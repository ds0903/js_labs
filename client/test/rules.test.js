import assert from "node:assert/strict";
import { test } from "node:test";
import { withHoming } from "../src/sim/behaviors.js";
import { Asteroid, Bullet, spawnPickup } from "../src/sim/entities.js";
import { createGame } from "../src/sim/game.js";
import { CONTROLS, SHIP, Ship } from "../src/sim/ship.js";
import { Vector2 } from "../src/sim/vector.js";
import { World } from "../src/sim/world.js";

const idle = { isDown: () => false };
const STEP = 1 / 60;

function addShip(world, x, y, controls = CONTROLS[0]) {
  const ship = new Ship({ input: idle, controls });
  ship.reset(new Vector2(x, y));
  ship.grace = 0;
  return world.spawn(ship);
}

const bulletAt = (pos, owner, damage = 10) =>
  new Bullet({ pos, vel: new Vector2(), owner, damage });

test("bullet destroys an asteroid, owner scores, sparks appear", () => {
  const world = new World({ seed: 2 });
  const ship = addShip(world, 100, 100);
  const asteroid = world.spawn(
    new Asteroid({ pos: new Vector2(800, 450), vel: new Vector2(), radius: 20 }),
  );
  world.spawn(bulletAt(new Vector2(800, 450), ship, 100));

  world.step(STEP);
  assert.equal(world.get(asteroid.id), undefined);
  assert.equal(ship.score, 2);
  assert.ok([...world.ofKind("particle")].length > 0);
});

test("bullet damages a ship through #hp, the owner is not hit", () => {
  const world = new World();
  const a = addShip(world, 100, 100);
  const b = addShip(world, 800, 450, CONTROLS[1]);

  world.spawn(bulletAt(new Vector2(100, 100), a)); // own bullet: ignored
  world.spawn(bulletAt(new Vector2(800, 450), a, 30));
  world.step(STEP);

  assert.equal(a.hp, SHIP.maxHp);
  assert.equal(b.hp, SHIP.maxHp - 30);
  assert.throws(() => {
    b.hp = 1; // getter only
  }, TypeError);
});

test("destroyed ship explodes and respawns after 2 s with full hp", () => {
  const world = new World({ seed: 4 });
  const a = addShip(world, 100, 100);
  const b = addShip(world, 800, 450, CONTROLS[1]);

  world.spawn(bulletAt(new Vector2(800, 450), a, 100));
  world.step(STEP);
  assert.equal(b.hp, 0);
  assert.equal(world.get(b.id), undefined);
  assert.equal(a.score, 10);

  for (let t = 0; t < 1.9; t += STEP) world.step(STEP);
  assert.equal(world.get(b.id), undefined);
  for (let t = 0; t < 0.3; t += STEP) world.step(STEP);
  assert.equal(world.get(b.id), b);
  assert.equal(b.hp, SHIP.maxHp);
  assert.ok(b.grace > 0);
});

test("shield blocks damage", () => {
  const world = new World();
  const a = addShip(world, 100, 100);
  const b = addShip(world, 800, 450, CONTROLS[1]);
  b.applyEffect("shield", 5);
  world.spawn(bulletAt(new Vector2(800, 450), a, 50));
  world.step(STEP);
  assert.equal(b.hp, SHIP.maxHp);
});

test("pickup is stationary, collides with a ship and gives the effect", () => {
  const world = new World();
  const ship = addShip(world, 400, 400);
  const pickup = spawnPickup(world, "rapid");
  pickup.pos = new Vector2(405, 400);

  world.step(STEP);
  assert.ok(ship.effects.rapid > 7);
  assert.equal(world.get(pickup.id), undefined);
  assert.equal(pickup.kind, "pickup");
  assert.equal(Object.getPrototypeOf(pickup).constructor.name, "Entity");
});

test("homing is a behavior: it steers a bullet and an asteroid alike", () => {
  const world = new World();
  const ship = addShip(world, 800, 800);

  const target = world.spawn(
    new Asteroid({ pos: new Vector2(500, 500), vel: new Vector2(), radius: 20 }),
  );
  const bullet = withHoming(
    new Bullet({ pos: new Vector2(100, 300), vel: new Vector2(700, 0), owner: ship }),
    { targetKinds: ["asteroid"], turnRate: 3 },
  );
  world.spawn(bullet);

  const hunter = withHoming(
    new Asteroid({ pos: new Vector2(800, 500), vel: new Vector2(40, 0), radius: 20 }),
    { targetKinds: ["ship"], turnRate: 1 },
  );
  world.spawn(hunter);

  for (let i = 0; i < 10; i++) world.step(STEP);

  assert.ok(target.alive);
  assert.ok(bullet.vel.y > 0, "bullet turns toward the asteroid below it");
  assert.ok(Math.abs(bullet.vel.length() - 700) < 1e-6, "speed is kept");
  assert.ok(hunter.vel.y > 0, "hunter asteroid turns toward the ship below it");
});

test("same seed, same world: the simulation is deterministic", () => {
  const snapshot = () => {
    const { world } = createGame({ inputs: [idle, idle], seed: 5 });
    for (let i = 0; i < 600; i++) world.step(STEP);
    return [...world].map((e) => [e.kind, e.pos.x, e.pos.y]);
  };
  assert.deepEqual(snapshot(), snapshot());
});
