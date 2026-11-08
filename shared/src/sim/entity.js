import { ARENA, wrap } from "./arena.js";
import { Vector2 } from "./vector.js";

// Base class for everything that lives in the world. The class tree stops
// here: Ship, Bullet, Asteroid and Particle extend Entity, nothing extends
// them. Extra features (homing, pickups) are added by composition through
// `behaviors` (functions run every step) and `parts` (plain data).
export class Entity {
  static #nextId = 1;
  #id;

  // `id` is only passed when the id is decided elsewhere (the server's id on
  // the client side); otherwise the entity takes the next free one
  constructor({
    id,
    kind,
    pos = new Vector2(),
    vel = new Vector2(),
    angle = 0,
    radius = 10,
    edge = "wrap", // "wrap" | "bounce" | "none"
    solid = true,
  }) {
    this.#id = id ?? Entity.#nextId++;
    this.kind = kind;
    this.pos = pos;
    this.vel = vel;
    this.angle = angle;
    this.radius = radius;
    this.edge = edge;
    this.solid = solid;
    this.alive = true;
    this.world = null;
    this.behaviors = [];
    this.parts = {};
    // state before the last step, used for interpolation when drawing
    this.prevPos = pos;
    this.prevAngle = angle;
  }

  get id() {
    return this.#id;
  }

  snapshot() {
    this.prevPos = this.pos;
    this.prevAngle = this.angle;
  }

  kill() {
    this.alive = false;
  }

  update(dt) {
    for (const behavior of this.behaviors) behavior(this, dt);
    this.pos = this.pos.add(this.vel.scale(dt));
    this.#handleEdges();
  }

  #handleEdges() {
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
