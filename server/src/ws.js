import { randomBytes } from "node:crypto";
import { WebSocketServer } from "ws";
import { CLOSE, validate, welcome } from "./protocol.js";

// Token bucket: holds up to `ratePerSec` tokens, refills at that speed,
// every message costs one. An empty bucket means the client is too fast.
export function createBucket(ratePerSec, now = Date.now) {
  let tokens = ratePerSec;
  let last = now();
  return {
    take() {
      const t = now();
      tokens = Math.min(ratePerSec, tokens + ((t - last) / 1000) * ratePerSec);
      last = t;
      if (tokens < 1) return false;
      tokens -= 1;
      return true;
    },
  };
}

// Sending with a slow-client policy. If the socket has more than
// `bufferedLimit` bytes waiting, messages that can be lost (chat, later
// snapshots) are dropped instead of piling up in server memory. Critical
// messages are still sent, but a client that is more than 16 times over
// the limit is closed.
export function createSender(config, stats = { dropped: 0 }) {
  return function send(ws, message, { critical = true } = {}) {
    if (ws.readyState !== ws.OPEN) return false;
    if (ws.bufferedAmount > config.bufferedLimit) {
      if (!critical) {
        stats.dropped++;
        return false;
      }
      if (ws.bufferedAmount > config.bufferedLimit * 16) {
        ws.close(CLOSE.SLOW_CLIENT, "too slow");
        return false;
      }
    }
    ws.send(JSON.stringify(message), () => {});
    return true;
  };
}

export function attachWebSocket(server, { rooms, config, stats, log }) {
  const wss = new WebSocketServer({
    server,
    path: "/ws",
    maxPayload: config.maxMessageBytes,
  });
  const send = createSender(config, stats);
  const states = new WeakMap();

  // an emitter without an "error" listener throws, and an uncaught throw
  // ends the whole process: every emitter here gets a listener
  wss.on("error", (error) => log.error("wss error", error.message));

  wss.on("connection", (ws) => {
    const state = {
      id: randomBytes(4).toString("hex"),
      room: null,
      missedPongs: 0,
      bucket: createBucket(config.rateLimitPerSec),
    };
    states.set(ws, state);

    const close = (code, reason) => {
      log.warn(`close ${code} (${reason}) player=${state.id}`);
      ws.close(code, reason);
    };

    const joinTimer = setTimeout(
      () => close(CLOSE.JOIN_TIMEOUT, "join timeout"),
      config.joinTimeoutMs,
    );

    ws.on("error", (error) =>
      log.warn(`socket error player=${state.id}: ${error.message}`),
    );
    ws.on("pong", () => {
      state.missedPongs = 0;
    });

    ws.on("message", (data, isBinary) => {
      if (ws.readyState !== ws.OPEN) return;
      if (isBinary) return close(CLOSE.BAD_MESSAGE, "binary frames are not supported");
      if (!state.bucket.take()) return close(CLOSE.RATE_LIMIT, "too many messages");

      const result = validate(data.toString("utf8"));
      if (!result.ok) return close(result.code, result.reason);
      const { msg } = result;

      if (msg.type === "join") {
        if (state.room) return close(CLOSE.BAD_MESSAGE, "already joined");
        const room = rooms.get(msg.room);
        if (!room) return close(CLOSE.ROOM_NOT_FOUND, "no such room");

        const player = { id: state.id, name: msg.name, send: (m, o) => send(ws, m, o) };
        if (!room.join(player)) return close(CLOSE.ROOM_FULL, "room is full");
        state.room = room;
        clearTimeout(joinTimer);
        send(ws, welcome(state.id, room.id, room.listPlayers()));
      } else if (!state.room) {
        close(CLOSE.BAD_MESSAGE, "join first");
      } else {
        state.room.say(state.id, msg.text);
      }
    });

    ws.on("close", () => {
      clearTimeout(joinTimer);
      state.room?.leave(state.id);
    });
  });

  // ping every interval; a client that did not answer two pings in a row is
  // cut off (terminate, there is nobody to say goodbye to)
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      const state = states.get(ws);
      if (!state) continue;
      if (state.missedPongs >= 2) {
        log.warn(`heartbeat lost player=${state.id}`);
        ws.terminate();
        continue;
      }
      state.missedPongs++;
      ws.ping();
    }
  }, config.pingIntervalMs);
  wss.on("close", () => clearInterval(heartbeat));

  return { wss, stopHeartbeat: () => clearInterval(heartbeat) };
}
