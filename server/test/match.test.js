import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeSnapshot, encodeInput } from "shared/codec/binary";
import * as jsonCodec from "shared/codec/json";
import { commandInput, NET_CONTROLS, NEUTRAL } from "shared/sim/commands";
import { applyCommand, DT } from "shared/sim/match";
import { Ship } from "shared/sim/ship";
import { describe } from "shared/sim/snapshot";
import { Match } from "../src/match.js";
import { createNetSim } from "../src/netsim.js";
import { Room } from "../src/rooms.js";
import { closed, connect, createRoom, join, startApp, until } from "./helpers.js";

function setup(options = {}) {
  const room = new Room({ id: "r", name: "R", arena: "duel" });
  const match = new Match(room, options);
  const player = (id, codec = "json") => {
    const frames = [];
    return { id, name: id, codec, frames, send() {}, sendGame: (f) => frames.push(f) };
  };
  return { room, match, player };
}

const cmd = (seq, extra = {}) => ({ ...NEUTRAL, seq, ...extra });
const lastSnapshot = (p) => jsonCodec.decodeSnapshot(p.frames.at(-1));

test("match: one input is applied per tick and acknowledged by seq", () => {
  const { room, match, player } = setup();
  const p = player("a");
  room.join(p);
  for (let seq = 1; seq <= 3; seq++) match.input("a", cmd(seq, { thrust: true }));

  match.runTick();
  assert.equal(lastSnapshot(p).ack, 1);
  match.runTick();
  assert.equal(lastSnapshot(p).ack, 2);
  assert.equal(lastSnapshot(p).tick, 2);
  match.stop();
});

test("match: old and duplicate inputs are ignored", () => {
  const { room, match, player } = setup();
  room.join(player("a"));
  assert.equal(match.input("a", cmd(5)), true);
  assert.equal(match.input("a", cmd(5)), false);
  assert.equal(match.input("a", cmd(4)), false);
  assert.equal(match.input("nobody", cmd(6)), false);
  match.stop();
});

test("match: with no input the ship does not move and the ack stays", () => {
  const { room, match, player } = setup();
  const p = player("a");
  room.join(p);
  match.input("a", cmd(1, { thrust: true }));
  match.runTick();
  const moved = lastSnapshot(p).entities.find((e) => e.kind === "ship");
  match.runTick(); // nothing in the queue
  const still = lastSnapshot(p).entities.find((e) => e.kind === "ship");
  assert.equal(lastSnapshot(p).ack, 1);
  assert.deepEqual(
    [still.x, still.y, still.vx, still.vy],
    [moved.x, moved.y, moved.vx, moved.vy],
  );
  assert.equal(match.stats().starvedTicks, 1);
  match.stop();
});

test("match: a burst beyond the queue limit is caught up with ship-only steps", () => {
  const { room, match, player } = setup({ maxInputQueue: 3 });
  const p = player("a");
  room.join(p);
  for (let seq = 1; seq <= 8; seq++) match.input("a", cmd(seq, { thrust: true }));
  match.runTick();
  assert.equal(lastSnapshot(p).ack, 6); // 5 caught up, 1 normal step, 2 stay in the queue
  assert.equal(match.stats().catchUpSteps, 5);
  match.stop();
});

test("match: a client that sends far more than 30 inputs per second is throttled", () => {
  const { room, match, player } = setup({ maxInputQueue: 3 });
  const p = player("a");
  room.join(p);
  let seq = 0;
  for (let tick = 0; tick < 60; tick++) {
    for (let i = 0; i < 3; i++) match.input("a", cmd(++seq, { thrust: true })); // 90/s
    match.runTick();
  }
  const { discardedInputs } = match.stats();
  assert.ok(discardedInputs > 50, `discarded ${discardedInputs}`); // about 2 of every 3 are ignored
  match.stop();
});

