// POC #8 — practice / onboarding simulator: step views and wiring.
// Every candidate-facing string comes from content/<lang>.json through t(); none is
// hard-coded here (R&D.md 28.5, D1). Pure logic is in logic.js, media in media.js.

import * as L from "./logic.js";
import * as M from "./media.js";

const STORAGE_KEY = "poc8_onboarding_state";
const PRACTICE_MS = 3 * 60 * 1000;
const QUIET_MS = 5000;
const SPEAK_TIMEOUT_MS = 20000;
const MIN_SENTENCE_MS = 800;
const ROOM_SCAN_S = 20;
const FACE_GRACE_MS = 400; // a single missed detection shouldn't restart the 3 s hold
// With two people in view the detector drops the second face for 0.1–0.7 s at a time,
// so per-frame guidance flickered between "more than one person" and "almost there"
// every ~100 ms. The multiple-faces message is held this long after the last sighting.
const MULTI_FACE_HOLD_MS = 1000;
const params = new URLSearchParams(location.search);
const DEV = params.has("dev");
const ICON = { pass: "✓", warn: "!", fail: "✕", skipped: "–", running: "…", not_run: "○" };
const PRACTICE_CONDITIONS = ["FACE_MISSING", "OUT_OF_FRAME", "MULTIPLE_FACES", "TOO_FAR"];

const els = {
  html: document.documentElement,
  appTitle: document.getElementById("appTitle"),
  badge: document.getElementById("practiceBadge"),
  langGroup: document.getElementById("langGroup"),
  notices: document.getElementById("notices"),
  stepper: document.getElementById("stepper"),
  root: document.getElementById("stepRoot"),
  live: document.getElementById("live"),
  devPanel: document.getElementById("devPanel"),
  camDockTemplate: document.getElementById("camDockTemplate"),
};

const env = M.detectEnvironment();
const contentCache = new Map();
let content = null;
let state = null;
let current = null; // the rendered step's { leave() }
let currentNav = null; // the rendered step's nav bar { update() }
let pendingResume = null; // saved progress, offered on the welcome screen

const media = { dock: null, monitor: null, cameraStream: null, mic: null, screenStream: null };
// Kept outside `state` so a language switch re-renders the rules step without losing ticks.
const rulesForm = { env: [], cant: false, ack: false };

// --- helpers -------------------------------------------------------------------

function t(key, vars) {
  const v = L.lookup(content, key);
  if (v === undefined) {
    console.warn(`missing content key: ${key}`);
    return key;
  }
  return typeof v === "string" ? L.format(v, vars, content.meta.number_locale) : v;
}

function has(key) {
  return L.lookup(content, key) !== undefined;
}

function num(n) {
  return L.format("{n}", { n }, content.meta.number_locale);
}

function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat(Infinity)) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

const list = (items, cls = "plain") => h("ul", { class: cls }, items.map((x) => h("li", {}, x)));

function save() {
  if (pendingResume) return; // don't overwrite saved progress before the candidate chooses
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* private mode / storage blocked: progress just isn't resumable */
  }
}

function clearSaved() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

let lastAnnounced = "";
function announce(text) {
  if (!text || text === lastAnnounced) return;
  lastAnnounced = text;
  els.live.textContent = text;
}

function record(stepId, result) {
  state = L.setResult(state, stepId, result);
  save();
  renderStepper();
  currentNav?.update();
}

const passable = (id) => L.PASSABLE.has(state.results[id]?.status) && state.results[id]?.status !== "skipped";

function setStatus(el, cls, text) {
  el.className = `status-line ${cls}`;
  el.textContent = text;
}

// --- chrome --------------------------------------------------------------------

async function loadContent(lang) {
  if (!contentCache.has(lang)) {
    const res = await fetch(`content/${lang}.json`);
    if (!res.ok) throw new Error(`content/${lang}.json: HTTP ${res.status}`);
    contentCache.set(lang, await res.json());
  }
  return contentCache.get(lang);
}

async function setLanguage(lang) {
  content = await loadContent(lang);
  els.html.lang = content.meta.lang;
  els.html.dir = content.meta.dir;
  if (state) {
    state = { ...state, lang };
    save();
  }
}

function renderChrome() {
  els.appTitle.textContent = t("ui.app_title");
  els.badge.textContent = t("ui.practice_badge");
  document.title = `${t("ui.app_title")} — POC #8`;
  els.langGroup.setAttribute("aria-label", t("ui.language_label"));
  for (const b of els.langGroup.querySelectorAll("button")) b.setAttribute("aria-pressed", String(b.dataset.lang === content.meta.lang));
  const notices = [h("div", { class: "notice", "data-notice": "policy" }, t("ui.draft_policy_banner"))];
  if (content.meta.translation_status !== "source") notices.push(h("div", { class: "notice", "data-notice": "translation" }, t("ui.translation_notice")));
  els.notices.replaceChildren(...notices);
  renderStepper();
}

function renderStepper() {
  const idx = L.STEPS.indexOf(state.step);
  const ol = h(
    "ol",
    {},
    L.STEPS.map((id, i) => {
      const st = state.results[id]?.status;
      return h(
        "li",
        { "aria-current": i === idx ? "step" : null, "data-step": id },
        h("span", { class: `mark ${st || ""}`, "aria-hidden": "true" }, st ? ICON[st] : num(i + 1)),
        t(`check_names.${id}`),
        st ? h("span", { class: "sr-only" }, ` (${t(`ui.status.${st}`)})`) : null
      );
    })
  );
  els.stepper.setAttribute("aria-label", t("ui.progress_label"));
  els.stepper.replaceChildren(ol, h("div", { class: "count" }, t("ui.step_of", { current: idx + 1, total: L.STEPS.length })));
}

function enterStep(id) {
  current?.leave?.();
  current = null;
  currentNav = null;
  state = L.goTo(state, id);
  save();
  renderChrome();
  els.root.replaceChildren();
  current = VIEWS[id](els.root) || {};
  const heading = els.root.querySelector("h1");
  if (heading) {
    heading.setAttribute("tabindex", "-1");
    heading.focus();
  }
}

