import assert from "node:assert/strict";
import { test } from "node:test";
import { applyCommand, createMatch, DT } from "shared/sim/match";
import { describe, id16 } from "shared/sim/snapshot";
import { Vector2 } from "shared/sim/vector";
import { createInterpolator } from "../src/net/interp.js";
import { createNetStats, netgraphLines } from "../src/net/netgraph.js";
import { createPredictor } from "../src/net/predict.js";

// ---------- a tiny fake network around the shared simulation ----------

const keysAt = (step) => ({
  thrust: step % 40 < 28,
  turn: (Math.floor(step / 12) % 3) - 1,
  fire: false,
});

// The server side of a test: the authoritative world and a ship, fed the
// client's commands `lag` steps late, one per tick like the real Match.
function rig({ lag = 4, noise = 0, onServerTick } = {}) {
  const sim = createMatch({ arena: "duel", seed: 3 });
  const server = sim.addShip(0, "A");
  const netId = id16(server.ship.id);
  const predictor = createPredictor({ shipId: netId, noise });
  const queue = [];
  let ack = 0;
  const errors = [];

  // the client learns the starting state from the first snapshot
  predictor.reconcile(describe(server.ship), 0);

  function run(steps, { snapshotEvery = 3, keys = keysAt } = {}) {
    for (let step = 0; step < steps; step++) {
      queue.push({ cmd: predictor.step(keys(step), 0), due: step + lag });
      const next = queue[0];
      if (next && next.due <= step) {
        queue.shift();
        applyCommand(server.ship, server.input, next.cmd);
        server.ship.idle = false;
        ack = next.cmd.seq;
      } else {
        server.ship.idle = true;
      }
      onServerTick?.(server, step);
      sim.world.step(DT);

      if (step % snapshotEvery === 0) {
        errors.push(predictor.reconcile(describe(server.ship), ack));
      }
    }
    return errors;
  }
  return { predictor, server, run, errors };
}

test("prediction that matches the server gives a correction of zero", () => {
  const { run, predictor } = rig();
  const errors = run(45);
  assert.ok(errors.length >= 10);
  assert.ok(Math.max(...errors) < 1e-6, `largest correction ${Math.max(...errors)}`);
  assert.ok(predictor.ship.vel.length() > 50, "the ship really moved");
});

test("a snapshot drops the acknowledged inputs and keeps the rest", () => {
  const { predictor, run } = rig({ lag: 6 });
  run(30, { snapshotEvery: 1 });
  const seqs = predictor.pending.map((c) => c.seq);
  assert.ok(seqs.length >= 5 && seqs.length <= 8, `pending ${seqs.length}`);
  assert.deepEqual(
    seqs,
    [...seqs].sort((a, b) => a - b),
  );
  assert.equal(seqs.at(-1), predictor.seq);
});

test("when the server disagrees the error is measured, then smoothed away", () => {
  const { run, predictor, server } = rig();
  run(20);
  // a hit the client could not know about: a shove of 150 px/s
  server.ship.vel = server.ship.vel.add(new Vector2(150, 0));
  const jump = run(6, { snapshotEvery: 1 });
  const biggest = Math.max(...jump.slice(-6));
  assert.ok(biggest > 1, `correction after the shove: ${biggest}`);

  // keep running without new surprises: the visual offset shrinks to nothing
  const offsets = [];
  for (let i = 0; i < 6; i++) {
    predictor.step(keysAt(100 + i), 0);
    offsets.push(Math.hypot(predictor.offset.x, predictor.offset.y));
  }
  assert.ok(
    offsets[5] < offsets[0] * 0.05 + 1e-9,
    `offsets ${offsets.map((o) => o.toFixed(3))}`,
  );
});

test("a huge correction (a respawn) is not smoothed", () => {
  const { run, predictor, server } = rig();
  run(10);
  server.ship.pos = new Vector2(
    (server.ship.pos.x + 700) % 1600,
    (server.ship.pos.y + 400) % 900,
  );
  run(4, { snapshotEvery: 1 });
  assert.equal(predictor.offset.x, 0);
  assert.equal(predictor.offset.y, 0);
});

test("breaking determinism on purpose makes the corrections grow", () => {
  const clean = rig({ noise: 0 }).run(90, { snapshotEvery: 1 });
  const broken = rig({ noise: 0.2 }).run(90, { snapshotEvery: 1 });
  const mean = (list) => list.reduce((a, b) => a + b, 0) / list.length;
  assert.ok(mean(clean) < 1e-6);
  assert.ok(mean(broken) > 0.2, `mean correction with noise: ${mean(broken)}`);
});