test("match: the server and a client that replays the same inputs agree exactly", () => {
  const { room, match, player } = setup();
  const p = player("a");
  room.join(p);

  // the "client": its own ship, put where the server's ship starts
  const input = commandInput();
  const mine = new Ship({ input, controls: NET_CONTROLS });
  mine.restore(describe(match.players.get("a").ship));

  for (let step = 0; step < 120; step++) {
    const c = cmd(step + 1, {
      thrust: step % 40 < 30,
      turn: (Math.floor(step / 15) % 3) - 1,
    });
    match.input("a", c);
    match.runTick();
    applyCommand(mine, input, c);
    mine.update(DT);
  }
  const server = lastSnapshot(p).entities.find((e) => e.kind === "ship");
  const wrapped = (a, b, size) => Math.min(Math.abs(a - b), size - Math.abs(a - b));
  assert.ok(wrapped(server.x, mine.pos.x, 1600) < 1e-9, `x ${server.x} vs ${mine.pos.x}`);
  assert.ok(wrapped(server.y, mine.pos.y, 900) < 1e-9, `y ${server.y} vs ${mine.pos.y}`);
  match.stop();
});

test("match: binary players get binary snapshots, json players get text", () => {
  const { room, match, player } = setup();
  const a = player("a", "binary");
  const b = player("b", "json");
  room.join(a);
  room.join(b);
  match.runTick();
  assert.ok(a.frames[0] instanceof ArrayBuffer);
  assert.equal(typeof b.frames[0], "string");
  assert.equal(
    decodeSnapshot(a.frames[0]).entities.length,
    jsonCodec.decodeSnapshot(b.frames[0]).entities.length,
  );
  match.stop();
});

test("match: leaving removes the ship, the last player stops the timer", () => {
  const { room, match, player } = setup();
  const a = player("a");
  const b = player("b");
  room.join(a);
  room.join(b);
  match.runTick();
  assert.equal(lastSnapshot(a).entities.filter((e) => e.kind === "ship").length, 2);
  room.leave("b");
  match.runTick();
  assert.equal(lastSnapshot(a).entities.filter((e) => e.kind === "ship").length, 1);
  room.leave("a");
  assert.equal(match.players.size, 0);
});

test("match: ticks keep the schedule and the stats show tick time and jitter", async () => {
  const { room, match, player } = setup();
  room.join(player("a"));
  await new Promise((resolve) => setTimeout(resolve, 700));
  const stats = match.stats();
  match.stop();
  assert.ok(stats.tick >= 15 && stats.tick <= 24, `ticks in 0.7 s: ${stats.tick}`);
  assert.ok(stats.tickMs.avg < 5);
  assert.ok(stats.jitterMs.avg < 20);
  assert.equal(stats.overruns, 0);
});

test("netsim: delays by half the latency each way, keeps order, drops only droppable frames", async () => {
  const randoms = [0.99, 1, 0, 0.1];
  const net = createNetSim(
    { latency: 100, jitter: 40, drop: 50 },
    { now: () => 0, random: () => randoms.shift() },
  );
  const seen = [];
  // drop check 0.99 -> kept; wait random 1 -> 50 + 20 = 70 ms
  net.run("out", () => seen.push("first"), { droppable: true });
  // wait random 0 -> 50 - 20 = 30 ms, but it must not overtake the first one
  net.run("out", () => seen.push("second"));
  // drop check 0.1 < 50 -> lost, never runs
  net.run("out", () => seen.push("lost"), { droppable: true });
  assert.equal(net.active, true);
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.deepEqual(seen, ["first", "second"]);

  const off = createNetSim();
  let ran = false;
  off.run("in", () => {
    ran = true;
  });
  assert.equal(ran, true); // inactive: runs right away
});

test("server: binary inputs move the ship, snapshots carry the ack, ping gets a pong", async () => {
  const { app, base, port } = await startApp({ MAX_PLAYERS: "4" });
  try {
    const room = await createRoom(base, "Flight");
    const ws = await connect(port);
    join(ws, room.id, "Ann");
    await until(() => ws.messages.some((m) => m.type === "welcome"));
    const welcome = ws.messages.find((m) => m.type === "welcome");
    assert.equal(welcome.tickRate, 30);
    assert.ok(Number.isInteger(welcome.ship));

    for (let seq = 1; seq <= 10; seq++) {
      ws.send(encodeInput({ seq, tick: 0, thrust: true, turn: 1, fire: false }));
      await new Promise((resolve) => setTimeout(resolve, 34));
    }
    await until(
      () => ws.frames.length > 0 && decodeSnapshot(ws.frames.at(-1)).ack === 10,
    );
    const snap = decodeSnapshot(ws.frames.at(-1));
    const me = snap.entities.find((e) => e.id === welcome.ship);
    assert.ok(me && Math.hypot(me.vx, me.vy) > 10, "the ship picked up speed");

    ws.send(JSON.stringify({ type: "ping", t: 123 }));
    await until(() => ws.messages.some((m) => m.type === "pong"));
    assert.equal(ws.messages.find((m) => m.type === "pong").t, 123);

    const stats = await (await fetch(`${base}/api/stats`)).json();
    assert.equal(stats.rooms[0].players, 1);
    assert.ok(stats.rooms[0].tickMs.avg >= 0 && stats.rooms[0].tick > 5);
    ws.close();
  } finally {
    await app.close();
  }
});

