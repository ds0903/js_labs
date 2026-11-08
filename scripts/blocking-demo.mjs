// Shows what a synchronous handler does to everybody else: one client chats
// and measures how long its own messages take to come back, while another
// client calls /api/slow (a busy loop of SLOW_MS) a few times.
//   node scripts/blocking-demo.mjs
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";

const PORT = 3102;
const SLOW_MS = 300;
const root = path.resolve(import.meta.dirname, "..");
const dir = mkdtempSync(path.join(os.tmpdir(), "arena-block-"));
mkdirSync(path.join(dir, "logs"), { recursive: true });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const server = spawn(process.execPath, ["server/src/index.js"], {
  cwd: root,
  env: {
    ...process.env,
    PORT: String(PORT),
    LOG_DIR: path.join(dir, "logs"),
    ENABLE_SLOW: "1",
    SLOW_MS: String(SLOW_MS),
  },
  stdio: "ignore",
});

async function until(fn) {
  for (let i = 0; i < 100; i++) {
    try {
      return await fn();
    } catch {
      await sleep(100);
    }
  }
  throw new Error("server did not start");
}

const base = `http://127.0.0.1:${PORT}`;
await until(() => fetch(`${base}/health`));
const room = await (
  await fetch(`${base}/api/rooms`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "block" }),
  })
).json();

const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
await new Promise((resolve) => ws.once("open", resolve));
ws.send(JSON.stringify({ type: "join", v: 1, room: room.id, name: "Probe" }));

const sent = new Map(); // text -> time sent
const latencies = []; // [sentAt, ms]
ws.on("message", (data) => {
  const message = JSON.parse(data.toString());
  if (message.type !== "chat" || !sent.has(message.text)) return;
  latencies.push([sent.get(message.text), performance.now() - sent.get(message.text)]);
});

// one probe every 100 ms, well under the 20 messages/s rate limit
let n = 0;
const probe = setInterval(() => {
  const text = `p${n++}`;
  sent.set(text, performance.now());
  ws.send(JSON.stringify({ type: "chat", text }));
}, 100);

const t0 = performance.now();
await sleep(1500); // quiet period
const quietEnd = performance.now();
for (let i = 0; i < 3; i++) {
  await fetch(`${base}/api/slow`); // blocks the server for SLOW_MS each
  await sleep(300);
}
const loadEnd = performance.now();
await sleep(500);
clearInterval(probe);

const stats = (rows) => {
  const v = rows.map((r) => r[1]).sort((a, b) => a - b);
  return {
    count: v.length,
    median: v[Math.floor(v.length / 2)],
    max: v.at(-1),
  };
};
const quiet = stats(latencies.filter(([at]) => at >= t0 && at < quietEnd));
const busy = stats(latencies.filter(([at]) => at >= quietEnd && at < loadEnd));
const f = (x) => x.toFixed(1);
console.log(`/api/slow busy loop: ${SLOW_MS} ms, 3 calls`);
console.log(
  `chat echo, server idle:    ${quiet.count} msgs, median ${f(quiet.median)} ms, max ${f(quiet.max)} ms`,
);
console.log(
  `chat echo, /api/slow runs: ${busy.count} msgs, median ${f(busy.median)} ms, max ${f(busy.max)} ms`,
);

ws.close();
server.kill();
rmSync(dir, { recursive: true, force: true });
