import assert from "node:assert/strict";
import { test } from "node:test";
import { backoff, Connection, wsUrl } from "../src/net/connection.js";

// A WebSocket stand-in that the test drives by hand.
class FakeSocket extends EventTarget {
  readyState = 0;
  sent = [];
  send(text) {
    this.sent.push(JSON.parse(text));
  }
  close() {
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.dispatchEvent(new Event("open"));
  }
  drop(code = 1006, reason = "") {
    this.readyState = 3;
    const event = new Event("close");
    event.code = code;
    event.reason = reason;
    this.dispatchEvent(event);
  }
  receive(message) {
    const event = new Event("message");
    event.data = JSON.stringify(message);
    this.dispatchEvent(event);
  }
}

function setup(delay = () => 5) {
  const sockets = [];
  const connection = new Connection({
    url: "ws://test/ws",
    room: "r1",
    name: "Ann",
    delay,
    create: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
  });
  const statuses = [];
  connection.addEventListener("status", (e) => statuses.push(e.detail));
  return { connection, sockets, statuses };
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const chat = (text) => ({ type: "chat", text });

test("join goes first when the socket opens, queued messages after it", () => {
  const { connection, sockets } = setup();
  connection.send(chat("early 1"));
  connection.send(chat("early 2"));
  assert.equal(sockets[0].sent.length, 0);

  sockets[0].open();
  assert.deepEqual(sockets[0].sent, [
    { type: "join", v: 1, room: "r1", name: "Ann", codec: "binary" },
    chat("early 1"),
    chat("early 2"),
  ]);

  connection.send(chat("later"));
  assert.deepEqual(sockets[0].sent.at(-1), chat("later"));
});

test("incoming messages become events", () => {
  const { connection, sockets } = setup();
  const got = [];
  connection.addEventListener("message", (e) => got.push(e.detail));
  sockets[0].open();
  sockets[0].receive({ type: "roster", players: [] });
  sockets[0].dispatchEvent(Object.assign(new Event("message"), { data: "not json" }));
  assert.deepEqual(got, [{ type: "roster", players: [] }]);
});

test("a dropped connection is reopened and joins again", async () => {
  const { connection, sockets, statuses } = setup();
  sockets[0].open();
  sockets[0].drop(1006);
  assert.equal(connection.status, "reconnecting");

  connection.send(chat("while offline"));
  await wait(30);
  assert.equal(sockets.length, 2);
  sockets[1].open();
  assert.deepEqual(sockets[1].sent, [
    { type: "join", v: 1, room: "r1", name: "Ann", codec: "binary" },
    chat("while offline"),
  ]);
  assert.deepEqual(statuses, ["open", "reconnecting", "open"]);
});

test("the delay grows with every failed attempt and resets after a success", async () => {
  const attempts = [];
  const { sockets } = setup((attempt) => {
    attempts.push(attempt);
    return 1;
  });
  sockets[0].drop();
  await wait(15);
  sockets[1].drop();
  await wait(15);
  sockets[2].open();
  sockets[2].drop();
  await wait(15);
  assert.deepEqual(attempts, [0, 1, 0]);
});

test("fatal close codes end the connection without retrying", async () => {
  for (const code of [4400, 4401, 4402, 4404, 4409, 4429]) {
    const { connection, sockets } = setup();
    const closed = [];
    connection.addEventListener("closed", (e) => closed.push(e.detail));
    sockets[0].open();
    sockets[0].drop(code, "because");
    await wait(20);
    assert.equal(sockets.length, 1, `code ${code}`);
    assert.equal(connection.status, "closed");
    assert.deepEqual(closed, [{ code, reason: "because" }]);
  }
});

test("close() stops reconnecting", async () => {
  const { connection, sockets } = setup();
  sockets[0].open();
  sockets[0].drop(1006);
  connection.close();
  await wait(30);
  assert.equal(sockets.length, 1);
});

test("backoff stays within the cap and has jitter", () => {
  for (let attempt = 0; attempt < 12; attempt++) {
    const d = backoff(attempt);
    assert.ok(d <= 10000 && d >= 250, `attempt ${attempt}: ${d}`);
  }
  assert.notEqual(backoff(3), backoff(3));
});

test("wsUrl follows the page protocol", () => {
  assert.equal(wsUrl({ protocol: "http:", host: "a:1" }), "ws://a:1/ws");
  assert.equal(wsUrl({ protocol: "https:", host: "a" }), "wss://a/ws");
});
