import { createStats } from "./stats.js";

export const STEP = 1 / 60;

// If a frame took longer than this (hidden tab, breakpoint, long block),
// the extra time is dropped instead of simulated. Otherwise the loop would
// try to catch up with hundreds of steps and fall even further behind.
const MAX_FRAME = 0.25;

// Fixed timestep loop on requestAnimationFrame.
//   simulate(step)  - advance the world by exactly `step` seconds
//   render(alpha)   - draw; alpha in [0, 1) is how far we are between
//                     the previous and the current simulation state
export function createLoop({ step = STEP, simulate, render, stats = createStats() }) {
  let running = false;
  let rafId = 0;
  let last = null;
  let accumulator = 0;

  function frame(now) {
    if (!running) return;
    rafId = requestAnimationFrame(frame);

    if (last === null) last = now;
    const frameMs = now - last;
    last = now;

    accumulator += Math.min(frameMs / 1000, MAX_FRAME);
    while (accumulator >= step) {
      simulate(step);
      stats.step();
      accumulator -= step;
    }

    render(accumulator / step);
    stats.frame(frameMs, now);
  }

  return {
    stats,
    start() {
      if (running) return;
      running = true;
      last = null;
      accumulator = 0;
      rafId = requestAnimationFrame(frame);
    },
    stop() {
      running = false;
      cancelAnimationFrame(rafId);
    },
  };
}
