import assert from "node:assert/strict";
import { test } from "node:test";
import { Asteroid, Bullet } from "../src/sim/entities.js";
import { Entity } from "../src/sim/entity.js";
import { Vector2 } from "../src/sim/vector.js";
import { World } from "../src/sim/world.js";

const asteroidAt = (x, y) =>
  new Asteroid({ pos: new Vector2(x, y), vel: new Vector2(), radius: 20 });

test("ids are unique and increasing", () => {
  const a = new Entity({ kind: "x" });
  const b = new Entity({ kind: "x" });
  assert.ok(b.id > a.id);
});

test("spawn, get, iterate, ofKind", () => {
  const world = new World();
  const a = world.spawn(asteroidAt(100, 100));
  const b = world.spawn(asteroidAt(500, 500));
  world.spawn(
    new Bullet({ pos: new Vector2(900, 100), vel: new Vector2(1, 0), owner: null }),
  );

  assert.equal(world.size, 3);
  assert.equal(world.get(a.id), a);
  assert.deepEqual([...world.ofKind("asteroid")], [a, b]);
  assert.equal([...world].length, 3);
});

test("despawn only marks the entity, the sweep at the end of step removes it", () => {
  const world = new World();
  const a = world.spawn(asteroidAt(100, 100));
  world.despawn(a.id);

  assert.equal(a.alive, false);
  assert.equal(world.get(a.id), a); // still in the map until the step ends
  world.step(1 / 60);
  assert.equal(world.get(a.id), undefined);
  assert.equal(a.world, null);
});

test("entities spawned during a step are added after it", () => {
  const world = new World();
  let spawned = null;
  world.schedule(0, () => {
    spawned = world.spawn(asteroidAt(300, 300));
  });
  world.step(1 / 60);
  assert.equal(world.get(spawned.id), spawned);
});

test("bouncing asteroid stays inside the arena", () => {
  const world = new World();
  const a = world.spawn(
    new Asteroid({ pos: new Vector2(30, 450), vel: new Vector2(-400, 0), radius: 20 }),
  );
  for (let i = 0; i < 60; i++) world.step(1 / 60);
  assert.ok(a.pos.x >= 20 && a.pos.x <= world.arena.width - 20);
  assert.ok(a.vel.x > 0);
});
