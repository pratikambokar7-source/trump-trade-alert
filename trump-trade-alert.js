// trump-trade-alert.js
// Pipeline: source (Tavily/proxy/direct) -> filter+timestamp in code ->
// Gemini (classify market-moving) -> ntfy (push). Watermark + de-dup ensure
// no post is missed and none is alerted twice. Zero deps. Native fetch (Node 20+).

import { readFileSync, writeFileSync, existsSync } from "node:fs";

// ---------- Config (from env) ----------
const TAVILY_API_KEY = process.env.TAVILY_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const NTFY_TOPIC = process.env.NTFY_TOPIC;
const NTFY_SERVER = (process.env.NTFY_SERVER || "https://ntfy.sh").replace(/\/+$/, "");
const NTFY_TOKEN = process.env.NTFY_TOKEN || "";

// First-run look-back bound (minutes). After that, the watermark drives things.
const TIME_WINDOW = parseInt(process.env.TIME_WINDOW || "120", 10);

const TRUTH_BASE = "https://truthsocial.com";
const ACCOUNT = process.env.TRUTH_ACCOUNT || "realDonaldTrump";
const ACCOUNT_ID = process.env.TRUTH_ACCOUNT_ID || "107780257626128497";

const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash-lite";
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

const STATE_FILE = process.env.STATE_FILE || "seen.json";
const MAX_SEEN = 200;

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
    .replace(/&/g, "&").replace(/</g, "<").replace(/&gt;/g, ">")
    .replace(/"/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/\n{3,}/g, "\n\n").replace(/[ \t]+/g, " ").trim();
}

// State = { lastMs, seen[] }. lastMs is the watermark: created_at (ms) of the
// newest post already processed. Each run handles everything newer than it, so
// no post is missed regardless of the gap. seen[] prevents duplicate alerts.
function loadState() {
  try {
    if (existsSync(STATE_FILE)) {
      const data = JSON.parse(readFileSync(STATE_FILE, "utf8"));
      if (Array.isArray(data)) return { seen: new Set(data.map(String)), lastMs: 0 };
      if (data && typeof data === "object") {
        return { seen: new Set((data.seen || []).map(String)), lastMs: Number(data.lastMs) || 0 };
      }
    }
  } catch (e) {
    console.warn(`⚠️ Could not read ${STATE_FILE}: ${e.message}`);
  }
  return { seen: new Set(), lastMs: 0 };
}

function saveState(seenSet, lastMs) {
  try {
    const seen = [...seenSet].slice(-MAX_SEEN);
    writeFileSync(STATE_FILE, JSON.stringify({ lastMs, seen }, null, 0));
  } catch (e) {
    console.warn(`⚠️ Could not write ${STATE_FILE}: ${e.message}`);
  }
}

// ---------- 1. Fetch posts (multi-source with fallback) ----------
const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  Accept: "application/json",
};

const PROXY_TEMPLATE =
  process.env.PROXY_TEMPLATE || "https://api.allorigins.win/raw?url={url}";

const FETCH_ORDER = (process.env.FETCH_ORDER || "tavily,proxy,direct")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

