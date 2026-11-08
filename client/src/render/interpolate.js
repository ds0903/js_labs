import { wrap } from "shared/sim/arena";

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

// Angles are periodic: going from 350 deg to 10 deg is +20, not -340.
export function lerpAngle(a, b, t) {
  const full = Math.PI * 2;
  const diff = ((((b - a + Math.PI) % full) + full) % full) - Math.PI;
  return a + diff * t;
}

// Same idea for a coordinate that wrapped around the arena edge between
// two steps: take the short way across the edge, not the long way back.
export function lerpWrapped(a, b, t, size) {
  let diff = b - a;
  if (diff > size / 2) diff -= size;
  if (diff < -size / 2) diff += size;
  return wrap(a + diff * t, size);
}
