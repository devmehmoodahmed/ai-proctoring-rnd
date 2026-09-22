// POC #2 — Gaze / head-pose ("looking away") detection.
// Standalone prototype: all inference runs in this tab via MediaPipe Tasks Vision
// (WASM). No frame or image is ever sent to a server. See README.md.

import {
  FaceLandmarker,
  FilesetResolver,
} from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/vision_bundle.mjs";

const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";
const WASM_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm";
const STORAGE_KEY = "poc2_gaze_headpose_events";

const els = {
  video: document.getElementById("video"),
  overlay: document.getElementById("overlay"),
  startBtn: document.getElementById("startBtn"),
  stopBtn: document.getElementById("stopBtn"),
  calibrateBtn: document.getElementById("calibrateBtn"),
  resetCalibrationBtn: document.getElementById("resetCalibrationBtn"),
  liveStatus: document.getElementById("liveStatus"),
  calibrationHint: document.getElementById("calibrationHint"),
  fpsVal: document.getElementById("fpsVal"),
  latencyVal: document.getElementById("latencyVal"),
  yawVal: document.getElementById("yawVal"),
  pitchVal: document.getElementById("pitchVal"),
  rollVal: document.getElementById("rollVal"),
  eventTableBody: document.getElementById("eventTableBody"),
  exportBtn: document.getElementById("exportBtn"),
  clearLogBtn: document.getElementById("clearLogBtn"),
  cfgYawThreshold: document.getElementById("cfgYawThreshold"),
  cfgPitchThreshold: document.getElementById("cfgPitchThreshold"),
  cfgRaiseMs: document.getElementById("cfgRaiseMs"),
  cfgClearMs: document.getElementById("cfgClearMs"),
};

const ctx = els.overlay.getContext("2d");

let faceLandmarker = null;
let stream = null;
let rafId = null;
let running = false;

// Persistence ("debounce with grace period") state machine — same shape as POC #1.
let raiseStreakStart = null;
let raiseStreakType = null;
let activeEvent = null; // { id, type, detail, startedAt, confirmedAt, resolvedAt, durationMs, status }
let clearStreakStart = null;

// Calibration baseline (raw yaw/pitch subtracted before classification/display).
let calibration = { yaw: 0, pitch: 0 };
let calibrated = false;
let lastRawPose = null; // most recent { yaw, pitch, roll, r } for the Calibrate button to read

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

els.startBtn.addEventListener("click", start);
els.stopBtn.addEventListener("click", stop);
els.calibrateBtn.addEventListener("click", calibrate);
els.resetCalibrationBtn.addEventListener("click", resetCalibration);
els.exportBtn.addEventListener("click", exportEvents);
els.clearLogBtn.addEventListener("click", clearEvents);

async function ensureLandmarker() {
  if (faceLandmarker) return faceLandmarker;
  const vision = await FilesetResolver.forVisionTasks(WASM_URL);
  const options = {
    baseOptions: { modelAssetPath: MODEL_URL, delegate: "GPU" },
    runningMode: "VIDEO",
    numFaces: 1,
    outputFaceBlendshapes: false,
    outputFacialTransformationMatrixes: true,
  };
  try {
    faceLandmarker = await FaceLandmarker.createFromOptions(vision, options);
  } catch (err) {
    console.warn("GPU delegate unavailable, falling back to CPU", err);
    faceLandmarker = await FaceLandmarker.createFromOptions(vision, {
      ...options,
      baseOptions: { ...options.baseOptions, delegate: "CPU" },
    });
  }
  return faceLandmarker;
}

