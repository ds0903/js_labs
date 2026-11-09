import { Bus } from "../bus.ts";
import { ARENA, type Arena } from "./arena.ts";
import { findCollisions } from "./collision.ts";
import type { PickupEffect } from "./effects.ts";
import type { Asteroid, Bullet, Particle } from "./entities.ts";
import type { Entity, EntityKind } from "./entity.ts";
import { mulberry32 } from "./random.ts";
import { resolve } from "./rules.ts";
import type { Ship } from "./ship.ts";
import { Vector2 } from "./vector.ts";

// which class each kind of entity is: lets `ofKind("ship")` return ships
export interface EntityTypes {
  ship: Ship;
  bullet: Bullet;
  asteroid: Asteroid;
  particle: Particle;
  pickup: Entity<"pickup">;
}

// The events of the world and what each one carries. Sound, HUD and the server
// subscribe from the outside, the simulation does not know about them.
export interface WorldEvents {
  fired: { ship: Ship; bullet: Bullet };
  hit: { target: Ship | Asteroid; bullet: Bullet | null };
  exploded: { entity: Ship | Asteroid };
  pickup: { ship: Ship; effect: PickupEffect };
  score: { ship: Ship; points: number };
  respawned: { ship: Ship };
}

// a type guard: after `isKind(e, "ship")` the compiler knows `e` is a Ship
export function isKind<K extends EntityKind>(e: Entity, kind: K): e is EntityTypes[K] {
  return e.kind === kind;
}

export interface WorldOptions {
  arena?: Arena;
  seed?: number;
}

// Owns all entities in a Map<id, Entity>. Despawn only marks an entity as
// dead, the real removal happens in sweep() at the end of the step, so
// nothing disappears while the step is still iterating over it.
export class World extends Bus<WorldEvents> {
  #entities = new Map<number, Entity>();
  #spawnQueue: Entity[] = [];
  #timers: { at: number; fn: () => void }[] = [];
  #stepping = false;
  readonly arena: Arena;
  readonly rng: () => number;
  time = 0;

  constructor({ arena = ARENA, seed = 1 }: WorldOptions = {}) {
    super();
    this.arena = arena;
    this.rng = mulberry32(seed);
  }

  get size(): number {
    return this.#entities.size;
  }

  spawn<T extends Entity>(entity: T): T {
    entity.world = this;
    // during a step new entities wait in a queue, so the Map is not
    // changed while it is being iterated
    if (this.#stepping) this.#spawnQueue.push(entity);
    else this.#entities.set(entity.id, entity);
    return entity;
  }

  despawn(id: number): void {
    this.#entities.get(id)?.kill();
  }

  get(id: number): Entity | undefined {
    return this.#entities.get(id);
  }

  *[Symbol.iterator](): Generator<Entity> {
    yield* this.#entities.values();
  }

  *ofKind<K extends EntityKind>(kind: K): Generator<EntityTypes[K]> {
    for (const entity of this) {
      if (isKind(entity, kind)) yield entity;
    }
  }

  // runs fn after `delay` seconds of simulated time
  schedule(delay: number, fn: () => void): void {
    this.#timers.push({ at: this.time + delay, fn });
  }

  randomSpot(clear = 120): Vector2 {
    const { width, height } = this.arena;
    let spot = new Vector2(this.rng() * width, this.rng() * height);
    for (let i = 0; i < 30; i++) {
      let free = true;
      for (const e of this) {
        if (e.solid && e.alive && e.pos.sub(spot).length() < clear + e.radius) {
          free = false;
          break;
        }
      }
      if (free) break;
      spot = new Vector2(this.rng() * width, this.rng() * height);
    }
    return spot;
  }

  step(dt: number): void {
    this.#stepping = true;
    this.time += dt;

    for (const entity of this) {
      if (!entity.alive) continue;
      entity.snapshot();
      entity.update(dt);
    }

    for (const [a, b] of findCollisions(this)) {
      if (a.alive && b.alive) resolve(a, b, this);
    }

    this.#runTimers();
    this.#sweep();

    this.#stepping = false;
    for (const entity of this.#spawnQueue.splice(0)) {
      this.#entities.set(entity.id, entity);
    }
  }

  #runTimers(): void {
    const due = this.#timers.filter((t) => t.at <= this.time);
    this.#timers = this.#timers.filter((t) => t.at > this.time);
    for (const timer of due) timer.fn();
  }

  #sweep(): void {
    for (const [id, entity] of this.#entities) {
      if (entity.alive) continue;
      this.#entities.delete(id);
      entity.world = null;
    }
  }
}
