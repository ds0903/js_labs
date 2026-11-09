import { withHoming } from "./behaviors.ts";
import { atan2 } from "./dmath.ts";
import { PICKUP_EFFECTS, type PickupEffect } from "./effects.ts";
import { Entity } from "./entity.ts";
import type { Ship } from "./ship.ts";
import { Vector2 } from "./vector.ts";
import type { World } from "./world.ts";

export { PICKUP_EFFECTS };

export interface BulletInit {
  pos: Vector2;
  vel: Vector2;
  owner: Ship;
  ttl?: number;
  damage?: number;
}

export class Bullet extends Entity<"bullet"> {
  owner: Ship;
  ttl: number;
  damage: number;
  // the input that fired it (set by Ship.fire), so the client can match its
  // own predicted bullet with the server's
  srcSeq = 0;

  constructor({ pos, vel, owner, ttl = 1.2, damage = 10 }: BulletInit) {
    super({ kind: "bullet", pos, vel, radius: 3, angle: atan2(vel.y, vel.x) });
    this.owner = owner;
    this.ttl = ttl;
    this.damage = damage;
  }

  override update(dt: number): void {
    this.ttl -= dt;
    if (this.ttl <= 0) this.kill();
    super.update(dt);
  }
}

export interface AsteroidInit {
  pos: Vector2;
  vel: Vector2;
  radius: number;
  spin?: number;
}

export class Asteroid extends Entity<"asteroid"> {
  spin: number;
  hp: number;

  constructor({ pos, vel, radius, spin = 0 }: AsteroidInit) {
    super({ kind: "asteroid", pos, vel, radius, edge: "bounce" });
    this.spin = spin;
    this.hp = Math.round(radius * 1.2);
  }

  override update(dt: number): void {
    this.angle += this.spin * dt;
    super.update(dt);
  }
}

export interface ParticleInit {
  pos: Vector2;
  vel: Vector2;
  ttl: number;
  color: string;
}

// short-lived spark, never collides
export class Particle extends Entity<"particle"> {
  ttl: number;
  maxTtl: number;
  color: string;

  constructor({ pos, vel, ttl, color }: ParticleInit) {
    super({ kind: "particle", pos, vel, radius: 0, edge: "none", solid: false });
    this.ttl = ttl;
    this.maxTtl = ttl;
    this.color = color;
  }

  override update(dt: number): void {
    this.ttl -= dt;
    if (this.ttl <= 0) this.kill();
    super.update(dt);
  }
}

export function explode(world: World, pos: Vector2, color: string, count = 24): void {
  const rand = world.rng;
  for (let i = 0; i < count; i++) {
    const vel = Vector2.fromAngle(rand() * Math.PI * 2, 60 + rand() * 220);
    world.spawn(new Particle({ pos, vel, ttl: 0.4 + rand() * 0.5, color }));
  }
}

export function spawnAsteroid(world: World, { hunter = false } = {}): Asteroid {
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

// A pickup is a plain Entity with a data part, not a subclass: it stands
// still, collides, and is not a ship.
export function spawnPickup(world: World, effect: PickupEffect): Entity<"pickup"> {
  const pickup = new Entity({
    kind: "pickup",
    pos: world.randomSpot(100),
    radius: 14,
    edge: "none",
  });
  pickup.parts.pickup = { effect, seconds: 8 };
  return world.spawn(pickup);
}
