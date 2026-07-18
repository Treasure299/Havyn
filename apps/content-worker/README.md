# Havyn Content Worker

This optional Cloudflare Worker supplies the desktop homepage with current entertainment news, TMDB discovery data, and regional JustWatch provider availability. It is separate from the room coordinator, so content outages cannot affect playback, chat, or calls.

## Setup

1. Create a free TMDB API read access token.
2. Run `npm install` at the repository root.
3. From this folder, run `npx wrangler secret put TMDB_API_TOKEN`.
4. Deploy with `npm run deploy:production`.
5. Put the deployed Worker URL in `VITE_CONTENT_API_URL` when building the desktop app.

For local development, put `TMDB_API_TOKEN=...` in `apps/content-worker/.dev.vars` and run `npm run dev`.

News comes from the publisher RSS URLs in `NEWS_FEEDS`. Havyn shows headlines and summaries and always opens the original publisher's page.
