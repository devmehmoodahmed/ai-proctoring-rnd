// POC #8 — pure logic for the practice / onboarding simulator.
// No DOM and no media APIs in this file, so all of it runs under `node --test`
// (see tests/). Browser wiring lives in media.js and app.js. See README.md.

export const STEPS = ["welcome", "device", "camera", "microphone", "screen", "rules", "practice", "summary"];

// Steps that produce a check result shown in the summary / readiness report.
export const CHECK_STEPS = ["device", "camera", "microphone", "screen", "rules", "practice"];

// A candidate is only "ready" when all of these passed (or passed with a warning).
// Practice is recommended, not required: skipping it is a warning, not "needs help".
export const REQUIRED_STEPS = ["device", "camera", "microphone", "screen", "rules"];

// Exam-time thresholds, copied from the defaults of the POCs that validated them.
export const EXAM_THRESHOLDS = {
  face: { raiseMs: 1500, clearMs: 800, edgeMargin: 0.08, minArea: 0.03 }, // POC #1
  pose: { yawDeg: 20, pitchDeg: 15, raiseMs: 1200, clearMs: 600 }, // POC #2
  phone: { minScore: 0.4, raiseMs: 1000, clearMs: 600 }, // POC #3
  vad: { positiveSpeechThreshold: 0.5, negativeSpeechThreshold: 0.35, minSpeechMs: 400, redemptionMs: 1400 }, // POC #4
};

// Setup guidance aims for the middle of the acceptable range, so it is stricter
// than the exam alert thresholds above (R&D.md 28.5, D6). Untuned starting values,
// except edgeMargin, which must stay above EXAM_THRESHOLDS.face.edgeMargin: at 0.05
// a face could pass setup and then raise OUT_OF_FRAME as soon as the exam started
// (caught by the "setup band is stricter" test).
export const SETUP_BAND = {
  edgeMargin: 0.12,
  minArea: 0.04,
  maxArea: 0.3,
  centreTolX: 0.15,
  minCy: 0.25,
  maxCy: 0.62,
  holdMs: 3000,
};

// Lighting heuristic (new in POC #8). Luma is 0–255. Untuned starting values.
export const LIGHTING = { darkFace: 60, darkFrame: 45, backlitDelta: 55, backlitMaxFace: 110, brightFace: 235 };

// --- persistence / hysteresis --------------------------------------------------
// Same "debounce with grace period" behaviour as the POC #1–#3 state machines,
// extracted so each practice condition gets its own instance.

export class Persistence {
  constructor({ raiseMs, clearMs }) {
    this.raiseMs = raiseMs;
    this.clearMs = clearMs;
    this.reset();
  }

  reset() {
    this.state = "idle"; // idle → pending → active → clearing → idle
    this.since = null;
    this.activeSince = null;
  }

  // Feed one observation. Returns "raised", "cleared", or null.
  update(active, now) {
    switch (this.state) {
      case "idle":
        if (active) {
          this.state = "pending";
          this.since = now;
        }
        break;
      case "pending":
        if (!active) {
          this.reset();
        } else if (now - this.since >= this.raiseMs) {
          this.state = "active";
          this.activeSince = now;
          return "raised";
        }
        break;
      case "active":
        if (!active) {
          this.state = "clearing";
          this.since = now;
        }
        break;
      case "clearing":
        if (active) {
          this.state = "active";
        } else if (now - this.since >= this.clearMs) {
          this.reset();
          return "cleared";
        }
        break;
    }
    return null;
  }

  get isActive() {
    return this.state === "active" || this.state === "clearing";
  }
}

// --- framing -------------------------------------------------------------------
// Boxes are normalised to 0–1 in *raw camera* coordinates, not the mirrored
// preview. directionFor() explains how that maps to the candidate's left/right.

export function faceBox(landmarks) {
  let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
  for (const p of landmarks) {
    if (p.x < x0) x0 = p.x;
    if (p.x > x1) x1 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.y > y1) y1 = p.y;
  }
  return { x0: clamp01(x0), y0: clamp01(y0), x1: clamp01(x1), y1: clamp01(y1) };
}

function clamp01(v) {
  return Math.min(1, Math.max(0, v));
}

