# POC #8 — Practice / Onboarding Simulator

Part of the AI Proctoring R&D track. See [`../R&D.md`](../R&D.md) Section 28 for the
research, the approaches compared, the decisions, and the measured results.

## What this validates

> Can a candidate, unaided and before exam day, prove their camera, microphone and
> screen sharing work, learn the rules from **approved, deterministic** content in
> English or Arabic, and experience what the AI flags and what happens next (a person
> reviews it)?

A **standalone, unwired prototype**, like POC #1–#7. It doesn't touch VerifyID-Portal
or qababoardweb, and it doesn't talk to any backend.

## What it is NOT

- **No LLM, no generated text.** Every word the candidate sees is in
  [`content/en.json`](content/en.json) / [`content/ar.json`](content/ar.json).
- **Not the real exam rules.** The rules are placeholders (`meta.policy_status:
  "draft-placeholder"`), and the page says so in a banner.
- **The Arabic text is machine-drafted** (`meta.translation_status`), and the page says
  so too. A qualified reviewer must approve it before real candidates see it.
- Nothing is recorded, stored on a server, or uploaded: no video, audio, images, or
  pose values. There's no ID capture (VerifyID-Portal already does that), no scoring,
  no auth, no network/TURN test, and no proctor-side view.

## How it works

Steps: **Welcome → Computer & browser → Camera → Microphone → Screen → Rules →
Practice exam → Summary.** Each check has a pass condition, a concrete fix for every
failure it can detect, and a **Skip — I need help** button, so nobody gets stuck. Only
the rules acknowledgement is mandatory.

| File | Role |
|---|---|
| [`content/*.json`](content/) | All candidate-facing text: UI strings, step copy, `rules[]`, in-exam `nudges`, example `proctor_alerts`, error fixes, practice questions. `meta` pins the direction and the number locale (`ar-u-nu-latn`) |
| [`logic.js`](logic.js) | Pure, no DOM: step machine, persistence/hysteresis, framing and lighting classification, pose + averaged calibration, readiness, report builder, i18n formatting |
| [`media.js`](media.js) | Browser wrappers: environment detection, Face Landmarker + Object Detector (MediaPipe **1.0.1, pinned**), lighting sampler, mic + level meter + Silero VAD, `getDisplayMedia` check |
| [`app.js`](app.js) | Renders each step from content and wires media → logic → UI |
| [`tests/`](tests/) | Unit tests (`node --test`), fixture builder, Playwright e2e |

Reused from earlier POCs: POC #1's framing categories and thresholds; POC #2's pose
decomposition and 20°/15° thresholds; POC #3's `cell phone` detector; POC #4's VAD
configuration and CDN path fix; POC #5's screen-share hints and `displaySurface`
enforcement; POC #6's event shape for the readiness report. What's new:

- **One face model.** The Face Landmarker (`numFaces: 2`) provides count, box *and*
  pose, instead of running POC #1's detector alongside POC #2's landmarker.
- **Setup guidance is stricter than the exam alerts.** Passing setup leaves headroom
  before an exam alert would fire. A unit test enforces this.
- **Directional hints** ("move a little to your left", "tilt your camera up"). They're
  worked out in raw camera coordinates while the preview is mirrored.
- **A lighting heuristic**: too dark, backlit, or too bright, from face vs frame luma.
- **Calibration is the mean pose over the 3 s "hold still"**, accepted only if it's
  stable. POC #2 used a single frame.
- **The phone detector is duty-cycled** to at most 25% of main-thread time, so it
  can't starve the face model. It's also loaded lazily.
- **Every model is warmed up while loading**, so the multi-second first inference
  never freezes a live step.
- **Model creation is serialised.** Two MediaPipe tasks created at once can hang,
  because the loader shares a global.
- **The "more than one person" message is held for 1 s** after the second face was
  last seen, so it doesn't flicker when the model briefly loses that face.
- **Progress is saved in `localStorage`**, so the macOS "Quit & Reopen" for screen
  permission resumes at the same step.
- **A CSP `connect-src` allow-list** in `index.html` (see Privacy).

## Running it

Camera/mic/screen need a secure context, so serve over `localhost`:

```bash
cd ai-proctoring-rnd          # repo root, or this folder
python3 -m http.server 8000
# http://localhost:8000/poc-08-onboarding-simulator/
# ?lang=ar      start in Arabic      ?dev=1   show model/FPS metrics
```

Chrome or Edge recommended. To start over, use **Start again** on the summary, or
clear the site's storage.

## Privacy

