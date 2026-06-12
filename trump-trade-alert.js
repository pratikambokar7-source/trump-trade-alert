// trump-trade-alert.js
// Pipeline: Tavily (scrape Truth Social) -> Gemini Flash (analyze) -> ntfy (push)
// Zero dependencies. Native fetch (Node 20+).

// ---------- Config (from env) ----------
const TAVILY_API_KEY = process.env.TAVILY_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const NTFY_TOPIC = process.env.NTFY_TOPIC;

// How far back to look for "recent" posts, in minutes.
// Workflows pass 45 (market hours) or 120 (off hours). Default 120.
const TIME_WINDOW = parseInt(process.env.TIME_WINDOW || "120", 10);

// Source(s) to monitor. Add more URLs here later (other accounts / news pages).
const SOURCES = (process.env.SOURCES ||
  "https://truthsocial.com/@realDonaldTrump")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.0-flash";
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

// ---------- Helpers ----------
function toIST(date = new Date()) {
  return new Date(date).toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
}

function checkEnv() {
  const missing = [];
  if (!TAVILY_API_KEY) missing.push("TAVILY_API_KEY");
  if (!GEMINI_API_KEY) missing.push("GEMINI_API_KEY");
  if (!NTFY_TOPIC) missing.push("NTFY_TOPIC");
  if (missing.length) throw new Error(`Missing env vars: ${missing.join(", ")}`);
}

// ---------- 1. Scrape via Tavily ----------
async function scrapeSources(urls) {
  const res = await fetch("https://api.tavily.com/extract", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TAVILY_API_KEY}`,
    },
    body: JSON.stringify({
      urls,
      extract_depth: "advanced", // needed for JS-heavy pages like Truth Social
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Tavily extract failed (HTTP ${res.status}): ${body.slice(0, 300)}`);
  }

  const data = await res.json();
  const results = Array.isArray(data.results) ? data.results : [];
  if (results.length === 0) {
    const failed = Array.isArray(data.failed_results) ? data.failed_results : [];
    throw new Error(
      `Tavily returned no content. Failed: ${JSON.stringify(failed).slice(0, 300)}`
    );
  }

  const combined = results
    .map((r) => `# SOURCE: ${r.url}\n\n${r.raw_content || ""}`)
    .join("\n\n========================================\n\n");

  console.log(`✔ Scraped ${results.length}/${urls.length} source(s), ${combined.length} chars`);
  return combined;
}

// ---------- 2. Analyze via Gemini ----------
async function analyze(rawContent) {
  const nowIST = toIST();

  const prompt = `You are a financial analyst monitoring Donald Trump's Truth Social feed for market-moving signals.

Current time: ${nowIST} IST.
Only consider posts published within the LAST ${TIME_WINDOW} MINUTES. Ignore older posts.

Below is the raw scraped content of the page(s). It may contain navigation noise, timestamps, and multiple posts. Extract the actual posts and their post times.

=== SCRAPED CONTENT START ===
${rawContent}
=== SCRAPED CONTENT END ===

For each post within the last ${TIME_WINDOW} minutes, FLAG it if it contains ANY of:
- A specific company name or stock ticker
- A specific industry or sector (steel, semiconductors, oil, pharma, banks, crypto, defense, autos, etc.)
- Trade or tariff language (tariff, deal, trade, import, export, tax, sanction, duty)
- Market sentiment language (great time, buy, winning, strong, tremendous, beautiful deal, boom)
- Policy announcements that would directly affect publicly traded companies
- Mentions of a major trading partner country (China, Canada, Mexico, EU, Japan, India, South Korea)

For EVERY flagged post, output EXACTLY this block (repeat per post), no extra commentary:

---
TRUMP TRADE ALERT
Date & Time: [post time in IST]
Post Summary: [one sentence summary of what he said]
Tickers Likely Affected: [comma-separated tickers if mentioned, else most likely affected based on context]
Direction: [Bullish / Bearish / Mixed]
Sector: [most affected sector]
Confidence: [High / Medium / Low]
Why It Matters: [one sentence on why this could move markets]
---

If NO posts in the last ${TIME_WINDOW} minutes contain market-moving language, respond with EXACTLY:
No alerts — nothing flagged in the last ${TIME_WINDOW} minutes.`;

  const res = await fetch(GEMINI_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: 2000, temperature: 0.1 },
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Gemini API error (HTTP ${res.status}): ${body.slice(0, 300)}`);
  }

  const data = await res.json();
  const raw = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? "";
  if (!raw) throw new Error("Gemini returned an empty response");

  console.log("📊 Gemini analysis:\n", raw);

  if (raw.toLowerCase().startsWith("no alerts")) {
    return [{ isAlert: false, text: raw }];
  }

  const blocks = raw
    .split(/^---$/m)
    .map((s) => s.trim())
    .filter((s) => s.includes("TRUMP TRADE ALERT"));

  return blocks.length > 0
    ? blocks.map((b) => ({ isAlert: true, text: b }))
    : [{ isAlert: false, text: `No alerts — nothing flagged in the last ${TIME_WINDOW} minutes.` }];
}

// ---------- 3. Push via ntfy ----------
async function sendNtfy({ title, body, priority, tags }) {
  const res = await fetch(`https://ntfy.sh/${NTFY_TOPIC}`, {
    method: "POST",
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      Title: title,
      Priority: String(priority),
      Tags: tags,
    },
    body,
  });
  if (!res.ok) throw new Error(`ntfy failed (HTTP ${res.status})`);
  console.log(`📲 Sent: "${title}"`);
}

// ---------- Main ----------
async function main() {
  const nowIST = toIST();
  console.log(`\n🚀 Trump Trade Alert — ${nowIST} IST (window: ${TIME_WINDOW} min)`);
  console.log("=".repeat(50));

  try {
    checkEnv();
    const content = await scrapeSources(SOURCES);
    const results = await analyze(content);

    let alertCount = 0;
    for (const r of results) {
      if (r.isAlert) {
        alertCount++;
        await sendNtfy({
          title: "🚨 TRUMP TRADE ALERT",
          body: r.text,
          priority: 5,
          tags: "rotating_light,chart_with_upwards_trend",
        });
      }
    }

    if (alertCount === 0) {
      await sendNtfy({
        title: "✅ Trump: No Market Alerts",
        body: `No alerts — nothing flagged in the last ${TIME_WINDOW} minutes.\n\nChecked: ${nowIST} IST`,
        priority: 1,
        tags: "white_check_mark",
      });
    }

    console.log("=".repeat(50));
    console.log(`✅ Done. ${alertCount} alert(s) sent.\n`);
  } catch (err) {
    console.error("❌ Fatal error:", err.message);
    try {
      await sendNtfy({
        title: "⚠️ Trump Alert Error",
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
