// POC #4 — Speaking / voice activity detection.
// Standalone prototype: all inference runs in this tab via Silero VAD (ONNX, WASM),
// loaded from CDN as global scripts (see index.html) — this is the first POC not
// built on MediaPipe. No audio is ever recorded or sent to a server. See README.md.
//
// `vad` is a global provided by the <script> tags in index.html, not an ES import —
// this library ships as a browser bundle, not an ES module like MediaPipe.

const STORAGE_KEY = "poc4_speaking_vad_events";

// vad-web's default baseAssetPath/onnxWASMBasePath are "./" (relative to this page),
// NOT an absolute CDN URL, despite what the docs prose implies. Left as defaults,
// the library's internal dynamic import() of its WASM worker module fails to
// resolve (surfaces as "Failed to resolve module specifier... base URL is
// about:blank"). Pointing both explicitly at the CDN directories fixes it.
const VAD_ASSET_BASE = "https://cdn.jsdelivr.net/npm/@ricky0123/vad-web@0.0.31/dist/";
const ONNX_WASM_BASE = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/";

const els = {
  startBtn: document.getElementById("startBtn"),
  stopBtn: document.getElementById("stopBtn"),
  liveStatus: document.getElementById("liveStatus"),
  levelFill: document.getElementById("levelFill"),
  probVal: document.getElementById("probVal"),
  segmentCountVal: document.getElementById("segmentCountVal"),
  misfireCountVal: document.getElementById("misfireCountVal"),
  eventTableBody: document.getElementById("eventTableBody"),
  exportBtn: document.getElementById("exportBtn"),
  clearLogBtn: document.getElementById("clearLogBtn"),
  cfgPositiveThreshold: document.getElementById("cfgPositiveThreshold"),
  cfgPositiveThresholdVal: document.getElementById("cfgPositiveThresholdVal"),
  cfgNegativeThreshold: document.getElementById("cfgNegativeThreshold"),
  cfgNegativeThresholdVal: document.getElementById("cfgNegativeThresholdVal"),
  cfgMinSpeechMs: document.getElementById("cfgMinSpeechMs"),
  cfgRedemptionMs: document.getElementById("cfgRedemptionMs"),
};

let myvad = null;
let running = false;
let misfireCount = 0;

let events = loadEvents();
renderEventTable();
els.segmentCountVal.textContent = String(events.length);

if (!window.isSecureContext) {
  els.liveStatus.textContent =
    "This page must be served over http://localhost or https:// for microphone access to work (see README.md).";
  els.startBtn.disabled = true;
}

els.cfgPositiveThreshold.addEventListener("input", () => {
  els.cfgPositiveThresholdVal.textContent = Number(els.cfgPositiveThreshold.value).toFixed(2);
});
els.cfgNegativeThreshold.addEventListener("input", () => {
  els.cfgNegativeThresholdVal.textContent = Number(els.cfgNegativeThreshold.value).toFixed(2);
});

els.startBtn.addEventListener("click", start);
els.stopBtn.addEventListener("click", stop);
els.exportBtn.addEventListener("click", exportEvents);
els.clearLogBtn.addEventListener("click", clearEvents);

async function start() {
  els.startBtn.disabled = true;
  setLiveStatus("idle", "Loading voice activity model…");
  try {
    myvad = await vad.MicVAD.new({
      model: "v5",
      baseAssetPath: VAD_ASSET_BASE,
      onnxWASMBasePath: ONNX_WASM_BASE,
      positiveSpeechThreshold: Number(els.cfgPositiveThreshold.value),
      negativeSpeechThreshold: Number(els.cfgNegativeThreshold.value),
      minSpeechMs: Number(els.cfgMinSpeechMs.value),
      redemptionMs: Number(els.cfgRedemptionMs.value),
      onSpeechStart: () => {
        setLiveStatus("warning", "Speech starting…");
      },
      onFrameProcessed: (probs) => {
        updateLevelMeter(probs.isSpeech);
      },
      onVADMisfire: () => {
        misfireCount += 1;
        els.misfireCountVal.textContent = String(misfireCount);
        setLiveStatus("present", "Silent (brief sound discarded — too short to count)");
      },
      onSpeechEnd: (audio) => {
        const durationS = audio.length / 16000;
        createEvent(durationS);
        setLiveStatus("present", "Silent");
      },
    });
    myvad.start();
    running = true;
    els.stopBtn.disabled = false;
    setLiveStatus("present", "Listening — silent");
  } catch (err) {
    console.error(err);
    setLiveStatus("idle", `Error: ${err.message}`);
    els.startBtn.disabled = false;
  }
}

async function stop() {
  running = false;
  if (myvad) {
    await myvad.destroy();
    myvad = null;
  }
  els.startBtn.disabled = false;
  els.stopBtn.disabled = true;
  setLiveStatus("idle", "Microphone not started");
  updateLevelMeter(0);
  els.probVal.textContent = "–";
}

function updateLevelMeter(prob) {
  if (!running) return;
  const pct = Math.round(prob * 100);
  els.levelFill.style.width = `${pct}%`;
  els.probVal.textContent = prob.toFixed(2);
  const positiveThreshold = Number(els.cfgPositiveThreshold.value);
  els.levelFill.classList.toggle("speaking", prob >= positiveThreshold);
}

function setLiveStatus(cls, text) {
  els.liveStatus.className = `live-status ${cls}`;
  els.liveStatus.textContent = text;
}

function createEvent(durationS) {
  const ev = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    type: "SPEECH_SEGMENT",
    startedAt: new Date().toISOString(),
    durationMs: Math.round(durationS * 1000),
    status: "confirmed",
  };
  events.push(ev);
  persistEvents();
  renderEventTable();
  els.segmentCountVal.textContent = String(events.length);
  return ev;
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
      tr.innerHTML = `
        <td>${new Date(ev.startedAt).toLocaleTimeString()}</td>
        <td>${ev.type}</td>
        <td>${(ev.durationMs / 1000).toFixed(1)}s</td>
        <td>${ev.status}</td>
      `;
      els.eventTableBody.appendChild(tr);
    });
}

function exportEvents() {
  const blob = new Blob([JSON.stringify(events, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `poc4-speaking-vad-events-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function clearEvents() {
  events = [];
  persistEvents();
  renderEventTable();
  els.segmentCountVal.textContent = "0";
}
