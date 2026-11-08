import { ARENA } from "./arena.js";
import { findCollisions } from "./collision.js";
import { mulberry32 } from "./random.js";
import { resolve } from "./rules.js";
import { Vector2 } from "./vector.js";

// Owns all entities in a Map<id, Entity>. Despawn only marks an entity as
// dead, the real removal happens in sweep() at the end of the step, so
// nothing disappears while the step is still iterating over it.
export class World extends EventTarget {
  #entities = new Map();
  #spawnQueue = [];
  #timers = [];
  #stepping = false;

  constructor({ arena = ARENA, seed = 1 } = {}) {
    super();
    this.arena = arena;
    this.rng = mulberry32(seed);
    this.time = 0;
  }

  get size() {
    return this.#entities.size;
  }

  spawn(entity) {
    entity.world = this;
    // during a step new entities wait in a queue, so the Map is not
    // changed while it is being iterated
    if (this.#stepping) this.#spawnQueue.push(entity);
    else this.#entities.set(entity.id, entity);
    return entity;
  }

  despawn(id) {
    this.#entities.get(id)?.kill();
  }

  get(id) {
    return this.#entities.get(id);
  }

  *[Symbol.iterator]() {
    yield* this.#entities.values();
  }

  *ofKind(kind) {
    for (const entity of this) {
      if (entity.kind === kind) yield entity;
    }
  }

  // runs fn after `delay` seconds of simulated time
  schedule(delay, fn) {
    this.#timers.push({ at: this.time + delay, fn });
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  randomSpot(clear = 120) {
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

  step(dt) {
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

  #runTimers() {
    const due = this.#timers.filter((t) => t.at <= this.time);
    this.#timers = this.#timers.filter((t) => t.at > this.time);
    for (const timer of due) timer.fn();
  }

  #sweep() {
    for (const [id, entity] of this.#entities) {
      if (entity.alive) continue;
      this.#entities.delete(id);
      entity.world = null;
    }
  }
}
