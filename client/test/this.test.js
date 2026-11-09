import assert from "node:assert/strict";
import { CONTROLS, Ship } from "shared/sim/ship";
import { Vector2 } from "shared/sim/vector";
import { World } from "shared/sim/world";
import { test } from "vitest";

function setup() {
  const world = new World();
  const ship = new Ship({ input: { isDown: () => false }, controls: CONTROLS[0] });
  ship.reset(new Vector2(800, 450));
  world.spawn(ship);
  return { world, ship };
}

const bullets = (world) => [...world.ofKind("bullet")].length;

test("ship.fire() as a method call works", () => {
  const { world, ship } = setup();
  ship.fire();
  assert.equal(bullets(world), 1);
});

test("passing ship.fire as a bare function loses this (default binding)", () => {
  const { world, ship } = setup();
  const fire = ship.fire; // what addEventListener("keydown", ship.fire) does
  assert.throws(() => fire(), TypeError);
  assert.equal(bullets(world), 0);
});

test("a listener gets the window/target as this, not the ship", () => {
  const { ship } = setup();
  const fakeWindow = {};
  assert.throws(() => ship.fire.call(fakeWindow), TypeError);
});

test("fix 1: arrow wrapper", () => {
  const { world, ship } = setup();
  const listener = () => ship.fire();
  listener();
  assert.equal(bullets(world), 1);
});

test("fix 2: bind", () => {
  const { world, ship } = setup();
  const listener = ship.fire.bind(ship);
  listener();
  assert.equal(bullets(world), 1);
  // bind wins over a later call with another this
  ship.cooldown = 0;
  listener.call({});
  assert.equal(bullets(world), 2);
});

test("fix 3: arrow function as class field works but makes a copy per instance", () => {
  class Gun {
    shots = 0;
    fire = () => {
      this.shots++;
    };
  }
  const a = new Gun();
  const b = new Gun();
  const detached = a.fire;
  detached();
  assert.equal(a.shots, 1);
  assert.notEqual(a.fire, b.fire); // one function object per instance
});

test("fire respects the cooldown and a ship outside the world cannot fire", () => {
  const { world, ship } = setup();
  ship.fire();
  ship.fire();
  assert.equal(bullets(world), 1);
  ship.kill();
  world.step(1 / 60);
  ship.cooldown = 0;
  ship.fire();
  assert.equal(bullets(world), 1);
});
