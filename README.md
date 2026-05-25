# Havyn MVP

Havyn is a desktop-first social watch-party platform for small private rooms. It gives each person their own embedded browser session, detects generic HTML5 video elements, and synchronizes navigation and playback state through a local Socket.IO signaling server.

Havyn does not stream, proxy, transmit, copy, scrape, or redistribute video files. Each participant loads content locally in their own browser session and uses their own normal service login.

## What Is Included

- Electron + React + Vite desktop app
- Node.js + Express + Socket.IO signaling server
- Supabase Auth for signup, login, logout, and profiles
- Private room creation and room-code joining
- Social Beta dashboard with recent watch partners, in-app invites, and public rooms
- In-memory live presence and participant status
- Embedded Electron BrowserView with generic HTML5 video detection
- Server-authoritative playback state
- Host-only, host-and-cohosts, and everyone playback modes
- Realtime room chat through Socket.IO
- Optional raw WebRTC peer-to-peer mesh calling for up to 4 users
- Public free STUN server for local testing
- Supabase SQL schema for profiles, rooms, members, chat messages, invites, public rooms, and social presence

## MVP Limitations

- Rooms are optimized for small private sessions
- Voice/video call limit is 4 users
- Public STUN only is used for MVP
- Some networks may need TURN later
- No paid providers are used
- No standalone browser extension yet
- No mobile app yet
- No payment system yet
- No large public rooms yet
- Generic HTML5 video detection only for MVP
- No site-specific streaming handlers yet

## Setup

Install dependencies from the repo root:

```bash
npm install
```

Copy environment files:

```bash
cp apps/server/.env.example apps/server/.env
cp apps/desktop/.env.example apps/desktop/.env
```

On Windows PowerShell:

```powershell
Copy-Item apps/server/.env.example apps/server/.env
Copy-Item apps/desktop/.env.example apps/desktop/.env
```

## Supabase Setup

1. Create a free Supabase project.
2. Open the SQL editor.
3. Run `supabase/schema.sql`.
   - Existing projects that already ran the older schema can run `supabase/social-beta.sql` once instead.
4. In Supabase Auth settings, enable email/password auth.
5. In Authentication > URL Configuration, set Site URL to your verification page. For the hosted MVP this is `https://havyn-socket-server.onrender.com/verify`.
6. Add these Redirect URLs:
   - `http://127.0.0.1:5173/**`
   - `http://localhost:5173/**`
7. Copy your project URL and anon key into `apps/desktop/.env`.

Desktop `.env`:

```env
VITE_SUPABASE_URL=your_supabase_project_url
VITE_SUPABASE_ANON_KEY=your_supabase_anon_key
VITE_SOCKET_SERVER_URL=http://localhost:4000
VITE_AUTH_REDIRECT_URL=https://havyn-socket-server.onrender.com/verify
```

Server `.env`:

```env
PORT=4000
CLIENT_ORIGIN=http://localhost:5173
```

## Run Locally

Start the signaling server:

```bash
npm run server
```

In another terminal, start the desktop app:

```bash
npm run desktop
```

You can also run both from the root:

```bash
npm run dev
```

## Testing With Multiple Users Or Windows

For the cleanest test, create two Supabase accounts and run two desktop windows. Electron uses a persistent embedded browser partition, so each participant still loads the media locally inside their own session.

If you need fully separate embedded browser sessions on one machine later, add a per-user Electron partition. The MVP keeps one persistent desktop partition for simplicity.

## Media Detection Test

The default URL field points to an MDN HTML5 video example. You can also open any page with a normal `<video>` element.

1. Host creates a room.
2. Host opens a video page.
3. Havyn shows media detected.
4. Host clicks `Use this media`.
5. Viewers automatically navigate to the same URL.
6. Each viewer detects media locally and becomes ready.
7. Host plays, pauses, seeks, and changes playback rate.

## Host-Only Playback Lock Test

1. Keep playback mode set to `host-only`.
2. Host selects detected media.
3. Viewer attempts to pause or seek using Havyn controls.
4. Server rejects the action and sends the authoritative host state.
5. Host actions continue to work.

The MVP drift correction is intentionally simple: every few seconds, clients compare against server time and seek if drift is greater than 1.5 seconds. Production can add smoother playback-rate correction and better latency handling.

## WebRTC Call Test

1. User joins call.
2. Second user joins call.
3. Confirm both can see and hear each other.
4. Test mute.
5. Test camera off.
6. Test leave call.
7. Try a fifth call participant and confirm the message: `Call is full. Maximum 4 participants allowed in MVP.`

The ICE config uses:

```js
const rtcConfig = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" }
  ]
};
```

Production should add TURN/coturn for reliability across stricter networks.

## Testing Checklist

Basic room test:

- Create account
- Create room
- Copy invite link
- Join from second app window/user
- Confirm participants appear

Media test:

- Host opens a video page
- Havyn detects media
- Host selects media
- Viewer auto-navigates to same page
- Viewer detects media
- Host plays
- Viewer plays in sync
- Host pauses
- Viewer pauses
- Host seeks
- Viewer seeks

Permission test:

- Set mode to host-only
- Viewer attempts to pause/seek
- Viewer action is blocked or corrected
- Host action works

Call test:

- User joins call
- Second user joins call
- Both see/hear each other
- Test mute
- Test camera off
- Test leave call
- Try fifth call participant and confirm it is blocked

## Future Migration Notes

- Persist live room state and chat messages to Supabase or a dedicated realtime store.
- Add TURN/coturn and connection-quality indicators for calls.
- Add per-user BrowserView partitions when testing multiple local identities in one desktop instance.
- Add cohost assignment controls.
- Add deep-link handling for `havyn://room/:roomId`.
- Add site-specific handlers only where legally and technically appropriate.
- Add app packaging and auto-update after the local MVP is stable.
