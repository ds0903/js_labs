import assert from "node:assert/strict";
import * as binary from "shared/codec/binary";
import { getCodec } from "shared/codec/index";
import * as json from "shared/codec/json";
import { applyCommand, createMatch, DT } from "shared/sim/match";
import { snapshotWorld } from "shared/sim/snapshot";
import { test } from "vitest";

// a busy world: 4 ships, asteroids, pickups, bullets
function busySnapshot() {
  const { world, addShip } = createMatch({ arena: "classic", seed: 5 });
  const players = [0, 1, 2, 3].map((i) => addShip(i, `P${i}`));
  for (let step = 0; step < 150; step++) {
    players.forEach(({ ship, input }, i) => {
      applyCommand(ship, input, {
        seq: step + 1,
        tick: step,
        thrust: step % 40 < 25,
        turn: (Math.floor(step / 10 + i) % 3) - 1,
        fire: step % 12 === i,
      });
    });
    world.step(DT);
  }
  return snapshotWorld(world, 150, 150);
}

// tolerances follow the quantization in binary.js
const TOLERANCE = {
  x: 0.01,
  y: 0.01,
  angle: 0.0006,
  vx: 0.06,
  vy: 0.06,
  radius: 0.51,
  cooldown: 0.003,
  grace: 0.06,
  shield: 0.06,
  rapid: 0.06,
  homing: 0.06,
};

function assertSnapshotsClose(actual, expected) {
  assert.equal(actual.tick, expected.tick);
  assert.equal(actual.ack, expected.ack);
  assert.equal(actual.entities.length, expected.entities.length);
  expected.entities.forEach((want, i) => {
    const got = actual.entities[i];
    for (const [key, value] of Object.entries(want)) {
      if (typeof value === "number" && key in TOLERANCE) {
        assert.ok(
          Math.abs(got[key] - value) <= TOLERANCE[key],
          `entity ${i} ${key}: ${got[key]} vs ${value}`,
        );
      } else {
        assert.deepEqual(got[key], value, `entity ${i} ${key}`);
      }
    }
  });
}

test("binary snapshot round trip is equal within the quantization", () => {
  const snap = busySnapshot();
  const kinds = new Set(snap.entities.map((e) => e.kind));
  assert.ok(kinds.has("ship") && kinds.has("bullet") && kinds.has("asteroid"));
  assertSnapshotsClose(binary.decodeSnapshot(binary.encodeSnapshot(snap)), snap);
});

test("json snapshot round trip is exact", () => {
  const snap = busySnapshot();
  assert.deepEqual(json.decodeSnapshot(json.encodeSnapshot(snap)), snap);
});

test("pickups survive the binary round trip", () => {
  const snap = {
    tick: 1,
    ack: 0,
    entities: [
      {
        id: 9,
        kind: "pickup",
        x: 10,
        y: 20,
        vx: 0,
        vy: 0,
        angle: 0,
        radius: 14,
        effect: "rapid",
      },
    ],
  };
  assert.deepEqual(
    binary.decodeSnapshot(binary.encodeSnapshot(snap)).entities[0].effect,
    "rapid",
  );
});

test("input round trip, both codecs", () => {
  const cmd = { seq: 4_000_000_000, tick: 123456, thrust: true, turn: -1, fire: false };
  assert.deepEqual(binary.decodeInput(binary.encodeInput(cmd)), cmd);
  assert.deepEqual(json.decodeInput(json.encodeInput(cmd)), cmd);
  const other = { seq: 0, tick: 0, thrust: false, turn: 1, fire: true };
  assert.deepEqual(binary.decodeInput(binary.encodeInput(other)), other);
});

test("the layout is little-endian and matches the written spec", () => {
  const bytes = new Uint8Array(
    binary.encodeInput({
      seq: 0x01020304,
      tick: 0x0a0b0c0d,
      thrust: true,
      turn: -1,
      fire: true,
    }),
  );
  assert.deepEqual([...bytes], [1, 1, 4, 3, 2, 1, 13, 12, 11, 10, 0b11, 255]);
  assert.equal(bytes.length, 12);

  const snap = busySnapshot();
  const expected =
    12 +
    snap.entities.reduce(
      (n, e) => n + { ship: 27, bullet: 23, asteroid: 19, pickup: 20 }[e.kind],
      0,
    );
  assert.equal(binary.encodeSnapshot(snap).byteLength, expected);
});

