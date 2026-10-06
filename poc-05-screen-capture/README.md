# POC #5 — Screen Capture / Live Proctor Viewing

Part of the AI Proctoring R&D track. See [`../R&D.md`](../R&D.md) Section 27 for the
research, options considered, measured results, and architecture implications this
POC produced.

## What this validates

> Can a candidate share their **entire screen** from a normal desktop browser, and
> can a proctor view it **live**, with low latency and modest bandwidth, and be told
> immediately when sharing stops or the candidate picks the wrong surface?

This is a **standalone, unwired prototype**, same as POC #1–4, #6 and #7. It does not
touch any Rails route, controller, model, or production JS bundle, and is not
connected to VerifyID-Portal or qababoardweb in any way.

## What it is NOT

Not built on purpose: remote control (the browser can't do it, and it isn't needed
— see R&D.md Section 27), recording (POC #7 covers evidence clips), authentication,
TURN relay, an SFU, or any AI analysis of screen content. Nothing triggers automatic
action. Every screen event is information for a human proctor, following the existing
Decision Log entry on Automatic Exam Pause.

## How it works

```
candidate.html ──getDisplayMedia()──► screen track
      │                                   │
      │  POST /signal, /status            │  WebRTC (DTLS-SRTP, peer-to-peer)
      ▼                                   ▼
  server.js  ──SSE──►  proctor.html  ◄────┘   video never touches server.js
```

- [`server.js`](server.js): plain Node.js, no npm dependencies. It's a **signaling
  relay only**: it passes offer/answer/ICE messages and candidate status between
  peers, using the same transport as POC #6 (POST up, Server-Sent Events down). It
  never receives any video.
  - `GET /signal/stream?role=candidate|proctor&id=…`: one SSE stream per tab.
  - `POST /signal`: relays `view-request` / `offer` / `answer` / `ice` / `hangup`
    to one peer. Other types are rejected.
  - `POST /status`: the candidate's share status plus screen events, sent to every
    proctor.
- [`candidate.html`](candidate.html) / [`candidate.js`](candidate.js):
  - `getDisplayMedia()` with the Chrome/Edge hints `displaySurface: "monitor"`,
    `monitorTypeSurfaces: "include"`, `selfBrowserSurface: "exclude"`,
    `surfaceSwitching: "exclude"`. These are **hints only**: the candidate can still
    pick a window or tab.
  - **Enforcement** happens after the pick. `track.getSettings().displaySurface`
    must be `"monitor"`, otherwise the share is stopped and `WRONG_SURFACE` is
    logged.
  - Events: `SCREEN_SHARE_STARTED`, `SCREEN_SHARE_STOPPED` (from the browser's own
    "Stop sharing" bar, via the track's `ended` event), `SCREEN_SHARE_DENIED`,
    `WRONG_SURFACE`, `SURFACE_UNVERIFIED`, `SCREEN_SHARE_PAUSED/RESUMED` (track
    mute), `MULTIPLE_MONITORS` / `MONITOR_CONFIG_CHANGED` (from `screen.isExtended`,
    plus optional `getScreenDetails()`), and `QUALITY_PROFILE_CHANGED`.
  - One `RTCPeerConnection` per viewing proctor, with `contentHint = "detail"` and
    `degradationPreference = "maintain-resolution"` so text stays sharp and frames
    are dropped under pressure.
  - Quality profiles (applied live with `setParameters`): Low 1 fps / 300 kbps /
    ≤1280 wide · Balanced 5 fps / 1 Mbps / ≤1920 · High 15 fps / 2.5 Mbps / ≤1920.
  - The page shows how many proctors are viewing. The browser's own sharing
    indicator is always visible too, and the page can't hide it.
- [`proctor.html`](proctor.html) / [`proctor.js`](proctor.js): one tile per connected
  candidate. It connects automatically when a candidate starts sharing and
  reconnects when they re-share. Per-tile live stats come from `getStats()`:
  resolution, fps, bitrate, RTT, jitter-buffer delay, decode time, freezes/packet
  loss. Click a tile to view it full screen.
- **Glass-to-glass latency probe.** With "Latency probe" ticked, the candidate page
  paints `Date.now()` as a strip of coloured and black/white cells in its top-left
  corner. The proctor page finds and decodes that strip in the *received video
  frames*, so it measures the real end-to-end delay (capture + encode + network +
  decode + render), not just network RTT. This only works when both pages share a
  clock (same machine, or NTP-synced machines). Keep the candidate window visible on
  the shared screen: if it's hidden, the proctor shows "probe frozen" instead of a
  wrong number.

## Running it

```bash
cd poc-05-screen-capture
node server.js
# Candidate: http://localhost:8030/candidate.html
# Proctor:   http://localhost:8030/proctor.html
```

- **getDisplayMedia needs a secure context.** The candidate page must be opened on
  `localhost` (or over HTTPS). To test across two machines, run the candidate on the
  machine running `server.js` (`localhost`) and open the proctor page from the other
  machine at `http://<server-ip>:8030/proctor.html`. WebRTC itself works over plain
  HTTP.
- No STUN/TURN by default; same machine and same LAN connect directly. Add `?stun=1`
  to both pages to try a public STUN server across networks. There's no TURN, so
  some networks (symmetric NAT, corporate firewalls) **will not connect**. That's
  expected, and it's an architecture finding, not a bug.
- **macOS:** the browser needs System Settings → Privacy & Security → **Screen
  Recording** permission. The first time, Chrome asks you to quit and reopen it. Until
  then, sharing fails with `SCREEN_SHARE_DENIED` (NotAllowedError), which looks the
  same as the user clicking Cancel.
- To simulate several candidates, open `candidate.html` in several **separate
  browser profiles or browsers**. All tabs in one profile share Chrome's 6-connection
  limit per origin (HTTP/1.1), which the SSE streams use up.

## Automated verification (already run; see R&D.md Section 27 for numbers)

A Playwright script (headless Chromium, not committed to this repo) exercised the
full flow. Two input sources were used:

1. Chromium's `--use-fake-device-for-media-stream` "screen" device, a synthetic
   *monitor* surface. This covered share → view, profiles, stop/ended events, proctor
   refresh, a second proctor, killing and restarting the signaling server, and
   closing the candidate tab.
2. An injected synthetic 1920×1080 "exam screen" canvas (dense question text, a
   ticking timer, and the latency probe) in place of `getDisplayMedia()`. This
   measured bandwidth for static text vs scrolling, glass-to-glass latency, text
   legibility of received frames, and N candidates → 1 proctor.

These runs **can't** cover a real OS screen picker, real monitors, the macOS
permission flow, other browsers, or a real network. That's what the manual matrix
below is for.

`?test=self-tab` (candidate page) is a test hook: it lets the candidate share its own
tab via `preferCurrentTab` and turns off the entire-screen check by default. Don't use
it for real testing.

## Test matrix (manual, fill in while testing, then summarize into `R&D.md`)

| Scenario | Worked as expected? | Notes |
|---|---|---|
| Chrome (macOS): share entire screen, proctor sees it; note connect time | Yes | 2026-10-02, team run: surface `monitor`, 3456×2234, one monitor detected; proctor page showed it live. Connect time not noted |
| Chrome: pick a **window**, should be rejected with `WRONG_SURFACE` | | |
| Chrome: pick a **tab**, should be rejected with `WRONG_SURFACE` | | |
| Chrome: stop via the browser's "Stop sharing" bar; proctor notified | | |
| macOS: first run with Screen Recording permission **off**: what does the candidate see? | | |
| macOS: grant permission, relaunch the browser, share again | | |
| Edge (Windows): share entire screen | | |
| Firefox: share entire screen; does it report `displaySurface`? | | |
| Safari (macOS): share; is `displaySurface` reported? Can a window be picked? | | |
| **Two monitors connected**: does `MULTIPLE_MONITORS` fire at share start? | | |
| Two monitors: "Detect monitors" (permission prompt): count + which screen is shared | | |
| Plug in / unplug a second monitor mid-share: `MONITOR_CONFIG_CHANGED`? | | |
| Unplug the monitor that is being shared | | |
| Mirrored displays (not extended): reported as single? (expected: yes, a known blind spot) | | |
| Latency probe on, candidate window visible: glass-to-glass per profile | | |
| Low / Balanced / High: can the proctor read exam text full screen? | | |
| Candidate scrolls a long page / plays a video: bitrate, fps, latency | | |
| Candidate on a second machine (same Wi-Fi): works without STUN? latency? | | |
| Candidate on a different network (e.g. phone hotspot) with `?stun=1` | | |
| 5+ candidates on separate machines → 1 proctor: proctor CPU and download | | |
| Lock the screen / sleep the laptop mid-share | | |
| Notifications / other apps visible to the proctor? (privacy check) | | |
| Leave sharing for 30+ min: drift, memory growth, freezes? | | |

## Known limitations of this POC

- No authentication. **Any page can register as a "proctor" and request a
  candidate's screen.** In production, view requests must be brokered by the server
  for an authenticated proctor who is assigned to that exam session (Pundit), and
  that's the first thing to add before any real use.
- No TURN server, so this doesn't connect across restrictive NATs or firewalls.
- Peer-to-peer mesh: each extra proctor viewing the same candidate costs the
  candidate a full extra encode and upload (measured, see R&D.md). Fine for one
  assigned proctor, not for many viewers.
- Multi-monitor detection is Chromium-only (`screen.isExtended`), can't see mirrored
  displays or a second device, and can't *capture* the other monitors.
  (`getAllScreensMedia()` exists but only for managed ChromeOS / Isolated Web Apps.)
- The latency probe needs a shared clock and a visible candidate window. When the
  proctor window is itself on the shared screen you get an "infinite mirror"; the
  decoder picks the largest (real) probe to handle that.
- Everything is in memory; restarting `server.js` forgets peers. Live video
  **survives** a restart, though (verified): media is peer-to-peer.
- No automated test suite in the repo; manual-testing prototype by design, same as
  every other POC here.
