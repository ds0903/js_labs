import { ARENA } from "shared/sim/arena";
import { commandInput, NET_CONTROLS } from "shared/sim/commands";
import { applyCommand, DT } from "shared/sim/match";
import { Ship } from "shared/sim/ship";
import { World } from "shared/sim/world";

// The local ship's id must not clash with the ids the local world hands out
// to bullets and particles, so it is shifted; the server's id is kept in netId.
const LOCAL_BASE = 2 ** 30;
const MAX_PENDING = 240; // 8 s of inputs; a longer silence means the link is gone
const SNAP_DISTANCE = 80; // a correction this big (a respawn) is not smoothed

// shortest vector from b to a on the wrapping arena
function wrappedDiff(a, b) {
  let dx = a.x - b.x;
  let dy = a.y - b.y;
  if (dx > ARENA.width / 2) dx -= ARENA.width;
  if (dx < -ARENA.width / 2) dx += ARENA.width;
  if (dy > ARENA.height / 2) dy -= ARENA.height;
  if (dy < -ARENA.height / 2) dy += ARENA.height;
  return { x: dx, y: dy };
}

// Client side prediction of the local ship, with server reconciliation.
// The local world holds the ship, its predicted bullets and the particles;
// every other entity comes from snapshots.
//   step(keys, tick)   one simulation step: makes the command, applies it at once
//   reconcile(me, ack) a snapshot arrived: restore, forget acked inputs, replay the rest
export function createPredictor({
  shipId,
  name = "you",
  color,
  sprite,
  smoothing = 0.35, // fraction of the visual error left after one step (~100 ms to vanish)
  noise = 0, // determinism experiment: a random error in the prediction, never in production
}) {
  const input = commandInput();
  const world = new World({ seed: 1 });
  const ship = new Ship({
    id: LOCAL_BASE + shipId,
    input,
    controls: NET_CONTROLS,
    name,
    color,
    sprite,
  });
  ship.alive = false; // placed in the world by the first snapshot
  let seq = 0;
  let pending = [];
  const offset = { x: 0, y: 0 }; // visual error left from the last correction

  return {
    ship,
    world,
    input,
    netId: shipId,
    offset,
    get pending() {
      return pending;
    },
    get seq() {
      return seq;
    },

    step(keys, tick = 0, { predict = true } = {}) {
      const cmd = {
        seq: ++seq,
        tick,
        thrust: keys.thrust,
        turn: keys.turn,
        fire: keys.fire,
      };
      pending.push(cmd);
      if (pending.length > MAX_PENDING) pending = pending.slice(-MAX_PENDING);

      if (predict && ship.alive) {
        applyCommand(ship, input, cmd);
        // the determinism experiment: Math.random() inside the prediction
        if (noise) ship.vel = ship.vel.scale(1 + (Math.random() - 0.5) * noise);
      }
      world.step(DT);

      // a homing bullet turns toward things the local world does not have:
      // the server's bullet is drawn instead
      for (const bullet of world.ofKind("bullet")) if (bullet.parts.homing) bullet.kill();

      offset.x *= smoothing;
      offset.y *= smoothing;
      return cmd;
    },

    // `me` is this ship's record in the snapshot, or undefined if it is dead.
    // Returns how far the prediction was from the server's truth, in arena units.
    reconcile(me, ack) {
      pending = pending.filter((cmd) => cmd.seq > ack);
      if (!me) {
        ship.kill();
        offset.x = offset.y = 0;
        return 0;
      }

      const before = ship.alive ? { x: ship.pos.x, y: ship.pos.y } : null;
      ship.restore(me);
      if (!world.get(ship.id)) world.spawn(ship);

      // Replay what the server has not seen yet. It runs in a throw-away world:
      // a replayed shot must not spawn a second bullet or play a second sound,
      // and each step starts with snapshot() so interpolation has a real
      // previous state.
      const real = ship.world;
      ship.world = new World();
      ship.snapshot();
      for (const cmd of pending) {
        applyCommand(ship, input, cmd);
        ship.snapshot();
        ship.update(DT);
      }
      ship.world = real;

      if (!before) return 0;
      const error = wrappedDiff(before, ship.pos);
      const magnitude = Math.hypot(error.x, error.y);
      if (magnitude > SNAP_DISTANCE) {
        offset.x = offset.y = 0;
      } else {
        offset.x += error.x;
        offset.y += error.y;
      }
      return magnitude;
    },

    // Local bullets are the prediction of bullets the server owns. Once the
    // server has processed the input that fired one (seq <= ack) its own
    // bullet is in the snapshot; if it is not, that bullet is already gone
    // (it hit something), so the local copy must go too.
    // Returns the set of srcSeq values (16 bit) of server bullets of this ship.
    pruneBullets(entities, ack) {
      const serverSeqs = new Set();
      for (const e of entities) {
        if (e.kind === "bullet" && e.owner === shipId) serverSeqs.add(e.srcSeq);
      }
      for (const bullet of world.ofKind("bullet")) {
        if (bullet.srcSeq <= ack && !serverSeqs.has(bullet.srcSeq & 0xffff))
          bullet.kill();
      }
      return serverSeqs;
    },

    hasLocalBullet(srcSeq16) {
      for (const bullet of world.ofKind("bullet")) {
        if ((bullet.srcSeq & 0xffff) === srcSeq16 && bullet.alive) return true;
      }
      return false;
    },
  };
}
