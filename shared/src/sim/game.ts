import { PICKUP_EFFECTS, spawnAsteroid, spawnPickup } from "./entities.ts";
import { CONTROLS, type InputSource, Ship } from "./ship.ts";
import { World } from "./world.ts";

export interface PlayerStyle {
  name: string;
  color: string;
  sprite: string;
}

export const PLAYERS: readonly [PlayerStyle, ...PlayerStyle[]] = [
  { name: "P1", color: "#cfe3ff", sprite: "ship1" },
  { name: "P2", color: "#ffd9a8", sprite: "ship2" },
  { name: "P3", color: "#b8f5c0", sprite: "ship1" },
  { name: "P4", color: "#f5b8e8", sprite: "ship2" },
];

// the style of the n-th player; more players than styles start over
export const styleFor = (index: number): PlayerStyle =>
  PLAYERS[index % PLAYERS.length] ?? PLAYERS[0];

export interface ArenaPreset {
  asteroids: number;
  pickups: boolean;
}

// Arena presets: what the room list offers and what the server simulates.
export const ARENAS = {
  classic: { asteroids: 6, pickups: true },
  rocks: { asteroids: 14, pickups: true },
  duel: { asteroids: 0, pickups: true },
} satisfies Record<string, ArenaPreset>;

export type ArenaName = keyof typeof ARENAS;

export const isArenaName = (name: string): name is ArenaName =>
  Object.hasOwn(ARENAS, name);

// asteroids, and a pickup spawner that keeps up to 3 pickups in the arena
export function populate(
  world: World,
  { asteroids = 6, pickups = true }: Partial<ArenaPreset> = {},
): void {
  for (let i = 0; i < asteroids; i++) {
    spawnAsteroid(world, { hunter: i % 3 === 2 });
  }

  if (pickups) {
    const tick = () => {
      let count = 0;
      for (const _ of world.ofKind("pickup")) count++;
      if (count < 3) {
        const effect = PICKUP_EFFECTS[Math.floor(world.rng() * PICKUP_EFFECTS.length)];
        if (effect) spawnPickup(world, effect);
      }
      world.schedule(6, tick);
    };
    world.schedule(2, tick);
  }
}

export interface GameInit {
  inputs: readonly InputSource[];
  names?: readonly string[];
  asteroids?: number;
  pickups?: boolean;
  seed?: number;
}

// Builds a world with ships (one per input), asteroids and a pickup spawner.
export function createGame({
  inputs,
  names = [],
  asteroids = 6,
  pickups = true,
  seed = 1,
}: GameInit): { world: World; ships: Ship[] } {
  const world = new World({ seed });

  const ships = inputs.map((input, i) => {
    const controls = CONTROLS[i];
    // found by the compiler: a third local input used to get `controls`
    // undefined and crash on its first update
    if (!controls) throw new RangeError(`no controls for local player ${i + 1}`);
    const style = styleFor(i);
    const ship = new Ship({ input, controls, ...style, name: names[i] ?? style.name });
    ship.reset(world.randomSpot(200));
    ship.grace = 0;
    return world.spawn(ship);
  });

  populate(world, { asteroids, pickups });
  return { world, ships };
}
