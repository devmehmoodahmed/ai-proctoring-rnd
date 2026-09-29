// POC #5 — candidate side. Captures the screen with getDisplayMedia(), enforces
// "entire screen" (rejects a window/tab pick), reports share/monitor events, and
// streams the screen peer-to-peer over WebRTC to every proctor that asks to view it.
// The signaling server never sees video. See README.md.

const els = {
  cfgName: document.getElementById("cfgName"),
  cfgProfile: document.getElementById("cfgProfile"),
  cfgRequireMonitor: document.getElementById("cfgRequireMonitor"),
  cfgProbe: document.getElementById("cfgProbe"),
  shareBtn: document.getElementById("shareBtn"),
  stopBtn: document.getElementById("stopBtn"),
  screensBtn: document.getElementById("screensBtn"),
  shareStatus: document.getElementById("shareStatus"),
  sigVal: document.getElementById("sigVal"),
  viewersVal: document.getElementById("viewersVal"),
  surfaceVal: document.getElementById("surfaceVal"),
  resVal: document.getElementById("resVal"),
  monitorsVal: document.getElementById("monitorsVal"),
  upVal: document.getElementById("upVal"),
  fpsVal: document.getElementById("fpsVal"),
  encVal: document.getElementById("encVal"),
  limitVal: document.getElementById("limitVal"),
  preview: document.getElementById("preview"),
  logBody: document.getElementById("logBody"),
  probe: document.getElementById("latencyProbe"),
};

// Screen content is mostly static text, so frame rate is traded away before
// resolution — a proctor needs to read the screen, not watch smooth motion.
const PROFILES = {
  low: { frameRate: 1, maxBitrate: 300_000, maxWidth: 1280 },
  balanced: { frameRate: 5, maxBitrate: 1_000_000, maxWidth: 1920 },
  high: { frameRate: 15, maxBitrate: 2_500_000, maxWidth: 1920 },
};

const params = new URLSearchParams(location.search);
// No STUN/TURN by default: same-machine and same-LAN tests connect on host
// candidates alone. ?stun=1 adds a public STUN server for cross-network tries.
// Production needs a TURN server too — see README "Architecture implications".
const ICE_SERVERS = params.has("stun") ? [{ urls: "stun:stun.l.google.com:19302" }] : [];
// Automated-test hook only (see README): share this tab instead of a monitor, so a
// headless browser can run the whole flow without a real screen picker.
const TEST_SELF_TAB = params.get("test") === "self-tab";

const peerId = sessionStorage.getItem("poc5-candidate-id") || `cand-${Math.random().toString(36).slice(2, 10)}`;
sessionStorage.setItem("poc5-candidate-id", peerId);

let source = null;
let stream = null;
let track = null;
let shareId = null;
let status = { sharing: false };
let screenDetails = null;
const pcs = new Map(); // proctorId -> { pc, sender, pendingIce, prevStats }

// --- signaling ---------------------------------------------------------------

// Every POST goes through one chain so offers/answers/ICE reach the server (and
// therefore the other peer) in the order they were sent.
let postChain = Promise.resolve();
function post(url, body) {
  postChain = postChain
    .then(() =>
      fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
    )
    .catch((err) => console.warn("POST failed", url, err));
  return postChain;
}

function signal(to, type, payload) {
  return post("/signal", { from: peerId, to, type, payload });
}

function publishStatus(event) {
  return post("/status", { from: peerId, status, event });
}

function connect() {
  if (source) source.close();
  const name = encodeURIComponent(els.cfgName.value.trim() || "Candidate");
  source = new EventSource(`/signal/stream?role=candidate&id=${peerId}&name=${name}`);
  source.addEventListener("open", () => {
    setMetric(els.sigVal, "Connected");
    // Re-announce current state: covers a server restart, which forgets everyone.
    publishStatus(null);
  });
  source.onerror = () => setMetric(els.sigVal, "Reconnecting…");
  source.addEventListener("view-request", (e) => handleViewRequest(JSON.parse(e.data)));
  source.addEventListener("answer", (e) => handleAnswer(JSON.parse(e.data)));
  source.addEventListener("ice", (e) => handleIce(JSON.parse(e.data)));
  source.addEventListener("hangup", (e) => closePeer(JSON.parse(e.data).from));
}

