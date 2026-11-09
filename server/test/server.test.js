import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { test } from "vitest";
import { createShutdown } from "../src/index.ts";
import { replay } from "../src/log/replay.ts";
import { closed, connect, createRoom, join, silent, startApp, until } from "./helpers.js";

// fetch() normalizes ".." away, so traversal attempts go out as raw requests
function rawGet(port, requestPath) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: "127.0.0.1", port, path: requestPath }, (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode));
      })
      .on("error", reject);
  });
}

test("HTTP: health, rooms API, validation, body cap, room cap", async () => {
  const { app, base } = await startApp({ MAX_ROOMS: "2", MAX_BODY_BYTES: "64" });
  try {
    const health = await (await fetch(`${base}/health`)).json();
    assert.equal(health.status, "ok");
    assert.deepEqual(await (await fetch(`${base}/api/rooms`)).json(), []);

    const room = await createRoom(base, "Duel room");
    assert.match(room.id, /^duel-room-[0-9a-f]{6}$/);
    assert.equal((await (await fetch(`${base}/api/rooms`)).json()).length, 1);

    const post = (body) =>
      fetch(`${base}/api/rooms`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
    assert.equal((await post("{oops")).status, 400);
    assert.equal((await post(JSON.stringify({ name: "" }))).status, 400);
    assert.equal((await post(JSON.stringify({ name: "x", arena: "moon" }))).status, 400);
    assert.equal((await post(JSON.stringify({ name: "x".repeat(200) }))).status, 413);

    await createRoom(base, "Second");
    assert.equal((await post(JSON.stringify({ name: "Third" }))).status, 429);

    assert.equal((await fetch(`${base}/api/nothing`)).status, 404);
    assert.equal((await fetch(`${base}/api/rooms`, { method: "DELETE" })).status, 405);
  } finally {
    await app.close();
  }
});

test("HTTP: static files are served, path traversal is rejected", async () => {
  const { app, base, port } = await startApp();
  try {
    const index = await fetch(`${base}/`);
    assert.equal(index.status, 200);
    assert.match(index.headers.get("content-type"), /text\/html/);
    assert.equal(await index.text(), "<h1>hi</h1>");

    assert.equal((await fetch(`${base}/missing.js`)).status, 404);
    for (const bad of [
      "/../secret.txt",
      "/%2e%2e/secret.txt",
      "/a/../../secret.txt",
      "/%2e%2e%2fsecret.txt",
    ]) {
      assert.equal(await rawGet(port, bad), 400, bad);
    }
  } finally {
    await app.close();
  }
});

test("WebSocket: two players join, see each other, chat, leave; room and log are cleaned up", async () => {
  const { app, base, port, config } = await startApp();
  try {
    const room = await createRoom(base, "Chat room");
    const a = await connect(port);
    const b = await connect(port);

    join(a, room.id, "Ann");
    await until(() => a.messages.some((m) => m.type === "welcome"));
    join(b, room.id, "Bob");
    await until(() => b.messages.some((m) => m.type === "welcome"));
    await until(() =>
      a.messages.some((m) => m.type === "roster" && m.players.length === 2),
    );

    a.send(JSON.stringify({ type: "chat", text: "hello Bob" }));
    await until(() => b.messages.some((m) => m.type === "chat"));
    const chat = b.messages.find((m) => m.type === "chat");
    assert.equal(chat.from, "Ann");
    assert.equal(chat.text, "hello Bob");
    assert.equal(
      a.messages.some((m) => m.type === "chat"),
      true,
      "sender gets it too",
    );

    assert.equal((await (await fetch(`${base}/api/rooms`)).json())[0].players, 2);

    const bClosed = closed(b);
    b.close();
    await bClosed;
    await until(() =>
      a.messages.some((m) => m.type === "roster" && m.players.length === 1),
    );

    const aClosed = closed(a);
    a.close();
    await aClosed;
    await until(() => app.rooms.rooms.size === 0);
    await app.rooms.flush();

    const [file] = readdirSync(config.logDir);
    const types = [];
    for await (const event of replay(path.join(config.logDir, file)))
      types.push(event.type);
    assert.deepEqual(types, ["open", "join", "join", "chat", "leave", "leave"]);
  } finally {
    await app.close();
  }
});

test("WebSocket: protocol violations close the socket with a code", async () => {
  const { app, base, port } = await startApp({
    MAX_MESSAGE_BYTES: "256",
    MAX_PLAYERS: "1",
  });
  try {
    const room = await createRoom(base);
    const expectClose = async (action, code) => {
      const ws = await connect(port);
      const result = closed(ws);
      await action(ws);
      assert.equal((await result).code, code);
    };

    await expectClose((ws) => ws.send("{oops"), 4400);
    await expectClose((ws) => ws.send(JSON.stringify({ type: "teleport" })), 4401);
    await expectClose(
      (ws) => ws.send(JSON.stringify({ type: "join", v: 9, room: room.id, name: "x" })),
      4402,
    );
    await expectClose(
      (ws) => ws.send(JSON.stringify({ type: "chat", text: "no join yet" })),
      4400,
    );
    await expectClose((ws) => ws.send(Buffer.from([1, 2, 3])), 4400);
    await expectClose((ws) => join(ws, "no-such-room", "x"), 4404);
    await expectClose((ws) => ws.send("x".repeat(1000)), 1009);

    const first = await connect(port);
    join(first, room.id, "One");
    await until(() => first.messages.some((m) => m.type === "welcome"));
    await expectClose((ws) => join(ws, room.id, "Two"), 4409);
    first.close();
  } finally {
    await app.close();
  }
});

test("WebSocket: no join within the timeout closes with 4408", async () => {
  const { app, port } = await startApp({ JOIN_TIMEOUT_MS: "100" });
  try {
    const ws = await connect(port);
    assert.equal((await closed(ws)).code, 4408);
  } finally {
    await app.close();
  }
});

test("WebSocket: too many messages per second closes with 4429", async () => {
  const { app, base, port } = await startApp({ RATE_LIMIT_PER_SEC: "5" });
  try {
    const room = await createRoom(base);
    const ws = await connect(port);
    join(ws, room.id, "Spammer");
    const result = closed(ws);
    for (let i = 0; i < 30; i++) ws.send(JSON.stringify({ type: "chat", text: `m${i}` }));
    assert.equal((await result).code, 4429);
  } finally {
    await app.close();
  }
});

test("WebSocket: a client that never answers pings is cut off, a normal one stays", async () => {
  const { app, base, port } = await startApp({ PING_INTERVAL_MS: "40" });
  try {
    const room = await createRoom(base);
    const deaf = await connect(port, { autoPong: false });
    const normal = await connect(port);
    join(deaf, room.id, "Deaf");
    join(normal, room.id, "Normal");
    await until(() => normal.messages.some((m) => m.type === "welcome"));

    const result = await closed(deaf);
    assert.equal(result.code, 1006); // terminated, no close frame
    assert.equal(normal.readyState, normal.OPEN);
    normal.close();
  } finally {
    await app.close();
  }
});

test("replays are streamed from LOG_DIR, bad names are refused", async () => {
  const { app, base, config } = await startApp();
  try {
    const content = `${JSON.stringify({ t: 1, type: "open" })}\n`.repeat(1000);
    writeFileSync(path.join(config.logDir, "demo.ndjson"), content);
    mkdirSync(path.join(config.logDir, "sub"), { recursive: true });

    assert.deepEqual(await (await fetch(`${base}/api/replays`)).json(), ["demo.ndjson"]);
    const response = await fetch(`${base}/api/replays/demo.ndjson`);
    assert.equal(response.headers.get("content-type"), "application/x-ndjson");
    assert.equal(await response.text(), content);

    assert.equal((await fetch(`${base}/api/replays/missing.ndjson`)).status, 404);
    assert.equal((await fetch(`${base}/api/replays/secret.txt`)).status, 400);
    assert.equal((await fetch(`${base}/api/replays/%2e%2e%2fsecret.ndjson`)).status, 400);
  } finally {
    await app.close();
  }
});

test("/api/slow exists only when ENABLE_SLOW is set and really blocks", async () => {
  const off = await startApp();
  try {
    assert.equal((await fetch(`${off.base}/api/slow`)).status, 404);
  } finally {
    await off.app.close();
  }

  const on = await startApp({ ENABLE_SLOW: "1", SLOW_MS: "80" });
  try {
    const t = Date.now();
    const body = await (await fetch(`${on.base}/api/slow`)).json();
    assert.ok(Date.now() - t >= 75);
    assert.ok(body.blockedMs >= 80);
  } finally {
    await on.app.close();
  }
});

test("shutdown: sockets get 1001, the log is flushed, exit code is 0", async () => {
  const { app, base, port, config } = await startApp();
  const room = await createRoom(base, "Bye");
  const ws = await connect(port);
  join(ws, room.id, "Ann");
  await until(() => ws.messages.some((m) => m.type === "welcome"));

  const result = closed(ws);
  let exitCode = null;
  await createShutdown(app, { exit: (code) => (exitCode = code), log: silent })(
    "SIGTERM",
  );

  assert.equal((await result).code, 1001);
  assert.equal(exitCode, 0);
  const [file] = readdirSync(config.logDir);
  const lines = readFileSync(path.join(config.logDir, file), "utf8").trim().split("\n");
  assert.deepEqual(
    lines.map((l) => JSON.parse(l).type),
    ["open", "join", "leave"],
  );
});