export function boxArea(b) {
  return Math.max(0, b.x1 - b.x0) * Math.max(0, b.y1 - b.y0);
}

function touching(b, margin) {
  return {
    left: b.x0 < margin,
    right: b.x1 > 1 - margin,
    top: b.y0 < margin,
    bottom: b.y1 > 1 - margin,
  };
}

// The camera sees the candidate the other way round: a face on the raw image's
// low-x side means the candidate sits to *their own right* and must move to their
// left to centre. The preview is mirrored, so "move left" also matches what they
// see on screen. Vertical: a face high in the image means the camera points too
// low, so the fix is to tilt the camera up.
function directionFor({ left, right, top, bottom }) {
  if (left) return "move_left";
  if (right) return "move_right";
  if (top) return "tilt_up";
  if (bottom) return "tilt_down";
  return null;
}

// Exam-time classification: exactly POC #1's categories and order.
export function classifyExamFrame(boxes, t = EXAM_THRESHOLDS.face) {
  if (boxes.length === 0) return "FACE_MISSING";
  if (boxes.length > 1) return "MULTIPLE_FACES";
  const edges = touching(boxes[0], t.edgeMargin);
  if (edges.left || edges.right || edges.top || edges.bottom) return "OUT_OF_FRAME";
  if (boxArea(boxes[0]) < t.minArea) return "TOO_FAR";
  return "PRESENT";
}

// Setup guidance: returns a code plus a concrete fix hint.
export function classifySetupFrame(boxes, band = SETUP_BAND) {
  if (boxes.length === 0) return { code: "NO_FACE", hint: null };
  if (boxes.length > 1) return { code: "MULTIPLE_FACES", hint: null };
  const b = boxes[0];
  const area = boxArea(b);
  if (area > band.maxArea) return { code: "TOO_CLOSE", hint: "move_back" };
  const edges = touching(b, band.edgeMargin);
  const edgeHint = directionFor(edges);
  if (edgeHint) return { code: "OUT_OF_FRAME", hint: edgeHint };
  if (area < band.minArea) return { code: "TOO_FAR", hint: "move_closer" };
  const cx = (b.x0 + b.x1) / 2;
  const cy = (b.y0 + b.y1) / 2;
  if (cx < 0.5 - band.centreTolX) return { code: "OFF_CENTRE", hint: "move_left" };
  if (cx > 0.5 + band.centreTolX) return { code: "OFF_CENTRE", hint: "move_right" };
  if (cy < band.minCy) return { code: "OFF_CENTRE", hint: "tilt_up" };
  if (cy > band.maxCy) return { code: "OFF_CENTRE", hint: "tilt_down" };
  return { code: "GOOD", hint: null };
}

// --- lighting ------------------------------------------------------------------

// Mean Rec. 601 luma of an RGBA buffer, optionally restricted to a normalised box.
export function meanLuma(rgba, width, height, box = null) {
  const xs = box ? Math.floor(box.x0 * width) : 0;
  const xe = box ? Math.ceil(box.x1 * width) : width;
  const ys = box ? Math.floor(box.y0 * height) : 0;
  const ye = box ? Math.ceil(box.y1 * height) : height;
  let sum = 0;
  let n = 0;
  for (let y = ys; y < ye; y++) {
    for (let x = xs; x < xe; x++) {
      const i = (y * width + x) * 4;
      sum += 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
      n++;
    }
  }
  return n ? sum / n : null;
}

export function classifyLighting({ frameLuma, faceLuma }, t = LIGHTING) {
  if (frameLuma == null) return "UNKNOWN";
  if (faceLuma == null) return frameLuma < t.darkFrame ? "TOO_DARK" : "UNKNOWN";
  if (faceLuma < t.darkFace) return "TOO_DARK";
  if (frameLuma - faceLuma > t.backlitDelta && faceLuma < t.backlitMaxFace) return "BACKLIT";
  if (faceLuma > t.brightFace) return "TOO_BRIGHT";
  return "OK";
}

// --- head pose -----------------------------------------------------------------

