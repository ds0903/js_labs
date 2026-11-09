import { ARENA, wrap } from "./arena.ts";
import type { PickupEffect } from "./effects.ts";
import { Vector2 } from "./vector.ts";
import type { World } from "./world.ts";

export type EntityKind = "ship" | "bullet" | "asteroid" | "particle" | "pickup";
export type EdgeMode = "wrap" | "bounce" | "none";

// Features that are added to an entity by composition (see behaviors.ts and
// the pickup factory), not by a subclass.
export interface Parts {
  homing?: boolean;
  pickup?: { effect: PickupEffect; seconds: number };
}

// runs every step before the movement
export type Behavior = (self: Entity, dt: number) => void;

export interface EntityInit<K extends EntityKind> {
  id?: number;
  kind: K;
  pos?: Vector2;
  vel?: Vector2;
  angle?: number;
  radius?: number;
  edge?: EdgeMode;
  solid?: boolean;
}

// Base class for everything that lives in the world. The class tree stops
// here: Ship, Bullet, Asteroid and Particle extend Entity, nothing extends
// them. `K` is the kind as a literal type, so `Entity<"ship">` is a ship and
// the compiler can tell the kinds apart.
export class Entity<K extends EntityKind = EntityKind> {
  static #nextId = 1;
  #id: number;

  readonly kind: K;
  pos: Vector2;
  vel: Vector2;
  angle: number;
  radius: number;
  edge: EdgeMode;
  solid: boolean;
  alive = true;
  world: World | null = null;
  behaviors: Behavior[] = [];
  parts: Parts = {};
  // state before the last step, used for interpolation when drawing
  prevPos: Vector2;
  prevAngle: number;

  // `id` is only passed when the id is decided elsewhere (the server's id on
  // the client side); otherwise the entity takes the next free one
  constructor({
    id,
    kind,
    pos = new Vector2(),
    vel = new Vector2(),
    angle = 0,
    radius = 10,
    edge = "wrap",
    solid = true,
  }: EntityInit<K>) {
    this.#id = id ?? Entity.#nextId++;
    this.kind = kind;
    this.pos = pos;
    this.vel = vel;
    this.angle = angle;
    this.radius = radius;
    this.edge = edge;
    this.solid = solid;
    this.prevPos = pos;
    this.prevAngle = angle;
  }

  get id(): number {
    return this.#id;
  }

  snapshot(): void {
    this.prevPos = this.pos;
    this.prevAngle = this.angle;
  }

  kill(): void {
    this.alive = false;
  }

  update(dt: number): void {
    for (const behavior of this.behaviors) behavior(this, dt);
    this.pos = this.pos.add(this.vel.scale(dt));
    this.#handleEdges();
  }

  #handleEdges(): void {
    if (this.edge === "none") return;
    const { width, height } = this.world?.arena ?? ARENA;
    let { x, y } = this.pos;
    let { x: vx, y: vy } = this.vel;

    if (this.edge === "wrap") {
      x = wrap(x, width);
      y = wrap(y, height);
    } else {
      const r = this.radius;
      if (x < r) [x, vx] = [r, Math.abs(vx)];
      if (x > width - r) [x, vx] = [width - r, -Math.abs(vx)];
      if (y < r) [y, vy] = [r, Math.abs(vy)];
      if (y > height - r) [y, vy] = [height - r, -Math.abs(vy)];
      this.vel = new Vector2(vx, vy);
    }
    this.pos = new Vector2(x, y);
  }
}
