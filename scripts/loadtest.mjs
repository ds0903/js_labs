// Load test: N headless WebSocket clients fly scripted paths against a real server.
//   node scripts/loadtest.mjs [steps] [seconds]
//   node scripts/loadtest.mjs 8,32,64,128 15
// Starts its own server (port 3999) as a child process, so the numbers are not
// disturbed by anything else, and prints one row per N as a markdown table.
// The clients run in this process on the same machine as the server, so they
// take CPU from it: the capacity found is a lower bound.

import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { decodeSnapshot, encodeInput } from "shared/codec/binary";
import WebSocket from "ws";

const steps = (process.argv[2] ?? "8,32,64,128").split(",").map(Number);
const seconds = Number(process.argv[3] ?? 15);
const PORT = 3999;
const ROOM_SIZE = 8;
const base = `http://127.0.0.1:${PORT}`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const api = async (route, init) => (await fetch(base + route, init)).json();

function startServer() {
  const child = spawn(process.execPath, ["server/src/index.ts"], {
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: "127.0.0.1",
      LOG_DIR: mkdtempSync(path.join(os.tmpdir(), "load-")),
      MAX_ROOMS: "64",
      MAX_PLAYERS: String(ROOM_SIZE),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return new Promise((resolve, reject) => {
    child.stdout.on("data", (chunk) => {
      if (String(chunk).includes("listening")) resolve(child);
    });
    child.once("exit", (code) => reject(new Error(`server exited with ${code}`)));
  });
}

function client(room, index, counters) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    ws.binaryType = "arraybuffer";
    let seq = 0;
    let tick = 0;
    let timer = null;
    const phase = index * 7;

    ws.on("open", () => {
      ws.send(
        JSON.stringify({ type: "join", v: 1, room, name: `L${index}`, codec: "binary" }),
      );
    });
    ws.on("message", (data, isBinary) => {
      if (!isBinary) {
        // the welcome means the ship exists: start flying
        if (!timer && JSON.parse(String(data)).type === "welcome") {
          timer = setInterval(() => {
            const step = seq++;
            ws.send(
              encodeInput({
                seq: seq,
                tick,
                thrust: (step + phase) % 90 < 60,
                turn: (Math.floor((step + phase) / 25) % 3) - 1,
                fire: (step + phase) % 12 === 0,
              }),
            );
          }, 1000 / 30);
          resolve({ ws, stop: () => clearInterval(timer) });
        }
        return;
      }
      tick = decodeSnapshot(data).tick;
      counters.frames++;
      counters.bytes += data.byteLength;
    });
    ws.on("error", reject);
  });
}

const pct = (sorted, q) => sorted[Math.floor((sorted.length - 1) * q)] ?? 0;

async function runStep(n) {
  const roomCount = Math.ceil(n / ROOM_SIZE);
  const rooms = [];
  for (let i = 0; i < roomCount; i++) {
    const body = JSON.stringify({ name: `load${i}`, arena: "classic" });
    const headers = { "Content-Type": "application/json" };
    rooms.push(await api("/api/rooms", { method: "POST", headers, body }));
  }

  const counters = { frames: 0, bytes: 0 };
  const clients = [];
  for (let i = 0; i < n; i++) {
    clients.push(await client(rooms[i % roomCount].id, i, counters));
  }

  await api("/api/stats"); // starts the event loop utilization window
  counters.frames = 0;
  counters.bytes = 0;
  await sleep(seconds * 1000);
  const stats = await api("/api/stats");

  const mine = stats.rooms.filter((r) => rooms.some((room) => room.id === r.id));
  const p99 = Math.max(...mine.map((r) => r.tickHistoryMs.p99));
  const p50 = pct(
    mine.map((r) => r.tickHistoryMs.p50).sort((a, b) => a - b),
    0.5,
  );
  const max = Math.max(...mine.map((r) => r.tickHistoryMs.max));
  const overruns = mine.reduce((sum, r) => sum + r.overruns, 0);

  for (const c of clients) {
    c.stop();
    c.ws.close();
  }
  await sleep(500);

  return {
    clients: n,
    rooms: roomCount,
    "tick p50 ms": p50,
    "tick p99 ms": p99,
    "tick max ms": max,
    overruns,
    elu: stats.elu,
    "rss MB": Math.round(stats.rss / 1048576),
    "frames/s per client": Math.round((counters.frames / n / seconds) * 10) / 10,
    "KB/s per client": Math.round(counters.bytes / n / seconds / 102.4) / 10,
  };
}

const server = await startServer();
const rows = [];
try {
  for (const n of steps) {
    const row = await runStep(n);
    rows.push(row);
    console.error(JSON.stringify(row));
  }
} finally {
  server.kill();
}

const columns = Object.keys(rows[0] ?? {});
console.log(`| ${columns.join(" | ")} |`);
console.log(`|${columns.map(() => "---").join("|")}|`);
for (const row of rows) console.log(`| ${columns.map((c) => row[c]).join(" | ")} |`);
process.exit(0);
