// POC #5 — proctor side. Lists connected candidates, asks each sharing candidate
// for a WebRTC offer, and renders their screen view-only in a tile grid with live
// connection stats. Measures true glass-to-glass latency by decoding the candidate
// page's latency probe out of the received video frames. See README.md.

const els = {
  connectionStatus: document.getElementById("connectionStatus"),
  candVal: document.getElementById("candVal"),
  liveVal: document.getElementById("liveVal"),
  downVal: document.getElementById("downVal"),
  grid: document.getElementById("grid"),
  emptyHint: document.getElementById("emptyHint"),
  logBody: document.getElementById("logBody"),
  tileTemplate: document.getElementById("tileTemplate"),
};

const params = new URLSearchParams(location.search);
const ICE_SERVERS = params.has("stun") ? [{ urls: "stun:stun.l.google.com:19302" }] : [];

const peerId = sessionStorage.getItem("poc5-proctor-id") || `proc-${Math.random().toString(36).slice(2, 10)}`;
sessionStorage.setItem("poc5-proctor-id", peerId);

// candidateId -> tile state
const tiles = new Map();

// --- signaling ---------------------------------------------------------------

let postChain = Promise.resolve();
function signal(to, type, payload) {
  postChain = postChain
    .then(() =>
      fetch("/signal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from: peerId, to, type, payload }),
      })
    )
    .catch((err) => console.warn("signal failed", err));
  return postChain;
}

function connect() {
  const source = new EventSource(`/signal/stream?role=proctor&id=${peerId}&name=Proctor`);
  source.addEventListener("open", () => setStatus(els.connectionStatus, "present", "✅ Connected"));
  source.onerror = () => setStatus(els.connectionStatus, "warning", "⚠ Reconnecting…");

  source.addEventListener("backlog", (e) => {
    const candidates = JSON.parse(e.data);
    // A reconnect (e.g. server restart) re-sends the full list. Media is
    // peer-to-peer and survives a signaling outage, so a tile whose video is still
    // live is kept even if its candidate hasn't re-registered with the server yet.
    const ids = new Set(candidates.map((c) => c.id));
    for (const [id, tile] of [...tiles]) if (!ids.has(id) && !isLive(tile)) removeTile(id);
    candidates.forEach((c) => upsertCandidate(c));
  });
  source.addEventListener("peer-joined", (e) => upsertCandidate(JSON.parse(e.data)));
  source.addEventListener("peer-left", (e) => {
    const { id } = JSON.parse(e.data);
    const tile = tiles.get(id);
    if (tile) logEvent(tile.name, "CANDIDATE_DISCONNECTED", "Candidate page closed or lost connection", null);
    removeTile(id);
  });
  source.addEventListener("status", (e) => {
    const { id, status, event } = JSON.parse(e.data);
    const tile = tiles.get(id);
    if (!tile) return;
    applyStatus(tile, status);
    if (event) logEvent(tile.name, event.event_type, event.detail, event.server_received_at - event.client_sent_at);
  });
  source.addEventListener("offer", (e) => handleOffer(JSON.parse(e.data)));
  source.addEventListener("ice", (e) => handleIce(JSON.parse(e.data)));
  source.addEventListener("hangup", (e) => handleHangup(JSON.parse(e.data).from));
}

// --- tiles -------------------------------------------------------------------

function upsertCandidate(c) {
  let tile = tiles.get(c.id);
  if (!tile) {
    const el = els.tileTemplate.content.firstElementChild.cloneNode(true);
    tile = {
      id: c.id,
      name: c.name,
      el,
      video: el.querySelector("video"),
      state: el.querySelector(".tile-state"),
      stats: Object.fromEntries([...el.querySelectorAll("dd[data-k]")].map((dd) => [dd.dataset.k, dd])),
      status: { sharing: false },
      pc: null,
      pendingIce: [],
      requestedShareId: null,
      retries: 0,
      prevStats: null,
      kbps: 0,
      g2g: [],
      lastProbe: null,
      probeMisses: 0,
      probeGen: 0,
    };
    el.querySelector(".tile-name").textContent = c.name;
    el.querySelector(".tile-video").addEventListener("click", () => {
      if (tile.video.srcObject) tile.video.requestFullscreen?.();
    });
    els.grid.appendChild(el);
    tiles.set(c.id, tile);
    applyStatus(tile, c.status);
  } else if (!isLive(tile)) {
    applyStatus(tile, c.status);
  }
  // else: a live tile re-joining after a signaling reconnect. The server's copy of
  // its status was reset, so wait for the candidate's own status message rather
  // than tearing the working connection down.
  renderCounts();
}