// Copied from POC #2: MediaPipe's facial transformation matrix is 4×4 column-major;
// R = Rz·Ry·Rx decomposition to yaw/pitch/roll in degrees.
export function computePose(matrix) {
  const rows = matrix.rows;
  const data = matrix.data;
  const g = (r, c) => data[c * rows + r];
  const r00 = g(0, 0), r10 = g(1, 0), r20 = g(2, 0);
  const r11 = g(1, 1), r21 = g(2, 1);
  const r12 = g(1, 2), r22 = g(2, 2);
  const sy = Math.sqrt(r00 * r00 + r10 * r10);
  let pitch, yaw, roll;
  if (sy >= 1e-6) {
    pitch = Math.atan2(r21, r22);
    yaw = Math.atan2(-r20, sy);
    roll = Math.atan2(r10, r00);
  } else {
    pitch = Math.atan2(-r12, r11);
    yaw = Math.atan2(-r20, sy);
    roll = 0;
  }
  const deg = (rad) => (rad * 180) / Math.PI;
  return { yaw: deg(yaw), pitch: deg(pitch), roll: deg(roll) };
}

// Calibration: POC #2 took one frame as the baseline, which was noisy. Here the
// baseline is the mean over the setup "hold" window, accepted only if stable.
export function summarisePose(samples) {
  const n = samples.length;
  if (!n) return { n: 0, yaw: 0, pitch: 0, sdYaw: Infinity, sdPitch: Infinity };
  const mean = (k) => samples.reduce((a, s) => a + s[k], 0) / n;
  const yaw = mean("yaw");
  const pitch = mean("pitch");
  const sd = (k, m) => Math.sqrt(samples.reduce((a, s) => a + (s[k] - m) ** 2, 0) / n);
  return { n, yaw, pitch, sdYaw: sd("yaw", yaw), sdPitch: sd("pitch", pitch) };
}

export function isStableCalibration(summary, { maxSdDeg = 4, minSamples = 10 } = {}) {
  return summary.n >= minSamples && summary.sdYaw <= maxSdDeg && summary.sdPitch <= maxSdDeg;
}

export function isLookingAway(pose, baseline, t = EXAM_THRESHOLDS.pose) {
  return Math.abs(pose.yaw - baseline.yaw) > t.yawDeg || Math.abs(pose.pitch - baseline.pitch) > t.pitchDeg;
}

// --- step machine --------------------------------------------------------------

export const PASSABLE = new Set(["pass", "warn", "skipped"]);
const STATE_VERSION = 1;

export function initialState({ lang = "en", now = Date.now(), sessionId }) {
  return {
    v: STATE_VERSION,
    lang,
    step: "welcome",
    maxStep: 0,
    results: {},
    calibration: null, // { yaw, pitch } baseline from the camera step
    practice: { startedAt: null, answers: {}, nudges: {}, submitted: false },
    sessionId: sessionId || `practice-${now.toString(36)}`,
    startedAt: now,
    completedAt: null,
  };
}

export function setResult(state, stepId, result, now = Date.now()) {
  return { ...state, results: { ...state.results, [stepId]: { ...result, at: now } } };
}

export function canAdvance(state) {
  if (state.step === "welcome") return true;
  if (state.step === "summary") return false;
  return PASSABLE.has(state.results[state.step]?.status);
}

export function goTo(state, stepId, now = Date.now()) {
  const i = STEPS.indexOf(stepId);
  if (i < 0) throw new Error(`unknown step ${stepId}`);
  const next = { ...state, step: stepId, maxStep: Math.max(state.maxStep, i) };
  if (stepId === "summary" && !state.completedAt) next.completedAt = now;
  return next;
}

export function next(state, now = Date.now()) {
  if (!canAdvance(state)) return state;
  const i = STEPS.indexOf(state.step);
  return goTo(state, STEPS[Math.min(i + 1, STEPS.length - 1)], now);
}

export function back(state) {
  const i = STEPS.indexOf(state.step);
  return i > 0 ? { ...state, step: STEPS[i - 1] } : state;
}

export function skip(state, code = "SKIPPED_BY_CANDIDATE", now = Date.now()) {
  if (state.step === "welcome" || state.step === "summary" || state.step === "rules") return state;
  return next(setResult(state, state.step, { status: "skipped", code }, now), now);
}