function goNext() {
  if (!L.canAdvance(state)) return;
  enterStep(L.STEPS[L.STEPS.indexOf(state.step) + 1]);
}

function goBack() {
  const i = L.STEPS.indexOf(state.step);
  if (i > 0) enterStep(L.STEPS[i - 1]);
}

function doSkip() {
  state = L.skip(state);
  enterStep(state.step);
}

function navBar({ skip = true, back = true } = {}) {
  const cont = h("button", { type: "button", class: "primary", "data-action": "continue", onclick: goNext }, t("ui.continue"));
  const bar = h(
    "div",
    { class: "nav-bar" },
    back ? h("button", { type: "button", "data-action": "back", onclick: goBack }, t("ui.back")) : null,
    h("span", { class: "spacer" }),
    skip ? h("button", { type: "button", class: "link", "data-action": "skip", onclick: doSkip }, t("ui.skip")) : null,
    cont
  );
  currentNav = { update: () => (cont.disabled = !L.canAdvance(state)) };
  currentNav.update();
  return bar;
}

// --- camera helpers ------------------------------------------------------------

function camDock(small = false) {
  if (!media.dock) {
    // importNode, not content.cloneNode: a clone stays owned by the template's inert
    // document, where video.play() never resolves (found in the first e2e run).
    media.dock = document.importNode(els.camDockTemplate.content, true).firstElementChild;
    media.monitor = new M.CameraMonitor(media.dock.querySelector("video"));
  }
  media.dock.classList.toggle("small", small);
  return media.dock;
}

// Throws a DOMException from getUserMedia, or an Error with code MODEL_LOAD_FAILED.
async function ensureCamera() {
  camDock();
  if (M.isLive(media.cameraStream)) return;
  const stream = await M.openCamera();
  let face;
  try {
    face = await M.loadFaceLandmarker();
  } catch (err) {
    stream.getTracks().forEach((tr) => tr.stop());
    throw Object.assign(new Error(err.message), { code: "MODEL_LOAD_FAILED" });
  }
  media.cameraStream = stream;
  await media.monitor.attach(stream, face);
}

