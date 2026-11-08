import { burn, createExperimentLoop, createScenario } from "./experiments.js";
import { createInput } from "./input.js";
import { createLoop, STEP } from "./loop.js";
import { createView } from "./render/canvas.js";
import { drawScene } from "./render/draw.js";
import { createGame } from "./sim/game.js";
import { createStats } from "./stats.js";

const params = new URLSearchParams(location.search);
const experiment = params.get("exp");
const burnIterations = Number(params.get("burn") || 0);
const scenario = params.has("scenario") ? createScenario(5) : null;

const view = createView(document.getElementById("game"));
const input = scenario ? scenario.input : createInput();
const hud = document.getElementById("hud");
const scoreboard = document.getElementById("scores");

const { world, ships } = scenario
  ? createGame({ inputs: [input], asteroids: 0, pickups: false })
  : createGame({ inputs: [input, input] });

if (!scenario) {
  // ship.fire must not be passed to the listener as is: it would be called
  // without `this`. The arrow function keeps the call as ship.fire().
  ships.forEach((ship) => {
    input.onPress(ship.controls.fire, () => ship.fire());
  });
}

function simulate(dt) {
  if (scenario) {
    if (scenario.done) return;
    dt = scenario.clip(dt);
  }

  world.step(dt);
  input.endStep();

  if (scenario?.advance(dt, ships[0])) {
    loop.stop();
    window.__result = scenario.result;
  }
}

let lastScores = "";
function showScores() {
  const text = ships
    .map((s) => `${s.name}  hp ${String(s.hp).padStart(3)}  score ${s.score}`)
    .join("\n");
  if (text !== lastScores) {
    scoreboard.textContent = text;
    lastScores = text;
  }
}

function render(alpha) {
  drawScene(view, world, alpha, performance.now());
  showScores();
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
window.__world = world;

loop.start();
