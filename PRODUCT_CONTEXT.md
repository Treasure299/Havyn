# Havyn Product Context

Last consolidated: 2026-08-30

## Purpose

Havyn is a desktop-first social watch-party platform: a premium shared virtual living room for people watching remotely. Its core value is not supplying video. Its core value is making separate viewing sessions feel like one private room through invitations, presence, synchronized state, conversation, and optional calls.

The experience should prioritize immersion, simplicity, stability, privacy, and cinematic presentation over feature quantity.

## Product ownership boundary

### Havyn owns

- Accounts, profiles, friends, notifications, and presence.
- Content-discovery metadata and watchlists.
- Private and public room creation and lifecycle.
- Invite links, room codes, direct friend invitations, and access control.
- Host, co-host, and viewer roles.
- Participants, chat, reactions, optional voice/video calls, and Live Share where supported.
- Authoritative shared playback state, permissions, readiness, drift handling, and sync status.
- Provider selection, provider capability reporting, switching, recovery, and browser fallback.

### A provider owns

- Its native browsing/search/detail experience when used directly.
- Content availability and licensing in the user's region.
- User authentication and subscription state.
- Source, episode, subtitle, and quality selection.
- Media delivery, DRM, codecs, and its native player.

Each participant uses their own authorized provider session. Havyn must not transmit, proxy, extract, download, decrypt, or redistribute media or credentials.

## Current product baseline

The current desktop application is React/Vite inside Electron with Supabase-backed identity/social data, realtime room coordination, chat, WebRTC calling, and an integrated browser/playback layer. The existing project includes:

- Landing, authentication, dashboard, content discovery, watchlist, and entertainment-news views.
- Private/public room creation and joining through invite or room code.
- Friends, invitations, presence, participant roles, and notifications.
- Room chat and optional small-group voice/video calls.
- Embedded browsing, media detection, playback synchronization, permissions, recovery, and Live Share work.
- A dark, cinematic visual system with near-black surfaces, thin borders, compact radii, glass layers, white/muted typography, and red as the principal Havyn accent.

The current implementation—not an old mockup—is the visual and behavioral source of truth.

## MVP V2 product thesis

MVP V2 should be built around **providers**.

The first provider is the practical viewing engine around which the initial experience can be built, similar to the studied MovieMe fork. It is not Havyn's permanent product identity. The architecture must allow more provider adapters and an external-browser mode later.

The durable rule is:

> A provider can interrupt playback, but it must never destroy the Havyn room.

Room membership, privacy, invitations, chat, reactions, call state, selected title, provider choice, and authoritative playback state live outside the provider surface.

## Intended MVP V2 journey

### Discovery-first path

1. The user signs into Havyn and opens Discover.
2. The user browses or searches Havyn's provider-independent catalog metadata.
3. The user selects a title and clicks **Create room**.
4. Havyn immediately creates a private, invite-only room associated with that title.
5. Havyn offers a lightweight invitation step:
   - Invite Havyn friends.
   - Copy an invite link.
   - Copy a room code.
   - Skip and enter alone.
6. The user chooses or accepts their preferred viewing method:
   - Use the configured embedded provider.
   - Open in a normal browser.
   - Choose another configured provider when available.
7. Havyn opens the shared room while the chosen provider supplies browsing/playback.
8. The persistent room-level **Invite** action remains available after room creation.

### Provider-first path

When the user enters a provider first, its native search, detail, source, episode, and player flows remain intact. Once a title is selected or playback is ready, Havyn can create or attach a private room and expose invitation/sync controls without replacing the provider interface.

Both paths should converge on the same durable Havyn room model.

## Room experience

When a provider is embedded, its working surface should remain central and recognizable. Havyn should appear as restrained, trusted companion chrome, such as:

- A slim room strip for privacy, title, sync state, participant count, Invite, provider choice, and browser switching.
- A collapsible companion drawer for participants, chat, reactions, pending invitations, and call state.
- Existing trusted browser/protection controls kept distinct from social-room controls.

