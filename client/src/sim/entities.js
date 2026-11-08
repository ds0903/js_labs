import { withHoming } from "./behaviors.js";
import { Entity } from "./entity.js";
import { Vector2 } from "./vector.js";

export class Bullet extends Entity {
  constructor({ pos, vel, owner, ttl = 1.2, damage = 10 }) {
    super({ kind: "bullet", pos, vel, radius: 3, angle: Math.atan2(vel.y, vel.x) });
    this.owner = owner;
    this.ttl = ttl;
    this.damage = damage;
  }

  update(dt) {
    this.ttl -= dt;
    if (this.ttl <= 0) this.kill();
    super.update(dt);
  }
}

export class Asteroid extends Entity {
  constructor({ pos, vel, radius, spin = 0 }) {
    super({ kind: "asteroid", pos, vel, radius, edge: "bounce" });
    this.spin = spin;
    this.hp = Math.round(radius * 1.2);
  }

  update(dt) {
    this.angle += this.spin * dt;
    super.update(dt);
  }
}

// short-lived spark, never collides
export class Particle extends Entity {
  constructor({ pos, vel, ttl, color }) {
    super({ kind: "particle", pos, vel, radius: 0, edge: "none", solid: false });
    this.ttl = ttl;
    this.maxTtl = ttl;
    this.color = color;
  }

  update(dt) {
    this.ttl -= dt;
    if (this.ttl <= 0) this.kill();
    super.update(dt);
  }
}

export function explode(world, pos, color, count = 24) {
  const rand = world.rng;
  for (let i = 0; i < count; i++) {
    const vel = Vector2.fromAngle(rand() * Math.PI * 2, 60 + rand() * 220);
    world.spawn(new Particle({ pos, vel, ttl: 0.4 + rand() * 0.5, color }));
  }
}

export function spawnAsteroid(world, { hunter = false } = {}) {
  const rand = world.rng;
  const radius = 20 + rand() * 25;
  const asteroid = new Asteroid({
    pos: world.randomSpot(radius + 120),
    vel: Vector2.fromAngle(rand() * Math.PI * 2, 25 + rand() * 35),
    radius,
    spin: rand() - 0.5,
  });
  if (hunter) withHoming(asteroid, { targetKinds: ["ship"], turnRate: 0.7 });
  return world.spawn(asteroid);
}

export const PICKUP_EFFECTS = ["shield", "rapid", "homing"];

// A pickup is a plain Entity with a data part, not a subclass: it stands
// still, collides, and is not a ship.
export function spawnPickup(world, effect) {
  const pickup = new Entity({
    kind: "pickup",
    pos: world.randomSpot(100),
    radius: 14,
    edge: "none",
  });
  pickup.parts.pickup = { effect, seconds: 8 };
  return world.spawn(pickup);
}
