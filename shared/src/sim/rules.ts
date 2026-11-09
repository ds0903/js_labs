import { type Asteroid, type Bullet, explode, spawnAsteroid } from "./entities.ts";
import type { Entity, EntityKind } from "./entity.ts";
import { SHIP, type Ship } from "./ship.ts";
import { type EntityTypes, isKind, type World } from "./world.ts";

const SCORE = { ship: 10, asteroid: 2 };

// What happens when two entities touch. The collision system only finds
// the pairs, the decisions live here.
export function resolve(a: Entity, b: Entity, world: World): void {
  const pick = <K extends EntityKind>(kind: K): EntityTypes[K] | null =>
    isKind(a, kind) ? a : isKind(b, kind) ? b : null;
  const bullet = pick("bullet");
  const ship = pick("ship");
  const asteroid = pick("asteroid");
  const pickup = pick("pickup");

  if (bullet && ship) bulletHitsShip(bullet, ship, world);
  else if (bullet && asteroid) bulletHitsAsteroid(bullet, asteroid, world);
  else if (ship && asteroid) asteroidHitsShip(asteroid, ship, world);
  else if (ship && pickup) collect(pickup, ship, world);
}

function bulletHitsShip(bullet: Bullet, ship: Ship, world: World): void {
  if (bullet.owner === ship) return;
  bullet.kill();
  const damaged = ship.takeDamage(bullet.damage);
  world.emit("hit", { target: ship, bullet });
  if (damaged && ship.hp === 0) destroyShip(world, ship, bullet.owner);
}

function bulletHitsAsteroid(bullet: Bullet, asteroid: Asteroid, world: World): void {
  bullet.kill();
  asteroid.hp -= bullet.damage;
  world.emit("hit", { target: asteroid, bullet });
  if (asteroid.hp > 0) return;

  asteroid.kill();
  award(world, bullet.owner, SCORE.asteroid);
  explode(world, asteroid.pos, "#b0a090", 18);
  world.emit("exploded", { entity: asteroid });
  // keep the arena populated
  const hunter = Boolean(asteroid.parts.homing);
  world.schedule(5, () => spawnAsteroid(world, { hunter }));
}

function asteroidHitsShip(asteroid: Asteroid, ship: Ship, world: World): void {
  if (!ship.takeDamage(15, 0.6)) return;
  const push = ship.pos.sub(asteroid.pos).normalize().scale(150);
  ship.vel = ship.vel.add(push);
  world.emit("hit", { target: ship, bullet: null });
  if (ship.hp === 0) destroyShip(world, ship, null);
}

function collect(pickup: Entity<"pickup">, ship: Ship, world: World): void {
  // `parts` is a bag of optional data, so the compiler makes us say what
  // happens to a pickup that has none (it cannot happen: the factory sets it)
  const data = pickup.parts.pickup;
  if (!data) return;
  ship.applyEffect(data.effect, data.seconds);
  pickup.kill();
  world.emit("pickup", { ship, effect: data.effect });
}

function award(world: World, ship: Ship, points: number): void {
  ship.score += points;
  world.emit("score", { ship, points });
}

function destroyShip(world: World, ship: Ship, killer: Ship | null): void {
  ship.kill();
  if (killer && killer !== ship) award(world, killer, SCORE.ship);
  explode(world, ship.pos, ship.color, 36);
  world.emit("exploded", { entity: ship });
  world.schedule(SHIP.respawnDelay, () => {
    ship.reset(world.randomSpot(200));
    world.spawn(ship);
    world.emit("respawned", { ship });
  });
}
