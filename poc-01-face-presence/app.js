// POC #1 — Face presence / out-of-frame / multiple-face detection.
// Standalone prototype: all inference runs in this tab via MediaPipe Tasks Vision
// (WASM). No frame or image is ever sent to a server. See README.md.

import {
  FaceDetector,
  FilesetResolver,
} from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/vision_bundle.mjs";

const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite";
const WASM_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm";
const STORAGE_KEY = "poc1_face_presence_events";

const els = {
  video: document.getElementById("video"),
  overlay: document.getElementById("overlay"),
  startBtn: document.getElementById("startBtn"),
  stopBtn: document.getElementById("stopBtn"),
  liveStatus: document.getElementById("liveStatus"),
  fpsVal: document.getElementById("fpsVal"),
  latencyVal: document.getElementById("latencyVal"),
  faceCountVal: document.getElementById("faceCountVal"),
  confidenceVal: document.getElementById("confidenceVal"),
  eventTableBody: document.getElementById("eventTableBody"),
  exportBtn: document.getElementById("exportBtn"),
  clearLogBtn: document.getElementById("clearLogBtn"),
  cfgMinConfidence: document.getElementById("cfgMinConfidence"),
  cfgMinConfidenceVal: document.getElementById("cfgMinConfidenceVal"),
  cfgRaiseMs: document.getElementById("cfgRaiseMs"),
  cfgClearMs: document.getElementById("cfgClearMs"),
  cfgEdgeMargin: document.getElementById("cfgEdgeMargin"),
  cfgTooFar: document.getElementById("cfgTooFar"),
};

const ctx = els.overlay.getContext("2d");

let faceDetector = null;
let stream = null;
let rafId = null;
let running = false;

// Persistence ("debounce with grace period") state machine.
let raiseStreakStart = null;
let raiseStreakType = null;
let activeEvent = null; // { id, type, confidence, startedAt, confirmedAt, resolvedAt, durationMs, status }
let clearStreakStart = null;

// Rolling perf metrics.
const frameTimes = [];
const latencySamples = [];

let events = loadEvents();
renderEventTable();

if (!window.isSecureContext) {
  els.liveStatus.textContent =
    "This page must be served over http://localhost or https:// for camera access to work (see README.md).";
  els.startBtn.disabled = true;
}

els.cfgMinConfidence.addEventListener("input", () => {
  const v = Number(els.cfgMinConfidence.value);
  els.cfgMinConfidenceVal.textContent = v.toFixed(2);
  if (faceDetector) faceDetector.setOptions({ minDetectionConfidence: v });
});

els.startBtn.addEventListener("click", start);
els.stopBtn.addEventListener("click", stop);
els.exportBtn.addEventListener("click", exportEvents);
els.clearLogBtn.addEventListener("click", clearEvents);

async function ensureDetector() {
  if (faceDetector) return faceDetector;
  const vision = await FilesetResolver.forVisionTasks(WASM_URL);
  const minDetectionConfidence = Number(els.cfgMinConfidence.value);
  try {
    faceDetector = await FaceDetector.createFromOptions(vision, {
      baseOptions: { modelAssetPath: MODEL_URL, delegate: "GPU" },
      runningMode: "VIDEO",
      minDetectionConfidence,
    });
  } catch (err) {
    console.warn("GPU delegate unavailable, falling back to CPU", err);
    faceDetector = await FaceDetector.createFromOptions(vision, {
      baseOptions: { modelAssetPath: MODEL_URL, delegate: "CPU" },
      runningMode: "VIDEO",
      minDetectionConfidence,
    });
  }
  return faceDetector;
}

async function start() {
  els.startBtn.disabled = true;
  els.liveStatus.textContent = "Loading model…";
  try {
    await ensureDetector();
    stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 } },
      audio: false,
    });
    els.video.srcObject = stream;
    await new Promise((resolve) => {
      els.video.onloadedmetadata = () => resolve();
    });
    await els.video.play();
    els.overlay.width = els.video.videoWidth;
    els.overlay.height = els.video.videoHeight;

    running = true;
    els.stopBtn.disabled = false;
    resetStateMachine();
    rafId = requestAnimationFrame(loop);
  } catch (err) {
    console.error(err);
    els.liveStatus.textContent = `Error: ${err.message}`;
    els.liveStatus.className = "live-status idle";
    els.startBtn.disabled = false;
  }
}

