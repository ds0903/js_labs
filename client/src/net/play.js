import { explode } from "shared/sim/entities";
import { DT } from "shared/sim/match";
import { Vector2 } from "shared/sim/vector";
import { createInput } from "../input.js";
import { createLoop } from "../loop.js";
import { drawScene } from "../render/draw.js";
import { createInterpolator } from "./interp.js";
import { createNetStats, netgraphLines } from "./netgraph.js";
import { createPredictor } from "./predict.js";

const NETSIM_PRESETS = [
  { label: "off", latency: 0, jitter: 0, drop: 0 },
  { label: "100 ms +-30, 2% loss", latency: 100, jitter: 30, drop: 2 },
  { label: "200 ms +-50, 5% loss", latency: 200, jitter: 50, drop: 5 },
];

const KEYS = {
  left: ["ArrowLeft", "KeyA"],
  right: ["ArrowRight", "KeyD"],
  thrust: ["ArrowUp", "KeyW"],
  fire: ["Space", "KeyF"],
};

const partsOf = (s) => {
  if (s.kind === "pickup") return { pickup: { effect: s.effect } };
  return s.homing === true || s.hunter ? { homing: true } : {};
};

// The online game: inputs go up, snapshots come down.
//   - the local ship is predicted and reconciled (predict.js)
//   - everything else is interpolated in the past (interp.js)
//   - the netgraph shows what the network is doing (netgraph.js)
export function startNetGame({
  connection,
  welcome,
  view,
  hud,
  scoreboard,
  audio,
  sprites,
  params,
}) {
  const input = createInput();
  const interp = createInterpolator({
    intervalMs: 1000 / welcome.tickRate,
    delayMs: Number(params.get("delay") || 100),
  });
  const stats = createNetStats();
  const roster = new Map(); // ship id -> { name, sprite, color }
  const noise = Number(params.get("breakdet") || 0);
  let predict = params.get("predict") !== "0";
  let netsimIndex = 0;
  let predictor = null;
  let latest = null; // newest snapshot
  let message = "";
  let messageUntil = 0;
  let lastHud = 0;

  const note = (players) => {
    for (const p of players) {
      if (p.ship !== undefined) roster.set(p.ship, p);
    }
  };

  function useWelcome(w) {
    note(w.players);
    const me = roster.get(w.ship);
    predictor = createPredictor({
      shipId: w.ship,
      name: me?.name,
      color: me?.color,
      sprite: me?.sprite,
      noise,
    });
    // the shot sounds the moment the key is pressed, not when the server confirms
    predictor.world.addEventListener("fired", () =>
      audio?.play("shoot", { rate: 0.95 + Math.random() * 0.1 }),
    );
  }
  useWelcome(welcome);

  const say = (text) => {
    message = text;
    messageUntil = performance.now() + 2500;
  };

  // ---- from the server
  connection.addEventListener("message", ({ detail: m }) => {
    if (m.type === "welcome")
      useWelcome(m); // after a reconnect the ship is a new one
    else if (m.type === "roster") note(m.players);
    else if (m.type === "pong") stats.onPong(performance.now() - m.t);
    else if (m.type === "event") onEvent(m);
  });

  connection.addEventListener("snapshot", ({ detail: { snap, at } }) => {
    latest = snap;
    interp.push(snap, at);
    stats.onSnapshot(at, snap.tick);
    const me = snap.entities.find((e) => e.kind === "ship" && e.id === predictor.netId);
    const magnitude = predictor.reconcile(me, snap.ack);
    if (predict && me) stats.onCorrection(magnitude);
    predictor.pruneBullets(snap.entities, snap.ack);
  });

  const nameOf = (id) => roster.get(id)?.name ?? `ship ${id}`;

  function onEvent(m) {
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
    }
  }

  // ---- to the server
  const keys = () => {
    const down = (list) => list.some((code) => input.isDown(code));
    return {
      thrust: down(KEYS.thrust),
      turn: (down(KEYS.right) ? 1 : 0) - (down(KEYS.left) ? 1 : 0),
      // a tap shorter than one step must still count
      fire: KEYS.fire.some((code) => input.isDown(code) || input.justPressed(code)),
    };
  };

  function simulate() {
    const cmd = predictor.step(keys(), interp.latestTick, { predict });
    connection.sendInput(cmd);
    input.endStep();
  }

  const pinger = setInterval(
    () => connection.send({ type: "ping", t: performance.now() }),
    1000,
  );

  // ---- drawing
  function shipView(ship, offset) {
    const shift = (v) => ({ x: v.x + offset.x, y: v.y + offset.y });
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
      effects: ship.effects,
      sprite: ship.sprite,
      color: ship.color,
      parts: {},
    };
  }

  function remoteView(s) {
    const pos = { x: s.x, y: s.y };
    const info = s.kind === "ship" ? roster.get(s.id) : undefined;
    return {
      id: s.id,
      kind: s.kind,
      pos,
      prevPos: pos,
      angle: s.angle,
      prevAngle: s.angle,
      radius: s.radius,
      thrusting: s.thrusting,
      grace: s.grace ?? 0,
      effects: { shield: s.shield ?? 0 },
      sprite: info?.sprite ?? "ship1",
      color: info?.color ?? "#cfe3ff",
      parts: partsOf(s),
    };
  }

  function buildScene(now) {
    const scene = [];
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
        if (predict && e.alive) scene.push(shipView(e, predictor.offset));
      } else if (predict || e.kind !== "bullet") {
        scene.push(e);
      }
    }
    return scene;
  }

  function scoreText() {
    if (!latest) return "";
    const lines = latest.entities
      .filter((e) => e.kind === "ship")
      .map((e) => `${nameOf(e.id)}  hp ${String(e.hp).padStart(3)}  score ${e.score}`);
    return lines.join("\n");
  }

  function render(alpha) {
    const now = performance.now();
    drawScene(view, buildScene(now), alpha, now, sprites);

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
          : NETSIM_PRESETS[netsimIndex].label,
      }).join("\n");
      const text = scoreText();
      scoreboard.textContent = now < messageUntil ? `${text}\n\n${message}` : text;
    }
  }

  // ---- keys for the experiments
  function onKey(event) {
    if (event.target?.matches?.("input, textarea, select")) return;
    if (event.code === "BracketLeft") interp.delayMs = Math.max(0, interp.delayMs - 16);
    else if (event.code === "BracketRight")
      interp.delayMs = Math.min(500, interp.delayMs + 16);
    else if (event.code === "KeyP") {
      predict = !predict;
      stats.resetMax();
    } else if (event.code === "KeyL" && welcome.netsim) {
      netsimIndex = (netsimIndex + 1) % NETSIM_PRESETS.length;
      const { latency, jitter, drop } = NETSIM_PRESETS[netsimIndex];
      connection.send({ type: "netsim", latency, jitter, drop });
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
