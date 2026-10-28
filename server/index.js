/**
 * Kutulu Arena — zero-dependency HTTP + SSE server.
 *
 *   node server/index.js            # http://localhost:8787
 *   PORT=8080 HOST=0.0.0.0 node server/index.js
 *
 * Static files from public/, JSON API under /api/, live game state over
 * Server-Sent Events.  No npm install, no build step.
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRoom, getRoom, roomList, allRooms } from "./rooms.js";
import { availableBots } from "./game/bots.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ARENA = path.resolve(HERE, "..");
const PUBLIC = path.join(ARENA, "public");
const DATA = path.join(ARENA, "data");
const REPLAYS = path.join(DATA, "replays");

fs.mkdirSync(REPLAYS, { recursive: true });

const cfgFile = path.join(ARENA, "config.json");
const cfg = fs.existsSync(cfgFile) ? JSON.parse(fs.readFileSync(cfgFile, "utf8")) : {};
const PORT = Number(process.env.PORT || cfg.port || 8787);
const HOST = process.env.HOST || cfg.host || "0.0.0.0";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

// ---------------------------------------------------------------- helpers
function json(res, code, body) {
  const data = JSON.stringify(body);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(data),
  });
  res.end(data);
}

function readBody(req, limit = 1e6) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("payload too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("invalid json"));
      }
    });
    req.on("error", reject);
  });
}

function serveStatic(req, res, urlPath) {
  const rel = decodeURIComponent(urlPath).replace(/^\/+/, "");
  const target = path.join(PUBLIC, rel || "index.html");
  if (!target.startsWith(PUBLIC)) {
    res.writeHead(403);
    return res.end("forbidden");
  }
  fs.stat(target, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end("not found");
    }
    const ext = path.extname(target).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Cache-Control": "no-cache",
      "Content-Length": st.size,
    });
    fs.createReadStream(target).pipe(res);
  });
}

// --------------------------------------------------------------- SSE ----
function sse(req, res, room, token) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write("retry: 2000\n\n");

  const seat = room.seats.find((s) => s.token && s.token === token);
  const client = {
    res,
    seat: seat ? seat.seat : -1,
    token,
    send(event, data) {
      try {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      } catch {
        /* ignore */
      }
    },
  };
  room.addClient(client);

  const ping = setInterval(() => {
    try {
      res.write(`: ping\n\n`);
    } catch {
      /* ignore */
    }
  }, 20000);

  req.on("close", () => {
    clearInterval(ping);
    room.removeClient(client);
  });
}

// ------------------------------------------------------------ replay io --
function saveReplay(room) {
  const bundle = room.replayBundle();
  fs.writeFileSync(path.join(REPLAYS, `${bundle.id}.json`), JSON.stringify(bundle));
  const indexFile = path.join(REPLAYS, "index.json");
  const index = fs.existsSync(indexFile) ? JSON.parse(fs.readFileSync(indexFile, "utf8")) : [];
  const me = bundle.meta?.seats?.find((s) => s.kind === "human");
  index.unshift({
    id: bundle.id,
    room: room.id,
    name: bundle.name,
    map: bundle.map,
    ended: bundle.meta.ended,
    turns: bundle.turns.length,
    seats: bundle.meta.seats,
    winner: bundle.ranking[0],
    humans: me ? 1 : 0,
  });
  fs.writeFileSync(indexFile, JSON.stringify(index.slice(0, 200), null, 1));
  return bundle.id;
}

