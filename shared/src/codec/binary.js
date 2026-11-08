import { MSG, PROTOCOL_VERSION } from "../protocol.js";
import { KIND, KIND_NAMES } from "../sim/snapshot.js";

// Space Arena binary protocol, version 1.
// Little-endian everywhere. Every frame starts with u8 type, u8 version.
//
// INPUT (client -> server), 12 bytes
//    0  u8   type = 1
//    1  u8   version
//    2  u32  seq      number of this input, counts up
//    6  u32  tick     newest server tick the client has seen
//   10  u8   flags    bit0 thrust, bit1 fire
//   11  i8   turn     -1, 0 or 1
//
// SNAPSHOT (server -> client), 12-byte header, then `count` records
//    0  u8   type = 2
//    1  u8   version
//    2  u32  tick     server tick of this snapshot
//    6  u32  ack      last input seq the server applied for this client
//   10  u16  count    number of records
//
// Record, common part, 19 bytes
//    0  u16  id       (16-bit protocol id)
//    2  u8   kind     1 ship, 2 bullet, 3 asteroid, 4 pickup
//    3  u8   flags    ship: bit0 thrusting. bullet: bit0 homing. asteroid: bit0 hunter
//    4  f32  x        arena units
//    8  f32  y
//   12  i16  angle    1/1000 rad, kept in (-pi, pi]: precision 0.0005 rad = 0.03 deg
//   14  i16  vx       1/10 arena units per second: range +-3276, bullets reach ~1180
//   16  i16  vy
//   18  u8   radius   rounded to whole units
// then, by kind:
//   ship (+8):     u8 hp, u8 cooldown (1/250 s), u8 grace (1/10 s),
//                  u8 shield, u8 rapid, u8 homing (1/10 s), u16 score
//   bullet (+4):   u16 owner, u16 srcSeq (low 16 bits of the input that fired it)
//   asteroid (+0)
//   pickup (+1):   u8 effect (0 shield, 1 rapid, 2 homing)
export const name = "binary";
export const binary = true;

const HEADER = 12;
const INPUT_SIZE = 12;
const SIZE = { ship: 27, bullet: 23, asteroid: 19, pickup: 20 };
const EFFECTS = ["shield", "rapid", "homing"];
const LE = true;

