#!/usr/bin/env node
// POC #6 — Real-time events -> proctor dashboard.
// Plain Node.js, zero npm dependencies: a static file server + a tiny JSON API +
// Server-Sent Events for pushing events to any number of connected dashboards.
// This is a stand-in for the recommended production technology (ActionCable, per
// R&D.md Section 7) — it validates the event schema, the human-review lifecycle,
// and latency, without standing up a new Ruby/Rails toolchain just for this repo.
// In-memory only — restarting this process clears all events. See README.md.

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 8010;
const ROOT = __dirname;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

let nextId = 1;
const events = []; // in-memory event log, oldest first
const sseClients = new Set(); // connected `res` objects for /events/stream

// AiEvent status lifecycle, per R&D.md Section 13: ALERTED -> ACKNOWLEDGED ->
// CONFIRMED / DISMISSED / FALSE_POSITIVE. ("DETECTED" is implicit — by the time the
// candidate side POSTs here, it's already past detection and being alerted.)
const TRANSITIONS = {
  acknowledge: { from: ["ALERTED"], to: "ACKNOWLEDGED" },
  confirm: { from: ["ACKNOWLEDGED"], to: "CONFIRMED" },
  dismiss: { from: ["ACKNOWLEDGED"], to: "DISMISSED" },
  false_positive: { from: ["ACKNOWLEDGED"], to: "FALSE_POSITIVE" },
};

function broadcast(type, payload) {
  const chunk = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of sseClients) res.write(chunk);
}

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(data),
  });
  res.end(data);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1e6) req.destroy(new Error("body too large"));
    });
    req.on("end", () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function serveStatic(res, pathname) {
  const filePath = path.join(ROOT, pathname === "/" ? "/candidate.html" : pathname);
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
  const { pathname } = url;

  if (req.method === "GET" && pathname === "/events/stream") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    // Send the current backlog first so a newly opened dashboard tab sees state
    // that already exists, not just events that happen from now on.
    res.write(`event: backlog\ndata: ${JSON.stringify(events)}\n\n`);
    sseClients.add(res);
    const heartbeat = setInterval(() => res.write(":\n\n"), 15000);
    req.on("close", () => {
      clearInterval(heartbeat);
      sseClients.delete(res);
    });
    return;
  }

  if (req.method === "POST" && pathname === "/events") {
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      return sendJson(res, 400, { error: "invalid JSON body" });
    }
    if (!body.event_type) {
      return sendJson(res, 400, { error: "event_type is required" });
    }
    const now = Date.now();
    const ev = {
      id: nextId++,
      event_type: body.event_type,
      confidence: body.confidence ?? null,
      detail: body.detail ?? null,
      session_id: body.session_id || "demo-session",
      status: "ALERTED",
      client_sent_at: body.client_sent_at ?? now,
      server_received_at: now,
      updated_at: now,
    };
    events.push(ev);
    broadcast("created", ev);
    return sendJson(res, 201, ev);
  }

  const reviewMatch = pathname.match(/^\/events\/(\d+)\/review$/);
  if (req.method === "POST" && reviewMatch) {
    const id = Number(reviewMatch[1]);
    const ev = events.find((e) => e.id === id);
    if (!ev) return sendJson(res, 404, { error: "event not found" });
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      return sendJson(res, 400, { error: "invalid JSON body" });
    }
    const t = TRANSITIONS[body.action];
    if (!t) return sendJson(res, 400, { error: "unknown action" });
    if (!t.from.includes(ev.status)) {
      return sendJson(res, 409, {
        error: `cannot ${body.action} an event with status ${ev.status}`,
      });
    }
    ev.status = t.to;
    ev.updated_at = Date.now();
    broadcast("updated", ev);
    return sendJson(res, 200, ev);
  }

  if (req.method === "GET") {
    return serveStatic(res, pathname);
  }

  res.writeHead(405);
  res.end("Method not allowed");
});

server.listen(PORT, () => {
  console.log(`POC #6 server running at http://localhost:${PORT}`);
  console.log(`  Candidate (simulate events): http://localhost:${PORT}/candidate.html`);
  console.log(`  Proctor dashboard:           http://localhost:${PORT}/dashboard.html`);
});
