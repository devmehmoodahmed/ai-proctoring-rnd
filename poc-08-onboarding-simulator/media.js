// POC #8 — browser media wrappers: camera + on-device vision, microphone + VAD,
// screen-share check, environment detection. Everything runs in this tab; no frame,
// audio sample, or screen image is ever sent anywhere. See README.md.
//
// Model URLs, options and loader fixes are reused from POC #1–#5. Every CDN
// dependency is loaded lazily (dynamic import / script injection), so a network
// that blocks the CDN shows up as a failed check, not as a page that never loads.

import { meanLuma, faceBox, computePose, EXAM_THRESHOLDS } from "./logic.js";

// POC #1–#3 used @latest; pinned here so a MediaPipe release can't change behaviour
// under us between test runs.
const MP_VERSION = "1.0.1";
const MP_BUNDLE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}/vision_bundle.mjs`;
const MP_WASM = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}/wasm`;
const FACE_MODEL =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task"; // POC #2
const PHONE_MODEL =
  "https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float32/1/efficientdet_lite0.tflite"; // POC #3
const PHONE_LABEL = "cell phone";

// POC #4, including its fix: vad-web's default asset paths are page-relative, so
// both must point at the CDN explicitly.
const ORT_SCRIPT = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/ort.wasm.min.js";
const VAD_SCRIPT = "https://cdn.jsdelivr.net/npm/@ricky0123/vad-web@0.0.31/dist/bundle.min.js";
const VAD_ASSET_BASE = "https://cdn.jsdelivr.net/npm/@ricky0123/vad-web@0.0.31/dist/";
const ONNX_WASM_BASE = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/";

const FACE_INTERVAL_MS = 66; // ≤15 fps: enough for 1.2–1.5 s persistence windows
// Both models run on the main thread, one after the other, so a slow phone model
// directly lowers the face rate (measured: 15 → 3.6 fps in headless Chromium at a
// fixed 4 Hz). The phone detector is capped at ~25% of wall time instead.
const PHONE_MIN_INTERVAL_MS = 250;
const PHONE_MAX_DUTY = 0.25;
const LUMA_INTERVAL_MS = 500;

export const metrics = {
  faceModelLoadMs: null,
  phoneModelLoadMs: null,
  vadLoadMs: null,
  faceDelegate: null,
  phoneDelegate: null,
  faceFps: null,
  // The first inference includes GPU shader compilation and blocks the main thread
  // for seconds, so each model is warmed up once at load time and that is reported
  // separately from steady-state inference time.
  faceWarmupMs: null,
  faceFirstMs: null,
  faceMs: null, // steady-state, smoothed
  phoneWarmupMs: null,
  phoneFirstMs: null,
  phoneMs: null,
  phoneIntervalMs: null,
};

// Runs one inference on a blank frame so the multi-second first-call cost happens
// on the loading screen, not in the middle of the camera check or the practice exam.
function warmUp(task) {
  const c = document.createElement("canvas");
  c.width = 64;
  c.height = 64;
  c.getContext("2d").fillRect(0, 0, 64, 64);
  const t0 = performance.now();
  task.detectForVideo(c, t0);
  return Math.round(performance.now() - t0);
}

// --- environment -----------------------------------------------------------------

