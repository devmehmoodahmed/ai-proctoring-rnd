#!/usr/bin/env node
// POC #5 — Screen capture / live proctor viewing.
// Plain Node.js, zero npm dependencies. This server is ONLY a WebRTC signaling relay
// (plus a static file server): it never receives, stores, or relays any screen
// video. Video flows peer-to-peer, candidate browser -> proctor browser, over WebRTC.
// Same transport pattern as POC #6 (POST up, Server-Sent Events down) so the
// signaling path maps onto ActionCable later exactly the way POC #6's alerts do.
// In-memory only — restarting this process drops all peers. See README.md.

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 8030;
const ROOT = __dirname;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
};

// peerId -> { id, role: "candidate" | "proctor", name, res, status, connected_at }
const peers = new Map();

// Signal types a peer may relay to another specific peer. Anything else is rejected
// so this stays a narrow relay rather than a general-purpose message bus.
const RELAY_TYPES = new Set(["view-request", "offer", "answer", "ice", "hangup"]);

function send(peer, type, payload) {
  peer.res.write(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`);
}

function publicPeer(p) {
  return { id: p.id, role: p.role, name: p.name, status: p.status, connected_at: p.connected_at };
}

function broadcastToProctors(type, payload) {
  for (const p of peers.values()) if (p.role === "proctor") send(p, type, payload);
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

  // Each browser tab opens exactly one SSE stream, identifying itself by a
  // client-generated id. Everything addressed to it arrives on this stream.
  if (req.method === "GET" && pathname === "/signal/stream") {
    const id = url.searchParams.get("id");
    const role = url.searchParams.get("role");
    const name = (url.searchParams.get("name") || "").slice(0, 60);
    if (!id || !["candidate", "proctor"].includes(role)) {
      return sendJson(res, 400, { error: "id and role=candidate|proctor are required" });
    }
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    const stale = peers.get(id);
    if (stale) stale.res.end(); // same tab reconnecting — drop the old stream

    const peer = {
      id,
      role,
      name: name || id,
      res,
      status: stale?.status ?? { sharing: false },
      connected_at: Date.now(),
    };
    peers.set(id, peer);

    if (role === "proctor") {
      // Backlog: every candidate currently connected, so a freshly opened proctor
      // tab can immediately request to view each of them.
      const candidates = [...peers.values()].filter((p) => p.role === "candidate").map(publicPeer);
      send(peer, "backlog", candidates);
    } else {
      broadcastToProctors("peer-joined", publicPeer(peer));
    }

    const heartbeat = setInterval(() => res.write(":\n\n"), 15000);
    req.on("close", () => {
      clearInterval(heartbeat);
      if (peers.get(id)?.res !== res) return; // superseded by a reconnect
      peers.delete(id);
      if (role === "candidate") broadcastToProctors("peer-left", { id });
      else {
        // Let candidates tear down their side of any connection to this proctor.
        for (const p of peers.values()) {
          if (p.role === "candidate") send(p, "hangup", { from: id, to: p.id });
        }
      }
    });
    return;
  }

  // Relay a WebRTC signaling message (offer/answer/ICE/etc.) to one specific peer.
  if (req.method === "POST" && pathname === "/signal") {
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      return sendJson(res, 400, { error: "invalid JSON body" });
    }
    const { from, to, type, payload } = body;
    if (!RELAY_TYPES.has(type)) return sendJson(res, 400, { error: "unknown signal type" });
    if (!peers.has(from)) return sendJson(res, 403, { error: "sender is not connected" });
    const target = peers.get(to);
    if (!target) return sendJson(res, 404, { error: "target peer not connected" });
    send(target, type, { from, to, payload, relayed_at: Date.now() });
    return sendJson(res, 202, { ok: true });
  }

  // Candidate-reported share status + screen events (SCREEN_SHARE_STOPPED,
  // WRONG_SURFACE, ...). Fanned out to every proctor. Shape matches POC #6's event
  // schema (event_type / detail / client_sent_at) so it can feed that pipeline later.
  if (req.method === "POST" && pathname === "/status") {
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      return sendJson(res, 400, { error: "invalid JSON body" });
    }
    const peer = peers.get(body.from);
    if (!peer || peer.role !== "candidate") {
      return sendJson(res, 403, { error: "sender is not a connected candidate" });
    }
    if (body.status) peer.status = body.status;
    const now = Date.now();
    broadcastToProctors("status", {
      id: peer.id,
      status: peer.status,
      event: body.event
        ? { ...body.event, client_sent_at: body.event.client_sent_at ?? now, server_received_at: now }
        : null,
    });
    return sendJson(res, 202, { ok: true });
  }

  if (req.method === "GET" && pathname === "/peers") {
    return sendJson(res, 200, [...peers.values()].map(publicPeer));
  }

  if (req.method === "GET") {
    return serveStatic(res, pathname);
  }

  res.writeHead(405);
  res.end("Method not allowed");
});

server.listen(PORT, () => {
  console.log(`POC #5 signaling server running at http://localhost:${PORT}`);
  console.log(`  Candidate (share screen): http://localhost:${PORT}/candidate.html`);
  console.log(`  Proctor (view screens):   http://localhost:${PORT}/proctor.html`);
});