async function start() {
  els.startBtn.disabled = true;
  els.liveStatus.textContent = "Loading model…";
  try {
    await ensureLandmarker();
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
    els.calibrateBtn.disabled = false;
    els.resetCalibrationBtn.disabled = false;
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
  els.calibrateBtn.disabled = true;
  els.resetCalibrationBtn.disabled = true;
  els.liveStatus.textContent = "Camera not started";
  els.liveStatus.className = "live-status idle";
  els.fpsVal.textContent = "–";
  els.latencyVal.textContent = "–";
  els.yawVal.textContent = "–";
  els.pitchVal.textContent = "–";
  els.rollVal.textContent = "–";
}

function resetStateMachine() {
  raiseStreakStart = null;
  raiseStreakType = null;
  activeEvent = null;
  clearStreakStart = null;
}

function calibrate() {
  if (!lastRawPose) return;
  calibration = { yaw: lastRawPose.yaw, pitch: lastRawPose.pitch };
  calibrated = true;
  els.calibrationHint.textContent = `Calibration: baseline set (raw yaw ${calibration.yaw.toFixed(1)}°, pitch ${calibration.pitch.toFixed(1)}°). Yaw/pitch below are now relative to this.`;
  els.calibrationHint.classList.add("calibrated");
  resetStateMachine();
}

function resetCalibration() {
  calibration = { yaw: 0, pitch: 0 };
  calibrated = false;
  els.calibrationHint.textContent = "Calibration: not calibrated — yaw/pitch shown are raw, relative to the camera, not your screen.";
  els.calibrationHint.classList.remove("calibrated");
  resetStateMachine();
}

function loop() {
  if (!running) return;
  const now = performance.now();
  if (els.video.readyState >= 2) {
    const t0 = performance.now();
    const result = faceLandmarker.detectForVideo(els.video, now);
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

// MediaPipe's facial transformation matrix is a 4x4, column-major (data[col*rows+row]).
// Rotation submatrix -> yaw/pitch/roll via the standard R = Rz*Ry*Rx decomposition
// (the same one used in most OpenCV/solvePnP head-pose tutorials). Sign/axis
// conventions are validated empirically during manual testing, not assumed correct —
// that's what the live readout + calibration step are for.
function computePose(matrix) {
  const rows = matrix.rows;
  const data = matrix.data;
  const g = (r, c) => data[c * rows + r];
  const r00 = g(0, 0), r10 = g(1, 0), r20 = g(2, 0);
  const r11 = g(1, 1), r21 = g(2, 1);
  const r12 = g(1, 2), r22 = g(2, 2);

  const sy = Math.sqrt(r00 * r00 + r10 * r10);
  const singular = sy < 1e-6;
  let pitch, yaw, roll;
  if (!singular) {
    pitch = Math.atan2(r21, r22);
    yaw = Math.atan2(-r20, sy);
    roll = Math.atan2(r10, r00);
  } else {
    pitch = Math.atan2(-r12, r11);
    yaw = Math.atan2(-r20, sy);
    roll = 0;
  }
  const toDeg = (rad) => (rad * 180) / Math.PI;
  return {
    yaw: toDeg(yaw),
    pitch: toDeg(pitch),
    roll: toDeg(roll),
    r: { r00, r10, r01: g(0, 1), r11, r02: g(0, 2), r12 },
  };
}

function classify(rawPose) {
  const adjYaw = rawPose.yaw - calibration.yaw;
  const adjPitch = rawPose.pitch - calibration.pitch;
  const yawThreshold = Number(els.cfgYawThreshold.value);
  const pitchThreshold = Number(els.cfgPitchThreshold.value);
  const exceedsYaw = Math.abs(adjYaw) > yawThreshold;
  const exceedsPitch = Math.abs(adjPitch) > pitchThreshold;

  if (!exceedsYaw && !exceedsPitch) {
    return { type: "FOCUSED", adjYaw, adjPitch, detail: null };
  }
  const parts = [];
  if (exceedsYaw) parts.push(`yaw ${adjYaw.toFixed(1)}°`);
  if (exceedsPitch) parts.push(`pitch ${adjPitch.toFixed(1)}°`);
  return { type: "LOOKING_AWAY", adjYaw, adjPitch, detail: parts.join(", ") };
}

function processResult(result, now) {
  const landmarks = result.faceLandmarks && result.faceLandmarks[0];
  const matrix = result.facialTransformationMatrixes && result.facialTransformationMatrixes[0];

  if (!landmarks || !matrix) {
    lastRawPose = null;
    draw(null, null, "NO_FACE");
    els.yawVal.textContent = "–";
    els.pitchVal.textContent = "–";
    els.rollVal.textContent = "–";
    resetStateMachine();
    if (activeEvent) resolveActiveEvent(now);
    setLiveStatus("idle", "No face detected — gaze unavailable");
    return;
  }

  const rawPose = computePose(matrix);
  lastRawPose = rawPose;
  const { type, adjYaw, adjPitch, detail } = classify(rawPose);

  els.yawVal.textContent = `${adjYaw.toFixed(1)}°`;
  els.pitchVal.textContent = `${adjPitch.toFixed(1)}°`;
  els.rollVal.textContent = `${rawPose.roll.toFixed(1)}°`;

  draw(landmarks, rawPose, type);

  const raiseMs = Number(els.cfgRaiseMs.value);
  const clearMs = Number(els.cfgClearMs.value);

  if (type === "FOCUSED") {
    raiseStreakStart = null;
    raiseStreakType = null;

    if (activeEvent) {
      if (clearStreakStart === null) clearStreakStart = now;
      const held = now - clearStreakStart;
      if (held >= clearMs) {
        resolveActiveEvent(now);
        setLiveStatus("present", "✅ Focused");
      } else {
        setLiveStatus("clearing", `Resolving LOOKING_AWAY… ${((clearMs - held) / 1000).toFixed(1)}s`);
      }
    } else {
      setLiveStatus("present", "✅ Focused");
    }
    return;
  }

  // LOOKING_AWAY — any non-focused frame cancels a pending "clear".
  clearStreakStart = null;

  if (activeEvent && activeEvent.type === type) {
    setLiveStatus("alert", `⚠ LOOKING_AWAY (${detail}, confirmed ${((now - activeEvent.confirmedAt) / 1000).toFixed(1)}s ago)`);
    return;
  }

  if (activeEvent && activeEvent.type !== type) {
    resolveActiveEvent(now);
  }

  if (raiseStreakType !== type) {
    raiseStreakType = type;
    raiseStreakStart = now;
  }

  const held = now - raiseStreakStart;
  if (held >= raiseMs) {
    activeEvent = createEvent(type, detail, now);
    setLiveStatus("alert", `⚠ LOOKING_AWAY (${detail})`);
  } else {
    setLiveStatus("warning", `Looking away (${detail}) — confirming in ${((raiseMs - held) / 1000).toFixed(1)}s`);
  }
}

function setLiveStatus(cls, text) {
  els.liveStatus.className = `live-status ${cls}`;
  els.liveStatus.textContent = text;
}

function createEvent(type, detail, now) {
  const ev = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    type,
    detail,
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

function draw(landmarks, pose, type) {
  ctx.clearRect(0, 0, els.overlay.width, els.overlay.height);

  if (type === "NO_FACE") {
    ctx.strokeStyle = "#e74c3c";
    ctx.lineWidth = 3;
    ctx.setLineDash([10, 6]);
    ctx.strokeRect(4, 4, els.overlay.width - 8, els.overlay.height - 8);
    ctx.setLineDash([]);
    ctx.fillStyle = "#e74c3c";
    ctx.font = "16px sans-serif";
    ctx.fillText("NO FACE DETECTED", 12, 24);
    return;
  }

  if (!landmarks) return;

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of landmarks) {
    const x = p.x * els.overlay.width;
    const y = p.y * els.overlay.height;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;

  const boxColor = type === "LOOKING_AWAY" ? "#f39c12" : "#2ecc71";
  ctx.strokeStyle = boxColor;
  ctx.lineWidth = 2;
  ctx.strokeRect(minX, minY, maxX - minX, maxY - minY);

  // Qualitative pose axes (X red, Y green, Z blue) — a sanity-check visualization,
  // not a calibrated 3D render. Sign/direction validated by eye during testing.
  if (pose && pose.r) {
    const len = 80;
    drawAxis(cx, cy, pose.r.r00, pose.r.r10, len, "#e74c3c");
    drawAxis(cx, cy, pose.r.r01, pose.r.r11, len, "#2ecc71");
    drawAxis(cx, cy, pose.r.r02, pose.r.r12, len, "#3498db");
  }
}

function drawAxis(cx, cy, dx, dy, len, color) {
  ctx.strokeStyle = color;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx + dx * len, cy + dy * len);
  ctx.stroke();
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
        <td>${ev.detail || "–"}</td>
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
  a.download = `poc2-gaze-headpose-events-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function clearEvents() {
  events = [];
  persistEvents();
  renderEventTable();
}
