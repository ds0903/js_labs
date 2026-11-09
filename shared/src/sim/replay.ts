import { seq, tick } from "../brand.ts";
import type { Command } from "../protocol.ts";
import { applyCommand, createMatch, DT } from "./match.ts";
import type { World } from "./world.ts";

// FNV-1a over the exact bits of every number that matters. Two runs give the
// same hash only if every position, velocity and angle is identical to the bit.
export function stateHash(world: World): number {
  const f = new Float64Array(1);
  const words = new Uint32Array(f.buffer);
  let h = 0x811c9dc5;
  const mix = (n: number) => {
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

const turnOf = (n: number): -1 | 0 | 1 => (n < 0 ? -1 : n > 0 ? 1 : 0);

// the same scripted inputs for everybody, a pure function of the step number
export function scriptedCommand(step: number, player: number): Command {
  return {
    seq: seq(step + 1),
    tick: tick(0),
    thrust: (step + player * 7) % 50 < 35,
    turn: turnOf((Math.floor((step + player * 11) / 16) % 3) - 1),
    fire: step % 20 === player * 5,
  };
}

// Runs a match with two scripted players and returns the final hash.
export function runScripted(
  steps = 1000,
  { arena = "classic", seed = 7 }: { arena?: string; seed?: number } = {},
): number {
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