// --- capture -----------------------------------------------------------------

function currentProfile() {
  return PROFILES[els.cfgProfile.value];
}

async function startShare() {
  const requireMonitor = els.cfgRequireMonitor.checked;
  const profile = currentProfile();
  const options = {
    video: {
      displaySurface: "monitor", // a hint only: pre-selects the "Entire screen" pane in Chrome/Edge
      frameRate: { ideal: profile.frameRate, max: 15 },
    },
    audio: false,
    // Chrome/Edge-only hints; other browsers ignore unknown keys.
    monitorTypeSurfaces: "include",
    selfBrowserSurface: TEST_SELF_TAB ? "include" : "exclude",
    surfaceSwitching: "exclude", // no "share this tab instead" button mid-exam
    systemAudio: "exclude",
    preferCurrentTab: TEST_SELF_TAB,
  };

  let newStream;
  try {
    newStream = await navigator.mediaDevices.getDisplayMedia(options);
  } catch (err) {
    // NotAllowedError covers both "user cancelled the picker" and "OS-level screen
    // recording permission missing" (macOS) — the browser doesn't let us tell them apart.
    logEvent("SCREEN_SHARE_DENIED", `${err.name}: ${err.message}`);
    setShareStatus("alert", "✖ Share denied / cancelled");
    return;
  }

  const newTrack = newStream.getVideoTracks()[0];
  const settings = newTrack.getSettings();
  const surface = settings.displaySurface || "unknown";

  // displaySurface in the request is only a hint — the candidate can still pick a
  // window or tab. The only enforcement point is checking what they actually picked.
  if (requireMonitor && surface !== "monitor" && surface !== "unknown") {
    newTrack.stop();
    logEvent("WRONG_SURFACE", `Candidate picked a "${surface}", entire screen required — share rejected`);
    setShareStatus("alert", `✖ You shared a ${surface} — please share your entire screen`);
    return;
  }
  if (surface === "unknown") {
    logEvent("SURFACE_UNVERIFIED", "Browser does not report which surface was picked");
  }

  if (track) teardownShare(null); // replacing an existing share
  stream = newStream;
  track = newTrack;
  shareId = `share-${Date.now()}`;
  // "detail" tells the encoder this is text-heavy content: keep it sharp and drop
  // frames under pressure rather than blurring.
  track.contentHint = "detail";
  els.preview.srcObject = stream;

  track.addEventListener("ended", () => {
    // Fires when the candidate clicks the browser's own "Stop sharing" control, or
    // the captured monitor disappears (unplugged). The page cannot prevent this.
    teardownShare({
      event_type: "SCREEN_SHARE_STOPPED",
      detail: "Stopped from the browser's sharing control (or the shared screen went away)",
    });
  });
  track.addEventListener("mute", () => logEvent("SCREEN_SHARE_PAUSED", "Capture muted by the browser/OS (no frames arriving)"));
  track.addEventListener("unmute", () => logEvent("SCREEN_SHARE_RESUMED", "Capture unmuted"));

  status = {
    sharing: true,
    share_id: shareId,
    surface,
    width: settings.width,
    height: settings.height,
    profile: els.cfgProfile.value,
    monitors: monitorSummary(settings),
  };
  renderShareInfo();
  setShareStatus("present", "● Sharing — proctors can view your screen");
  els.shareBtn.textContent = "Share a different screen";
  els.stopBtn.disabled = false;
  logEvent("SCREEN_SHARE_STARTED", `${surface} ${settings.width}×${settings.height}`);

  if (status.monitors.extended) {
    logEvent(
      "MULTIPLE_MONITORS",
      `Another monitor is connected — only one screen is being shared${
        status.monitors.count ? ` (${status.monitors.count} screens)` : ""
      }`
    );
  }
}

