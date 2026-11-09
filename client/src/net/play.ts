import { type EntityId, tick } from "shared/brand";
import type {
  PlayerInfo,
  ServerMessage,
  ShipRecord,
  Snapshot,
  SnapshotEntity,
} from "shared/protocol";
import { explode } from "shared/sim/entities";
import { DT } from "shared/sim/match";
import { Vector2 } from "shared/sim/vector";
import type { Audio } from "../audio.ts";
import { isTypingTarget } from "../dom.ts";
import { createInput } from "../input.ts";
import { createLoop } from "../loop.ts";
import { timed } from "../perf.ts";
import type { View } from "../render/canvas.ts";
import { type Drawable, drawableOf, drawScene, type Sprites } from "../render/draw.ts";
import type { Connection } from "./connection.ts";
import { createInterpolator } from "./interp.ts";
import { createNetStats, netgraphLines } from "./netgraph.ts";
import { createPredictor, type Keys, type Predictor } from "./predict.ts";

const NETSIM_PRESETS = [
  { label: "off", latency: 0, jitter: 0, drop: 0 },
  { label: "100 ms +-30, 2% loss", latency: 100, jitter: 30, drop: 2 },
  { label: "200 ms +-50, 5% loss", latency: 200, jitter: 50, drop: 5 },
] as const;

const KEYS = {
  left: ["ArrowLeft", "KeyA"],
  right: ["ArrowRight", "KeyD"],
  thrust: ["ArrowUp", "KeyW"],
  fire: ["Space", "KeyF"],
} as const;

type Welcome = Extract<ServerMessage, { type: "welcome" }>;
type GameEvent = Extract<ServerMessage, { type: "event" }>;

export interface NetGameOptions {
  connection: Connection;
  welcome: Welcome;
  view: View;
  hud: HTMLElement;
  scoreboard: HTMLElement;
  audio: Audio | undefined;
  sprites: Sprites;
  params: URLSearchParams;
}

const isShipRecord = (e: SnapshotEntity): e is ShipRecord => e.kind === "ship";

