// End-to-end tests for POC #8 in headless Chromium with a fake camera (real face
// videos), fake microphone (TTS speech) and Chromium's fake screen. Failure modes
// are produced by stubbing getUserMedia / getDisplayMedia / screen.isExtended.
//
// Not part of `node --test`: it needs Playwright and the fixtures.
//   node tests/make-fixtures.mjs                      # once (macOS: uses `say`)
//   PLAYWRIGHT=/path/to/node_modules/playwright node tests/e2e.mjs [scenario…]
// Writes screenshots, downloaded reports and e2e-results.json to tests/out/.

import { createRequire } from "node:module";
import http from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium, devices } = require(process.env.PLAYWRIGHT || "playwright");

const POC = fileURLToPath(new URL("..", import.meta.url));
const REPO = path.resolve(POC, "..");
const FX = path.join(POC, "tests/fixtures");
const OUT = path.join(POC, "tests/out");
const STATE_KEY = "poc8_onboarding_state";
const ALLOWED_HOSTS = new Set(["127.0.0.1", "cdn.jsdelivr.net", "storage.googleapis.com"]);
const ONLY = process.argv.slice(2);
const MAC_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const WIN_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

let base = null;
let open = []; // browsers launched by the current scenario

// --- harness -------------------------------------------------------------------

function serve(root) {
  const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".css": "text/css; charset=utf-8" };
  const server = http.createServer(async (req, res) => {
    const p = decodeURIComponent(new URL(req.url, "http://x").pathname);
    const file = path.join(root, p.endsWith("/") ? `${p}index.html` : p);
    if (!file.startsWith(root)) return res.writeHead(403).end();
    try {
      const data = await readFile(file);
      res.writeHead(200, { "Content-Type": types[path.extname(file)] || "application/octet-stream" }).end(data);
    } catch {
      res.writeHead(404).end();
    }
  });
  // 127.0.0.1 is a secure context, so camera/mic/screen APIs are available over http.
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

async function launch({ video = "akiyo_cif.y4m", audio = "speech_en.wav", init = [], contextOptions = {}, route = null } = {}) {
  const browser = await chromium.launch({
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      `--use-file-for-fake-video-capture=${path.join(FX, video)}`,
      `--use-file-for-fake-audio-capture=${path.join(FX, audio)}`,
      "--autoplay-policy=no-user-gesture-required",
    ],
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true, ...contextOptions });
  await context.addInitScript(() =>
    document.addEventListener("securitypolicyviolation", (e) => (window.__csp ||= []).push({ uri: e.blockedURI, directive: e.effectiveDirective }))
  );
  for (const { fn, arg } of init) await context.addInitScript(fn, arg);
  if (route) await context.route(route.pattern, route.handler);
  const page = await context.newPage();
  // Scenarios call browser.close() in `finally`; the runner does the real close
  // afterwards, so it can screenshot the page first if the scenario failed.
  open.push({ close: browser.close.bind(browser), page });
  browser.close = async () => {};
  const requests = [];
  const problems = [];
  page.on("request", (r) => requests.push({ method: r.method(), url: r.url(), body: Boolean(r.postData()) }));
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  page.on("console", (m) => m.text().includes("missing content key") && problems.push(m.text()));
  return { browser, page, requests, problems };
}

const act = (page, name) => page.click(`[data-action="${name}"]`);
const state = (page) => page.evaluate(() => window.poc8.state);
const shot = (page, name, fullPage = true) => page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage });

async function waitResult(page, step, timeout, statuses = null) {
  await page.waitForFunction(
    ([s, st]) => {
      const r = window.poc8?.state.results[s];
      return r && (!st || st.includes(r.status));
    },
    [step, statuses],
    { timeout }
  );
  return (await state(page)).results[step];
}

