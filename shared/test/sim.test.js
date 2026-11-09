import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { CommandSchema } from "shared/protocol";
import { NEUTRAL } from "shared/sim/commands";
import { applyCommand, createMatch, DT } from "shared/sim/match";
import { runScripted, stateHash } from "shared/sim/replay";
import { describe, id16, normalizeAngle, snapshotWorld } from "shared/sim/snapshot";
import { test } from "vitest";

// Changing the simulation changes this number. That is the point: the client
// and the server must agree, so a change has to be made on purpose.
const GOLDEN_1000_STEPS = 2394282127;

test("the shared simulation imports in Node and touches no DOM or Node API", () => {
  assert.equal(typeof document, "undefined");
  assert.equal(typeof window, "undefined");
  const dir = new URL("../src/", import.meta.url);
  const files = [];
  for (const entry of readdirSync(dir, { recursive: true })) {
    if (entry.endsWith(".ts")) files.push(entry);
  }
  assert.ok(files.length > 10);
  for (const file of files) {
    const source = readFileSync(new URL(file, dir), "utf8");
    assert.doesNotMatch(
      source,
      /\b(document|window|localStorage|requestAnimationFrame)\b/,
      file,
    );
    assert.doesNotMatch(source, /from "node:|require\(|process\./, file);
    // determinism: no clock, no Math.random in the simulation
    assert.doesNotMatch(source, /Math\.random|Date\.now|performance\.now/, file);
  }
});

test("same inputs give the same hash, a different seed does not", () => {
  const a = runScripted(1000);
  assert.equal(a, runScripted(1000));
  assert.equal(a, GOLDEN_1000_STEPS);
  assert.notEqual(a, runScripted(1000, { seed: 8 }));
  assert.notEqual(a, runScripted(999));
});

test("a stray Math.random in the simulation changes the hash", () => {
  const run = (noise) => {
    const m = createMatch({ seed: 7 });
    const s = m.addShip(0, "A");
    for (let i = 0; i < 100; i++) {
      applyCommand(s.ship, s.input, { ...NEUTRAL, seq: i + 1, thrust: true });
      if (noise) s.ship.vel = s.ship.vel.add(s.ship.vel.scale(Math.random() * 1e-9));
      m.world.step(DT);
    }
    return stateHash(m.world);
  };
  assert.equal(run(false), run(false));
  assert.notEqual(run(true), run(true)); // the bug: two runs of the same inputs differ
});

test("snapshot of a world describes ships, bullets, asteroids and pickups, not particles", () => {
  const { world, addShip } = createMatch({ arena: "classic", seed: 3 });
  const { ship, input } = addShip(0, "A");
  applyCommand(ship, input, { ...NEUTRAL, seq: 5, fire: true });
  for (let i = 0; i < 10; i++) world.step(DT);

  const snap = snapshotWorld(world, 10, 5);
  assert.equal(snap.tick, 10);
  assert.equal(snap.ack, 5);
  const kinds = new Set(snap.entities.map((e) => e.kind));
  assert.ok(kinds.has("ship") && kinds.has("asteroid") && kinds.has("bullet"));
  assert.ok(!kinds.has("particle"));

  const me = snap.entities.find((e) => e.kind === "ship");
  assert.equal(me.id, id16(ship.id));
  assert.equal(me.hp, 100);
  // plain data: survives structuredClone and JSON unchanged
  assert.deepEqual(structuredClone(snap), snap);
  assert.deepEqual(JSON.parse(JSON.stringify(snap)), snap);

  for (let i = 0; i < 90; i++) world.step(DT); // pickups appear after 2 s
  const later = snapshotWorld(world, 100);
  assert.ok(later.entities.some((e) => e.kind === "pickup"));
  assert.ok(later.entities.every((e) => e.kind !== "particle"));
});

test("a fired bullet remembers the input that fired it", () => {
  const { world, addShip } = createMatch({ arena: "duel", seed: 3 });
  const { ship, input } = addShip(0, "A");
  applyCommand(ship, input, { ...NEUTRAL, seq: 42, fire: true });
  world.step(DT);
  const bullet = [...world.ofKind("bullet")][0];
  assert.equal(describe(bullet).srcSeq, 42);
  assert.equal(describe(bullet).owner, id16(ship.id));
});

test("restore puts a ship into the state a snapshot describes", () => {
  const { world, addShip } = createMatch({ arena: "duel", seed: 3 });
  const { ship, input } = addShip(0, "A");
  for (let i = 0; i < 20; i++) {
    applyCommand(ship, input, { ...NEUTRAL, seq: i + 1, thrust: true, turn: 1 });
    world.step(DT);
  }
  const state = describe(ship);

  const other = createMatch({ arena: "duel", seed: 99 });
  const copy = other.addShip(1, "copy");
  copy.ship.restore(state);
  assert.equal(copy.ship.pos.x, state.x);
  assert.equal(copy.ship.vel.y, state.vy);
  assert.equal(copy.ship.hp, state.hp);
  assert.equal(copy.ship.cooldown, state.cooldown);
});

test("an idle ship does not move, which keeps client replay exact", () => {
  const { world, addShip } = createMatch({ arena: "duel", seed: 3 });
  const { ship, input } = addShip(0, "A");
  applyCommand(ship, input, { ...NEUTRAL, seq: 1, thrust: true });
  world.step(DT);
  const { x, y } = ship.pos;
  ship.idle = true;
  world.step(DT);
  assert.deepEqual({ x: ship.pos.x, y: ship.pos.y }, { x, y });
});

test("CommandSchema rejects anything a legitimate client cannot send", () => {
  const checkCommand = (cmd) => (CommandSchema.safeParse(cmd).success ? null : "bad");
  assert.equal(checkCommand({ ...NEUTRAL, seq: 1 }), null);
  for (const bad of [
    null,
    "x",
    { ...NEUTRAL, turn: 1000 },
    { ...NEUTRAL, turn: 0.5 },
    { ...NEUTRAL, seq: -1 },
    { ...NEUTRAL, seq: 1.5 },
    { ...NEUTRAL, tick: 2 ** 32 },
    { ...NEUTRAL, thrust: 1 },
    { ...NEUTRAL, fire: "yes" },
  ]) {
    assert.notEqual(checkCommand(bad), null, JSON.stringify(bad));
  }
});

test("normalizeAngle keeps angles in (-pi, pi]", () => {
  for (const a of [0, 1, -1, 7, -7, 100, -100]) {
    const n = normalizeAngle(a);
    assert.ok(n > -Math.PI - 1e-12 && n <= Math.PI + 1e-12);
    assert.ok(Math.abs(Math.cos(n) - Math.cos(a)) < 1e-9);
  }
});