function stop() {
  running = false;
  if (rafId) cancelAnimationFrame(rafId);
  if (stream) {
    stream.getTracks().forEach((t) => t.stop());
    stream = null;
  }
  if (activeEvent) resolveActiveEvent(performance.now());
  els.video.srcObject = null;
  ctx.clearRect(0, 0, els.overlay.width, els.overlay.height);
  els.startBtn.disabled = false;
  els.stopBtn.disabled = true;
  els.liveStatus.textContent = "Camera not started";
  els.liveStatus.className = "live-status idle";
  els.fpsVal.textContent = "–";
  els.latencyVal.textContent = "–";
  els.faceCountVal.textContent = "–";
  els.confidenceVal.textContent = "–";
}

function resetStateMachine() {
  raiseStreakStart = null;
  raiseStreakType = null;
  activeEvent = null;
  clearStreakStart = null;
}

function loop() {
  if (!running) return;
  const now = performance.now();
  if (els.video.readyState >= 2) {
    const t0 = performance.now();
    const result = faceDetector.detectForVideo(els.video, now);
    trackLatency(performance.now() - t0);
    trackFps(now);
    processResult(result, now);
  }
  rafId = requestAnimationFrame(loop);
}

function trackFps(now) {
  frameTimes.push(now);
  while (frameTimes.length > 30) frameTimes.shift();
  if (frameTimes.length >= 2) {
    const dt = (frameTimes[frameTimes.length - 1] - frameTimes[0]) / (frameTimes.length - 1);
    els.fpsVal.textContent = (1000 / dt).toFixed(1);
  }
}

function trackLatency(latency) {
  latencySamples.push(latency);
  while (latencySamples.length > 30) latencySamples.shift();
  const avg = latencySamples.reduce((a, b) => a + b, 0) / latencySamples.length;
  els.latencyVal.textContent = `${avg.toFixed(1)} ms`;
}

function classify(result) {
  const detections = result.detections || [];
  const count = detections.length;
  const vw = els.video.videoWidth;
  const vh = els.video.videoHeight;
  const edgeMarginPct = Number(els.cfgEdgeMargin.value) / 100;
  const tooFarRatio = Number(els.cfgTooFar.value) / 100;

  if (count === 0) return { type: "FACE_MISSING", confidence: null, detections };

  if (count > 1) {
    const conf = Math.max(...detections.map((d) => d.categories?.[0]?.score ?? 0));
    return { type: "MULTIPLE_FACES", confidence: conf, detections };
  }

  const box = detections[0].boundingBox;
  const confidence = detections[0].categories?.[0]?.score ?? null;
  const marginX = edgeMarginPct * vw;
  const marginY = edgeMarginPct * vh;
  const left = box.originX;
  const top = box.originY;
  const right = box.originX + box.width;
  const bottom = box.originY + box.height;
  const touchingEdge = left < marginX || top < marginY || right > vw - marginX || bottom > vh - marginY;
  const areaRatio = (box.width * box.height) / (vw * vh);

  if (touchingEdge) return { type: "OUT_OF_FRAME", confidence, detections };
  if (areaRatio < tooFarRatio) return { type: "TOO_FAR", confidence, detections };
  return { type: "PRESENT", confidence, detections };
}

