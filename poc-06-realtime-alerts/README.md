# POC #6 — Real-Time Events → Proctor Dashboard

Part of the AI Proctoring R&D track. See [`../R&D.md`](../R&D.md) for the full
architecture/research document this POC belongs to (Section 6 "Proposed
Architecture", Section 7 "Technology Options", and Section 13 "Human-in-the-Loop
Design" cover the design this was built from).

## What this validates

> Can browser-side detection events (matching POC #1–4's event shapes) reach a
> separate proctor dashboard in near-real-time, with a human-in-the-loop review
> lifecycle (acknowledge → confirm/dismiss/false-positive), at latency/schema/UX
> characteristics that would transfer directly to a real ActionCable implementation
> later?

This is a **standalone, unwired prototype**, same as POC #1–4. It does not touch any
Rails route, controller, model, or production JS bundle, and is not connected to
VerifyID-Portal or qababoardweb in any way.

## What it is NOT

This deliberately does not implement: real camera/mic detection (it simulates the
event types POC #1–4 produce, via buttons — those POCs already validated detection
itself), ActionCable (see "Why Node + SSE, not ActionCable" below), authentication,
database persistence (everything is in-memory and clears on server restart), or
evidence/video capture (POC #7). Per the existing Decision Log entry on Automatic
Exam Pause, nothing here triggers any automatic action — every event sits and waits
for a human decision.

## Why Node + SSE, not ActionCable

R&D.md Section 7 already recommends ActionCable for the real integration (it's
Redis-backed infra already configured in VerifyID-Portal and already proven working
in qababoardweb). This POC intentionally does not build that — standing up a
disposable Rails app just for an R&D prototype would be a real step up in setup cost
from every prior POC in this repo, none of which need anything beyond a browser.

What this POC actually tests — the event schema, the acknowledge → confirm/dismiss
review lifecycle, multi-client fan-out (two dashboards staying in sync), and
delivery latency — doesn't depend on which push technology carries it. A plain
Node.js server using Server-Sent Events answers those questions with zero
dependencies (`node server.js`, nothing to `npm install`). **ActionCable remains the
documented target for the real production integration** — this POC's schema and UX
are meant to carry over to that directly, not replace it.

## How it works

- [`server.js`](server.js) — plain Node.js (`http` module only, no npm
  dependencies). Holds events in memory, exposes:
  - `POST /events` — candidate side submits a new event.
  - `GET /events/stream` — Server-Sent Events feed the dashboard subscribes to
    (sends the current backlog first, then pushes new events/updates as they
    happen).
  - `POST /events/:id/review` — proctor dashboard submits a review decision.
- [`candidate.html`](candidate.html) / [`candidate.js`](candidate.js) — simulates a
  candidate's browser. One button per POC #1–4 event type; each click POSTs one
  event with a timestamp, so delivery latency can be measured.
- [`dashboard.html`](dashboard.html) / [`dashboard.js`](dashboard.js) — the
  proctor's view. Live feed via `EventSource`, each alert showing type, detail,
  confidence, delivery latency, and status, with buttons for whichever action is
  valid next (Acknowledge → Confirm / Dismiss / False positive).
- **Lifecycle:** `ALERTED → ACKNOWLEDGED → CONFIRMED / DISMISSED / FALSE_POSITIVE`,
  matching R&D.md Section 13. The server rejects an out-of-order action (e.g.
  confirming something that hasn't been acknowledged yet) with a 409 — worth
  triggering on purpose while testing (open two dashboard tabs and try to
  double-review the same event from both).

## Running it

This POC needs an actual running process, not just a static file server:

```bash
cd poc-06-realtime-alerts
node server.js
# Candidate:  http://localhost:8010/candidate.html
# Dashboard:  http://localhost:8010/dashboard.html
```

Open both pages (ideally side by side, or dashboard in two separate tabs), fire
events from the candidate page, and review them on the dashboard.

## Metrics captured live in the UI

- **Delivery latency** — per-event, and a rolling average on the dashboard. Computed
  from the candidate's `client_sent_at` timestamp vs. the server's receipt time, so
  it reflects network + server time, not dashboard render time. Expect very low
  numbers on localhost — this establishes a baseline, not a real-network figure.
- **Total alerts / Awaiting review** — simple counts on the dashboard.

## Test matrix (fill in while testing, then summarize into `R&D.md`)

**Automated run, 2026-10-27**: headless Chrome 155 on macOS drove the real `candidate.html` and two `dashboard.html` tabs on localhost through the DevTools protocol. Latencies, counts and heap sizes below are measured. Each tab's JS heap size was read through the DevTools protocol. Script and raw output aren't committed.

| Scenario | Worked as expected? | Notes |
|---|---|---|
| Single event: candidate → dashboard, note the latency | ✅ Yes (automated) | Arrived. Server-measured 1 ms candidate→server; card visible in dashboard ≤29 ms after the click (25 ms polling) |
| Full lifecycle: Acknowledge → Confirm | ✅ Yes (automated) | #2: ALERTED → ACKNOWLEDGED → CONFIRMED in tab A; tab B followed both steps |
| Full lifecycle: Acknowledge → Dismiss | ✅ Yes (automated) | #3: ALERTED → ACKNOWLEDGED → DISMISSED in tab A; tab B followed both steps |
| Full lifecycle: Acknowledge → False positive | ✅ Yes (automated) | #4: ALERTED → ACKNOWLEDGED → FALSE_POSITIVE in tab A; tab B followed both steps |
| Try to Confirm before Acknowledging (should be rejected, 409) | ✅ Yes (automated) | HTTP 409: "cannot confirm an event with status ALERTED". The dashboard UI doesn't offer Confirm before Acknowledge, so this was sent directly to the API |
| Two dashboard tabs open — both receive the same event | ✅ Yes (automated) | Both tabs show the same event ids [1,2,3,4,5] |
| Two dashboard tabs — review from one, does the other update too? | ✅ Yes (automated) | Tab B reflected every Acknowledge/Confirm/Dismiss/False-positive made in tab A |
| Rapid-fire: click every event button quickly in a row | ✅ Yes (automated) | 7 clicks in one tick → 7 new cards in tab A, 7 in tab B, none lost |
| Refresh the dashboard tab mid-session — does it recover the backlog? | ✅ Yes (automated) | After reload: 12 events with identical ids and review statuses |
| Close the candidate tab, reopen — still able to send events? | ✅ Yes (automated) | New candidate tab's event reached the dashboard |
| Stop and restart `server.js` — does the dashboard reconnect (even though history is gone)? | ⚠️ Partly (automated) | Reconnects: showed "Reconnecting…" within 29 ms, back to "Connected" 2189 ms after restart, and a new event arrived. **Bug:** an open dashboard keeps its pre-restart cards (the `backlog` handler in `dashboard.js` adds to its map and never clears it), and the server restarts ids at #1. So new event #1 overwrote stale card #1: card count stayed 13 → 13 instead of +1. New alerts silently replace old ones until the tab is reloaded |
| Leave both tabs open 10+ minutes — any drift, memory growth, dropped events? | ✅ Yes (automated) | 10.5 min, 1 event / 15 s: 42 sent, 42 received in tab A, 42 in tab B; max delivery 8 ms; JS heap A 0.7→1.3 MB, B 0.7→1.2 MB; still Connected |

## Known limitations of this POC

- In-memory only — restarting `server.js` clears everything. Not a substitute for
  the persistence question POC #7 (evidence capture) or a real database will need to
  answer.
- No authentication on any endpoint — matches the "standalone, unwired" pattern, but
  a real integration must sit behind VerifyID-Portal's existing proctor auth/Pundit
  policies, which is explicitly not this POC's job.
- Latency is measured on localhost between two tabs on the same machine — it is a
  baseline for the mechanism, not a real-network or real-candidate-hardware number.
- Concurrent review races (two proctors clicking different actions on the same event
  at the same instant) are handled by the server's status check (whichever request
  arrives first wins, the second gets a 409) but there's no UI conflict messaging
  beyond a plain alert — acceptable for a POC, not production-polished.
- No automated test suite — manual-testing prototype by design, same as POC #1–4.
