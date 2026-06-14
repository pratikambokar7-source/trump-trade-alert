// trump-trade-alert.js
// Pipeline: Tavily (fetch Truth Social Mastodon API JSON) -> filter+timestamp in
// code -> Gemini (classify market-moving) -> ntfy (push). De-dupes by post id.
// Zero dependencies. Native fetch (Node 20+).

import { readFileSync, writeFileSync, existsSync } from "node:fs";

// ---------- Config (from env) ----------
const TAVILY_API_KEY = process.env.TAVILY_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const NTFY_TOPIC = process.env.NTFY_TOPIC;

// Look-back window in minutes. Workflows pass 45 (market hours) / 120 (off hours).
const TIME_WINDOW = parseInt(process.env.TIME_WINDOW || "120", 10);

// Truth Social account to monitor (Mastodon-compatible API).
const TRUTH_BASE = "https://truthsocial.com";
const ACCOUNT = process.env.TRUTH_ACCOUNT || "realDonaldTrump";
// Trump's stable numeric account id (override via env if it ever changes).
const ACCOUNT_ID = process.env.TRUTH_ACCOUNT_ID || "107780257626128497";

// Free-tier model (2026): gemini-2.5-flash-lite has the highest free quota.
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash-lite";
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

// Cross-run de-dup state (committed back by the workflow).
const STATE_FILE = process.env.STATE_FILE || "seen.json";
const MAX_SEEN = 200;

// ---------- Helpers ----------
function toIST(date = new Date()) {
  return new Date(date).toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "2-digit", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit", hour12: true,
  });
}

function checkEnv() {
  const missing = [];
  if (!TAVILY_API_KEY) missing.push("TAVILY_API_KEY");
  if (!GEMINI_API_KEY) missing.push("GEMINI_API_KEY");
  if (!NTFY_TOPIC) missing.push("NTFY_TOPIC");
  if (missing.length) throw new Error(`Missing env vars: ${missing.join(", ")}`);
}

function cleanContent(html = "") {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<a[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gi, "$2 ($1)")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/\n{3,}/g, "\n\n").replace(/[ \t]+/g, " ").trim();
}

function loadSeen() {
  try {
    if (existsSync(STATE_FILE)) {
      const arr = JSON.parse(readFileSync(STATE_FILE, "utf8"));
      if (Array.isArray(arr)) return new Set(arr.map(String));
    }
  } catch (e) {
    console.warn(`⚠️ Could not read ${STATE_FILE}: ${e.message}`);
  }
  return new Set();
}

function saveSeen(seenSet) {
  try {
    const arr = [...seenSet].slice(-MAX_SEEN);
    writeFileSync(STATE_FILE, JSON.stringify(arr, null, 0));
  } catch (e) {
    console.warn(`⚠️ Could not write ${STATE_FILE}: ${e.message}`);
  }
}

