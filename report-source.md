# Web Playback-Control Research

## Revalidation of the submitted provider list

Date: 2026-09-12

The submitted notes described VidCore, VidLink, and `vidsrc.cc` as two-way
bridges. Havyn re-tested the exact suggested `{ event: "command", func:
"seekTo", args: [seconds, true] }` shape, its JSON-string form, and common
`PLAYER_COMMAND` variants in desktop Chrome and an iPhone-sized Chrome profile.
The result does not establish inbound control for any of them.

| Provider | Current published or shipped evidence | Exact live result | Havyn decision |
| --- | --- | --- | --- |
| VidCore | Its site lists outbound play, pause, and ended events; the live embed contains native timeline code but no parent-message receiver | Loaded, but emitted zero parent messages and ignored every play, pause, and seek payload | Not admitted as synced |
| VidLink | Its documentation and shipped bundle implement outbound `PLAYER_EVENT` and `MEDIA_DATA` | Outbound play/time updates worked. The exact seek/pause commands were ignored and playback continued normally | Not admitted as synced |
| `vidsrc.cc` | No current first-party command contract could be verified | Both documented-looking embed routes returned a frame-blocking response on desktop and phone profiles | Not admitted |
| `vidsrc.to` | Current public documentation describes embed routes and query parameters, not a parent command protocol | Loaded but emitted zero messages and ignored all commands | Not admitted as synced |
| Embed.su | No current first-party contract could be reached | DNS did not resolve during both test passes | Not admitted |

VidLink is useful as an observation source, but Havyn intentionally has no
manual-only provider tier. A provider enters the synchronized pool only after a
live parent-to-player play, pause, and seek round trip succeeds.

