# POC #3 — Phone / Object Detection

Part of the AI Proctoring R&D track. See [`../R&D.md`](../R&D.md) for the full
architecture/research document this POC belongs to.

## What this validates

> Can a pretrained, no-training-required object detector reliably distinguish a phone
> from visually similar objects (calculator, TV remote, wallet, notebook) at typical
> webcam distance/angle, well enough to be a usable proctoring signal?

This is the central open question flagged back in `R&D.md` Section 10 ("Phone
Detection") — this POC exists specifically to answer it with real data, not assume
an answer.

This is a **standalone, unwired prototype**, same as POC #1 and #2. It does not touch
any Rails route, controller, model, or production JS bundle, and does not require
production auth or an asset pipeline to run.

## What it is NOT

Per the R&D working rules, this POC deliberately does not implement: face
presence/gaze detection (POC #1/#2), a custom-trained phone-specific model (this uses
a generic pretrained COCO detector — that's the point of the experiment), any
auto-pause behavior (per the existing Decision Log entry: alert-only, regardless of
accuracy), production auth, video storage, a full proctor dashboard, or any backend
persistence. Event history is kept only in this browser tab's `localStorage`.

## How it works

- [`index.html`](index.html) — page shell: video feed, canvas overlay, live status,
  threshold controls, event log table.
- [`app.js`](app.js) — loads MediaPipe Tasks Vision's `ObjectDetector`
  (EfficientDet-Lite0, COCO-pretrained) from CDN, runs it against the webcam feed in a
  `requestAnimationFrame` loop, filters detections down to the COCO `"cell phone"`
  category, and runs the same persistence/hysteresis state machine pattern POC #1/#2
  used before logging an event.
- No build step, no npm dependency added to this repo — MediaPipe is loaded as an ES
  module directly from jsDelivr at runtime, same as POC #1/#2.
- **Every detected object is drawn on screen with its label and confidence** — not
  just phones. Phone detections above the confidence threshold get a thick red box;
  everything else gets a thin gray box. This is deliberate: the point of this POC is
  to see what a decoy object gets misclassified as, not just whether a phone was
  found.
- **Privacy:** every video frame is processed locally in this tab. No frame, image, or
  detection data is ever sent to a server. The only thing written anywhere is the
  event log, and it only goes to this browser's `localStorage`.

### Detection logic

Each frame is classified as:

| Classification | Condition |
|---|---|
| `NO_PHONE` | No detection with category `"cell phone"` at or above the confidence threshold |
| `PHONE_DETECTED` | At least one detection with category `"cell phone"` at or above the confidence threshold |

Only the COCO `"cell phone"` class drives classification — other recognized objects
(shown on screen for diagnostic purposes) do not trigger events. As with POC #1/#2, a
raw per-frame classification does not immediately create an event — it must persist
for the configurable "persist-to-confirm" window (default 1000ms) before an event is
logged, and must return to `NO_PHONE` and hold for the "persist-to-clear" window
(default 600ms) before the event is marked resolved.

## Running it

`getUserMedia` requires a secure context, so opening `index.html` directly via
`file://` will not work in Chrome. Serve it from `localhost` instead:

```bash
cd poc-03-phone-object
python3 -m http.server 8002
# then open http://localhost:8002
```

(or `npx serve .`, or any other static file server.) Use a different port than
POC #1/#2 if you want them all running side by side.

Recommended browser: Chrome or Edge (best WASM/WebGL delegate support for MediaPipe).

## Metrics captured live in the UI

- **FPS** — rolling average over the last 30 processed frames.
- **Inference latency** — rolling average `detectForVideo()` call time in ms. Object
  detection is generally heavier than the face-only models in POC #1/#2 — this is
  measured directly, not assumed to match.
- **Phone confidence** — the highest-scoring `"cell phone"` detection in the current
  frame, if any.
- **Objects seen (any class)** — total detections in the current frame, regardless of
  category. A sanity metric, not used for classification.

CPU usage is not readable via a browser JS API — observe it manually via your OS/
browser task manager while testing and record it in the table below.

## Test matrix (fill in while testing, then summarize into `R&D.md`)

| Scenario | Detected correctly? | Time to confirm (s) | False positives? | Notes |
|---|---|---|---|---|
| Phone held up, facing camera, normal lighting | | | | |
| Phone flat on desk, in view | | | | |
| Phone held near face | | | | |
| Phone at a steep angle / partially turned away | | | | |
| Phone partially occluded by hand | | | | |
| Phone below desk level / at frame edge | | | | |
| Brief phone appearance (~0.5s) — should NOT trigger if under persist-to-confirm | | | | |
| Sustained phone visibility (~5s) — should trigger `PHONE_DETECTED` | | | | |
| **Decoy: calculator** — what does it get labeled as? | | | | |
| **Decoy: TV remote** — what does it get labeled as? | | | | |
| **Decoy: wallet** — what does it get labeled as? | | | | |
| **Decoy: water bottle** — what does it get labeled as? | | | | |
| **Decoy: empty hand, no object** | | | | |
| Dim/low light | | | | |
| Extended run (10+ min) — any drift, memory growth, FPS degradation? | | | | |

## Known limitations of this POC

- Uses a generic COCO-pretrained model, not a phone-specific or exam-context-specific
  one — false positive/negative rates on real candidate hardware/lighting are
  genuinely unknown until this test matrix is run. That's the point of this POC, not
  an oversight.
- Thresholds (confidence, persistence windows) are untuned defaults, not validated
  production values — same caveat as POC #1/#2.
- Only the `"cell phone"` COCO category drives events. If testing shows phones are
  frequently misclassified as a different COCO label (e.g. `"remote"`), that's an
  important finding to record, not something this POC works around automatically.
- No results feed into automatic exam pause under any circumstance, per the existing
  Decision Log entry — this POC cannot change that on its own regardless of accuracy.
- Single camera / single tab assumed, same as POC #1/#2.
- No automated test suite — manual-testing prototype by design, same as POC #1/#2.
