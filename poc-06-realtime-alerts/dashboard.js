// POC #6 — proctor dashboard. Subscribes to the server's SSE stream and renders a
// live feed, with the human-review lifecycle (acknowledge -> confirm/dismiss/
// false-positive). See README.md.

const els = {
  connectionStatus: document.getElementById("connectionStatus"),
  totalVal: document.getElementById("totalVal"),
  pendingVal: document.getElementById("pendingVal"),
  latencyVal: document.getElementById("latencyVal"),
  feed: document.getElementById("feed"),
};

const eventsById = new Map();
const latencySamples = [];

const ACTIONS_BY_STATUS = {
  ALERTED: [["acknowledge", "Acknowledge"]],
  ACKNOWLEDGED: [
    ["confirm", "Confirm"],
    ["dismiss", "Dismiss"],
    ["false_positive", "False positive"],
  ],
};

function connect() {
  const source = new EventSource("/events/stream");

  source.addEventListener("open", () => {
    setConnectionStatus("present", "✅ Connected");
  });
  source.onerror = () => {
    setConnectionStatus("warning", "⚠ Reconnecting…");
  };

  source.addEventListener("backlog", (e) => {
    const backlog = JSON.parse(e.data);
    backlog.forEach((ev) => eventsById.set(ev.id, ev));
    renderFeed();
  });

  source.addEventListener("created", (e) => {
    const ev = JSON.parse(e.data);
    recordLatency(ev);
    eventsById.set(ev.id, ev);
    renderFeed();
  });

  source.addEventListener("updated", (e) => {
    const ev = JSON.parse(e.data);
    eventsById.set(ev.id, ev);
    renderFeed();
  });
}

function recordLatency(ev) {
  if (ev.client_sent_at == null) return;
  const latency = ev.server_received_at - ev.client_sent_at;
  // This measures candidate -> server latency (both timestamps trust the browser
  // clocks involved); dashboard render time on top of that is typically negligible
  // on localhost but is exactly what the "extended run" / multi-tab test rows
  // should surface if it isn't.
  latencySamples.push(latency);
  while (latencySamples.length > 30) latencySamples.shift();
  const avg = latencySamples.reduce((a, b) => a + b, 0) / latencySamples.length;
  els.latencyVal.textContent = `${avg.toFixed(0)} ms`;
}

function setConnectionStatus(cls, text) {
  els.connectionStatus.className = `live-status ${cls}`;
  els.connectionStatus.textContent = text;
}

async function review(id, action) {
  const res = await fetch(`/events/${id}/review`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    alert(`Could not ${action}: ${body.error || res.status}`);
  }
  // No local state mutation here — the server's "updated" broadcast (received by
  // every open dashboard tab, including this one) is the single source of truth.
}

function renderFeed() {
  const all = [...eventsById.values()].sort((a, b) => b.id - a.id);
  els.totalVal.textContent = String(all.length);
  els.pendingVal.textContent = String(
    all.filter((ev) => ev.status === "ALERTED" || ev.status === "ACKNOWLEDGED").length
  );

  els.feed.innerHTML = "";
  all.forEach((ev) => {
    const card = document.createElement("div");
    card.className = "event-card";
    const actions = ACTIONS_BY_STATUS[ev.status] || [];
    card.innerHTML = `
      <div class="meta">
        <span class="type">${ev.event_type} <span class="badge ${ev.status}">${ev.status}</span></span>
        <span class="detail">${ev.detail || ""}${ev.confidence != null ? ` — confidence ${Number(ev.confidence).toFixed(2)}` : ""}</span>
        <span class="timing">#${ev.id} · ${ev.session_id} · ${new Date(ev.server_received_at).toLocaleTimeString()} · delivered in ${ev.server_received_at - ev.client_sent_at}ms</span>
      </div>
      <div class="actions"></div>
    `;
    const actionsEl = card.querySelector(".actions");
    actions.forEach(([action, label]) => {
      const btn = document.createElement("button");
      btn.textContent = label;
      btn.addEventListener("click", () => review(ev.id, action));
      actionsEl.appendChild(btn);
    });
    els.feed.appendChild(card);
  });
}

connect();
