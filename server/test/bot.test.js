import assert from "node:assert/strict";
import { test } from "vitest";
import { Match } from "../src/match.ts";
import { Room } from "../src/rooms.ts";
import { connect, createRoom, join, startApp, until } from "./helpers.js";

function setup(arena = "duel") {
  const room = new Room({ id: "r", name: "R", arena });
  const match = new Match(room);
  const human = { id: "h", name: "human", codec: "json", send() {}, sendGame() {} };
  room.join(human);
  return { room, match, human };
}

const ships = (match) => [...match.players.values()].map((p) => p.ship);

test("a bot joins like a player: roster entry, ship, id", () => {
  const { room, match } = setup();
  const bot = match.addBot();
  assert.ok(bot);
  assert.equal(room.size, 2);
  assert.ok(room.players.has(bot.id));
  assert.equal(room.listPlayers().find((p) => p.id === bot.id)?.name, "Bot 1");
  assert.ok(bot.shipId !== undefined, "the match gave it a ship");
  assert.equal(match.stats().bots, 1);
  match.stop();
});

test("a bot's input goes through Match.input: seq counts up and the match acknowledges it", () => {
  const { match } = setup();
  const bot = match.addBot();
  for (let i = 0; i < 10; i++) match.runTick();
  const entry = match.players.get(bot.id);
  assert.equal(entry.lastSeq, 10, "one input accepted per tick");
  assert.equal(entry.ack, 10);
  match.stop();
});

test("bots chase, shoot and move: over 20 s of play the ships fly and bullets are fired", () => {
  const { match } = setup();
  for (let i = 0; i < 3; i++) match.addBot();
  const start = ships(match).map((s) => [s.pos.x, s.pos.y]);
  let bullets = 0;
  match.world.on("fired", () => bullets++);
  for (let i = 0; i < 600; i++) match.runTick();
  const moved = ships(match).filter((s, i) => {
    const [x, y] = start[i];
    return Math.hypot(s.pos.x - x, s.pos.y - y) > 50;
  });
  assert.ok(moved.length >= 3, `${moved.length} ships moved`);
  assert.ok(bullets > 5, `${bullets} shots fired`);
  match.stop();
});

test("a full room refuses another bot", () => {
  const room = new Room({ id: "r", name: "R", arena: "duel", maxPlayers: 2 });
  const match = new Match(room);
  room.join({ id: "h", name: "human", codec: "json", send() {}, sendGame() {} });
  assert.ok(match.addBot());
  assert.equal(match.addBot(), null);
  match.stop();
});

test("when the last human leaves, the bots go and the room closes", () => {
  const { room, match } = setup();
  match.addBot();
  match.addBot();
  let empty = 0;
  room.once("empty", () => empty++);
  room.leave("h");
  assert.equal(room.size, 2, "the bots are still in until the next tick");
  match.runTick();
  assert.equal(room.size, 0);
  assert.equal(match.bots.size, 0);
  assert.equal(empty, 1);
});

test("POST /api/rooms/:id/bots adds bots, shows up in the room list and refuses bad input", async () => {
  const { app, port, base } = await startApp();
  try {
    const room = await createRoom(base, "botroom");
    const ws = await connect(port);
    join(ws, room.id, "Ann");
    await until(() => ws.messages.some((m) => m.type === "welcome"));

    const post = (path, body) =>
      fetch(`${base}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });

    const added = await post(`/api/rooms/${room.id}/bots`, { count: 3 });
    assert.equal(added.status, 201);
    assert.deepEqual(await added.json(), { added: 3, players: 4 });

    const listed = await (await fetch(`${base}/api/rooms`)).json();
    assert.equal(listed.find((r) => r.id === room.id).players, 4);

    assert.equal(
      (await post(`/api/rooms/${room.id}/bots`)).status,
      201,
      "no body means one bot",
    );
    assert.equal((await post(`/api/rooms/${room.id}/bots`, { count: 0 })).status, 400);
    assert.equal(
      (await post(`/api/rooms/${room.id}/bots`, { count: "many" })).status,
      400,
    );
    assert.equal((await post("/api/rooms/nosuchroom/bots", { count: 1 })).status, 404);
    assert.equal((await fetch(`${base}/api/rooms/${room.id}/bots`)).status, 405);

    // 4 + 1 = 5 in the room; asking for 8 more fills it (8) and says so
    const over = await post(`/api/rooms/${room.id}/bots`, { count: 8 });
    assert.deepEqual(await over.json(), { added: 3, players: 8, error: "room is full" });
    assert.equal((await post(`/api/rooms/${room.id}/bots`, { count: 1 })).status, 409);
    ws.close();
  } finally {
    await app.close();
  }
});
