import assert from "node:assert/strict";
import fc from "fast-check";
import * as binary from "shared/codec/binary";
import * as json from "shared/codec/json";
import { PROTOCOL_VERSION, parseClientMessage, SnapshotSchema } from "shared/protocol";
import { ARENA } from "shared/sim/arena";
import { applyCommand, createMatch, DT } from "shared/sim/match";
import { snapshotWorld } from "shared/sim/snapshot";
import { expect, test } from "vitest";

// Property tests: instead of a few examples, state a rule and let fast-check try
// hundreds of generated inputs. When one fails it shrinks it to a small case.

const RUNS = { numRuns: 200 };

const u32 = fc.integer({ min: 0, max: 0xffffffff });
const u16 = fc.integer({ min: 0, max: 0xffff });

// fc.record may build objects without a prototype; deepStrictEqual compares prototypes
const command = fc
  .record({
    seq: u32,
    tick: u32,
    thrust: fc.boolean(),
    turn: fc.constantFrom(-1, 0, 1),
    fire: fc.boolean(),
  })
  .map((cmd) => ({ ...cmd }));

// ---- entities, with values in the ranges the quantization is made for
const body = {
  id: u16,
  x: fc.float({ min: 0, max: ARENA.width, noNaN: true }), // float32 in, float32 out: exact
  y: fc.float({ min: 0, max: ARENA.height, noNaN: true }),
  vx: fc.double({ min: -3000, max: 3000, noNaN: true }),
  vy: fc.double({ min: -3000, max: 3000, noNaN: true }),
  angle: fc.double({ min: -Math.PI, max: Math.PI, noNaN: true }),
  radius: fc.integer({ min: 1, max: 60 }),
};

const entity = fc.oneof(
  fc.record({
    ...body,
    kind: fc.constant("ship"),
    thrusting: fc.boolean(),
    hp: fc.integer({ min: 0, max: 100 }),
    cooldown: fc.double({ min: 0, max: 1, noNaN: true }),
    grace: fc.double({ min: 0, max: 20, noNaN: true }),
    shield: fc.double({ min: 0, max: 20, noNaN: true }),
    rapid: fc.double({ min: 0, max: 20, noNaN: true }),
    homing: fc.double({ min: 0, max: 20, noNaN: true }),
    score: fc.integer({ min: 0, max: 65535 }),
  }),
  fc.record({
    ...body,
    kind: fc.constant("bullet"),
    owner: u16,
    srcSeq: u16,
    homing: fc.boolean(),
  }),
  fc.record({ ...body, kind: fc.constant("asteroid"), hunter: fc.boolean() }),
  fc.record({
    ...body,
    kind: fc.constant("pickup"),
    effect: fc.constantFrom("shield", "rapid", "homing"),
  }),
);

const snapshot = fc.record({
  tick: u32,
  ack: u32,
  entities: fc.array(entity, { maxLength: 30 }),
});

