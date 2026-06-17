# Trump Trade Alert

Monitors Donald Trump's Truth Social feed for market-moving posts and pushes alerts to your phone via ntfy. Runs free on GitHub Actions.

```
GitHub Actions (scheduled)
      ↓
Tavily API → fetches Truth Social Mastodon API JSON (bypasses 403 IP blocks)
      ↓
Code → filters posts to the time window using real created_at timestamps,
       formats post time in IST, de-dupes by post id (seen.json)
      ↓
Gemini Flash → classifies each NEW post as market-moving or not
      ↓
ntfy.sh → push notification to your phone
```

## Data source & fallback chain

Truth Social's Mastodon API sits behind Cloudflare bot protection, which 403s direct requests (even from residential IPs) and breaks most free proxies. **Tavily** (residential proxy + browser engine) is the only source that reliably gets through, so it's the primary source.

The script tries sources in `FETCH_ORDER` (default `tavily,proxy,direct`) and uses the first that returns a parseable statuses array:
- **tavily** — reliable; reshapes the JSON, so the built-in sanitizer repairs control chars and invalid escape sequences before parsing.
- **proxy** — a raw HTTP proxy (`PROXY_TEMPLATE`, default allorigins). Returns the body unmodified when it works, but free proxies are flaky/blocked. Only fires if Tavily fails.
- **direct** — plain fetch; works only if Cloudflare ever stops blocking (e.g. self-host scenarios). Last resort.

To prioritise a working proxy (and save Tavily credits), set `FETCH_ORDER=proxy,tavily`. To disable the proxy, set `PROXY_TEMPLATE=` (empty).

## Why Tavily + the JSON API

GitHub, Cloudflare, Render and most cloud platforms run on data-center IPs that Truth Social blocks (HTTP 403). Tavily fetches through residential proxies, so it reaches the content. We point Tavily at Truth Social's underlying **Mastodon JSON API** (`/api/v1/accounts/{id}/statuses`) rather than the HTML page, so every post comes with a real `created_at` timestamp and a stable `id`. That lets the code — not the LLM — decide what's recent and stamp the correct time, and lets us de-dupe so the same post is never alerted twice. Tavily free tier: 1,000 credits/month.

## De-duplication

`seen.json` stores the IDs of posts already alerted on (last 200). Each scheduled run commits it back to the repo via the workflow (needs `contents: write`, already set). This guarantees no repeat alerts across runs.

## Rate limits & quiet mode

- All new posts in a run are analyzed in a **single** Gemini call (not one per post), which keeps usage well under the free tier and avoids per-minute 429s during posting bursts.
- On a 429, the script retries with backoff (honoring `Retry-After`). If it still fails, the run is skipped quietly and those posts are **not** marked seen — the next scheduled run retries them, so no alert is lost and you don't get a flood of error notifications.
- The "No Market Alerts" heartbeat is **off by default** (quiet). Set a repo secret `HEARTBEAT=true` if you want a confirmation ping each run.

## Account id

`TRUTH_ACCOUNT_ID` defaults to Trump's stable numeric id. Override it via a repo variable/secret if it ever changes.

## Schedule

| Window | Frequency | `TIME_WINDOW` |
|---|---|---|
| US market hours (Mon–Fri, ~13:30–20:00 UTC) | every ~45 min | 45 |
| Off hours + weekends | every 2 hours | 120 |

Estimated usage ≈ 440 Tavily credits/month — well inside the free tier.

> DST note: GitHub cron is UTC. `market-hours.yml` is tuned for US summer time (EDT). In winter (EST) the session is 14:30–21:00 UTC; shift each cron line forward 1 hour if you want exact edges.

## Access-controlled (private) topic

The free public `ntfy.sh` has **no access control** — anyone who knows the topic name can read or publish to it. The script already supports authenticated publishing; you just need a server that enforces auth. Two options:

### Option A — ntfy Pro (paid, hosted, easiest)
1. Sign up at [ntfy.sh](https://ntfy.sh/) and subscribe to ntfy Pro.
2. Reserve your topic and set access to **"Deny all"** (others get read-only, nobody else can publish).
3. Create an access token (Account → Access tokens).
4. Add a repo secret `NTFY_TOKEN` = that token. Leave `NTFY_SERVER` unset (defaults to `https://ntfy.sh`).
5. Share the topic name with others — they can subscribe and read, but only your token can publish.

### Option B — Self-host ntfy (free-ish, your own VPS)
1. Run ntfy on a free/cheap VM (e.g. Oracle Cloud free tier) via Docker: `binwiederhier/ntfy`.
2. In `server.yml`, enable auth and set `auth-default-access: deny-all`.
3. Create a user/token: `ntfy user add publisher` and `ntfy token add publisher`; grant read-only to others on the topic.
4. Add repo secrets: `NTFY_SERVER` = `https://your-ntfy-domain`, `NTFY_TOKEN` = the publisher token.

In both cases the script sends `Authorization: Bearer <NTFY_TOKEN>` automatically when `NTFY_TOKEN` is set. If you leave it blank, it behaves exactly as before (public topic).

## Setup

### 1. Phone (ntfy)
- Install ntfy ([Android](https://play.google.com/store/apps/details?id=io.heckel.ntfy) / [iOS](https://apps.apple.com/app/ntfy/id1625396347))
- Tap `+`, subscribe to a unique topic, e.g. `trump-alerts-pratik`

### 2. API keys
- Tavily: [app.tavily.com](https://app.tavily.com/) → copy key (`tvly-...`)
- Gemini: [aistudio.google.com](https://aistudio.google.com/) → Get API key (`AIzaSy...`)

### 3. Push to GitHub
Create a repo and add these files (keep the `.github/workflows/` structure intact):
```
trump-trade-alert/
├── trump-trade-alert.js
├── package.json
├── README.md
└── .github/workflows/
    ├── market-hours.yml
    └── off-hours.yml
```

### 4. Add repository secrets
Repo → Settings → Secrets and variables → Actions → New repository secret:

| Name | Value |
|---|---|
| `TAVILY_API_KEY` | your Tavily key |
| `GEMINI_API_KEY` | your Gemini key |
| `NTFY_TOPIC` | the topic you subscribed to (e.g. `trump-alerts-pratik`) |

### 5. Test
Actions tab → either workflow → **Run workflow**. You should get an ntfy notification within ~30s.

## Local test
```bash
cp .env.example .env   # fill in real values
node --env-file=.env trump-trade-alert.js
```

## Adding more sources later
Set the `SOURCES` env var (comma-separated URLs) as a repo secret/variable, e.g.:
```
SOURCES=https://truthsocial.com/@realDonaldTrump,https://truthsocial.com/@SomeOtherAccount
```
No code change needed.

## Alert format
```
🚨 TRUMP TRADE ALERT
TRUMP TRADE ALERT
Date & Time: 04 Jun 2026, 09:42 PM IST
Post Summary: Trump announced 50% tariffs on Chinese semiconductor imports
Tickers Likely Affected: NVDA, AMD, QCOM, TSM, INTC
Direction: Bearish
Sector: Semiconductors
Confidence: High
Why It Matters: Tariffs would spike input costs for US chipmakers
```

## Cost
| Item | Cost |
|---|---|
| Tavily (~440 credits/mo) | Free |
| Gemini Flash | Free (1,500 req/day tier) |
| GitHub Actions | Free (public repo) |
| ntfy.sh | Free |