export function detectEnvironment() {
  const ua = navigator.userAgent;
  const pick = (re) => (ua.match(re) || [])[1];
  let name = "Other";
  let version = null;
  if (pick(/Edg\/(\d+)/)) [name, version] = ["Edge", pick(/Edg\/(\d+)/)];
  else if (pick(/OPR\/(\d+)/)) [name, version] = ["Opera", pick(/OPR\/(\d+)/)];
  else if (pick(/Chrome\/(\d+)/)) [name, version] = ["Chrome", pick(/Chrome\/(\d+)/)];
  else if (pick(/Firefox\/(\d+)/)) [name, version] = ["Firefox", pick(/Firefox\/(\d+)/)];
  else if (/Safari\//.test(ua)) [name, version] = ["Safari", pick(/Version\/(\d+)/)];

  // iPadOS reports a Mac user agent; touch points give it away.
  const ipadAsMac = /Macintosh/.test(ua) && navigator.maxTouchPoints > 1;
  let os = "other";
  if (/iPhone|iPad/.test(ua) || ipadAsMac) os = "ios";
  else if (/Android/.test(ua)) os = "android";
  else if (/Macintosh|Mac OS X/.test(ua)) os = "macos";
  else if (/Windows/.test(ua)) os = "windows";
  else if (/CrOS/.test(ua)) os = "chromeos";
  else if (/Linux/.test(ua)) os = "linux";

  const mobile = navigator.userAgentData?.mobile ?? (os === "ios" || os === "android" || /Mobi/.test(ua));
  return {
    browserName: name,
    browser: version ? `${name} ${version}` : name,
    chromium: /Chrome\//.test(ua),
    os,
    mobile,
    secureContext: window.isSecureContext,
    apis: {
      getUserMedia: Boolean(navigator.mediaDevices?.getUserMedia),
      getDisplayMedia: Boolean(navigator.mediaDevices?.getDisplayMedia),
      webrtc: typeof RTCPeerConnection === "function",
      wasm: typeof WebAssembly === "object",
      windowManagement: "isExtended" in screen,
    },
    screen: { width: screen.width, height: screen.height },
  };
}

// --- model loading ---------------------------------------------------------------

let visionPromise = null;
function vision() {
  visionPromise ??= import(MP_BUNDLE).then(async (mp) => ({ mp, fileset: await mp.FilesetResolver.forVisionTasks(MP_WASM) }));
  // A failed load must be retryable, not cached forever.
  visionPromise.catch(() => (visionPromise = null));
  return visionPromise;
}

// MediaPipe's loader passes each new task its WASM module through a global
// (self.ModuleFactory) and clears it afterwards, so tasks created at the same time
// race. Observed: loading face + phone concurrently hung for ~17 minutes. This can
// happen in the app (resume at Rules, then enter Practice), so creation is serialised.
let createChain = Promise.resolve();
function serialised(fn) {
  const p = createChain.then(fn, fn);
  createChain = p.catch(() => {});
  return p;
}

async function createWithFallback(Task, fileset, options) {
  try {
    return { task: await Task.createFromOptions(fileset, { ...options, baseOptions: { ...options.baseOptions, delegate: "GPU" } }), delegate: "GPU" };
  } catch (err) {
    console.warn("GPU delegate unavailable, falling back to CPU", err);
    return { task: await Task.createFromOptions(fileset, { ...options, baseOptions: { ...options.baseOptions, delegate: "CPU" } }), delegate: "CPU" };
  }
}

let facePromise = null;
export function loadFaceLandmarker() {
  facePromise ??= serialised(async () => {
    const t0 = performance.now();
    const { mp, fileset } = await vision();
    // One model for presence, count, framing AND pose (R&D.md 28.5, D2). numFaces: 2
    // so a second person is still counted.
    const { task, delegate } = await createWithFallback(mp.FaceLandmarker, fileset, {
      baseOptions: { modelAssetPath: FACE_MODEL },
      runningMode: "VIDEO",
      numFaces: 2,
      outputFaceBlendshapes: false,
      outputFacialTransformationMatrixes: true,
    });
    metrics.faceModelLoadMs = Math.round(performance.now() - t0);
    metrics.faceDelegate = delegate;
    metrics.faceWarmupMs = warmUp(task);
    return task;
  });
  facePromise.catch(() => (facePromise = null));
  return facePromise;
}

let phonePromise = null;
export function loadPhoneDetector() {
  phonePromise ??= serialised(async () => {
    const t0 = performance.now();
    const { mp, fileset } = await vision();
    const { task, delegate } = await createWithFallback(mp.ObjectDetector, fileset, {
      baseOptions: { modelAssetPath: PHONE_MODEL },
      runningMode: "VIDEO",
      scoreThreshold: 0.1, // real filtering happens against EXAM_THRESHOLDS.phone.minScore
      maxResults: 10,
    });
    metrics.phoneModelLoadMs = Math.round(performance.now() - t0);
    metrics.phoneDelegate = delegate;
    metrics.phoneWarmupMs = warmUp(task);
    return task;
  });
  phonePromise.catch(() => (phonePromise = null));
  return phonePromise;
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)?.dataset.loaded) return resolve();
    const s = document.createElement("script");
    s.src = src;
    s.onload = () => {
      s.dataset.loaded = "1";
      resolve();
    };
    s.onerror = () => {
      s.remove();
      reject(new Error(`failed to load ${src}`));
    };
    document.head.appendChild(s);
  });
}

