import type { ShipRecord } from "../protocol.ts";
import { withHoming } from "./behaviors.ts";
import { PICKUP_EFFECTS, type PickupEffect } from "./effects.ts";
import { Bullet } from "./entities.ts";
import { Entity } from "./entity.ts";
import { Vector2 } from "./vector.ts";

export const SHIP = {
  turnSpeed: 3.5, // rad/s
  thrust: 320, // px/s^2
  drag: 0.5, // 1/s
  maxSpeed: 480, // px/s
  maxHp: 100,
  fireCooldown: 0.25, // s
  bulletSpeed: 700, // px/s
  respawnDelay: 2, // s
  spawnGrace: 2, // s without damage after respawn
};

// which key code (or command name) does what
export interface Controls {
  left: string;
  right: string;
  thrust: string;
  fire: string;
}

export const CONTROLS: readonly Controls[] = [
  { left: "ArrowLeft", right: "ArrowRight", thrust: "ArrowUp", fire: "Space" },
  { left: "KeyA", right: "KeyD", thrust: "KeyW", fire: "KeyF" },
];

// A ship only needs to ask "is this pressed?", so a test can pass a fake one.
// `seq` is there when the input comes from the network.
export interface InputSource {
  isDown(code: string): boolean;
  readonly seq?: number;
}

export type Effects = Record<PickupEffect, number>;

export interface ShipInit {
  id?: number;
  input: InputSource;
  controls: Controls;
  name?: string;
  color?: string;
  sprite?: string;
}

export class Ship extends Entity<"ship"> {
  #hp: number = SHIP.maxHp;
  input: InputSource;
  controls: Controls;
  name: string;
  color: string;
  sprite: string;
  score = 0;
  thrusting = false;
  cooldown = 0;
  grace = 0;
  effects: Effects = { shield: 0, rapid: 0, homing: 0 };
  // the server sets it when a player's input did not arrive for this tick:
  // the ship does not move, so the client can replay exactly what was acked
  idle = false;

  constructor({
    id,
    input,
    controls,
    name = "ship",
    color = "#cfe3ff",
    sprite = "ship1",
  }: ShipInit) {
    super({ id, kind: "ship", radius: 14, angle: -Math.PI / 2 });
    this.input = input;
    this.controls = controls;
    this.name = name;
    this.color = color;
    this.sprite = sprite;
  }

  get hp(): number {
    return this.#hp;
  }

  override update(dt: number): void {
    if (this.idle) return;
    const { left, right, thrust } = this.controls;
    const turn = (this.input.isDown(right) ? 1 : 0) - (this.input.isDown(left) ? 1 : 0);
    this.angle += turn * SHIP.turnSpeed * dt;
    this.thrusting = this.input.isDown(thrust);

    let vel = this.vel;
    if (this.thrusting) vel = vel.add(Vector2.fromAngle(this.angle, SHIP.thrust * dt));
    vel = vel.scale(1 - SHIP.drag * dt);
    const speed = vel.length();
    if (speed > SHIP.maxSpeed) vel = vel.scale(SHIP.maxSpeed / speed);
    this.vel = vel;

    super.update(dt);

    this.cooldown = Math.max(0, this.cooldown - dt);
    this.grace = Math.max(0, this.grace - dt);
    for (const name of PICKUP_EFFECTS) {
      this.effects[name] = Math.max(0, this.effects[name] - dt);
    }
  }

  // Uses `this`, so it only works when called as ship.fire(). Passing the
  // bare method to an event listener loses `this`, see README.
  fire(): void {
    if (this.cooldown > 0 || this.world === null) return;

    const dir = Vector2.fromAngle(this.angle);
    const bullet = new Bullet({
      pos: this.pos.add(dir.scale(this.radius + 6)),
      vel: this.vel.add(dir.scale(SHIP.bulletSpeed)),
      owner: this,
    });
    bullet.srcSeq = this.input.seq ?? 0;
    if (this.effects.homing > 0) {
      withHoming(bullet, {
        targetKinds: ["ship", "asteroid"],
        turnRate: 3,
        ignore: this,
      });
    }
    this.cooldown = this.effects.rapid > 0 ? SHIP.fireCooldown / 3 : SHIP.fireCooldown;
    this.world.spawn(bullet);
    this.world.emit("fired", { ship: this, bullet });
  }

  // returns true if the damage was applied
  takeDamage(amount: number, grace = 0): boolean {
    if (this.effects.shield > 0 || this.grace > 0) return false;
    this.#hp = Math.max(0, this.#hp - amount);
    this.grace = grace;
    return true;
  }

  applyEffect(name: PickupEffect, seconds: number): void {
    this.effects[name] = seconds;
  }

  // Takes the state described by a snapshot (see snapshot.ts). Used by the
  // client to put its predicted ship where the server says it is.
  restore(s: ShipRecord): void {
    this.#hp = s.hp;
    this.alive = true;
    this.pos = new Vector2(s.x, s.y);
    this.prevPos = this.pos;
    this.vel = new Vector2(s.vx, s.vy);
    this.angle = s.angle;
    this.prevAngle = s.angle;
    this.cooldown = s.cooldown;
    this.grace = s.grace;
    this.effects = { shield: s.shield, rapid: s.rapid, homing: s.homing };
    this.score = s.score;
  }

  reset(pos: Vector2): void {
    this.#hp = SHIP.maxHp;
    this.alive = true;
    this.pos = pos;
    this.prevPos = pos;
    this.vel = new Vector2();
    this.angle = -Math.PI / 2;
    this.prevAngle = this.angle;
    this.cooldown = 0;
    this.grace = SHIP.spawnGrace;
    this.effects = { shield: 0, rapid: 0, homing: 0 };
  }
}
