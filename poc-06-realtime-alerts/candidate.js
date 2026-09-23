// POC #6 — candidate side. Sends simulated events to the server; does not use a
// real camera/mic. See README.md.

const els = {
  cfgConfidence: document.getElementById("cfgConfidence"),
  cfgConfidenceVal: document.getElementById("cfgConfidenceVal"),
  cfgSession: document.getElementById("cfgSession"),
  connectionStatus: document.getElementById("connectionStatus"),
  sentTableBody: document.getElementById("sentTableBody"),
};

let sentLog = [];

els.cfgConfidence.addEventListener("input", () => {
  els.cfgConfidenceVal.textContent = Number(els.cfgConfidence.value).toFixed(2);
});

document.querySelectorAll(".event-btn").forEach((btn) => {
  btn.addEventListener("click", () => sendEvent(btn.dataset.type, btn.dataset.detail));
});

async function sendEvent(eventType, detail) {
  const payload = {
    event_type: eventType,
    detail,
    confidence: Number(els.cfgConfidence.value),
    session_id: els.cfgSession.value || "demo-session",
    client_sent_at: Date.now(),
  };
  try {
    const res = await fetch("/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = await res.json();
    logSent(eventType, res.ok ? `#${body.id}` : `error`, res.ok ? "sent" : body.error);
  } catch (err) {
    logSent(eventType, "–", `failed: ${err.message}`);
  }
}

function logSent(type, serverId, result) {
  sentLog.unshift({ time: new Date().toLocaleTimeString(), type, serverId, result });
  sentLog = sentLog.slice(0, 50);
  renderSentTable();
}

function renderSentTable() {
  els.sentTableBody.innerHTML = "";
  sentLog.forEach((row) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${row.time}</td><td>${row.type}</td><td>${row.serverId}</td><td>${row.result}</td>`;
    els.sentTableBody.appendChild(tr);
  });
}

// A lightweight connection check — just confirms the server is reachable, since
// this page only POSTs (it doesn't need the SSE stream the dashboard uses).
async function checkConnection() {
  try {
    const res = await fetch("/events", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    // A 400 (missing event_type) still proves the server is up and responding.
    els.connectionStatus.textContent = res.status === 400 || res.ok
      ? "✅ Server reachable."
      : `⚠ Server responded with ${res.status}.`;
  } catch (err) {
    els.connectionStatus.textContent = `⚠ Cannot reach server: ${err.message}. Is server.js running?`;
  }
}

checkConnection();
