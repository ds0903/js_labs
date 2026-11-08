import { applyCommand, createMatch, DT } from "./match.js";

// FNV-1a over the exact bits of every number that matters. Two runs give the
// same hash only if every position, velocity and angle is identical to the bit.
export function stateHash(world) {
  const f = new Float64Array(1);
  const words = new Uint32Array(f.buffer);
  let h = 0x811c9dc5;
  const mix = (n) => {
    f[0] = n;
    for (const w of words) {
      h ^= w;
      h = Math.imul(h, 0x01000193) >>> 0;
    }
  };
  for (const e of world) {
    if (e.kind === "particle") continue;
    mix(e.pos.x);
    mix(e.pos.y);
    mix(e.vel.x);
    mix(e.vel.y);
    mix(e.angle);
  }
  return h >>> 0;
}

// the same scripted inputs for everybody, a pure function of the step number
export function scriptedCommand(step, player) {
  return {
    seq: step + 1,
    tick: 0,
    thrust: (step + player * 7) % 50 < 35,
    turn: (Math.floor((step + player * 11) / 16) % 3) - 1,
    fire: step % 20 === player * 5,
  };
}

// Runs a match with two scripted players and returns the final hash.
export function runScripted(steps = 1000, { arena = "classic", seed = 7 } = {}) {
  const { world, addShip } = createMatch({ arena, seed });
  const players = [addShip(0, "A"), addShip(1, "B")];
  for (let step = 0; step < steps; step++) {
    players.forEach(({ ship, input }, i) => {
      applyCommand(ship, input, scriptedCommand(step, i));
    });
    world.step(DT);
  }
  return stateHash(world);
}