// The online game: inputs go up, snapshots come down.
//   - the local ship is predicted and reconciled (predict.ts)
//   - everything else is interpolated in the past (interp.ts)
//   - the netgraph shows what the network is doing (netgraph.ts)
export function startNetGame({
  connection,
  welcome,
  view,
  hud,
  scoreboard,
  audio,
  sprites,
  params,
}: NetGameOptions) {
  const input = createInput();
  const interp = createInterpolator({
    intervalMs: 1000 / welcome.tickRate,
    delayMs: Number(params.get("delay") || 100),
  });
  const stats = createNetStats();
  const roster = new Map<EntityId, PlayerInfo>(); // ship id -> who flies it
  const noise = Number(params.get("breakdet") || 0);
  let predict = params.get("predict") !== "0";
  let netsimIndex = 0;
  let latest: Snapshot | null = null; // newest snapshot
  let message = "";
  let messageUntil = 0;
  let lastHud = 0;

  const note = (players: readonly PlayerInfo[]) => {
    for (const p of players) {
      if (p.ship !== undefined) roster.set(p.ship, p);
    }
  };

  // the predictor is made again for every welcome: after a reconnect the ship is a new one
  function makePredictor(w: Welcome): Predictor {
    note(w.players);
    const me = roster.get(w.ship);
    const made = createPredictor({
      shipId: w.ship,
      name: me?.name,
      color: me?.color,
      sprite: me?.sprite,
      noise,
    });
    // the shot sounds the moment the key is pressed, not when the server confirms
    made.world.on("fired", () =>
      audio?.play("shoot", { rate: 0.95 + Math.random() * 0.1 }),
    );
    return made;
  }
  let predictor = makePredictor(welcome);

  const say = (text: string) => {
    message = text;
    messageUntil = performance.now() + 2500;
  };

  // ---- from the server
  connection.on("message", (m) => {
    switch (m.type) {
      case "welcome":
        predictor = makePredictor(m);
        break;
      case "roster":
        note(m.players);
        break;
      case "pong":
        stats.onPong(performance.now() - m.t);
        break;
      case "chat":
        break; // the chat view shows it
      default:
        onEvent(m);
    }
  });

  connection.on("snapshot", ({ snap, at }) => {
    latest = snap;
    interp.push(snap, at);
    stats.onSnapshot(at, snap.tick);
    const me = snap.entities.find(
      (e): e is ShipRecord => isShipRecord(e) && e.id === predictor.netId,
    );
    const magnitude = timed("reconcile", () => predictor.reconcile(me, snap.ack));
    if (predict && me) stats.onCorrection(magnitude);
    predictor.pruneBullets(snap.entities, snap.ack);
  });

  const nameOf = (id: EntityId) => roster.get(id)?.name ?? `ship ${id}`;

  function onEvent(m: GameEvent): void {
    switch (m.name) {
      case "fired":
        // my own shot already played when I pressed the key
        if (!(predict && m.ship === predictor.netId)) audio?.play("shoot");
        break;
      case "hit":
        audio?.play("hit");
        break;
      case "exploded":
        audio?.play("explosion", { volume: 0.6 });
        explode(
          predictor.world,
          new Vector2(m.x, m.y),
          m.color,
          m.kind === "ship" ? 36 : 18,
        );
        if (m.kind === "ship") say(`${nameOf(m.id)} destroyed`);
        break;
      case "pickup":
        say(`${nameOf(m.ship)} picked up ${m.effect}`);
        break;
      case "respawned":
        break;
      default:
        assertNever(m);
    }
  }

  // ---- to the server
  const keys = (): Keys => {
    const down = (list: readonly string[]) => list.some((code) => input.isDown(code));
    const left = down(KEYS.left);
    const right = down(KEYS.right);
    return {
      thrust: down(KEYS.thrust),
      turn: left === right ? 0 : right ? 1 : -1,
      // a tap shorter than one step must still count
      fire: KEYS.fire.some((code) => input.isDown(code) || input.justPressed(code)),
    };
  };

  function simulate(): void {
    const cmd = timed("simulate", () =>
      predictor.step(keys(), tick(interp.latestTick), { predict }),
    );
    connection.sendInput(cmd);
    input.endStep();
  }

  const pinger = setInterval(
    () => connection.send({ type: "ping", t: performance.now() }),
    1000,
  );

  // ---- drawing
  function shipView(ship: Predictor["ship"], offset: { x: number; y: number }): Drawable {
    const shift = (v: { x: number; y: number }) => ({
      x: v.x + offset.x,
      y: v.y + offset.y,
    });
    return {
      id: ship.id,
      kind: "ship",
      pos: shift(ship.pos),
      prevPos: shift(ship.prevPos),
      angle: ship.angle,
      prevAngle: ship.prevAngle,
      radius: ship.radius,
      thrusting: ship.thrusting,
      grace: ship.grace,
      shield: ship.effects.shield,
      sprite: ship.sprite,
      color: ship.color,
    };
  }

  // an entity from a snapshot as something drawable (it has no previous state)
  function remoteView(s: SnapshotEntity): Drawable {
    const pos = { x: s.x, y: s.y };
    const base = {
      id: s.id,
      pos,
      prevPos: pos,
      angle: s.angle,
      prevAngle: s.angle,
      radius: s.radius,
    };
    switch (s.kind) {
      case "ship": {
        const info = roster.get(s.id);
        return {
          ...base,
          kind: "ship",
          thrusting: s.thrusting,
          grace: s.grace,
          shield: s.shield,
          sprite: info?.sprite ?? "ship1",
          color: info?.color ?? "#cfe3ff",
        };
      }
      case "bullet":
        return { ...base, kind: "bullet", homing: s.homing };
      case "asteroid":
        return { ...base, kind: "asteroid", hunter: s.hunter };
      case "pickup":
        return { ...base, kind: "pickup", effect: s.effect };
      default:
        return assertNever(s);
    }
  }

  function buildScene(now: number): Drawable[] {
    const scene: Drawable[] = [];
    for (const s of interp.sample(now)) {
      if (predict && s.kind === "ship" && s.id === predictor.netId) continue;
      // my own bullet is drawn from the local copy while there is one
      if (
        predict &&
        s.kind === "bullet" &&
        s.owner === predictor.netId &&
        predictor.hasLocalBullet(s.srcSeq)
      ) {
        continue;
      }
      scene.push(remoteView(s));
    }
    for (const e of predictor.world) {
      if (e === predictor.ship) {
        if (predict && e.alive) scene.push(shipView(predictor.ship, predictor.offset));
      } else if (predict || e.kind !== "bullet") {
        const drawable = drawableOf(e);
        if (drawable) scene.push(drawable);
      }
    }
    return scene;
  }

  function scoreText(): string {
    if (!latest) return "";
    return latest.entities
      .filter(isShipRecord)
      .map((e) => `${nameOf(e.id)}  hp ${String(e.hp).padStart(3)}  score ${e.score}`)
      .join("\n");
  }

  function render(alpha: number): void {
    const now = performance.now();
    timed("render", () => drawScene(view, buildScene(now), alpha, now, sprites));

    if (now - lastHud > 100) {
      lastHud = now;
      stats.sampleBytes(now, connection.bytesIn, connection.bytesOut);
      hud.textContent = netgraphLines(stats.snapshot(now), {
        pending: predictor.pending.length,
        delayMs: Math.round(interp.delayMs),
        predict,
        codec: connection.codecName,
        netsim: params.has("lat")
          ? "from the address"
          : (NETSIM_PRESETS[netsimIndex]?.label ?? "off"),
      }).join("\n");
      const text = scoreText();
      scoreboard.textContent = now < messageUntil ? `${text}\n\n${message}` : text;
    }
  }

  // ---- keys for the experiments
  function onKey(event: KeyboardEvent): void {
    if (isTypingTarget(event.target)) return;
    if (event.code === "BracketLeft") interp.delayMs = Math.max(0, interp.delayMs - 16);
    else if (event.code === "BracketRight")
      interp.delayMs = Math.min(500, interp.delayMs + 16);
    else if (event.code === "KeyP") {
      predict = !predict;
      stats.resetMax();
    } else if (event.code === "KeyL" && welcome.netsim) {
      netsimIndex = (netsimIndex + 1) % NETSIM_PRESETS.length;
      const preset = NETSIM_PRESETS[netsimIndex];
      if (!preset) return;
      connection.send({
        type: "netsim",
        latency: preset.latency,
        jitter: preset.jitter,
        drop: preset.drop,
      });
      stats.resetMax();
    }
  }
  window.addEventListener("keydown", onKey);

  const loop = createLoop({ step: DT, simulate, render });
  loop.start();

  // handles for measuring from the browser console
  window.__net = {
    stats,
    interp,
    connection,
    get predictor() {
      return predictor;
    },
    get latest() {
      return latest;
    },
  };

  return {
    loop,
    stop() {
      loop.stop();
      clearInterval(pinger);
      input.dispose();
      window.removeEventListener("keydown", onKey);
    },
  };
}

// the compiler complains here when a new event or entity kind has no case above
function assertNever(value: never): never {
  throw new Error(`unhandled ${JSON.stringify(value)}`);
}