Do not build a generic Havyn-native player merely to imitate the provider. Do not duplicate provider-native source, episode, authentication, or playback UI inside Havyn unless a future approved provider API requires it.

## Invitation requirements

Invitations are a core flow, not a secondary setting.

They must be available:

- Immediately after creating a room from Discover.
- From a persistent Invite action inside every active room.
- Through direct friend selection, link sharing, and room codes.

The invite surface should show sent/accepted state when practical. A recipient joins the Havyn room first, sees the selected title and room state, then chooses a supported viewing method.

## Provider contract

Provider adapters should expose capabilities rather than pretending all providers behave identically. A conceptual adapter includes:

```text
identity and display metadata
resolve(title)
open(title or destination)
embedded support
external-browser support
readiness detection
playback-state observation
playback-command application
navigation/title detection
recovery and teardown
```

Useful capability flags include:

- `embedded`
- `externalBrowser`
- `titleResolution`
- `playbackRead`
- `playbackControl`
- `navigationSync`
- `requiresUserAccount`
- `manualSyncOnly`

A provider switch should replace/recreate only the isolated provider surface. The Havyn room remains connected.

## Synchronization principles

- The server maintains authoritative room playback state.
- Playback permissions remain role-based: host-only by default, with co-host/everyone modes where supported.
- When a newly selected media session has synchronized locally, every participant sees a centered, media-blocking readiness overlay until the room starts playback. Ordinary pause, seek, and resume actions must not re-show it.
- Full sync is shown only when the active adapter can reliably observe and apply play, pause, seek, and time state.
- External-browser support may use a browser extension or approved provider adapter. Without one, label it **Manual sync** rather than implying automatic synchronization.
- DRM itself does not necessarily prevent coordination: an authorized extension can observe/control a locally rendered player without touching the protected stream. Provider-specific maintenance, user subscriptions, extension permissions, store policies, and provider terms remain real constraints.
- Never weaken isolation or expose a general remote-page bridge merely to obtain synchronization.

## Isolation and security direction

The MovieMe fork established a useful pattern:

- Remote provider content lives in an isolated, ephemeral/incognito webview.
- Trusted local UI owns navigation, recovery, privacy/protection state, and Havyn room coordination.
- Provider pages do not receive general native capabilities.
- Top-level origins are allowlisted; popups, downloads, external schemes, and unnecessary permissions are denied.
- The trusted surface survives remote-view crashes and recreates the provider surface cleanly.

For multiple providers, replace the single-origin assumption with audited provider descriptors and per-provider allowlists. Provider switching should recreate the remote surface rather than weakening origin policy.

Camera and microphone permissions for Havyn calls belong to trusted Havyn UI, not the provider page. Remote providers should remain untrusted even when selected by the user.

## Web, extension, desktop, and mobile direction

### Web MVP decision (2026-08-28)

Havyn Web is a Cloudflare-hosted social and discovery surface using the existing
Havyn identity and Durable Object room authority. It offers TMDB-backed title
discovery, private room creation, invitations, presence, chat, and a
provider-selection handoff. A selected title and provider are durable room
metadata, so a participant can enter an existing room without recreating the
room's social state.

Web providers remain provider-owned: each participant uses their own authorised
session and Havyn must state whether a provider is manual-sync only. The first
web release does not proxy media or claim dependable iframe control for a
provider that blocks embedding. A browser extension remains a later capability
for coordinating provider tabs outside Havyn Web.

### Public positioning decision (2026-08-30)

Havyn Web is the flagship public entry point while it is tested as a live demo.
The public landing page should offer a direct, ungated **Open Havyn Web** action
before desktop-download conversion. The page must visibly label Web as a demo
and avoid implying that every provider offers synchronized playback. The email
signup remains the secondary path for the higher-capability Windows beta and
the future Mac build.