test("angle is quantized to 1/1000 rad, which is under 0.04 degrees", () => {
  const snap = {
    tick: 0,
    ack: 0,
    entities: [
      {
        id: 1,
        kind: "asteroid",
        x: 0,
        y: 0,
        vx: 0,
        vy: 0,
        angle: 1.23456789,
        radius: 20,
        hunter: false,
      },
    ],
  };
  const angle = binary.decodeSnapshot(binary.encodeSnapshot(snap)).entities[0].angle;
  assert.equal(angle, 1.235);
  assert.ok(Math.abs(angle - 1.23456789) <= 0.0005);
});

test("decoding rejects garbage instead of returning nonsense", () => {
  const good = binary.encodeSnapshot(busySnapshot());
  assert.throws(() => binary.decodeSnapshot(good.slice(0, 20)), /truncated|short/);
  assert.throws(() => binary.decodeSnapshot(new ArrayBuffer(0)), binary.CodecError);
  assert.throws(() => binary.decodeInput(new ArrayBuffer(11)), binary.CodecError);
  assert.throws(
    () => binary.decodeInput(binary.encodeSnapshot(busySnapshot())),
    /wrong frame type/,
  );

  const wrongVersion = new Uint8Array(
    binary.encodeInput({ seq: 1, tick: 0, thrust: false, turn: 0, fire: false }),
  );
  wrongVersion[1] = 9;
  assert.throws(() => binary.decodeInput(wrongVersion), /version/);

  const unknownKind = new Uint8Array(binary.encodeSnapshot(busySnapshot()));
  unknownKind[12 + 2] = 77;
  assert.throws(() => binary.decodeSnapshot(unknownKind), /unknown kind/);
});

test("a Buffer with an offset (as ws delivers it) decodes the same", () => {
  const cmd = { seq: 7, tick: 8, thrust: false, turn: 1, fire: true };
  const padded = new Uint8Array(20);
  padded.set(new Uint8Array(binary.encodeInput(cmd)), 5);
  assert.deepEqual(binary.decodeInput(padded.subarray(5, 17)), cmd);
});

test("getCodec finds both codecs, and each refuses the other's frames", () => {
  assert.equal(getCodec("binary").binary, true);
  assert.equal(getCodec("json").binary, false);
  // an unknown codec name never gets this far: the join schema rejects it
  const cmd = { seq: 1, tick: 2, thrust: true, turn: 0, fire: false };
  for (const codec of [getCodec("binary"), getCodec("json")]) {
    assert.deepEqual(codec.decodeInput(codec.encodeInput(cmd)), cmd);
  }
  assert.throws(() => getCodec("binary").decodeInput("text"), binary.CodecError);
  assert.throws(() => getCodec("json").decodeInput(new ArrayBuffer(12)));
});

test("decoders check ranges, not only lengths", () => {
  const input = new Uint8Array(
    binary.encodeInput({ seq: 1, tick: 0, thrust: false, turn: 0, fire: false }),
  );
  input[11] = 2; // turn must be -1, 0 or 1
  assert.throws(() => binary.decodeInput(input), /bad turn/);

  const snap = new Uint8Array(binary.encodeSnapshot(busySnapshot()));
  assert.throws(() => binary.decodeSnapshot(snap.slice(0, snap.length - 1)), /truncated/);
  const longer = new Uint8Array(snap.length + 1);
  longer.set(snap);
  assert.throws(() => binary.decodeSnapshot(longer), /trailing/);

  // JSON: the schema is the validator, a missing or foreign field throws
  assert.throws(() => json.decodeInput('{"type":"input","seq":1}'));
  assert.throws(() =>
    json.decodeInput(
      '{"type":"input","seq":1,"tick":0,"thrust":false,"turn":5,"fire":false}',
    ),
  );
});

test("typed array versus DataView: the same bytes read two ways", () => {
  const buffer = new ArrayBuffer(8);
  const view = new DataView(buffer);
  view.setFloat32(0, 1.5, true);
  assert.deepEqual([...new Uint8Array(buffer, 0, 4)], [0, 0, 192, 63]);
  view.setFloat32(0, 1.5, false);
  assert.deepEqual([...new Uint8Array(buffer, 0, 4)], [63, 192, 0, 0]);
  // a typed array always uses the machine's byte order, DataView takes it as an argument
  assert.deepEqual([...new Uint16Array(new Uint8Array([1, 0, 0, 1]).buffer)], [1, 256]);
});