function teardownShare(event) {
  for (const id of [...pcs.keys()]) closePeer(id, true);
  if (track) {
    track.stop();
    track = null;
  }
  stream = null;
  shareId = null;
  els.preview.srcObject = null;
  status = { sharing: false };
  renderShareInfo();
  setShareStatus("warning", "⚠ Not sharing — the proctor has been notified");
  els.shareBtn.textContent = "Share entire screen";
  els.stopBtn.disabled = true;
  if (event) logEvent(event.event_type, event.detail);
  else publishStatus(null);
}

// --- multiple monitors -------------------------------------------------------

function monitorSummary(settings) {
  const summary = {
    // Window Management API (Chromium). Readable without a permission prompt.
    extended: "isExtended" in screen ? screen.isExtended : null,
    count: null,
    shared_label: null,
  };
  if (screenDetails) {
    summary.count = screenDetails.screens.length;
    summary.shared_label = matchSharedScreen(settings);
  }
  return summary;
}

// Guess which physical screen was picked by comparing the captured frame size to
// each screen's size (physical or logical pixels — browsers differ).
function matchSharedScreen(settings) {
  if (!screenDetails || !settings?.width) return null;
  const close = (a, b) => Math.abs(a - b) / b < 0.02;
  for (const s of screenDetails.screens) {
    const dpr = s.devicePixelRatio || 1;
    if (
      (close(settings.width, s.width * dpr) && close(settings.height, s.height * dpr)) ||
      (close(settings.width, s.width) && close(settings.height, s.height))
    ) {
      return s.label || (s.isPrimary ? "primary screen" : "secondary screen");
    }
  }
  return "no exact size match";
}

async function detectScreens() {
  if (!("getScreenDetails" in window)) {
    logEvent("MONITORS_UNAVAILABLE", "Window Management API not supported in this browser");
    return;
  }
  try {
    screenDetails = await window.getScreenDetails();
  } catch (err) {
    logEvent("MONITORS_UNAVAILABLE", `Permission denied: ${err.message}`);
    return;
  }
  screenDetails.addEventListener("screenschange", () => {
    logEvent("MONITOR_CONFIG_CHANGED", `${screenDetails.screens.length} screen(s) now connected`);
    refreshMonitorStatus();
  });
  logEvent(
    "MONITORS_DETECTED",
    screenDetails.screens.map((s) => `${s.label || "screen"} ${s.width}×${s.height}@${s.devicePixelRatio}x`).join(", ")
  );
  refreshMonitorStatus();
}

function refreshMonitorStatus() {
  const settings = track?.getSettings();
  status.monitors = monitorSummary(settings);
  renderShareInfo();
  publishStatus(null);
}

// Fires when a monitor is plugged in/out (isExtended flips) even without the
// getScreenDetails permission.
if ("isExtended" in screen && "addEventListener" in screen) {
  screen.addEventListener("change", () => {
    if (!status.sharing) return renderShareInfo();
    const before = status.monitors?.extended;
    refreshMonitorStatus();
    if (status.monitors.extended !== before) {
      logEvent(
        "MONITOR_CONFIG_CHANGED",
        status.monitors.extended ? "A second monitor was connected mid-share" : "Now a single monitor"
      );
    }
  });
}

// --- WebRTC (one RTCPeerConnection per viewing proctor) ----------------------

function encodingFor(profile) {
  const width = track?.getSettings().width || profile.maxWidth;
  return {
    maxBitrate: profile.maxBitrate,
    maxFramerate: profile.frameRate,
    scaleResolutionDownBy: Math.max(1, width / profile.maxWidth),
  };
}