- All inference is on-device. The page fetches only its own files, code/WASM from
  `cdn.jsdelivr.net`, and models from `storage.googleapis.com`.
- **MediaPipe tasks-vision ≥ 1.0.0 sends usage telemetry.** Every 60 s it POSTs a
  small protobuf (task type, version, call counts, latency) to
  `odml.pa.googleapis.com/v1/log`, with the page origin and user agent. It has no
  option to turn this off, and 0.10.x doesn't do it. The CSP `connect-src` in
  `index.html` blocks it; the `telemetry_blocked` e2e scenario proves it. **POC #1–#3
  load `@latest` (now 1.0.x) without a CSP, so they send it.**
- The readiness report has statuses and error codes only. The test suite checks that
  it contains no pose values or media.
- The VAD's speech-end callback receives audio samples. Only the duration is kept.

## Automated tests

```bash
node --test tests/*.test.mjs        # 29 unit tests: logic + EN/AR content parity, <1 s

node tests/make-fixtures.mjs        # once: downloads Xiph test videos (~140 MB),
                                    # makes a darkened copy, TTS speech (macOS `say`)
PLAYWRIGHT=/path/to/node_modules/playwright node tests/e2e.mjs [scenario …]
# the full suite takes ~8 min; on a Mac, prefix with `caffeinate -i -s` and keep the
# lid open: if the machine sleeps, the frozen browsers make scenarios fail or hang
```

The e2e runs headless Chromium with fake devices: real face videos as the camera, TTS
speech as the mic, and Chromium's fake screen. Failure modes are produced by stubbing
`getUserMedia`, `getDisplayMedia` and `screen.isExtended`. Screenshots, the downloaded
reports and `e2e-results.json` go to `tests/out/`. Fixtures and outputs are gitignored.
The happy paths also record a `micTrace` (VAD events and mic phases, timed from when
the mic opens), so a microphone warning can be diagnosed from `e2e-results.json`.
18 scenarios; results are summarised in R&D.md 28.10.

## Test matrix (manual — fill in, then summarise into R&D.md)

These need real people, real hardware or real rooms, which the automated run can't
provide.

| Scenario | Worked? | Notes |
|---|---|---|
| First-time candidate, no help, EN: time to finish (target < ~5 min), where they hesitated | | |
| First-time candidate, no help, **AR** (native speaker): same, plus copy clarity and register | | |
| Bilingual reviewer reads every AR string (`content/ar.json`) | | |
| Real laptop: face FPS in Camera and in Practice (`?dev=1`), low-end machine included | | |
| Real laptop, candidate moves left/right/closer: hints point the right way (mirrored preview) | | |
| Dim room / window behind candidate: `TOO_DARK` / `BACKLIT` shown? false alarms in normal light? | | |
| Glasses, hijab / head covering, beard: framing, calibration and look-away still OK? | | |
| Practice: turn head away 3 s → `LOOKING_AWAY` nudge + example alert | | |
| Practice: hold up a phone → `PHONE_DETECTED`; hold a calculator/remote → none? | | |
| Practice: speak / cough / type → speech nudge only for speech | | |
| Screen: real picker, choose a window, a tab, then the entire screen | | |
| macOS, Screen Recording permission off: guidance shown; after Quit & Reopen, resumes at Screen | | |
| Real second monitor connected → `MULTIPLE_MONITORS` warning | | |
| Firefox / Safari / Edge on Windows: every step, especially the screen surface check | | |
| Screen reader (VoiceOver / NVDA): steps, statuses and nudges announced sensibly | | |
| Network that blocks jsDelivr: device step explains it clearly | | |

## Known limitations

- Thresholds for the setup band and lighting are untuned starting values.
- **The Face Landmarker misses a second face in ~16% of frames** on the two-person
  test video, so the practice `MULTIPLE_FACES` alert takes 1.5–8 s to fire instead
  of 1.5 s. POC #1's BlazeFace doesn't have this problem (R&D.md 28.10, F6).
- `LOOKING_AWAY` and `PHONE_DETECTED` aren't covered by the automated run (no fixture
  video contains them). They need the manual matrix.
- The first model load is slow on a cold cache (face ~5–9 s, phone ~8 s in the
  automated run, measured over the network).
- The Arabic copy mostly avoids masculine-default grammar ("يُرجى + verbal noun",
  first-person checklist items), but a reviewer should confirm register and tone.
- Switching language restarts the current step's live check (the practice timer and
  answers are kept).
- The report is only downloaded. Sending it to the proctoring backend is the
  integration next step (R&D.md 28.13).
