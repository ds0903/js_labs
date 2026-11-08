import assert from "node:assert/strict";
import { test } from "node:test";
import { Vector2 } from "shared/sim/vector";

test("add returns a new vector and leaves both arguments alone", () => {
  const a = new Vector2(1, 2);
  const b = new Vector2(3, 4);
  const c = a.add(b);
  assert.deepEqual([c.x, c.y], [4, 6]);
  assert.deepEqual([a.x, a.y], [1, 2]);
  assert.deepEqual([b.x, b.y], [3, 4]);
  assert.notEqual(c, a);
});

test("vectors are frozen, mutating one throws", () => {
  const v = new Vector2(1, 2);
  assert.throws(() => {
    v.x = 5;
  }, TypeError);
});

test("normalize gives length 1, zero vector stays zero", () => {
  assert.ok(Math.abs(new Vector2(3, 4).normalize().length() - 1) < 1e-12);
  assert.equal(new Vector2().normalize().length(), 0);
});

test("rotate by a quarter turn", () => {
  const v = new Vector2(1, 0).rotate(Math.PI / 2);
  assert.ok(Math.abs(v.x) < 1e-12 && Math.abs(v.y - 1) < 1e-12);
});

test("fromAngle, dot, sub, scale", () => {
  const v = Vector2.fromAngle(0, 5);
  assert.deepEqual([v.x, v.y], [5, 0]);
  assert.equal(new Vector2(1, 2).dot(new Vector2(3, 4)), 11);
  assert.deepEqual(Object.values(new Vector2(5, 5).sub(new Vector2(1, 2))), [4, 3]);
  assert.deepEqual(Object.values(new Vector2(1, 2).scale(3)), [3, 6]);
});
