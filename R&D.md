# AI Proctoring R&D

Status: **POC #1 and POC #2 both implemented.** POC #1 has been manually tested by the
team; POC #2 awaiting its manual test pass. Neither POC's test-matrix results have
been recorded in this document yet (Section 18 and the POC #2 README are still
blank) — do that before treating either POC as fully validated. POC #3+ not started.

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
| Screen capture / viewing | P2 | POC #5 |
| Real-time proctor alerting | P0 (infra) | POC #6 |
| Rolling-buffer evidence capture | P1 | POC #7 |
| Practice/onboarding simulator | P2 | POC #8 |

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
| Screen capture | `getDisplayMedia()` + WebRTC | View/record only — remote control explicitly not recommended (Section 10). |

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
- **Status:** not yet built. Proposed as POC #5.

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
| 2 | Gaze / head pose | **Implemented** — see Section 22; results pending manual test pass |
| 3 | Phone/object detection | Not started |
| 4 | Audio/speaking detection | Not started |
| 5 | Screen capture | Not started |
| 6 | Real-time events → proctor dashboard | Not started |
| 7 | Evidence rolling-buffer recording | Not started |
| 8 | Practice/onboarding simulator | Not started |

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

## 21. Next Steps

1. Record POC #1's manual test-matrix results into Section 18 (and POC #2's into
   Section 22's Results subsection) — both are still blank. Testing has happened for
   POC #1 per the team, but the written results aren't captured in this document yet,
   which matters for anyone reviewing this doc later without having been in the room.
2. Run POC #2's manual test matrix (see `poc-02-gaze-headpose/README.md`) — not yet
   done. Pay particular attention to the false-positive-prone scenarios (second
   monitor, notes on desk) and the pose-axis sign/direction sanity check.
3. Resolve Open Questions #1 and #2 — they change the shape of POC #5/#6.
4. Await explicit approval before starting POC #3, per the working rule governing this
   R&D track.

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

---

## Decision Log

| Date | Decision | Options Considered | Decision | Reason | Status |
|---|---|---|---|---|---|
| 2026-09-21 | Where should continuous face/gaze/object detection run (client vs server)? | Client-side (MediaPipe/TF.js), server-side (Rekognition per-frame), hybrid | Client-side, on-device | Rekognition is a per-call API not built for continuous inference; client-side avoids per-frame network latency/cost and keeps raw video off the wire (Section 8, finding 3) | Proposed |
| 2026-09-21 | VAD vs full speech-to-text for speaking detection | VAD only, STT only, VAD-first with STT escalation | VAD-first, STT only on confirmed sustained events, evidence-review-only | Smaller privacy footprint, lower cost/latency, sufficient for "flag for human review" (Section 8, finding 4) | Proposed |
| 2026-09-21 | Automatic exam pause on phone detection | Option A (alert only), Option B (auto-pause), Option C (high-confidence temp auto-pause) | Option A for now | Detection accuracy unvalidated; auto-pause risk (race conditions, black-box exam engine) outweighs benefit until POC #3 produces real numbers | Approved for POC phase |
| 2026-09-21 | Where should the proctoring backend/dashboard live | VerifyID-Portal, qababoardweb, new standalone service | VerifyID-Portal (proposed) | Reuses existing proctor auth, Pundit policies, and human-review pattern; qababoardweb's ActionCable pattern is worth imitating, not necessarily extending directly | Proposed, not approved |
| 2026-09-21 | Model choice for POC #1 | MediaPipe Face Detector, MediaPipe Face Landmarker, TF.js face-landmarks-detection | MediaPipe Face Detector (BlazeFace short-range) | Lightest model that satisfies POC #1's scope (presence/position/count only); better signal on real CPU/latency headroom | Approved for POC #1 |
| 2026-09-22 | Model/approach for POC #2 (gaze/head-pose) | MediaPipe Face Landmarker w/ built-in transformation matrix, manual solvePnP from landmarks, TF.js face-landmarks-detection, OpenCV.js+solvePnP, iris-based gaze | MediaPipe Face Landmarker, built-in `outputFacialTransformationMatrixes` for yaw/pitch/roll; head pose primary, iris gaze out of scope | Simplest path to a robust head-pose signal; consistent with Section 8 finding #2 that pupil-gaze is too noisy to be primary | Approved — implemented, awaiting manual test results |

## Experiment Log

| POC | Goal | Setup | Result | Metrics | Problems | Decision |
|---|---|---|---|---|---|---|
| 1 | Validate face presence / out-of-frame / multiple-face detection on a normal webcam | Standalone browser page, MediaPipe Face Detector (BlazeFace short-range), WASM, no backend | See Section 18 (pending human test run) | Latency/FPS logged live in-app; see README for how to capture | TBD after manual testing | TBD |
