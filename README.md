# AI Proctoring R&D

Research and proof-of-concept track for AI-assisted exam proctoring. Standalone from
the production apps (VerifyID-Portal, qababoardweb) — nothing here touches their
routes, controllers, models, or asset pipelines.

Start with [`R&D.md`](R&D.md) — the living architecture/research document. It tracks
findings, trade-offs, decisions, and the full POC roadmap.

## POCs

| # | Folder | Goal | Status |
|---|---|---|---|
| 1 | [poc-01-face-presence/](poc-01-face-presence/) | Face presence / out-of-frame / multiple faces | Implemented, tested |
| 2 | [poc-02-gaze-headpose/](poc-02-gaze-headpose/) | Gaze / head-pose ("looking away") | Implemented, tested |
| 3 | [poc-03-phone-object/](poc-03-phone-object/) | Phone / object detection | Implemented, tested |
| 4 | [poc-04-speaking-vad/](poc-04-speaking-vad/) | Speaking / voice activity detection | Implemented, tested |
| 5 | [poc-05-screen-capture/](poc-05-screen-capture/) | Screen capture / live proctor viewing | Implemented — automated runs done, manual matrix pending |
| 6 | [poc-06-realtime-alerts/](poc-06-realtime-alerts/) | Real-time events → proctor dashboard | Implemented, tested |
| 7 | [poc-07-evidence-capture/](poc-07-evidence-capture/) | Evidence rolling-buffer recording | Implemented, tested |
| 8 | [poc-08-onboarding-simulator/](poc-08-onboarding-simulator/) | Practice / onboarding simulator (EN/AR) | Implemented — automated e2e done, manual matrix (real candidates) pending |

Each POC is a standalone folder with its own README (how to run it, what it validates,
known limitations). No shared build step or dependency between POCs unless a POC's own
README says otherwise.

## Ground rules

- Each POC is small, scoped, and manually tested before the next one starts.
- AI flags potential events for human review — it never auto-determines misconduct.
- All prototypes here are privacy-first: video/audio processing stays on-device where
  possible, nothing is uploaded unless a POC's README says otherwise.
  **Caveat, found in POC #8:** MediaPipe tasks-vision ≥ 1.0.0 posts usage telemetry
  (no images) to `odml.pa.googleapis.com` every 60 s. POC #1–#3 load `@latest` without
  a blocking CSP, and on 2026-09-30 each was seen sending it about 60 s after
  starting. POC #8 blocks it (R&D.md Section 28.10, F1).
- See `R&D.md`'s Decision Log for what's actually approved vs. still proposed.
