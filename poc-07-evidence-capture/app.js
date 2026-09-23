// POC #7 — Evidence rolling-buffer recording.
// Standalone prototype: records real video locally (via MediaRecorder) and saves
// short clips to this machine's own disk (server.js, running on localhost) only
// when a simulated alert fires — never a continuous upload, never sent externally.
// See README.md.
//
// IMPORTANT implementation note: MediaRecorder's periodic timeslice chunks are NOT
// independently playable — only the very first chunk of a recording session
// contains the WebM container header; later chunks are just continuation data that
// are meaningless without it. A naive "keep the last N seconds of chunks" buffer
// eventually evicts that header chunk, producing unplayable fragments. The fix used
// here: restart MediaRecorder every CHUNK_MS, so each segment is a small,
// independently-valid WebM file with its own header. A captured clip is a sequence
// of these segments, played back one after another (see setupSequentialPlayback),
// not concatenated into a single blob.

const els = {
  video: document.getElementById("video"),
  startBtn: document.getElementById("startBtn"),
  stopBtn: document.getElementById("stopBtn"),
  liveStatus: document.getElementById("liveStatus"),
  bufferVal: document.getElementById("bufferVal"),
  lastSizeVal: document.getElementById("lastSizeVal"),
  lastLatencyVal: document.getElementById("lastLatencyVal"),
  cfgPreRoll: document.getElementById("cfgPreRoll"),
  cfgPostRoll: document.getElementById("cfgPostRoll"),
  clipList: document.getElementById("clipList"),
  clearBtn: document.getElementById("clearBtn"),
};

const CHUNK_MS = 1000; // segment length — the rolling buffer's granularity

let stream = null;
let currentRecorder = null;
let mimeType = "";
let running = false;
let capturing = false;
let pendingCapture = null; // { eventType, triggerTime }
let segments = []; // { blob, timestamp } — each blob is one complete, independently-playable segment
let bufferTimer = null;

document.querySelectorAll(".event-btn").forEach((btn) => {
  btn.addEventListener("click", () => triggerCapture(btn.dataset.type));
});
els.startBtn.addEventListener("click", start);
els.stopBtn.addEventListener("click", stop);
els.clearBtn.addEventListener("click", clearAllClips);

if (!window.isSecureContext) {
  els.liveStatus.textContent =
    "This page must be served over http://localhost or https:// for camera access to work (see README.md).";
  els.startBtn.disabled = true;
}

async function start() {
  els.startBtn.disabled = true;
  setLiveStatus("idle", "Requesting camera…");
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 } },
      audio: false,
    });
    els.video.srcObject = stream;

    mimeType = pickSupportedMimeType();
    segments = [];
    running = true;
    startSegmentChain();

    els.stopBtn.disabled = false;
    setLiveStatus("present", "Buffering — filling pre-roll window");
    bufferTimer = setInterval(updateBufferMetric, 500);
  } catch (err) {
    console.error(err);
    setLiveStatus("idle", `Error: ${err.message}`);
    els.startBtn.disabled = false;
  }
}

function stop() {
  running = false;
  if (currentRecorder && currentRecorder.state !== "inactive") currentRecorder.stop();
  if (stream) {
    stream.getTracks().forEach((t) => t.stop());
    stream = null;
  }
  if (bufferTimer) clearInterval(bufferTimer);
  segments = [];
  els.video.srcObject = null;
  els.startBtn.disabled = false;
  els.stopBtn.disabled = true;
  els.bufferVal.textContent = "–";
  setLiveStatus("idle", "Camera not started");
}

function pickSupportedMimeType() {
  const candidates = ["video/webm;codecs=vp8", "video/webm;codecs=vp9", "video/webm"];
  return candidates.find((c) => MediaRecorder.isTypeSupported(c)) || "";
}

// Restarts MediaRecorder every CHUNK_MS. Each session (start()..stop()) with no
// timeslice argument fires exactly one `dataavailable`, containing that whole
// segment as a single self-contained, independently-playable blob.
//
// Chrome (and others) write an invalid/zero duration into a WebM's header when a
// MediaRecorder session stops normally — the real frame data is fine, but players
// show "0:00" with a fully-filled progress bar and can misbehave on playback. Fixed
// via the fix-webm-duration library (loaded as a global in index.html), which
// patches the container's binary Duration field using our own measured wall-clock
// time for that segment — a second, distinct MediaRecorder quirk from the
// missing-header-on-eviction bug fixed earlier (see README.md).
function startSegmentChain() {
  if (!running) return;
  const startedAt = performance.now();
  const rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  currentRecorder = rec;

  rec.ondataavailable = (e) => {
    if (!e.data || e.data.size === 0) return;
    const durationMs = performance.now() - startedAt;
    fixSegmentDuration(e.data, durationMs).then((fixedBlob) => {
      segments.push({ blob: fixedBlob, timestamp: startedAt });
      if (!capturing) pruneOldSegments();
    });
  };
  rec.onstop = () => {
    if (running) startSegmentChain(); // chain the next segment without waiting on the duration fix
  };
  rec.start();
  setTimeout(() => {
    if (rec.state !== "inactive") rec.stop();
  }, CHUNK_MS);
}

function fixSegmentDuration(blob, durationMs) {
  if (typeof window.ysFixWebmDuration !== "function") return Promise.resolve(blob);
  return window.ysFixWebmDuration(blob, durationMs);
}

function pruneOldSegments() {
  const preRollMs = Number(els.cfgPreRoll.value) * 1000;
  const cutoff = performance.now() - preRollMs;
  while (segments.length && segments[0].timestamp < cutoff) segments.shift();
}