// ---------------------------------------------------------------- routes
async function route(req, res, url) {
  const p = url.pathname;

  if (p === "/api/bots") return json(res, 200, { bots: availableBots() });

  if (p === "/api/rooms" && req.method === "GET") return json(res, 200, { rooms: roomList() });

  if (p === "/api/rooms" && req.method === "POST") {
    const body = await readBody(req);
    const room = createRoom({
      name: body.name,
      stepMs: body.stepMs,
      bankMs: body.bankMs,
      games: body.games,
      paceMs: body.paceMs,
      visibility: body.visibility,
    });
    const host = room.join({ name: body.nickname || "房主" });
    room.hostToken = host.token; // the creator owns the room
    room.on("finished", () => {
      try {
        saveReplay(room);
      } catch (e) {
        console.error("replay save failed", e);
      }
    });
    if (body.quick) {
      // solo practice: three medium bots, straight in
      for (const seat of [1, 2, 3]) {
        room.setSeat(seat, { kind: "ai", difficulty: "medium" }, host.token);
      }
      room.start(host.token);
    }
    return json(res, 200, { id: room.id, token: host.token, seat: host.seat });
  }

  const m = /^\/api\/rooms\/([A-Z0-9]{4,8})(\/.*)?$/.exec(p);
  if (m) {
    const room = getRoom(m[1]);
    if (!room) return json(res, 404, { error: "房间不存在" });
    const sub = m[2] || "";

    if (sub === "/join" && req.method === "POST") {
      const body = await readBody(req);
      const r = room.join({ name: body.nickname, token: body.token });
      if (r.error) return json(res, 400, r);
      return json(res, 200, { ...r, room: room.publicInfo() });
    }
    if (sub === "/seat" && req.method === "POST") {
      const body = await readBody(req);
      const r = room.setSeat(Number(body.seat), body, body.token);
      if (r.error) return json(res, 400, r);
      return json(res, 200, { ok: true });
    }
    if (sub === "/settings" && req.method === "POST") {
      const body = await readBody(req);
      const r = room.setSettings(body, body.token);
      if (r.error) return json(res, 400, r);
      return json(res, 200, { ok: true });
    }
    if (sub === "/start" && req.method === "POST") {
      const body = await readBody(req);
      const r = room.start(body.token);
      if (r.error) return json(res, 400, r);
      return json(res, 200, { ok: true });
    }
    if (sub === "/act" && req.method === "POST") {
      const body = await readBody(req);
      const r = room.submit(Number(body.seat), body.action, body.token, body.turn);
      if (r.error) return json(res, 400, r);
      return json(res, 200, { ok: true });
    }
    if (sub === "/next" && req.method === "POST") {
      const body = await readBody(req);
      const r = room.nextGame(body.token);
      if (r.error) return json(res, 400, r);
      return json(res, 200, { ok: true });
    }
    if (sub === "/end-series" && req.method === "POST") {
      const body = await readBody(req);
      const r = room.endSeries(body.token);
      if (r.error) return json(res, 400, r);
      return json(res, 200, { ok: true });
    }
    if (sub === "/state" && req.method === "GET") {
      const token = url.searchParams.get("token") || "";
      const seat = room.seats.find((s) => s.token === token);
      const viewer = { token, seat: seat ? seat.seat : -1 };
      return json(res, 200, {
        room: room.stateFor(viewer),
        snapshot: room.snapshotFor(viewer),
      });
    }
    if (sub === "/events" && req.method === "GET") {
      return sse(req, res, room, url.searchParams.get("token") || "");
    }
    return json(res, 404, { error: "unknown endpoint" });
  }

  if (p === "/api/ladder" && req.method === "GET") {
    const f = path.join(DATA, "ladder.json");
    if (!fs.existsSync(f)) return json(res, 404, { error: "还没有统计数据" });
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    return res.end(fs.readFileSync(f));
  }

  if (p === "/api/replays" && req.method === "GET") {
    const f = path.join(REPLAYS, "index.json");
    const list = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : [];
    return json(res, 200, { replays: list });
  }
  if (p.startsWith("/api/replays/") && req.method === "GET") {
    const id = p.slice("/api/replays/".length).replace(/[^A-Za-z0-9-]/g, "");
    const f = path.join(REPLAYS, `${id}.json`);
    if (!fs.existsSync(f)) return json(res, 404, { error: "录像不存在" });
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    return res.end(fs.readFileSync(f));
  }

  return serveStatic(req, res, p);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }
  route(req, res, url).catch((err) => {
    console.error(err);
    if (!res.headersSent) json(res, 500, { error: err.message });
    else res.end();
  });
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`\n  Port ${PORT} is already in use.`);
    console.error("  Another arena (or another app) is listening there.");
    console.error("  Stop it, or pick another port:");
    console.error(`    PowerShell:  $env:PORT=8788; node server/index.js`);
    console.error(`    bash:        PORT=8788 node server/index.js\n`);
    process.exit(1);
  }
  if (err.code === "EACCES") {
    console.error(`\n  Not allowed to listen on ${HOST}:${PORT}. Try a port above 1024.\n`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, HOST, () => {
  const shown = HOST === "0.0.0.0" ? "localhost" : HOST;
  console.log(`\n  Kutulu Arena  ->  http://${shown}:${PORT}`);
  console.log(`  static:  ${PUBLIC}`);
  console.log(`  replays: ${REPLAYS}\n`);
});

// housekeeping: drop finished/empty rooms after two quiet hours
setInterval(() => {
  const now = Date.now();
  for (const room of allRooms()) {
    if (room.state === "closed") continue;
    if (room.state === "playing") continue;
    if (room.clients.size) continue;
    if (now - room.createdAt > 2 * 3600 * 1000) room.close();
  }
}, 10 * 60 * 1000).unref?.();

// never leave bot subprocesses behind
function shutdown() {
  for (const room of allRooms()) {
    try {
      room.close();
    } catch {
      /* ignore */
    }
  }
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("exit", () => {
  for (const room of allRooms()) {
    try {
      room.stopBots();
    } catch {
      /* ignore */
    }
  }
});
