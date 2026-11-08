import assert from "node:assert/strict";
import { createWriteStream, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { test } from "node:test";
import { ConfigError, loadConfig } from "../src/config.js";
import { toNdjson } from "../src/log/matchlog.js";
import { replay } from "../src/log/replay.js";
import { Room, RoomManager } from "../src/rooms.js";
import { mimeFor, resolveStaticPath } from "../src/static.js";
import { createBucket, createSender } from "../src/ws.js";

const tmp = () => mkdtempSync(path.join(os.tmpdir(), "arena-u-"));

// ---------- config ----------

test("config: defaults and values from the environment", () => {
  const dir = tmp();
  const config = loadConfig({ LOG_DIR: dir });
  assert.equal(config.port, 3000);
  assert.equal(config.logDir, dir);
  assert.equal(loadConfig({ LOG_DIR: dir, PORT: "8080" }).port, 8080);
  assert.equal(loadConfig({ LOG_DIR: dir, ENABLE_SLOW: "1" }).enableSlow, true);
});

test("config: bad values are all reported at once", () => {
  const dir = tmp();
  assert.throws(
    () => loadConfig({ LOG_DIR: dir, PORT: "99999", MAX_PLAYERS: "abc" }),
    (error) =>
      error instanceof ConfigError &&
      /PORT/.test(error.message) &&
      /MAX_PLAYERS/.test(error.message),
  );
});

test("config: LOG_DIR that is a file is rejected", () => {
  const file = path.join(tmp(), "a-file");
  writeFileSync(file, "x");
  assert.throws(() => loadConfig({ LOG_DIR: path.join(file, "sub") }), ConfigError);
});

// ---------- static paths ----------

test("static: normal paths resolve inside the root", () => {
  const root = path.resolve("/srv/app");
  assert.equal(resolveStaticPath(root, "/"), path.join(root, "index.html"));
  assert.equal(
    resolveStaticPath(root, "/assets/a.png"),
    path.join(root, "assets", "a.png"),
  );
  assert.equal(resolveStaticPath(root, "/a%20b.txt"), path.join(root, "a b.txt"));
});

test("static: paths with .. or other tricks are rejected", () => {
  const root = path.resolve("/srv/app");
  for (const bad of [
    "/../x",
    "/a/../../x",
    "/%2e%2e/x",
    "/%2E%2E%2fx",
    "/a\\..\\x",
    "/a%00b",
    "/%zz",
  ]) {
    assert.equal(resolveStaticPath(root, bad), null, bad);
  }
});

test("static: mime types", () => {
  assert.match(mimeFor("a.html"), /text\/html/);
  assert.equal(mimeFor("a.PNG"), "image/png");
  assert.equal(mimeFor("a.unknown"), "application/octet-stream");
});

// ---------- rooms ----------

function fakePlayer(id) {
  const received = [];
  return { id, name: `p${id}`, received, send: (m) => received.push(m) };
}

test("room: join, roster, leave, empty", () => {
  const room = new Room({ id: "r", name: "R" });
  const events = [];
  for (const name of ["join", "leave", "empty"]) room.on(name, () => events.push(name));

  const a = fakePlayer("a");
  const b = fakePlayer("b");
  room.join(a);
  room.join(b);
  assert.deepEqual(a.received.at(-1), {
    type: "roster",
    players: [
      { id: "a", name: "pa" },
      { id: "b", name: "pb" },
    ],
  });
  room.leave("a");
  assert.equal(b.received.at(-1).players.length, 1);
  room.leave("b");
  assert.deepEqual(events, ["join", "join", "leave", "leave", "empty"]);
});

test("room: chat goes to everyone, a full room refuses", () => {
  const room = new Room({ id: "r", name: "R", maxPlayers: 2 });
  const a = fakePlayer("a");
  const b = fakePlayer("b");
  room.join(a);
  room.join(b);
  room.say("a", "hi");
  assert.equal(b.received.at(-1).text, "hi");
  assert.equal(b.received.at(-1).from, "pa");
  assert.equal(room.join(fakePlayer("c")), false);
});

test("manager: empty room is deleted, caps and stale rooms", async () => {
  const manager = new RoomManager({ maxRooms: 2, staleRoomMs: 30 });
  const room = manager.create({ name: "One" });
  manager.create({ name: "Two" });
  assert.throws(() => manager.create({ name: "Three" }), { name: "LimitError" });

  room.join(fakePlayer("a"));
  room.leave("a");
  assert.equal(manager.get(room.id), undefined);

  await new Promise((resolve) => setTimeout(resolve, 80)); // the never-joined room goes stale
  assert.equal(manager.rooms.size, 0);
});

// ---------- match log ----------

test("match log: events become NDJSON lines and come back through replay()", async () => {
  const file = path.join(tmp(), "log.ndjson");
  const events = [
    { t: 1, type: "open" },
    { t: 2, type: "chat", text: "привіт" },
    { t: 3, type: "close" },
  ];
  await pipeline(Readable.from(events), toNdjson(), createWriteStream(file));

  assert.equal(readFileSync(file, "utf8").split("\n").length, 4); // 3 lines and the final newline
  const back = [];
  for await (const event of replay(file)) back.push(event);
  assert.deepEqual(back, events);
});

test("manager writes a log file for every room and flushes it", async () => {
  const dir = tmp();
  const manager = new RoomManager({ logDir: dir });
  const room = manager.create({ name: "Logged" });
  room.join(fakePlayer("a"));
  room.say("a", "hello");
  room.leave("a"); // last one: "empty" ends the log
  await manager.flush();

  const files = (await import("node:fs")).readdirSync(dir);
  assert.equal(files.length, 1);
  const types = [];
  for await (const event of replay(path.join(dir, files[0]))) types.push(event.type);
  assert.deepEqual(types, ["open", "join", "chat", "leave"]);
});

// ---------- rate limit and slow clients ----------

test("token bucket: allows a burst, then refills with time", () => {
  let now = 0;
  const bucket = createBucket(5, () => now);
  const burst = Array.from({ length: 7 }, () => bucket.take());
  assert.deepEqual(burst, [true, true, true, true, true, false, false]);
  now += 400; // 5 per second -> 2 tokens
  assert.deepEqual([bucket.take(), bucket.take(), bucket.take()], [true, true, false]);
});

function fakeSocket(bufferedAmount) {
  const sent = [];
  let closedWith = null;
  return {
    OPEN: 1,
    readyState: 1,
    bufferedAmount,
    sent,
    send: (data) => sent.push(data),
    close: (code) => {
      closedWith = code;
    },
    get closedWith() {
      return closedWith;
    },
  };
}

test("slow client: non-critical messages are dropped, critical ones still go", () => {
  const stats = { dropped: 0 };
  const send = createSender({ bufferedLimit: 1000 }, stats);

  const fine = fakeSocket(10);
  send(fine, { type: "chat" }, { critical: false });
  assert.equal(fine.sent.length, 1);

  const slow = fakeSocket(5000);
  assert.equal(send(slow, { type: "chat" }, { critical: false }), false);
  assert.equal(send(slow, { type: "roster" }), true);
  assert.equal(slow.sent.length, 1);
  assert.equal(stats.dropped, 1);

  const hopeless = fakeSocket(1000 * 17);
  assert.equal(send(hopeless, { type: "roster" }), false);
  assert.equal(hopeless.closedWith, 4413);
});