// Seeds saved progress before the app loads (once per tab, so reloads aren't re-seeded).
function seed(step, results, extra = {}) {
  const s = {
    v: 1,
    lang: "en",
    step,
    maxStep: 7,
    results,
    calibration: { yaw: 0, pitch: 0 },
    practice: { startedAt: null, answers: {}, nudges: {}, submitted: false },
    sessionId: "practice-e2e",
    startedAt: Date.now() - 60000,
    completedAt: null,
    ...extra,
  };
  return {
    fn: ([k, v]) => {
      if (!sessionStorage.getItem("seeded")) {
        localStorage.setItem(k, v);
        sessionStorage.setItem("seeded", "1");
      }
    },
    arg: [STATE_KEY, JSON.stringify(s)],
  };
}
const P = { status: "pass", at: 0 };

const stub = {
  gumVideoError: {
    fn: (name) => {
      const orig = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = async (c) => {
        if (c?.video) throw new DOMException("stubbed", name);
        return orig(c);
      };
    },
  },
  displayError: {
    fn: (name) => {
      navigator.mediaDevices.getDisplayMedia = async () => {
        throw new DOMException("stubbed", name);
      };
    },
  },
  displaySurface: {
    fn: (surface) => {
      const orig = navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getDisplayMedia = async (o) => {
        const s = await orig(o);
        const tr = s.getVideoTracks()[0];
        const real = tr.getSettings.bind(tr);
        tr.getSettings = () => ({ ...real(), displaySurface: surface });
        return s;
      };
    },
  },
  extended: {
    fn: () => Object.defineProperty(Screen.prototype, "isExtended", { configurable: true, get: () => true }),
  },
};
const withArg = (s, arg) => ({ fn: s.fn, arg });

async function resumeAt(page, query = "") {
  await page.goto(base + query);
  await act(page, "resume");
}

// Samples data-code attributes for `ms`, returning how often each code appeared.
async function sampleCodes(page, selector, ms) {
  const counts = {};
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const code = await page.getAttribute(selector, "data-code").catch(() => null);
    if (code) counts[code] = (counts[code] || 0) + 1;
    await page.waitForTimeout(250);
  }
  return counts;
}

function networkAudit(requests) {
  const http = requests.filter((r) => /^https?:/.test(r.url));
  return {
    total: http.length,
    nonGet: http.filter((r) => r.method !== "GET" || r.body).map((r) => `${r.method} ${r.url}`),
    hosts: [...new Set(http.map((r) => new URL(r.url).hostname))],
    disallowed: [...new Set(http.map((r) => new URL(r.url).hostname))].filter((h) => !ALLOWED_HOSTS.has(h)),
  };
}

// --- scenarios -------------------------------------------------------------------

// Timestamps every mic phase change and VAD callback (relative to the mic opening),
// so a quiet-phase warning can be told apart from real speech in the fixture.
const traceMic = {
  fn: () => {
    let t0 = null;
    const log = (what) => (window.__micTrace ||= []).push(`${t0 === null ? "-" : ((performance.now() - t0) / 1000).toFixed(2)}s ${what}`);
    const gum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (c) => {
      const s = await gum(c);
      if (c.audio && t0 === null) {
        t0 = performance.now();
        log("mic open");
      }
      return s;
    };
    let v;
    Object.defineProperty(window, "vad", {
      configurable: true,
      get: () => v,
      set: (x) => {
        v = x;
        const create = x.MicVAD.new.bind(x.MicVAD);
        x.MicVAD.new = (o) =>
          create({
            ...o,
            onSpeechRealStart: () => (log("vad speech-start"), o.onSpeechRealStart?.()),
            onSpeechEnd: (a) => (log(`vad speech-end ${Math.round(a.length / 16)} ms`), o.onSpeechEnd?.(a)),
            onVADMisfire: () => (log("vad misfire"), o.onVADMisfire?.()),
          });
      },
    });
    let phase;
    new MutationObserver(() => {
      const p = document.querySelector('[data-testid="mic-phase"]')?.dataset.phase;
      if (p && p !== phase) log(`phase ${(phase = p)}`);
    }).observe(document, { subtree: true, attributes: true, childList: true });
  },
};

