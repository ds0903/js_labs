import { PICKUP_EFFECTS, spawnAsteroid, spawnPickup } from "./entities.js";
import { CONTROLS, Ship } from "./ship.js";
import { World } from "./world.js";

export const PLAYERS = [
  { name: "P1", color: "#cfe3ff", sprite: "ship1" },
  { name: "P2", color: "#ffd9a8", sprite: "ship2" },
  { name: "P3", color: "#b8f5c0", sprite: "ship1" },
  { name: "P4", color: "#f5b8e8", sprite: "ship2" },
];

// Arena presets: what the room list offers and what the server simulates.
export const ARENAS = {
  classic: { asteroids: 6, pickups: true },
  rocks: { asteroids: 14, pickups: true },
  duel: { asteroids: 0, pickups: true },
};

// asteroids, and a pickup spawner that keeps up to 3 pickups in the arena
export function populate(world, { asteroids = 6, pickups = true } = {}) {
  for (let i = 0; i < asteroids; i++) {
    spawnAsteroid(world, { hunter: i % 3 === 2 });
  }

  if (pickups) {
    const tick = () => {
      let count = 0;
      for (const _ of world.ofKind("pickup")) count++;
      if (count < 3) {
        spawnPickup(
          world,
          PICKUP_EFFECTS[Math.floor(world.rng() * PICKUP_EFFECTS.length)],
        );
      }
      world.schedule(6, tick);
    };
    world.schedule(2, tick);
  }
}

// Builds a world with ships (one per input), asteroids and a pickup spawner.
export function createGame({
  inputs,
  names = [],
  asteroids = 6,
  pickups = true,
  seed = 1,
}) {
  const world = new World({ seed });

  const ships = inputs.map((input, i) => {
    const player = { ...PLAYERS[i], name: names[i] ?? PLAYERS[i].name };
    const ship = new Ship({ input, controls: CONTROLS[i], ...player });
    ship.reset(world.randomSpot(200));
    ship.grace = 0;
    return world.spawn(ship);
  });

  populate(world, { asteroids, pickups });
  return { world, ships };
}
