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
| 3 | [poc-03-phone-object/](poc-03-phone-object/) | Phone / object detection | Implemented — awaiting manual test pass |

Each POC is a standalone folder with its own README (how to run it, what it validates,
known limitations). No shared build step or dependency between POCs unless a POC's own
README says otherwise.

## Ground rules

- Each POC is small, scoped, and manually tested before the next one starts.
- AI flags potential events for human review — it never auto-determines misconduct.
- All prototypes here are privacy-first: video/audio processing stays on-device where
  possible, nothing is uploaded unless a POC's README says otherwise.
- See `R&D.md`'s Decision Log for what's actually approved vs. still proposed.
