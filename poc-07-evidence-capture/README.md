# POC #7 — Evidence Rolling-Buffer Recording

Part of the AI Proctoring R&D track. See [`../R&D.md`](../R&D.md) for the full
architecture/research document this POC belongs to (Section 6 "Proposed
Architecture" and Section 10 "Evidence Recording" cover the design this was built
from; Section 11 "Privacy/Security" covers the retention concerns below).

## ⚠️ This POC saves real video to your local disk

Unlike POC #1–4 (which only ever logged text/JSON) and POC #6 (which only ever
moved small text payloads), **this POC records actual video clips of you and saves
them to this machine's disk**, in a `clips/` folder next to `server.js`. Nothing
leaves your machine — there's no cloud upload, no external server — but this is real
recorded video, not just a classification event.

- `clips/` is already added to the repo root `.gitignore` — **do not remove that
  entry.**
- Use the **Clear all clips** button in the UI (or just delete the `clips/` folder
  manually) once you're done testing.
- Don't leave test recordings sitting around longer than you need them for.

## What this validates

> Can we maintain a rolling in-memory video buffer, and — only when a proctoring
> alert fires — save a short clip (a few seconds before and after the trigger) to
> storage, without continuously recording or uploading the entire session?

This is exactly the architecture Section 10 proposed ("client-side rolling buffer…
flushed only when a detector confirms an event… avoids continuous video upload for
the entire exam") — this POC exists to prove that mechanism actually works, not just
assume it does.

This is a **standalone, unwired prototype**, same as POC #1–4/#6. It does not touch
any Rails route, controller, model, or production JS bundle.

## What it is NOT

This deliberately does not implement: real face/gaze/phone/speech detection (the
"Simulate an alert" buttons stand in for POC #1–4's real detectors — this POC only
tests the recording mechanism, not detection accuracy again), real cloud storage
(see below), audio recording (video only, to keep scope tight), retention/TTL
enforcement (Section 11 flags this as needed before production; this POC's clips
just sit in a local folder until you delete them), or any proctor-review UI (that's
POC #6's job — these two POCs are deliberately not integrated with each other yet).

## Why a local folder, not real S3

Section 7 already recommends S3 for evidence storage (no new vendor, already used
elsewhere in VerifyID-Portal). Actually wiring real S3 into an R&D prototype would
mean handling real AWS credentials and real cost for a repo that has otherwise been
zero-install and zero-credential by design — a materially bigger step than anything
else in this track, and not something to do without a separate, explicit decision.

What this POC actually needs to prove — does the rolling-buffer capture work, is the
clip actually centered on the trigger moment, and is upload-only-on-confirmed-event
(not continuous) — doesn't depend on which storage backend receives the file. A
local folder via a small Node server answers those questions directly. **S3 remains
the documented target for real production storage.**

## How it works

- [`server.js`](server.js) — plain Node.js (`http`/`fs` only, no npm dependencies).
  `POST /evidence?capture_id=...&part_index=...&event_type=...&pre_roll_s=...&post_roll_s=...`
  accepts one video segment and saves it to `clips/`, grouping segments that share a
  `capture_id` into one clip record; `GET /evidence` lists clips (each with a
  `parts` array); `GET /clips/:file` serves one segment back; `DELETE /evidence`
  clears everything.
- [`app.js`](app.js) — restarts `MediaRecorder` every second, so each second is its
  own small, independently-playable video segment (see "Why segments, not one
  continuous recording" below). Keeps a rolling buffer of the last "pre-roll"
  seconds of segments in memory (older ones are discarded). Clicking a "Simulate
  alert" button freezes that buffer, keeps recording for the "post-roll" window,
  then uploads exactly the segments between (trigger − pre-roll) and
  (trigger + post-roll) as one grouped clip.
- **Privacy:** no frame is ever sent anywhere except this same-machine local server.
  No continuous recording is uploaded — only the short clip around a confirmed
  trigger, matching the architecture this POC is validating.

### Why segments, not one continuous recording

The first version of this POC used a single continuous `MediaRecorder` with a
1-second timeslice, evicting old chunks to bound memory use. **That produced
unplayable clips.** `MediaRecorder`'s periodic chunks aren't independently
playable — only the very first chunk of a recording session contains the WebM
container header; every later chunk is just continuation data that's meaningless on
its own. Evicting that header chunk once the first pre-roll window elapsed meant
every clip captured after that point was a headerless, broken fragment — it looked
fine in the size/latency metrics (those never touch the actual video bytes) but
silently failed on playback.

The fix: restart `MediaRecorder` every second instead of using one long recording
with a timeslice. Each restart produces a small, complete, independently-valid WebM
file with its own header. A captured clip is a *sequence* of these segments,
played back one after another in the `<video>` element (advancing to the next
segment's file on `ended`) — not concatenated into a single file, since stitching
multiple independent WebM headers into one blob isn't reliably playable across
browsers. You'll see a brief stutter/reload between segments during playback; that's
this trade-off, not a bug.

### Known cosmetic issue: segments display "0:00"

A second, separate `MediaRecorder` quirk: Chrome doesn't write a valid duration into
a WebM file's header when a recording session stops normally, so a player shows
"0:00" with a fully-filled progress bar. **This is cosmetic only** — confirmed by
testing that clicking play actually plays real content and correctly advances
through every segment in order; the underlying frames and the sequential-playback
mechanism are unaffected.

An attempted fix is in place ([`fix-webm-duration`](https://github.com/yusitnikov/fix-webm-duration),
loaded from CDN as `window.ysFixWebmDuration`, patching each segment's binary
Duration field using our own measured wall-clock time right after recording it) but
it does not reliably correct the displayed label for these very short (~1s)
segments — the library wraps its WebM parsing in a blanket try/catch that silently
no-ops on failure, so it's likely failing quietly on some structural edge case
rather than actually patching. Chasing the exact binary-parsing mismatch further
wasn't worth it once playback itself was confirmed correct — that's what this POC
actually needs to validate, not a scrubber label. Left in place since it's harmless
and may still help in some cases; treat the displayed duration as unreliable.

### Buffer mechanics (why this matters for testing)

The rolling buffer is only as good as what's already been captured — if you click a
simulate button before the buffer has held a full pre-roll window (see the **Buffer
held** metric), you'll get less pre-roll than requested, not an error. That's
expected: it's exactly the same "was there enough history buffered yet" question a
real deployment needs to answer. Wait for the live status to say "Buffer ready"
before testing the pre-roll timing seriously.

While a capture is in progress (during the post-roll window), a second click on any
simulate button is ignored — overlapping captures are out of scope for this POC.

## Running it

This POC needs an actual running process (it saves files to disk), not just a
static file server:

```bash
cd poc-07-evidence-capture
node server.js
# then open http://localhost:8020
```

## Metrics captured live in the UI

- **Buffer held** — how much pre-roll history is currently available.
- **Last clip size** — the size of the most recently uploaded clip.
- **Last upload latency** — time from starting the upload to the server confirming
  it saved the file.

## Test matrix (fill in while testing, then summarize into `R&D.md`)

| Scenario | Worked as expected? | Notes |
|---|---|---|
| Simulate an alert right after the buffer says "ready" — does the clip actually start ~pre-roll seconds before the click? | | |
| Simulate an alert too early (before buffer is full) — less pre-roll than requested, not an error | | |
| Play back a saved clip — does it actually play (not blank/frozen), across all segments? | ✅ Confirmed 2026-09-23 | Real playback and segment progression work; the "0:00" label is a known cosmetic issue only, see README |
| Play back a saved clip — is the trigger moment visibly in the middle, not at the very start/end? | | |
| Try clicking a second "simulate" button while a capture is already in progress (should be ignored) | | |
| Change pre-roll/post-roll settings, restart camera, capture again | | |
| Capture several clips in a row — does the clip list and playback all work? | | |
| Clear all clips — do they disappear from both the UI and the `clips/` folder on disk? | | |
| Stop and restart `server.js` — do previously saved clip files remain on disk (even though the in-memory list resets)? | | |
| Extended run (10+ min, buffer continuously filling/discarding) — any memory growth or dropped frames? | | |

## Known limitations of this POC

- Clip boundaries are snapped to ~1-second segment boundaries — "5 seconds before"
  is approximate, not frame-exact.
- A clip plays back as a sequence of segments (brief stutter/reload between each),
  not one seamless file — a deliberate trade-off for guaranteed playability, see
  "Why segments, not one continuous recording" above.
- Segment duration displays as "0:00" in the player (cosmetic only — confirmed
  actual playback and segment-to-segment progression work correctly). An attempted
  fix via `fix-webm-duration` is in place but doesn't reliably correct the label for
  these short segments; not worth chasing further since it doesn't affect the
  mechanism this POC is validating. See "Known cosmetic issue" above.
- In-memory clip metadata resets on server restart, even though the actual clip
  files remain on disk — there's no persistent index, by design for a POC.
- No retention/TTL enforcement — Section 11 flags this as needed before production
  (this repo already has a `SelfieRetentionPurgeJob` precedent to follow); this POC
  relies on you manually clearing clips.
- Video only, no audio — kept out of scope to avoid requiring mic permission on top
  of camera permission here; POC #4 already covers audio detection separately.
- Overlapping trigger clicks are ignored, not queued — a known, accepted scope limit.
- No automated test suite — manual-testing prototype by design, same as the rest of
  this track.
