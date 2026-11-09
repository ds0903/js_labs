import { entityId, seq, tick } from "../brand.ts";
import { type Command, MSG, PROTOCOL_VERSION, type Snapshot, type SnapshotEntity } from "../protocol.ts";
import { PICKUP_EFFECTS } from "../sim/effects.ts";
import { KIND, KIND_NAMES } from "../sim/snapshot.ts";

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
//
// A decoder is a validator: it checks the length, the type, the version, the
// kind, the effect index, the turn and that positions are finite numbers, and
// throws CodecError for anything else. What it returns has the right type.
export const name = "binary";
export const binary = true;

const HEADER = 12;
const INPUT_SIZE = 12;
const COMMON = 19;
const SIZE = { ship: 27, bullet: 23, asteroid: 19, pickup: 20 } as const;
const LE = true;

export class CodecError extends Error {
  override name = "CodecError";
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const quant = (v: number, scale: number, lo: number, hi: number) =>
  clamp(Math.round(v * scale), lo, hi);

// ArrayBuffer from a browser, Buffer (a Uint8Array with an offset) from ws
export type BinaryFrame = ArrayBuffer | ArrayBufferView;

const viewOf = (data: BinaryFrame): DataView =>
  ArrayBuffer.isView(data)
    ? new DataView(data.buffer, data.byteOffset, data.byteLength)
    : new DataView(data);

function checkHeader(v: DataView, type: number): void {
  if (v.byteLength < 2 || v.getUint8(0) !== type) throw new CodecError("wrong frame type");
  if (v.getUint8(1) !== PROTOCOL_VERSION) throw new CodecError("unsupported version");
}

export function encodeInput(cmd: Command): ArrayBuffer {
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

export function decodeInput(data: BinaryFrame): Command {
  const v = viewOf(data);
  checkHeader(v, MSG.INPUT);
  if (v.byteLength !== INPUT_SIZE) throw new CodecError("bad input length");
  const flags = v.getUint8(10);
  const turn = v.getInt8(11);
  if (turn !== -1 && turn !== 0 && turn !== 1) throw new CodecError("bad turn");
  return {
    seq: seq(v.getUint32(2, LE)),
    tick: tick(v.getUint32(6, LE)),
    thrust: (flags & 1) !== 0,
    fire: (flags & 2) !== 0,
    turn,
  };
}

export function encodeSnapshot(snap: Snapshot): ArrayBuffer {
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
    v.setUint16(o, e.id, LE);
    v.setUint8(o + 2, KIND[e.kind]);
    v.setUint8(o + 3, flagOf(e) ? 1 : 0);
    v.setFloat32(o + 4, e.x, LE);
    v.setFloat32(o + 8, e.y, LE);
    v.setInt16(o + 12, quant(e.angle, 1000, -32767, 32767), LE);
    v.setInt16(o + 14, quant(e.vx, 10, -32767, 32767), LE);
    v.setInt16(o + 16, quant(e.vy, 10, -32767, 32767), LE);
    v.setUint8(o + 18, quant(e.radius, 1, 0, 255));
    o += COMMON;

    switch (e.kind) {
      case "ship":
        v.setUint8(o, clamp(e.hp, 0, 255));
        v.setUint8(o + 1, quant(e.cooldown, 250, 0, 255));
        v.setUint8(o + 2, quant(e.grace, 10, 0, 255));
        v.setUint8(o + 3, quant(e.shield, 10, 0, 255));
        v.setUint8(o + 4, quant(e.rapid, 10, 0, 255));
        v.setUint8(o + 5, quant(e.homing, 10, 0, 255));
        v.setUint16(o + 6, clamp(e.score, 0, 65535), LE);
        o += 8;
        break;
      case "bullet":
        v.setUint16(o, e.owner, LE);
        v.setUint16(o + 2, e.srcSeq, LE);
        o += 4;
        break;
      case "asteroid":
        break;
      case "pickup":
        v.setUint8(o, PICKUP_EFFECTS.indexOf(e.effect));
        o += 1;
        break;
      default:
        return assertNever(e);
    }
  }
  return buffer;
}

// the one bit in the flags byte: thrusting / homing / hunter
function flagOf(e: SnapshotEntity): boolean {
  switch (e.kind) {
    case "ship":
      return e.thrusting;
    case "bullet":
      return e.homing;
    case "asteroid":
      return e.hunter;
    case "pickup":
      return false;
    default:
      return assertNever(e);
  }
}

function assertNever(value: never): never {
  throw new CodecError(`unhandled kind ${JSON.stringify(value)}`);
}

export function decodeSnapshot(data: BinaryFrame): Snapshot {
  const v = viewOf(data);
  checkHeader(v, MSG.SNAPSHOT);
  if (v.byteLength < HEADER) throw new CodecError("short snapshot");
  const count = v.getUint16(10, LE);
  const entities: SnapshotEntity[] = [];

  let o = HEADER;
  for (let i = 0; i < count; i++) {
    if (o + COMMON > v.byteLength) throw new CodecError("truncated snapshot");
    const kind = KIND_NAMES[v.getUint8(o + 2)];
    if (!kind) throw new CodecError("unknown kind");
    if (o + SIZE[kind] > v.byteLength) throw new CodecError("truncated snapshot");
    const flag = (v.getUint8(o + 3) & 1) !== 0;
    const body = {
      id: entityId(v.getUint16(o, LE)),
      x: v.getFloat32(o + 4, LE),
      y: v.getFloat32(o + 8, LE),
      vx: v.getInt16(o + 14, LE) / 10,
      vy: v.getInt16(o + 16, LE) / 10,
      angle: v.getInt16(o + 12, LE) / 1000,
      radius: v.getUint8(o + 18),
    };
    if (!Number.isFinite(body.x) || !Number.isFinite(body.y)) {
      throw new CodecError("position is not a number");
    }
    const r = o + COMMON; // start of the part that depends on the kind
    o += SIZE[kind];

    switch (kind) {
      case "ship":
        entities.push({
          ...body,
          kind,
          thrusting: flag,
          hp: v.getUint8(r),
          cooldown: v.getUint8(r + 1) / 250,
          grace: v.getUint8(r + 2) / 10,
          shield: v.getUint8(r + 3) / 10,
          rapid: v.getUint8(r + 4) / 10,
          homing: v.getUint8(r + 5) / 10,
          score: v.getUint16(r + 6, LE),
        });
        break;
      case "bullet":
        entities.push({
          ...body,
          kind,
          owner: entityId(v.getUint16(r, LE)),
          srcSeq: v.getUint16(r + 2, LE),
          homing: flag,
        });
        break;
      case "asteroid":
        entities.push({ ...body, kind, hunter: flag });
        break;
      case "pickup": {
        const effect = PICKUP_EFFECTS[v.getUint8(r)];
        if (!effect) throw new CodecError("unknown pickup effect");
        entities.push({ ...body, kind, effect });
        break;
      }
      default:
        return assertNever(kind);
    }
  }
  if (o !== v.byteLength) throw new CodecError("trailing bytes");
  return { tick: tick(v.getUint32(2, LE)), ack: seq(v.getUint32(6, LE)), entities };
}