export class CodecError extends Error {
  name = "CodecError";
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const quant = (v, scale, lo, hi) => clamp(Math.round(v * scale), lo, hi);

// ArrayBuffer from a browser, Buffer (a Uint8Array with an offset) from ws
const viewOf = (data) =>
  ArrayBuffer.isView(data)
    ? new DataView(data.buffer, data.byteOffset, data.byteLength)
    : new DataView(data);

function checkHeader(v, type) {
  if (v.byteLength < 2 || v.getUint8(0) !== type)
    throw new CodecError("wrong frame type");
  if (v.getUint8(1) !== PROTOCOL_VERSION) throw new CodecError("unsupported version");
}

export function encodeInput(cmd) {
  const buffer = new ArrayBuffer(INPUT_SIZE);
  const v = new DataView(buffer);
  v.setUint8(0, MSG.INPUT);
  v.setUint8(1, PROTOCOL_VERSION);
  v.setUint32(2, cmd.seq, LE);
  v.setUint32(6, cmd.tick, LE);
  v.setUint8(10, (cmd.thrust ? 1 : 0) | (cmd.fire ? 2 : 0));
  v.setInt8(11, cmd.turn);
  return buffer;
}

export function decodeInput(data) {
  const v = viewOf(data);
  checkHeader(v, MSG.INPUT);
  if (v.byteLength !== INPUT_SIZE) throw new CodecError("bad input length");
  const flags = v.getUint8(10);
  return {
    seq: v.getUint32(2, LE),
    tick: v.getUint32(6, LE),
    thrust: (flags & 1) !== 0,
    fire: (flags & 2) !== 0,
    turn: v.getInt8(11),
  };
}

export function encodeSnapshot(snap) {
  let size = HEADER;
  for (const e of snap.entities) size += SIZE[e.kind];
  const buffer = new ArrayBuffer(size);
  const v = new DataView(buffer);

  v.setUint8(0, MSG.SNAPSHOT);
  v.setUint8(1, PROTOCOL_VERSION);
  v.setUint32(2, snap.tick, LE);
  v.setUint32(6, snap.ack, LE);
  v.setUint16(10, snap.entities.length, LE);

  let o = HEADER;
  for (const e of snap.entities) {
    const flag = { ship: e.thrusting, bullet: e.homing, asteroid: e.hunter }[e.kind];
    v.setUint16(o, e.id, LE);
    v.setUint8(o + 2, KIND[e.kind]);
    v.setUint8(o + 3, flag ? 1 : 0);
    v.setFloat32(o + 4, e.x, LE);
    v.setFloat32(o + 8, e.y, LE);
    v.setInt16(o + 12, quant(e.angle, 1000, -32767, 32767), LE);
    v.setInt16(o + 14, quant(e.vx, 10, -32767, 32767), LE);
    v.setInt16(o + 16, quant(e.vy, 10, -32767, 32767), LE);
    v.setUint8(o + 18, quant(e.radius, 1, 0, 255));
    o += 19;

    if (e.kind === "ship") {
      v.setUint8(o, clamp(e.hp, 0, 255));
      v.setUint8(o + 1, quant(e.cooldown, 250, 0, 255));
      v.setUint8(o + 2, quant(e.grace, 10, 0, 255));
      v.setUint8(o + 3, quant(e.shield, 10, 0, 255));
      v.setUint8(o + 4, quant(e.rapid, 10, 0, 255));
      v.setUint8(o + 5, quant(e.homing, 10, 0, 255));
      v.setUint16(o + 6, clamp(e.score, 0, 65535), LE);
      o += 8;
    } else if (e.kind === "bullet") {
      v.setUint16(o, e.owner, LE);
      v.setUint16(o + 2, e.srcSeq, LE);
      o += 4;
    } else if (e.kind === "pickup") {
      v.setUint8(o, EFFECTS.indexOf(e.effect));
      o += 1;
    }
  }
  return buffer;
}

export function decodeSnapshot(data) {
  const v = viewOf(data);
  checkHeader(v, MSG.SNAPSHOT);
  if (v.byteLength < HEADER) throw new CodecError("short snapshot");
  const snap = {
    tick: v.getUint32(2, LE),
    ack: v.getUint32(6, LE),
    entities: [],
  };
  const count = v.getUint16(10, LE);

  let o = HEADER;
  for (let i = 0; i < count; i++) {
    const kind = KIND_NAMES[v.getUint8(o + 2)];
    if (!kind) throw new CodecError("unknown kind");
    if (o + SIZE[kind] > v.byteLength) throw new CodecError("truncated snapshot");
    const flags = v.getUint8(o + 3);
    const e = {
      id: v.getUint16(o, LE),
      kind,
      x: v.getFloat32(o + 4, LE),
      y: v.getFloat32(o + 8, LE),
      angle: v.getInt16(o + 12, LE) / 1000,
      vx: v.getInt16(o + 14, LE) / 10,
      vy: v.getInt16(o + 16, LE) / 10,
      radius: v.getUint8(o + 18),
    };
    o += 19;

    if (kind === "ship") {
      e.thrusting = (flags & 1) !== 0;
      e.hp = v.getUint8(o);
      e.cooldown = v.getUint8(o + 1) / 250;
      e.grace = v.getUint8(o + 2) / 10;
      e.shield = v.getUint8(o + 3) / 10;
      e.rapid = v.getUint8(o + 4) / 10;
      e.homing = v.getUint8(o + 5) / 10;
      e.score = v.getUint16(o + 6, LE);
      o += 8;
    } else if (kind === "bullet") {
      e.owner = v.getUint16(o, LE);
      e.srcSeq = v.getUint16(o + 2, LE);
      e.homing = (flags & 1) !== 0;
      o += 4;
    } else if (kind === "asteroid") {
      e.hunter = (flags & 1) !== 0;
    } else {
      e.effect = EFFECTS[v.getUint8(o)];
      o += 1;
    }
    snap.entities.push(e);
  }
  return snap;
}