// Drawn in raw camera coordinates; CSS mirrors the canvas together with the video.
function drawOverlay(boxes, colour, guide) {
  const canvas = media.dock.querySelector("canvas");
  const v = media.monitor.video;
  if (v.videoWidth && canvas.width !== v.videoWidth) {
    canvas.width = v.videoWidth;
    canvas.height = v.videoHeight;
  }
  const ctx = canvas.getContext("2d");
  const W = canvas.width;
  const H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  if (guide) {
    ctx.setLineDash([8, 6]);
    ctx.strokeStyle = "rgba(255,255,255,0.5)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.ellipse(W * 0.5, H * 0.44, W * 0.17, H * 0.3, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  ctx.strokeStyle = colour;
  ctx.lineWidth = 3;
  for (const b of boxes) ctx.strokeRect(b.x0 * W, b.y0 * H, (b.x1 - b.x0) * W, (b.y1 - b.y0) * H);
}

function stopScreen() {
  media.screenStream?.getTracks().forEach((tr) => tr.stop());
  media.screenStream = null;
}

function stopAllMedia() {
  media.monitor?.stop();
  media.cameraStream = null;
  media.mic?.destroy();
  media.mic = null;
  stopScreen();
}

// --- steps ---------------------------------------------------------------------

const VIEWS = {
  welcome(root) {
    const w = "steps.welcome";
    if (pendingResume) {
      const saved = pendingResume;
      root.append(
        h(
          "div",
          { class: "card", "data-testid": "resume" },
          h("h2", {}, t("ui.resume_title")),
          h("p", {}, t("ui.resume_body", { step: t(`check_names.${saved.step}`) })),
          h(
            "div",
            { class: "nav-bar" },
            h(
              "button",
              {
                type: "button",
                class: "primary",
                "data-action": "resume",
                onclick: () => {
                  pendingResume = null;
                  state = { ...saved, lang: state.lang };
                  enterStep(saved.step);
                },
              },
              t("ui.resume_yes")
            ),
            h(
              "button",
              {
                type: "button",
                onclick: () => {
                  pendingResume = null;
                  clearSaved();
                  enterStep("welcome");
                },
              },
              t("ui.resume_no")
            )
          )
        )
      );
    }
    root.append(
      h(
        "div",
        { class: "card" },
        h("h1", {}, t(`${w}.title`)),
        h("p", {}, t(`${w}.intro`)),
        h("p", { class: "muted" }, t(`${w}.duration`, { minutes: 5 })),
        h("h2", {}, t(`${w}.privacy_title`)),
        list(t(`${w}.privacy_points`)),
        h("h2", {}, t(`${w}.need_title`)),
        list(t(`${w}.need_points`)),
        h(
          "div",
          { class: "nav-bar" },
          h("span", { class: "spacer" }),
          h(
            "button",
            {
              type: "button",
              class: "primary",
              "data-action": "start",
              onclick: () => {
                pendingResume = null;
                enterStep("device");
              },
            },
            t(`${w}.start`)
          )
        )
      )
    );
  },

  device(root) {
    const d = "steps.device.checks";
    const rows = {};
    const results = {};
    const ul = h("ul", { class: "check-list" });
    const summary = h("div", { class: "status-line" });
    const setRow = (key, status, msg) => {
      results[key] = status;
      const row = h(
        "li",
        { "data-check": key, "data-status": status },
        h("span", { class: `icon ${status}`, "aria-hidden": "true" }, ICON[status]),
        h("span", {}, t(`${d}.${key}.label`)),
        h("span", { class: "state" }, t(`ui.status.${status}`)),
        msg ? h("span", { class: "msg" }, msg) : null
      );
      if (rows[key]) rows[key].replaceWith(row);
      else ul.append(row);
      rows[key] = row;
    };
    const a = env.apis;
    const sync = [
      ["secure_context", env.secureContext],
      ["desktop", !env.mobile],
      ["browser", env.chromium || "warn"],
      ["camera_api", a.getUserMedia],
      ["screen_api", a.getDisplayMedia],
      ["webrtc", a.webrtc],
      ["wasm", a.wasm],
      ["screen_size", (env.screen.width >= 1024 && env.screen.height >= 600) || "warn"],
    ];
    for (const [key, ok] of sync) {
      if (ok === true) setRow(key, "pass");
      else if (ok === "warn") setRow(key, "warn", t(`${d}.${key}.warn`, { browser: env.browser }));
      else setRow(key, "fail", t(`${d}.${key}.fail`));
    }
    setRow("models", "running", t(`${d}.models.loading`));

    root.append(h("div", { class: "card" }, h("h1", {}, t("steps.device.title")), h("p", {}, t("steps.device.intro")), ul, summary, navBar()));

    let alive = true;
    const finish = () => {
      if (!alive) return;
      const entries = Object.entries(results);
      const fail = entries.find(([, s]) => s === "fail");
      const warn = entries.find(([, s]) => s === "warn");
      const worst = fail || warn;
      const status = fail ? "fail" : warn ? "warn" : "pass";
      record("device", {
        status,
        code: worst ? worst[0].toUpperCase() : null,
        msg: worst ? `${d}.${worst[0]}.${fail ? "fail" : "warn"}` : null,
        params: { browser: env.browser },
      });
      setStatus(summary, status, t(status === "pass" ? "steps.device.all_good" : "steps.device.has_issues"));
      announce(summary.textContent);
    };
    if (!a.wasm) {
      setRow("models", "fail", t(`${d}.models.fail`));
      finish();
    } else {
      M.loadFaceLandmarker().then(
        () => alive && (setRow("models", "pass"), finish()),
        (err) => {
          console.error(err);
          if (alive) (setRow("models", "fail", t(`${d}.models.fail`)), finish());
        }
      );
    }
    return { leave: () => (alive = false) };
  },

  camera(root) {
    const c = "steps.camera";
    const guidance = h("div", { class: "guidance", "data-testid": "guidance" });
    const hint = h("div", { class: "hint", "data-testid": "hint" });
    const lighting = h("div", { class: "lighting", "data-testid": "lighting" });
    const status = h("div", { class: "status-line", "data-testid": "camera-status" });
    const actions = h("div", { class: "controls" });
    const stage = h("div", {});
    root.append(h("div", { class: "card" }, h("h1", {}, t(`${c}.title`)), h("p", {}, t(`${c}.intro`)), stage, status, actions, navBar()));

    let alive = true;
    let holdStart = null;
    let lastGood = 0;
    let lastMulti = -Infinity;
    let samples = [];
    let lightOkSince = null;
    let lastCode = null;

    const showResult = () => {
      const r = state.results.camera;
      if (!r || !passable("camera")) return;
      setStatus(status, r.status, t(r.status === "pass" ? `${c}.passed` : `${c}.lighting_only`));
    };

    const fail = (err) => {
      const code = err?.code === "MODEL_LOAD_FAILED" ? "MODEL_LOAD_FAILED" : err?.name || "Error";
      const msg = code === "MODEL_LOAD_FAILED" ? "steps.device.checks.models.fail" : has(`${c}.errors.${code}`) ? `${c}.errors.${code}` : `${c}.errors.generic`;
      record("camera", { status: "fail", code, msg, params: { code } });
      setStatus(status, "fail", t(msg, { code }));
      announce(status.textContent);
      actions.replaceChildren(h("button", { type: "button", class: "primary", "data-action": "retry", onclick: start }, t("ui.retry")));
    };

    const onFrame = (f) => {
      if (f.boxes.length > 1) lastMulti = f.now;
      const setup = f.now - lastMulti < MULTI_FACE_HOLD_MS ? { code: "MULTIPLE_FACES", hint: null } : L.classifySetupFrame(f.boxes);
      const light = L.classifyLighting(f.luma);
      const lightBad = light !== "OK" && light !== "UNKNOWN";
      drawOverlay(f.boxes, setup.code === "GOOD" ? "#2ecc71" : "#f39c12", true);
      lighting.textContent = light === "UNKNOWN" ? "" : t(`${c}.lighting.${light}`);
      lighting.classList.toggle("bad", lightBad);
      lighting.dataset.code = light;
      hint.textContent = setup.hint ? t(`${c}.hints.${setup.hint}`) : "";
      hint.dataset.code = setup.hint || "";
      guidance.dataset.code = setup.code;
      if (setup.code === "GOOD") lastGood = f.now;

      if (!passable("camera")) {
        if (setup.code === "GOOD") {
          holdStart ??= f.now;
          if (f.pose) samples.push(f.pose);
          const left = L.SETUP_BAND.holdMs - (f.now - holdStart);
          if (left > 0) {
            guidance.textContent = t(`${c}.holding`, { seconds: Math.ceil(left / 1000) });
          } else {
            const s = L.summarisePose(samples);
            if (L.isStableCalibration(s)) {
              state = { ...state, calibration: { yaw: s.yaw, pitch: s.pitch } };
              record("camera", lightBad ? { status: "warn", code: light, msg: `${c}.lighting.${light}` } : { status: "pass" });
              guidance.textContent = t(`${c}.guidance.GOOD`);
              showResult();
              announce(status.textContent);
            } else {
              guidance.textContent = t(`${c}.unstable`);
            }
            holdStart = null;
            samples = [];
          }
        } else if (f.now - lastGood > FACE_GRACE_MS) {
          holdStart = null;
          samples = [];
          guidance.textContent = t(`${c}.guidance.${setup.code}`);
        }
      } else {
        guidance.textContent = t(`${c}.guidance.${setup.code}`);
        // A lighting warning upgrades to a pass once the lighting is fixed.
        if (state.results.camera.status === "warn" && light === "OK") {
          lightOkSince ??= f.now;
          if (f.now - lightOkSince > 1000) {
            record("camera", { status: "pass" });
            showResult();
          }
        } else {
          lightOkSince = null;
        }
      }
      if (setup.code !== lastCode) {
        lastCode = setup.code;
        announce(`${guidance.textContent} ${hint.textContent}`.trim());
      }
    };

    async function start() {
      actions.replaceChildren();
      setStatus(status, "info", t(`${c}.requesting`));
      try {
        await ensureCamera();
      } catch (err) {
        console.error(err);
        if (alive) fail(err);
        return;
      }
      if (!alive) return;
      setStatus(status, "", "");
      stage.replaceChildren(camDock(false), guidance, hint, lighting);
      media.monitor.onFrame = onFrame;
      media.monitor.resume();
      showResult();
    }

    if (M.isLive(media.cameraStream)) start();
    else actions.append(h("button", { type: "button", class: "primary", "data-action": "camera-on", onclick: start }, t(`${c}.allow_btn`)));

    return {
      leave() {
        alive = false;
        if (media.monitor) {
          media.monitor.onFrame = null;
          media.monitor.pause();
        }
      },
    };
  },

  microphone(root) {
    const m = "steps.microphone";
    const fill = h("div", { class: "meter-fill" });
    const meter = h("div", { class: "meter", role: "meter", "aria-label": t(`${m}.level_label`), "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": "0" }, fill);
    const phase = h("div", { class: "guidance", "data-testid": "mic-phase" });
    const sentence = h("div", { class: "sentence", hidden: true }, t(`${m}.sentence`));
    const status = h("div", { class: "status-line", "data-testid": "mic-status" });
    const tips = h("div", {});
    const actions = h("div", { class: "controls" });
    const stage = h("div", { hidden: true }, h("p", { class: "muted" }, t(`${m}.level_label`)), meter, phase, sentence);
    root.append(h("div", { class: "card" }, h("h1", {}, t(`${m}.title`)), h("p", {}, t(`${m}.intro`)), stage, status, tips, actions, navBar()));

    let alive = true;
    let raf = null;
    let timers = [];
    let maxDb = -100;
    let phaseName = null;
    let heardQuiet = false;
    const clearTimers = () => {
      timers.forEach(clearTimeout);
      timers = [];
    };
    const retryBtn = (fn) => h("button", { type: "button", class: "primary", "data-action": "retry", onclick: fn }, t("ui.retry"));

    const levelLoop = () => {
      if (!alive || !media.mic) return;
      const db = media.mic.levelDb();
      maxDb = Math.max(maxDb, db);
      const pct = Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
      fill.style.width = `${pct}%`;
      meter.setAttribute("aria-valuenow", String(Math.round(pct)));
      raf = requestAnimationFrame(levelLoop);
    };

    const handlers = {
      onSpeechStart: () => {
        if (phaseName === "quiet") heardQuiet = true;
        if (phaseName === "speak") phase.textContent = t(`${m}.listening`);
      },
      onSpeechEnd: (ms) => {
        if (phaseName === "speak" && ms >= MIN_SENTENCE_MS) heard();
      },
    };

    const failWith = (code, msg) => {
      record("microphone", { status: "fail", code, msg, params: { code } });
      setStatus(status, "fail", t(msg, { code }));
      announce(status.textContent);
    };

    async function start() {
      actions.replaceChildren();
      tips.replaceChildren();
      setStatus(status, "info", t(`${m}.requesting`));
      if (!media.mic) {
        let stream;
        try {
          stream = await M.openMic();
        } catch (err) {
          const code = err?.name || "Error";
          if (!alive) return;
          failWith(code, has(`${m}.errors.${code}`) ? `${m}.errors.${code}` : `${m}.errors.generic`);
          actions.replaceChildren(retryBtn(start));
          return;
        }
        media.mic = new M.MicMonitor(stream);
      }
      if (!alive) return;
      media.mic.handlers = handlers;
      stage.hidden = false;
      cancelAnimationFrame(raf);
      levelLoop();
      setStatus(status, "info", t(`${m}.loading`));
      try {
        await media.mic.startVad();
      } catch (err) {
        console.error(err);
        if (!alive) return;
        failWith("VAD_LOAD_FAILED", `${m}.load_failed`);
        actions.replaceChildren(retryBtn(start));
        return;
      }
      if (!alive) return;
      setStatus(status, "", "");
      runQuiet();
    }

    function runQuiet() {
      clearTimers();
      actions.replaceChildren();
      tips.replaceChildren();
      heardQuiet = false;
      maxDb = -100;
      phaseName = "quiet";
      phase.dataset.phase = "quiet";
      sentence.hidden = true;
      const end = performance.now() + QUIET_MS;
      const tick = () => {
        const left = end - performance.now();
        if (left <= 0) return runSpeak();
        phase.textContent = t(`${m}.phase_quiet`, { seconds: Math.ceil(left / 1000) });
        timers.push(setTimeout(tick, 200));
      };
      tick();
      announce(phase.textContent);
    }

    function runSpeak() {
      clearTimers();
      phaseName = "speak";
      phase.dataset.phase = "speak";
      phase.textContent = t(`${m}.phase_speak`);
      sentence.hidden = false;
      tips.replaceChildren(
        heardQuiet
          ? h("div", { class: "status-line warn", "data-testid": "quiet-result" }, t(`${m}.quiet_heard`))
          : h("div", { class: "status-line pass", "data-testid": "quiet-result" }, t(`${m}.quiet_ok`))
      );
      announce(`${phase.textContent} ${t(`${m}.sentence`)}`);
      timers.push(setTimeout(notHeard, SPEAK_TIMEOUT_MS));
    }

    function heard() {
      clearTimers();
      phaseName = "done";
      phase.dataset.phase = "done";
      phase.textContent = "";
      sentence.hidden = true;
      record("microphone", heardQuiet ? { status: "warn", code: "BACKGROUND_SPEECH", msg: `${m}.quiet_heard` } : { status: "pass" });
      setStatus(status, heardQuiet ? "warn" : "pass", t(`${m}.heard`));
      announce(status.textContent);
      actions.replaceChildren(h("button", { type: "button", "data-action": "retry", onclick: runQuiet }, t("ui.retry")));
    }

    function notHeard() {
      phaseName = "done";
      phase.dataset.phase = "done";
      sentence.hidden = true;
      failWith("NOT_HEARD", `${m}.not_heard`);
      const items = [...t(`${m}.not_heard_tips`)];
      if (maxDb < -70) items.unshift(t(`${m}.muted_hint`));
      tips.replaceChildren(list(items));
      actions.replaceChildren(retryBtn(runQuiet));
    }

    if (media.mic && passable("microphone")) {
      // Coming back (or switching language) after a pass: show it, offer a re-test.
      media.mic.handlers = handlers;
      stage.hidden = false;
      levelLoop();
      setStatus(status, state.results.microphone.status, t(`${m}.heard`));
      actions.append(h("button", { type: "button", "data-action": "retry", onclick: start }, t("ui.retry")));
    } else if (media.mic) {
      start();
    } else {
      actions.append(h("button", { type: "button", class: "primary", "data-action": "mic-on", onclick: start }, t(`${m}.allow_btn`)));
    }

    return {
      leave() {
        alive = false;
        clearTimers();
        cancelAnimationFrame(raf);
        if (media.mic) {
          media.mic.pause();
          media.mic.handlers = {};
        }
      },
    };
  },

  screen(root) {
    const s = "steps.screen";
    const isMac = env.os === "macos";
    const macBox = h(
      "div",
      { class: "mac-box", hidden: !isMac, "data-testid": "mac-help" },
      h("h2", {}, t(`${s}.mac_title`)),
      h("ol", { class: "plain" }, t(`${s}.mac_steps`).map((x) => h("li", {}, x))),
      h("p", { class: "muted" }, t(`${s}.mac_note`))
    );
    const status = h("div", { class: "status-line", "data-testid": "screen-status" });
    const note = h("p", { class: "muted", hidden: true }, t(`${s}.preview_note`));
    const preview = h("video", { class: "screen-preview", autoplay: true, muted: true, playsinline: true });
    const shareBtn = h("button", { type: "button", class: "primary", "data-action": "share" }, t(`${s}.share_btn`));
    root.append(
      h(
        "div",
        { class: "card" },
        h("h1", {}, t(`${s}.title`)),
        h("p", {}, t(`${s}.intro`)),
        list(t(`${s}.instructions`)),
        macBox,
        h("div", { class: "controls" }, shareBtn),
        status,
        preview,
        note,
        navBar()
      )
    );

    const show = (r) => {
      setStatus(status, r.status, t(r.msg, r.params));
      if (r.status === "fail") shareBtn.textContent = t("ui.retry");
    };
    if (state.results.screen?.msg) show(state.results.screen);

    shareBtn.addEventListener("click", async () => {
      stopScreen();
      preview.srcObject = null;
      preview.classList.remove("live");
      note.hidden = true;
      shareBtn.disabled = true;
      setStatus(status, "info", t(`${s}.sharing`));
      const res = await M.tryScreenShare();
      shareBtn.disabled = false;
      const surface = res.surface ? (has(`${s}.surface_names.${res.surface}`) ? t(`${s}.surface_names.${res.surface}`) : res.surface) : "";
      const msg = res.status === "pass" ? `${s}.passed` : has(`${s}.errors.${res.code}`) ? `${s}.errors.${res.code}` : `${s}.errors.generic`;
      const r = { status: res.status, code: res.code, msg, params: { surface, code: res.code } };
      record("screen", r);
      show(r);
      if (res.stream) {
        media.screenStream = res.stream;
        preview.srcObject = res.stream;
        preview.classList.add("live");
        note.hidden = false;
        res.stream.getVideoTracks()[0].addEventListener("ended", () => {
          preview.srcObject = null;
          preview.classList.remove("live");
        });
      }
      if (res.code === "NotAllowedError" && isMac) {
        macBox.classList.add("emphasis");
        macBox.scrollIntoView({ block: "nearest" });
      }
      announce(status.textContent);
    });

    return { leave: stopScreen };
  },

  rules(root) {
    const r = "steps.rules";
    const group = (kind, titleKey) =>
      h(
        "div",
        {},
        h("h2", {}, t(`${r}.${titleKey}`)),
        content.rules
          .filter((x) => x.kind === kind)
          .map((rule) =>
            h(
              "div",
              { class: `rule ${kind}`, "data-rule": rule.id },
              h("div", { class: "rule-title" }, rule.title),
              h("div", { class: "rule-text" }, rule.text),
              rule.if_detected ? h("div", { class: "rule-if" }, h("b", {}, t(`${r}.if_detected`)), " ", rule.if_detected) : null
            )
          )
      );

    const envItems = t(`${r}.env_items`);
    const envHint = h("p", { class: "muted", "data-testid": "env-hint" });
    const checkbox = (checked, onchange) => h("input", { type: "checkbox", checked, onchange });
    const envBoxes = envItems.map((text, i) =>
      h("label", {}, checkbox(rulesForm.env[i], (e) => ((rulesForm.env[i] = e.target.checked), update())), h("span", {}, text))
    );
    const cantBox = h("label", { class: "cant" }, checkbox(rulesForm.cant, (e) => ((rulesForm.cant = e.target.checked), update())), h("span", {}, t(`${r}.env_cant`)));
    const ackBox = h("label", { class: "ack" }, checkbox(rulesForm.ack, (e) => ((rulesForm.ack = e.target.checked), update())), h("span", {}, t(`${r}.ack`)));

    // Optional room-scan practice: preview + countdown only. No detection, no recording.
    const scanStage = h("div", {});
    const scanStatus = h("div", { class: "status-line" });
    const scanBtn = h("button", { type: "button", "data-action": "room-scan" }, t(`${r}.room_scan_btn`, { seconds: ROOM_SCAN_S }));
    let scanTimer = null;
    if (state.practice.roomScan) setStatus(scanStatus, "pass", t(`${r}.room_scan_done`));
    if (!M.isLive(media.cameraStream)) {
      scanBtn.disabled = true;
      setStatus(scanStatus, "info", t(`${r}.room_scan_no_camera`));
    }
    scanBtn.addEventListener("click", () => {
      scanBtn.disabled = true;
      scanStage.replaceChildren(camDock(true));
      drawOverlay([], "#fff", false);
      media.monitor.video.play().catch(() => {});
      const end = Date.now() + ROOM_SCAN_S * 1000;
      const tick = () => {
        const left = end - Date.now();
        if (left <= 0) {
          state = { ...state, practice: { ...state.practice, roomScan: true } };
          save();
          scanStage.replaceChildren();
          setStatus(scanStatus, "pass", t(`${r}.room_scan_done`));
          scanBtn.disabled = false;
          return;
        }
        setStatus(scanStatus, "info", t(`${r}.room_scan_running`, { seconds: Math.ceil(left / 1000) }));
        scanTimer = setTimeout(tick, 250);
      };
      tick();
    });

    root.append(
      h("div", { class: "card" }, h("h1", {}, t(`${r}.title`)), h("p", {}, t(`${r}.intro`)), h("div", { class: "rule-groups" }, group("allowed", "allowed_title"), group("prohibited", "prohibited_title"), group("behaviour", "behaviour_title"))),
      h("div", { class: "card" }, h("h2", {}, t(`${r}.id_title`)), h("p", {}, t(`${r}.id_body`))),
      h("div", { class: "card" }, h("h2", {}, t(`${r}.env_title`)), h("div", { class: "checks" }, envBoxes, cantBox), envHint),
      h("div", { class: "card" }, h("h2", {}, t(`${r}.room_scan_title`)), h("p", {}, t(`${r}.room_scan_body`)), scanBtn, scanStatus, scanStage),
      h("div", { class: "card" }, h("h2", {}, t(`${r}.faq_title`)), t(`${r}.faq`).map(({ q, a }) => h("details", { class: "faq" }, h("summary", {}, q), h("p", {}, a)))),
      h("div", { class: "card" }, ackBox, navBar({ skip: false }))
    );

    function update() {
      const allEnv = envItems.every((_, i) => rulesForm.env[i]);
      envHint.textContent = allEnv || rulesForm.cant ? "" : t(`${r}.env_incomplete`);
      if (!rulesForm.ack || !(allEnv || rulesForm.cant)) {
        if (state.results.rules) record("rules", { status: "fail", code: rulesForm.ack ? "ENVIRONMENT_INCOMPLETE" : "NOT_ACKNOWLEDGED" });
        currentNav?.update();
        return;
      }
      record("rules", allEnv ? { status: "pass" } : { status: "warn", code: "ENVIRONMENT_NOT_READY", msg: `${r}.env_cant` });
    }
    update();

    // Warm up the phone model so the practice exam starts without a wait.
    M.loadPhoneDetector().catch(() => {});

    return {
      leave() {
        clearTimeout(scanTimer);
        media.monitor?.pause();
      },
    };
  },

  practice(root) {
    const p = "steps.practice";
    const T = L.EXAM_THRESHOLDS;
    const qs = content.practice_questions;
    let alive = true;
    let timerId = null;
    let okTimer = null;

    const timer = h("span", { class: "timer", role: "timer", "data-testid": "timer" });
    const nudge = h("div", { class: "nudge ok", role: "status", "data-testid": "nudge" }, t(`${p}.all_clear`));
    const camSlot = h("div", {});
    const tryRows = {};
    const tryList = h(
      "ul",
      { class: "try-list" },
      Object.keys(content.steps.practice.try_items).map((code) => {
        const done = (state.practice.nudges[code] || 0) > 0;
        const row = h(
          "li",
          { class: done ? "done" : "", "data-try": code },
          h("span", { class: "box", "aria-hidden": "true" }, done ? "✓" : "○"),
          h("span", {}, t(`${p}.try_items.${code}`), h("span", { class: "unavail" }))
        );
        tryRows[code] = row;
        return row;
      })
    );
    const unavailable = (codes, text) => codes.forEach((c) => tryRows[c] && (tryRows[c].querySelector(".unavail").textContent = text));
    const alertCard = h("div", { class: "alert-card", hidden: true, "data-testid": "alert-card" });
    const steps = t(`${p}.what_next_steps`);
    const whatNext = h("div", { class: "what-next" }, h("h2", {}, t(`${p}.what_next_title`)), h("ol", {}, h("li", {}, steps[0]), h("li", {}, steps[1], alertCard), h("li", {}, steps[2])));

    const question = (q) =>
      h(
        "div",
        { class: "question", "data-question": q.id },
        h(
          "fieldset",
          {},
          h("legend", {}, q.prompt),
          q.options.map((opt, i) =>
            h(
              "label",
              {},
              h("input", {
                type: "radio",
                name: q.id,
                value: String(i),
                checked: state.practice.answers[q.id] === i,
                onchange: () => {
                  state = { ...state, practice: { ...state.practice, answers: { ...state.practice.answers, [q.id]: i } } };
                  save();
                },
              }),
              h("span", {}, opt)
            )
          )
        )
      );
    const form = h("form", { onsubmit: (e) => (e.preventDefault(), finish(false)) }, qs.map(question), h("button", { type: "submit", class: "primary", "data-action": "finish" }, t(`${p}.submit`)));
    const examCard = h("div", { class: "card" }, h("div", { class: "exam-head" }, h("span", { class: "not-scored" }, t(`${p}.not_scored`)), h("span", {}, t(`${p}.timer_label`), " ", timer)), form);
    const grid = h("div", { class: "practice-grid", hidden: true }, examCard, h("div", { class: "card" }, camSlot, nudge, h("h2", {}, t(`${p}.try_title`)), tryList, whatNext));
    const startBtn = h("button", { type: "button", class: "primary", "data-action": "start-practice", onclick: () => begin() }, t(`${p}.start_btn`));
    const intro = h("div", { class: "card" }, h("h1", {}, t(`${p}.title`)), h("p", {}, t(`${p}.intro`)), startBtn);
    root.append(intro, grid, h("div", { class: "card" }, navBar()));

    // --- detection → nudges ---
    const faceConds = PRACTICE_CONDITIONS.map((code) => [code, new L.Persistence(T.face)]);
    const pose = new L.Persistence(T.pose);
    const phone = new L.Persistence(T.phone);
    const active = new Map();

    function raise(code, heldMs) {
      active.set(code, heldMs);
      const nudges = { ...state.practice.nudges, [code]: (state.practice.nudges[code] || 0) + 1 };
      state = { ...state, practice: { ...state.practice, nudges } };
      save();
      const row = tryRows[code];
      if (row) {
        row.classList.add("done");
        row.querySelector(".box").textContent = "✓";
      }
      alertCard.replaceChildren(
        h("span", { class: "muted" }, t(`${p}.alert_example`), " · "),
        h("bdi", { class: "code" }, code),
        h("span", { class: "label" }, `${t(`proctor_alerts.${code}`)} · ${t("proctor_alerts.duration", { seconds: heldMs / 1000 })}`),
        h("span", { class: "alert-status" }, t(`${p}.alert_status`), " · ", h("bdi", {}, "ALERTED"))
      );
      alertCard.hidden = false;
      alertCard.dataset.code = code;
      showNudge();
      announce(t(`nudges.${code}`));
    }

    function clear(code) {
      if (!active.delete(code)) return;
      showNudge();
    }

    function showNudge() {
      clearTimeout(okTimer);
      const last = [...active.keys()].at(-1);
      if (last) {
        nudge.className = "nudge alert";
        nudge.dataset.code = last;
        nudge.textContent = t(`nudges.${last}`);
        return;
      }
      nudge.className = "nudge ok";
      nudge.dataset.code = "";
      nudge.textContent = t(`${p}.back_to_normal`);
      okTimer = setTimeout(() => !active.size && (nudge.textContent = t(`${p}.all_clear`)), 2500);
    }

    const handle = (code, change, heldMs) => {
      if (change === "raised") raise(code, heldMs);
      else if (change === "cleared") clear(code);
    };

    const onFrame = (f) => {
      const code = L.classifyExamFrame(f.boxes);
      drawOverlay(f.boxes, code === "PRESENT" ? "#2ecc71" : "#f39c12", false);
      for (const [c, pers] of faceConds) handle(c, pers.update(code === c, f.now), T.face.raiseMs);
      const away = code === "PRESENT" && f.pose && state.calibration ? L.isLookingAway(f.pose, state.calibration) : false;
      handle("LOOKING_AWAY", pose.update(away, f.now), T.pose.raiseMs);
      if (f.phoneScore != null) handle("PHONE_DETECTED", phone.update(f.phoneScore >= T.phone.minScore, f.now), T.phone.raiseMs);
    };

    async function startDetectors() {
      if (passable("camera")) {
        try {
          await ensureCamera();
          if (!alive) return;
          camSlot.replaceChildren(camDock(true));
          media.monitor.onFrame = onFrame;
          media.monitor.resume();
          if (!state.calibration) unavailable(["LOOKING_AWAY"], t(`${p}.pose_unavailable`));
          unavailable(["PHONE_DETECTED"], t(`${p}.phone_loading`));
          M.loadPhoneDetector().then(
            (det) => {
              if (!alive) return;
              media.monitor.setPhone(det, true);
              unavailable(["PHONE_DETECTED"], "");
            },
            () => alive && unavailable(["PHONE_DETECTED"], t(`${p}.phone_unavailable`))
          );
        } catch (err) {
          console.error(err);
          unavailable(["LOOKING_AWAY", "FACE_MISSING", "PHONE_DETECTED"], t(`${p}.camera_unavailable`));
        }
      } else {
        unavailable(["LOOKING_AWAY", "FACE_MISSING", "PHONE_DETECTED"], t(`${p}.camera_unavailable`));
      }
      if (passable("microphone")) {
        try {
          if (!media.mic) media.mic = new M.MicMonitor(await M.openMic());
          media.mic.handlers = {
            onSpeechStart: () => raise("SPEECH_DETECTED", T.vad.minSpeechMs),
            onSpeechEnd: () => clear("SPEECH_DETECTED"),
          };
          await media.mic.startVad();
        } catch (err) {
          console.error(err);
          unavailable(["SPEECH_DETECTED"], t(`${p}.mic_unavailable`));
        }
      } else {
        unavailable(["SPEECH_DETECTED"], t(`${p}.mic_unavailable`));
      }
    }

    function stopDetectors() {
      if (media.monitor) {
        media.monitor.onFrame = null;
        media.monitor.setPhone(null, false);
        media.monitor.pause();
      }
      if (media.mic) {
        media.mic.pause();
        media.mic.handlers = {};
      }
    }

    function tick() {
      const left = state.practice.startedAt + PRACTICE_MS - Date.now();
      timer.textContent = L.formatClock(left, content.meta.number_locale);
      if (left <= 0) finish(true);
    }

    function begin() {
      if (!state.practice.startedAt) {
        state = { ...state, practice: { ...state.practice, startedAt: Date.now() } };
        save();
      }
      startBtn.remove();
      grid.hidden = false;
      tick();
      timerId = setInterval(tick, 250);
      startDetectors();
    }

    function finish(timeUp) {
      clearInterval(timerId);
      stopDetectors();
      state = { ...state, practice: { ...state.practice, submitted: true } };
      record("practice", { status: "pass" });
      showResults(timeUp);
    }

    function showResults(timeUp) {
      startBtn.remove();
      grid.hidden = false;
      const answers = state.practice.answers;
      const correct = qs.filter((q) => answers[q.id] === q.correct).length;
      form.replaceWith(
        h(
          "div",
          { "data-testid": "practice-results" },
          h("h2", {}, t(`${p}.result_title`)),
          timeUp ? h("p", { class: "muted" }, t(`${p}.time_up`)) : null,
          h("p", {}, t(`${p}.result_score`, { correct, total: qs.length })),
          qs.map((q) => {
            const a = answers[q.id];
            const right = a === q.correct;
            return h(
              "div",
              { class: "question" },
              h("div", { class: "rule-title" }, q.prompt),
              h("div", {}, `${t(`${p}.your_answer`)}: `, a == null ? "–" : q.options[a]),
              h("div", { class: `feedback ${right ? "right" : "wrong"}` }, right ? "✓ " : `✕ ${q.options[q.correct]} — `, `${t(`${p}.explanation`)}: ${q.explanation}`)
            );
          })
        )
      );
      timer.textContent = L.formatClock(0, content.meta.number_locale);
    }

    if (state.practice.submitted) {
      showResults(false);
    } else if (state.practice.startedAt && (!passable("microphone") || media.mic?.ctx.state === "running")) {
      begin(); // language switch mid-practice: carry on without another click
    }

    return {
      leave() {
        alive = false;
        clearInterval(timerId);
        clearTimeout(okTimer);
        stopDetectors();
      },
    };
  },

  summary(root) {
    stopAllMedia();
    const s = "steps.summary";
    const ov = L.overall(state.results);
    const report = () =>
      L.buildReport(state, { contentVersion: content.meta.content_version, policyStatus: content.meta.policy_status, env: { browser: env.browser, os: env.os, mobile: env.mobile } });
    const download = () => {
      const blob = new Blob([JSON.stringify(report(), null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = h("a", { href: url, download: `poc8-readiness-${state.sessionId}.json` });
      document.body.append(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    };
    const restart = () => {
      clearSaved();
      Object.assign(rulesForm, { env: [], cant: false, ack: false });
      state = L.initialState({ lang: state.lang });
      enterStep("welcome");
    };
    root.append(
      h("div", { class: `card overall ${ov}`, "data-overall": ov }, h("h1", {}, t(`${s}.overall.${ov}.title`)), h("p", {}, t(`${s}.overall.${ov}.body`)), h("p", { class: "muted" }, t(`${s}.media_off`))),
      h(
        "div",
        { class: "card" },
        h("h2", {}, t(`${s}.checks_title`)),
        h(
          "ul",
          { class: "check-list" },
          L.CHECK_STEPS.map((id) => {
            const r = state.results[id];
            const st = r?.status || "not_run";
            return h(
              "li",
              { "data-check": id, "data-status": st },
              h("span", { class: `icon ${st}`, "aria-hidden": "true" }, ICON[st]),
              h("span", {}, t(`check_names.${id}`)),
              h("span", { class: "state" }, t(`ui.status.${st}`)),
              r?.msg ? h("span", { class: "msg" }, t(r.msg, r.params)) : null
            );
          })
        ),
        h(
          "div",
          { class: "nav-bar" },
          h("button", { type: "button", class: "primary", "data-action": "download", onclick: download }, t(`${s}.download_btn`)),
          h("span", { class: "muted" }, t(`${s}.report_privacy`)),
          h("span", { class: "spacer" }),
          h("button", { type: "button", "data-action": "restart", onclick: restart }, t(`${s}.restart_btn`))
        )
      ),
      h("div", { class: "card" }, h("h2", {}, t(`${s}.exam_day_title`)), list(t(`${s}.exam_day`)))
    );
  },
};

// --- boot ----------------------------------------------------------------------

async function boot() {
  let saved = null;
  try {
    saved = L.restoreState(localStorage.getItem(STORAGE_KEY));
  } catch {
    /* storage blocked */
  }
  const browserLang = (navigator.language || "en").toLowerCase().startsWith("ar") ? "ar" : "en";
  const lang = ["en", "ar"].includes(params.get("lang")) ? params.get("lang") : saved?.lang || browserLang;
  await setLanguage(lang);
  state = L.initialState({ lang });
  if (saved && saved.step !== "welcome") pendingResume = saved;

  els.langGroup.addEventListener("click", async (e) => {
    const lang = e.target.closest("button")?.dataset.lang;
    if (!lang || lang === content.meta.lang) return;
    await setLanguage(lang);
    enterStep(state.step);
  });

  enterStep("welcome");

  // Read-only hook for the automated tests and for debugging in the console.
  window.poc8 = {
    get state() {
      return state;
    },
    get report() {
      return L.buildReport(state, { contentVersion: content.meta.content_version, policyStatus: content.meta.policy_status, env: { browser: env.browser, os: env.os, mobile: env.mobile } });
    },
    metrics: M.metrics,
    env,
    mediaLive: () => ({
      camera: M.isLive(media.cameraStream) || M.isLive(media.monitor?.stream),
      mic: M.isLive(media.mic?.stream),
      screen: M.isLive(media.screenStream),
    }),
  };

  if (DEV) {
    els.devPanel.hidden = false;
    setInterval(() => {
      const m = M.metrics;
      els.devPanel.textContent = [
        `content ${content.meta.content_version} (${content.meta.lang}, ${content.meta.translation_status})`,
        `face ${m.faceFps ?? "–"} fps, ${m.faceMs?.toFixed(1) ?? "–"} ms (warm-up ${m.faceWarmupMs ?? "–"} ms) [${m.faceDelegate ?? "–"}]`,
        `phone ${m.phoneMs?.toFixed(1) ?? "–"} ms every ${m.phoneIntervalMs ?? "–"} ms (warm-up ${m.phoneWarmupMs ?? "–"} ms) [${m.phoneDelegate ?? "–"}]`,
        `load: face ${m.faceModelLoadMs ?? "–"} ms, phone ${m.phoneModelLoadMs ?? "–"} ms, vad ${m.vadLoadMs ?? "–"} ms`,
        `calibration ${state.calibration ? `${state.calibration.yaw.toFixed(1)}°/${state.calibration.pitch.toFixed(1)}°` : "–"}`,
      ].join("\n");
    }, 1000);
  }
}

boot().catch((err) => {
  console.error(err);
  els.root.textContent = `Could not start the practice: ${err.message}`;
});