function isLive(tile) {
  return ["connected", "connecting"].includes(tile.pc?.connectionState);
}

function removeTile(id) {
  const tile = tiles.get(id);
  if (!tile) return;
  closePc(tile);
  tile.el.remove();
  tiles.delete(id);
  renderCounts();
}

function applyStatus(tile, status) {
  tile.status = status || { sharing: false };
  const s = tile.status;
  tile.stats.surface.textContent = s.sharing ? s.surface : "–";
  tile.stats.monitors.textContent = describeMonitors(s.monitors);
  tile.el.classList.toggle("multi-monitor", !!s.monitors?.extended);

  if (!s.sharing) {
    closePc(tile);
    tile.requestedShareId = null;
    setStatus(tile.state, "warning", "Not sharing");
    return;
  }
  if (tile.requestedShareId !== s.share_id) {
    // New share (first share, or candidate re-picked a screen): (re)connect.
    closePc(tile);
    tile.retries = 0;
    requestView(tile);
  }
}

function describeMonitors(m) {
  if (!m) return "–";
  let text = m.extended === null ? "unknown" : m.extended ? "⚠ multiple" : "single";
  if (m.count) text = `${m.extended ? "⚠ " : ""}${m.count} connected`;
  if (m.shared_label) text += ` (sharing ${m.shared_label})`;
  return text;
}

function requestView(tile) {
  tile.requestedShareId = tile.status.share_id;
  setStatus(tile.state, "idle", "Connecting…");
  signal(tile.id, "view-request", { share_id: tile.status.share_id });
}

// --- WebRTC ------------------------------------------------------------------

async function handleOffer({ from, payload }) {
  const tile = tiles.get(from);
  if (!tile || payload.share_id !== tile.requestedShareId) return;
  closePc(tile);

  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  tile.pc = pc;
  tile.connectStartedAt = performance.now();
  pc.ontrack = (e) => {
    tile.video.srcObject = e.streams[0] || new MediaStream([e.track]);
    tile.el.classList.add("live");
    tile.probeMisses = 0;
    startProbeReader(tile);
  };
  pc.onicecandidate = (e) => {
    if (e.candidate) signal(from, "ice", e.candidate.toJSON());
  };
  pc.onconnectionstatechange = () => {
    const st = pc.connectionState;
    if (st === "connected") {
      tile.retries = 0;
      const ms = performance.now() - tile.connectStartedAt;
      setStatus(tile.state, "present", `● Live (${ms.toFixed(0)} ms to connect)`);
    } else if (st === "failed") {
      setStatus(tile.state, "alert", "✖ Connection failed");
      retry(tile);
    } else if (st === "disconnected") {
      setStatus(tile.state, "warning", "⚠ Connection interrupted");
    }
    renderCounts();
  };

  await pc.setRemoteDescription(payload.sdp);
  await pc.setLocalDescription(await pc.createAnswer());
  signal(from, "answer", { sdp: pc.localDescription.toJSON() });
  for (const c of tile.pendingIce.splice(0)) await pc.addIceCandidate(c).catch(() => {});
}

async function handleIce({ from, payload }) {
  const tile = tiles.get(from);
  if (!tile) return;
  if (tile.pc?.remoteDescription) await tile.pc.addIceCandidate(payload).catch(() => {});
  else tile.pendingIce.push(payload);
}

function handleHangup(from) {
  const tile = tiles.get(from);
  if (!tile) return;
  closePc(tile);
  // Candidate dropped the connection but still says it's sharing (e.g. its side of
  // the connection failed) — ask again, a few times.
  if (tile.status.sharing) retry(tile);
}

function retry(tile) {
  closePc(tile);
  if (tile.retries >= 3 || !tile.status.sharing) return;
  tile.retries += 1;
  setTimeout(() => {
    if (tile.status.sharing && !tile.pc) requestView(tile);
  }, 1000 * tile.retries);
}

function closePc(tile) {
  if (tile.pc) tile.pc.close();
  tile.pc = null;
  tile.pendingIce = [];
  tile.prevStats = null;
  tile.kbps = 0;
  tile.g2g = [];
  tile.lastProbe = null;
  tile.probeGen += 1;
  tile.video.srcObject = null;
  tile.el.classList.remove("live");
  for (const k of ["res", "fps", "kbps", "rtt", "jitter", "decode", "loss", "g2g"]) tile.stats[k].textContent = "–";
  renderCounts();
}