function updateBufferMetric() {
  if (!segments.length) {
    els.bufferVal.textContent = "0.0s";
    return;
  }
  const heldMs = performance.now() - segments[0].timestamp;
  els.bufferVal.textContent = `${(heldMs / 1000).toFixed(1)}s`;
  const preRollMs = Number(els.cfgPreRoll.value) * 1000;
  if (!capturing && heldMs >= preRollMs * 0.95) {
    setLiveStatus("present", "✅ Buffer ready — simulate an alert to capture a clip");
  }
}

function triggerCapture(eventType) {
  if (!running) return;
  if (capturing) return; // ignore new triggers while a capture is already in progress
  capturing = true;
  pendingCapture = { eventType, triggerTime: performance.now() };
  const postRollS = Number(els.cfgPostRoll.value);
  setLiveStatus("warning", `⚠ ${eventType} — capturing clip, ${postRollS}s remaining…`);
  setTimeout(finishCapture, postRollS * 1000);
}

async function finishCapture() {
  const { eventType, triggerTime } = pendingCapture;
  const preRollS = Number(els.cfgPreRoll.value);
  const postRollS = Number(els.cfgPostRoll.value);
  const windowStart = triggerTime - preRollS * 1000;
  const windowEnd = triggerTime + postRollS * 1000;

  // A segment is part of the clip if it overlaps the window at all (its own
  // duration is roughly CHUNK_MS, so include anything starting up to CHUNK_MS
  // before windowStart).
  const selected = segments
    .filter((s) => s.timestamp + CHUNK_MS >= windowStart && s.timestamp <= windowEnd)
    .map((s) => s.blob);

  capturing = false;
  pendingCapture = null;
  pruneOldSegments();
  setLiveStatus("present", `Uploading ${selected.length} clip segment(s) to local disk…`);

  await uploadClip(selected, eventType, preRollS, postRollS);
}

async function uploadClip(blobs, eventType, preRollS, postRollS) {
  if (blobs.length === 0) {
    setLiveStatus("idle", "⚠ No segments captured — buffer wasn't ready yet");
    return;
  }
  const t0 = performance.now();
  const captureId = `cap-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  let totalBytes = 0;
  try {
    for (let i = 0; i < blobs.length; i++) {
      const params = new URLSearchParams({
        capture_id: captureId,
        part_index: String(i),
        event_type: eventType,
        trigger_time: new Date().toISOString(),
        pre_roll_s: String(preRollS),
        post_roll_s: String(postRollS),
      });
      const res = await fetch(`/evidence?${params}`, {
        method: "POST",
        headers: { "Content-Type": blobs[i].type || "video/webm" },
        body: blobs[i],
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setLiveStatus("idle", `⚠ Upload failed on part ${i}: ${body.error || res.status}`);
        return;
      }
      totalBytes += blobs[i].size;
    }
    const latencyMs = performance.now() - t0;
    els.lastSizeVal.textContent = formatBytes(totalBytes);
    els.lastLatencyVal.textContent = `${latencyMs.toFixed(0)} ms`;
    setLiveStatus("present", `✅ Clip saved (${eventType}, ${blobs.length} segment${blobs.length === 1 ? "" : "s"})`);
    await refreshClipList();
  } catch (err) {
    setLiveStatus("idle", `⚠ Upload failed: ${err.message}`);
  }
}

async function refreshClipList() {
  try {
    const res = await fetch("/evidence");
    const clips = await res.json();
    renderClipList(clips);
  } catch (err) {
    console.warn("Could not load clip list", err);
  }
}

function renderClipList(clips) {
  els.clipList.innerHTML = "";
  [...clips].reverse().forEach((clip) => {
    const card = document.createElement("div");
    card.className = "clip-card";
    const partCount = clip.parts ? clip.parts.length : 0;
    card.innerHTML = `
      <video controls></video>
      <div class="meta">
        <div><strong>${clip.event_type}</strong> · #${clip.id}</div>
        <div>${formatBytes(clip.total_bytes)} · pre-roll ${clip.pre_roll_s}s / post-roll ${clip.post_roll_s}s · ${partCount} segment${partCount === 1 ? "" : "s"}</div>
        <div>${new Date(clip.uploaded_at).toLocaleTimeString()}</div>
      </div>
    `;
    const videoEl = card.querySelector("video");
    if (clip.parts && clip.parts.length) setupSequentialPlayback(videoEl, clip.parts);
    els.clipList.appendChild(card);
  });
}

// Plays a clip's segments back one after another. Each segment is an independently
// valid file (see the note at the top of this file) — this deliberately does not
// rely on concatenating them into a single blob.
function setupSequentialPlayback(videoEl, parts) {
  let idx = 0;
  videoEl.src = `/clips/${parts[idx]}`;
  videoEl.addEventListener("ended", () => {
    idx += 1;
    if (idx < parts.length) {
      videoEl.src = `/clips/${parts[idx]}`;
      videoEl.play();
    }
  });
}

async function clearAllClips() {
  await fetch("/evidence", { method: "DELETE" });
  await refreshClipList();
  els.lastSizeVal.textContent = "–";
  els.lastLatencyVal.textContent = "–";
}

function formatBytes(bytes) {
  if (bytes == null) return "–";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function setLiveStatus(cls, text) {
  els.liveStatus.className = `live-status ${cls}`;
  els.liveStatus.textContent = text;
}

refreshClipList();
