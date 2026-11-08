import { createGame } from "shared/sim/game";
import { devUrl, isAbort, loadAll, loadJson, withRetry } from "./assets/loader.js";
import { connectAudio, createAudio } from "./audio.js";
import { burn, createExperimentLoop, createScenario } from "./experiments.js";
import { createInput } from "./input.js";
import { createLoop, STEP } from "./loop.js";
import { Connection, wsUrl } from "./net/connection.js";
import { Lobby } from "./net/lobby.js";
import { createView } from "./render/canvas.js";
import { drawScene } from "./render/draw.js";
import { createStats } from "./stats.js";
import { createChatView } from "./ui/chat-view.js";
import { connectHud } from "./ui/hud.js";
import { createLoadingScreen } from "./ui/loading.js";
import { showLobby } from "./ui/lobby-view.js";

const params = new URLSearchParams(location.search);
const experiment = params.get("exp");
const burnIterations = Number(params.get("burn") || 0);
const scenario = params.has("scenario") ? createScenario(5) : null;

const view = createView(document.getElementById("game"));
const overlay = document.getElementById("overlay");
const hud = document.getElementById("hud");
const scoreboard = document.getElementById("scores");

function startGame({ config, sprites, audio, name }) {
  const input = scenario ? scenario.input : createInput();
  const { world, ships } = scenario
    ? createGame({ inputs: [input], asteroids: 0, pickups: false })
    : createGame({ inputs: [input, input], names: name ? [name] : [], ...config });

  if (!scenario) {
    // ship.fire must not be passed to the listener as is: it would be called
    // without `this`. The arrow function keeps the call as ship.fire().
    for (const ship of ships) input.onPress(ship.controls.fire, () => ship.fire());
    connectHud(world, ships, scoreboard);
    if (audio) connectAudio(audio, world);
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

  function render(alpha) {
    drawScene(view, world, alpha, performance.now(), sprites);
    if (burnIterations) burn(burnIterations);
  }

  const stats = createStats((s) => {
    hud.textContent = [
      `steps/s   ${s.stepsPerSec.toFixed(1)}`,
      `frames/s  ${s.framesPerSec.toFixed(1)}`,
      `frame     ${s.frameMs.toFixed(1)} ms (max ${s.frameMaxMs.toFixed(1)})`,
      experiment ? `exp       ${experiment}` : "",
    ].join("\n");
  });
  const loop =
    createExperimentLoop(experiment, { simulate, render, stats }) ??
    createLoop({ step: STEP, simulate, render, stats });

  // handles for measuring from the browser console
  window.__stats = stats;
  window.__world = world;

  loop.start();
}

// ?inject=... adds broken or slow assets to the manifest, to test the loading screen
function injectedAssets() {
  const kind = params.get("inject");
  if (kind === "missing") {
    return [
      { key: "sprite:ghost", type: "image", url: "/assets/ghost.png", optional: true },
    ];
  }
  if (kind === "timeout") {
    return [{ key: "sound:stuck", type: "audio", url: "/slow/20000/assets/hit.wav" }];
  }
  if (kind === "corrupt") {
    return [
      { key: "json:corrupt", type: "json", name: "corrupt", url: "/assets/corrupt.json" },
    ];
  }
  if (kind === "many") {
    return Array.from({ length: 12 }, (_, i) => ({
      key: `sound:copy${i}`,
      type: "audio",
      name: `copy${i}`,
      url: `/assets/shoot.wav?copy=${i}`,
    }));
  }
  return [];
}

function describe(error) {
  if (isAbort(error)) return "Loading cancelled";
  if (error.name === "TimeoutError") return "Failed: request timed out";
  if (error instanceof SyntaxError) return `Failed: broken JSON (${error.message})`;
  return `Failed: ${error.message}`;
}

async function boot() {
  const audio = createAudio();
  const screen = createLoadingScreen(view, overlay);
  const loadLog = [];
  window.__loadLog = loadLog;
  const log = (text) => {
    loadLog.push(text);
    console.info("[load]", text);
  };
  const retry = {};
  const timeoutMs = Number(params.get("timeout") || 0) || undefined;
  const onRetry = ({ key, attempt, delay, error }) =>
    log(
      `retry ${key}: attempt ${attempt} failed (${error.name}), next in ${Math.round(delay)} ms`,
    );

  let manifest = null;
  let assets = null;
  while (!assets) {
    const controller = new AbortController();
    const cancelOnEsc = (e) => {
      if (e.code === "Escape") controller.abort();
    };
    window.addEventListener("keydown", cancelOnEsc);
    const started = performance.now();
    try {
      manifest ??= await withRetry(
        () =>
          loadJson(devUrl("/assets/manifest.json"), {
            signal: controller.signal,
            timeoutMs,
          }),
        { signal: controller.signal, onRetry: (i) => onRetry({ key: "manifest", ...i }) },
      );
      assets = await loadAll(manifest, {
        ctx: audio.ctx,
        signal: controller.signal,
        sequential: params.get("loader") === "sequential",
        extra: injectedAssets(),
        timeoutMs,
        retry,
        onRetry,
        onProgress: (fraction, key) => screen.progress(fraction, key),
      });
      window.__loadMs = performance.now() - started;
      const failed = assets.failed.map((f) => `${f.key} (${f.error.message})`);
      log(
        `loaded in ${Math.round(window.__loadMs)} ms, optional failures: ${failed.join(", ") || "none"}`,
      );
    } catch (error) {
      log(describe(error));
      await screen.fail(describe(error));
    } finally {
      window.removeEventListener("keydown", cancelOnEsc);
    }
  }
  screen.done();
  audio.setBuffers(assets.sounds);

  const lobby = new Lobby();
  const { name, room } = await showLobby(overlay, lobby);

  // the match itself is still local; the room gives chat and a player list
  const connection = new Connection({ url: wsUrl(), room: room.id, name });
  createChatView(document.body, connection, { roomName: room.name, selfName: name });
  window.__connection = connection;

  startGame({
    config: manifest.arenas[room.arena],
    sprites: assets.sprites,
    audio,
    name,
  });
}

// experiments from lab 1 start right away, without assets and lobby
if (scenario || experiment) startGame({ config: {} });
else boot();