test("a ship that is dead on the server disappears locally and returns on respawn", () => {
  const { predictor, server } = rig();
  predictor.reconcile(undefined, 0);
  assert.equal(predictor.ship.alive, false);
  predictor.reconcile(describe(server.ship), 0);
  assert.equal(predictor.ship.alive, true);
  assert.ok(predictor.world.get(predictor.ship.id));
});

test("a predicted bullet stays while the server has the same one and goes when it does not", () => {
  const { predictor, server } = rig();
  const cmd = predictor.step({ thrust: false, turn: 0, fire: true }, 0);
  assert.equal(predictor.hasLocalBullet(cmd.seq & 0xffff), true);

  // the server has not processed the input yet: keep the bullet
  predictor.pruneBullets([], cmd.seq - 1);
  assert.equal(predictor.hasLocalBullet(cmd.seq & 0xffff), true);

  // processed, and the server's own bullet is there: keep
  const theirs = {
    kind: "bullet",
    owner: id16(server.ship.id),
    srcSeq: cmd.seq & 0xffff,
  };
  predictor.pruneBullets([theirs], cmd.seq);
  assert.equal(predictor.hasLocalBullet(cmd.seq & 0xffff), true);

  // processed and gone from the snapshot (it hit something): remove
  predictor.pruneBullets([], cmd.seq);
  assert.equal(predictor.hasLocalBullet(cmd.seq & 0xffff), false);
});

test("replaying inputs after a snapshot does not spawn bullets or events again", () => {
  const { predictor, server } = rig();
  let fired = 0;
  predictor.world.addEventListener("fired", () => fired++);
  for (let i = 0; i < 14; i++) {
    predictor.step({ thrust: true, turn: 0, fire: i === 2 || i === 12 }, 0);
  }
  assert.equal(fired, 2);
  const bullets = () => [...predictor.world.ofKind("bullet")].length;
  const before = bullets();
  for (let i = 0; i < 5; i++) predictor.reconcile(describe(server.ship), 0); // all 14 inputs replayed
  assert.equal(fired, 2);
  assert.equal(bullets(), before);
});

test("the cooldown makes a held fire key shoot once, not every step", () => {
  const { predictor } = rig();
  for (let i = 0; i < 6; i++) predictor.step({ thrust: false, turn: 0, fire: true }, 0);
  assert.equal([...predictor.world.ofKind("bullet")].length, 1);
});

// ---------- interpolation ----------

const snapOf = (tick, entities) => ({ tick, ack: 0, entities });
const rock = (x, y = 100, id = 1) => ({
  id,
  kind: "asteroid",
  x,
  y,
  vx: 0,
  vy: 0,
  angle: 0,
  radius: 20,
});

function filled(delayMs = 100) {
  const interp = createInterpolator({ intervalMs: 100, delayMs });
  interp.push(snapOf(0, [rock(0)]), 1000);
  interp.push(snapOf(1, [rock(100)]), 1100);
  interp.push(snapOf(2, [rock(200)]), 1200);
  interp.push(snapOf(3, [rock(300)]), 1300);
  return interp;
}

test("interpolation draws between the two snapshots around now minus the delay", () => {
  const interp = filled();
  // tick 1.5 at now = 1000 + 150 + delay 100 = 1250
  assert.ok(Math.abs(interp.sample(1250)[0].x - 150) < 1e-9);
  assert.ok(Math.abs(interp.sample(1300)[0].x - 200) < 1e-9);
  assert.ok(Math.abs(interp.sample(1325)[0].x - 225) < 1e-9);
});

test("interpolation takes the short way across the arena edge", () => {
  const interp = createInterpolator({ intervalMs: 100, delayMs: 0 });
  interp.push(snapOf(0, [rock(1590)]), 0);
  interp.push(snapOf(1, [rock(10)]), 100);
  const x = interp.sample(50)[0].x;
  assert.ok(x > 1595 || x < 5, `x = ${x}`);
});

test("interpolation takes the short way round for angles", () => {
  const interp = createInterpolator({ intervalMs: 100, delayMs: 0 });
  interp.push(snapOf(0, [{ ...rock(0), angle: 3.1 }]), 0);
  interp.push(snapOf(1, [{ ...rock(0), angle: -3.1 }]), 100);
  const angle = interp.sample(50)[0].angle;
  assert.ok(Math.abs(Math.abs(angle) - Math.PI) < 0.1, `angle ${angle}`);
});

