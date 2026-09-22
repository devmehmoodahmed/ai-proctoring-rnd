# POC #4 — Speaking / Voice Activity Detection

Part of the AI Proctoring R&D track. See [`../R&D.md`](../R&D.md) for the full
architecture/research document this POC belongs to (Section 8 finding #4 and Section
10 "Speaking Detection" cover the VAD-vs-STT research this was built from).

## What this validates

> Can we reliably detect sustained candidate speech from the microphone using an
> on-device voice activity detector, with a low false-positive rate on background
> noise (typing, room hum, coughs), without running any speech-to-text?

This is a **standalone, unwired prototype**, same as POC #1–3. It does not touch any
Rails route, controller, model, or production JS bundle, and does not require
production auth or an asset pipeline to run.

## What it is NOT

Per the R&D working rules, this POC deliberately does not implement: any
transcription or speech-to-text (Section 10 is explicit that STT is only a future
escalation, only on confirmed sustained events, only if VAD proves insufficient —
none of that is built here), audio recording/storage of any kind, face/gaze/phone
detection (POC #1–3), production auth, a full proctor dashboard, or any backend
persistence. Event history (timestamp + duration only, never audio) is kept only in
this browser tab's `localStorage`.

## How it works

- [`index.html`](index.html) — page shell: mic controls, live speech-probability
  meter, threshold controls, event log table. No camera/video is used in this POC.
- [`app.js`](app.js) — uses Silero VAD (an on-device ONNX voice-activity model) via
  the `@ricky0123/vad-web` browser bundle, loaded from CDN as plain `<script>` tags
  (not an ES module import — unlike POC #1–3, this library ships as a browser
  bundle, so `vad` is a global, not something `app.js` imports).
- **This is the first POC in this track not built on MediaPipe.** POC #1–3 all share
  one validated runtime; this one uses a different library and CDN loading mechanism,
  which is real, not-yet-proven integration risk worth calling out during testing —
  if the mic never starts or the model never loads, that's exactly the kind of thing
  this POC exists to surface.
- The library's own built-in smoothing (a minimum-speech-length filter and a
  "redemption" grace period before ending a segment) does the persistence/hysteresis
  job that POC #1–3 implemented by hand — no separate custom state machine was needed
  here, since the library already handles "avoid flagging on a single blip."
- **Privacy:** all audio processing happens locally in this tab. No audio clip is
  ever recorded, stored, or sent anywhere — not even to `localStorage`. Only the
  timestamp and duration of each detected speech segment are logged.

### Detection logic

Each detected sound is one of:

| Outcome | Condition |
|---|---|
| `SPEECH_SEGMENT` (logged) | Sustained speech at or above the "min speech length to log" threshold |
| Discarded (not logged, counted separately) | A brief sound crossed the speech threshold but ended before the minimum length — a cough, a tap, a short blip |

The **Discarded (too short)** counter exists specifically so you can confirm the
pipeline is actually hearing brief sounds and correctly choosing not to log them,
rather than silently missing them entirely — those are different failure modes and
worth telling apart while testing.

## Running it

Microphone access requires a secure context, so opening `index.html` directly via
`file://` will not work in Chrome. Serve it from `localhost` instead — use the same
single server already set up for the other POCs (see the repo root `README.md`), or:

```bash
cd poc-04-speaking-vad
python3 -m http.server 8000
# then open http://localhost:8000
```

Recommended browser: Chrome or Edge. Grant microphone permission when prompted.

## Metrics captured live in the UI

- **Speech probability** — the model's live confidence (0–1) that the current audio
  frame contains speech; also drives the level meter bar.
- **Segments logged** — total confirmed speech segments in the event log.
- **Discarded (too short)** — sounds that crossed the speech threshold but didn't
  last long enough to log (see above).

CPU usage is not readable via a browser JS API — observe it manually via your OS/
browser task manager while testing and record it in the table below.

## Test matrix (fill in while testing, then summarize into `R&D.md`)

| Scenario | Detected correctly? | False positives? | Notes |
|---|---|---|---|
| Silence, quiet room | | | |
| Normal speaking / reading aloud | | | |
| Quiet mumbling | | | |
| Background noise, no speech (typing) | | | |
| Background noise, no speech (music/TV) | | | |
| Background noise, no speech (HVAC/fan hum) | | | |
| Brief cough or sneeze — should be discarded, not logged | | | |
| Sustained speech (~10s) — should log one segment | | | |
| Mid-sentence pause (~1s) — should NOT split into two segments | | | |
| Second person talking in the room | | | |
| Speaking from further away from the mic | | | |
| Extended run (10+ min) — any drift, memory growth, CPU creep? | | | |

## Known limitations of this POC

- Pure VAD only — it knows *that* someone is speaking, not *what* they said or *to
  whom*. It can't tell "reading the exam question aloud" apart from "talking to
  someone off-screen." That's an accepted, by-design limitation (Section 10), not a
  bug — STT escalation is explicitly future work, gated on this POC's results.
- Thresholds (speech/silence probability, min length, grace period) are untuned
  defaults, not validated production values — same caveat as POC #1–3.
- Audio consent is a distinct legal question from video consent (two-party consent
  recording laws vary by jurisdiction) — flagged in Section 11 for legal review
  before this ever touches real candidate audio. This POC is safe as a controlled,
  self-tested prototype (your own voice, nothing recorded or persisted beyond a
  timestamp+duration in your own browser).
- New dependency, not yet validated in this environment the way MediaPipe has been
  across three POCs — if setup issues show up, that's this POC doing its job.
- No automated test suite — manual-testing prototype by design, same as POC #1–3.
