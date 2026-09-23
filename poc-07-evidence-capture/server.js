#!/usr/bin/env node
// POC #7 — Evidence rolling-buffer recording.
// Plain Node.js, zero npm dependencies: a static file server + a tiny API that
// accepts recorded video clips and saves them to a local `clips/` folder, standing
// in for the "Evidence Service" in R&D.md Section 6. Real production would flush to
// S3 (Section 7) — this local stand-in validates the capture/upload mechanism and
// timing without needing real cloud credentials for an R&D prototype.
//
// IMPORTANT: this writes real recorded video to disk under clips/. That folder is
// gitignored at the repo root — never remove that entry. See README.md.

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 8020;
const ROOT = __dirname;
const CLIPS_DIR = path.join(ROOT, "clips");

if (!fs.existsSync(CLIPS_DIR)) fs.mkdirSync(CLIPS_DIR);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".webm": "video/webm",
};

let nextId = 1;
const clips = []; // in-memory metadata; files themselves live on disk in clips/
// Each clip is a *sequence* of independently-playable segment files, not one blob —
// see the note at the top of app.js for why a single concatenated file doesn't work.

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(data),
  });
  res.end(data);
}

function readBinaryBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const parts = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        req.destroy(new Error("clip too large"));
        return;
      }
      parts.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(parts)));
    req.on("error", reject);
  });
}

function serveStatic(res, pathname) {
  const filePath = path.join(ROOT, pathname === "/" ? "/index.html" : pathname);
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end("Not found");
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const { pathname, searchParams } = url;

  if (req.method === "GET" && pathname === "/evidence") {
    return sendJson(res, 200, clips);
  }

  if (req.method === "POST" && pathname === "/evidence") {
    let buffer;
    try {
      buffer = await readBinaryBody(req, 50 * 1024 * 1024); // 50MB guard, generous for a short clip
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
    const captureId = searchParams.get("capture_id");
    if (!captureId) return sendJson(res, 400, { error: "capture_id is required" });
    const partIndex = Number(searchParams.get("part_index") || 0);

    let clip = clips.find((c) => c.capture_id === captureId);
    if (!clip) {
      clip = {
        id: nextId++,
        capture_id: captureId,
        event_type: searchParams.get("event_type") || "UNKNOWN",
        detail: searchParams.get("detail") || null,
        trigger_time: searchParams.get("trigger_time") || new Date().toISOString(),
        pre_roll_s: Number(searchParams.get("pre_roll_s") || 0),
        post_roll_s: Number(searchParams.get("post_roll_s") || 0),
        parts: [],
        total_bytes: 0,
        uploaded_at: new Date().toISOString(),
      };
      clips.push(clip);
    }

    const ext = (req.headers["content-type"] || "").includes("webm") ? "webm" : "bin";
    const filename = `clip-${clip.id}-part${partIndex}.${ext}`;
    fs.writeFile(path.join(CLIPS_DIR, filename), buffer, (err) => {
      if (err) return sendJson(res, 500, { error: "failed to save clip segment" });
      clip.parts[partIndex] = filename;
      clip.total_bytes += buffer.length;
      sendJson(res, 201, clip);
    });
    return;
  }

  if (req.method === "DELETE" && pathname === "/evidence") {
    clips.forEach((c) => {
      c.parts.forEach((filename) => {
        const p = path.join(CLIPS_DIR, filename);
        if (fs.existsSync(p)) fs.unlinkSync(p);
      });
    });
    clips.length = 0;
    return sendJson(res, 200, { cleared: true });
  }

  const clipMatch = pathname.match(/^\/clips\/([a-zA-Z0-9_.-]+)$/);
  if (req.method === "GET" && clipMatch) {
    const filePath = path.join(CLIPS_DIR, clipMatch[1]);
    if (!filePath.startsWith(CLIPS_DIR) || !fs.existsSync(filePath)) {
      res.writeHead(404);
      return res.end("Not found");
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    fs.createReadStream(filePath).pipe(res);
    return;
  }

  if (req.method === "GET") {
    return serveStatic(res, pathname);
  }

  res.writeHead(405);
  res.end("Method not allowed");
});

server.listen(PORT, () => {
  console.log(`POC #7 server running at http://localhost:${PORT}`);
  console.log(`  Open: http://localhost:${PORT}/`);
  console.log(`  Clips saved locally to: ${CLIPS_DIR}`);
});