async function happyPath(lang, audio) {
  const { browser, page, requests, problems } = await launch({ audio, init: [traceMic] });
  const content = JSON.parse(await readFile(path.join(POC, `content/${lang}.json`), "utf8"));
  const timings = {};
  const t0 = Date.now();
  let tStep = t0;
  const mark = (name) => {
    timings[name] = Date.now() - tStep;
    tStep = Date.now();
  };
  const d = { lang };
  try {
    await page.goto(`${base}?dev=1${lang === "ar" ? "&lang=ar" : ""}`);
    await page.waitForSelector('[data-action="start"]'); // content JSON is loaded async
    d.htmlDirLang = await page.evaluate(() => [document.documentElement.dir, document.documentElement.lang]);
    d.notices = await page.$$eval("[data-notice]", (n) => n.map((x) => x.dataset.notice));
    await shot(page, `${lang}-1-welcome`);
    await act(page, "start");
    mark("welcome");

    d.device = await waitResult(page, "device", 60000);
    mark("device");
    await shot(page, `${lang}-2-device`);
    await act(page, "continue");

    await act(page, "camera-on");
    d.camera = await waitResult(page, "camera", 30000, ["pass", "warn"]);
    mark("camera");
    d.calibration = (await state(page)).calibration;
    await shot(page, `${lang}-3-camera`);
    await act(page, "continue");

    await act(page, "mic-on");
    d.microphone = await waitResult(page, "microphone", 60000, ["pass", "warn", "fail"]);
    mark("microphone");
    d.quietPhase = await page.getAttribute('[data-testid="quiet-result"]', "class").catch(() => null);
    d.micTrace = await page.evaluate(() => window.__micTrace || []);
    await shot(page, `${lang}-4-microphone`);
    await act(page, "continue");

    if (lang === "en") {
      // Simulates the macOS "Quit & Reopen" at the screen step.
      await page.reload();
      await page.waitForSelector('[data-testid="resume"]');
      d.resumeCard = (await page.textContent('[data-testid="resume"]')).replace(/\s+/g, " ").trim();
      await act(page, "resume");
      await page.waitForSelector('[data-action="share"]');
      const s = await state(page);
      d.resumed = { step: s.step, kept: Object.keys(s.results) };
    }

    await act(page, "share");
    d.screen = await waitResult(page, "screen", 20000);
    mark("screen");
    await shot(page, `${lang}-5-screen`);
    await act(page, "continue");

    const boxes = page.locator(".checks input[type=checkbox]");
    const n = await boxes.count();
    for (let i = 0; i < n - 1; i++) await boxes.nth(i).check(); // not the last "I can't" box
    d.rulesBeforeAck = (await state(page)).results.rules?.status || null;
    await page.check(".ack input");
    d.rules = await waitResult(page, "rules", 5000);
    d.ruleIds = await page.$$eval("[data-rule]", (r) => r.map((x) => x.dataset.rule));
    mark("rules");
    await shot(page, `${lang}-6-rules`);
    await act(page, "continue");

    await act(page, "start-practice");
    for (const q of content.practice_questions) await page.check(`[data-question="${q.id}"] input[value="${q.correct}"]`);
    await page.waitForFunction(() => (window.poc8.state.practice.nudges.SPEECH_DETECTED || 0) > 0, null, { timeout: 60000 });
    d.speechNudge = await page.textContent('[data-testid="nudge"]');
    d.alertCard = (await page.textContent('[data-testid="alert-card"]')).replace(/\s+/g, " ").trim();
    d.timerText = await page.textContent('[data-testid="timer"]');
    await shot(page, `${lang}-7-practice`);
    await page.waitForTimeout(3000); // let the phone model run alongside the face model
    d.practiceMetrics = await page.evaluate(() => ({ ...window.poc8.metrics }));
    d.practiceNudges = (await state(page)).practice.nudges;
    await act(page, "finish");
    d.practice = await waitResult(page, "practice", 5000);
    d.score = await page.textContent('[data-testid="practice-results"] p');
    mark("practice");
    await act(page, "continue");

    await page.waitForSelector("[data-overall]");
    d.overall = await page.getAttribute("[data-overall]", "data-overall");
    d.mediaAfterSummary = await page.evaluate(() => window.poc8.mediaLive());
    await shot(page, `${lang}-8-summary`);
    const [dl] = await Promise.all([page.waitForEvent("download"), act(page, "download")]);
    const reportFile = path.join(OUT, `report-${lang}.json`);
    await dl.saveAs(reportFile);
    d.report = JSON.parse(await readFile(reportFile, "utf8"));
    d.totalMs = Date.now() - t0;
    d.timings = timings;

    if (lang === "ar") {
      d.rtl = await page.evaluate(() => {
        const lis = [...document.querySelectorAll(".stepper li")];
        return {
          direction: getComputedStyle(document.querySelector(".step-root")).direction,
          firstStepIsRightmost: lis[0].getBoundingClientRect().left > lis.at(-1).getBoundingClientRect().left,
          arabicChars: (document.body.innerText.match(/[؀-ۿ]/g) || []).length,
        };
      });
    }
    d.network = networkAudit(requests);
    d.cspViolations = await page.evaluate(() => window.__csp || []);
    d.problems = problems;

    const checksPass = ["device", "camera", "microphone", "screen", "rules", "practice"].every((k) => d[k]?.status === "pass");
    const ok =
      checksPass &&
      d.overall === "ready" &&
      d.report.event_type === "READINESS_REPORT" &&
      d.alertCard.includes("SPEECH_DETECTED") &&
      /^\d+:\d\d$/.test(d.timerText) &&
      d.network.nonGet.length === 0 &&
      d.network.disallowed.length === 0 &&
      !Object.values(d.mediaAfterSummary).some(Boolean) &&
      problems.length === 0 &&
      (lang !== "ar" || (d.htmlDirLang[0] === "rtl" && d.rtl.direction === "rtl" && d.rtl.firstStepIsRightmost && d.notices.includes("translation"))) &&
      (lang !== "en" || (d.resumed.step === "screen" && d.resumed.kept.includes("microphone")));
    return { ok, d };
  } finally {
    await browser.close();
  }
}

