# TI4 Strategy Advisor

AI-powered Twilight Imperium 4th Edition advisor, grounded in the actual rulebook and PoK Living Rules Reference via Anthropic's prompt caching API.

## What makes this different

- **Rulebook-grounded** — both the TI4 rulebook and PoK Living Rules Reference PDFs are sent to Claude on every query as authoritative documents. Rules answers cite actual text, not training memory.
- **Prompt-cached** — the PDFs (~11MB, ~82K tokens) are cached after the first call. Subsequent calls pay 90% less for that context ($0.025/msg vs $0.31 uncached).
- **Full game state** — tracks VP standings, strategy cards, objectives, technologies, action cards, resources, promissory notes, journal, and secret objectives.
- **Board scan** — attach a photo of the board for Claude to analyze alongside the structured state.

## Project structure

```
/
├── vercel.json          # Routing + function config (bundles data/ with api/)
├── package.json         # type:module for ESM imports
├── api/
│   └── chat.js          # Serverless proxy: loads PDFs, prepends to system, injects API key
├── data/
│   ├── rulebook.pdf     # TI4 4th Edition Rulebook
│   └── pok-lrr.pdf      # Prophecy of Kings Living Rules Reference v2.0
└── public/
    └── index.html       # Full single-file app (~105KB)
```

## Deploy to Vercel

### Via GitHub (recommended)

1. Push this repo to GitHub
2. Go to [vercel.com/new](https://vercel.com/new) → Import your repo
3. Framework preset: **Other**
4. Build command: *(empty)*
5. Output directory: `public`
6. Add environment variable: `ANTHROPIC_API_KEY` = your key from [console.anthropic.com](https://console.anthropic.com)
7. Deploy

### Via Vercel CLI

```bash
npm i -g vercel
vercel env add ANTHROPIC_API_KEY
vercel --prod
```

## Cost model (per game session)

| | Tokens | Cost |
|---|---|---|
| First message (cache write) | ~82K PDF + ~2K static | ~$0.31 |
| Each subsequent message (cache hit) | ~82K cached + ~2K fresh | ~$0.025 |
| 25-message game (1 write + 24 hits) | — | **~$0.91** |
| 40-message game (1 write + 39 hits) | — | **~$1.28** |

Board photos add ~2,500 tokens each and persist in history — use them selectively.

Cache stats are logged to Vercel function logs: `hits=`, `writes=`, `cost=`, `saved=`.

## Local dev

```bash
npm i -g vercel
vercel dev          # http://localhost:3000
# or set ANTHROPIC_API_KEY in .env.local
```
