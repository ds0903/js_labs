import { createStats, type Stats } from "./stats.ts";

export const STEP = 1 / 60;

// If a frame took longer than this (hidden tab, breakpoint, long block),
// the extra time is dropped instead of simulated. Otherwise the loop would
// try to catch up with hundreds of steps and fall even further behind.
const MAX_FRAME = 0.25;

export interface Loop {
  readonly stats: Stats;
  start(): void;
  stop(): void;
}

export interface LoopOptions {
  step?: number;
  simulate: (step: number) => void;
  render: (alpha: number) => void;
  stats?: Stats;
}

// Fixed timestep loop on requestAnimationFrame.
//   simulate(step)  - advance the world by exactly `step` seconds
//   render(alpha)   - draw; alpha in [0, 1) is how far we are between
//                     the previous and the current simulation state
export function createLoop({
  step = STEP,
  simulate,
  render,
  stats = createStats(),
}: LoopOptions): Loop {
  let running = false;
  let rafId = 0;
  let last: number | null = null;
  let accumulator = 0;

  function frame(now: number) {
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