const scenarios = {
  happy_en: () => happyPath("en", "speech_en.wav"),
  happy_ar: () => happyPath("ar", "speech_ar.wav"),

  async two_faces() {
    const { browser, page, problems } = await launch({ video: "mother_daughter_cif.y4m", init: [seed("camera", { device: P })] });
    try {
      await resumeAt(page);
      await act(page, "camera-on");
      await page.waitForSelector('[data-testid="guidance"][data-code]', { timeout: 30000 });
      const codes = await sampleCodes(page, '[data-testid="guidance"]', 8000);
      const r = (await state(page)).results.camera || null;
      await shot(page, "fail-two-faces", false);
      const total = Object.values(codes).reduce((a, b) => a + b, 0);
      return { ok: (codes.MULTIPLE_FACES || 0) / total > 0.8 && !r && problems.length === 0, d: { codes, result: r, problems } };
    } finally {
      await browser.close();
    }
  },

  async too_dark() {
    const { browser, page, problems } = await launch({ video: "akiyo_dark.y4m", init: [seed("camera", { device: P })] });
    try {
      await resumeAt(page);
      await act(page, "camera-on");
      await page.waitForSelector('[data-testid="guidance"][data-code]', { timeout: 30000 });
      const lighting = await sampleCodes(page, '[data-testid="lighting"]', 6000);
      const guidance = await sampleCodes(page, '[data-testid="guidance"]', 2000);
      const r = (await state(page)).results.camera || null;
      await shot(page, "fail-too-dark", false);
      return { ok: (lighting.TOO_DARK || 0) > 0 && r?.status !== "pass" && problems.length === 0, d: { lighting, guidance, result: r, problems } };
    } finally {
      await browser.close();
    }
  },

  async face_missing_in_practice() {
    const { browser, page, problems } = await launch({
      video: "foreman_cif.y4m",
      init: [seed("practice", { device: P, camera: P, microphone: P, screen: P, rules: P })],
    });
    try {
      await resumeAt(page, "?dev=1");
      await act(page, "start-practice");
      await page.waitForFunction(() => (window.poc8.state.practice.nudges.FACE_MISSING || 0) > 0, null, { timeout: 40000 });
      const nudge = await page.textContent('[data-testid="nudge"]');
      const alertCard = (await page.textContent('[data-testid="alert-card"]')).replace(/\s+/g, " ").trim();
      const tryDone = await page.getAttribute('[data-try="FACE_MISSING"]', "class");
      await shot(page, "practice-face-missing");
      await page.waitForTimeout(12000); // one more loop of the video: what else fires?
      const s = await state(page);
      const metrics = await page.evaluate(() => ({ ...window.poc8.metrics }));
      return {
        ok: alertCard.includes("FACE_MISSING") && tryDone.includes("done") && problems.length === 0,
        d: { nudge, alertCard, nudges: s.practice.nudges, metrics, problems },
      };
    } finally {
      await browser.close();
    }
  },

  // D2 re-validation at exam thresholds: the Face Landmarker drops the second face for
  // 0.1–0.7 s at a time on this video, and a raise needs 1.5 s without a gap. Measures
  // how long the alert takes and whether it flaps (clears and re-raises) afterwards.
  async two_faces_in_practice() {
    const { browser, page, problems } = await launch({
      video: "mother_daughter_cif.y4m",
      init: [seed("practice", { device: P, camera: P, microphone: P, screen: P, rules: P })],
    });
    try {
      await resumeAt(page, "?dev=1");
      await act(page, "start-practice");
      const t0 = Date.now();
      await page.waitForFunction(() => (window.poc8.state.practice.nudges.MULTIPLE_FACES || 0) > 0, null, { timeout: 30000 });
      const raisedAfterMs = Date.now() - t0;
      const alertCard = (await page.textContent('[data-testid="alert-card"]')).replace(/\s+/g, " ").trim();
      await page.waitForTimeout(20000); // two more loops of the video: does it flap?
      const s = await state(page);
      const metrics = await page.evaluate(() => ({ ...window.poc8.metrics }));
      return {
        ok: alertCard.includes("MULTIPLE_FACES") && s.practice.nudges.MULTIPLE_FACES === 1 && problems.length === 0,
        d: { raisedAfterMs, alertCard, nudges: s.practice.nudges, metrics, problems },
      };
    } finally {
      await browser.close();
    }
  },

  async camera_denied() {
    const { browser, page, problems } = await launch({ init: [seed("camera", { device: P }), withArg(stub.gumVideoError, "NotAllowedError")] });
    try {
      await resumeAt(page);
      await act(page, "camera-on");
      const r = await waitResult(page, "camera", 10000, ["fail"]);
      const text = await page.textContent('[data-testid="camera-status"]');
      const retry = await page.isVisible('[data-action="retry"]');
      await shot(page, "fail-camera-denied", false);
      await act(page, "skip");
      const s = await state(page);
      return { ok: r.code === "NotAllowedError" && /blocked/i.test(text) && retry && s.step === "microphone" && s.results.camera.status === "skipped" && !problems.length, d: { r, text, afterSkip: s.results.camera } };
    } finally {
      await browser.close();
    }
  },

  async camera_busy() {
    const { browser, page, problems } = await launch({ init: [seed("camera", { device: P }), withArg(stub.gumVideoError, "NotReadableError")] });
    try {
      await resumeAt(page);
      await act(page, "camera-on");
      const r = await waitResult(page, "camera", 10000, ["fail"]);
      const text = await page.textContent('[data-testid="camera-status"]');
      return { ok: r.code === "NotReadableError" && /another app/i.test(text) && !problems.length, d: { r, text } };
    } finally {
      await browser.close();
    }
  },

  async mic_silent() {
    const { browser, page, problems } = await launch({ audio: "silence.wav", init: [seed("microphone", { device: P, camera: P })] });
    try {
      await resumeAt(page);
      await act(page, "mic-on");
      const r = await waitResult(page, "microphone", 60000, ["fail", "pass", "warn"]);
      const tips = await page.$$eval(".card ul.plain li", (l) => l.map((x) => x.textContent));
      await shot(page, "fail-mic-silent", false);
      return { ok: r.code === "NOT_HEARD" && tips.some((x) => /muted/i.test(x)) && !problems.length, d: { r, tips } };
    } finally {
      await browser.close();
    }
  },

  async screen_wrong_surface() {
    const { browser, page, problems } = await launch({ init: [seed("screen", { device: P, camera: P, microphone: P }), withArg(stub.displaySurface, "window")] });
    try {
      await resumeAt(page);
      await act(page, "share");
      const r = await waitResult(page, "screen", 15000);
      const text = await page.textContent('[data-testid="screen-status"]');
      await shot(page, "fail-screen-window", false);
      return { ok: r.status === "fail" && r.code === "WRONG_SURFACE" && /shared a window/.test(text) && !problems.length, d: { r, text } };
    } finally {
      await browser.close();
    }
  },

  async screen_denied_mac() {
    const { browser, page, problems } = await launch({
      contextOptions: { userAgent: MAC_UA },
      init: [seed("screen", { device: P, camera: P, microphone: P }), withArg(stub.displayError, "NotAllowedError")],
    });
    try {
      await resumeAt(page);
      const macBefore = await page.isVisible('[data-testid="mac-help"]');
      await act(page, "share");
      const r = await waitResult(page, "screen", 15000);
      const emphasis = await page.getAttribute('[data-testid="mac-help"]', "class");
      await shot(page, "fail-screen-denied-mac", false);
      return { ok: r.code === "NotAllowedError" && macBefore && emphasis.includes("emphasis") && !problems.length, d: { r, macBefore, emphasis } };
    } finally {
      await browser.close();
    }
  },

  async screen_denied_windows() {
    const { browser, page, problems } = await launch({
      contextOptions: { userAgent: WIN_UA },
      init: [seed("screen", { device: P, camera: P, microphone: P }), withArg(stub.displayError, "NotAllowedError")],
    });
    try {
      await resumeAt(page);
      await act(page, "share");
      const r = await waitResult(page, "screen", 15000);
      const macVisible = await page.isVisible('[data-testid="mac-help"]');
      return { ok: r.code === "NotAllowedError" && !macVisible && !problems.length, d: { r, macVisible } };
    } finally {
      await browser.close();
    }
  },

  async screen_multi_monitor() {
    const { browser, page, problems } = await launch({ init: [seed("screen", { device: P, camera: P, microphone: P }), stub.extended] });
    try {
      await resumeAt(page);
      await act(page, "share");
      const r = await waitResult(page, "screen", 15000);
      const text = await page.textContent('[data-testid="screen-status"]');
      return { ok: r.status === "warn" && r.code === "MULTIPLE_MONITORS" && /monitor/.test(text) && !problems.length, d: { r, text } };
    } finally {
      await browser.close();
    }
  },

  async mobile_device() {
    const { browser, page, problems } = await launch({ contextOptions: { ...devices["iPhone 13"] } });
    try {
      await page.goto(base);
      await shot(page, "mobile-welcome");
      await act(page, "start");
      const r = await waitResult(page, "device", 60000);
      const failed = await page.$$eval('[data-check][data-status="fail"]', (l) => l.map((x) => x.dataset.check));
      const scroll = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
      await shot(page, "mobile-device");
      return { ok: r.status === "fail" && failed.includes("desktop") && !scroll && !problems.length, d: { r, failed, horizontalScroll: scroll } };
    } finally {
      await browser.close();
    }
  },

  async cdn_blocked() {
    const { browser, page, problems } = await launch({ route: { pattern: "https://cdn.jsdelivr.net/**", handler: (r) => r.abort() } });
    try {
      await page.goto(base);
      await act(page, "start");
      const r = await waitResult(page, "device", 30000);
      const failed = await page.$$eval('[data-check][data-status="fail"]', (l) => l.map((x) => x.dataset.check));
      await shot(page, "fail-cdn-blocked", false);
      return { ok: r.status === "fail" && r.code === "MODELS" && failed.includes("models") && !problems.length, d: { r, failed } };
    } finally {
      await browser.close();
    }
  },

  // Regression: creating two MediaPipe tasks at once used to hang (~17 min observed)
  // because the loader shares a global. media.js now serialises creation.
  async concurrent_model_load() {
    const { browser, page, problems } = await launch();
    try {
      await page.goto(base);
      await page.waitForSelector('[data-action="start"]');
      const t0 = Date.now();
      const outcome = await page.evaluate(() =>
        Promise.race([
          import("./media.js").then((m) => Promise.all([m.loadFaceLandmarker(), m.loadPhoneDetector()])).then(() => "loaded"),
          new Promise((r) => setTimeout(() => r("TIMEOUT"), 60000)),
        ])
      );
      const metrics = await page.evaluate(() => ({ ...window.poc8.metrics }));
      return { ok: outcome === "loaded" && !problems.length, d: { outcome, ms: Date.now() - t0, metrics } };
    } finally {
      await browser.close();
    }
  },

  // MediaPipe ≥ 1.0.0 batches usage telemetry during inference and POSTs it every
  // 60 s. A network audit shorter than that, or one without live inference, proves
  // nothing. So this keeps the camera check running for 75 s: the CSP must block the
  // POST (the browser reports the violation) and nothing may leave for other hosts.
  async telemetry_blocked() {
    const { browser, page, requests, problems } = await launch({ init: [seed("camera", { device: P })] });
    try {
      await resumeAt(page);
      await act(page, "camera-on");
      await page.waitForSelector('[data-testid="guidance"][data-code]', { timeout: 30000 });
      await page.waitForTimeout(75000);
      const csp = await page.evaluate(() => window.__csp || []);
      const net = networkAudit(requests);
      const telemetryAttempts = csp.filter((v) => v.uri.includes("odml.pa.googleapis.com"));
      return {
        ok: telemetryAttempts.length > 0 && net.nonGet.length === 0 && net.disallowed.length === 0 && !problems.length,
        d: { cspViolations: csp, network: net },
      };
    } finally {
      await browser.close();
    }
  },

  // The downloaded report must be accepted, unchanged, by POC #6's POST /events.
  async report_into_poc6() {
    const report = await readFile(path.join(OUT, "report-en.json"), "utf8").catch(() => null);
    if (!report) return { ok: false, d: "run happy_en first" };
    const port = 8019;
    const proc = spawn(process.execPath, [path.join(REPO, "poc-06-realtime-alerts/server.js")], { env: { ...process.env, PORT: String(port) }, stdio: "ignore" });
    try {
      await new Promise((r) => setTimeout(r, 600));
      const res = await fetch(`http://127.0.0.1:${port}/events`, { method: "POST", headers: { "Content-Type": "application/json" }, body: report });
      const body = await res.json();
      return { ok: res.status === 201 && body.event_type === "READINESS_REPORT" && body.session_id === JSON.parse(report).session_id, d: { status: res.status, stored: body } };
    } finally {
      proc.kill();
    }
  },
};

