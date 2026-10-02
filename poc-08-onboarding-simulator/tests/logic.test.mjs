// Unit tests for logic.js. Zero dependencies: `node --test tests/` from the POC folder.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  Persistence,
  classifyExamFrame,
  classifySetupFrame,
  classifyLighting,
  meanLuma,
  computePose,
  summarisePose,
  isStableCalibration,
  isLookingAway,
  initialState,
  setResult,
  canAdvance,
  next,
  back,
  skip,
  overall,
  restoreState,
  buildReport,
  format,
  formatClock,
  STEPS,
} from "../logic.js";

const box = (cx, cy, w, h) => ({ x0: cx - w / 2, y0: cy - h / 2, x1: cx + w / 2, y1: cy + h / 2 });

test("Persistence raises only after the condition holds for raiseMs", () => {
  const p = new Persistence({ raiseMs: 1000, clearMs: 500 });
  assert.equal(p.update(true, 0), null);
  assert.equal(p.update(true, 999), null);
  assert.equal(p.update(true, 1000), "raised");
  assert.equal(p.isActive, true);
});

test("Persistence ignores flicker shorter than raiseMs", () => {
  const p = new Persistence({ raiseMs: 1000, clearMs: 500 });
  for (let t = 0; t < 5000; t += 100) {
    // on for 400 ms, off for 100 ms: never 1 s continuously
    assert.equal(p.update(t % 500 !== 400, t), null);
  }
  assert.equal(p.isActive, false);
});

test("Persistence clears only after clearMs of absence, and a relapse keeps it active", () => {
  const p = new Persistence({ raiseMs: 100, clearMs: 500 });
  p.update(true, 0);
  assert.equal(p.update(true, 100), "raised");
  assert.equal(p.update(false, 200), null);
  assert.equal(p.update(true, 600), null); // relapse inside the grace period
  assert.equal(p.isActive, true);
  assert.equal(p.update(false, 700), null);
  assert.equal(p.update(false, 1199), null);
  assert.equal(p.update(false, 1200), "cleared");
  assert.equal(p.isActive, false);
});

test("classifyExamFrame matches POC #1's categories", () => {
  assert.equal(classifyExamFrame([]), "FACE_MISSING");
  assert.equal(classifyExamFrame([box(0.5, 0.45, 0.25, 0.35), box(0.2, 0.4, 0.2, 0.3)]), "MULTIPLE_FACES");
  assert.equal(classifyExamFrame([box(0.1, 0.45, 0.25, 0.35)]), "OUT_OF_FRAME");
  assert.equal(classifyExamFrame([box(0.5, 0.45, 0.1, 0.15)]), "TOO_FAR"); // 1.5% of frame
  assert.equal(classifyExamFrame([box(0.5, 0.45, 0.25, 0.35)]), "PRESENT");
});

test("classifySetupFrame gives GOOD for a centred, well-sized face", () => {
  assert.deepEqual(classifySetupFrame([box(0.5, 0.45, 0.25, 0.35)]), { code: "GOOD", hint: null });
});

test("classifySetupFrame direction hints use the candidate's own left/right", () => {
  // Face on the raw image's low-x side = candidate sits to their right → move left.
  assert.deepEqual(classifySetupFrame([box(0.3, 0.45, 0.2, 0.3)]), { code: "OFF_CENTRE", hint: "move_left" });
  assert.deepEqual(classifySetupFrame([box(0.7, 0.45, 0.2, 0.3)]), { code: "OFF_CENTRE", hint: "move_right" });
  assert.equal(classifySetupFrame([box(0.08, 0.45, 0.2, 0.3)]).hint, "move_left"); // touching the edge
  // Face high in the image = camera points too low → tilt up.
  assert.deepEqual(classifySetupFrame([box(0.5, 0.24, 0.25, 0.22)]), { code: "OFF_CENTRE", hint: "tilt_up" });
  assert.deepEqual(classifySetupFrame([box(0.5, 0.2, 0.2, 0.25)]), { code: "OUT_OF_FRAME", hint: "tilt_up" });
  assert.deepEqual(classifySetupFrame([box(0.5, 0.7, 0.2, 0.25)]), { code: "OFF_CENTRE", hint: "tilt_down" });
});

