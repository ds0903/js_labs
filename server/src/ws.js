import { randomBytes } from "node:crypto";
import { decodeInput } from "shared/codec/binary";
import { checkCommand } from "shared/sim/commands";
import { TICK_RATE } from "shared/sim/match";
import { WebSocketServer } from "ws";
import { createNetSim } from "./netsim.js";
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
// `bufferedLimit` bytes waiting, messages that can be lost (chat, snapshots)
// are dropped instead of piling up in server memory. Critical messages are
// still sent, but a client that is more than 16 times over the limit is
// closed. A message is an object (sent as JSON text) or already encoded
// (a string or a binary frame from a codec).
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
    const encoded =
      typeof message === "string" ||
      ArrayBuffer.isView(message) ||
      message instanceof ArrayBuffer;
    ws.send(encoded ? message : JSON.stringify(message), () => {});
    return true;
  };
}

function netsimFromUrl(url = "/") {
  const params = new URL(url, "http://localhost").searchParams;
  const num = (name) => Math.min(2000, Math.max(0, Number(params.get(name)) || 0));
  return { latency: num("lat"), jitter: num("jitter"), drop: Math.min(50, num("drop")) };
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

  wss.on("connection", (ws, req) => {
    const state = {
      id: randomBytes(4).toString("hex"),
      room: null,
      codec: "binary",
      missedPongs: 0,
      bucket: createBucket(config.rateLimitPerSec),
      inputBucket: createBucket(config.inputRatePerSec),
      net: createNetSim(config.enableNetsim ? netsimFromUrl(req.url) : {}),
    };
    states.set(ws, state);

    const close = (code, reason) => {
      log.warn(`close ${code} (${reason}) player=${state.id}`);
      ws.close(code, reason);
    };
    // everything that goes out passes the latency injector (if it is on)
    const out = (message, options = {}) =>
      state.net.run("out", () => send(ws, message, options), { droppable: options.game });

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

    function onInput(cmd) {
      if (!state.inputBucket.take()) return close(CLOSE.RATE_LIMIT, "too many inputs");
      state.room.match.input(state.id, cmd);
    }

    function handle(data, isBinary) {
      if (ws.readyState !== ws.OPEN) return;

      if (isBinary) {
        if (!state.room) return close(CLOSE.BAD_MESSAGE, "join first");
        let cmd;
        try {
          cmd = decodeInput(data);
        } catch (error) {
          return close(CLOSE.BAD_MESSAGE, error.message);
        }
        const problem = checkCommand(cmd);
        if (problem) return close(CLOSE.BAD_MESSAGE, problem);
        return onInput(cmd);
      }

      const result = validate(data.toString("utf8"));
      if (!result.ok) return close(result.code, result.reason);
      const { msg } = result;

      if (msg.type === "input") {
        if (!state.room) return close(CLOSE.BAD_MESSAGE, "join first");
        const { type, ...cmd } = msg;
        return onInput(cmd);
      }
      if (!state.bucket.take()) return close(CLOSE.RATE_LIMIT, "too many messages");

      if (msg.type === "join") {
        if (state.room) return close(CLOSE.BAD_MESSAGE, "already joined");
        const room = rooms.get(msg.room);
        if (!room) return close(CLOSE.ROOM_NOT_FOUND, "no such room");

        state.codec = msg.codec ?? "binary";
        const player = {
          id: state.id,
          name: msg.name,
          codec: state.codec,
          send: (m, o) => out(m, o),
          sendGame: (frame) => out(frame, { critical: false, game: true }),
        };
        if (!room.join(player)) return close(CLOSE.ROOM_FULL, "room is full");
        state.room = room;
        clearTimeout(joinTimer);
        player.send(
          welcome(
            state.id,
            room.id,
            player.shipId,
            room.listPlayers(),
            TICK_RATE,
            config.enableNetsim,
          ),
        );
      } else if (!state.room && msg.type !== "ping") {
        close(CLOSE.BAD_MESSAGE, "join first");
      } else if (msg.type === "ping") {
        out({ type: "pong", t: msg.t, tick: state.room?.match.tick ?? 0 });
      } else if (msg.type === "netsim") {
        if (!config.enableNetsim) return close(CLOSE.UNKNOWN_TYPE, "netsim is disabled");
        state.net.set({ latency: msg.latency, jitter: msg.jitter, drop: msg.drop });
      } else {
        state.room.say(state.id, msg.text);
      }
    }

    // only inputs can be "lost" by the injector, chat and join cannot
    ws.on("message", (data, isBinary) => {
      const droppable =
        isBinary || data.toString("utf8", 0, 16).startsWith('{"type":"input"');
      state.net.run("in", () => handle(data, isBinary), { droppable });
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
