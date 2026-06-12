# Trump Trade Alert

Monitors Donald Trump's Truth Social feed for market-moving posts and pushes alerts to your phone via ntfy. Runs free on GitHub Actions.

```
GitHub Actions (scheduled)
      ↓
Tavily API → scrapes truthsocial.com/@realDonaldTrump (bypasses 403 IP blocks)
      ↓
Gemini Flash → analyzes posts for market-moving language
      ↓
ntfy.sh → push notification to your phone
```

## Why Tavily

GitHub, Cloudflare, Render and most cloud platforms run on data-center IPs that Truth Social blocks (HTTP 403). Tavily fetches through residential proxies, so it gets the real page content. Free tier: 1,000 credits/month.

## Schedule

| Window | Frequency | `TIME_WINDOW` |
|---|---|---|
| US market hours (Mon–Fri, ~13:30–20:00 UTC) | every ~45 min | 45 |
| Off hours + weekends | every 2 hours | 120 |

Estimated usage ≈ 440 Tavily credits/month — well inside the free tier.

> DST note: GitHub cron is UTC. `market-hours.yml` is tuned for US summer time (EDT). In winter (EST) the session is 14:30–21:00 UTC; shift each cron line forward 1 hour if you want exact edges.

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