// --- camera ----------------------------------------------------------------------

export function openCamera() {
  return navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 640 }, height: { ideal: 480 } }, audio: false });
}

export function isLive(stream) {
  return Boolean(stream?.getTracks().some((t) => t.readyState === "live"));
}

// Runs the face model (and, when enabled, the phone model and the lighting sampler)
// on the camera video and hands each result to `onFrame`. The loop can be paused
// between steps without stopping the camera, so the candidate isn't re-prompted.
export class CameraMonitor {
  constructor(video) {
    this.video = video;
    this.stream = null;
    this.face = null;
    this.phone = null;
    this.phoneEnabled = false;
    this.onFrame = null;
    this.running = false;
    this.rafId = null;
    this.last = { face: 0, phone: 0, luma: 0 };
    this.latest = { boxes: [], pose: null, phoneScore: null, luma: { frameLuma: null, faceLuma: null } };
    this.faceTimes = [];
    this.lumaCanvas = document.createElement("canvas");
    this.lumaCanvas.width = 64;
    this.lumaCanvas.height = 48;
    this.lumaCtx = this.lumaCanvas.getContext("2d", { willReadFrequently: true });
  }

  async attach(stream, faceLandmarker) {
    this.stream = stream;
    this.face = faceLandmarker;
    if (this.video.srcObject !== stream) this.video.srcObject = stream;
    await this.video.play().catch(() => {});
  }

  resume() {
    if (this.running || !this.face) return;
    this.running = true;
    this.video.play().catch(() => {});
    this.rafId = requestAnimationFrame(() => this.loop());
  }

  pause() {
    this.running = false;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = null;
  }

  setPhone(detector, enabled) {
    this.phone = detector;
    this.phoneEnabled = Boolean(detector && enabled);
    if (!this.phoneEnabled) this.latest.phoneScore = null;
  }

  stop() {
    this.pause();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.srcObject = null;
  }

  loop() {
    if (!this.running) return;
    const now = performance.now();
    const v = this.video;
    if (v.readyState >= 2 && v.videoWidth) {
      let changed = false;
      if (now - this.last.face >= FACE_INTERVAL_MS) {
        this.last.face = now;
        const t0 = performance.now();
        const r = this.face.detectForVideo(v, now);
        const ms = performance.now() - t0;
        if (metrics.faceFirstMs == null) metrics.faceFirstMs = Math.round(ms);
        else metrics.faceMs = smooth(metrics.faceMs, ms);
        this.trackFps(now);
        const faces = r.faceLandmarks || [];
        this.latest.boxes = faces.map(faceBox);
        const m = r.facialTransformationMatrixes?.[0];
        this.latest.pose = faces.length && m ? computePose(m) : null;
        changed = true;
      }
      const phoneInterval = Math.max(PHONE_MIN_INTERVAL_MS, (metrics.phoneMs ?? 0) / PHONE_MAX_DUTY);
      metrics.phoneIntervalMs = Math.round(phoneInterval);
      if (this.phoneEnabled && now - this.last.phone >= phoneInterval) {
        this.last.phone = now;
        const t0 = performance.now();
        const r = this.phone.detectForVideo(v, now);
        const ms = performance.now() - t0;
        if (metrics.phoneFirstMs == null) metrics.phoneFirstMs = Math.round(ms);
        else metrics.phoneMs = smooth(metrics.phoneMs, ms);
        const scores = (r.detections || [])
          .map((d) => d.categories?.[0])
          .filter((c) => c?.categoryName === PHONE_LABEL)
          .map((c) => c.score);
        this.latest.phoneScore = scores.length ? Math.max(...scores) : 0;
        changed = true;
      }
      if (now - this.last.luma >= LUMA_INTERVAL_MS) {
        this.last.luma = now;
        this.latest.luma = this.sampleLuma(this.latest.boxes[0] || null);
        changed = true;
      }
      if (changed && this.onFrame) this.onFrame({ now, ...this.latest });
    }
    this.rafId = requestAnimationFrame(() => this.loop());
  }

  sampleLuma(box) {
    const { width, height } = this.lumaCanvas;
    this.lumaCtx.drawImage(this.video, 0, 0, width, height);
    const px = this.lumaCtx.getImageData(0, 0, width, height).data;
    return { frameLuma: meanLuma(px, width, height), faceLuma: box ? meanLuma(px, width, height, box) : null };
  }

