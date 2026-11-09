import { atan2, normalizeAngle } from "./dmath.ts";
import type { Behavior, Entity, EntityKind } from "./entity.ts";
import { Vector2 } from "./vector.ts";

export interface HomingOptions {
  targetKinds: readonly EntityKind[];
  turnRate: number;
  range?: number;
  ignore?: Entity | null;
}

// Homing is a behavior, not a class. It can be attached to a bullet, to an
// asteroid, or to anything else that has a velocity, without a new subclass.
export function homing({
  targetKinds,
  turnRate,
  range = 450,
  ignore = null,
}: HomingOptions): Behavior {
  return (self, dt) => {
    const speed = self.vel.length();
    if (speed === 0 || !self.world) return;

    let target: Entity | null = null;
    let best = range;
    for (const kind of targetKinds) {
      for (const other of self.world.ofKind(kind)) {
        if (!other.alive || other === ignore) continue;
        const dist = other.pos.sub(self.pos).length();
        if (dist < best) {
          best = dist;
          target = other;
        }
      }
    }
    if (!target) return;

    const want = target.pos.sub(self.pos);
    const current = atan2(self.vel.y, self.vel.x);
    const diff = normalizeAngle(atan2(want.y, want.x) - current); // to [-PI, PI]
    const turn = Math.max(-turnRate * dt, Math.min(turnRate * dt, diff));

    self.vel = Vector2.fromAngle(current + turn, speed);
    self.angle = current + turn;
  };
}

export function withHoming<T extends Entity>(entity: T, options: HomingOptions): T {
  entity.behaviors.push(homing(options));
  entity.parts.homing = true;
  return entity;
}
