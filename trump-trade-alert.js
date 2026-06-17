// trump-trade-alert.js
// Pipeline: Tavily (fetch Truth Social Mastodon API JSON) -> filter+timestamp in
// code -> Gemini (classify market-moving) -> ntfy (push). De-dupes by post id.
// Zero dependencies. Native fetch (Node 20+).

import { readFileSync, writeFileSync, existsSync } from "node:fs";

// ---------- Config (from env) ----------
const TAVILY_API_KEY = process.env.TAVILY_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const NTFY_TOPIC = process.env.NTFY_TOPIC;
// ntfy server (default public). Point to your self-hosted instance if you have one.
const NTFY_SERVER = (process.env.NTFY_SERVER || "https://ntfy.sh").replace(/\/+$/, "");
// Optional access token for an access-controlled / reserved topic (ntfy Pro or
// self-hosted with auth). When set, publishing is authenticated.
const NTFY_TOKEN = process.env.NTFY_TOKEN || "";

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

// Send a "no alerts" heartbeat when nothing is flagged? Default off to cut noise.
const HEARTBEAT = /^(1|true|yes)$/i.test(process.env.HEARTBEAT || "");

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

// Repair JSON that a web extractor mangled: inside string literals, escape raw
// control characters AND fix invalid escape sequences (e.g. markdown "\." or a
// lone "\"). Structural whitespace between tokens is left untouched.
function sanitizeJsonControlChars(str) {
  const validEscape = new Set(['"', "\\", "/", "b", "f", "n", "r", "t", "u"]);
  let out = "";
  let inString = false;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (!inString) {
      out += ch;
      if (ch === '"') inString = true;
      continue;
    }
    // Inside a string literal:
    if (ch === '"') { out += ch; inString = false; continue; }
    if (ch === "\\") {
      const next = str[i + 1];
      if (next !== undefined && validEscape.has(next)) {
        out += ch + next; // valid escape — keep the pair as-is
        i++;
      } else {
        out += "\\\\"; // invalid escape — escape the backslash itself
      }
      continue;
    }
    const code = ch.charCodeAt(0);
    if (code < 0x20) {
      if (ch === "\n") out += "\\n";
      else if (ch === "\r") out += "\\r";
      else if (ch === "\t") out += "\\t";
      else out += "\\u" + code.toString(16).padStart(4, "0");
      continue;
    }
    out += ch;
  }
  return out;
}

// Pull a JSON value (array or object) out of possibly-noisy extracted text.
function extractJson(raw) {
  const text = String(raw).trim();
  const start = text.search(/[[{]/);
  if (start === -1) throw new Error("No JSON found in Tavily content");
  const open = text[start];
  const close = open === "[" ? "]" : "}";
  const end = text.lastIndexOf(close);
  if (end <= start) throw new Error("Malformed JSON in Tavily content");
  const candidate = sanitizeJsonControlChars(text.slice(start, end + 1));
  return JSON.parse(candidate);
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

// ---------- 2. Analyze posts via Gemini (batched, with 429 backoff) ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Single Gemini call with retry/backoff. Throws an error with code "QUOTA"
// if rate-limited (429) after all retries, so the caller can skip gracefully.
async function geminiGenerate(prompt, { maxOutputTokens = 2000 } = {}) {
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await fetch(GEMINI_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens, temperature: 0.1 },
      }),
    });

    if (res.status === 429) {
      if (attempt < maxAttempts) {
        const retryAfter = parseInt(res.headers.get("retry-after") || "0", 10);
        const waitMs = (retryAfter > 0 ? retryAfter : attempt * 8) * 1000;
        console.warn(`⏳ Gemini 429 — retrying in ${waitMs / 1000}s (attempt ${attempt}/${maxAttempts})`);
        await sleep(waitMs);
        continue;
      }
      const err = new Error("Gemini quota exceeded (429) after retries");
      err.code = "QUOTA";
      throw err;
    }
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Gemini API error (HTTP ${res.status}): ${body.slice(0, 200)}`);
    }
    const data = await res.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? "";
  }
  return "";
}

// Analyze ALL fresh posts in one call. Returns an array of alert text blocks.
async function analyzePosts(posts) {
  const postsBlock = posts
    .map((p, i) => `[POST ${i + 1}] published ${p.timeIST} IST\n${p.text}`)
    .join("\n\n----------\n\n");

  const prompt = `You are a financial analyst monitoring Donald Trump's Truth Social posts for market-moving signals.