test("classifySetupFrame distance hints", () => {
  assert.deepEqual(classifySetupFrame([box(0.5, 0.45, 0.12, 0.2)]), { code: "TOO_FAR", hint: "move_closer" });
  assert.deepEqual(classifySetupFrame([box(0.5, 0.5, 0.6, 0.8)]), { code: "TOO_CLOSE", hint: "move_back" });
  assert.equal(classifySetupFrame([]).code, "NO_FACE");
  assert.equal(classifySetupFrame([box(0.3, 0.4, 0.2, 0.3), box(0.7, 0.4, 0.2, 0.3)]).code, "MULTIPLE_FACES");
});

test("setup band is stricter than exam thresholds (D6): anything GOOD in setup is PRESENT in the exam", () => {
  for (let cx = 0.05; cx <= 0.95; cx += 0.05) {
    for (let cy = 0.05; cy <= 0.95; cy += 0.05) {
      for (const w of [0.1, 0.2, 0.3, 0.45]) {
        const b = [box(cx, cy, w, w * 1.3)];
        if (classifySetupFrame(b).code === "GOOD") assert.equal(classifyExamFrame(b), "PRESENT", JSON.stringify(b));
      }
    }
  }
});

test("meanLuma over the whole frame and over a region", () => {
  const w = 4, h = 2;
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const v = i % w < 2 ? 0 : 200; // left half black, right half grey 200
    rgba.set([v, v, v, 255], i * 4);
  }
  assert.equal(Math.round(meanLuma(rgba, w, h)), 100);
  assert.equal(Math.round(meanLuma(rgba, w, h, { x0: 0.5, y0: 0, x1: 1, y1: 1 })), 200);
});

test("classifyLighting", () => {
  assert.equal(classifyLighting({ frameLuma: 40, faceLuma: 35 }), "TOO_DARK");
  assert.equal(classifyLighting({ frameLuma: 170, faceLuma: 90 }), "BACKLIT");
  assert.equal(classifyLighting({ frameLuma: 240, faceLuma: 245 }), "TOO_BRIGHT");
  assert.equal(classifyLighting({ frameLuma: 120, faceLuma: 130 }), "OK");
  assert.equal(classifyLighting({ frameLuma: 30, faceLuma: null }), "TOO_DARK");
  assert.equal(classifyLighting({ frameLuma: 120, faceLuma: null }), "UNKNOWN");
});

// Column-major 4×4 for a pure rotation about Y (yaw) by `deg`.
function yawMatrix(deg) {
  const a = (deg * Math.PI) / 180;
  const c = Math.cos(a), s = Math.sin(a);
  // rows: [c 0 s 0; 0 1 0 0; -s 0 c 0; 0 0 0 1]
  const m = [
    [c, 0, s, 0],
    [0, 1, 0, 0],
    [-s, 0, c, 0],
    [0, 0, 0, 1],
  ];
  const data = [];
  for (let col = 0; col < 4; col++) for (let row = 0; row < 4; row++) data.push(m[row][col]);
  return { rows: 4, columns: 4, data };
}

test("computePose recovers yaw from a rotation matrix (POC #2 decomposition)", () => {
  const p = computePose(yawMatrix(30));
  assert.ok(Math.abs(p.yaw - 30) < 1e-6, `yaw ${p.yaw}`);
  assert.ok(Math.abs(p.pitch) < 1e-6);
  assert.ok(Math.abs(p.roll) < 1e-6);
});

test("calibration: averaged baseline, rejected when unstable", () => {
  const steady = Array.from({ length: 30 }, (_, i) => ({ yaw: 5 + (i % 3) - 1, pitch: -8 + ((i % 2) ? 1 : -1) }));
  const s = summarisePose(steady);
  assert.ok(Math.abs(s.yaw - 5) < 0.2);
  assert.ok(isStableCalibration(s));
  const shaky = Array.from({ length: 30 }, (_, i) => ({ yaw: i % 2 ? 20 : -20, pitch: 0 }));
  assert.equal(isStableCalibration(summarisePose(shaky)), false);
  assert.equal(isStableCalibration(summarisePose(steady.slice(0, 3))), false); // too few samples
});

test("isLookingAway is relative to the calibrated baseline", () => {
  const baseline = { yaw: 10, pitch: -12 };
  assert.equal(isLookingAway({ yaw: 25, pitch: -12 }, baseline), false); // 15° from baseline
  assert.equal(isLookingAway({ yaw: 35, pitch: -12 }, baseline), true); // 25°
  assert.equal(isLookingAway({ yaw: 10, pitch: 6 }, baseline), true); // pitch 18°
});

