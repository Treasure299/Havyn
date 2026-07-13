# Havyn Watchroom 2.0 coordinator

This Worker is the authoritative realtime coordinator for a Havyn room. One
Cloudflare Durable Object owns each room's presence, playback state, chat,
permissions, and WebRTC signaling.

The Worker coordinates room state only. Media and call tracks remain on each
participant's device and are never relayed through Cloudflare.

## Local checks

```powershell
npm run room:test
npm run room:check
```

The integration suite opens real WebSockets against the Workers test runtime
and covers two-client playback, permission rejection, WebRTC routing, Durable
Object eviction, reconnect recovery, call limits, and intentional departure.

## Local development

Copy `.dev.vars.example` to `.dev.vars`, then run:

```powershell
npm run room:dev
npm --workspace apps/desktop run dev:cloudflare
```

Local development can use `VITE_CLOUDFLARE_DEV_AUTH=true`. Never enable that
flag in a packaged build or deployed environment.

## Staging

Staging coordinator:

`https://havyn-room-coordinator-staging.chijiokekosisochukwu.workers.dev`

Build the desktop renderer against staging without changing the normal `.env`:

```powershell
npm --workspace apps/desktop run build:cloudflare
```

The checked-in `.env.cloudflare` changes only the signaling provider and
coordinator URL. Supabase values still come from the developer's ignored
`apps/desktop/.env` file.

## Deployment secrets

Both staging and production require these Worker secrets:

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `ROOM_TICKET_SECRET` (a strong random value)

Deploy staging only after the test and type-check commands pass:

```powershell
npm --workspace apps/room-worker run deploy:staging
```

## Rollback

Cloudflare and Ably are explicit build-time providers. Havyn never fails over
between providers inside a live room, because doing so would split participants
between two authorities.

To return a build to Ably, set:

```dotenv
VITE_SIGNALING_PROVIDER=ably
```

The pre-migration source checkpoint is tagged `havyn-ably-stable-2.0.7` and is
also available on branch `backup/ably-stable-2.0.7`.
