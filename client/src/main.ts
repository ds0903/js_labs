import type { ServerMessage } from "shared/protocol";
import { type ArenaPreset, createGame } from "shared/sim/game";
import type { World } from "shared/sim/world";
import { ZodError } from "zod";
import {
  type Assets,
  devUrl,
  isAbort,
  type LoadItem,
  loadAll,
  loadJson,
  type Manifest,
  ManifestSchema,
  withRetry,
} from "./assets/loader.ts";
import { type Audio, connectAudio, createAudio } from "./audio.ts";
import { query } from "./dom.ts";
import { burn, createExperimentLoop, createScenario } from "./experiments.ts";
import { createInput } from "./input.ts";
import { createLoop, STEP } from "./loop.ts";
import { Connection, wsUrl } from "./net/connection.ts";
import { Lobby } from "./net/lobby.ts";
import { startNetGame } from "./net/play.ts";
import { createView } from "./render/canvas.ts";
import { type Drawable, drawableOf, drawScene, type Sprites } from "./render/draw.ts";
import { createStats } from "./stats.ts";
import { createChatView } from "./ui/chat-view.ts";
import { connectHud } from "./ui/hud.ts";
import { createLoadingScreen } from "./ui/loading.ts";
import { showLobby } from "./ui/lobby-view.ts";

const params = new URLSearchParams(location.search);
const experiment = params.get("exp");
const burnIterations = Number(params.get("burn") || 0);
const scenario = params.has("scenario") ? createScenario(5) : null;

const view = createView(query(document, "#game", HTMLCanvasElement));
const overlay = query(document, "#overlay", HTMLElement);
const hud = query(document, "#hud", HTMLElement);
const scoreboard = query(document, "#scores", HTMLElement);

interface LocalGame {
  config: Partial<ArenaPreset>;
  sprites?: Sprites;
  audio?: Audio;
  name?: string;
}

// what is drawn of a world that lives in this page (no network)
function* sceneOf(world: World): Generator<Drawable> {
  for (const entity of world) {
    const drawable = drawableOf(entity);
    if (drawable) yield drawable;
  }
}

function startGame({ config, sprites, audio, name }: LocalGame): void {
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

  function simulate(step: number): void {
    let dt = step;
    if (scenario) {
      if (scenario.done) return;
      dt = scenario.clip(dt);
    }

    world.step(dt);
    input.endStep();

    const first = ships[0];
    if (scenario && first && scenario.advance(dt, first)) {
      loop.stop();
      window.__result = scenario.result;
    }
  }

  function render(alpha: number): void {
    drawScene(view, sceneOf(world), alpha, performance.now(), sprites);
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
function injectedAssets(): LoadItem[] {
  const kind = params.get("inject");
  if (kind === "missing") {
    return [
      {
        key: "sprite:ghost",
        type: "image",
        name: "ghost",
        url: "/assets/ghost.png",
        optional: true,
      },
    ];
  }
  if (kind === "timeout") {
    return [
      {
        key: "sound:stuck",
        type: "audio",
        name: "stuck",
        url: "/slow/20000/assets/hit.wav",
      },
    ];
  }
  if (kind === "corrupt") {
    return [
      { key: "json:corrupt", type: "json", name: "corrupt", url: "/assets/corrupt.json" },
    ];
  }
  if (kind === "many") {
    return Array.from({ length: 12 }, (_, i) => ({
      key: `sound:copy${i}`,
      type: "audio" as const,
      name: `copy${i}`,
      url: `/assets/shoot.wav?copy=${i}`,
    }));
  }
  return [];
}

// a catch clause gives `unknown`: look at what it is before using it
function describe(error: unknown): string {
  if (isAbort(error)) return "Loading cancelled";
  if (error instanceof ZodError) return "Failed: manifest has a wrong shape";
  if (error instanceof SyntaxError) return `Failed: broken JSON (${error.message})`;
  if (error instanceof Error) {
    if (error.name === "TimeoutError") return "Failed: request timed out";
    return `Failed: ${error.message}`;
  }
  return `Failed: ${String(error)}`;
}

async function boot(): Promise<void> {
  const audio = createAudio();
  const screen = createLoadingScreen(view, overlay);
  const loadLog: string[] = [];
  window.__loadLog = loadLog;
  const log = (text: string) => {
    loadLog.push(text);
    console.info("[load]", text);
  };
  const timeoutMs = Number(params.get("timeout") || 0) || undefined;
  const onRetry = ({
    key,
    attempt,
    delay,
    error,
  }: {
    key: string;
    attempt: number;
    delay: number;
    error: unknown;
  }) => {
    const kind = error instanceof Error ? error.name : "error";
    log(
      `retry ${key}: attempt ${attempt} failed (${kind}), next in ${Math.round(delay)} ms`,
    );
  };

  let manifest: Manifest | null = null;
  let assets: Assets | null = null;
  while (!assets) {
    const controller = new AbortController();
    const cancelOnEsc = (e: KeyboardEvent) => {
      if (e.code === "Escape") controller.abort();
    };
    window.addEventListener("keydown", cancelOnEsc);
    const started = performance.now();
    try {
      manifest ??= ManifestSchema.parse(
        await withRetry(
          () =>
            loadJson(devUrl("/assets/manifest.json"), {
              signal: controller.signal,
              timeoutMs,
            }),
          {
            signal: controller.signal,
            onRetry: (info) => onRetry({ key: "manifest", ...info }),
          },
        ),
      );
      assets = await loadAll(manifest, {
        ctx: audio.ctx,
        signal: controller.signal,
        sequential: params.get("loader") === "sequential",
        extra: injectedAssets(),
        timeoutMs,
        retry: {},
        onRetry,
        onProgress: (fraction, key) => screen.progress(fraction, key),
      });
      window.__loadMs = performance.now() - started;
      const failed = assets.failed.map((f) => `${f.key} (${describe(f.error)})`);
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

  // ?local keeps the lab 2 game: two players on one keyboard, no server match
  if (params.has("local")) {
    startGame({
      config: manifest?.arenas?.[room.arena] ?? {},
      sprites: assets.sprites,
      audio,
      name,
    });
    return;
  }

  const connection = new Connection({
    url: wsUrl(),
    room: room.id,
    name,
    codec: params.get("codec") === "json" ? "json" : "binary",
  });
  createChatView(document.body, connection, { roomName: room.name, selfName: name });
  window.__connection = connection;

  // the match starts when the server has put a ship in the world for us;
  // a refusal (room full, ...) ends the connection and the chat shows why
  const welcome = await new Promise<Extract<ServerMessage, { type: "welcome" }>>(
    (resolve) => {
      connection.on("message", (message) => {
        if (message.type === "welcome") resolve(message);
      });
    },
  );
  startNetGame({
    connection,
    welcome,
    view,
    hud,
    scoreboard,
    audio,
    sprites: assets.sprites,
    params,
  });
}

// experiments from lab 1 start right away, without assets and lobby
if (scenario || experiment) startGame({ config: {} });
else boot();
