import { burn, createExperimentLoop, createScenario } from "./experiments.js";
import { createInput } from "./input.js";
import { createLoop, STEP } from "./loop.js";
import { createView } from "./render/canvas.js";
import { drawScene } from "./render/draw.js";
import { ARENA, wrapShip } from "./sim/arena.js";
import { createShip, integrate } from "./sim/ship.js";
import { createStats } from "./stats.js";

const params = new URLSearchParams(location.search);
const experiment = params.get("exp");
const burnIterations = Number(params.get("burn") || 0);
const scenario = params.has("scenario") ? createScenario(5) : null;

const view = createView(document.getElementById("game"));
const input = scenario ? scenario.input : createInput();
const hud = document.getElementById("hud");

let prev = createShip(ARENA.width / 2, ARENA.height / 2);
let curr = prev;

function simulate(dt) {
  if (scenario) {
    if (scenario.done) return;
    dt = scenario.clip(dt);
  }

  prev = curr;
  curr = wrapShip(integrate(curr, input, dt), ARENA);
  input.endStep();

  if (scenario?.advance(dt, curr)) {
    loop.stop();
    window.__result = scenario.result;
  }
}

function render(alpha) {
  drawScene(view, prev, curr, alpha, performance.now());
  if (burnIterations) burn(burnIterations);
}

function showStats(s) {
  hud.textContent = [
    `steps/s   ${s.stepsPerSec.toFixed(1)}`,
    `frames/s  ${s.framesPerSec.toFixed(1)}`,
    `frame     ${s.frameMs.toFixed(1)} ms (max ${s.frameMaxMs.toFixed(1)})`,
    experiment ? `exp       ${experiment}` : "",
  ].join("\n");
}

const stats = createStats(showStats);
const loop =
  createExperimentLoop(experiment, { simulate, render, stats }) ??
  createLoop({ step: STEP, simulate, render, stats });

// handles for measuring from the browser console
window.__stats = stats;

loop.start();