async function handleViewRequest({ from, payload }) {
  // The proctor re-requests whenever our status says we're sharing, so a request
  // that arrives while we're not sharing (or for an older share) can be ignored.
  if (!track || payload?.share_id !== shareId) return;
  closePeer(from, true);

  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  const entry = { pc, sender: null, pendingIce: [], prevStats: null };
  pcs.set(from, entry);

  const tx = pc.addTransceiver(track, {
    direction: "sendonly",
    streams: [stream],
    sendEncodings: [encodingFor(currentProfile())],
  });
  entry.sender = tx.sender;

  pc.onicecandidate = (e) => {
    if (e.candidate) signal(from, "ice", e.candidate.toJSON());
  };
  pc.onconnectionstatechange = () => {
    if (["failed", "closed"].includes(pc.connectionState)) closePeer(from, true);
    renderViewers();
  };

  await pc.setLocalDescription(await pc.createOffer());
  signal(from, "offer", { sdp: pc.localDescription.toJSON(), share_id: shareId });
  renderViewers();
}

async function handleAnswer({ from, payload }) {
  const entry = pcs.get(from);
  if (!entry) return;
  await entry.pc.setRemoteDescription(payload.sdp);
  for (const c of entry.pendingIce.splice(0)) await entry.pc.addIceCandidate(c).catch(() => {});
  // Under bandwidth/CPU pressure, keep the text readable and drop frames instead.
  try {
    const p = entry.sender.getParameters();
    p.degradationPreference = "maintain-resolution";
    await entry.sender.setParameters(p);
  } catch {
    /* not supported everywhere — the default ("balanced") is acceptable */
  }
}

async function handleIce({ from, payload }) {
  const entry = pcs.get(from);
  if (!entry) return;
  if (entry.pc.remoteDescription) await entry.pc.addIceCandidate(payload).catch(() => {});
  else entry.pendingIce.push(payload);
}

function closePeer(proctorId, notify = false) {
  const entry = pcs.get(proctorId);
  if (!entry) return;
  pcs.delete(proctorId);
  entry.pc.close();
  if (notify) signal(proctorId, "hangup", {});
  renderViewers();
}

async function applyProfile() {
  const profile = currentProfile();
  status.profile = els.cfgProfile.value;
  if (!track) return;
  await track.applyConstraints({ frameRate: { ideal: profile.frameRate, max: 15 } }).catch(() => {});
  for (const entry of pcs.values()) {
    try {
      const p = entry.sender.getParameters();
      Object.assign(p.encodings[0], encodingFor(profile));
      await entry.sender.setParameters(p);
    } catch (err) {
      console.warn("setParameters failed", err);
    }
  }
  logEvent("QUALITY_PROFILE_CHANGED", els.cfgProfile.selectedOptions[0].textContent);
}

// --- stats -------------------------------------------------------------------

async function pollStats() {
  let kbps = 0;
  let fps = null;
  let encMs = null;
  let limit = null;
  for (const entry of pcs.values()) {
    if (!entry.sender) continue;
    const report = await entry.sender.getStats().catch(() => null);
    if (!report) continue;
    report.forEach((s) => {
      if (s.type !== "outbound-rtp" || s.kind !== "video") return;
      const prev = entry.prevStats;
      if (prev) {
        const dt = (s.timestamp - prev.timestamp) / 1000;
        kbps += ((s.bytesSent - prev.bytesSent) * 8) / 1000 / dt;
        const frames = s.framesEncoded - prev.framesEncoded;
        if (frames > 0) encMs = ((s.totalEncodeTime - prev.totalEncodeTime) / frames) * 1000;
        fps = (frames / dt).toFixed(1);
      }
      limit = s.qualityLimitationReason;
      entry.prevStats = s;
    });
  }
  const active = pcs.size > 0;
  setMetric(els.upVal, active ? `${kbps.toFixed(0)} kbps` : "–");
  setMetric(els.fpsVal, active && fps != null ? fps : "–");
  setMetric(els.encVal, active && encMs != null ? `${encMs.toFixed(1)} ms` : "–");
  setMetric(els.limitVal, active && limit ? limit : "–");
}
setInterval(pollStats, 1000);

