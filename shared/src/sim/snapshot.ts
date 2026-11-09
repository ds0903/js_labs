// What a snapshot says about the world. Plain data only (numbers, booleans,
// strings), so it can be cloned, sent as JSON or packed with DataView.
//
// Ids in snapshots are 16 bits (id & 0xffff): that is what the binary format
// has room for, and the JSON format follows it so both behave the same.
import { id16, type Seq, type Tick } from "../brand.ts";
import type { Snapshot, SnapshotEntity } from "../protocol.ts";
import { normalizeAngle } from "./dmath.ts";
import type { Entity } from "./entity.ts";
import { isKind, type World } from "./world.ts";

export { id16, normalizeAngle };

export const KIND = { ship: 1, bullet: 2, asteroid: 3, pickup: 4 } as const;
export const KIND_NAMES: readonly (SnapshotEntity["kind"] | null)[] = [
  null,
  "ship",
  "bullet",
  "asteroid",
  "pickup",
];

// null for what a snapshot does not carry: particles are drawn by the client
// from events
export function describe(e: Entity): SnapshotEntity | null {
  const base = {
    id: id16(e.id),
    x: e.pos.x,
    y: e.pos.y,
    vx: e.vel.x,
    vy: e.vel.y,
    // angles grow without limit inside the simulation, a snapshot keeps (-pi, pi]
    angle: normalizeAngle(e.angle),
    radius: e.radius,
  };
  if (isKind(e, "ship")) {
    return {
      ...base,
      kind: "ship",
      thrusting: e.thrusting,
      hp: e.hp,
      cooldown: e.cooldown,
      grace: e.grace,
      shield: e.effects.shield,
      rapid: e.effects.rapid,
      homing: e.effects.homing,
      score: e.score,
    };
  }
  if (isKind(e, "bullet")) {
    return {
      ...base,
      kind: "bullet",
      owner: id16(e.owner.id),
      srcSeq: e.srcSeq & 0xffff,
      homing: Boolean(e.parts.homing),
    };
  }
  if (isKind(e, "asteroid")) {
    return { ...base, kind: "asteroid", hunter: Boolean(e.parts.homing) };
  }
  if (isKind(e, "pickup") && e.parts.pickup) {
    return { ...base, kind: "pickup", effect: e.parts.pickup.effect };
  }
  return null;
}

// `ack` is the last input seq the server applied for the player this
// snapshot is for; the server fills it in per client.
export function snapshotWorld(world: World, tick: Tick, ack: Seq): Snapshot {
  const entities: SnapshotEntity[] = [];
  for (const e of world) {
    if (!e.alive) continue;
    const d = describe(e);
    if (d) entities.push(d);
  }
  return { tick, ack, entities };
}
