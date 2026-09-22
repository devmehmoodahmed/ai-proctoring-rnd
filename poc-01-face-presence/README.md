# POC #1 — Face Presence / Out-of-Frame / Multi-Face Detection

Part of the AI Proctoring R&D track. See [`../R&D.md`](../R&D.md) for the full
architecture/research document this POC belongs to.

## What this validates

> Can we reliably detect whether a candidate's face is present, and whether they've
> moved out of frame, using a normal browser webcam?

This is a **standalone, unwired prototype**. It does not touch any Rails route,
controller, model, or the production JS bundle in this repo, and does not
require production auth or the app's asset pipeline to run.

## What it is NOT

Per the R&D working rules, this POC deliberately does not implement: production auth,
production video storage, automatic exam suspension, a full proctor dashboard, gaze
detection (that's POC #2), phone/object detection (POC #3), or any backend
persistence. Event history is kept only in this browser tab's `localStorage`.

## How it works

- [`index.html`](index.html) — page shell: video feed, canvas overlay, live status,
  threshold controls, event log table.
- [`app.js`](app.js) — loads MediaPipe Tasks Vision's `FaceDetector`
  (BlazeFace short-range model) from CDN, runs it against the webcam feed in a
  `requestAnimationFrame` loop, classifies each frame, and runs a small
  persistence/hysteresis state machine before logging an event.
- No build step, no npm dependency added to this repo — MediaPipe is loaded as an
  ES module directly from jsDelivr at runtime.
- **Privacy:** every video frame is processed locally in this tab. No frame, image,
  or embedding is ever sent to a server. The only thing written anywhere is the
  event log, and it only goes to this browser's `localStorage`.

### Detection logic

Each frame is classified as one of:

| Classification | Condition |
|---|---|
| `PRESENT` | Exactly one face, fully inside the frame with margin, not too small |
| `FACE_MISSING` | Zero faces detected |
| `MULTIPLE_FACES` | More than one face detected |
| `OUT_OF_FRAME` | Exactly one face, but its bounding box touches/exceeds the configurable edge margin |
| `TOO_FAR` | Exactly one face, centered, but its bounding-box area is below the configurable "too far" ratio |

A raw per-frame classification does **not** immediately create an event. It must
persist for the configurable "persist-to-confirm" window (default 1500ms) before an
event is logged — this is the grace-period behavior described in the brief ("detect
issue → warning → grace period → alert if it continues"). The live status line shows
the countdown during the grace period. Once confirmed, the condition must return to
`PRESENT` and hold for the "persist-to-clear" window (default 800ms) before the event
is marked resolved. This exists specifically to avoid flooding the log with
single-frame flicker from detector noise.

## Running it

`getUserMedia` requires a secure context, so opening `index.html` directly via
`file://` will not work in Chrome. Serve it from `localhost` instead:

```bash
cd rnd/poc-01-face-presence
python3 -m http.server 8000
# then open http://localhost:8000
```

(or `npx serve .`, or any other static file server — nothing here is Rails-specific.)

Recommended browser: Chrome or Edge (best WASM/WebGL delegate support for MediaPipe).
Firefox and Safari should also work but were not part of the primary test pass — note
any browser-specific behavior in the results table below.

## Metrics captured live in the UI

- **FPS** — rolling average over the last 30 processed frames.
- **Inference latency** — rolling average `detectForVideo()` call time in ms.
- **Faces detected** — raw count from the current frame.
- **Confidence** — detector's score for the primary face (or the max score across
  faces when `MULTIPLE_FACES`).

CPU usage is not something a browser tab can read about itself via a JS API — observe
it manually via your OS/browser task manager while testing and record it in the table
below.

## Test matrix (fill in while testing, then summarize into `R&D.md` Section 18)

Run through each row with the app open, and log what you observed. "Detected
correctly?" should reference the live status line and the event log, not just
eyeballing the video.

| Scenario | Detected correctly? | Time to confirm (s) | False positives? | Notes |
|---|---|---|---|---|
| Normal lighting, ~50cm from camera | | | | |
| Dim/low light | | | | |
| Backlit (window/light behind candidate) | | | | |
| Very close to camera (~20cm) | | | | |
| Far from camera (~1.5m+) — should trigger `TOO_FAR` | | | | |
| Move slowly out of frame to the left | | | | |
| Move slowly out of frame to the right | | | | |
| Move slowly out of frame downward | | | | |
| Quick full exit from frame — should trigger `FACE_MISSING` | | | | |
| Brief hand-over-face (~1s) — should NOT trigger an event if under persist-to-confirm | | | | |
| Sustained face obstruction (~5s) — should trigger `FACE_MISSING` | | | | |
| Second person enters frame — should trigger `MULTIPLE_FACES` | | | | |
| Camera angle: laptop lid tilted down/up | | | | |
| Low-quality/older webcam, if available | | | | |
| Extended run (10+ min) — any drift, memory growth, FPS degradation? | | | | |

## Known limitations of this POC

- Thresholds (persistence windows, edge margin, "too far" ratio) are untuned
  defaults, not validated production values — that tuning is future work once we
  have real test data.
- `TOO_FAR` is a simple bounding-box-area heuristic, not a calibrated distance
  estimate — it will vary with webcam field of view.
- No gaze/head-pose signal yet (POC #2) — a candidate could be fully in frame,
  centered, and still looking away, and this POC won't catch that.
- Single camera / single tab assumed; no handling for camera switching, permission
  revocation mid-session beyond a hard stop, or multiple simultaneous video tracks.
- No automated test suite — this is a manual-testing prototype by design (Section 28
  of the brief explicitly scopes POC #1 to manual validation, not production
  hardening).