test("an entity that appears or disappears between snapshots is handled", () => {
  const interp = createInterpolator({ intervalMs: 100, delayMs: 0 });
  interp.push(snapOf(0, [rock(0, 100, 1), rock(50, 100, 2)]), 0);
  interp.push(snapOf(1, [rock(100, 100, 1), rock(500, 300, 3)]), 100);
  const ids = interp
    .sample(50)
    .map((e) => e.id)
    .sort();
  assert.deepEqual(ids, [1, 2, 3]); // 2 is still there, 3 has appeared
  const later = createInterpolator({ intervalMs: 100, delayMs: 0 });
  later.push(snapOf(0, [rock(0, 100, 1), rock(50, 100, 2)]), 0);
  later.push(snapOf(1, [rock(100, 100, 1)]), 100);
  later.push(snapOf(2, [rock(200, 100, 1)]), 200);
  assert.deepEqual(
    later.sample(150).map((e) => e.id),
    [1],
  ); // 2 is gone once the window moved on
});

test("with no newer snapshot it extrapolates a little, then stops", () => {
  const interp = createInterpolator({ intervalMs: 100, delayMs: 0, extrapolateMs: 120 });
  interp.push(snapOf(0, [{ ...rock(100), vx: 100 }]), 0);
  assert.equal(interp.sample(0)[0].x, 100);
  interp.push(snapOf(1, [{ ...rock(110), vx: 100 }]), 100);
  assert.ok(Math.abs(interp.sample(160)[0].x - 116) < 1e-9); // 60 ms at 100 px/s
  assert.ok(Math.abs(interp.sample(2000)[0].x - 122) < 1e-9); // capped at 120 ms
});

test("the clock follows the fastest snapshots, so one late packet does not shift the picture", () => {
  const interp = createInterpolator({ intervalMs: 100, delayMs: 100 });
  interp.push(snapOf(0, [rock(0)]), 1000);
  interp.push(snapOf(1, [rock(100)]), 1100);
  const before = interp.renderTick(1500);
  interp.push(snapOf(2, [rock(200)]), 1290); // 90 ms late
  assert.ok(
    Math.abs(interp.renderTick(1500) - before) < 0.06,
    "a late packet moves the clock by only a little",
  );
  interp.push(snapOf(3, [rock(300)]), 1290 + 10); // back on time
  assert.ok(Math.abs(interp.renderTick(1500) - before) < 0.06);
});

test("old and duplicate snapshots are ignored, and the buffer is bounded", () => {
  const interp = filled();
  interp.push(snapOf(2, [rock(999)]), 5000);
  assert.equal(interp.size, 4);
  for (let tick = 4; tick < 200; tick++)
    interp.push(snapOf(tick, [rock(tick)]), 1000 + tick * 100);
  assert.ok(interp.size <= 45);
});

test("nothing is drawn before the first snapshot", () => {
  assert.deepEqual(createInterpolator().sample(1000), []);
});

// ---------- netgraph numbers ----------

test("netgraph: byte rates, snapshot gaps, rtt and correction averages", () => {
  const stats = createNetStats();
  stats.sampleBytes(0, 0, 0);
  stats.sampleBytes(1000, 20480, 5120);
  stats.onPong(100);
  stats.onPong(200);
  stats.onSnapshot(1000, 10);
  stats.onSnapshot(1033, 11);
  stats.onSnapshot(1100, 12);
  stats.onCorrection(1);
  stats.onCorrection(3);
  const s = stats.snapshot(1150);
  assert.equal(s.inKBs, 20);
  assert.equal(s.outKBs, 5);
  assert.equal(s.rtt, 120); // moving average: 100 + (200 - 100) * 0.2
  assert.equal(s.snapshotAge, 50);
  assert.equal(s.gapMax, 67);
  assert.equal(s.tick, 12);
  assert.equal(s.correctionAvg, 2);
  assert.equal(s.correctionMax, 3);
  const text = netgraphLines(s, {
    pending: 4,
    delayMs: 100,
    predict: true,
    codec: "binary",
    netsim: "off",
  });
  assert.ok(text.some((line) => line.includes("rtt") && line.includes("120")));
  assert.ok(text.some((line) => line.includes("pending") && line.includes("4")));
});