Havyn Web's public promise is device-wide: the durable room, discovery,
invitations, presence, chat, and compatible call experience should be available
across phones, tablets, and computers, including iPhone, iPad, Android, Mac,
and Windows browsers. Marketing should lead with this cross-device advantage,
while still stating that embedded provider playback and synchronization
capability can vary by device, browser, provider, and region.

### Guest-room decision (2026-08-30)

Havyn Web supports a deliberately limited **guest** identity. A guest receives
a temporary local display name and may create a private room as its host, join
an existing room by its code or shared link, choose a provider when hosting,
and share their room only by link or code. Guests are never written to the
friends graph and do not have friend invitations or a persistent profile. The
room surface itself remains consistent with signed-in rooms, including its
room chat and calls.
Guest room tickets are signed and scoped to the room; hosts can identify guests
in the participant list and remove or change their role like any other room
participant. Guests are not a way around provider authorization: each person
still uses their own provider session.

### YouTube room decision (2026-08-29)

YouTube is a first-class embedded web provider. Havyn may use YouTube's official
iframe player API to coordinate play, pause, and seek state through
the existing room authority. Discovery search uses YouTube Data API v3 through
the server-side content worker; its key is never shipped to the browser. Havyn
does not store or proxy Google credentials. People sign in through the normal
top-level YouTube page and the browser retains that session subject to the
browser's own privacy rules.

Because the normal YouTube homepage cannot be framed reliably in Havyn Web,
the room can instead open a native, API-backed YouTube browse surface. Choosing
a result replaces only the provider surface with YouTube's official embedded
player; the durable Havyn room, invitations, chat, and authority remain intact.

### Audited web-provider decision (2026-08-28)

The current web provider pool is capability-based rather than a generic list of
embeds. CineSrc is the primary synced provider, with Strigil as a secondary
synced provider and MoviesAPI as a lower-priority fallback. Each passed a live
iframe probe for playback and inbound play, pause, and seek commands using a
provider-specific `postMessage` adapter. VidRock, VidCore, and VidFast are
retired from the web picker. VidZen and VidScene are excluded because they did
not expose a dependable playable/control surface during testing. Peachify and
other outbound-only providers remain manual-sync candidates until they offer a
documented, inbound command contract.

Only an adapter with both verified observation and command application may be
presented as **Synced playback**. The room remains usable if an adapter fails;
Havyn must show a clear recovery choice rather than silently claiming sync.

The 2026-09-12 revalidation also excluded VidLink, `vidsrc.cc`, `vidsrc.to`,
and Embed.su from the synced pool. VidLink's outbound events are real, but its
current player ignored exact parent play, pause, and seek commands. VidCore's
live embed emitted no bridge events; `vidsrc.cc` refused framing; `vidsrc.to`
did not expose a live message bridge; and Embed.su did not resolve. On a phone,
Havyn may recover locally from an unresponsive synced-provider frame by using
the already verified MoviesAPI adapter without changing the provider surface
for healthy participants. Readiness requires an actual provider bridge event,
not merely the iframe load event.

### Desktop

Desktop remains the highest-capability Havyn experience because it can host an isolated provider webview, provider adapters, protection controls, richer Live Share, and recovery.

### Web plus extension

A future Havyn Web product can provide zero-install room entry for accounts, invitations, chat, calls, presence, and social state. A Manifest V3 browser extension can connect a normal top-level provider tab to the Havyn room and apply narrow provider adapters. This is preferable to fragile iframe/header/cookie workarounds.

### Android

Android can support Havyn's social layer, invitations, rooms, chat, calls, and compatible web-video coordination. Its provider surface must use Android-native WebView/app integration rather than Electron. Protected playback, screen/audio capture, and arbitrary WebView control cannot be guaranteed; external-app/manual-sync fallbacks are required.

## Visual identity