const SIZE = { ship: 27, bullet: 23, asteroid: 19, pickup: 20 };
const TOLERANCE = {
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

test("property: a binary input decodes to what was encoded, in exactly 12 bytes", () => {
  fc.assert(
    fc.property(command, (cmd) => {
      const bytes = binary.encodeInput(cmd);
      assert.equal(bytes.byteLength, 12);
      assert.deepEqual(binary.decodeInput(bytes), cmd);
    }),
    RUNS,
  );
});

test("property: a json input round trip is exact", () => {
  fc.assert(
    fc.property(command, (cmd) => {
      assert.deepEqual(json.decodeInput(json.encodeInput(cmd)), cmd);
    }),
    RUNS,
  );
});

test("property: a binary snapshot is as long as the spec says and decodes within the quantization", () => {
  fc.assert(
    fc.property(snapshot, (snap) => {
      const bytes = binary.encodeSnapshot(snap);
      const expected = 12 + snap.entities.reduce((n, e) => n + SIZE[e.kind], 0);
      assert.equal(bytes.byteLength, expected);

      const back = binary.decodeSnapshot(bytes);
      assert.equal(back.tick, snap.tick);
      assert.equal(back.ack, snap.ack);
      assert.equal(back.entities.length, snap.entities.length);
      snap.entities.forEach((want, i) => {
        const got = back.entities[i];
        for (const [key, value] of Object.entries(want)) {
          if (key in TOLERANCE) {
            assert.ok(
              Math.abs(got[key] - value) <= TOLERANCE[key],
              `${want.kind} ${key}: ${got[key]} vs ${value}`,
            );
          } else if (key === "x" || key === "y") {
            assert.equal(got[key], Math.fround(value));
          } else {
            assert.deepEqual(got[key], value, `${want.kind} ${key}`);
          }
        }
      });
    }),
    RUNS,
  );
});

test("property: random bytes never crash the snapshot or input decoder, only CodecError", () => {
  fc.assert(
    fc.property(fc.uint8Array({ maxLength: 300 }), (bytes) => {
      for (const decode of [binary.decodeSnapshot, binary.decodeInput]) {
        try {
          decode(bytes);
        } catch (error) {
          assert.ok(error instanceof binary.CodecError, `threw ${error}`);
        }
      }
    }),
    { numRuns: 1000 },
  );
});

test("property: a valid snapshot with one byte changed is refused or still valid, never nonsense", () => {
  fc.assert(
    fc.property(
      snapshot,
      fc.nat(),
      fc.integer({ min: 0, max: 255 }),
      (snap, at, value) => {
        const bytes = new Uint8Array(binary.encodeSnapshot(snap));
        bytes[at % bytes.length] = value;
        try {
          const back = binary.decodeSnapshot(bytes);
          // what came out must satisfy the same schema as everything else
          assert.ok(SnapshotSchema.safeParse(back).success);
        } catch (error) {
          assert.ok(error instanceof binary.CodecError, `threw ${error}`);
        }
      },
    ),
    { numRuns: 500 },
  );
});

// ---- the protocol parser

const roomId = fc.stringMatching(/^[A-Za-z0-9_-]{1,40}$/);
const word = (max) => fc.stringMatching(new RegExp(`^[A-Za-z0-9 ]{1,${max}}$`));

const validMessage = fc.oneof(
  fc.record({
    type: fc.constant("join"),
    v: fc.constant(PROTOCOL_VERSION),
    room: roomId,
    name: word(16),
  }),
  fc.record({ type: fc.constant("chat"), text: word(200) }),
  fc.record({
    type: fc.constant("ping"),
    t: fc.double({ min: 0, max: 1e12, noNaN: true }),
  }),
  fc.record({
    type: fc.constant("netsim"),
    latency: fc.integer({ min: 0, max: 2000 }),
    jitter: fc.integer({ min: 0, max: 1000 }),
    drop: fc.integer({ min: 0, max: 50 }),
  }),
);

// ways to break a valid message
const mutation = fc.constantFrom(
  "extra key",
  "drop a field",
  "wrong type of field",
  "unknown type",
);

function mutate(message, how) {
  const copy = { ...message };
  const key = Object.keys(copy).find((k) => k !== "type") ?? "type";
  if (how === "extra key") copy.admin = true;
  else if (how === "drop a field") delete copy[key];
  else if (how === "wrong type of field") copy[key] = { not: "a scalar" };
  else copy.type = "teleport";
  return copy;
}

test("property: parseClientMessage accepts every generated valid message", () => {
  fc.assert(
    fc.property(validMessage, (message) => {
      const result = parseClientMessage(message);
      assert.ok(result.ok, JSON.stringify(result));
    }),
    RUNS,
  );
});

test("property: parseClientMessage rejects every mutation of a valid message", () => {
  fc.assert(
    fc.property(validMessage, mutation, (message, how) => {
      assert.equal(parseClientMessage(mutate(message, how)).ok, false, how);
    }),
    RUNS,
  );
});

// ---- the simulation

const inputs = fc.array(
  fc.record({
    thrust: fc.boolean(),
    turn: fc.constantFrom(-1, 0, 1),
    fire: fc.boolean(),
  }),
  { minLength: 1000, maxLength: 1000 },
);

function drive(seed, steps) {
  const { world, addShip } = createMatch({ arena: "duel", seed });
  const { ship, input } = addShip(0, "A");
  const positions = [];
  steps.forEach((s, i) => {
    applyCommand(ship, input, { seq: i + 1, tick: i, ...s });
    world.step(DT);
    positions.push([ship.pos.x, ship.pos.y]);
  });
  return { world, positions };
}

test("property: a ship stays inside the arena over 1000 random input steps", () => {
  fc.assert(
    fc.property(inputs, fc.integer({ min: 1, max: 1000 }), (steps, seed) => {
      for (const [x, y] of drive(seed, steps).positions) {
        assert.ok(x >= 0 && x <= ARENA.width && y >= 0 && y <= ARENA.height, `${x},${y}`);
      }
    }),
    { numRuns: 15 },
  );
});

// Entity ids come from one counter for the whole process (Entity.#nextId), so two
// identical worlds built one after the other get different ids. The state of the
// world is what must match, so ids and owners are left out of the comparison.
const withoutIds = (snap) =>
  snap.entities.map(({ id, owner, ...rest }) => rest).sort((a, b) => a.x - b.x);

test("property: the simulation is deterministic, the same seed and inputs give the same world", () => {
  fc.assert(
    fc.property(inputs, fc.integer({ min: 1, max: 1000 }), (steps, seed) => {
      const a = drive(seed, steps);
      const b = drive(seed, steps);
      assert.deepEqual(a.positions, b.positions);
      expect(withoutIds(snapshotWorld(a.world, 0, 0))).toEqual(
        withoutIds(snapshotWorld(b.world, 0, 0)),
      );
    }),
    { numRuns: 10 },
  );
});