async function directFetch(url) {
  const res = await fetch(url, { headers: BROWSER_HEADERS, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`direct HTTP ${res.status}`);
  return await res.text();
}

async function proxyFetch(url) {
  const proxied = PROXY_TEMPLATE.replace("{url}", encodeURIComponent(url));
  const res = await fetch(proxied, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`proxy HTTP ${res.status}`);
  return await res.text();
}

async function tavilyExtract(url) {
  if (!TAVILY_API_KEY) throw new Error("no Tavily key");
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
    throw new Error(`Tavily HTTP ${res.status}: ${body.slice(0, 120)}`);
  }
  const data = await res.json();
  const results = Array.isArray(data.results) ? data.results : [];
  if (results.length === 0) throw new Error("Tavily returned no content");
  return results[0].raw_content || "";
}

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
    if (ch === '"') { out += ch; inString = false; continue; }
    if (ch === "\\") {
      const next = str[i + 1];
      if (next !== undefined && validEscape.has(next)) {
        out += ch + next;
        i++;
      } else {
        out += "\\\\";
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

function extractJson(raw) {
  const text = String(raw).trim();
  const start = text.search(/[[{]/);
  if (start === -1) throw new Error("no JSON found");
  const open = text[start];
  const close = open === "[" ? "]" : "}";
  const end = text.lastIndexOf(close);
  if (end <= start) throw new Error("malformed JSON");
  const slice = text.slice(start, end + 1);
  try {
    return JSON.parse(slice);
  } catch (_) {
    return JSON.parse(sanitizeJsonControlChars(slice));
  }
}

async function fetchRecentPosts() {
  const url = `${TRUTH_BASE}/api/v1/accounts/${ACCOUNT_ID}/statuses?exclude_replies=true&limit=20`;

  const sources = { direct: directFetch, proxy: proxyFetch, tavily: tavilyExtract };

  let statuses, lastErr;
  for (const name of FETCH_ORDER) {
    const fn = sources[name];
    if (!fn) continue;
    if (name === "proxy" && !PROXY_TEMPLATE) continue;
    if (name === "tavily" && !TAVILY_API_KEY) continue;
    try {
      const raw = await fn(url);
      const parsed = extractJson(raw);
      if (!Array.isArray(parsed)) throw new Error("payload is not an array");
      statuses = parsed;
      console.log(`✔ Source: ${name}`);
      break;
    } catch (e) {
      console.warn(`↪ source "${name}" failed: ${e.message}`);
      lastErr = e;
    }
  }

  if (!statuses) {
    throw new Error(`All sources failed to return Truth Social statuses. Last: ${lastErr?.message}`);
  }

  const posts = statuses
    .filter((s) => s && s.created_at && s.id)
    .map((s) => {
      const main = s.reblog || s;
      return {
        id: String(s.id),
        createdMs: new Date(s.created_at).getTime(),
        timeIST: toIST(s.created_at),
        text: cleanContent(main.content || ""),
        reposted: Boolean(s.reblog),
      };
    })
    .filter((p) => p.text && Number.isFinite(p.createdMs));

  console.log(`✔ Fetched ${statuses.length} statuses (${posts.length} usable)`);
  return posts;
}

// ---------- 2. Analyze posts via Gemini (batched, retry on 429/5xx) ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

    // 429 = rate limit; 5xx = temporary model overload/outage. Both transient.
    if ([429, 500, 502, 503, 504].includes(res.status)) {
      if (attempt < maxAttempts) {
        const retryAfter = parseInt(res.headers.get("retry-after") || "0", 10);
        const waitMs = (retryAfter > 0 ? retryAfter : attempt * 8) * 1000;
        console.warn(`⏳ Gemini ${res.status} — retrying in ${waitMs / 1000}s (attempt ${attempt}/${maxAttempts})`);
        await sleep(waitMs);
        continue;
      }
      const err = new Error(`Gemini transient error (HTTP ${res.status}) after retries`);
      err.code = "TRANSIENT";
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
  const res = await fetch(`${NTFY_SERVER}/${NTFY_TOPIC}`, { method: "POST", headers, body });
  if (!res.ok) throw new Error(`ntfy failed (HTTP ${res.status})`);
  console.log(`📲 Sent: "${safeTitle}"`);
}

// ---------- Main ----------
async function main() {
  const nowIST = toIST();
  console.log(`\n🚀 Trump Trade Alert — ${nowIST} IST`);
  console.log("=".repeat(50));

  try {
    checkEnv();
    const { seen, lastMs } = loadState();
    const posts = await fetchRecentPosts();

    // Floor = watermark of last processed post. First ever run (no watermark)
    // falls back to the TIME_WINDOW bound so we don't alert on ancient history.
    const floorMs = lastMs > 0 ? lastMs : Date.now() - TIME_WINDOW * 60 * 1000;
    const fresh = posts
      .filter((p) => p.createdMs > floorMs && !seen.has(p.id))
      .sort((a, b) => a.createdMs - b.createdMs);

    console.log(`🔎 ${fresh.length} new post(s) since ${toIST(floorMs)} IST`);

    let alerts = [];
    let newLastMs = lastMs;
    if (fresh.length > 0) {
      try {
        alerts = await analyzePosts(fresh);
        fresh.forEach((p) => seen.add(p.id));
        newLastMs = Math.max(lastMs, ...fresh.map((p) => p.createdMs));
      } catch (err) {
        if (err.code === "TRANSIENT") {
          // Don't advance watermark or mark seen — next run retries these exact
          // posts. No lost alerts, no error-notification spam.
          console.warn(`⚠️ ${err.message} — skipping, will retry next run.`);
          saveState(seen, lastMs);
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
        body: `No new market-moving posts.\n\nChecked: ${nowIST} IST`,
        priority: 1,
        tags: "white_check_mark",
      });
    }

    saveState(seen, newLastMs);
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