// --- run -------------------------------------------------------------------------

await mkdir(OUT, { recursive: true });
const server = await serve(REPO);
base = `http://127.0.0.1:${server.address().port}/poc-08-onboarding-simulator/`;
const results = {};
for (const [name, fn] of Object.entries(scenarios)) {
  if (ONLY.length && !ONLY.includes(name)) continue;
  const t0 = Date.now();
  try {
    results[name] = { ...(await fn()), ms: Date.now() - t0 };
  } catch (err) {
    results[name] = { ok: false, error: err.message.split("\n").slice(0, 3).join(" | "), ms: Date.now() - t0 };
  }
  for (const b of open) {
    if (!results[name].ok) await b.page.screenshot({ path: path.join(OUT, `FAILED-${name}.png`), fullPage: true }).catch(() => {});
    await b.close();
  }
  open = [];
  console.log(`${results[name].ok ? "PASS" : "FAIL"}  ${name}  (${(results[name].ms / 1000).toFixed(1)} s)${results[name].error ? `  ${results[name].error}` : ""}`);
}
server.close();
await writeFile(path.join(OUT, "e2e-results.json"), JSON.stringify(results, null, 2));
const failed = Object.values(results).filter((r) => !r.ok).length;
console.log(`\n${Object.keys(results).length - failed}/${Object.keys(results).length} scenarios passed. Details: tests/out/e2e-results.json`);
process.exit(failed ? 1 : 0);