function processResult(result, now) {
  const { type, confidence, detections } = classify(result);
  draw(detections, type);
  els.faceCountVal.textContent = String(detections.length);
  els.confidenceVal.textContent = confidence != null ? confidence.toFixed(2) : "–";

  const raiseMs = Number(els.cfgRaiseMs.value);
  const clearMs = Number(els.cfgClearMs.value);

  if (type === "PRESENT") {
    raiseStreakStart = null;
    raiseStreakType = null;

    if (activeEvent) {
      if (clearStreakStart === null) clearStreakStart = now;
      const held = now - clearStreakStart;
      if (held >= clearMs) {
        resolveActiveEvent(now);
        setLiveStatus("present", "✅ Face present");
      } else {
        setLiveStatus("clearing", `Resolving ${activeEvent.type}… ${((clearMs - held) / 1000).toFixed(1)}s`);
      }
    } else {
      setLiveStatus("present", "✅ Face present");
    }
    return;
  }

  // Any non-present frame cancels a pending "clear".
  clearStreakStart = null;

  if (activeEvent && activeEvent.type === type) {
    setLiveStatus("alert", `⚠ ${type} (confirmed ${((now - activeEvent.confirmedAt) / 1000).toFixed(1)}s ago)`);
    return;
  }

  if (activeEvent && activeEvent.type !== type) {
    // Condition changed shape (e.g. FACE_MISSING -> OUT_OF_FRAME) — close the old
    // event and start a fresh persistence window for the new classification.
    resolveActiveEvent(now);
  }

  if (raiseStreakType !== type) {
    raiseStreakType = type;
    raiseStreakStart = now;
  }

  const held = now - raiseStreakStart;
  if (held >= raiseMs) {
    activeEvent = createEvent(type, confidence, now);
    setLiveStatus("alert", `⚠ ${type} (confirmed)`);
  } else {
    setLiveStatus("warning", `${type} — confirming in ${((raiseMs - held) / 1000).toFixed(1)}s`);
  }
}

function setLiveStatus(cls, text) {
  els.liveStatus.className = `live-status ${cls}`;
  els.liveStatus.textContent = text;
}

function createEvent(type, confidence, now) {
  const ev = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    type,
    confidence: confidence != null ? Number(confidence.toFixed(3)) : null,
    startedAt: new Date().toISOString(),
    confirmedAt: now,
    resolvedAt: null,
    durationMs: null,
    status: "active",
  };
  events.push(ev);
  persistEvents();
  renderEventTable();
  return ev;
}

function resolveActiveEvent(now) {
  if (!activeEvent) return;
  activeEvent.status = "resolved";
  activeEvent.resolvedAt = new Date().toISOString();
  activeEvent.durationMs = Math.round(now - activeEvent.confirmedAt);
  persistEvents();
  renderEventTable();
  activeEvent = null;
}

const BOX_COLORS = {
  PRESENT: "#2ecc71",
  OUT_OF_FRAME: "#f39c12",
  TOO_FAR: "#f1c40f",
  MULTIPLE_FACES: "#9b59b6",
  FACE_MISSING: "#e74c3c",
};

function draw(detections, type) {
  ctx.clearRect(0, 0, els.overlay.width, els.overlay.height);
  const color = BOX_COLORS[type] || "#ffffff";
  ctx.lineWidth = 3;
  ctx.strokeStyle = color;
  ctx.font = "16px sans-serif";
  ctx.fillStyle = color;

  detections.forEach((d) => {
    const b = d.boundingBox;
    ctx.strokeRect(b.originX, b.originY, b.width, b.height);
    const score = d.categories?.[0]?.score;
    if (score != null) ctx.fillText(score.toFixed(2), b.originX, Math.max(14, b.originY - 6));
  });

  if (type === "FACE_MISSING") {
    ctx.setLineDash([10, 6]);
    ctx.strokeRect(4, 4, els.overlay.width - 8, els.overlay.height - 8);
    ctx.setLineDash([]);
    ctx.fillText("NO FACE DETECTED", 12, 24);
  }
  if (type === "MULTIPLE_FACES") {
    ctx.fillText(`MULTIPLE FACES (${detections.length})`, 12, 24);
  }
}

function loadEvents() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function persistEvents() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(events));
  } catch (err) {
    console.warn("Could not persist events to localStorage", err);
  }
}

function renderEventTable() {
  els.eventTableBody.innerHTML = "";
  [...events]
    .reverse()
    .forEach((ev) => {
      const tr = document.createElement("tr");
      tr.className = ev.status === "active" ? "row-active" : "";
      tr.innerHTML = `
        <td>${new Date(ev.startedAt).toLocaleTimeString()}</td>
        <td>${ev.type}</td>
        <td>${ev.confidence != null ? ev.confidence.toFixed(2) : "–"}</td>
        <td>${ev.status}</td>
        <td>${ev.durationMs != null ? (ev.durationMs / 1000).toFixed(1) + "s" : "–"}</td>
      `;
      els.eventTableBody.appendChild(tr);
    });
}

function exportEvents() {
  const blob = new Blob([JSON.stringify(events, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `poc1-face-presence-events-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function clearEvents() {
  events = [];
  persistEvents();
  renderEventTable();
}