test("server: the json codec works over text frames", async () => {
  const { app, base, port } = await startApp();
  try {
    const room = await createRoom(base);
    const ws = await connect(port);
    ws.send(
      JSON.stringify({ type: "join", v: 1, room: room.id, name: "Ann", codec: "json" }),
    );
    await until(() => ws.messages.some((m) => m.type === "welcome"));
    ws.send(JSON.stringify({ type: "input", ...cmd(1, { thrust: true }) }));
    await until(() => ws.messages.some((m) => m.type === "snapshot" && m.ack === 1));
    assert.equal(ws.frames.length, 0, "no binary frames for a json client");
    ws.close();
  } finally {
    await app.close();
  }
});

test("server: invalid inputs close the socket", async () => {
  const { app, base, port } = await startApp();
  try {
    const room = await createRoom(base);
    // somebody stays in the room, an empty room is removed
    const anchor = await connect(port);
    join(anchor, room.id, "Anchor");
    await until(() => anchor.messages.some((m) => m.type === "welcome"));
    const expectClose = async (send, code) => {
      const ws = await connect(port);
      join(ws, room.id, "Cheat");
      await until(() => ws.messages.some((m) => m.type === "welcome"));
      const result = closed(ws);
      send(ws);
      assert.equal((await result).code, code);
    };
    await expectClose((ws) => ws.send(Buffer.from([1, 1, 0])), 4400); // too short
    await expectClose(
      (ws) => ws.send(Buffer.from([9, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])),
      4400,
    ); // wrong type
    const turn1000 = Buffer.from(encodeInput(cmd(1)));
    turn1000[11] = 100; // turn = 100
    await expectClose((ws) => ws.send(turn1000), 4400);
    await expectClose(
      (ws) => ws.send(JSON.stringify({ type: "input", ...cmd(1), turn: 1000 })),
      4400,
    );
    await expectClose(
      (ws) =>
        ws.send(JSON.stringify({ type: "netsim", latency: 100, jitter: 0, drop: 0 })),
      4401,
    );
    anchor.close();
  } finally {
    await app.close();
  }
});

test("server: inputs are rate limited separately from chat", async () => {
  const { app, base, port } = await startApp({ INPUT_RATE_PER_SEC: "40" });
  try {
    const room = await createRoom(base);
    const ws = await connect(port);
    join(ws, room.id, "Flood");
    await until(() => ws.messages.some((m) => m.type === "welcome"));
    const result = closed(ws);
    for (let seq = 1; seq <= 100; seq++) ws.send(encodeInput(cmd(seq)));
    assert.equal((await result).code, 4429);
  } finally {
    await app.close();
  }
});

test("server: the latency injector adds to the round trip when it is enabled", async () => {
  const { app, base, port } = await startApp({ ENABLE_NETSIM: "1" });
  try {
    const room = await createRoom(base);
    const rtt = async (ws) => {
      const t = performance.now();
      ws.send(JSON.stringify({ type: "ping", t }));
      const before = ws.messages.filter((m) => m.type === "pong").length;
      await until(() => ws.messages.filter((m) => m.type === "pong").length > before);
      return performance.now() - t;
    };
    const plain = await connect(port);
    join(plain, room.id, "Plain");
    const slow = await connect(port, undefined, "?lat=200");
    join(slow, room.id, "Slow");
    await until(() => slow.messages.some((m) => m.type === "welcome"));

    const fast = await rtt(plain);
    const slowRtt = await rtt(slow);
    assert.ok(slowRtt >= 190, `rtt with lat=200: ${slowRtt}`);
    assert.ok(fast < 100, `rtt without: ${fast}`);

    slow.send(JSON.stringify({ type: "netsim", latency: 0, jitter: 0, drop: 0 })); // live toggle
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.ok((await rtt(slow)) < 100);
    plain.close();
    slow.close();
  } finally {
    await app.close();
  }
});