// --- latency probe -----------------------------------------------------------
// Layout (must match proctor.js): [red][green][blue][24 bits, MSB first], each cell
// PROBE_CELL CSS px square. Value = Date.now() mod 2^24 (wraps every ~4.66 hours).

const PROBE_CELL = 16;
const PROBE_BITS = 24;
function drawProbe() {
  if (!els.cfgProbe.checked) return;
  const ctx = els.probe.getContext("2d");
  const colors = ["#ff0000", "#00ff00", "#0000ff"];
  colors.forEach((c, i) => {
    ctx.fillStyle = c;
    ctx.fillRect(i * PROBE_CELL, 0, PROBE_CELL, PROBE_CELL);
  });
  const v = Date.now() % 2 ** PROBE_BITS;
  for (let i = 0; i < PROBE_BITS; i++) {
    ctx.fillStyle = (v >> (PROBE_BITS - 1 - i)) & 1 ? "#ffffff" : "#000000";
    ctx.fillRect((3 + i) * PROBE_CELL, 0, PROBE_CELL, PROBE_CELL);
  }
  requestAnimationFrame(drawProbe);
}
function toggleProbe() {
  els.probe.width = (3 + PROBE_BITS) * PROBE_CELL;
  els.probe.height = PROBE_CELL;
  els.probe.hidden = !els.cfgProbe.checked;
  if (els.cfgProbe.checked) requestAnimationFrame(drawProbe);
}

// --- UI ----------------------------------------------------------------------

function renderShareInfo() {
  setMetric(els.surfaceVal, status.sharing ? status.surface : "–");
  setMetric(els.resVal, status.sharing ? `${status.width}×${status.height}` : "–");
  const m = status.monitors || monitorSummary(null);
  let text = m.extended === null ? "unknown (API unsupported)" : m.extended ? "multiple" : "single";
  if (m.count) text = `${m.count} connected`;
  if (m.shared_label) text += ` — sharing: ${m.shared_label}`;
  setMetric(els.monitorsVal, text);
}

function renderViewers() {
  const n = [...pcs.values()].filter((e) => e.pc.connectionState === "connected").length;
  // Always tell the candidate when someone is actually watching.
  setMetric(els.viewersVal, String(n));
}

function logEvent(eventType, detail) {
  const row = document.createElement("tr");
  const cells = [new Date().toLocaleTimeString(), eventType, detail];
  cells.forEach((text) => {
    const td = document.createElement("td");
    td.textContent = text;
    row.appendChild(td);
  });
  els.logBody.prepend(row);
  publishStatus({ event_type: eventType, detail, client_sent_at: Date.now() });
}

function setShareStatus(cls, text) {
  els.shareStatus.className = `live-status ${cls}`;
  els.shareStatus.textContent = text;
}

function setMetric(el, text) {
  el.textContent = text;
}

els.shareBtn.addEventListener("click", startShare);
els.stopBtn.addEventListener("click", () =>
  teardownShare({ event_type: "SCREEN_SHARE_STOPPED", detail: "Stopped from the page's Stop button" })
);
els.screensBtn.addEventListener("click", detectScreens);
els.cfgProfile.addEventListener("change", applyProfile);
els.cfgProbe.addEventListener("change", toggleProbe);
els.cfgName.addEventListener("change", connect);

if (!navigator.mediaDevices?.getDisplayMedia) {
  els.shareBtn.disabled = true;
  setShareStatus("alert", "✖ getDisplayMedia() not available (needs HTTPS or localhost, desktop browser)");
}
if (TEST_SELF_TAB) {
  // A tab is not a monitor, so the check would (correctly) reject it; the test
  // turns it back on deliberately to exercise the WRONG_SURFACE path.
  els.cfgRequireMonitor.checked = false;
  els.cfgProbe.checked = true;
}
toggleProbe();
renderShareInfo();
connect();
