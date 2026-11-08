import { createLoop, STEP } from "./loop.js";

// Code for the "break it on purpose" experiments from the README.
// Enabled from the URL: ?exp=block | interval | variable,
// plus &burn=N for extra CPU work per frame and &scenario for a scripted flight.

// work that scales with CPU speed (CPU throttling slows it down)
export function burn(iterations) {
  let x = 0;
  for (let i = 0; i < iterations; i++) x += Math.sqrt(i) * Math.sin(i);
  // keep the result observable so the engine cannot throw the loop away
  globalThis.__burn = x;
}

// work that takes fixed wall-clock time
function busyWait(ms) {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    // spin
  }
}

// Experiment 1: the same loop, but every 60th frame render blocks for 100 ms.
function createBlockingLoop({ simulate, render, stats }) {
  let frames = 0;
  return createLoop({
    step: STEP,
    simulate,
    stats,
    render(alpha) {
      render(alpha);
      frames++;
      if (frames % 60 === 0) busyWait(100);
    },
  });
}

// Experiment 2: same accumulator, but driven by setInterval instead of rAF.
function createIntervalLoop({ simulate, render, stats }) {
  let timer = 0;
  let last = 0;
  let accumulator = 0;

  function frame() {
    const now = performance.now();
    const frameMs = now - last;
    last = now;

    accumulator += Math.min(frameMs / 1000, 0.25);
    while (accumulator >= STEP) {
      simulate(STEP);
      stats.step();
      accumulator -= STEP;
    }

    render(accumulator / STEP);
    stats.frame(frameMs, now);
  }

  return {
    stats,
    start() {
      last = performance.now();
      timer = setInterval(frame, 16);
    },
    stop() {
      clearInterval(timer);
    },
  };
}

// Experiment 3: no accumulator, one simulation step per frame with
// whatever dt the frame happened to take.
function createVariableLoop({ simulate, render, stats }) {
  let running = false;
  let rafId = 0;
  let last = null;

  function frame(now) {
    if (!running) return;
    rafId = requestAnimationFrame(frame);

    if (last === null) last = now;
    const frameMs = now - last;
    last = now;

    simulate(Math.min(frameMs / 1000, 0.25));
    stats.step();
    render(1);
    stats.frame(frameMs, now);
  }

  return {
    stats,
    start() {
      running = true;
      last = null;
      rafId = requestAnimationFrame(frame);
    },
    stop() {
      running = false;
      cancelAnimationFrame(rafId);
    },
  };
}

export function createExperimentLoop(name, context) {
  if (name === "block") return createBlockingLoop(context);
  if (name === "interval") return createIntervalLoop(context);
  if (name === "variable") return createVariableLoop(context);
  return null;
}

// Scripted flight for comparing trajectories. Keys are a function of
// simulated time, not wall-clock time, so every run asks for the same
// thing and only the loop can make the results differ.
export function createScenario(duration) {
  let time = 0;
  let steps = 0;

  const input = {
    isDown(code) {
      if (code === "ArrowUp") return time < 2 || (time >= 3 && time < 4);
      if (code === "ArrowRight") return time >= 0.5 && time < 1.5;
      if (code === "ArrowLeft") return time >= 2.5 && time < 3.5;
      return false;
    },
    justPressed: () => false,
    endStep() {},
  };

  const scenario = {
    input,
    result: null,

    get done() {
      return scenario.result !== null;
    },

    // the last step is cut short so every run ends at exactly `duration`
    clip(dt) {
      return Math.min(dt, duration - time);
    },

    advance(dt, ship) {
      time += dt;
      steps++;
      if (time < duration - 1e-9) return false;
      scenario.result = {
        simTime: time,
        steps,
        x: ship.x,
        y: ship.y,
        vx: ship.vx,
        vy: ship.vy,
        angle: ship.angle,
      };
      return true;
    },
  };

  return scenario;
}