Below are ${posts.length} recent post(s). Each is labelled with its EXACT published time. Use that exact time string in the output — never invent a time.

=== POSTS ===
${postsBlock}
=== END POSTS ===

FLAG a post if it contains ANY of:
- A specific company name or stock ticker
- A specific industry or sector (steel, semiconductors, oil, pharma, banks, crypto, defense, autos, etc.)
- Trade or tariff language (tariff, deal, trade, import, export, tax, sanction, duty)
- Market sentiment language (great time, buy, winning, strong, tremendous, beautiful deal, boom)
- Policy announcements that would directly affect publicly traded companies
- Mentions of a major trading partner country (China, Canada, Mexico, EU, Japan, India, South Korea)

For EVERY flagged post, output this block (and nothing else around it):
TRUMP TRADE ALERT
Date & Time: [the post's exact published time] IST
Post Summary: [one sentence summary]
Tickers Likely Affected: [comma-separated tickers if mentioned, else most likely affected based on context]
Direction: [Bullish / Bearish / Mixed]
Sector: [most affected sector]
Confidence: [High / Medium / Low]
Why It Matters: [one sentence on why this could move markets]

Separate multiple alert blocks with a line containing only: ===
If NONE of the posts are market-moving, respond with exactly: NONE`;

  const out = await geminiGenerate(prompt, { maxOutputTokens: 2000 });
  if (!out || /^none\b/i.test(out)) return [];
  return out
    .split(/^===$/m)
    .map((s) => s.trim())
    .filter((s) => s.includes("TRUMP TRADE ALERT"));
}

// ---------- 3. Push via ntfy ----------
async function sendNtfy({ title, body, priority, tags }) {
  const safeTitle = String(title).replace(/[^\x00-\xFF]/g, "").trim();
  const headers = {
    "Content-Type": "text/plain; charset=utf-8",
    Title: safeTitle,
    Priority: String(priority),
    Tags: tags,
  };
  if (NTFY_TOKEN) headers.Authorization = `Bearer ${NTFY_TOKEN}`;
  const res = await fetch(`${NTFY_SERVER}/${NTFY_TOPIC}`, {
    method: "POST",
    headers,
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

    let alerts = [];
    if (fresh.length > 0) {
      try {
        alerts = await analyzePosts(fresh);
        // Classification succeeded — mark all fresh posts processed.
        fresh.forEach((p) => seen.add(p.id));
      } catch (err) {
        if (err.code === "QUOTA") {
          // Don't mark these posts seen; next scheduled run retries them.
          // Skip quietly (no scary alert, green exit) to avoid spam.
          console.warn("⚠️ Gemini quota hit — skipping run, posts will be retried next time.");
          saveSeen(seen);
          return;
        }
        throw err;
      }
    }

    for (const text of alerts) {
      await sendNtfy({
        title: "TRUMP TRADE ALERT",
        body: text,
        priority: 5,
        tags: "rotating_light,chart_with_upwards_trend",
      });
    }

    if (alerts.length === 0 && HEARTBEAT) {
      await sendNtfy({
        title: "Trump: No Market Alerts",
        body: `No alerts — nothing flagged in the last ${TIME_WINDOW} minutes.\n\nChecked: ${nowIST} IST`,
        priority: 1,
        tags: "white_check_mark",
      });
    }

    saveSeen(seen);
    console.log("=".repeat(50));
    console.log(`✅ Done. ${alerts.length} alert(s) sent.\n`);
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