test("step machine: cannot advance past a check without a result", () => {
  let s = initialState({ now: 0, sessionId: "t" });
  assert.equal(canAdvance(s), true); // welcome
  s = next(s, 1);
  assert.equal(s.step, "device");
  assert.equal(canAdvance(s), false);
  assert.equal(next(s, 2).step, "device");
  s = setResult(s, "device", { status: "fail", code: "MODELS" }, 3);
  assert.equal(canAdvance(s), false);
  s = setResult(s, "device", { status: "warn", code: "BROWSER" }, 4);
  assert.equal(next(s, 5).step, "camera");
});

test("step machine: skip records 'skipped' and moves on; rules cannot be skipped", () => {
  let s = initialState({ now: 0, sessionId: "t" });
  s = { ...s, step: "camera" };
  s = skip(s, "SKIPPED_BY_CANDIDATE", 10);
  assert.equal(s.step, "microphone");
  assert.equal(s.results.camera.status, "skipped");
  const r = skip({ ...s, step: "rules" });
  assert.equal(r.step, "rules");
  assert.equal(back(s).step, "camera");
});

test("overall readiness", () => {
  const pass = { status: "pass" };
  const all = { device: pass, camera: pass, microphone: pass, screen: pass, rules: pass, practice: pass };
  assert.equal(overall(all), "ready");
  assert.equal(overall({ ...all, screen: { status: "warn" } }), "ready_with_warnings");
  assert.equal(overall({ ...all, practice: { status: "skipped" } }), "ready_with_warnings"); // practice is optional
  assert.equal(overall({ ...all, camera: { status: "skipped" } }), "needs_help");
  assert.equal(overall({ ...all, screen: { status: "fail" } }), "needs_help");
  assert.equal(overall({}), "needs_help");
});

test("restoreState accepts our own state and rejects anything else", () => {
  const s = initialState({ now: 0, sessionId: "t" });
  assert.deepEqual(restoreState(JSON.stringify({ ...s, step: "screen" })).step, "screen");
  assert.equal(restoreState("not json"), null);
  assert.equal(restoreState(JSON.stringify({ ...s, v: 99 })), null);
  assert.equal(restoreState(JSON.stringify({ ...s, step: "nope" })), null);
  assert.equal(restoreState(null), null);
});

test("readiness report: POC #6 event shape, statuses only, no media or pose values", () => {
  let s = initialState({ now: 1000, sessionId: "practice-x", lang: "ar" });
  s = setResult(s, "device", { status: "pass" });
  s = setResult(s, "camera", { status: "warn", code: "TOO_DARK" });
  s = { ...s, calibration: { yaw: 3.2, pitch: -7.1 }, completedAt: 61000 };
  const r = buildReport(s, { contentVersion: "v1", policyStatus: "draft-placeholder", env: { browser: "Chrome 140", os: "macos", mobile: false }, now: 62000 });
  // Fields POC #6's POST /events reads:
  assert.equal(r.event_type, "READINESS_REPORT");
  assert.equal(r.session_id, "practice-x");
  assert.equal(r.confidence, null);
  assert.equal(typeof r.detail, "string");
  assert.equal(r.client_sent_at, 62000);
  assert.equal(r.readiness.overall, "needs_help");
  assert.equal(r.readiness.duration_ms, 60000);
  assert.deepEqual(r.readiness.checks.find((c) => c.id === "camera"), { id: "camera", status: "warn", code: "TOO_DARK" });
  assert.equal(r.readiness.checks.find((c) => c.id === "screen").status, "not_run");
  const json = JSON.stringify(r);
  for (const banned of ["calibration", "yaw", "pitch", "data:image", "base64", "audio"]) {
    assert.ok(!json.includes(banned), `report must not contain "${banned}"`);
  }
});

test("format: placeholders, and Arabic digits follow the pinned numbering system", () => {
  assert.equal(format("Step {current} of {total}", { current: 2, total: 8 }), "Step 2 of 8");
  assert.equal(format("{missing} stays", {}), "{missing} stays");
  assert.equal(format("{n}", { n: 5 }, "ar-u-nu-latn"), "5");
  assert.equal(format("{n}", { n: 5 }, "ar-u-nu-arab"), "٥");
  assert.equal(formatClock(179500, "en"), "3:00");
  assert.equal(formatClock(61000, "en"), "1:01");
  assert.equal(formatClock(61000, "ar-u-nu-arab"), "١:٠١");
});

test("STEPS order is the documented flow", () => {
  assert.deepEqual(STEPS, ["welcome", "device", "camera", "microphone", "screen", "rules", "practice", "summary"]);
});