  trackFps(now) {
    this.faceTimes.push(now);
    while (this.faceTimes.length > 30) this.faceTimes.shift();
    if (this.faceTimes.length >= 2) {
      const dt = (this.faceTimes.at(-1) - this.faceTimes[0]) / (this.faceTimes.length - 1);
      metrics.faceFps = Math.round((1000 / dt) * 10) / 10;
    }
  }
}

function smooth(prev, v) {
  return prev == null ? v : prev * 0.9 + v * 0.1;
}

// --- microphone ------------------------------------------------------------------

export function openMic() {
  return navigator.mediaDevices.getUserMedia({ audio: true, video: false });
}

// Level meter (Web Audio RMS) plus Silero VAD (POC #4). The page opens the mic itself
// so it can report which getUserMedia error happened, then hands the stream to VAD.
// Steps swap `handlers` to receive VAD events. Audio samples are never kept: the
// speech-end callback only receives a duration.
export class MicMonitor {
  constructor(stream) {
    this.stream = stream;
    this.ctx = new AudioContext();
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.ctx.createMediaStreamSource(stream).connect(this.analyser);
    this.buf = new Float32Array(this.analyser.fftSize);
    this.vad = null;
    this.handlers = {};
  }

  levelDb() {
    this.analyser.getFloatTimeDomainData(this.buf);
    let sum = 0;
    for (const s of this.buf) sum += s * s;
    const rms = Math.sqrt(sum / this.buf.length);
    return rms > 0 ? Math.max(-100, 20 * Math.log10(rms)) : -100;
  }

  async startVad() {
    if (this.ctx.state === "suspended") await this.ctx.resume();
    if (this.vad) return this.vad.start();
    const t0 = performance.now();
    await loadScript(ORT_SCRIPT);
    await loadScript(VAD_SCRIPT);
    this.vad = await window.vad.MicVAD.new({
      model: "v5",
      baseAssetPath: VAD_ASSET_BASE,
      onnxWASMBasePath: ONNX_WASM_BASE,
      audioContext: this.ctx,
      getStream: async () => this.stream,
      pauseStream: async () => {}, // keep the mic open between steps
      resumeStream: async (s) => s,
      startOnLoad: false,
      ...EXAM_THRESHOLDS.vad,
      onSpeechRealStart: () => this.handlers.onSpeechStart?.(),
      onSpeechEnd: (audio) => this.handlers.onSpeechEnd?.((audio.length / 16000) * 1000),
      onVADMisfire: () => this.handlers.onMisfire?.(),
      onFrameProcessed: () => {},
    });
    metrics.vadLoadMs = Math.round(performance.now() - t0);
    await this.vad.start();
  }

  pause() {
    this.vad?.pause();
  }

  async destroy() {
    try {
      await this.vad?.destroy();
    } catch {
      /* already torn down */
    }
    this.stream.getTracks().forEach((t) => t.stop());
    await this.ctx.close().catch(() => {});
  }
}

// --- screen ----------------------------------------------------------------------

// Same hints and the same "verify, don't trust the hint" enforcement as POC #5.
export async function tryScreenShare() {
  if (!navigator.mediaDevices?.getDisplayMedia) return { status: "fail", code: "NOT_SUPPORTED" };
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { displaySurface: "monitor", frameRate: { ideal: 5, max: 15 } },
      audio: false,
      monitorTypeSurfaces: "include",
      selfBrowserSurface: "exclude",
      surfaceSwitching: "exclude",
      systemAudio: "exclude",
    });
  } catch (err) {
    // NotAllowedError = Cancel *or* missing OS permission (macOS); indistinguishable.
    return { status: "fail", code: err?.name || "Error" };
  }
  const track = stream.getVideoTracks()[0];
  const surface = track.getSettings().displaySurface || "unknown";
  if (surface !== "monitor" && surface !== "unknown") {
    stream.getTracks().forEach((t) => t.stop());
    return { status: "fail", code: "WRONG_SURFACE", surface };
  }
  const extended = "isExtended" in screen ? screen.isExtended : null;
  if (extended) return { status: "warn", code: "MULTIPLE_MONITORS", surface, stream };
  if (surface === "unknown") return { status: "warn", code: "SURFACE_UNVERIFIED", surface, stream };
  return { status: "pass", code: null, surface, stream };
}
