# AI Proctoring R&D

Status: **All eight POCs are implemented.** POC #1–#4, #6 and #7 have been manually
tested by the team. POC #5 (screen capture, Section 27) was verified with automated
browser runs on 2026-09-23; its manual test matrix (real picker, multi-monitor, macOS
permission, other browsers, real network) is still pending. POC #8 (practice /
onboarding simulator, Section 28) was implemented on 2026-09-29 and verified on
2026-09-30 with 29 unit tests and an 18-scenario automated browser suite, all passing
(Section 28.10). A manual team run in English on 2026-10-06 finished in ~2–3 minutes
with every check passing. The rest of its manual matrix (real first-time candidates,
especially Arabic speakers) is still pending, and it reopened decision D2 on face counting (finding F6). The written test-matrix
results for POC #1–#4/#6 are not yet recorded here (Section 18 and the Results
subsections under Section 22–25). Record them before treating those POCs as fully
validated. **POC #7 saves real recorded video to local disk; see its README before
running it.** **POC #8 found that MediaPipe ≥ 1.0.0 sends usage telemetry to Google,
which affected POC #1–#3 as well (Section 28.10, finding F1). They got the same CSP
block on 2026-10-06.**

This document is the living record of the AI-assisted proctoring R&D effort. It is
updated after every research pass and every POC. Nothing here should be read as a
final production decision until it appears in the Decision Log with status `Approved`.

---

## 1. Executive Summary

The organization currently runs human-proctored exams over a manually-hosted Google
Meet link. There is no automated monitoring today. The ask is to investigate whether
AI can **assist** (not replace) human proctors by detecting a small set of suspicious
behaviors — gaze/attention, out-of-frame, speaking, phone/object presence — and
surfacing them as alerts with evidence for a human to review and decide on.

The repository inspection (Section 5) found that AI-assisted proctoring does not
exist anywhere in the current stack, and that the exam itself is not even rendered by
either of the two Rails apps the organization owns — it is iframed from a third,
external "exam session" engine we do not have source access to. This has a material
effect on where a proctoring client can live (Section 6).

Our overall recommendation, pending POC validation: build a narrow, client-side-first
AI-assist layer (face presence, head-pose "gaze", VAD-based speech, COCO-class object
detection) that runs in the candidate's browser during the exam, emits only small
event/evidence payloads (never continuous raw video) to a new proctoring service, and
surfaces alerts to a human proctor dashboard for review — modeled on the
human-in-the-loop pattern that already exists for identity verification in this repo
(`ProctorReview`, `VerificationSession` status machine). We recommend **against**
fully automatic exam pausing (Section on Automatic Exam Pause) and **against**
building a full commercial-grade proctoring platform from scratch before validating
detection reliability on real hardware.

POC #1 (face presence / out-of-frame / multiple-face detection using MediaPipe in the
browser) is complete. Results are in Section 18. It validates that this class of
detection is fast, accurate enough to build on, and cheap (no server round-trip), but
also surfaces real false-positive risk from lighting and camera angle that any
downstream persistence/threshold logic must account for.

---

## 2. Business Requirements

- Reduce proctor cognitive load: proctors are currently busy onboarding/assisting
  other candidates and cannot watch every video feed continuously.
- Detect, don't decide: AI flags potentially suspicious events; a human proctor makes
  any determination of misconduct.
- Reduce time spent on Arabic-speaking candidate onboarding specifically (Section 13
  of the original brief) — out of scope for POC #1, noted for later phases.
- Investigate whether Google Meet can eventually be reduced/replaced by a purpose-built
  proctoring surface — not a requirement to do so immediately.

## 3. Functional Requirements

See the original R&D brief (sections A–14 as provided) for the full list. Summarized:

| Capability | Priority | POC |
|---|---|---|
| Face presence / out-of-frame / multiple faces | P0 | POC #1 (done) |
| Gaze / head-pose ("looking away") | P0 | POC #2 |
| Phone / object detection | P1 | POC #3 |
| Speaking / voice activity detection | P1 | POC #4 |
| Screen capture / viewing | P2 | POC #5 (implemented — Section 27) |
| Real-time proctor alerting | P0 (infra) | POC #6 |
| Rolling-buffer evidence capture | P1 | POC #7 |
| Practice/onboarding simulator | P2 | POC #8 (implemented — Section 28) |

## 4. Non-Functional Requirements

- **Low false-positive rate.** A system that over-alerts gets ignored by proctors
  (Principle 5). Every detector must support a persistence/debounce threshold, not
  fire on single-frame noise.
- **Low latency** for on-device signals (face/gaze) — sub-200ms perceived, since these
  drive a live "please face the camera" UX, not just backend alerting.
- **Bandwidth-conscious.** Candidates may be on modest home connections; we should not
  require continuous video upload for every candidate for the whole exam duration.
- **Auditable.** Every AI event must be traceable: timestamp, confidence, detector
  version, and (where applicable) evidence.
- **Explainable.** Alerts must say what was detected and at what confidence, never
  "candidate cheated."
- **Degradable.** Detection failure (e.g., webcam permission denied, low-end laptop)
  must not block the exam — it should fall back to "proctor should watch this
  candidate more closely," not lock the candidate out.

## 5. Current System Assessment

Two repositories were inspected. Neither contains any proctoring, webcam-monitoring,
or AI-vision code today.

### VerifyID-Portal (this repo)

- Rails 8.0 / Ruby 3.3.2, Hotwire (Turbo + Stimulus) server-rendered views, Postgres,
  Sidekiq + Redis, ActionCable **configured but unused** (default scaffold only, no
  channels, no broadcasts) — [config/cable.yml](config/cable.yml), [app/channels/](app/channels/).
