import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream";
import { LimitError } from "./rooms.js";
import { serveStatic } from "./static.js";

const ARENAS = ["classic", "rocks", "duel"];

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

export function sendJson(res, status, body, headers = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(data),
    ...headers,
  });
  res.end(data);
}

// Reads the request body, but gives up as soon as it is bigger than `limit`.
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooBig = false;
    req.on("data", (chunk) => {
      if (tooBig) return;
      size += chunk.length;
      if (size > limit) {
        tooBig = true;
        reject(new HttpError(413, "body too large"));
      } else {
        chunks.push(chunk);
      }
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function parseNewRoom(text) {
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new HttpError(400, "body is not JSON");
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "body must be an object");
  }
  const { name, arena = "classic" } = body;
  if (typeof name !== "string" || name.trim().length < 1 || name.length > 24) {
    throw new HttpError(400, "name must be 1-24 characters");
  }
  if (!ARENAS.includes(arena))
    throw new HttpError(400, `arena must be one of ${ARENAS.join(", ")}`);
  return { name: name.trim(), arena };
}

const REPLAY_NAME = /^[A-Za-z0-9_.-]+\.ndjson$/;

export function createHandler({ config, rooms, stats, connections }) {
  return async function handle(req, res) {
    const { pathname } = new URL(req.url, "http://localhost");
    const method = req.method;

    if (pathname === "/health" && method === "GET") {
      return sendJson(res, 200, {
        status: "ok",
        uptimeSec: Math.round(process.uptime()),
        rss: process.memoryUsage().rss,
        rooms: rooms.rooms.size,
        connections: connections(),
        droppedMessages: stats.dropped,
      });
    }

    if (pathname === "/api/rooms") {
      if (method === "GET") return sendJson(res, 200, rooms.list());
      if (method === "POST") {
        try {
          const { name, arena } = parseNewRoom(await readBody(req, config.maxBodyBytes));
          const room = rooms.create({ name, arena });
          return sendJson(res, 201, {
            id: room.id,
            name: room.name,
            arena: room.arena,
            players: 0,
          });
        } catch (error) {
          if (error instanceof LimitError)
            return sendJson(res, 429, { error: error.message });
          throw error;
        }
      }
      throw new HttpError(405, "method not allowed");
    }

    // match logs: list, and download one as a stream
    if (pathname === "/api/replays" && method === "GET") {
      const files = (await readdir(config.logDir)).filter((f) => REPLAY_NAME.test(f));
      return sendJson(res, 200, files);
    }
    if (pathname.startsWith("/api/replays/") && method === "GET") {
      let name;
      try {
        name = decodeURIComponent(pathname.slice("/api/replays/".length));
      } catch {
        throw new HttpError(400, "bad replay name");
      }
      if (!REPLAY_NAME.test(name)) throw new HttpError(400, "bad replay name");
      const file = path.join(config.logDir, name);
      let info;
      try {
        info = await stat(file);
      } catch {
        throw new HttpError(404, "no such replay");
      }
      res.writeHead(200, {
        "Content-Type": "application/x-ndjson",
        "Content-Length": info.size,
      });
      pipeline(createReadStream(file), res, () => {});
      return;
    }

    // demo only: blocks the event loop on purpose
    if (pathname === "/api/slow" && config.enableSlow) {
      const start = Date.now();
      while (Date.now() - start < config.slowMs) {
        // busy loop
      }
      return sendJson(res, 200, { blockedMs: Date.now() - start });
    }

    if (pathname.startsWith("/api/")) throw new HttpError(404, "no such endpoint");

    if (method !== "GET" && method !== "HEAD")
      throw new HttpError(405, "method not allowed");
    return serveStatic(config.clientDir, req, res);
  };
}