// ---------- 1. Fetch posts via Tavily (Mastodon JSON API) ----------
async function tavilyExtract(url) {
  const res = await fetch("https://api.tavily.com/extract", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TAVILY_API_KEY}`,
    },
    body: JSON.stringify({ urls: [url], extract_depth: "advanced" }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Tavily extract failed (HTTP ${res.status}): ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  const results = Array.isArray(data.results) ? data.results : [];
  if (results.length === 0) {
    throw new Error(`Tavily returned no content for ${url}`);
  }
  return results[0].raw_content || "";
}

// Pull a JSON value (array or object) out of possibly-noisy extracted text.
function extractJson(raw) {
  const text = String(raw).trim();
  try {
    return JSON.parse(text);
  } catch (_) {
    /* fall through to substring salvage */
  }
  const start = text.search(/[[{]/);
  if (start === -1) throw new Error("No JSON found in Tavily content");
  const open = text[start];
  const close = open === "[" ? "]" : "}";
  const end = text.lastIndexOf(close);
  if (end <= start) throw new Error("Malformed JSON in Tavily content");
  return JSON.parse(text.slice(start, end + 1));
}

async function fetchRecentPosts() {
  // Keep limit small so the JSON isn't truncated by the extractor.
  const url = `${TRUTH_BASE}/api/v1/accounts/${ACCOUNT_ID}/statuses?exclude_replies=true&limit=10`;
  const raw = await tavilyExtract(url);

  let statuses;
  try {
    statuses = extractJson(raw);
  } catch (e) {
    throw new Error(`Could not parse Truth Social statuses: ${e.message}`);
  }
  if (!Array.isArray(statuses)) {
    throw new Error(`Unexpected statuses payload: ${JSON.stringify(statuses).slice(0, 200)}`);
  }

  const cutoff = Date.now() - TIME_WINDOW * 60 * 1000;
  const posts = statuses
    .filter((s) => s && s.created_at && s.id)
    .map((s) => {
      const main = s.reblog || s; // surface reposted content
      return {
        id: String(s.id),
        createdMs: new Date(s.created_at).getTime(),
        timeIST: toIST(s.created_at),
        text: cleanContent(main.content || ""),
        reposted: Boolean(s.reblog),
      };
    })
    .filter((p) => p.text && Number.isFinite(p.createdMs) && p.createdMs >= cutoff);

  console.log(`✔ Fetched ${statuses.length} statuses — ${posts.length} within last ${TIME_WINDOW} min`);
  return posts;
}

// ---------- 2. Classify each post via Gemini ----------
async function classifyPost(post) {
  const prompt = `You are a financial analyst checking a single Truth Social post by Donald Trump for market-moving signals.

The post was published at: ${post.timeIST} IST. Use this EXACT time string in the output — do not invent a time.

POST:
"""
${post.text}
"""

FLAG the post if it contains ANY of:
- A specific company name or stock ticker
- A specific industry or sector (steel, semiconductors, oil, pharma, banks, crypto, defense, autos, etc.)
- Trade or tariff language (tariff, deal, trade, import, export, tax, sanction, duty)
- Market sentiment language (great time, buy, winning, strong, tremendous, beautiful deal, boom)
- Policy announcements that would directly affect publicly traded companies
- Mentions of a major trading partner country (China, Canada, Mexico, EU, Japan, India, South Korea)

If FLAGGED, respond in EXACTLY this format and nothing else:
TRUMP TRADE ALERT
Date & Time: ${post.timeIST} IST
Post Summary: [one sentence summary of what he said]
Tickers Likely Affected: [comma-separated tickers if mentioned, else most likely affected based on context]
Direction: [Bullish / Bearish / Mixed]
Sector: [most affected sector]
Confidence: [High / Medium / Low]
Why It Matters: [one sentence on why this could move markets]

If the post is NOT market-moving, respond with exactly: SKIP`;

  const res = await fetch(GEMINI_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: 600, temperature: 0.1 },
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Gemini API error (HTTP ${res.status}): ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  const out = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? "";
  if (!out || /^skip\b/i.test(out)) return null;
  if (!out.includes("TRUMP TRADE ALERT")) return null;
  return out;
}

// ---------- 3. Push via ntfy ----------
async function sendNtfy({ title, body, priority, tags }) {
  const safeTitle = String(title).replace(/[^\x00-\xFF]/g, "").trim();
  const res = await fetch(`https://ntfy.sh/${NTFY_TOPIC}`, {
    method: "POST",
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      Title: safeTitle,
      Priority: String(priority),
      Tags: tags,
    },
    body,
  });
  if (!res.ok) throw new Error(`ntfy failed (HTTP ${res.status})`);
  console.log(`📲 Sent: "${safeTitle}"`);
}

// ---------- Main ----------
async function main() {
  const nowIST = toIST();
  console.log(`\n🚀 Trump Trade Alert — ${nowIST} IST (window: ${TIME_WINDOW} min)`);
  console.log("=".repeat(50));

  try {
    checkEnv();
    const seen = loadSeen();
    const posts = await fetchRecentPosts();

    // Only analyze posts we haven't already alerted on.
    const fresh = posts.filter((p) => !seen.has(p.id));
    console.log(`🔎 ${fresh.length} new post(s) to analyze (${posts.length - fresh.length} already seen)`);

    let alertCount = 0;
    for (const post of fresh) {
      const alert = await classifyPost(post);
      seen.add(post.id); // mark processed regardless, so we never re-alert it
      if (alert) {
        alertCount++;
        await sendNtfy({
          title: "TRUMP TRADE ALERT",
          body: alert,
          priority: 5,
          tags: "rotating_light,chart_with_upwards_trend",
        });
      }
    }

    if (alertCount === 0) {
      await sendNtfy({
        title: "Trump: No Market Alerts",
        body: `No alerts — nothing flagged in the last ${TIME_WINDOW} minutes.\n\nChecked: ${nowIST} IST`,
        priority: 1,
        tags: "white_check_mark",
      });
    }

    saveSeen(seen);
    console.log("=".repeat(50));
    console.log(`✅ Done. ${alertCount} alert(s) sent.\n`);
  } catch (err) {
    console.error("❌ Fatal error:", err.message);
    try {
      await sendNtfy({
        title: "Trump Alert Error",
        body: `Failed at ${nowIST} IST\n\n${err.message}`,
        priority: 3,
        tags: "warning",
      });
    } catch (_) {
      console.error("Could not send error notification.");
    }
    process.exit(1);
  }
}

main();