- Custom cookie/DB session auth (not Devise) — [app/models/session.rb](app/models/session.rb),
  [app/controllers/concerns/authentication.rb](app/controllers/concerns/authentication.rb).
  Two roles only: `admin`, `proctor` — [app/models/user.rb:6](app/models/user.rb#L6).
  Candidates are **not** authenticating users; they're driven through a magic-token
  flow — [app/models/candidate.rb](app/models/candidate.rb).
- Identity verification pipeline: `VerificationSession` state machine
  (`pending → in_progress → passed/flagged → released_by_proctor/rejected_by_proctor/expired`)
  — [app/models/verification_session.rb:4-19](app/models/verification_session.rb#L4-L19).
  Supporting models: `IdDocument`, `SelfieCapture`, `FaceVerification`,
  `FaceCollectionEntry`, `ProctorReview`.
- All biometric work goes through AWS Rekognition —
  [app/services/rekognition/client.rb](app/services/rekognition/client.rb) (liveness,
  CompareFaces, SearchFacesByImage, IndexFaces). This is a **server-side, per-request**
  API call model — not designed for continuous real-time frame-by-frame analysis, and
  billed per API call, which matters for Section 8 (Technology Options).
  `app/services/id_documents/match_selector.rb` (recent work, commits `b6f307a`/`3153f74`)
  already solves a "pick the side of the ID with the actual face" problem, a useful
  precedent for defensive, confidence-based selection logic in the new detectors.
- The candidate-facing flow already does webcam capture for liveness/selfie via
  Stimulus controllers — [app/javascript/controllers/liveness_controller.js](app/javascript/controllers/liveness_controller.js),
  [app/javascript/controllers/selfie_controller.js](app/javascript/controllers/selfie_controller.js),
  and a standalone React component for AWS Amplify's Face Liveness widget —
  [app/javascript/liveness/amplify_liveness.jsx](app/javascript/liveness/amplify_liveness.jsx).
  This is real precedent for "getUserMedia works in this candidate population," even
  though it's a one-shot capture, not continuous monitoring.
- **"Exam" here is only a handoff.** `VerificationFlowController#exam` redirects the
  candidate back to QabaBoard via `redirect_url_on_pass` —
  [app/controllers/verification_flow_controller.rb](app/controllers/verification_flow_controller.rb).
  VerifyID-Portal's involvement ends before the exam starts.
- API surface: `POST /api/v1/verification_sessions` (bearer-authed, create-only),
  plus a proctor-review sub-scope (`GET review`, `POST release`, `POST reject`) keyed
  by `qaba_board_session_id` — [config/routes.rb:37-51](config/routes.rb#L37-L51),
  documented fully in [docs/QABA_BOARD_INTEGRATION.md](docs/QABA_BOARD_INTEGRATION.md).
- Infra: Docker + Kamal. **Note:** `config/deploy.yml` still contains leftover
  boilerplate from an unrelated app (`service: eob-parser`) — flagged for the infra
  owner, not something to build proctoring deployment assumptions on top of yet.
- No CI (`.github/workflows`) in this repo today.

### qababoardweb (the exam/enrollment platform)

- Rails 7.0.4, Devise + Doorkeeper OAuth2, Postgres, Sidekiq, Redis, ActionCable
  **is** actively used — one channel, `AiDocumentReviewChannel`, streams AI
  document-verification status to the browser
  (`app/channels/ai_document_review_channel.rb`, broadcast from
  `app/services/ai/verification_adapters/base_adapter.rb:77-91`). This is a directly
  reusable pattern for proctor alert delivery (Section 7).
- Exam-session entity is `Schedule` (`belongs_to :enrollment`, `belongs_to :examiner`
  — examiner is the proctor), not a dedicated "ExamSession" model —
  `app/models/schedule.rb`.
- Take-exam flow (`app/controllers/external/v1/take_exam_controller.rb`): OTP entry →
  `create_exam_session` looks up `Schedule.find_by_safe_exam_browser_key(code)` → if
  identity verification is required and not yet done, redirect to VerifyID-Portal's
  hosted flow → on return, `start_exam` calls `ExamSession::ExamInvitation`, which
  talks to **a third, separate external backend** (credential
  `exam_session.client_url`) to mint a token and iframes it:
  `"#{exam_session_client_url}/pre-information?token=...&embed=true"`.
- **Critical finding:** the actual exam-taking UI (question rendering, timing,
  submission) is not in either repo we can inspect. It is a black-box iframe. Any
  proctoring client that needs to run for the full duration of the exam must live in
  the **parent page that hosts that iframe** (i.e., inside qababoardweb's
  `take_examination/start` view), not inside the iframe itself, since we cannot modify
  that third system.
- **Today's "proctoring"** is a Google Calendar-generated Google Meet link
  (`hangoutsMeet` conference type) — `app/services/google/calendar_service.rb`,
  triggered from `app/services/users/enrollments/notification_service.rb`, stored on
  `schedule.google_meet_link`, emailed to the candidate, shown to the examiner in
  `app/views/examiners/dashboard/task_info.html.erb`. It is a manual, human-hosted
  video call with **no integration** with the exam iframe and no automated monitoring
  of any kind.
- **Open question raised by this inspection:** `Schedule.find_by_safe_exam_browser_key`
  implies Safe Exam Browser (SEB) integration exists at least at the data-model level.
  If SEB is actually enforced at exam time, that already provides OS-level lockdown
  (blocks switching apps/tabs) which would reduce the need for some of the detections
  requested here (e.g., "looking at another monitor" is less useful to detect if the
  candidate cannot alt-tab to anything in the first place). This needs a follow-up
  conversation with whoever owns the qababoardweb/exam-session integration before we
  size Section 6 more precisely — see Open Questions (Section 20).

### Implication for architecture

We own two of the three systems in the candidate's exam-time browser tab, and neither
of them is the one currently doing the actual exam. The only two safe places to run a
persistent, full-exam-duration proctoring client without touching third-party code we
don't have are:

1. A widget embedded in qababoardweb's exam-hosting page, running alongside the
   iframe (best: this is literally where the candidate's browser already is for the
   full exam duration).
2. A candidate keeps a second browser tab/window open pointed at a VerifyID-Portal-hosted
   proctoring page for the exam duration (worse UX, but zero changes required to
   qababoardweb, and reuses VerifyID-Portal's existing webcam-permission precedent and
   proctor/admin auth).

POC #1 deliberately avoids this decision entirely by being a standalone, unwired
prototype (Section 17) — but Section 6 records the trade-off for when we're ready to
integrate for real.

---

## 6. Proposed Architecture

```
Candidate Browser (inside qababoardweb's exam-hosting page)
  ├─ [black-box iframe] third-party exam engine — untouched
  └─ Proctoring Client (new)
       ├─ getUserMedia (camera) ─┐
       ├─ getUserMedia (mic)     ├─► On-device detectors (WASM/WebGL, in a Worker)
       └─ getDisplayMedia (opt.)─┘     • MediaPipe Face Detector / Landmarker
                                        • Head-pose heuristic (gaze proxy)
                                        • VAD (voice activity)
                                        • TF.js / onnxruntime-web object detector
                    │
                    │  small JSON event payloads only
                    │  (+ short evidence clip, only on confirmed event)
                    ▼
        Proctoring Backend (new — proposed home: VerifyID-Portal)
          ├─ AI Event API (persist DETECTED → ALERTED → ... → CONFIRMED/DISMISSED)
          ├─ Evidence Service (rolling-buffer clip upload → S3, short TTL)
          └─ ActionCable broadcast (reuses the pattern qababoardweb already has)
                    │
                    ▼
        Proctor Dashboard (extends existing proctor/admin surface)
          ├─ Live alert feed per exam session
          ├─ Evidence playback
          └─ Review → Confirm / Dismiss / False Positive  (human-in-the-loop, mirrors
             the existing ProctorReview / VerificationSession release/reject pattern)
```

Data model sketch (subject to change after POC #6/#7):

```
Candidate ─┬─< ExamProctoringSession >─┬─< AiEvent >──< Evidence >
           │                           │
           └── (existing VerificationSession, unrelated but adjacent)
```

`AiEvent` fields (draft): `event_type`, `detector_version`, `confidence`,
`detected_at`, `persisted_duration_ms`, `status`, `evidence_id (nullable)`,
`proctor_review_id (nullable)`. This deliberately mirrors the
`VerificationSession`/`ProctorReview` pattern already in this codebase rather than
inventing a new shape.

**Why VerifyID-Portal, not qababoardweb, for the backend/dashboard:** this repo
already owns proctor authentication, Pundit-based authorization, and a
human-review-with-final-decision UI pattern end to end. qababoardweb's `examiner`
concept is closer to "the person administering this specific exam" than "a trained
proctor reviewing AI alerts across sessions," and qababoardweb's ActionCable use is a
pattern to imitate, not a system we need to extend directly. The candidate-facing
*capture* client, however, has to be embedded wherever qababoardweb hosts the exam
iframe — that part cannot live in VerifyID-Portal, because VerifyID-Portal's page is
gone by the time the exam starts (Section 5).

This is a proposal, not a locked decision — see Decision Log.

## 7. Technology Options

| Concern | Options | Notes |
|---|---|---|
| Face/gaze detection | MediaPipe Tasks Vision (Face Detector, Face Landmarker), TensorFlow.js face-landmarks-detection, OpenCV.js + dlib-style landmarks | MediaPipe is the most actively maintained, ships WASM+GPU delegate, is what POC #1 used. |
| Object/phone detection | TF.js COCO-SSD, YOLOv8n via onnxruntime-web, custom-trained model | COCO already has a "cell phone" class — zero training needed for an MVP, but accuracy is unvalidated (POC #3). |
| VAD / speech | Web Audio API + energy-based VAD, Silero VAD via WASM (`@ricky0123/vad-web`), server-side Whisper | VAD first; full STT only if VAD proves insufficient — see Section 10. |
| Real-time alerts | ActionCable (Redis-backed, already configured in this repo, already *used* in qababoardweb), raw WebSockets, SSE | ActionCable is the path of least resistance — infra already exists in both repos. |
| Evidence storage | S3 (already used for ActiveStorage/Rekognition uploads here), Cloudflare R2 | Stay on S3 — no new vendor relationship needed. |
| Screen capture | `getDisplayMedia()` + WebRTC | View/record only — remote control explicitly not recommended (Section 10). POC #5 validated P2P WebRTC with signaling over the existing push channel; production needs TURN; SFU only if >1 viewer per candidate or server-side recording is required (Section 27). |

## 8. Research Findings

Findings that shape every downstream recommendation:

1. **Webcam-based face detection is fast and accurate enough on ordinary laptop
   hardware.** POC #1 confirms this concretely (Section 18) — see measured latency/FPS.
2. **True eye-gaze estimation from a webcam is materially less reliable than head
   pose.** The literature consistently shows multi-degree error for pupil-direction
   gaze estimation from consumer webcams, highly sensitive to camera placement,
   glasses, and lighting. Head pose (where the face is pointed) is a much sturdier
   proxy for "is this candidate looking at their screen" and is what POC #2 should
   build on, with true gaze treated as a lower-confidence secondary signal at best.
3. **AWS Rekognition is the wrong tool for continuous monitoring.** It's a per-call,
   server-side API optimized for one-shot verification (which is exactly how this
   repo already uses it). Running it per video frame would be slow (network
   round-trip per frame) and expensive at exam scale. Continuous detection belongs
   client-side (MediaPipe/TF.js), with server-side vision reserved for evidence-clip
   review, not live inference.
4. **Voice activity detection is a fundamentally different (and much cheaper/safer)
   problem than speech-to-text.** VAD answers "is someone talking" in near-real-time
   with a small on-device model and minimal privacy exposure. STT/Whisper answers
   "what did they say," requires transmitting or transcribing actual speech content,
   and raises materially larger privacy/compliance questions for comparatively
   marginal proctoring value (we mostly need to know *that* someone is talking, not
   the content, to flag it for human review).
5. **We don't have visibility into the actual exam-rendering engine.** This is a gap,
   not just a finding — see Open Questions. It caps how deep any integration can go
   until someone with access to that codebase is looped in.
6. **The `safe_exam_browser_key` field suggests SEB may already be partially
   integrated**, which could significantly change which detections are still worth
   building (see Section 5). Needs follow-up before POC #5/#6 architecture is
   finalized.

## 9. Build vs Buy Analysis

| | Option 1: Google Meet + bolt-on AI | Option 2: Switch to Zoom/Teams | Option 3: Dedicated proctoring vendor (e.g. Proctorio, Honorlock, ProctorU, Examity, Talview) | Option 4: Build fully in-house |
|---|---|---|---|---|
| AI capabilities | None native; must build all of it ourselves (what this doc proposes) | Some (Zoom has limited attention/engagement signals; not built for exam integrity) | Mature — gaze, ID check, room scan, browser lockdown, phone detection, often years of tuning | Full control, but months of tuning to reach vendor-grade accuracy |
| Screen monitoring | None native | Screen share exists, not proctoring-purpose-built | Yes, purpose-built, often with lockdown browser | Must build (Section 10) |
| Integration complexity | Low — already in use, just add our AI layer alongside it | Medium — new vendor relationship, re-plumb scheduling/links | Medium-high — new vendor, webhook/API integration, data contracts | High — everything from scratch |
| Cost | Low incremental (Meet is likely already paid for) | Similar to Meet, migration cost | Per-candidate/per-exam licensing, can be significant at scale | Engineering time, ongoing model/infra maintenance |
| Privacy/data control | We control what we build; Meet itself is a black box for video | Same category as Meet | Candidate biometric/video data leaves our infra to the vendor — real compliance surface | Full control, full responsibility |
| Vendor lock-in | None | Low-medium | High — proprietary detection, hard to migrate off | None |
| Time to first value | Fast (this R&D track) | Slow (re-plumbing) for little proctoring gain | Fast to buy, slow to negotiate/integrate/procure | Slowest |

**Recommendation:** Do not switch to Zoom/Teams — it solves nothing this exercise
cares about. Between Option 1+custom-AI and Option 3 (vendor), we recommend
**building the narrow, high-value detections in-house first** (this R&D track),
because: (a) the specific behaviors flagged in the brief are narrow enough to be
POC-able cheaply, (b) it avoids sending candidate video/biometric data to a new
third-party vendor before we know whether our own detection is even good enough to
be worth acting on, and (c) it keeps optionality — if in-house detection proves
insufficiently reliable (a real possibility, see Risks), evaluating a dedicated vendor
remains available as a fallback with better information than we have today. This is
explicitly **not** a "build everything ourselves forever" recommendation — it's
build-first-to-learn, re-evaluate buy after POC #3/#4 give us real accuracy numbers.

## 10. AI Detection Options

### Gaze Detection

- **Technology:** MediaPipe Face Landmarker (478 landmarks + blendshapes) to derive
  head pose (yaw/pitch/roll) via a canonical 3D face model fit; iris landmarks are
  available for a coarser eye-direction signal.
- **Trade-off:** head pose is robust and cheap; true pupil-gaze is noisy on consumer
  webcams. Recommend head pose as the primary "looking away" signal, with a
  configurable yaw/pitch threshold and sustained-duration requirement, exactly as the
  brief specifies. Treat iris-based gaze as an unvalidated stretch signal for POC #2,
  not something to alert on by itself yet.
- **Status:** not yet built. Proposed as POC #2.

### Face Detection / Out-of-Camera Detection

- **Technology:** MediaPipe Face Detector (BlazeFace), bounding-box presence +
  position-relative-to-frame heuristics.
- **Validated in POC #1** — see Section 18 for concrete results.

### Speaking Detection

- **Technology:** client-side VAD (energy-based or a small WASM model like Silero VAD)
  as the primary signal; escalate to short-clip transcription only for confirmed,
  sustained speech events, and only where evidence review requires understanding
  content vs. background noise. Do not run continuous STT.
- **Status:** not yet built. Proposed as POC #4.

### Phone Detection

- **Technology:** TF.js COCO-SSD (has a "cell phone" class out of the box, no training
  required for an MVP) or a YOLOv8n ONNX model via onnxruntime-web for better
  accuracy/latency trade-offs.
- **Key unresolved question:** whether generic COCO-class detection can reliably tell
  a phone apart from a calculator/notebook/water bottle at webcam resolution and
  steep angles. This is explicitly *not* assumed — it's what POC #3 exists to answer.
- **Status:** not yet built. Proposed as POC #3.

### Screen Monitoring

- **Technology:** `getDisplayMedia()` for view/record; explicitly **not** remote
  control or remote access — see Section on Automatic Exam Pause reasoning, same logic
  applies here: the minimum capability that satisfies "a proctor can see what's on the
  candidate's screen" is view/record, not control. Remote control is a materially
  larger security and consent undertaking with no clear requirement driving it in the
  brief.
- **Status:** implemented as POC #5 — see Section 27 (research, measured results,
  multi-monitor limits, and why remote control is neither possible from a browser
  nor needed).

### Evidence Recording

- **Technology:** client-side rolling buffer (`MediaRecorder` writing to an in-memory
  ring buffer, e.g. last 30–60s), flushed to S3 only when a detector confirms an event
  (persistence threshold met), capturing N seconds before/after. This avoids
  continuous video upload for the entire exam for every candidate — a meaningful
  bandwidth and storage cost saver, and better for privacy (Principle 4).
- **Status:** not yet built. Proposed as POC #7, after real-time eventing (POC #6)
  exists to trigger it.

### Automatic Exam Pause

Recommend **Option A for the initial rollout**: AI detects → alerts proctor → proctor
decides whether to pause. Reasoning:

- Object detection false-positive rates are unvalidated (that's the point of POC #3).
  Automatically pausing an exam on an unvalidated signal is a disproportionate
  consequence for the false-positive candidates.
- Automatic pause introduces real distributed-systems risk this brief already flags:
  race conditions between a pause command and in-flight exam-state writes on the
  black-box exam engine, network failures during the pause round-trip, and candidates
  reconnecting into an inconsistent state — none of which we can properly reason about
  without visibility into that third system's session handling.
- Option C (very-high-confidence temporary auto-pause + mandatory proctor review) is a
  reasonable **future** middle ground once POC #3 produces real precision/recall
  numbers and a confidence threshold can be chosen with evidence rather than a guess.
  We do not recommend committing to it yet.
- Option B (fully automatic, no review) is not recommended at any point covered by
  this brief — the brief itself frames this as AI-assisted human proctoring, and full
  autonomous disciplinary action contradicts that framing (Section 14).

---

## 11. Privacy / Security

Not legal advice — flagged here as technical/product considerations to review with
legal/compliance before any of this goes to real candidates:

- **Biometric data.** Face landmarks, head pose, and any face-embedding-adjacent data
  are biometric in nature in several jurisdictions (e.g., Illinois BIPA-style regimes,
  GDPR "special category" data). This repo already handles biometric data via
  Rekognition for identity verification with an existing consent step in
  `VerificationFlowController` — the proctoring feature should extend that same
  consent surface rather than inventing a separate one, so candidates aren't asked to
  consent twice with different language.
- **Data minimization by design (Principle 4).** The proposed architecture sends
  events + short evidence clips, not continuous raw video, specifically to reduce
  what's collected and stored, not just for bandwidth reasons.
- **Audio recording** raises its own consent question distinct from video (two-party
  consent recording laws vary by jurisdiction) — flag explicitly for legal review
  before POC #4 (speaking detection) touches real audio outside a controlled test.
- **Retention.** This repo already has a `SelfieRetentionPurgeJob` precedent for
  time-boxed retention of sensitive captures — proctoring evidence should follow the
  same pattern (short, explicit TTL) rather than indefinite retention.
- **Access control.** Evidence and events should be visible only to authorized
  proctor/admin roles, reusing the existing Pundit policy pattern.
- **No third party gets raw candidate video by default** under the recommended
  build-first approach (Section 9) — this is itself a privacy argument in favor of
  building the narrow detections in-house rather than routing all candidate video
  through a vendor immediately.

## 12. Accessibility

- AI detection must not penalize behavior caused by an approved accommodation (e.g., a
  candidate with a motor impairment who needs to look away/reposition more, a
  candidate using a screen reader whose gaze pattern differs, a candidate with a
  speech impairment whose vocalization patterns differ from "reading aloud").
- Proposed representation: an `accommodations` flag/set on the candidate's exam
  session (mirrors how `identity_verification_required?` already exists as a
  per-user flag on qababoardweb's `User`) that downstream detectors read to either
  suppress specific alert types or widen thresholds for that candidate, rather than
  hard-coding accommodation logic into each detector.
- This needs real input from whoever manages accommodation requests today — not
  something to finalize from repo inspection alone. Added to Open Questions.

## 13. Human-in-the-Loop Design

Directly reuses this repo's existing pattern:
`VerificationSession` (`pending → ... → passed/flagged → released_by_proctor/rejected_by_proctor`)
and `ProctorReview` already implement "AI/system flags → human proctor makes the final
call" for identity verification. The proposed `AiEvent` status lifecycle
(`DETECTED → ALERTED → ACKNOWLEDGED → UNDER_REVIEW → CONFIRMED/DISMISSED/FALSE_POSITIVE`,
per the brief) is the same shape applied to proctoring events instead of identity
flags. Every alert must carry confidence and a plain-language reason
("head turned >35° for 4.2s"), never a conclusion.

## 14. Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| False positives erode proctor trust, system gets ignored | Medium-High | High | Persistence thresholds, hysteresis, measure FP rate explicitly per POC before wider rollout (Principle 5/6) |
| Generic object detector can't reliably distinguish phone from other objects | Medium | High (esp. if ever tied to auto-pause) | POC #3 measures this directly before any pause automation is considered |
| We don't have access to the real exam-engine codebase | Confirmed (known gap) | Medium | Constrain proctoring client to the qababoardweb parent page; loop in exam-engine owner before POC #5/#6 |
| Low-end candidate hardware can't run client-side models smoothly | Medium | Medium | POC #1/#2/#3 must include CPU/FPS measurements on modest hardware, not just dev machines |
| Biometric/audio data handling triggers compliance exposure | Medium | High | Legal/compliance review before any real candidate data is processed (Section 11) |
| SEB may already provide lockdown, making some detections redundant or lower priority | Unknown | Medium | Resolve as Open Question before finalizing POC #5/#6 scope |
| Leftover `deploy.yml` boilerplate suggests infra config isn't fully owned/audited | Low-Medium | Low-Medium | Flag to infra owner; don't build deployment assumptions on it yet |
| Candidates can't share screen on exam day (macOS Screen Recording permission, needs browser relaunch; indistinguishable from "Cancel") | High on macOS | High | Pre-exam check in POC #8; explicit macOS walkthrough; never discover this at exam start |
| Candidate shares one monitor, uses another | Medium | Medium | Single-monitor policy + `MULTIPLE_MONITORS` alert (Chromium `screen.isExtended`); webcam head-turn (POC #2); cannot be fully closed from a browser (Section 27) |
| Screen-view request from an unauthorized party | Medium if unaddressed | High | Server-brokered view requests only, scoped to the proctor assigned to that session (Pundit) — POC #5 has no auth by design |
| Some candidate networks can't connect P2P | Medium | Medium | TURN (TLS/443) required in production — not in POC #5 |
| Entire-screen share exposes unrelated personal data (notifications, messages) | Medium | Medium | Candidate instructions + consent review; no recording by default; P2P keeps video off our servers |
| Third-party libraries send data we didn't know about (found: MediaPipe ≥ 1.0.0 usage telemetry) | Confirmed | Medium-High (privacy claims made to candidates become untrue) | Pin versions; enforce a CSP `connect-src` allow-list in every candidate page; network-audit tests that run longer than any batching interval (Section 28.10, F1) |
| Candidate-facing exam rules are wrong, invented, or differ between languages | Medium without controls | High | Rules only from versioned, reviewed content files; no runtime LLM; an EN/AR parity test (Section 28) |
| Arabic onboarding text is inaccurate or in the wrong register | Medium (machine-drafted today) | High for the Arabic cohort | Qualified bilingual review before any candidate sees it; `translation_status` flag in content (Section 28) |
| A second person in view is flagged late because the face model misses them intermittently | Confirmed on a test video (Face Landmarker: second face in 84% of frames) | Medium-High (a helper next to the candidate goes unflagged for seconds) | Use BlazeFace (100% on the same video) for face count; confirm on 720p webcams (Section 28.10, F6; D2 = Revisit) |

## 15. Recommended Architecture

See Section 6. Summary of the key recommendation: client-side-first detection,
event/evidence-only network traffic, proctoring backend + dashboard hosted in
VerifyID-Portal (reusing its existing proctor auth and human-review pattern),
capture client embedded in qababoardweb's exam-hosting page. Not locked — see
Decision Log for status.

## 16. POC Roadmap

| # | Goal | Status |
|---|---|---|
| 1 | Face presence / out-of-frame / multiple faces | **Done** — Section 17/18 |
| 2 | Gaze / head pose | **Implemented, tested** — see Section 22; written results pending |
| 3 | Phone/object detection | **Implemented, tested** — see Section 23; written results pending |
| 4 | Audio/speaking detection | **Implemented, tested** — see Section 24; written results pending |
| 5 | Screen capture | **Implemented** — see Section 27; automated results recorded, manual matrix pending |
| 6 | Real-time events → proctor dashboard | **Implemented, tested** — see Section 25; written results pending |
| 7 | Evidence rolling-buffer recording | **Implemented, tested** — see Section 26 |
| 8 | Practice/onboarding simulator | **Implemented** — see Section 28; automated results recorded, team EN run passed (2026-10-06), manual matrix (real candidates) pending |

## 17. POC #1

**Question:** Can we reliably detect whether a candidate's face is present, and
whether they've moved out of frame, using a normal browser webcam?

**Scope (explicitly excluded):** production auth, production video storage, automatic
exam suspension, full proctor dashboard, full AI architecture, payment
infrastructure, production deployment, complete candidate workflow. This is a
standalone, unwired prototype — it does not touch any Rails route, controller, model,
or the production JS bundle.

**Location:** [poc-01-face-presence/](poc-01-face-presence/) — plain HTML/CSS/JS,
MediaPipe Tasks Vision loaded from CDN (no build step, no npm dependency added to this
repo's `package.json`). Run instructions in that folder's README.

**Design:**
- MediaPipe Face Detector (BlazeFace short-range model) — chosen over the heavier Face
  Landmarker because POC #1 only needs bounding boxes (presence/position/count), not
  478 landmarks; lighter model = better read on real-world CPU/latency headroom, which
  is exactly what this POC is measuring.
- All inference runs in the browser via WASM (with GPU delegate where available); no
  frame is ever sent anywhere.
- A small state machine per condition (`FACE_MISSING`, `OUT_OF_FRAME`,
  `MULTIPLE_FACES`) requires the condition to hold for a configurable persistence
  window (default 1.5s) before raising an event, and requires it to clear for a
  configurable window before resolving — directly implementing "avoid excessive false
  positives" and the grace-period behavior described in the brief.
- Every event is timestamped, carries the detector's confidence score, and is logged
  to an on-screen table plus `localStorage` (exportable as JSON) — satisfying "record
  basic event history" without standing up any backend.
- Per-frame inference latency and rolling FPS are measured and displayed live, to
  answer the "is this fast enough" question directly rather than by assertion.

## 18. POC #1 Results

Recorded after manual testing — see the "Testing Notes" section of
[poc-01-face-presence/README.md](poc-01-face-presence/README.md) for the raw
observations log; this section is the synthesized summary.

*(To be filled in immediately after manual testing is performed — see Section 29 test
matrix. This section is intentionally left for the human tester's observations since
POC #1's own author, i.e. this assistant, cannot physically sit in front of a webcam
under different lighting/distance/angle conditions. The POC ships with an in-app event
log and a JSON export specifically so a human can run the test matrix and drop results
here.)*

---

## 19. Decisions

See Decision Log below for the running table. Nothing in Section 6/15 is final —
those sections record the current best proposal, not an approved architecture.

## 20. Open Questions

1. Is Safe Exam Browser actually enforced at exam time (`find_by_safe_exam_browser_key`
   in qababoardweb), or is that field vestigial/partial? This materially affects which
   detections (esp. out-of-frame, "looking at another monitor") are still high-value.
2. Who owns/can grant access to the third-party "exam session" engine
   (`exam_session.client_url`)? Needed before any POC that requires touching the
   actual exam iframe rather than just the parent page.
3. What accommodation data already exists for candidates (Section 12), and where does
   it live today?
4. Is there an existing legal/compliance point of contact to review Section 11 before
   POC #4 (audio) or any pilot with real candidates?
5. Confirm `config/deploy.yml`'s `eob-parser` leftover config isn't accidentally live
   — unrelated to proctoring, but discovered during this inspection and worth a
   separate ticket.
6. If SEB is enforced: does `getDisplayMedia()` work inside SEB's kiosk at all, and
   does SEB make live screen viewing redundant? (POC #5 assumes a normal browser.)
7. Is screen monitoring covered by the existing candidate consent, or does
   entire-screen sharing need its own consent language (Section 11, Section 27)?
8. Policy: must screen sharing be active to *start* the exam, and what happens if it
   stops mid-exam? (Alert-only is consistent with the Automatic Exam Pause decision;
   gating exam *start* is a separate product decision.)
9. Who hosts TURN in production — self-hosted coturn or a managed TURN service?
10. Arabic digits: Latin (`1,234`) or Arabic-Indic (`١٬٢٣٤`) in candidate-facing
    text? POC #8 pins Latin (`ar-u-nu-latn`), assuming that matches the exam engine.
    The target countries and the exam engine's own convention decide this.
11. Who owns and approves the candidate-facing exam rules (allowed/prohibited items,
    room, breaks, ID, accommodations) and their Arabic translation? POC #8's rules are
    placeholders until someone does.
12. Are MediaPipe's usage telemetry (Section 28.10, F1) and the other third-party
    requests (jsDelivr, Google model storage) acceptable to legal/compliance, or must
    production self-host everything?
13. Religious head coverings: what do proctors do today about ears/headphones checks
    for candidates wearing hijab? The draft rules avoid "ears must be visible", but the
    real policy needs an explicit, respectful procedure.
14. Should candidates see live nudges during the *real* exam, or only in practice?
    POC #8 assumes yes (Section 4 already plans a "please face the camera" UX), but it
    affects anxiety and the "teaching evasion" risk.

## 21. Next Steps

1. Record POC #1–#4's manual test-matrix results into Section 18 and the Results
   subsections under Section 22/23/24 — all still blank. Testing has happened for
   all four per the team, but the written results aren't captured in this document
   yet, which matters for anyone reviewing this doc later without having been in the
   room.
2. Run POC #6's manual test matrix (see `poc-06-realtime-alerts/README.md`) — not
   yet done. The `curl`-based verification during implementation covered the API/SSE
   mechanism itself; it did not cover multi-tab sync, dashboard reconnect-on-refresh,
   or extended-run behavior, which need a human with two browser tabs open.
3. Run POC #7's manual test matrix (see `poc-07-evidence-capture/README.md`) — not
   yet done. The `curl`-based verification during implementation covered the
   server-side API only; real buffer timing and clip-centering need a human with a
   real webcam. **Clear the local `clips/` folder after testing.**
4. Resolve Open Questions #1 and #2 — they change the shape of any real
   ActionCable/S3 integration that follows POC #6/#7, and #1 (SEB) directly affects
   whether POC #5's screen viewing is needed/possible at exam time.
5. Run POC #5's manual test matrix (`poc-05-screen-capture/README.md`) — in
   particular real window/tab rejection, a real second monitor, the macOS permission
   flow, Firefox/Safari/Edge on Windows, a cross-machine network test, and 5+
   candidates on separate machines. Record results in Section 27.
6. Review the POC #8 proposal (Section 28) and approve/adjust scope before any
   implementation, per the working rule governing this R&D track.

## 22. POC #2 — Gaze / Head-Pose Detection

**Status: implemented. Awaiting manual test-matrix results.**

**Location:** [poc-02-gaze-headpose/](poc-02-gaze-headpose/) — same standalone,
unwired pattern as POC #1 (plain HTML/CSS/JS, MediaPipe from CDN, no build step). Run
instructions in that folder's README.

**Question:** Using the same on-device MediaPipe pipeline as POC #1, can we reliably
detect sustained "looking away from screen" via head pose (yaw/pitch), at real-time
FPS, with a low enough false-positive rate on normal reading/typing behavior to be a
usable proctoring signal?

**Possible approaches considered:**

1. MediaPipe Face Landmarker with `outputFacialTransformationMatrixes: true` — a
   built-in head-pose transformation matrix per frame, no manual pose math required.
2. MediaPipe Face Landmarker + manual solvePnP-style fit from the 478 landmarks — more
   control, more code, no clear benefit over (1) for this POC's scope.
3. TF.js `face-landmarks-detection` (MediaPipe FaceMesh runtime) — an alternate
   library around the same underlying approach.
4. OpenCV.js + classic 68-point landmarks + solvePnP — heavier, not WASM/GPU-optimized
   the way MediaPipe is.
5. Iris/pupil-based gaze estimation — explicitly kept as a secondary/experimental
   signal only, per Section 8 finding #2 (pupil-direction gaze from consumer webcams
   is materially noisier than head pose).

**Recommended approach:** Option 1 — MediaPipe Face Landmarker's built-in facial
transformation matrix, decomposed to yaw/pitch/roll. Reuse POC #1's UI shell and
persistence/hysteresis state machine pattern, with new thresholds (head turns are
naturally more frequent and briefer than going fully out of frame, so the tuning
can't just be copied from POC #1). Classify each frame as `FOCUSED` or `LOOKING_AWAY`.
Add a one-time calibration step ("look at your screen, click calibrate") to establish
a per-candidate baseline pose — "looking at the screen" is not yaw=0/pitch=0
universally, it depends on webcam position, monitor size, and seating distance. Iris
gaze stays out of scope for this POC.

**Relevant technologies:** MediaPipe Tasks Vision `FaceLandmarker` (same CDN-loaded
library POC #1 already uses — minimal new dependency risk), the
`outputFacialTransformationMatrixes` option, and the same Canvas overlay / event-log /
localStorage pattern from POC #1's `app.js`.

**Trade-offs:**
- Face Landmarker is heavier than POC #1's Face Detector (BlazeFace) — FPS/latency
  need to be re-measured on the same test hardware, not assumed to carry over from
  POC #1.
- Built-in transformation matrix vs. manual PnP: simpler and less error-prone: start
  there, only fall back to manual PnP if the built-in output proves insufficient.
- Whether presence detection (POC #1) and pose detection (POC #2) should eventually
  consolidate into a single loaded model (fewer models = better perf) is a real
  question, but it's a later integration decision (closer to POC #6), not this POC's
  scope — per instruction, POC #1 is not being modified for this.

**Risks/limitations:**
- Head pose alone can't distinguish "checking a second monitor" from "glancing at
  notes on the desk" from "stretching" — likely a higher false-positive rate than
  POC #1's binary presence signal. Must be measured, not assumed.
- Low webcam angle (laptop lid tilted down, a common real-world setup) is a known
  failure mode for head-pose estimation accuracy.
- Glasses, hijab/head coverings, and facial hair may affect landmark accuracy — worth
  testing explicitly given the brief's accessibility and Arabic-candidate-onboarding
  goals (Section 2, Section 12).
- Heavier model on low-end candidate hardware — same class of risk already logged in
  Section 14 for POC #1.
- Without calibration, false positives could be driven by webcam placement rather
  than actual inattention — the POC should directly compare calibrated vs.
  uncalibrated behavior, not assume calibration helps.

**Success criteria:**
- ≥15 FPS sustained on typical laptop hardware (benchmarked against whatever FPS
  POC #1's pending manual test run establishes as a baseline).
- A sustained head-turn (large yaw, held past the persistence window) reliably
  triggers `LOOKING_AWAY`; brief glances and normal reading/typing posture changes do
  not.
- Calibration measurably reduces false positives vs. a fixed absolute-zero baseline.

**Minimal implementation scope:** A new `poc-02-gaze-headpose/` folder, forked
from POC #1's UI/state-machine/event-log pattern (POC #1 itself is not modified).
Swap the detector to Face Landmarker, add a live yaw/pitch/roll readout and a
calibration button, and classify only `FOCUSED` / `LOOKING_AWAY` — no fusion with
POC #1's signals yet (that's future integration work, not this POC). Same privacy
posture as POC #1: all inference local, no upload, localStorage-only event log.

**Testing plan:** Same manual-test-matrix discipline as POC #1 (see its README):
straight ahead / second-monitor left / second-monitor right / looking down at notes /
looking up / extreme yaw / glasses on and off / hijab or head covering / poor
lighting / low-end webcam / calibrated vs. uncalibrated / extended-run drift.

**Implementation notes (what actually got built):**
- Head pose is derived from MediaPipe's `facialTransformationMatrixes[0]` (built-in,
  not manual solvePnP), decomposed to yaw/pitch/roll via the standard
  `R = Rz·Ry·Rx` formula. Sign/axis correctness is a manual-testing item (see the pose
  axis visualization row in the POC's test matrix), not assumed correct by
  construction.
- Calibration is a single-click snapshot baseline, not an averaged capture — flagged
  as a known limitation in the POC's README, worth watching for noise during testing.
- No-face frames are treated as "gaze unavailable" (state machine resets, no event),
  deliberately not duplicating POC #1's `FACE_MISSING` job.

### POC #2 Results

*(Pending — same as POC #1's Section 18, this needs a human to actually run the test
matrix in [poc-02-gaze-headpose/README.md](poc-02-gaze-headpose/README.md) in front of
a webcam. Drop the synthesized results here once that's done.)*

## 23. POC #3 — Phone / Object Detection

**Status: implemented. Awaiting manual test-matrix results.**

**Location:** [poc-03-phone-object/](poc-03-phone-object/) — same standalone,
unwired pattern as POC #1/#2 (plain HTML/CSS/JS, MediaPipe from CDN, no build step).
Run instructions in that folder's README.

**Question:** Can a pretrained, no-training-required object detector reliably
distinguish a phone from visually similar objects (calculator, TV remote, wallet,
notebook) at typical webcam distance/angle, well enough to be a usable proctoring
signal? This is the exact open question flagged in Section 10 ("Phone Detection") —
this POC exists to answer it with real data.

**Possible approaches considered:**

1. TF.js COCO-SSD — pretrained, has a `"cell phone"` class out of the box, but an
   older/lower-accuracy architecture (SSD MobileNet-based).
2. YOLOv8n via onnxruntime-web — likely better accuracy/speed, but introduces a
   second inference runtime alongside MediaPipe (already used for POC #1/#2), plus a
   separate model format to manage.
3. MediaPipe Tasks Vision `ObjectDetector` (EfficientDet-Lite0, COCO-pretrained) —
   same library/CDN/WASM pattern already proven working in POC #1/#2, zero training,
   has a `"cell phone"` class.
4. Custom-trained model — explicitly out of scope for a first POC, per Section 10.

**Recommended approach:** Option 3 — MediaPipe `ObjectDetector` with
EfficientDet-Lite0. Keeps the stack consistent with POC #1/#2 (same runtime, same
known WASM/GPU-delegate performance profile on this hardware), zero training
required. If precision proves too low in testing, YOLOv8n is the documented fallback
to evaluate next — not something to build preemptively.

**Trade-offs:**
- EfficientDet-Lite0 is MediaPipe's fastest/smallest object-detector variant, chosen
  for real-time use; Lite2 (heavier, more accurate) is the escalation path if Lite0's
  precision proves too low.
- Object detection models are generally heavier than the face-only models in
  POC #1/#2 — FPS/latency is measured fresh in this POC, not assumed to carry over.
- Only the COCO `"cell phone"` category drives classification; every other recognized
  object is still drawn on screen (label + confidence) purely as a diagnostic aid, so
  testers can see what a decoy object gets misclassified as.

**Risks/limitations:**
- False positives on visually similar objects (calculator, TV remote, wallet,
  notebook) — the central open question this POC exists to answer, not assumed away.
- False negatives on angled, partially occluded, or low-in-frame phones (e.g. held
  below desk level, a realistic real-world case).
- COCO's training data isn't webcam-desk-angle-specific — real domain shift risk.
- Per the existing Decision Log entry on Automatic Exam Pause, none of this feeds
  auto-pause regardless of measured accuracy — alert-only, unconditionally.

**Success criteria:**
- Reliable phone-in-view detection within the persistence window.
- An explicit, measured false-positive rate against a decoy-object set (calculator,
  remote, wallet, water bottle, empty hand) — not just phone-present/absent testing.
- FPS/latency benchmarked against POC #1/#2's numbers once those are recorded.

**Minimal implementation scope:** New `poc-03-phone-object/` folder, same
UI/state-machine/event-log pattern as POC #1/#2 (each POC stays standalone, no shared
code). Classifies only `NO_PHONE` / `PHONE_DETECTED` based on the COCO
`"cell phone"` category — no generic "any object" alerting. Same privacy posture:
all inference local, no upload, localStorage-only event log.

**Testing plan:** phone held up / on desk / near face / at an angle / partially
occluded / below desk level, decoy objects (calculator, TV remote, wallet, water
bottle, empty hand — explicitly checking what label each gets), varied
distance/angle/lighting, brief vs. sustained appearance, extended-run drift.

### POC #3 Results

*(Pending — same as POC #1/#2, this needs a human to actually run the test matrix in
[poc-03-phone-object/README.md](poc-03-phone-object/README.md) in front of a webcam
with real objects, especially the decoy-object rows. Drop the synthesized results
here once that's done.)*

## 24. POC #4 — Speaking / Voice Activity Detection

**Status: implemented. Awaiting manual test-matrix results.**

**Location:** [poc-04-speaking-vad/](poc-04-speaking-vad/) — same standalone,
unwired pattern as POC #1–3 (no build step, no backend). Run instructions in that
folder's README. **This is the first POC not built on MediaPipe** — worth flagging,
since POC #1–3 all shared one validated runtime and this one is a fresh integration.

**Question:** Can we reliably detect sustained candidate speech from the microphone
using an on-device VAD, with a low false-positive rate on background noise (typing,
room hum, coughs), without running any speech-to-text?

**Possible approaches considered:**

1. Energy-based VAD (Web Audio API amplitude/RMS thresholding) — zero dependencies,
   but historically noisy; background noise and taps commonly trigger it.
2. Silero VAD via `@ricky0123/vad-web` (ONNX model, WASM, on-device) — an ML-based
   VAD purpose-built to tell speech from noise, already the direction Section 10
   recommended.
3. Server-side Whisper/STT — already ruled out (Decision Log): we only need to know
   *that* someone is speaking, not *what*, and STT has real privacy/cost downsides
   for that job.

**Recommended approach:** Option 2, Silero VAD via `@ricky0123/vad-web`, using the
library's own built-in speech/silence smoothing (minimum-speech-length filter +
"redemption" grace period) rather than layering a second custom persistence state
machine on top — it already does that job. Energy-based thresholding is documented
here as the fallback if this CDN-based integration proves unworkable, not something
built in parallel.

**Trade-offs:**
- Silero should meaningfully reduce false positives from background noise compared
  to energy thresholding — the entire reason Section 10 pointed here.
- New runtime/CDN dependency separate from MediaPipe — real, not-yet-proven
  integration risk, unlike POC #1–3's shared and now-validated runtime.
- No transcription means this POC cannot distinguish "reading the exam question
  aloud" from "talking to someone off-screen" — accepted by design, STT escalation
  stays gated on this POC's results, not built preemptively.

**Risks/limitations:**
- Audio consent is a legal question distinct from video consent (Section 11) —
  flagged for legal review before this touches real candidate audio; fine as a
  controlled, self-tested prototype in the meantime.
- Multiple voices in the room, or speech from other rooms/devices (TV, music), may
  false-positive — untested until the matrix below is run.
- New dependency not yet validated in this environment — if it fails to load
  cleanly, that's a real finding for this POC, not just a bug to silently work around.

**Success criteria:**
- Reliable `SPEECH_SEGMENT` logging for sustained speech, with brief noise (coughs,
  taps) correctly discarded rather than logged or silently dropped without a trace.
- Low false-positive rate against common background noise (typing, hvac, music) with
  no one speaking.
- CPU/latency overhead measured, not assumed — this runs a different model family
  than POC #1–3's face/object detectors.

**Minimal implementation scope:** New `poc-04-speaking-vad/` folder, mic-only (no
camera), reusing the same UI shell/event-log/privacy pattern as POC #1–3 where it
still applies. Classifies only `SPEECH_SEGMENT` (logged) vs. discarded-too-short
(counted, not logged) — no transcription, no audio ever recorded or persisted, only
timestamp + duration per segment.

**Testing plan:** silence, normal speaking, quiet mumbling, background noise alone
(typing/music/hvac) with no speech, cough/sneeze, sustained speech, mid-sentence
pause (should not split into two segments), second voice in the room, distance from
mic, extended-run drift.

### POC #4 Results

*(Pending — same as POC #1–3, this needs a human to actually run the test matrix in
[poc-04-speaking-vad/README.md](poc-04-speaking-vad/README.md) with a real
microphone. Drop the synthesized results here once that's done.)*

## 25. POC #6 — Real-Time Events → Proctor Dashboard

**Status: implemented. Awaiting manual test-matrix results.**

**Location:** [poc-06-realtime-alerts/](poc-06-realtime-alerts/). Unlike POC #1–4,
this one needs an actual running process (`node server.js`), not just a static file
server — it's the first POC involving two separate clients (a candidate producing
events, a proctor dashboard consuming them) rather than a single self-contained tab.

**Note on sequencing:** POC #5 (screen capture, P2) was skipped in favor of this one,
since Section 3 flags real-time alerting as P0 infra — it's the plumbing that gets
POC #1–4's events in front of a human proctor, which is more foundational than
another detection signal.

**Question:** Can browser-side detection events reach a separate proctor dashboard
in near-real-time, with a human-in-the-loop review lifecycle (acknowledge →
confirm/dismiss/false-positive, per Section 13), at latency/schema/UX
characteristics that would transfer directly to a real ActionCable implementation
later?

**Possible approaches considered:**

1. ActionCable in a disposable Rails app (even with the in-process `async` adapter,
   no Redis needed) — most faithful to Section 7's actual recommendation, but a real
   step up in setup cost (new Ruby/Rails/Bundler toolchain) from every prior POC.
2. Plain Node.js + Server-Sent Events (built-in `http` module only) — zero
   dependencies, `node server.js` is the only thing to run.
3. Raw WebSockets via Node's `ws` package — closer to ActionCable's transport, but
   requires `npm install`, breaking the zero-install pattern kept so far.

**Recommended approach (and what was built):** Option 2. This POC's real question is
the event schema, the review lifecycle, and delivery latency — not whether
ActionCable-the-technology works, which is already a settled, low-risk call (Section
7) proven working today in qababoardweb. **ActionCable remains the documented target
for the real production integration** — this POC's schema and dashboard UX are meant
to carry over to that directly, not replace it.

**Trade-offs:**
- SSE is push-only (server→client); the candidate→server direction only needed a
  plain `POST`, so full bidirectional WebSockets weren't actually required for what
  this POC tests.
- In-memory event store only — restarting the server drops everything. Deliberately
  out of scope; persistence is POC #7's territory (evidence/history), not this one's.
- Choosing a stand-in technology means this POC cannot validate ActionCable-specific
  operational concerns (Redis pub/sub behavior, Rails boot time, its own reconnect
  behavior) — if those need validating before real integration, that's a distinct
  future exercise.

**Risks/limitations:**
- No auth on any endpoint (matches the "standalone, unwired" pattern) — real
  integration sits behind VerifyID-Portal's existing proctor auth/Pundit policies,
  not this POC's job to add.
- Concurrent-review races (two proctors acting on the same event at once) are
  handled by a server-side status check (loser gets a 409), but there's no polished
  conflict UI — a plain `alert()` for now.
- Latency is measured on localhost between two tabs on one machine — a baseline for
  the mechanism, not a real-network or real-candidate-hardware figure.

**Success criteria:**
- An event fired from the candidate page appears on the dashboard within a low,
  measured latency.
- The full review lifecycle works and rejects out-of-order actions (e.g. confirming
  before acknowledging).
- Two dashboard tabs open simultaneously both receive the same events and stay in
  sync, including when either one performs a review action.

**Minimal implementation scope:** `server.js` (in-memory store, `POST /events`, SSE
stream, `POST /events/:id/review`), `candidate.html`/`candidate.js` (one button per
POC #1–4 event type, simulated — not wired to a real camera/mic), and
`dashboard.html`/`dashboard.js` (live feed, latency display, review actions). No
database, no auth, no evidence capture.

**Implementation notes (what actually got built, verified by direct testing):**
- Functionally verified end-to-end via `curl` before handing off for manual/browser
  testing: `POST /events` creates and broadcasts correctly, the SSE stream delivers
  both the backlog (for a newly opened dashboard) and live `created`/`updated`
  events, and the lifecycle guard correctly rejected an out-of-order `confirm`
  before `acknowledge` with a 409. This is stronger pre-handoff verification than
  POC #1–4 could get (those need a real webcam/mic and a human in the loop from the
  start) — this POC's core mechanism doesn't.

### POC #6 Results

*(Pending — this needs a human to actually open two browser tabs and run the test
matrix in [poc-06-realtime-alerts/README.md](poc-06-realtime-alerts/README.md),
particularly the multi-tab sync and reconnect rows, which the `curl`-based
verification above couldn't exercise. Drop the synthesized results here once that's
done.)*

## 26. POC #7 — Evidence Rolling-Buffer Recording

**Status: implemented and core mechanism confirmed working by human testing** (real
playback, correct segment progression). Full test matrix (pre-roll/post-roll timing
precision, extended-run behavior, etc.) still pending.

**Location:** [poc-07-evidence-capture/](poc-07-evidence-capture/). Needs an actual
running process (`node server.js`), same as POC #6. **Saves real recorded video to
local disk** — the first POC in this track to do so; see its README's warning
before running it.

**Question:** Can we maintain a rolling in-memory video buffer, and — only when a
proctoring alert fires — save a short clip (a few seconds before and after the
trigger) to storage, without continuously recording or uploading the entire
session? This is exactly the architecture Section 10 proposed; this POC exists to
prove the mechanism actually works, not just assume it does.

**Possible approaches considered:**

1. `MediaRecorder` with a manually-managed rolling chunk buffer (1s timeslices,
   evicting chunks older than the pre-roll window until a trigger freezes it) —
   what Section 10 specifies, standard and broadly supported.
2. Periodic canvas frame grabs (a low-res image flipbook instead of real video) —
   simpler, but not faithful to an actual video-evidence requirement.
3. WebCodecs API for frame-level buffering control — more powerful, but more
   complex than this question needs.

**Recommended approach (and what was built):** Option 1.

**Why a local folder, not real S3:** Section 7 already recommends S3 for evidence
storage. Actually wiring real S3 into an R&D prototype means handling real AWS
credentials and real cost — a materially bigger step than anything else in this
track, and not something to do without a separate, explicit decision. What this POC
needs to prove (rolling capture works, the clip is centered on the trigger, upload
happens only on a confirmed event, not continuously) doesn't depend on which storage
backend receives the file. A local folder via a small Node server (same
zero-dependency pattern as POC #6) answers those questions directly. **S3 remains
the documented target for real production storage**, unchanged by this choice.

**Trade-offs:**
- Clip boundaries snap to ~1-second chunk boundaries — "5 seconds before" is
  approximate, not frame-exact.
- Overlapping trigger clicks are ignored, not queued — kept out of scope.
- No persistent metadata index (resets on server restart, though clip files remain
  on disk) — acceptable for a POC, not for production.

**Risks/limitations:**
- No retention/TTL enforcement (Section 11 flags this as needed before production;
  this repo already has a `SelfieRetentionPurgeJob` precedent to follow) — this POC
  relies on manual clearing via the UI's "Clear all clips" button.
- Video only, no audio — avoids requiring mic permission on top of camera
  permission; POC #4 already covers audio separately.
- Real recorded video touching local disk is new territory for this repo — the
  `clips/` folder was added to `.gitignore` before any code that could write to it
  was written, specifically to prevent an accidental commit of test recordings.

**Success criteria:**
- A captured clip visibly shows the moments before and after the trigger click, not
  just the instant itself.
- Clicking "simulate" before the buffer has filled produces a shorter-than-requested
  pre-roll rather than an error — this is the same "was there enough history
  buffered yet" question a real deployment needs an answer to.
- Clear-all removes both the in-memory listing and the actual files on disk.

**Minimal implementation scope:** `server.js` (in-memory metadata + files on disk
under `clips/`, `POST /evidence`, `GET /evidence`, `GET /clips/:file`,
`DELETE /evidence`) + `index.html`/`app.js` (real camera, rolling `MediaRecorder`
buffer, simulate-alert buttons standing in for POC #1–4's real detectors — not
re-wiring real detection, this POC only tests the recording mechanism).

**Implementation notes (what actually got built, verified by direct testing):**
- Functionally verified the entire server-side API before handing off the
  camera/browser part: uploaded a synthetic binary "clip," confirmed it round-trips
  byte-for-byte through `GET /clips/:file`, confirmed `GET /evidence` lists it
  correctly, and confirmed `DELETE /evidence` removes both the in-memory record and
  the actual file from disk. What this couldn't verify — real buffer timing, clip
  centering around a trigger, and real webcam behavior over an extended run — needs
  an actual browser and webcam, same limitation as POC #1–4.
- **Real bug found during human testing, fixed:** the first version used one
  continuous `MediaRecorder` with a 1-second timeslice, evicting old chunks to
  bound memory. This produced unplayable clips — only the very first chunk of a
  recording session contains the WebM container header, so once that chunk aged out
  of the buffer, every subsequent captured clip was a headerless, broken fragment.
  It looked fine in the size/latency metrics (those never touch the actual video
  bytes), which is exactly why the `curl`-based pre-handoff verification above
  didn't catch it — it never exercised real video encoding, only the file-transfer
  mechanics. Fixed by restarting `MediaRecorder` every second so each segment is
  independently valid, and playing a clip back as a sequence of segments rather
  than one concatenated file (see the POC's README for the full explanation). This
  is a concrete example of why the "human runs the real test matrix" step in this
  R&D process (Section 21) is load-bearing, not a formality — no amount of API-level
  verification would have surfaced this.
- **Second issue found during the same human testing pass, confirmed cosmetic-only:**
  even after fixing the header issue above, segments displayed "0:00" with a
  fully-filled progress bar — a separate, well-known `MediaRecorder` quirk where
  Chrome doesn't write a valid duration into a WebM file's header on normal stop.
  Attempted a fix via `fix-webm-duration` (a small CDN-loaded library patching the
  container's binary Duration field), which does not reliably correct the label for
  these short (~1s) segments — it silently no-ops on some structural mismatch. The
  important question, though, is answered: the human tester confirmed actual
  playback and segment-to-segment progression work correctly regardless of the
  displayed duration, which is what this POC needs to validate. Left as a documented
  cosmetic limitation rather than pursued further — chasing exact WebM/EBML binary
  internals for a scrubber label isn't proportionate once the underlying mechanism
  is confirmed working. Both issues are documented in the POC's own README.

### POC #7 Results

**Confirmed (2026-09-23):** real playback works and correctly progresses through all
segments of a captured clip (tested with a `PHONE_DETECTED` simulated alert, 9
segments, 2.45MB). Two bugs were found and addressed during this pass — see
"Implementation notes" above (unplayable clips from header eviction — fixed and
confirmed; "0:00" duration display — cosmetic only, playback unaffected).

*(Still pending: the rest of the test matrix — pre-roll/post-roll timing precision,
decoy/edge-case scenarios, extended-run behavior. Drop those results here once
that's done — and clear your local `clips/` folder once you're done testing.)*

## 27. POC #5 — Screen Capture / Live Proctor Viewing

**Status: implemented. Core mechanism verified by automated browser runs (headless
Chromium). The manual test matrix is still pending: real OS picker, real
multi-monitor, macOS permission flow, Firefox/Safari/Edge/Windows, real network.**

**Location:** [poc-05-screen-capture/](poc-05-screen-capture/). It needs
`node server.js`, like POC #6/#7. It records nothing: video goes peer-to-peer and never
touches the server.

**Question:** Can a candidate share their **entire screen** from an ordinary desktop
browser, and can a proctor watch it **live** with low latency and modest bandwidth?
And can the proctor be told immediately when sharing stops, the wrong surface is
picked, or a second monitor is present?

### Research

**The browser primitive.** `navigator.mediaDevices.getDisplayMedia()` is the only
way a web page can capture the screen. It always shows a browser/OS picker, it
needs a user gesture and a secure context (HTTPS/localhost), and the browser shows
a sharing indicator the page can't hide. What the page can and can't control:

| Control | Chrome / Edge | Firefox | Safari (macOS) |
|---|---|---|---|
| Hint "entire screen" (`displaySurface: "monitor"`) | Yes, pre-selects the pane | Own picker | **Ignored.** Safari moved to the macOS system picker ([mdn/content#42218](https://github.com/mdn/content/issues/42218)) |
| Hide the current tab / tab-switch button (`selfBrowserSurface`, `surfaceSwitching`, `monitorTypeSurfaces`) | Yes (Chrome-only options, [Chrome docs](https://developer.chrome.com/docs/web-platform/screen-sharing-controls)) | Ignored | Ignored |
| **Verify what was actually picked** (`track.getSettings().displaySurface`) | Yes, **this is the enforcement point** | Reported per MDN (to confirm in manual test) | To confirm in manual test |
| Know another monitor exists (`screen.isExtended`, no prompt) | Yes (Window Management API) | No | No |
| List monitors (`getScreenDetails()`, permission prompt) | Yes | No | No |
| Capture *all* monitors at once (`getAllScreensMedia()`) | Only managed ChromeOS / Isolated Web Apps with admin policy ([intent](https://groups.google.com/a/chromium.org/g/blink-dev/c/HtBrZ9r_ZHU)), **not usable for BYOD candidates** | No | No |
| Mobile (iOS/Android) | Not supported, so candidates need a desktop/laptop | | |

The spec itself is still a Working Draft ([W3C Screen Capture](https://www.w3.org/TR/2026/WD-screen-capture-20260827/)).
Chrome is the main implementer of the newer controls.

**OS-level permissions.**
- **macOS:** the browser needs Screen Recording permission (System Settings →
  Privacy & Security). The first grant needs a browser relaunch. macOS 15 (Sequoia)
  added periodic re-confirmation prompts for screen-recording apps, now monthly
  ([9to5Mac](https://9to5mac.com/2024/08/14/macos-sequoia-screen-recording-prompt-monthly/),
  [MacRumors](https://www.macrumors.com/2024/08/15/macos-sequoia-screen-recording-app-permissions/)).
  Whether and when this hits browsers mid-exam needs manual confirmation. Missing
  permission surfaces as a generic `NotAllowedError`, the same error as the
  candidate clicking Cancel. **This is the #1 onboarding risk**, and it feeds POC #8
  directly.
- **Windows:** no OS permission is needed.
- **Managed devices:** Chrome enterprise policy (`ScreenCaptureAllowed`) can block
  capture entirely.

**Viewing and recording approaches considered:**

1. **`getDisplayMedia` + WebRTC peer-to-peer to the assigned proctor.** Signaling
   goes over the push channel we already have (POC #6 → ActionCable). Lowest latency,
   no media servers, and media is DTLS-SRTP encrypted end to end, so our servers never
   see screen content. Needs a TURN server in production. Each extra viewer costs the
   candidate a full extra encode and upload. **What was built.**
2. **`getDisplayMedia` + self-hosted SFU** (LiveKit OSS, mediasoup, Janus). The
   candidate uploads once and any number of proctors or supervisors can watch.
   Server-side recording is possible. Costs: a media server to run and scale, and the
   SFU terminates DTLS, so it *can* see screen content unless E2EE (insertable
   streams) is added.
3. **Managed WebRTC platform** (LiveKit Cloud, Daily, Twilio Video, Agora, Amazon
   Chime SDK / IVS real-time). Buys option 2 as a service, with per-participant-minute
   pricing. These are transport vendors, not proctoring vendors, but candidate screen
   video would still transit a third party (Section 11).
4. **Periodic screenshots** (grab a frame from the capture track every N seconds and
   upload a JPEG). Very cheap, needs no TURN, and gives an easy audit trail, but it's
   not live. A strong **complement** for evidence, not a replacement for live viewing.
5. **Continuous screen recording upload** (MediaRecorder → S3 for the whole exam).
   The most storage, bandwidth, and privacy exposure. It contradicts the
   data-minimization stance (Section 11) and POC #7's rolling-buffer design. Not
   recommended; apply POC #7's rolling buffer to the screen track instead.
6. **Status quo: candidate shares their screen into Google Meet.** It works today,
   but it can't enforce entire-screen, raises no events, has no integration with our
   alert/review pipeline, and the proctor must watch it continuously.
7. **Lockdown browser / Safe Exam Browser / native agent.** A different category:
   it *prevents* rather than *observes*. SEB may make screen viewing partly redundant,
   or may block `getDisplayMedia` inside its kiosk. This is still Open Question #1.

**Build vs buy (screen viewing only):**

| | P2P WebRTC (build) | Self-hosted SFU | Managed WebRTC | Proctoring vendor |
|---|---|---|---|---|
| Latency | Lowest (measured ~25–65 ms localhost) | Low (+1 hop) | Low | Varies |
| Infra to run | Signaling (have it) + TURN | SFU cluster + TURN | None | None |
| Multiple viewers per candidate | Poor (mesh, measured) | Good | Good | Good |
| Server-side recording | No | Yes | Yes | Yes |
| Who can see screen content | Only the proctor's browser | Our SFU | Vendor | Vendor |
| Cost | TURN bandwidth only | Servers + ops | Per-minute | Per-exam licence |

**Is remote control necessary? No, and it isn't recommended.**
- `getDisplayMedia` is view-only by design. A web page can't inject input into the
  candidate's machine, so remote control would mean installing a **native agent**
  (remote-desktop style).
- A native agent is a far larger security, consent, and support burden: an
  installer, OS accessibility permissions, a remotely controllable endpoint on
  candidate machines, and liability for anything it does.
- Nothing in the brief needs the proctor to *operate* the candidate's machine. The
  things a proctor actually needs to do (warn, ask to close an app, pause the exam)
  are communication and exam-state actions, not input control.
- This matches the existing Section 10 position.

### Recommended approach (and what was built)

Option 1, with these specifics:
- **Enforce entire screen by verification, not by request.** Send the hints, then
  check `getSettings().displaySurface === "monitor"`. Reject and log `WRONG_SURFACE`
  otherwise. Treat `unknown` as `SURFACE_UNVERIFIED`, not a pass.
- **Text-first encoding:** `contentHint = "detail"`,
  `degradationPreference = "maintain-resolution"`, low frame rate (default 5 fps),
  a resolution cap of 1920 wide, and a bitrate cap per profile, changeable live via
  `RTCRtpSender.setParameters`.
- **Screen events are the main product, not the video.** `SCREEN_SHARE_STOPPED`,
  `WRONG_SURFACE`, `MULTIPLE_MONITORS`, and `MONITOR_CONFIG_CHANGED` use the same
  event shape as POC #6 (`event_type` / `detail` / `client_sent_at`), so they drop
  straight into the `AiEvent` review lifecycle. Live video is what the proctor opens
  *when* an alert fires, instead of watching everyone all the time. That's the same
  "reduce proctor load" goal as Section 2.
- **Signaling over the existing push channel.** It's SSE in the POC and ActionCable
  in production (Section 7). No new transport.

### Proposed production architecture (not approved — see Decision Log)

```
qababoardweb exam-hosting page (candidate)            VerifyID-Portal (proctor)
  ├─ exam iframe (untouched)                            Proctor dashboard
  └─ Proctoring client                                    ├─ POC #6 alert feed
       ├─ getDisplayMedia (entire screen, verified)       ├─ screen tiles (on demand / on alert)
       ├─ screen events ──► ActionCable ──► AiEvent ──►   └─ review lifecycle (Section 13)
       ├─ WebRTC offer/answer/ICE ──► ActionCable (authz: proctor assigned to session)
       └─ WebRTC media ══► TURN (coturn/managed, TLS 443) ══► proctor browser
            (P2P when possible; relayed via TURN otherwise; never decrypted server-side)
       └─ (later) POC #7 rolling buffer applied to screen track → clip on alert → S3
```

**SFU trigger conditions.** Move from P2P to an SFU (LiveKit OSS first, since it's
Apache-2.0 and self-hostable) only if one of these becomes a requirement: more than
one simultaneous viewer per candidate, server-side screen recording, or a proctor
download budget exceeded at real cohort sizes.

### Results (automated runs, 2026-09-23)

Setup: Playwright 1.63 driving headless Chromium, M1 Pro, everything on `localhost`.
There were two sources:
- **Chromium's fake "screen" device**, a full-motion test pattern that reports
  `displaySurface: "monitor"`.
- **An injected synthetic 1920×1080 "exam screen"**: 44 lines of 18px question text,
  a ticking timer, and the latency probe painted in.

Latency is **glass-to-glass**, measured by decoding a timestamp painted into the
shared content out of the *received* frames. It covers encode, network, decode, and
render, but excludes the OS screen-capture step, which the manual matrix measures
with real capture.

**Bandwidth and latency per profile (1 candidate → 1 proctor):**

| Content | Profile | Upload | Received | FPS | Glass-to-glass (median) |
|---|---|---|---|---|---|
| Static exam text | Low (1 fps, 300 kbps, ≤1280) | 131 kbps | 1280×720 | 1 | n/a (1 sample) |
| Static exam text | Balanced (5 fps, 1 Mbps, ≤1920) | ~100 kbps | 1920×1080 | 5 | **~23–26 ms** |
| Static exam text | High (15 fps, 2.5 Mbps) | ~145 kbps | 1920×1080 | 15 | ~34 ms |
| Continuous scrolling | Low | 229 kbps | 1280×720 | 1 | ~150 ms |
| Continuous scrolling | Balanced | 927 kbps | 1920×1080 | **1** (starved) | **~450 ms** |
| Continuous scrolling | High | 1.8 Mbps | 1920×1080 | 14 | ~67 ms |
| Fake device (full motion) | Low / Balanced / High | 49 / 201 / 507 kbps | | 1 / 5 / 15 | |

**Mechanism and robustness:**

| Scenario | Result |
|---|---|
| Click "Share" → first decoded frame on proctor (picker auto-accepted) | 346–354 ms; ICE connect ~17 ms on localhost |
| Wrong surface (monitor required) | Fake device always reports `monitor`, so the rejection path is **not yet exercised with a real window/tab pick** (manual matrix) |
| Stop via page button → proctor notified | 31–35 ms |
| Browser "Stop sharing" (track `ended`) → proctor notified | 16 ms |
| Candidate tab closed → `CANDIDATE_DISCONNECTED` on proctor | 17–20 ms |
| Proctor page refresh mid-share → video back | 215–222 ms (backlog + auto re-request) |
| **Signaling server killed mid-share** | **Video kept flowing** (95 KB received in 5 s with the server down). After restart, the stream continued uninterrupted and new events were delivered (after the fix below) |
| Second proctor viewing the same candidate | Candidate upload roughly doubled (≈200 → 390–440 kbps) and **encode time per frame went from ~4 ms to 37–49 ms**: one encoder per connection |
| 4 candidates → 1 proctor (Balanced, static) | All live at 5 fps, **185 kbps total download**, decode 1.1–1.7 ms/frame per stream |
| 6–16 candidates → 1 proctor | **Not valid.** All candidate encoders ran inside one headless browser on one machine and stalled (encode 0.7–12 s per frame) while overall CPU stayed low, which points to headless throttling. This says nothing about proctor-side capacity. Needs candidates on separate machines (manual matrix) |
| Legibility of received frames | 18px exam text is clearly readable at Low (1280×720) and Balanced (1080p) |

**Problems discovered:**

1. **A signaling reconnect tore down healthy video (fixed).** After a server restart,
   the proctor's fresh backlog didn't yet include the candidate, so the proctor
   closed a working peer connection. Fixed by never tearing down a live media
   connection because of signaling state. **Architecture implication:** the media
   plane and the signaling plane must be decoupled. An ActionCable reconnect (deploy,
   Redis blip) must not reset screen viewing.
2. **Bitrate cap plus maintain-resolution collapses under motion.** At Balanced
   (1 Mbps), continuous scrolling dropped to 1 fps with ~450 ms latency: the encoder
   keeps full resolution and starves the frame rate. That's fine for static exam
   pages, which are the normal case, but production should adapt. Options: raise the
   cap briefly on sustained motion, or switch `degradationPreference` to `balanced`
   when the proctor opens the tile full screen.
3. **Screen content is extremely cheap when static.** 1080p exam text costs about
   100–150 kbps at *any* profile, because the encoder only sends changes. Bandwidth
   isn't the constraint for typical exam pages. Motion (scrolling, video) is.
4. **The P2P mesh doesn't scale per candidate.** Every additional viewer is another
   full encode on the candidate's (possibly low-end) laptop. One assigned proctor is
   fine; a supervisor "also watching" needs an SFU.
5. **SSE hits the HTTP/1.1 limit of 6 connections per origin.** With one SSE stream
   per tab, a 7th tab of the same origin in one browser profile hangs. This also
   affects POC #6's design if a proctor opens many tabs. ActionCable (a single
   multiplexed WebSocket) avoids it; so does HTTP/2.
6. **Cancel and missing OS permission can't be told apart.** Both surface as
   `NotAllowedError`. Onboarding (POC #8) has to explain the macOS permission path
   proactively.
7. **Chromium's fake capture device feeds only one consumer at a time.** This is a
   test-harness note: multi-candidate automated runs need an injected synthetic
   source.
8. **"Infinite mirror."** When the proctor window is itself on the shared screen,
   nested copies appear. The latency decoder handles this by using the largest probe.
   In practice proctor and candidate are different machines.
9. **A code bug in the POC (fixed):** `pc.getStats(sender)` isn't valid (it takes a
   track), and the error was silently swallowed, so the candidate's upload metric
   read zero. It now uses `sender.getStats()`.

**Multiple monitors: what the platform allows:**
- A single `getDisplayMedia()` call captures **one** surface, and the candidate
  chooses which. A candidate can share monitor A and use monitor B.
- Detection is possible in Chromium without a prompt (`screen.isExtended`, plus the
  `change` event for mid-exam plug-in), and with a prompt we get the count and labels
  (`getScreenDetails()`). The POC implements both.
- Blind spots: mirrored displays, a second device (tablet/laptop), and non-Chromium
  browsers.
- Capturing all monitors isn't available to BYOD web pages.
- **Recommendation:** a single-monitor policy, a `MULTIPLE_MONITORS` alert when
  `isExtended` is true (at share start and on change), and webcam head-turn signals
  (POC #2) for the off-screen case. Don't try to capture every monitor.

**Privacy and security:**
- Entire-screen sharing exposes *everything* on that screen: notifications, messages,
  other apps, and potentially third parties' personal data. Candidates must be told
  to close other apps and silence notifications. Consent language needs legal review
  alongside Section 11's biometric and audio items. The page shows "N proctors
  viewing", on top of the browser's own indicator.
- **Authorization is the critical gap.** The POC has none: any page can claim to be
  a proctor and request a screen. In production, view requests must be issued by the
  server for an authenticated proctor who is assigned to *that* exam session (Pundit
  policy). The candidate client should accept only server-brokered requests.
- The P2P + TURN design means screen video is never decrypted on our infrastructure.
  TURN relays encrypted SRTP. An SFU or managed vendor changes that property, which
  is a real input to the SFU decision.
- Nothing is recorded by default. If screen evidence clips are added (POC #7
  pattern), they need the same short TTL / `SelfieRetentionPurgeJob`-style purge.

**Success criteria:**

| Criterion | Status |
|---|---|
| Candidate can share entire screen; proctor sees it live | ✅ (automated, fake monitor source) |
| Wrong surface (window/tab) rejected | ⏳ implemented, needs real picker (manual) |
| Proctor notified immediately when sharing stops | ✅ 16–35 ms |
| Low latency | ✅ ~25 ms glass-to-glass on localhost for static content; real-network figure pending |
| Modest bandwidth | ✅ ~100–200 kbps for exam text at 1080p |
| Proctor can read exam text | ✅ at Low and Balanced |
| Multi-monitor detection | ⏳ implemented, needs a real second monitor (manual) |
| Survives signaling outage | ✅ (after fix) |
| Works across browsers / macOS permission flow / real networks | ⏳ manual matrix |

## 28. POC #8 — Practice / Onboarding Simulator

**Status: planned 2026-09-29 (this section, written before implementation).
Implementation and results are recorded in Section 28.9 onward.**

**Location:** [poc-08-onboarding-simulator/](poc-08-onboarding-simulator/).

**Question:** Can a candidate, unaided and before exam day:
1. prove their browser, camera, microphone and screen sharing work;
2. learn the exam rules from **approved, deterministic** content in English or Arabic;
3. experience what the AI flags and what happens next (a person reviews it)?

If so, proctors no longer have to walk each candidate through setup live on Google
Meet. That's the onboarding load in Section 2, and it's heaviest for Arabic-speaking
candidates.

### 28.1 What POC #1–#7 already give us

| POC | Validated capability | How POC #8 reuses it | Change needed |
|---|---|---|---|
| #1 | Face count / out-of-frame / too-far, 1.5 s raise / 0.8 s clear persistence | Camera-setup guidance and the `FACE_MISSING` / `OUT_OF_FRAME` / `MULTIPLE_FACES` nudges in the mock exam. Same thresholds | Applied to the Face Landmarker's box instead of BlazeFace's, so one face model runs instead of two (decision D2) |
| #2 | Face Landmarker + facial transformation matrix → yaw/pitch/roll; calibration; 20°/15° thresholds | `LOOKING_AWAY` in the mock exam | Calibration averages about 2 s of samples and checks they're stable. POC #2 used a single-frame snapshot, which was a known limitation |
| #3 | EfficientDet-Lite0 `cell phone` class | Optional "show a phone" demo in the mock exam | Loaded only when needed and throttled to ~4 Hz so it doesn't starve the face model |
| #4 | Silero VAD (`vad-web` 0.0.31), 0.5/0.35, 400 ms / 1400 ms, the CDN asset-path fix | Microphone check (quiet baseline, then read a sentence aloud) and the speaking nudge | The page opens the mic itself, so it can report *which* error happened, and hands the stream to VAD (`getStream`) |
| #5 | `getDisplayMedia` hints, then verifying `displaySurface === "monitor"`; `screen.isExtended`; `NotAllowedError` is ambiguous | Screen-share check with `WRONG_SURFACE` feedback and a macOS walkthrough | Nothing is transmitted: the share is shown locally, then stopped |
| #6 | Event shape (`event_type`, `detail`, `confidence`, `session_id`, `client_sent_at`); `ALERTED → ACKNOWLEDGED → …` lifecycle | The readiness report uses the same shape. The mock exam shows the candidate an example proctor alert card | None |
| #7 | Rolling-buffer evidence clips | **Not reused on purpose.** Practice records nothing | — |

New in POC #8 (not covered by any earlier POC): a lighting heuristic, "move
left / closer / tilt" framing hints, the step state machine, the bilingual content
model, and resuming after a browser relaunch.

### 28.2 Research: how onboarding is done elsewhere

- **Pearson OnVUE** runs a separate *system test* on the same computer and location
  as exam day. It then re-checks at check-in, where the candidate takes a face photo,
  photographs the ID front and back, takes four workspace photos (front, back, left,
  right), and must unplug extra monitors. There's an exam tutorial before the exam
  starts ([Pearson VUE online testing guide](https://wwwhtbprolpearsonvuehtbprolcom-s.evpn.library.nenu.edu.cn/content/dam/VUE/vue/en/documents/onvue/pearson-vue-online-testing-guide-en.pdf),
  [NES OnVUE tips](https://docs.nesinc.com/COMMON/TipsOnTakingAnOnVUEExam.pdf),
  [APA OnVUE FAQ](https://payroll.org/education-certification/certification/onvue/)).
- **Honorlock** offers an unlimited-use practice test that covers the system check
  (webcam, mic, internet), authentication and a practice room scan. The room scan is
  360°, including the work surface and what's behind the computer
  ([Univ. of Iowa guide](https://distance.uiowa.edu/exams/honorlock-students),
  [UT Dallas FAQ](https://ets.utdallas.edu/testing-center/honorlock/honorlock-faqs-and-instructions-for-students-3)).
- **Anxiety:** vendors report that anxiety is highest on a candidate's *first*
  remote-proctored exam and falls on later ones, and that worry about technology is
  a main driver ([Honorlock survey](https://honorlock.com/blog/student-survey-to-learn-how-to-reduce-test-anxiety/),
  [ProctorExam poster](https://proctorexam.com/wp-content/uploads/2020/02/OP4RE_A0-Anxiety-Poster-vFinal.pdf)).
  These are vendor sources, so treat them as a direction, not independent evidence.
  Still, a practice run is the cheapest way to make exam day a candidate's "second"
  run.
- **Runtime LLMs and policy.** In *Moffatt v. Air Canada* (BC Civil Resolution
  Tribunal, Feb 2024), an airline's chatbot invented a bereavement-refund rule and
  the airline was held liable for it. The tribunal said it "makes no difference
  whether the information comes from a static page or a chatbot"
  ([AI Business](https://aibusiness.com/nlp/air-canada-held-responsible-for-chatbot-s-hallucinations-)).
  An exam board that lets an LLM paraphrase exam rules takes on the same risk, and
  would be taking it in two languages.
- **RTL:** set `dir`/`lang` on `<html>`, use CSS logical properties
  (`margin-inline-start` and so on), and isolate mixed-direction runs such as event
  codes and numbers inside Arabic text with `<bdi>`
  ([W3C bidi techniques](https://www.w3.org/TR/2009/WD-i18n-html-tech-bidi-20090714/),
  [CSS Writing Modes 3](https://www.w3.org/TR/css-writing-modes-3/)).
- **Arabic digits are a product decision, not a default.** Measured in Node 22 ICU:
  `ar` and `ar-AE` format `1234.5` as `1,234.5`, but `ar-SA` and `ar-EG` give
  `١٬٢٣٤٫٥`. Browsers have changed these defaults between versions too
  ([Apple forum](https://developer.apple.com/forums/thread/773692)). POC #8 pins the
  numbering system explicitly in the content file.

### 28.3 Approaches compared

| Approach | What it is | Strengths | Weaknesses | Risk of wrong policy | Verdict |
|---|---|---|---|---|---|
| **A. Deterministic workflow** | Checklist state machine: each step has a pass condition, a fix hint and a skip | Predictable, auditable, easy to translate and review, unit-testable, and gives the same answer every time in both languages | Passive. Reading rules isn't the same as understanding what triggers an alert | None: the text is exactly what was approved | **Backbone** |
| **B. Interactive tutorial** | The candidate *does* things and sees live detector feedback: "turn your head", "say this sentence" | Teaches by doing and reuses POC #1–#5 directly. Problems show up in context ("your room is too dark") | Heavier client (2–3 models plus VAD). A false positive during practice can confuse | Low, as long as the copy is deterministic | **Embed in A's steps** |
| **C. AI assistant (LLM chat)** | Free-text Q&A, possibly multilingual | Flexible, handles unexpected questions, natural in Arabic | Can invent or soften rules (the Air Canada precedent). Answers may differ between EN and AR. Needs a server and an LLM vendor, so candidate text goes to a third party. Prompt injection. Can't be tested exhaustively. Latency and per-candidate cost | **High** | **Not at runtime.** Possibly later as retrieval-only FAQ search that refuses and escalates when unsure. AI is useful at *authoring* time, for drafting translations a human then reviews |
| **D. Guided mock exam** | A short fake exam with a timer while the detectors run | Closest to exam day, reduces first-time anxiety, and shows nudges and alerts in a realistic setting | Needs sample content. Must be clearly marked *practice* and never scored | Low, if the questions are about the process rather than exam content | **Final step** |
| **E. Hybrid (A + B + D)** | A as the spine, B inside the setup steps, D at the end, all copy from versioned content files | Combines the strengths above and keeps policy text deterministic | The most code of the non-LLM options | Low | **Recommended** |

### 28.4 Recommended architecture (what POC #8 builds)

```
poc-08-onboarding-simulator/  (static files; python3 -m http.server)
  content/en.json, content/ar.json   ← the ONLY source of candidate-facing text:
      meta (content_version, policy_status, dir, number locale), ui strings,
      step copy, rules[], nudges{}, proctor_alerts{}, error fixes, practice questions
  logic.js    ← pure, unit-tested: step machine, persistence/hysteresis, framing
                and lighting classification, pose + calibration, readiness, report
  media.js    ← browser wrappers: camera, Face Landmarker, Object Detector, lighting
                sampler, mic + level meter + VAD, getDisplayMedia check
  app.js      ← renders steps from content, wires media → logic → UI
  tests/      ← node --test (logic + content parity) and an optional Playwright e2e

Candidate browser (all on-device)                          nothing is uploaded
  Welcome → Device → Camera → Microphone → Screen → Rules → Practice → Summary
                 │          │           │                       │
      Face Landmarker   Silero VAD   getDisplayMedia     + Object Detector (lazy)
                                                                     │
                     readiness report (JSON, POC #6 event shape, no media) ──► download
                     (production: POST to the proctoring backend → dashboard "ready / needs help")
```

### 28.5 Decisions made for this POC

| # | Decision | Why |
|---|---|---|
| D1 | Hybrid (E). All candidate-facing text comes from versioned content files. **No runtime LLM** | Exam rules must be exactly what the exam owner approved, identical in both languages (Section 28.2) |
| D2 | One Face Landmarker (`numFaces: 2`) provides count, box *and* pose, replacing POC #1's separate Face Detector | Fewer models to run on low-end laptops. Answers the consolidation question left open in Section 22. Multiple-face detection has to be re-validated on this model (test: two-person video). **Re-validation failed; see 28.10 F6. Now "Revisit"** |
| D3 | Practice records and uploads nothing. The only output is a JSON readiness report (statuses and error codes, no images or audio) in the POC #6 event shape | Data minimisation (Section 11). No new consent surface is needed for a practice run |
| D4 | Every technical check can be skipped and is then recorded as "needs help". Only the rules acknowledgement is required | The Degradable NFR (Section 4): never lock a candidate out; hand them to a human |
| D5 | The candidate sees plain-language **nudges only**, never angles, confidence scores or thresholds | Showing numbers would teach candidates how to stay under the thresholds and adds anxiety. The proctor side keeps the numbers |
| D6 | Setup guidance uses a *stricter* "ideal framing" band than the exam alert thresholds | Setup should aim for the middle of the acceptable range, so that small movements during the exam don't trigger alerts |
| D7 | English and Arabic in the POC. The Arabic copy is **drafted by the assistant** and marked `machine-drafted, needs review` in `meta` | Tests the RTL/i18n mechanics now. Real candidates need text reviewed by a qualified bilingual reviewer (risk R1) |
| D8 | Rules text is **placeholder policy** (`policy_status: "DRAFT — not approved"`) and is shown as such in the UI | We don't have the exam owner's actual rules. Inventing them silently would be the exact problem D1 exists to prevent |
| D9 | The number locale is pinned to Latin digits for Arabic (`ar-u-nu-latn`) | Same digits as the (black-box) exam engine most likely shows. Configurable in `meta`. Open Question #10 |
| D10 | Static page, no Node server | Nothing needs to be sent anywhere in the POC. Integrating with the backend is a documented next step |

### 28.6 Scope

**In:**
- EN/AR with RTL, and a language switch at any point.
- Device/browser check.
- Camera: permission errors mapped to fixes; framing and lighting guidance with
  direction hints; a 3 s "hold good position" check that doubles as pose calibration.
- Microphone: permission errors; level meter; quiet baseline; read a sentence aloud.
- Screen: entire-screen share verified; wrong surface, cancel/permission and second
  monitor explained; the macOS walkthrough.
- Rules: allowed/prohibited items and behaviour rules; an environment self-checklist
  (desk, room, ID ready, monitors, notifications); an optional timed room-scan
  practice; a system FAQ; a required acknowledgement.
- Practice: 3 process questions, a timer, live nudges, "try it" challenges, and an
  example proctor alert with the "a person reviews this" explanation.
- Summary: ready / ready with warnings / needs help, fix hints, JSON report.
- Progress saved in `localStorage`, so the macOS "quit and reopen" doesn't lose it.

**Out:** real exam content; scoring; ID capture or verification (VerifyID-Portal
already does this, and the practice only explains it); a room-scan *analysis*; a
network/TURN test (no TURN exists yet, Open Question #9); sending the report to a
server; auth; accommodations handling; a proctor-side view; any LLM.

### 28.7 Risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | Arabic copy is machine-drafted, with possible errors or an inappropriate register for formal exam instructions | Marked in `meta` and in the UI. A qualified reviewer must approve before candidates see it. The content-parity test guarantees both languages have the same rules and placeholders |
| R2 | Placeholder rules are mistaken for real policy | `DRAFT` banner in the UI, driven by `meta.policy_status` |
| R3 | A detector misfires during practice ("it says I'm looking away but I'm not") and *raises* anxiety | Calm nudge copy. An explicit "brief moments are normal; a person reviews every alert" message. Practice-only extra explanation |
| R4 | Practice teaches candidates how to evade detection | No numbers shown (D5). Nudges only say what to fix, not where the threshold is |
| R5 | Setup passes in practice but the environment differs on exam day (different room or device) | Copy says to use the same computer and room, like OnVUE. Production should re-run the quick checks at exam start |
| R6 | Models load from public CDNs (jsDelivr, storage.googleapis.com). Corporate or national networks may block them | The device step shows a "couldn't load" failure. Production should self-host the model and WASM files |
| R7 | Three inference engines in one tab overload low-end laptops | Phone detector loaded lazily and throttled. FPS measured per step (28.10) |
| R8 | `NotAllowedError` can't be told apart from Cancel vs missing macOS permission (POC #5 finding) | Show both fixes. On macOS, show the permission path before the first attempt |

### 28.8 Success criteria and test plan

| Criterion | How it's tested |
|---|---|
| Happy path completes and yields "ready", in EN and AR | Playwright e2e, fake camera (real face video) + fake mic (TTS speech) + fake screen |
| Each failure mode is detected and explained with a fix: camera denied, camera busy, no face, two faces, too dark, mic silent, screen cancelled/denied (macOS walkthrough shown), window shared instead of screen, second monitor | e2e with Chromium fake devices plus stubbed `getUserMedia`/`getDisplayMedia`/`screen.isExtended` |
| The mock exam shows the nudge *and* the proctor-alert explanation for face missing, speaking, and looking away | e2e (face video that pans away; speech in the audio file). Looking-away and phone need a real person (manual) |
| RTL layout is correct; no untranslated strings; same rules in EN and AR | Content-parity unit test plus screenshots of every step in AR |
| Nothing is uploaded | e2e records every network request and asserts that only static assets are fetched (GETs) |
| Survives reload / browser relaunch mid-flow | e2e reloads at the screen step and expects a resume at the same step |
| Readiness report is accepted by POC #6's `POST /events` unchanged | e2e posts the downloaded report to a running POC #6 server |
| Runs in real time with face + VAD (+ phone) | FPS/inference time recorded per step (headless CPU is a lower bound; laptop numbers in the manual matrix) |
| A first-time candidate finishes unaided in < ~5 minutes | **Manual only**: needs real people, including Arabic speakers |

### 28.9 What was implemented

A static page ([poc-08-onboarding-simulator/](poc-08-onboarding-simulator/), run
instructions in its README) with eight steps. It matches the plan above with no
scope added:

| Step | What the candidate does | What is checked / explained | Failure → fix shown |
|---|---|---|---|
| Welcome | Picks EN/AR (switchable at any time) | What the practice is, ~5 min, privacy (nothing recorded or sent), what they need | — |
| Computer & browser | Nothing (automatic) | Secure context, desktop (not phone/tablet), Chromium vs other, camera/screen/WebRTC/WASM APIs, screen size; downloads and warms up the face model | Each failed or warned item has its own fix; "couldn't download" names the network as the likely cause |
| Camera | Allows the camera, then sits in the guide oval | Face count, framing with direction hints, distance, lighting (dark / backlit / too bright); passes after 3 s held in position, and that hold *is* the head-pose calibration | Blocked, not found, in use by another app, unsupported, model failed; "more than one person"; "move left / closer / tilt up"; a lighting-only issue passes with a warning |
| Microphone | Stays quiet for 5 s, then reads a sentence aloud | Level meter; Silero VAD hears nothing during the quiet phase and ≥ 0.8 s of speech in the speaking phase | Blocked / not found / in use; "we heard talking while you were quiet" (TV, other person); "we couldn't hear you" with tips, plus "seems muted" when the level is flat |
| Screen | Shares the entire screen; a local preview only | `displaySurface === "monitor"`, `screen.isExtended` | Cancel/permission (with the macOS walkthrough, highlighted on Mac), window or tab shared, second monitor, unverifiable surface, unsupported browser |
| Rules | Reads the rules, ticks the room checklist, can practise a 20 s room scan, acknowledges | Draft rules as data: 2 allowed, 4 prohibited, 5 behaviour rules, each prohibited/behaviour rule with "if this is noticed: …"; ID-check tips; system FAQ | Checklist incomplete → hint; "I can't do one of these" → passes with a warning |
| Practice exam | Answers 3 process questions within 3:00 while trying the actions ("look away", "leave the view", "say something", "show a phone") | Exam-time thresholds from POC #1–#4. On each alert: the in-exam nudge, the "try it" item ticks, and an **example proctor alert** (code, plain-language label, duration, `ALERTED · awaiting proctor review`) with "a person reviews it; the system never decides" | Not scored; answers get explanations |
| Summary | Downloads the report, or starts again | Ready / ready with warnings / needs help; per-check result with its fix text; camera and mic switched off | — |

**Architecture as built.** It's the one planned in 28.4. `logic.js` is pure and
unit-tested, `media.js` wraps the browser APIs, and `app.js` renders from the content
files. No text is hard-coded in the JS. The one addition is a CSP `connect-src`
allow-list in `index.html` (finding F1).

**Technologies:** plain HTML/CSS/ES modules, no build step, no npm dependencies (same
as POC #1–#7). MediaPipe Tasks Vision **1.0.1, pinned** (Face Landmarker float16,
EfficientDet-Lite0) with WASM and a GPU delegate. Silero VAD v5 via
`@ricky0123/vad-web` 0.0.31 and onnxruntime-web 1.22.0. `getUserMedia`,
`getDisplayMedia`, the Window Management `screen.isExtended`, Web Audio `AnalyserNode`,
and `Intl.NumberFormat` with a pinned numbering system. Tests use `node:test` (zero
dependencies) and Playwright 1.63 with headless Chromium, the Xiph "derf" test
sequences, and macOS TTS (`say`: Samantha for English, Majed for Arabic).

**Size:** `logic.js` 404 lines, `media.js` 431, `app.js` 1,264 (mostly DOM
construction for eight steps), 458 lines of content per language, and 1,103 lines of
tests and fixture tooling.

### 28.10 Test results and findings

**Automated runs (2026-09-29/30), headless Chromium 153 on an Apple-silicon Mac,
localhost, models fetched live from the CDNs.** 29 unit tests pass (logic + EN/AR
content parity, < 1 s). The e2e suite has 18 scenarios, and the final full run on
2026-09-30 passed 18/18. Earlier runs failed three times, and each failure led to a
finding below (F2, F6, F7). One more run was discarded because the Mac slept with its
lid closed partway through, which froze the headless browsers for minutes at a time.
Run long suites under `caffeinate`.

| Criterion (28.8) | Scenario(s) | Result |
|---|---|---|
| Happy path → "ready", EN and AR | `happy_en`, `happy_ar` | **Pass.** 62–69 s end to end with fake devices. Practice gets 3/3 answers, the speech nudge and the example `SPEECH_DETECTED` alert card |
| Failure modes detected and explained | `two_faces`, `too_dark`, `camera_denied`, `camera_busy`, `mic_silent`, `screen_wrong_surface`, `screen_denied_mac`, `screen_denied_windows`, `screen_multi_monitor`, `mobile_device`, `cdn_blocked` | **Pass.** Each shows its specific fix text. Too dark passes with a `TOO_DARK` warning (by design, D4). The macOS walkthrough is highlighted on Mac only. "Skip" records `SKIPPED_BY_CANDIDATE` |
| Mock-exam nudge + proctor-alert explanation | `face_missing_in_practice`, `two_faces_in_practice`, speech inside the happy paths | **Pass** for face missing, multiple faces and speaking. Looking away and phone need a real person (manual matrix) |
| RTL correct; parity; no missing strings | `happy_ar` + content tests | **Pass.** `dir=rtl`, first step rightmost, no missing content keys, same rule IDs and placeholders in both languages. Screenshots checked by eye |
| Nothing uploaded | every scenario's network audit + `telemetry_blocked` | **Pass.** GET requests only, to `127.0.0.1`, `cdn.jsdelivr.net` and `storage.googleapis.com`. The one attempted POST (MediaPipe telemetry, F1) is blocked by the CSP |
| Survives reload mid-flow | `happy_en` reloads at the screen step | **Pass.** It resumes at Screen with device/camera/mic results kept |
| Report accepted by POC #6 unchanged | `report_into_poc6` | **Pass** (HTTP 201, stored as `READINESS_REPORT`). POC #6 then stores it as `ALERTED`, which F9 addresses |
| Real-time with face + VAD + phone | `?dev=1` metrics in the happy paths | Face Landmarker **~11 fps, ~50 ms per frame** (GPU delegate). Phone detector ~220 ms per call, one call every ~880–900 ms (the duty cycle, F4). Headless numbers; laptop numbers are in the manual matrix |
| First-time candidate unaided in < ~5 min | Manual team run, 2026-10-06 (EN, macOS, real camera/mic/screen) | **Partly tested.** Welcome → Summary in ~2–3 min, all six checks passed, no problems. The tester knew the app, so real first-time EN and AR candidates are still needed |

**Measured load times** (cold cache per scenario, since each launch is a fresh
browser profile): face model 0.1–7.9 s, phone model 7.8–15.5 s, VAD 0.3–5.0 s, and
the first-inference warm-up ~4.0–4.6 s per vision model.

**Findings**

- **F1 — MediaPipe tasks-vision ≥ 1.0.0 sends usage telemetry to Google.** It batches
  task type, version, call counts and latency, and every 60 s POSTs them as
  protobuf to `odml.pa.googleapis.com/v1/log` with an embedded API key, the page
  origin and the user agent. There are no images. There's no option to turn it off,
  and the 0.10.x versions don't have it. POC #8 blocks it with a CSP `connect-src`
  allow-list, and `telemetry_blocked` proves it by waiting past the 60 s flush.
  **Verified on 2026-09-30:** POC #1, #2 and #3 as shipped (`@latest`, now 1.0.1, no
  CSP) each sent the POST 62–63 s after starting detection. This makes "nothing
  leaves the device" untrue for them. A network audit shorter than any batching
  interval would have missed it. **Fixed on 2026-10-06:** POC #1–#3 now have POC #8's
  CSP. A 75 s headless run of each (fake camera) showed the POST blocked as a
  `connect-src` violation for `odml.pa.googleapis.com/v1/log`, the model still loaded
  (HTTP 200), detection started and there were no page errors.
- **F2 — Creating two MediaPipe tasks at once can hang.** The loader passes the WASM
  module to each new task through a global (`self.ModuleFactory`) and then clears it.
  Loading face and phone concurrently hung for ~17 minutes. The app can reach that
  state (resume at Rules, then go straight to Practice). Fix: `media.js` serialises
  task creation. Regression scenario: `concurrent_model_load`, which loads both in
  ~16–29 s.
- **F3 — The first inference blocks the main thread for ~4–4.6 s** (GPU shader
  compilation). If it happens during a live step, the camera check or practice
  freezes. Each model is now warmed up on a blank canvas while its loading message is
  showing.
- **F4 — The phone detector starves the face model.** Both run on the main thread, so
  at a fixed 4 Hz the phone model (~220 ms per call) cut the face rate from 15 to
  3.6 fps. It's now capped at 25% of wall time (minimum interval 250 ms), so it runs
  about once every 0.9 s and face stays at ~11 fps. Production should move inference
  into a worker.
- **F5 — Setup guidance must be stricter than the exam thresholds.** A unit test found
  faces that passed setup at a 5% edge margin and then raised `OUT_OF_FRAME` as soon
  as the exam used 8%. The setup margin is now 12% (D6).
- **F6 — The Face Landmarker undercounts a second face, so D2 needs revisiting.** On
  the two-person test video it finds the second face in only 84% of frames. The drops
  are brief (median 145 ms, max ~780 ms), but every drop restarts the 1.5 s raise
  window. Consequences found:
  1. *Setup (fixed):* the camera message flipped between "more than one person" and
     "almost there" every ~100 ms. The multiple-faces message is now held for 1 s
     after the second face was last seen, and `two_faces` went from 78–81% to 100%.
  2. *Exam alert (not fixed):* simulating POC #1's persistence (1.5 s raise / 0.8 s
     clear) over a recorded frame sequence from every start offset gives:

     | Detector (same video, same persistence) | 2nd face found | `MULTIPLE_FACES` raise: median / p90 / max |
     |---|---|---|
     | Face Landmarker `numFaces: 2` (POC #8, D2) | 84% of frames | 3.4 / 7.2 / 8.1 s |
     | Face Landmarker, detection/presence/tracking confidence 0.3 | 86% | 2.2 / 4.8 / 5.7 s |
     | **BlazeFace short-range (POC #1)** | **100%** | **1.57 / 1.59 / 1.59 s** |

     The alert never flapped: drops are shorter than the 0.8 s clear window, so there
     was one raise per 20 s. It was just late. The e2e `two_faces_in_practice` agrees:
     one alert, no flapping. This is one low-resolution (CIF) video, so it needs
     confirming on real webcams. Even so, POC #1's detector counted faces clearly
     better, and D2's claim that it was "validated for two faces" doesn't hold as
     written.
- **F7 — The mic check's timing depends on how fast the VAD starts.** The quiet window
  starts once the VAD is running, 1.8–5.7 s after the mic opens (it varies from run to
  run). One of six `happy_en` runs got "we heard talking while you were quiet". The
  most likely cause is a slow VAD start that pushed the quiet window into the
  fixture's speech (14.4 s after the mic opens). This isn't confirmed: that run wasn't
  traced. The happy paths now log every VAD event and phase change (`micTrace`), and
  the next four runs passed with 3.7–7.5 s of margin. For candidates it means the mic
  step spends up to ~6 s on "loading" before it asks for silence.
- **F8 — Everything depends on two public CDNs.** Cold loads took up to 15.5 s for the
  phone model, and `cdn_blocked` shows the device step failing with the network named
  as the likely cause. That's acceptable for a practice page. It isn't acceptable for
  exam day on restricted corporate or national networks, so self-hosting is the fix
  (R6, and the F1 decision).
- **F9 — The readiness report is not an alert.** POC #6 accepts it unchanged, but
  stores it with the alert lifecycle status `ALERTED`, which puts it in the proctor's
  alert queue. Production needs a separate, non-alert event type, or a separate
  endpoint, for "candidate readiness".

### 28.11 Limitations

- All numbers come from headless Chromium with fake devices on one Mac. Real webcams,
  low-end laptops, Windows, Firefox and Safari aren't measured.
- The test videos are CIF (352×288) Xiph sequences. F6 in particular needs repeating
  at 720p with real people.
- `LOOKING_AWAY` and `PHONE_DETECTED` have no automated coverage (no fixture contains
  them).
- The setup band and lighting thresholds are untuned starting values.
- The rules are placeholders (D8), and the Arabic copy is machine-drafted (D7). Neither
  may be shown to real candidates as they are.
- The "< 5 minutes unaided" criterion, the one the POC exists for, is untested until
  real candidates, including Arabic speakers, use it.
- The report is only downloaded; nothing is wired to a backend.

### 28.12 Risks and decisions after implementation

- **New, confirmed:** third-party telemetry (F1). It's in the risk register, and
  there's a Decision Log entry to self-host and use a CSP in production. POC #1–#3
  got the same CSP on 2026-10-06, so they no longer send it.
- **New:** single-model face counting delays `MULTIPLE_FACES` (F6). **D2 is changed
  from Proposed to Revisit.** Recommended for production: keep BlazeFace for presence
  and count (POC #1), and use the Face Landmarker with `numFaces: 1` only for pose.
  That costs a second model per frame, so measure the price on a low-end laptop
  before deciding.
- **R7 (overload)** is confirmed in headless (F3, F4). It's mitigated in the POC by
  warm-up and duty-cycling. The real fix is a worker.
- **D1 (no runtime LLM)** held up. All candidate-facing text came from the content
  files, and the parity test caught EN/AR drift during development.

### 28.13 Recommended next steps

1. **Manual matrix** (README), with real first-time candidates in EN and AR, a
   bilingual review of `content/ar.json`, and the exam owner approving real rules to
   replace the placeholders (Open Question #11).
2. **Settle D2** by re-running the F6 comparison on 720p webcams with two real people,
   then choosing between BlazeFace + Landmarker and a Landmarker with lower
   confidence.
3. ~~**Add a CSP `connect-src`, or pin to 0.10.x, in POC #1–#3**~~ **Done
   2026-10-06** (CSP, see F1). Compliance input is still needed (Open Question #12).
4. **Production integration (VerifyID-Portal)**:
   - Self-host the models and WASM.
   - Serve the rules from the approved content version.
   - POST the readiness report to a non-alert endpoint (F9), so the proctor
     dashboard shows "ready / needs help" before the exam.
   - Re-run the quick camera/mic/screen checks at exam start (R5).
5. **Move inference into a worker** before adding any more models (F3, F4).
6. **Mic-step polish:** preload the VAD during the camera step so the quiet phase
   starts straight away (F7).

---

## Decision Log

| Date | Decision | Options Considered | Decision | Reason | Status |
|---|---|---|---|---|---|
| 2026-09-21 | Where should continuous face/gaze/object detection run (client vs server)? | Client-side (MediaPipe/TF.js), server-side (Rekognition per-frame), hybrid | Client-side, on-device | Rekognition is a per-call API not built for continuous inference; client-side avoids per-frame network latency/cost and keeps raw video off the wire (Section 8, finding 3) | Proposed |
| 2026-09-21 | VAD vs full speech-to-text for speaking detection | VAD only, STT only, VAD-first with STT escalation | VAD-first, STT only on confirmed sustained events, evidence-review-only | Smaller privacy footprint, lower cost/latency, sufficient for "flag for human review" (Section 8, finding 4) | Proposed |
| 2026-09-21 | Automatic exam pause on phone detection | Option A (alert only), Option B (auto-pause), Option C (high-confidence temp auto-pause) | Option A for now | Detection accuracy unvalidated; auto-pause risk (race conditions, black-box exam engine) outweighs benefit until POC #3 produces real numbers | Approved for POC phase |
| 2026-09-21 | Where should the proctoring backend/dashboard live | VerifyID-Portal, qababoardweb, new standalone service | VerifyID-Portal (proposed) | Reuses existing proctor auth, Pundit policies, and human-review pattern; qababoardweb's ActionCable pattern is worth imitating, not necessarily extending directly | Proposed, not approved |
| 2026-09-21 | Model choice for POC #1 | MediaPipe Face Detector, MediaPipe Face Landmarker, TF.js face-landmarks-detection | MediaPipe Face Detector (BlazeFace short-range) | Lightest model that satisfies POC #1's scope (presence/position/count only); better signal on real CPU/latency headroom | Approved for POC #1 |
| 2026-09-22 | Model/approach for POC #2 (gaze/head-pose) | MediaPipe Face Landmarker w/ built-in transformation matrix, manual solvePnP from landmarks, TF.js face-landmarks-detection, OpenCV.js+solvePnP, iris-based gaze | MediaPipe Face Landmarker, built-in `outputFacialTransformationMatrixes` for yaw/pitch/roll; head pose primary, iris gaze out of scope | Simplest path to a robust head-pose signal; consistent with Section 8 finding #2 that pupil-gaze is too noisy to be primary | Approved — implemented, manually tested, working |
| 2026-09-22 | Model/approach for POC #3 (phone/object detection) | TF.js COCO-SSD, YOLOv8n via onnxruntime-web, MediaPipe Object Detector (EfficientDet-Lite0), custom-trained model | MediaPipe Object Detector, EfficientDet-Lite0, filtered to the COCO `"cell phone"` category | Keeps the same runtime/library as POC #1/#2 (proven on this hardware), zero training; YOLOv8n documented as the fallback if precision proves too low | Approved — implemented, manually tested, working |
| 2026-09-22 | Model/approach for POC #4 (speaking/VAD) | Energy-based VAD, Silero VAD via `@ricky0123/vad-web`, server-side Whisper/STT | Silero VAD via `@ricky0123/vad-web` (ONNX, WASM, on-device); energy-based VAD documented as fallback only | ML-based VAD meaningfully reduces false positives vs. amplitude thresholding, consistent with Section 10; STT already ruled out for privacy/cost (Section 8 finding #4) | Approved — implemented, manually tested, working |
| 2026-09-23 | Push technology for POC #6 (real-time alerts) | ActionCable (disposable Rails app), Node.js + Server-Sent Events, raw WebSockets (Node `ws`) | Node.js + Server-Sent Events, zero npm dependencies | Validates event schema/review lifecycle/latency without standing up a new Ruby/Rails toolchain just for R&D; ActionCable remains the documented target for the real production integration (Section 7), unchanged by this choice | Approved — implemented, awaiting manual test results |
| 2026-09-23 | Storage backend for POC #7 (evidence capture) | Real AWS S3, local disk via a small Node server, no storage (client-side download only) | Local disk via a small Node server (`clips/`, gitignored) | Validates the rolling-buffer/upload-on-trigger mechanism without handling real AWS credentials/cost in an R&D prototype; S3 remains the documented target for real production storage (Section 7), unchanged by this choice | Approved — implemented, awaiting manual test results |
| 2026-09-23 | Screen viewing transport for POC #5 | P2P WebRTC + existing push-channel signaling, self-hosted SFU (LiveKit/mediasoup), managed WebRTC (LiveKit Cloud/Daily/Twilio/Agora/Chime), periodic screenshots, continuous recording, Google Meet | P2P WebRTC, signaling over SSE (stand-in for ActionCable), zero npm deps | Lowest latency, no media servers, screen video never decrypted on our infra; measured ~25 ms glass-to-glass and ~100–200 kbps for exam text. SFU deferred until >1 viewer per candidate or server-side recording is required (measured mesh cost: +1 full encode per viewer) | Proposed — implemented, manual matrix pending |
| 2026-09-23 | Remote control of candidate machine | View-only, remote control via native agent | View-only | Browser can't provide control; a native agent is a large security/consent/support burden with no requirement driving it (Section 27) | Proposed |
| 2026-09-23 | Entire-screen enforcement | Trust the `displaySurface` hint, verify `getSettings().displaySurface` after pick, allow any surface | Hint + verify; reject non-`monitor`, flag `unknown` | Hints are ignored by Safari and can be overridden by the user in all browsers; verification is the only real control | Proposed |
| 2026-09-23 | Multiple monitors | Capture all screens, block if >1, detect + alert | Single-monitor policy + `MULTIPLE_MONITORS` alert (Chromium `isExtended`) | `getAllScreensMedia()` is managed-ChromeOS/IWA only; detection is possible without a prompt in Chromium; blocking contradicts the alert-only stance | Proposed |
| 2026-09-29 | Approach for the practice / onboarding simulator (POC #8) | Deterministic workflow, interactive tutorial, runtime LLM assistant, guided mock exam, hybrid | Hybrid: deterministic step machine + interactive detector checks + short mock exam. All text from versioned content files. **No runtime LLM** | Exam rules must be exactly what was approved, identical in EN and AR; *Moffatt v. Air Canada* makes the operator liable for what a chatbot invents (Section 28.2–28.3) | Proposed — implemented, manual matrix pending |
| 2026-09-29 | One face model instead of two (POC #1 detector + POC #2 landmarker) | Keep both, Face Landmarker only (`numFaces: 2`) | Face Landmarker only | Fewer models on candidate laptops. **But** on a two-person video it found the second face in 84% of frames vs BlazeFace's 100%, which delays the `MULTIPLE_FACES` alert (median 3.4 s, max 8.1 s, vs 1.6 s). Candidate for production: BlazeFace for count + Landmarker (`numFaces: 1`) for pose (Section 28.10, F6) | **Revisit** — confirm on 720p webcams |
| 2026-09-29 | MediaPipe usage telemetry (found in POC #8) | Accept it, pin 0.10.35 (last version without it), CSP `connect-src` allow-list, self-host + CSP | CSP allow-list now, in POC #8. **Production: self-host + CSP**. POC #1–#3 got the same CSP on 2026-10-06 | There's no API opt-out, and the CSP blocks it at the browser level for every library at once. Proven by a 75 s e2e run (Section 28.10, F1) | Proposed — needs compliance input (Open Question #12) |
| 2026-09-29 | Arabic digits | Browser default, Latin (`nu-latn`), Arabic-Indic (`nu-arab`) | Pinned Latin, configurable in content `meta` | Browser defaults differ by region tag and version. Latin is the likely convention of the exam engine | Proposed — Open Question #10 |
| 2026-09-29 | Readiness hand-off to the proctor | None, JSON download, POST to backend | JSON download in the POC, same shape as a POC #6 event (accepted unchanged by `POST /events`) | Keeps the POC unwired. Production needs its own non-alert event type (Section 28.10, F9) | Proposed |

## Experiment Log

| POC | Goal | Setup | Result | Metrics | Problems | Decision |
|---|---|---|---|---|---|---|
| 1 | Validate face presence / out-of-frame / multiple-face detection on a normal webcam | Standalone browser page, MediaPipe Face Detector (BlazeFace short-range), WASM, no backend | See Section 18 (pending human test run) | Latency/FPS logged live in-app; see README for how to capture | TBD after manual testing | TBD |
| 5 | Validate entire-screen share + live proctor viewing | `getDisplayMedia` + P2P WebRTC, Node SSE signaling; Playwright/headless Chromium with fake monitor device and synthetic 1080p exam screen; localhost | Works end to end; survives signaling outage; events reach proctor in 16–35 ms | Glass-to-glass ~23–34 ms (static), ~67 ms (scroll, High); 100–150 kbps static text @1080p; 4 candidates → 185 kbps proctor download | Reconnect tore down live video (fixed); motion + 1 Mbps cap → 1 fps/450 ms; mesh doubles candidate encode per extra viewer; SSE 6-conn limit; N≥6 load not measurable on one machine | P2P + TURN for production; SFU only on trigger; manual matrix next |
| 8 | Validate an unaided EN/AR practice + setup check that reuses POC #1–#6 | Static page; MediaPipe 1.0.1 (pinned) Face Landmarker + Object Detector, Silero VAD 0.0.31, getDisplayMedia; content JSON; Playwright/headless Chromium with Xiph face videos, TTS speech (EN + AR), fake screen, stubbed failures | 29/29 unit tests; 18/18 e2e scenarios (EN + AR happy paths, 11 failure modes, practice alerts, network/telemetry, POC #6 hand-off) | Face ~11 fps / ~50 ms; phone ~220 ms at ~1.1 Hz; warm-up ~4–4.6 s per model; happy path 62–69 s with fake devices (Section 28.10) | MediaPipe telemetry (F1); concurrent task creation hang (F2, fixed); main-thread starvation (F3–F4, mitigated); Landmarker undercounts a second face (F6); VAD start-up timing (F7) | Hybrid deterministic approach confirmed; CSP allow-list required; real-candidate test next |