// --- stats -------------------------------------------------------------------

async function pollStats() {
  for (const tile of tiles.values()) {
    if (!tile.pc) continue;
    const report = await tile.pc.getStats().catch(() => null);
    if (!report) continue;
    let inbound = null;
    let rtt = null;
    report.forEach((s) => {
      if (s.type === "inbound-rtp" && s.kind === "video") inbound = s;
      if (s.type === "candidate-pair" && s.nominated && s.state === "succeeded" && s.currentRoundTripTime != null) {
        rtt = s.currentRoundTripTime * 1000;
      }
    });
    if (!inbound) continue;
    const prev = tile.prevStats;
    const st = tile.stats;
    st.res.textContent = inbound.frameWidth ? `${inbound.frameWidth}×${inbound.frameHeight}` : "–";
    st.fps.textContent = inbound.framesPerSecond != null ? inbound.framesPerSecond.toFixed(1) : "0";
    if (prev) {
      const dt = (inbound.timestamp - prev.timestamp) / 1000;
      tile.kbps = ((inbound.bytesReceived - prev.bytesReceived) * 8) / 1000 / dt;
      st.kbps.textContent = `${tile.kbps.toFixed(0)} kbps`;
      const emitted = inbound.jitterBufferEmittedCount - prev.jitterBufferEmittedCount;
      if (emitted > 0) {
        st.jitter.textContent = `${(((inbound.jitterBufferDelay - prev.jitterBufferDelay) / emitted) * 1000).toFixed(0)} ms`;
      }
      const decoded = inbound.framesDecoded - prev.framesDecoded;
      if (decoded > 0) {
        st.decode.textContent = `${(((inbound.totalDecodeTime - prev.totalDecodeTime) / decoded) * 1000).toFixed(1)} ms`;
      }
    }
    st.rtt.textContent = rtt != null ? `${rtt.toFixed(1)} ms` : "–";
    st.loss.textContent = `${inbound.freezeCount ?? "?"} / ${inbound.packetsLost ?? 0}`;
    tile.prevStats = inbound;
  }
  renderCounts();
}
setInterval(pollStats, 1000);

// --- glass-to-glass latency (decodes candidate.js's probe) -------------------
// Probe layout: [red][green][blue][24 bits MSB-first], square cells. Value =
// candidate's Date.now() mod 2^24 at paint time. Only meaningful when both pages
// share a clock (same machine, or NTP-synced machines — skew adds directly).

const PROBE_BITS = 24;
const PROBE_MOD = 2 ** PROBE_BITS;

// Started once per received track; a newer track (or closing the connection)
// bumps probeGen, which ends the previous loop.
function startProbeReader(tile) {
  const gen = ++tile.probeGen;
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  let lastRun = 0;

  const onFrame = (now, meta) => {
    if (tiles.get(tile.id) !== tile || tile.probeGen !== gen || !tile.video.srcObject) return;
    // Back off when no probe is visible, so idle scanning stays cheap.
    const interval = tile.probeMisses > 5 ? 3000 : 500;
    if (tile.video.videoWidth && now - lastRun > interval) {
      lastRun = now;
      // Wall-clock time this frame is (expected to be) on screen.
      const displayedAt = Date.now() + ((meta?.expectedDisplayTime ?? now) - performance.now());
      readProbe(tile, canvas, ctx, displayedAt);
    }
    schedule();
  };
  const schedule = () => {
    if ("requestVideoFrameCallback" in HTMLVideoElement.prototype) {
      tile.video.requestVideoFrameCallback(onFrame);
    } else {
      setTimeout(() => onFrame(performance.now(), null), 250);
    }
  };
  schedule();
}

function readProbe(tile, canvas, ctx, displayedAt) {
  const w = tile.video.videoWidth;
  const h = tile.video.videoHeight;
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  ctx.drawImage(tile.video, 0, 0, w, h);
  const value = decodeProbe(ctx.getImageData(0, 0, w, h).data, w, h);
  const st = tile.stats.g2g;
  if (value == null) {
    tile.probeMisses += 1;
    if (tile.probeMisses > 5) st.textContent = "no probe visible";
    return;
  }
  tile.probeMisses = 0;
  if (value === tile.lastProbe) {
    // Same painted value as last time: the candidate page stopped rendering
    // (hidden/minimised/background tab) so the number would be meaningless.
    st.textContent = "probe frozen (candidate page not visible?)";
    return;
  }
  tile.lastProbe = value;
  const latency = (((displayedAt % PROBE_MOD) - value) % PROBE_MOD + PROBE_MOD) % PROBE_MOD;
  if (latency > 10000) return; // implausible — a misread, not a measurement
  tile.g2g.push(latency);
  while (tile.g2g.length > 20) tile.g2g.shift();
  const sorted = [...tile.g2g].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  st.textContent = `${latency.toFixed(0)} ms (median ${median.toFixed(0)}, min ${sorted[0].toFixed(0)}, n=${sorted.length})`;
}

