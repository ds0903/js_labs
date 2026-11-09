// What a snapshot says about the world. Plain data only (numbers, booleans,
// strings), so it can be cloned, sent as JSON or packed with DataView.
//
// Ids in snapshots are 16 bits (id & 0xffff): that is what the binary format
// has room for, and the JSON format follows it so both behave the same.
import { normalizeAngle } from "./dmath.js";

export const KIND = { ship: 1, bullet: 2, asteroid: 3, pickup: 4 };
export const KIND_NAMES = [null, "ship", "bullet", "asteroid", "pickup"];

export const id16 = (id) => id & 0xffff;

// angles grow without limit inside the simulation, a snapshot keeps (-pi, pi]
export { normalizeAngle };

export function describe(e) {
  const base = {
    id: id16(e.id),
    kind: e.kind,
    x: e.pos.x,
    y: e.pos.y,
    vx: e.vel.x,
    vy: e.vel.y,
    angle: normalizeAngle(e.angle),
    radius: e.radius,
  };
  switch (e.kind) {
    case "ship":
      return {
        ...base,
        thrusting: e.thrusting,
        hp: e.hp,
        cooldown: e.cooldown,
        grace: e.grace,
        shield: e.effects.shield,
        rapid: e.effects.rapid,
        homing: e.effects.homing,
        score: e.score,
      };
    case "bullet":
      return {
        ...base,
        owner: id16(e.owner.id),
        srcSeq: (e.srcSeq ?? 0) & 0xffff,
        homing: Boolean(e.parts.homing),
      };
    case "asteroid":
      return { ...base, hunter: Boolean(e.parts.homing) };
    case "pickup":
      return { ...base, effect: e.parts.pickup.effect };
    default:
      return null; // particles are drawn by the client from events
  }
}

// `ack` is the last input seq the server applied for the player this
// snapshot is for; the server fills it in per client.
export function snapshotWorld(world, tick, ack = 0) {
  const entities = [];
  for (const e of world) {
    if (!e.alive) continue;
    const d = describe(e);
    if (d) entities.push(d);
  }
  return { tick, ack, entities };
}
