# TI4 Strategy Advisor — Vercel Deployment

AI-powered Twilight Imperium 4 strategy advisor. Runs on Vercel with your Anthropic API key.

## Structure

```
ti4-vercel/
├── vercel.json        # Routing: /api/* → serverless, /* → public/
├── package.json       # Minimal Node config
├── api/
│   └── chat.js        # Serverless proxy — injects API key, enables prompt caching
└── public/
    └── index.html     # The full app (single file, ~100KB)
```

## Deploy to Vercel (5 minutes)

### Option A — Vercel CLI (fastest)

```bash
npm install -g vercel
cd ti4-vercel
vercel deploy
```

When prompted, follow the interactive setup. After deploy, go to your Vercel dashboard:
**Settings → Environment Variables → Add:**
- Name:  `ANTHROPIC_API_KEY`
- Value: `sk-ant-xxxxxxxx` (your key from console.anthropic.com)
- Environments: Production, Preview, Development ✓

Then redeploy: `vercel --prod`

### Option B — GitHub + Vercel Dashboard (recommended for sharing)

1. Push this folder to a GitHub repo:
   ```bash
   cd ti4-vercel
   git init && git add . && git commit -m "TI4 advisor"
   gh repo create ti4-advisor --public --push --source=.
   ```

2. Go to [vercel.com/new](https://vercel.com/new) → Import your repo

3. In the Vercel deploy screen, open **Environment Variables** and add:
   - `ANTHROPIC_API_KEY` = your key

4. Click **Deploy**. You'll get a URL like `https://ti4-advisor-xyz.vercel.app`

5. Share that URL with your game group — it works on mobile too.

## Getting Your API Key

1. Go to [console.anthropic.com](https://console.anthropic.com)
2. API Keys → Create Key
3. Copy the `sk-ant-...` value

## Cost

Model: `claude-sonnet-4-20250514` — $3/M input, $15/M output tokens.

This app uses **prompt caching** — the static system prompt (~600 tokens of AI instructions)
is cached at $0.30/M on hits (90% cheaper). The dynamic game state is always fresh.

| Play style       | Messages | Photos | Est. cost |
|------------------|----------|--------|-----------|
| Light            | 10–15    | 0      | $0.20–$0.40 |
| Typical game night | 20–30  | 1–2    | $0.80–$1.80 |
| Heavy use        | 40–50    | 3–5    | $2.50–$5.00 |

Cost grows with conversation length because full history is sent every call.
Board photos are re-sent in history — use them selectively.

To monitor spend: [console.anthropic.com/usage](https://console.anthropic.com/usage)

## Local Development

```bash
npm install -g vercel
cd ti4-vercel
vercel dev   # runs on http://localhost:3000
```

Set your API key locally:
```bash
vercel env add ANTHROPIC_API_KEY
```
Or create a `.env.local` file (git-ignored):
```
ANTHROPIC_API_KEY=sk-ant-xxxxxxxx
```

## Security Notes

- Your API key lives only in Vercel's encrypted environment variables — never in the HTML
- The HTML is fully public; it contains zero secrets
- The `/api/chat` proxy validates `POST` only and passes the body through as-is
- To restrict access, add Vercel's password protection or deploy to a private repo