function decodeProbe(d, w, h) {
  const at = (x, y) => (y * w + x) * 4;
  const px = (x, y) => {
    // 3×3 average around the sample point smooths compression noise.
    let r = 0, g = 0, b = 0, n = 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const xx = Math.min(w - 1, Math.max(0, x + dx));
        const yy = Math.min(h - 1, Math.max(0, y + dy));
        const i = at(xx, yy);
        r += d[i]; g += d[i + 1]; b += d[i + 2]; n++;
      }
    }
    return [r / n, g / n, b / n];
  };
  const isRed = (x, y) => {
    const i = at(x, y);
    return d[i] > 200 && d[i + 1] < 60 && d[i + 2] < 60;
  };

  const boxes = [];
  let best = null;
  let attempts = 0;
  for (let y = 0; y < h; y += 2) {
    for (let x = 0; x < w; x += 2) {
      if (!isRed(x, y)) continue;
      const box = boxes.find((b) => x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1);
      if (box) {
        x = box.x1;
        continue;
      }
      if (++attempts > 200) return best?.value ?? null;

      // Vertical extent of the red cell, then horizontal extent at its centre row.
      let y0 = y, y1 = y;
      while (y1 < h - 1 && isRed(x, y1 + 1)) y1++;
      while (y0 > 0 && isRed(x, y0 - 1)) y0--;
      const cy = (y0 + y1) >> 1;
      let x0 = x, x1 = x;
      while (x0 > 0 && isRed(x0 - 1, cy)) x0--;
      while (x1 < w - 1 && isRed(x1 + 1, cy)) x1++;
      boxes.push({ x0, x1, y0, y1 });
      const pitch = x1 - x0 + 1;
      if (pitch < 4 || x0 + pitch * (3 + PROBE_BITS) > w) continue;

      const cx = (i) => Math.round(x0 + pitch * (i + 0.5));
      const [gr, gg, gb] = px(cx(1), cy);
      const [br, bg, bb] = px(cx(2), cy);
      if (!(gg > 150 && gr < 100 && gb < 100 && bb > 150 && br < 100 && bg < 100)) continue;

      let value = 0;
      for (let i = 0; i < PROBE_BITS; i++) {
        const [r, g, b] = px(cx(3 + i), cy);
        value = value * 2 + (0.299 * r + 0.587 * g + 0.114 * b > 128 ? 1 : 0);
      }
      // Largest probe wins: when the proctor window is itself on the shared screen,
      // smaller (older) nested copies of the probe show up inside it.
      if (!best || pitch > best.pitch) best = { value, pitch };
    }
  }
  return best?.value ?? null;
}

// --- UI ----------------------------------------------------------------------

function renderCounts() {
  els.candVal.textContent = String(tiles.size);
  const live = [...tiles.values()].filter((t) => t.pc?.connectionState === "connected");
  els.liveVal.textContent = String(live.length);
  const kbps = live.reduce((sum, t) => sum + t.kbps, 0);
  els.downVal.textContent = live.length ? `${kbps.toFixed(0)} kbps` : "–";
  els.emptyHint.hidden = tiles.size > 0;
}

function logEvent(candidate, eventType, detail, deliveryMs) {
  const row = document.createElement("tr");
  const alerting = ["SCREEN_SHARE_STOPPED", "WRONG_SURFACE", "MULTIPLE_MONITORS", "MONITOR_CONFIG_CHANGED", "SCREEN_SHARE_DENIED", "CANDIDATE_DISCONNECTED"];
  if (alerting.includes(eventType)) row.className = "alert-row";
  const cells = [
    new Date().toLocaleTimeString(),
    candidate,
    eventType,
    detail,
    deliveryMs != null ? `${deliveryMs} ms` : "–",
  ];
  cells.forEach((text) => {
    const td = document.createElement("td");
    td.textContent = text;
    row.appendChild(td);
  });
  els.logBody.prepend(row);
}

function setStatus(el, cls, text) {
  el.className = `${el.classList.contains("tile-state") ? "tile-state " : ""}live-status ${cls}`;
  el.textContent = text;
}

renderCounts();
connect();
