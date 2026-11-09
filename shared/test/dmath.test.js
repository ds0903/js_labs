import assert from "node:assert/strict";
import { test } from "node:test";
import { atan2, cos, normalizeAngle, sin } from "shared/sim/dmath";

// bit-exact fingerprint of the functions over many inputs: the same number must
// come out in every engine (checked in Chrome 156, see README)
function fingerprint() {
  const f64 = new Float64Array(1);
  const words = new Uint32Array(f64.buffer);
  let h = 0x811c9dc5;
  const mix = (n) => {
    f64[0] = n;
    for (const w of words) h = Math.imul(h ^ w, 0x01000193) >>> 0;
  };
  for (let i = 1; i < 20000; i++) {
    mix(sin(i * 0.0137));
    mix(cos(i * 0.0137));
    mix(atan2(sin(i), cos(i * 1.3)));
  }
  return h;
}

test("sin and cos agree with Math to about 1e-14 for small and large angles", () => {
  let worst = 0;
  for (let i = -4000; i <= 4000; i++) {
    const x = i * 0.0731;
    worst = Math.max(
      worst,
      Math.abs(sin(x) - Math.sin(x)),
      Math.abs(cos(x) - Math.cos(x)),
    );
  }
  assert.ok(worst < 1e-12, `worst error ${worst}`);
  for (const x of [0, Math.PI, -Math.PI, Math.PI / 2, 1000, -1000, 12345.678]) {
    assert.ok(Math.abs(sin(x) - Math.sin(x)) < 1e-9, `sin(${x})`);
    assert.ok(Math.abs(cos(x) - Math.cos(x)) < 1e-9, `cos(${x})`);
  }
});

test("atan2 agrees with Math.atan2 in every quadrant and on the axes", () => {
  let worst = 0;
  for (let i = 0; i < 3000; i++) {
    const a = i * 0.0021 - 3.14;
    const y = Math.sin(a) * (1 + (i % 7));
    const x = Math.cos(a) * (1 + (i % 5));
    worst = Math.max(worst, Math.abs(atan2(y, x) - Math.atan2(y, x)));
  }
  assert.ok(worst < 1e-12, `worst error ${worst}`);
  assert.equal(atan2(0, 0), 0);
  assert.ok(Math.abs(atan2(1, 0) - Math.PI / 2) < 1e-15);
  assert.ok(Math.abs(atan2(-1, 0) + Math.PI / 2) < 1e-15);
  assert.ok(Math.abs(atan2(0, -1) - Math.PI) < 1e-15);
  assert.ok(Math.abs(atan2(-1e-9, -1) + Math.PI) < 1e-8);
});

test("normalizeAngle lands in (-pi, pi]", () => {
  for (const a of [0, 3, -3, 7, -7, 100, -100, 6.283185307179586]) {
    const n = normalizeAngle(a);
    assert.ok(n > -Math.PI - 1e-12 && n <= Math.PI + 1e-12, `${a} -> ${n}`);
    assert.ok(Math.abs(Math.cos(n) - Math.cos(a)) < 1e-9);
  }
});

// Same number measured in Node 24 and in Chrome 156 (browser_evaluate with the
// same source). With Math.sin/cos/atan2 the two engines give different numbers.
test("the fingerprint is the one measured in Node and Chrome", () => {
  assert.equal(fingerprint(), 2920830439);
});
