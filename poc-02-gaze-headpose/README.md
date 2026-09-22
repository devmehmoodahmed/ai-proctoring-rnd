# POC #2 — Gaze / Head-Pose ("Looking Away") Detection

Part of the AI Proctoring R&D track. See [`../R&D.md`](../R&D.md) for the full
architecture/research document this POC belongs to (Section 22 has the original
proposal this was built from).

## What this validates

> Using the same on-device MediaPipe pipeline as POC #1, can we reliably detect
> sustained "looking away from screen" via head pose (yaw/pitch), at real-time FPS,
> with a low enough false-positive rate on normal reading/typing behavior to be a
> usable proctoring signal?

This is a **standalone, unwired prototype**, same as POC #1. It does not touch any
Rails route, controller, model, or production JS bundle, and does not require
production auth or an asset pipeline to run.

## What it is NOT

Per the R&D working rules, this POC deliberately does not implement: face
presence/out-of-frame/multiple-face detection (that's POC #1 — this POC assumes a
single face is already present), true pupil/iris-based gaze (kept as an explicitly
out-of-scope, lower-confidence signal per R&D.md Section 8 finding #2), fusion with
POC #1's signals, production auth, video storage, automatic exam suspension, a full
proctor dashboard, or any backend persistence. Event history is kept only in this
browser tab's `localStorage`.

## How it works

- [`index.html`](index.html) — page shell: video feed, canvas overlay, live
  yaw/pitch/roll readout, calibration controls, threshold controls, event log table.
- [`app.js`](app.js) — loads MediaPipe Tasks Vision's `FaceLandmarker` from CDN with
  `outputFacialTransformationMatrixes: true`, runs it against the webcam feed in a
  `requestAnimationFrame` loop, decomposes the per-frame facial transformation matrix
  into yaw/pitch/roll, classifies each frame, and runs the same
  persistence/hysteresis state machine pattern POC #1 used before logging an event.
- No build step, no npm dependency added to this repo — MediaPipe is loaded as an
  ES module directly from jsDelivr at runtime, same as POC #1.
- **Privacy:** every video frame is processed locally in this tab. No frame, image, or
  landmark/embedding data is ever sent to a server. The only thing written anywhere is
  the event log, and it only goes to this browser's `localStorage`.

### Head-pose math

MediaPipe's `facialTransformationMatrixes[0]` is a 4x4, column-major matrix. The
rotation submatrix is decomposed into yaw/pitch/roll using the standard
`R = Rz(roll) · Ry(yaw) · Rx(pitch)` formula (the same one used in most
OpenCV/solvePnP head-pose tutorials). **Exact sign/axis convention is not assumed
correct — it's validated empirically** by watching the live yaw/pitch numbers and the
on-screen pose axes (red/green/blue lines drawn from the face center) while turning
your head, as part of the test matrix below.

### Calibration

"Looking at the screen" is not yaw=0/pitch=0 in absolute terms — it depends on webcam
position, monitor size, and seating distance. Click **Calibrate** while looking
straight at your screen to zero out the current pose as the baseline; all subsequent
yaw/pitch values and thresholds are relative to that baseline. **Reset calibration**
clears it back to raw camera-relative angles. The test matrix explicitly compares
calibrated vs. uncalibrated behavior.

### Detection logic

Each frame (with exactly one face present) is classified as:

| Classification | Condition |
|---|---|
| `FOCUSED` | \|calibrated yaw\| and \|calibrated pitch\| both within threshold |
| `LOOKING_AWAY` | \|calibrated yaw\| or \|calibrated pitch\| exceeds its configurable threshold |

If no face is detected, gaze classification is skipped entirely (status shows "No
face detected — gaze unavailable") — that condition is POC #1's job, not this POC's.

As with POC #1, a raw per-frame classification does not immediately create an event —
it must persist for the configurable "persist-to-confirm" window (default 1200ms)
before an event is logged, and must return to `FOCUSED` and hold for the
"persist-to-clear" window (default 600ms) before the event is marked resolved. Every
logged event carries a plain-language detail string (e.g. `"yaw 34.2°"`), never a bare
"cheating" conclusion.

## Running it

`getUserMedia` requires a secure context, so opening `index.html` directly via
`file://` will not work in Chrome. Serve it from `localhost` instead:

```bash
cd poc-02-gaze-headpose
python3 -m http.server 8001
# then open http://localhost:8001
```

(or `npx serve .`, or any other static file server.) Use a different port than POC #1
if you want both running side by side.

Recommended browser: Chrome or Edge (best WASM/WebGL delegate support for MediaPipe).

## Metrics captured live in the UI

- **FPS** — rolling average over the last 30 processed frames.
- **Inference latency** — rolling average `detectForVideo()` call time in ms. Expect
  this to be higher than POC #1's — Face Landmarker (478 landmarks + pose) is a
  heavier model than Face Detector (bounding boxes only). This is measured directly,
  not assumed to match POC #1.
- **Yaw / Pitch (calibrated)** — live degrees, relative to the calibration baseline.
- **Roll** — live degrees, raw (not used for classification, shown for diagnostics).

CPU usage is not readable via a browser JS API — observe it manually via your OS/
browser task manager while testing and record it in the table below.

## Test matrix (fill in while testing, then summarize into `R&D.md` Section 18-equivalent for POC #2)

| Scenario | Detected correctly? | Time to confirm (s) | False positives? | Notes |
|---|---|---|---|---|
| Straight ahead, calibrated, normal lighting | | | | |
| Look at a second monitor to the left | | | | |
| Look at a second monitor to the right | | | | |
| Look down at notes on the desk | | | | |
| Look up | | | | |
| Extreme yaw (near-profile turn) | | | | |
| Brief glance away (~0.5s) — should NOT trigger if under persist-to-confirm | | | | |
| Sustained look-away (~5s) — should trigger `LOOKING_AWAY` | | | | |
| Natural reading/typing posture drift — should NOT false-positive | | | | |
| Glasses on | | | | |
| Glasses off (if applicable) | | | | |
| Hijab / head covering | | | | |
| Poor/dim lighting | | | | |
| Low-quality/older webcam, if available | | | | |
| Laptop lid tilted down/up (camera angle) | | | | |
| Uncalibrated vs. calibrated — same head turn, compare false-positive rate | | | | |
| Pose axis visualization — do red/green/blue lines move in the expected direction when you turn/nod/tilt? | | | | |
| Extended run (10+ min) — any drift, memory growth, FPS degradation? | | | | |

## Known limitations of this POC

- Thresholds (yaw/pitch degrees, persistence windows) are untuned defaults, not
  validated production values — tuning is future work once we have real test data,
  same as POC #1.
- Head pose cannot distinguish "checking a second monitor" from "glancing at notes"
  from "stretching" — it only knows head orientation, not intent. This is a known,
  accepted limitation per R&D.md Section 8 finding #2, not a bug.
- Calibration is a single-snapshot baseline (one click), not an averaged/smoothed
  capture — noisy single-frame calibration is a known risk to watch for in testing.
- True eye/pupil gaze is out of scope — a candidate could hold their head still and
  move only their eyes, and this POC won't catch that (by design, per the research
  findings — pupil gaze from consumer webcams is materially noisier than head pose).
- Pose axis visualization is a qualitative sanity check, not a calibrated 3D render —
  useful for confirming sign/direction during testing, not for precision measurement.
- Single camera / single tab assumed, same as POC #1.
- No automated test suite — manual-testing prototype by design, same as POC #1.