- Brand spelling: **Havyn**.
- Desired character: premium, cinematic, futuristic, minimal, calm, and trustworthy.
- Viewing/provider content is the visual focus.
- Use near-black backgrounds, layered dark surfaces, subtle glass, thin soft borders, compact 7–8px radii, restrained glow, strong hierarchy, and smooth low-key motion.
- Current application tokens center on near-black `#08080a`, dark surfaces around `#111115`/`#181820`, white text, muted gray, and Havyn red around `#ef3e3a`; blue/green/yellow are secondary functional statuses.
- Avoid clutter, oversized bubbly cards, excessive neon, purple brand takeover, and generic dashboard compositions.
- Extend current screens and interaction density before inventing a new design language.

## Rejected direction

The following direction was explicitly rejected and must not be revived without a new user decision:

- Replacing a working provider's browse/detail/player experience with a generic Havyn-native discovery page or player.
- Making the provider a large abstract modal or treating it as a mere icon behind an invented Havyn playback surface.
- Designing without first inspecting the current Havyn implementation and the chosen provider's real flow.

The corrected model is a premium Havyn companion layer around or adjacent to the provider's functioning experience.

## Current MVP constraints and known risks

- Rooms are optimized for small private sessions.
- Voice/video calling targets a small group and uses Cloudflare TURN when direct WebRTC connectivity fails. The room coordinator exchanges a server-side TURN key for short-lived, participant-specific credentials through fresh room-scoped tickets. Long-term credentials remain Worker secrets and are never shipped to the browser or committed. Direct calls are preferred. The relay meter uses Cloudflare's account-level TURN egress analytics when configured, with a device-local selected-relay estimate as fallback, and estimates overage after Cloudflare Realtime's shared 1,000 GB monthly SFU/TURN free tier at the published rate. During the web beta, every signed-in account is an administrator and may replace the global relay with a different Cloudflare account or standard STUN/TURN credentials; guests cannot. Secrets are submitted only to the coordinator and the settings read endpoint never returns them. Active callers must rejoin after a global relay change.
- Provider UI and internal APIs can change, so adapters require maintenance and testing.
- Autoplay and browser gesture requirements can interrupt automatic room startup.
- Every participant may need their own provider account/subscription.
- Provider availability varies by region and account.
- Provider terms, authorization, licensing, and extension-store requirements must be reviewed before public integration.
- Title detection based on brittle DOM scraping should be avoided. Prefer audited metadata/adapters or an explicit user confirmation.
- Narrow windows and fullscreen need the Haven drawer to collapse so the provider regains maximum space.

## Planning priorities

Unless the user changes scope, plan MVP V2 in this order:

1. Define the provider interface and room/provider data model.
2. Make room creation independent from provider loading.
3. Connect Discover title selection to private-room creation.
4. Add invitation flow immediately after creation and persist Invite inside the room.
5. Implement one isolated embedded-provider adapter.
6. Implement **Open in browser** as a first-class viewing choice.
7. Add capability-aware sync/manual-sync states and recovery.
8. Add provider switching without disconnecting the room.
9. Validate privacy, security boundaries, provider failure, reconnects, narrow-window behavior, and fullscreen.
10. Only then add more providers or platform variants.

## Decision log

- Havyn is the durable room/social/sync layer; providers are replaceable viewing engines.
- The initial MVP V2 can be built closely around one provider, but the provider boundary must support future additions.
- Users can choose embedded-provider mode or switch to a normal browser.
- Discover can create the room directly from a selected title.
- Invitations are required both immediately after room creation and inside an existing room.
- Provider-native browsing/player UI remains central when used; Havyn should not replace it.
- Room continuity takes priority over provider continuity.
- CineSrc, Strigil, and MoviesAPI are the current web provider adapters; their
  ability to sync is verified per adapter, not inferred from being embedded.
- Havyn Web is the flagship public entry point, presented as a live demo; the
  Windows/Mac signup is a secondary desktop-access path.
- Havyn Web's flagship advantage is cross-device room access on phones,
  tablets, and computers; provider playback capability remains device-aware.
- Discover uses a media-led, rotating title hero followed by a compact
  discovery workbench: search and filters sit beside the user's Havyn social
  context, so title selection, room creation, and invitations remain one
  continuous flow rather than separate dashboard panels.
