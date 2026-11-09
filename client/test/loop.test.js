import assert from "node:assert/strict";
import { afterEach, beforeEach, test, vi } from "vitest";
import { createLoop, STEP } from "../src/loop.ts";

// requestAnimationFrame on a fake clock: a frame is a timer, and the test decides
// how long the next one takes. Nothing here waits for real time.
let frameDelay = 16;

beforeEach(() => {
  frameDelay = 16;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  globalThis.requestAnimationFrame = (callback) =>
    setTimeout(() => callback(performance.now()), frameDelay);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
});

afterEach(() => {
  vi.useRealTimers();
  delete globalThis.requestAnimationFrame;
  delete globalThis.cancelAnimationFrame;
});

function run() {
  const calls = { steps: 0, renders: 0, alphas: [] };
  const loop = createLoop({
    simulate: () => calls.steps++,
    render: (alpha) => {
      calls.renders++;
      calls.alphas.push(alpha);
    },
  });
  loop.start();
  return { loop, calls };
}

test("one second of 16 ms frames makes about 60 fixed steps", () => {
  const { loop, calls } = run();
  vi.advanceTimersByTime(1000);
  loop.stop();
  // the first frame only starts the clock, so 1000 ms is really ~976 ms of steps
  assert.ok(Math.abs(calls.steps - 60) <= 3, `steps ${calls.steps}`);
  assert.ok(calls.renders >= 60 && calls.renders <= 63, `renders ${calls.renders}`);
});

test("the step does not depend on the frame rate: 30 fps and 144 fps both get 60 steps/s", () => {
  for (const delay of [33, 7]) {
    frameDelay = delay;
    const { loop, calls } = run();
    vi.advanceTimersByTime(2000);
    loop.stop();
    assert.ok(
      Math.abs(calls.steps - 120) <= 6,
      `${delay} ms frames: ${calls.steps} steps`,
    );
  }
});

test("render gets alpha in [0, 1), the part of a step that is left over", () => {
  const { loop, calls } = run();
  vi.advanceTimersByTime(500);
  loop.stop();
  assert.ok(calls.alphas.length > 10);
  for (const alpha of calls.alphas) assert.ok(alpha >= 0 && alpha < 1, `alpha ${alpha}`);
});

test("a stalled frame is clamped to 0.25 s, so the loop does not try to catch up", () => {
  const { loop, calls } = run();
  vi.advanceTimersByTime(100); // warm up
  const before = calls.steps;
  frameDelay = 3000; // the next frame comes after a 3 s stall
  vi.advanceTimersByTime(16); // the frame in flight fires and schedules the late one
  vi.advanceTimersByTime(3000);
  loop.stop();
  const during = calls.steps - before;
  const clamp = 0.25 / STEP;
  assert.ok(during <= clamp + 3, `${during} steps after a 3 s stall`);
  assert.ok(during >= clamp - 3, `${during} steps after a 3 s stall`);
});

test("stop() ends the loop and start() twice does not run two loops", () => {
  const { loop, calls } = run();
  loop.start(); // second start is ignored
  vi.advanceTimersByTime(500);
  loop.stop();
  const stopped = calls.steps;
  vi.advanceTimersByTime(500);
  assert.equal(calls.steps, stopped);
  assert.ok(Math.abs(stopped - 30) <= 3, `steps ${stopped}`);
});
