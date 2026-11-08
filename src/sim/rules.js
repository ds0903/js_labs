import { explode, spawnAsteroid } from "./entities.js";
import { SHIP } from "./ship.js";

const SCORE = { ship: 10, asteroid: 2 };

// What happens when two entities touch. The collision system only finds
// the pairs, the decisions live here.
export function resolve(a, b, world) {
  const pick = (kind) => (a.kind === kind ? a : b.kind === kind ? b : null);
  const bullet = pick("bullet");
  const ship = pick("ship");
  const asteroid = pick("asteroid");
  const pickup = pick("pickup");

  if (bullet && ship) bulletHitsShip(bullet, ship, world);
  else if (bullet && asteroid) bulletHitsAsteroid(bullet, asteroid, world);
  else if (ship && asteroid) asteroidHitsShip(asteroid, ship, world);
  else if (ship && pickup) collect(pickup, ship, world);
}

function bulletHitsShip(bullet, ship, world) {
  if (bullet.owner === ship) return;
  bullet.kill();
  const damaged = ship.takeDamage(bullet.damage);
  world.emit("hit", { target: ship, bullet });
  if (damaged && ship.hp === 0) destroyShip(world, ship, bullet.owner);
}

function bulletHitsAsteroid(bullet, asteroid, world) {
  bullet.kill();
  asteroid.hp -= bullet.damage;
  world.emit("hit", { target: asteroid, bullet });
  if (asteroid.hp > 0) return;

  asteroid.kill();
  bullet.owner.score += SCORE.asteroid;
  explode(world, asteroid.pos, "#b0a090", 18);
  world.emit("exploded", { entity: asteroid });
  // keep the arena populated
  const hunter = Boolean(asteroid.parts.homing);
  world.schedule(5, () => spawnAsteroid(world, { hunter }));
}

function asteroidHitsShip(asteroid, ship, world) {
  if (!ship.takeDamage(15, 0.6)) return;
  const push = ship.pos.sub(asteroid.pos).normalize().scale(150);
  ship.vel = ship.vel.add(push);
  world.emit("hit", { target: ship, bullet: null });
  if (ship.hp === 0) destroyShip(world, ship, null);
}

function collect(pickup, ship, world) {
  const { effect, seconds } = pickup.parts.pickup;
  ship.applyEffect(effect, seconds);
  pickup.kill();
  world.emit("pickup", { ship, effect });
}

function destroyShip(world, ship, killer) {
  ship.kill();
  if (killer && killer !== ship) killer.score += SCORE.ship;
  explode(world, ship.pos, ship.color, 36);
  world.emit("exploded", { entity: ship });
  world.schedule(SHIP.respawnDelay, () => {
    ship.reset(world.randomSpot(200));
    world.spawn(ship);
  });
}