Sources: [VidCore current documentation](https://www.vidcore.org/), [VidLink
current documentation](https://vidlink.pro/), and [VidSrc.to current
documentation](https://vidsrc.to/). The live results were captured by Havyn's
local iframe probe on 2026-09-12.

## TURN service comparison

Date: 2026-09-12

| Service | Free or entry allowance | Published paid model | Fit for Havyn |
| --- | --- | --- | --- |
| Cloudflare Realtime TURN | First 1,000 GB/month shared across Realtime SFU and TURN; STUN is free | $0.05/GB beyond the included allowance | Best current default on allowance and price |
| Metered Open Relay | 20 GB/month on the developer Open Relay service; commercial trial is 500 MB | Plans start at 150 GB for $99, then $0.40/GB on that tier | Simple secondary account option, much smaller free pool |
| Xirsys | 30-day global trial; afterward a free testing region with limited channels and sockets; STUN is free | Paid production plans unlock global regions, routing, and SLA | Better production support, not a larger continuing free allowance |
| Twilio Network Traversal Service | STUN is free | TURN begins at $0.40/GB in the US and Europe and costs more in some regions | Mature, but materially more expensive |
| AWS Kinesis Video Streams WebRTC | No comparable standing 1 TB allowance | US East example charges $0.12 per 1,000 TURN streaming minutes plus signaling and data transfer | Useful AWS-native alternative, harder to predict and operate |

Cloudflare remains the strongest freemium default. Havyn's global relay editor
therefore supports either another Cloudflare account or conventional static
TURN credentials. Rotating a key within the same Cloudflare account does not
reset that account's monthly allowance.

Sources: [Cloudflare Realtime pricing](https://developers.cloudflare.com/realtime/pricing/),
[Metered pricing](https://www.metered.ca/pricing), [Metered Open
Relay](https://www.metered.ca/tools/openrelay/), [Xirsys
FAQ](https://xirsys.com/faq), [Twilio NTS
pricing](https://www.twilio.com/en-us/stun-turn/pricing), and [AWS Kinesis Video
Streams pricing](https://aws.amazon.com/kinesis/video-streams/pricing/).

Date: 2026-08-28
Audience: Havyn product and engineering

## Direct answer

A standard web app cannot inspect or control media inside an arbitrary third-party tab or iframe. The browser same-origin policy permits only limited cross-origin window access; a provider must intentionally expose a supported messaging API for Havyn to coordinate its player. See [MDN: Same-origin policy](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Same-origin_policy) and [MDN: `Window.postMessage`](https://developer.mozilla.org/en-US/docs/Web/API/Window/postMessage?lang=en).

## Browser-only alternatives

- **Provider adapter:** The only route to per-participant play/pause/seek synchronization in a normal web browser. The provider must support state events plus inbound commands.
- **Host screen-share mode:** A host can select a tab/window with `getDisplayMedia()` and transmit that MediaStream through WebRTC. It gives every viewer the same host video, but does not expose or control the original player's timeline. The selection is always user-mediated and support varies by browser. See [MDN: `getDisplayMedia()`](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getDisplayMedia).
- **Media Session is not a workaround:** It lets a page describe and handle the media session for media the page itself is handling; it is not a cross-tab inspection/control API. See [MDN: Media Session](https://developer.mozilla.org/en-US/docs/Web/API/MediaSession).

## StreamHub provider audit

The referenced `Swabhimanc/StreamHub` source normalizes VidCore, VidFast, and VidRock as iframe URL templates and passes an autoplay URL parameter. Its `PlayerEmbed` is a plain iframe; it contains no provider event listener, inbound command message, or room-sync adapter. This proves StreamHub itself does not supply the missing control layer.

| Provider | Documented outbound state | Documented inbound play/pause/seek | Research status |
| --- | --- | --- | --- |
| Peachify | Yes: `PLAYER_EVENT` plus progress data | No: Peachify docs say parent-to-player commands are currently disabled | Observation/manual sync only until Peachify changes this |
| VidCore | Yes: play, pause, ended in its published API | Not found in published documentation | Observation only |
| VidFast (`vidfast.vc`) | Not verified in first-party documentation | Not verified | Do not classify as synchronized |
| VidRock (`vidrock.net`) | Not verified in first-party documentation | Not verified | Do not classify as synchronized |

## Providers with a published two-way contract

These sites publish an iframe control protocol suitable for a Havyn adapter. Their availability and operational quality still require a live, multi-browser integration test before product adoption.

| Provider | Published control surface | Notes |
| --- | --- | --- |
| [CineSrc](https://cinesrc.st/docs) | `cinesrc:command` supports play, pause, seek, volume and getters; it emits ready, timeupdate, play, pause, seeked and ended events | Best-documented movie/TV candidate found in this pass |
| [MoviesAPI](https://moviesapi.to/) | Documents play, pause, seek, volume, status request and matching state events | Community evidence also flags nuisance/popup and devtools-reload behaviour; test carefully before relying on it |
| [Strigil](https://strigil.cc/) | Documents `PLAYER_COMMAND` play, pause, seek and full event forwarding | Newer provider; no independent maturity signal found in this pass |
| [VidZen](https://vidzen.fun/) | Documents commands for play, pause, seek, volume and status plus event callbacks | Newer provider; no independent maturity signal found in this pass |
| [VidScene](https://www.vidscene.app/docs) | Documents two-way postMessage integration | Candidate needs a live adapter test |

## Live iframe probe: 2026-08-28

Test environment: a local parent page embedded each provider's own documented movie URL and sent its published play, pause, seek-to-60-seconds, and status messages using the exact provider origin. The probe accepted only messages whose origin exactly matched the provider origin.

| Provider | Load and frame | Event observation | Inbound controls | Result |
| --- | --- | --- | --- | --- |
| CineSrc | Passed | Passed: ready, metadata, source, play, timeupdate, seeked, pause, getter response | Passed: play, pause, seek, getCurrentTime | **Pass: sync-capable** |
| MoviesAPI | Passed | Passed: play, pause, seeked, timeupdate, playerstatus | Passed: play, pause, seek, getStatus | **Pass: sync-capable, but reserve as fallback pending stability testing** |
| Strigil | Passed | Passed: metadata and detailed playback events | Passed: play, pause, seek | **Pass: sync-capable** |
| VidZen | Passed visual frame | No postMessage events received | Published JSON commands produced no observable result | **Fail: not admissible** |
| VidScene | Failed: iframe reported `player.vidscene.app refused to connect` | Not testable | Not testable | **Fail: not admissible** |

The live test is a Chrome desktop integration check. It does not substitute for Safari/iOS, Android, multi-user, extended-duration, or regional availability testing.

## Recommendation

1. Build Havyn's adapter boundary once: `load`, `subscribe`, `getStatus`, `play`, `pause`, and `seek`.
2. Admit CineSrc, Strigil, and MoviesAPI to a staged provider pool, with CineSrc as the first integration and MoviesAPI as a fallback only.
3. Reject VidZen and VidScene from the current pool because their live behaviour failed the baseline iframe test.
4. Treat Peachify and VidCore as telemetry/manual-sync providers today.
5. Do not use iframe reload plus URL parameters as a pseudo-control protocol; it breaks provider state and recreates the unwanted reload loop.
6. Before production promotion, run the same probe in Safari/iOS and Android Chrome, then run a two-browser, repeated play/pause/seek test against one room.

## Limitations

Provider documentation is self-published and can change. Searches of GitHub and Reddit found no independent evidence that VidFast or VidRock support a two-way protocol. Search findings about MoviesAPI include reports of popup/nuisance and reload behaviour, so its documentation alone is insufficient for product acceptance.

---

# iPhone and iPad Call Audio Research

Date: 2026-09-02
Audience: Havyn product and engineering

## Scope and direct answer

Question: can Havyn Web keep the microphone active in a room call without iOS
moving the provider audio into its quieter call-audio behavior, by changing
browser or using a browser-only bypass?

**No reliable web-only bypass exists today.** An active microphone capture track
is defined as a `play-and-record` audio-session element. The W3C Audio Session
specification states that a browser ends the microphone track when the audio
session is neither `play-and-record` nor `auto`. Consequently, forcing
`navigator.audioSession.type = "playback"` cannot preserve a live microphone.
The supported conference configuration is `play-and-record`, which Havyn now
sets before acquiring camera and microphone.

This is not an accidental Havyn volume setting: the iOS browser changes its
underlying audio routing/level when microphone capture starts. WebKit's active
issue documents that `playback` does not help while microphone capture
continues, and reports the same half-volume behavior after `play-and-record`
is selected.

## Browser audit

| Option | Different iOS audio engine today? | Result for Havyn's issue |
| --- | --- | --- |
| Safari | No; this is the WebKit implementation in question | Not a bypass |
| Chrome, Edge, Opera | No evidence of a shipped non-WebKit iOS engine | Not a bypass |
| Firefox | Mozilla documents that Firefox for iOS uses WKWebView, not Gecko | Not a bypass |
| Brave | Brave explicitly documents WebKit on iOS | Not a bypass |
| EU alternative-engine browser | Apple permits an entitlement in the EU, but Mozilla reports that no browser developer has met the requirements as of 2026-09-01 | No product a Havyn user can rely on today |
| Android phone/tablet | Yes; Chromium/Firefox engine paths differ | Could be a practical device alternative, but does not fix iPhone/iPad web |

The European Union entitlement is real, but it is not an end-user switch. Apple
requires the browser developer to obtain the entitlement, ship a separate
engine-bearing browser app, and meet ongoing technical and security criteria.
It therefore cannot be used by Havyn Web, and it does not make the installed
iOS versions of familiar browsers a different-engine test target.

## Workarounds considered

1. **Force `playback` while retaining mic capture:** rejected. It conflicts with
   the Audio Session microphone-track rules and WebKit reports it does not solve
   the issue while capture continues.
2. **Use `auto`:** rejected. A microphone's default session type is
   `play-and-record`, so it produces the same class of behavior.
3. **Disable echo cancellation, noise suppression, and auto gain control:**
   retained for the Apple call path as a best-effort mitigation. It has helped
   some WebKit reports but is not dependable and can reduce call echo quality.
4. **Web Audio gain/"volume booster":** rejected. Havyn cannot capture or
   re-amplify the audible stream of a cross-origin provider iframe. The provider
   owns that media surface, and the browser's same-origin rules prevent Havyn
   from wiring it into a gain node. Even same-origin audio cannot exceed the
   platform's call-routing constraint this way.
5. **Install Havyn as a PWA or use private browsing:** rejected. Those remain on
   the iOS WebKit audio stack.
6. **Bluetooth/phone speaker plus the hardware volume buttons:** a practical
   user-side mitigation only. Apple documents that the buttons control the
   active call/media volume. It cannot guarantee the original provider level or
   change WebKit's routing policy.
7. **A native Havyn app:** technically viable because native code can configure
   AVAudioSession directly, but excluded by the product request.
8. **Separate call device:** technically viable as a no-app workaround: leave
   provider playback on iPad/iPhone A and join Havyn's call on another browser
   device. It avoids microphone capture in the provider device, but changes the
   desired one-device experience.

## Recommendation

Do not tell users to install Chrome, Firefox, Edge, Brave, or Opera on iOS as a
fix: current evidence says they do not alter the relevant audio engine. Keep
Havyn's standards-compliant full-duplex `play-and-record` behavior, apply the
Apple best-effort input constraints, and avoid promising that iOS web can keep
provider media at normal playback level while its microphone is live. If a
one-device, full-volume iPhone/iPad experience is a non-negotiable product
requirement, it needs a native route; otherwise, a second-device call is the
only dependable no-app workaround.

## Sources consulted

- [W3C Audio Session specification](https://w3c.github.io/audio-session/),
  accessed 2026-09-02. Defines microphone tracks as `play-and-record` and the
  behavior when another session type is chosen.
- [WebKit issue 236219](https://bugs.webkit.org/show_bug.cgi?format=multiple&id=236219),
  accessed 2026-09-02. Documents that `playback` does not solve continued mic
  capture and records persistent low-volume results.
- [Apple: alternative browser engines in the EU](https://developer.apple.com/support/alternative-browser-engines/),
  accessed 2026-09-02. Describes the entitlement and regional restrictions.
- [Mozilla: Firefox iOS source documentation](https://firefox-source-docs.mozilla.org/overview/ios.html),
  accessed 2026-09-02. States that Firefox iOS does not use Gecko and uses
  WKWebView for web interaction.
- [Brave: About Brave](https://brave.com/about/), accessed 2026-09-02. States
  that Brave on iOS uses Apple's WebKit.
- [Mozilla policy update](https://blog.mozilla.org/netpolicy/2026/09/01/browsers-compete-on-privacy-when-the-operating-system-allows/),
  2026-09-01. States no browser developer has met Apple's alternative-engine
  conditions in practice.
- [Apple Support: adjust iPhone volume](https://support.apple.com/en-euro/guide/iphone/iphb71f9b54d/ios),
  accessed 2026-09-02. Documents hardware volume controls during calls/media.

---

# Room Viewport and Theater Clipping Research

Date: 2026-08-29
Audience: Havyn product and engineering

## Direct answer

The clipping is a layout-sizing fault, not an operating-system taskbar fault. The room previously combined large viewport heights (`vh`), dynamic viewport heights (`dvh`), fixed bottom padding, and nested CSS Grid tracks. On iPad and mobile browsers, that can either put the bottom of the room below visible browser chrome or make a nested flexible `1fr` media row lack a definite height. The latter was also the direct cause of the fullscreen regression: the provider row collapsed, leaving only the Call strip.

## Evidence

- [MDN: CSS length values](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Values/length) states that `vh` is equivalent to `lvh` in current browsers. Large viewport sizing can obscure content while browser UI is visible; `dvh` tracks visible browser UI but can change while scrolling.
- [WebKit: Safari 15.4 viewport units](https://webkit.org/blog/12445/new-webkit-features-in-safari-15-4/) documents the small, large, and dynamic viewport model introduced for Safari and iPadOS.
- [MDN: VisualViewport](https://developer.mozilla.org/en-US/docs/Web/API/VisualViewport) exposes the visible viewport height in CSS pixels, and [MDN: VisualViewport resize](https://developer.mozilla.org/en-US/docs/Web/API/VisualViewport/resize_event) documents its resize event. This is broadly available across current browsers.
- [CSS Grid Level 2](https://drafts.csswg.org/css-grid/) specifies that flexible `fr` tracks use remaining available space only when the grid container has a definite size. It also describes the automatic minimum sizing behavior that can make nested content overflow instead of shrink.

## Implemented model

1. Havyn now writes the actual `VisualViewport.height` into one root CSS variable and updates it when the visible browser area changes.
2. The room app alone uses that variable as its fixed workspace height. The page cannot become a taller scrolling document behind the room.
3. The normal and theater layouts receive a definite grid height and use `minmax(0, 1fr)` for the provider row, so the media is the flexible area.
4. Theater's call rail is a bounded second grid row. Its resize limit is calculated from the actual room height, so enlarging the call rail reduces provider space rather than pushing it underneath Safari or the desktop taskbar.
5. Fullscreen uses its own single-row grid and no artificial bottom gutter. The broken `height: auto` experiment is removed.

## Remaining validation

The source builds successfully. Direct automated inspection of the signed-in browser was unavailable during this run, so the final visual confirmation must be performed after deployment in desktop Chrome and iPad Safari, including address-bar-expanded and fullscreen states.

---

# Provider Playback-Contract Follow-up

Date: 2026-08-30
Audience: Havyn product and engineering

## Scope correction

This follow-up is deliberately a technical contract audit, not a judgment about
any provider. The question is only whether an iframe player gives Havyn both
directions needed for authoritative room playback: observable player state and
inbound play, pause, seek, and status commands.

## Current technical shortlist

| Provider | Outbound state contract | Inbound command contract | Current Havyn result |
| --- | --- | --- | --- |
| CineSrc | ready, play, pause, timeupdate, seeked, errors, getters | `cinesrc:command` for play, pause, seek, and getters | Integrated and retained as a synced adapter |
| Strigil | detailed player events reported by the existing live probe | `PLAYER_COMMAND` play, pause, and seek reported by the probe | Integrated and retained as a synced adapter |
| MoviesAPI | play, pause, seeked, timeupdate, and status reported by the existing live probe | play, pause, seek, and status reported by the probe | Integrated as the lower-priority synced fallback |
| VidZen | published `PLAYER_EVENT` events and JSON command examples | play, pause, seek, volume, and status | Published contract is promising, but the prior live probe observed no events or command effect; not admitted |
| VidScene | `VIDSCENE_PLAYER_EVENT` includes play, pause, timeupdate, seeked, status, and errors | `VIDSCENE_PLAYER_COMMAND` supports play, pause, seekTo, and getStatus | Published contract is complete, but the prior live frame was refused; not admitted |
| YouTube | official player state-change event and time API | official IFrame API play, pause, and seek | First-class synced adapter; activity events now also enter the room timeline |

## Admission rule

Havyn should only add a provider after a current two-browser room test proves:

1. Local play, pause, and seek each produce a provider event.
2. The room worker broadcasts the authoritative command and sequence.
3. A second participant applies that command without echoing it back.
4. A status read and periodic time report converge the two participants after drift.
5. The same flow works in the target embedded browser, including mobile where supported.

No provider should be described as synchronized on documentation alone.
