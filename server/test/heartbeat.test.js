import assert from "node:assert/strict";
import { afterEach, beforeEach, test, vi } from "vitest";
import { closed, connect, startApp } from "./helpers.js";

// The heartbeat is a setInterval inside the server. The clock of that interval
// is fake, the sockets are real: the test decides when "15 seconds" have passed.
const INTERVAL = 1000;
let running;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
});

afterEach(async () => {
  await running?.app.close();
  running = null;
  vi.useRealTimers();
});

const real = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("a client that never answers pings is terminated on the third interval", async () => {
  running = await startApp({ PING_INTERVAL_MS: String(INTERVAL) });
  const ws = await connect(running.port, { autoPong: false });
  const gone = closed(ws);

  vi.advanceTimersByTime(INTERVAL); // ping 1, missed = 1
  vi.advanceTimersByTime(INTERVAL); // ping 2, missed = 2
  await real(30);
  assert.equal(ws.readyState, ws.OPEN, "two missed pongs are still allowed");

  vi.advanceTimersByTime(INTERVAL); // missed >= 2: terminate
  const { code } = await gone;
  assert.equal(code, 1006, "terminate() drops the connection without a goodbye");
});

test("a client that answers pings stays connected through many intervals", async () => {
  running = await startApp({ PING_INTERVAL_MS: String(INTERVAL) });
  const ws = await connect(running.port); // the ws client pongs by itself
  for (let i = 0; i < 6; i++) {
    vi.advanceTimersByTime(INTERVAL);
    await real(30); // let the ping reach the client and the pong come back
  }
  assert.equal(ws.readyState, ws.OPEN);
  ws.close();
});
