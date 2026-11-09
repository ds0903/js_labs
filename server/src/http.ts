import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { pipeline } from "node:stream";
import { ARENAS, isArenaName } from "shared/sim/game";
import type { ServerConfig } from "./config.ts";
import { LimitError, type RoomManager } from "./rooms.ts";
import { serveStatic } from "./static.ts";

const ARENA_NAMES = Object.keys(ARENAS);
let lastElu = performance.eventLoopUtilization();

export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(data),
    ...headers,
  });
  res.end(data);
}

// Reads the request body, but gives up as soon as it is bigger than `limit`.
function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooBig = false;
    req.on("data", (chunk: Buffer) => {
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

function parseNewRoom(text: string): { name: string; arena: string } {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new HttpError(400, "body is not JSON");
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "body must be an object");
  }
  // the body is `unknown` until here; `in` narrows it field by field
  const name = "name" in body ? body.name : undefined;
  const arena = "arena" in body && body.arena !== undefined ? body.arena : "classic";
  if (typeof name !== "string" || name.trim().length < 1 || name.length > 24) {
    throw new HttpError(400, "name must be 1-24 characters");
  }
  if (typeof arena !== "string" || !isArenaName(arena)) {
    throw new HttpError(400, `arena must be one of ${ARENA_NAMES.join(", ")}`);
  }
  return { name: name.trim(), arena };
}

const REPLAY_NAME = /^[A-Za-z0-9_.-]+\.ndjson$/;

// an empty body means one bot
function parseBotCount(text: string): number {
  if (text.trim() === "") return 1;
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new HttpError(400, "body is not JSON");
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "body must be an object");
  }
  const count = "count" in body ? body.count : 1;
  if (typeof count !== "number" || !Number.isInteger(count) || count < 1 || count > 8) {
    throw new HttpError(400, "count must be a whole number from 1 to 8");
  }
  return count;
}

export interface HandlerDeps {
  config: ServerConfig;
  rooms: RoomManager;
  stats: { dropped: number };
  connections: () => number;
}

export function createHandler({ config, rooms, stats, connections }: HandlerDeps) {
  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const { pathname } = new URL(req.url ?? "/", "http://localhost");
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

    if (pathname === "/api/stats" && method === "GET") {
      // share of time the event loop was busy since the previous call
      const now = performance.eventLoopUtilization();
      const elu = performance.eventLoopUtilization(now, lastElu).utilization;
      lastElu = now;
      const memory = process.memoryUsage();
      return sendJson(res, 200, {
        uptimeSec: Math.round(process.uptime()),
        rss: memory.rss,
        heapUsed: memory.heapUsed,
        elu: Math.round(elu * 1000) / 1000,
        connections: connections(),
        rooms: rooms.stats(),
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

    // POST /api/rooms/:id/bots  { count?: 1-8 }  puts AI players into a room
    const botsRoute = /^\/api\/rooms\/([A-Za-z0-9_-]{1,40})\/bots$/.exec(pathname);
    if (botsRoute) {
      if (method !== "POST") throw new HttpError(405, "method not allowed");
      const room = rooms.get(botsRoute[1] ?? "");
      if (!room?.match) throw new HttpError(404, "no such room");
      const count = parseBotCount(await readBody(req, config.maxBodyBytes));
      let added = 0;
      while (added < count && room.match.addBot()) added++;
      return sendJson(res, added > 0 ? 201 : 409, {
        added,
        players: room.size,
        ...(added < count && { error: "room is full" }),
      });
    }

    // match logs: list, and download one as a stream
    if (pathname === "/api/replays" && method === "GET") {
      const files = (await readdir(config.logDir)).filter((f) => REPLAY_NAME.test(f));
      return sendJson(res, 200, files);
    }
    if (pathname.startsWith("/api/replays/") && method === "GET") {
      let name: string;
      try {
        name = decodeURIComponent(pathname.slice("/api/replays/".length));
      } catch {
        throw new HttpError(400, "bad replay name");
      }
      if (!REPLAY_NAME.test(name)) throw new HttpError(400, "bad replay name");
      const file = path.join(config.logDir, name);
      let info: Awaited<ReturnType<typeof stat>>;
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
