// POC #3 — Phone / object detection.
// Standalone prototype: all inference runs in this tab via MediaPipe Tasks Vision
// (WASM). No frame or image is ever sent to a server. See README.md.

import {
  ObjectDetector,
  FilesetResolver,
} from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/vision_bundle.mjs";

const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float32/1/efficientdet_lite0.tflite";
const WASM_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm";
const STORAGE_KEY = "poc3_phone_object_events";
const PHONE_LABEL = "cell phone"; // COCO category name used by this model

const els = {
  video: document.getElementById("video"),
  overlay: document.getElementById("overlay"),
  startBtn: document.getElementById("startBtn"),
  stopBtn: document.getElementById("stopBtn"),
  liveStatus: document.getElementById("liveStatus"),
  fpsVal: document.getElementById("fpsVal"),
  latencyVal: document.getElementById("latencyVal"),
  confidenceVal: document.getElementById("confidenceVal"),
  objectCountVal: document.getElementById("objectCountVal"),
  eventTableBody: document.getElementById("eventTableBody"),
  exportBtn: document.getElementById("exportBtn"),
  clearLogBtn: document.getElementById("clearLogBtn"),
  cfgMinConfidence: document.getElementById("cfgMinConfidence"),
  cfgMinConfidenceVal: document.getElementById("cfgMinConfidenceVal"),
  cfgRaiseMs: document.getElementById("cfgRaiseMs"),
  cfgClearMs: document.getElementById("cfgClearMs"),
};

const ctx = els.overlay.getContext("2d");

let objectDetector = null;
let stream = null;
let rafId = null;
let running = false;

// Persistence ("debounce with grace period") state machine — same shape as POC #1/#2.
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
});

els.startBtn.addEventListener("click", start);
els.stopBtn.addEventListener("click", stop);
els.exportBtn.addEventListener("click", exportEvents);
els.clearLogBtn.addEventListener("click", clearEvents);

async function ensureDetector() {
  if (objectDetector) return objectDetector;
  const vision = await FilesetResolver.forVisionTasks(WASM_URL);
  const options = {
    baseOptions: { modelAssetPath: MODEL_URL, delegate: "GPU" },
    runningMode: "VIDEO",
    scoreThreshold: 0.1, // low floor — real filtering happens in classify() via the UI slider
    maxResults: 10,
  };
  try {
    objectDetector = await ObjectDetector.createFromOptions(vision, options);
  } catch (err) {
    console.warn("GPU delegate unavailable, falling back to CPU", err);
    objectDetector = await ObjectDetector.createFromOptions(vision, {
      ...options,
      baseOptions: { ...options.baseOptions, delegate: "CPU" },
    });
  }
  return objectDetector;
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
  els.confidenceVal.textContent = "–";
  els.objectCountVal.textContent = "–";
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
    const result = objectDetector.detectForVideo(els.video, now);
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
  const minConfidence = Number(els.cfgMinConfidence.value);

  const phoneDetections = detections.filter((d) => {
    const top = d.categories?.[0];
    return top && top.categoryName === PHONE_LABEL && top.score >= minConfidence;
  });

  if (phoneDetections.length === 0) {
    return { type: "NO_PHONE", confidence: null, detections };
  }
  const confidence = Math.max(...phoneDetections.map((d) => d.categories[0].score));
  return { type: "PHONE_DETECTED", confidence, detections };
}

function processResult(result, now) {
  const { type, confidence, detections } = classify(result);
  draw(detections);
  els.objectCountVal.textContent = String(detections.length);
  els.confidenceVal.textContent = confidence != null ? confidence.toFixed(2) : "–";

  const raiseMs = Number(els.cfgRaiseMs.value);
  const clearMs = Number(els.cfgClearMs.value);

  if (type === "NO_PHONE") {
    raiseStreakStart = null;
    raiseStreakType = null;

    if (activeEvent) {
      if (clearStreakStart === null) clearStreakStart = now;
      const held = now - clearStreakStart;
      if (held >= clearMs) {
        resolveActiveEvent(now);
        setLiveStatus("present", "✅ No phone visible");
      } else {
        setLiveStatus("clearing", `Resolving PHONE_DETECTED… ${((clearMs - held) / 1000).toFixed(1)}s`);
      }
    } else {
      setLiveStatus("present", "✅ No phone visible");
    }
    return;
  }

  // PHONE_DETECTED — any non-clear frame cancels a pending "clear".
  clearStreakStart = null;

  if (activeEvent && activeEvent.type === type) {
    setLiveStatus("alert", `⚠ PHONE_DETECTED (confirmed ${((now - activeEvent.confirmedAt) / 1000).toFixed(1)}s ago)`);
    return;
  }

  if (raiseStreakType !== type) {
    raiseStreakType = type;
    raiseStreakStart = now;
  }

  const held = now - raiseStreakStart;
  if (held >= raiseMs) {
    activeEvent = createEvent(type, confidence, now);
    setLiveStatus("alert", `⚠ PHONE_DETECTED (confirmed)`);
  } else {
    setLiveStatus("warning", `Phone visible — confirming in ${((raiseMs - held) / 1000).toFixed(1)}s`);
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

function draw(detections) {
  ctx.clearRect(0, 0, els.overlay.width, els.overlay.height);
  ctx.font = "13px sans-serif";
  const minConfidence = Number(els.cfgMinConfidence.value);

  detections.forEach((d) => {
    const top = d.categories?.[0];
    if (!top) return;
    const isPhone = top.categoryName === PHONE_LABEL && top.score >= minConfidence;
    const color = isPhone ? "#e74c3c" : "#8a8f9b";
    const b = d.boundingBox;
    ctx.lineWidth = isPhone ? 3 : 1.5;
    ctx.strokeStyle = color;
    ctx.strokeRect(b.originX, b.originY, b.width, b.height);
    ctx.fillStyle = color;
    ctx.fillText(`${top.categoryName} ${top.score.toFixed(2)}`, b.originX, Math.max(14, b.originY - 6));
  });
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
  a.download = `poc3-phone-object-events-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function clearEvents() {
  events = [];
  persistEvents();
  renderEventTable();
}
