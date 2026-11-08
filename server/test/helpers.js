import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { loadConfig } from "../src/config.js";
import { createApp } from "../src/index.js";

export const silent = { info() {}, warn() {}, error() {} };

// A real server on a free port with its own temp dirs.
export async function startApp(env = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "arena-"));
  const clientDir = path.join(dir, "client");
  mkdirSync(clientDir);
  writeFileSync(path.join(clientDir, "index.html"), "<h1>hi</h1>");
  writeFileSync(path.join(dir, "secret.txt"), "secret");

  const config = loadConfig({
    PORT: "0",
    HOST: "127.0.0.1",
    LOG_DIR: path.join(dir, "logs"),
    CLIENT_DIR: clientDir,
    ...env,
  });
  const app = createApp(config, { log: silent });
  const port = await app.listen();
  return { app, port, dir, config, base: `http://127.0.0.1:${port}` };
}

export function connect(port, options) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, options);
    ws.messages = [];
    ws.on("message", (data) => ws.messages.push(JSON.parse(data.toString())));
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

export const closed = (ws) =>
  new Promise((resolve) =>
    ws.once("close", (code, reason) => resolve({ code, reason: reason.toString() })),
  );

export async function until(predicate, timeoutMs = 3000) {
  const end = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > end) throw new Error("until: timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

export async function createRoom(base, name = "Test room") {
  const response = await fetch(`${base}/api/rooms`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  return response.json();
}

export const join = (ws, room, name) =>
  ws.send(JSON.stringify({ type: "join", v: 1, room, name }));