export function overall(results) {
  const required = REQUIRED_STEPS.map((id) => results[id]?.status);
  if (required.some((s) => s !== "pass" && s !== "warn")) return "needs_help";
  const all = CHECK_STEPS.map((id) => results[id]?.status);
  if (all.some((s) => s !== "pass")) return "ready_with_warnings";
  return "ready";
}

// Saved progress is a per-browser convenience (it survives the macOS "Quit &
// Reopen"). Anything that doesn't look like our own state is ignored.
export function restoreState(raw) {
  try {
    const s = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!s || s.v !== STATE_VERSION || !STEPS.includes(s.step) || typeof s.results !== "object") return null;
    return s;
  } catch {
    return null;
  }
}

// --- readiness report ------------------------------------------------------------
// Same top-level shape as a POC #6 event, so it can be POSTed to /events unchanged.
// It carries statuses and error codes only: no images, audio, or pose values.

export function buildReport(state, { contentVersion, policyStatus, env = {}, now = Date.now() }) {
  const status = overall(state.results);
  const checks = CHECK_STEPS.map((id) => ({
    id,
    status: state.results[id]?.status || "not_run",
    code: state.results[id]?.code || null,
  }));
  const issues = checks.filter((c) => c.status !== "pass").map((c) => `${c.id}=${c.status}${c.code ? `(${c.code})` : ""}`);
  const questions = state.practice?.answers || {};
  return {
    event_type: "READINESS_REPORT",
    session_id: state.sessionId,
    confidence: null,
    detail: `${status}: ${issues.length ? issues.join(", ") : "all checks passed"}`,
    client_sent_at: now,
    readiness: {
      overall: status,
      lang: state.lang,
      content_version: contentVersion,
      policy_status: policyStatus,
      started_at: new Date(state.startedAt).toISOString(),
      completed_at: new Date(state.completedAt || now).toISOString(),
      duration_ms: (state.completedAt || now) - state.startedAt,
      checks,
      practice: {
        submitted: Boolean(state.practice?.submitted),
        questions_answered: Object.keys(questions).length,
        room_scan_practised: Boolean(state.practice?.roomScan),
        nudges_seen: { ...(state.practice?.nudges || {}) },
      },
      environment: {
        browser: env.browser || null,
        os: env.os || null,
        mobile: env.mobile ?? null,
      },
    },
  };
}

// --- i18n ----------------------------------------------------------------------

export function lookup(dict, key) {
  return key.split(".").reduce((o, k) => (o == null ? undefined : o[k]), dict);
}

// Replaces {name} placeholders. Numbers go through Intl so Arabic digits follow the
// content file's pinned numbering system (R&D.md 28.5, D9), not the browser default.
export function format(template, params = {}, numberLocale = "en") {
  if (typeof template !== "string") return "";
  const nf = new Intl.NumberFormat(numberLocale, { maximumFractionDigits: 1 });
  return template.replace(/\{(\w+)\}/g, (m, name) => {
    if (!(name in params)) return m;
    const v = params[name];
    return typeof v === "number" ? nf.format(v) : String(v);
  });
}

export function formatClock(ms, numberLocale = "en") {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const nf2 = new Intl.NumberFormat(numberLocale, { minimumIntegerDigits: 2, useGrouping: false });
  const nf1 = new Intl.NumberFormat(numberLocale, { useGrouping: false });
  return `${nf1.format(Math.floor(total / 60))}:${nf2.format(total % 60)}`;
}

export function placeholders(str) {
  return new Set([...String(str).matchAll(/\{(\w+)\}/g)].map((m) => m[1]));
}

// Flattens a content tree to { "a.b.0.c": leaf } for parity checks.
export function flatten(obj, prefix = "", out = {}) {
  if (Array.isArray(obj)) {
    obj.forEach((v, i) => flatten(v, `${prefix}${i}.`, out));
  } else if (obj && typeof obj === "object") {
    for (const [k, v] of Object.entries(obj)) flatten(v, `${prefix}${k}.`, out);
  } else {
    out[prefix.slice(0, -1)] = obj;
  }
  return out;
}
