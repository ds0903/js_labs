import { randomBytes } from "node:crypto";
import type { Server } from "node:http";
import { decodeInput } from "shared/codec/binary";
import { type CodecName, type Command, CLOSE, parseClientText } from "shared/protocol";
import { TICK_RATE } from "shared/sim/match";
import { type RawData, type WebSocket, WebSocketServer } from "ws";
import type { ServerConfig } from "./config.ts";
import { createNetSim, type NetSim, type NetSimSettings } from "./netsim.ts";
import { welcome } from "./protocol.ts";
import type { Room, RoomManager } from "./rooms.ts";
import type { Logger, Outgoing, Player, SendOptions } from "./types.ts";

export interface Bucket {
  take(): boolean;
}

// Token bucket: holds up to `ratePerSec` tokens, refills at that speed,
// every message costs one. An empty bucket means the client is too fast.
export function createBucket(ratePerSec: number, now: () => number = Date.now): Bucket {
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

// the part of a WebSocket the sender touches (a test can pass a fake)
export type SocketLike = Pick<WebSocket, "readyState" | "OPEN" | "bufferedAmount" | "send" | "close">;

// Sending with a slow-client policy. If the socket has more than
// `bufferedLimit` bytes waiting, messages that can be lost (chat, snapshots)
// are dropped instead of piling up in server memory. Critical messages are
// still sent, but a client that is more than 16 times over the limit is
// closed. A message is an object (sent as JSON text) or already encoded
// (a string or a binary frame from a codec).
export function createSender(
  config: Pick<ServerConfig, "bufferedLimit">,
  stats: { dropped: number } = { dropped: 0 },
) {
  return function send(
    ws: SocketLike,
    message: Outgoing,
    { critical = true }: SendOptions = {},
  ): boolean {
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

function netsimFromUrl(url = "/"): NetSimSettings {
  const params = new URL(url, "http://localhost").searchParams;
  const num = (name: string) => Math.min(2000, Math.max(0, Number(params.get(name)) || 0));
  return { latency: num("lat"), jitter: num("jitter"), drop: Math.min(50, num("drop")) };
}

// `ws` hands over a Buffer, an ArrayBuffer or a list of fragments
function toBuffer(data: RawData): Buffer {
  if (Array.isArray(data)) return Buffer.concat(data);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return data;
}

interface ConnectionState {
  id: string;
  room: Room | null;
  codec: CodecName;
  missedPongs: number;
  bucket: Bucket;
  inputBucket: Bucket;
  net: NetSim;
}

export interface WsDeps {
  rooms: RoomManager;
  config: ServerConfig;
  stats: { dropped: number };
  log: Logger;
}

export function attachWebSocket(server: Server, { rooms, config, stats, log }: WsDeps) {
  const wss = new WebSocketServer({
    server,
    path: "/ws",
    maxPayload: config.maxMessageBytes,
  });
  const send = createSender(config, stats);
  const states = new WeakMap<WebSocket, ConnectionState>();

  // an emitter without an "error" listener throws, and an uncaught throw
  // ends the whole process: every emitter here gets a listener
  wss.on("error", (error) => log.error("wss error", error.message));

  wss.on("connection", (ws, req) => {
    const state: ConnectionState = {
      id: randomBytes(4).toString("hex"),
      room: null,
      codec: "binary",
      missedPongs: 0,
      bucket: createBucket(config.rateLimitPerSec),
      inputBucket: createBucket(config.inputRatePerSec),
      net: createNetSim(config.enableNetsim ? netsimFromUrl(req.url) : {}),
    };
    states.set(ws, state);

    const close = (code: number, reason: string): void => {
      log.warn(`close ${code} (${reason}) player=${state.id}`);
      ws.close(code, reason);
    };
    // everything that goes out passes the latency injector (if it is on)
    const out = (message: Outgoing, options: SendOptions = {}): void =>
      state.net.run(
        "out",
        () => {
          send(ws, message, options);
        },
        { droppable: options.game },
      );

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

    function onInput(room: Room, cmd: Command): void {
      if (!state.inputBucket.take()) return close(CLOSE.RATE_LIMIT, "too many inputs");
      room.match?.input(state.id, cmd);
    }

    function handle(data: Buffer, isBinary: boolean): void {
      if (ws.readyState !== ws.OPEN) return;

      if (isBinary) {
        const room = state.room;
        if (!room) return close(CLOSE.BAD_MESSAGE, "join first");
        let cmd: Command;
        try {
          cmd = decodeInput(data); // the decoder is the validator
        } catch (error) {
          return close(CLOSE.BAD_MESSAGE, error instanceof Error ? error.message : "bad input");
        }
        return onInput(room, cmd);
      }

      const result = parseClientText(data.toString("utf8"));
      if (!result.ok) return close(result.code, result.reason);
      const { msg } = result;

      if (msg.type === "input") {
        const room = state.room;
        if (!room) return close(CLOSE.BAD_MESSAGE, "join first");
        const { type: _type, ...cmd } = msg;
        return onInput(room, cmd);
      }
      if (!state.bucket.take()) return close(CLOSE.RATE_LIMIT, "too many messages");

      switch (msg.type) {
        case "join": {
          if (state.room) return close(CLOSE.BAD_MESSAGE, "already joined");
          const room = rooms.get(msg.room);
          if (!room) return close(CLOSE.ROOM_NOT_FOUND, "no such room");

          state.codec = msg.codec ?? "binary";
          const player: Player = {
            id: state.id,
            name: msg.name,
            codec: state.codec,
            send: (m, o) => out(m, o),
            sendGame: (frame) => out(frame, { critical: false, game: true }),
          };
          if (!room.join(player)) return close(CLOSE.ROOM_FULL, "room is full");
          state.room = room;
          clearTimeout(joinTimer);
          // the match gave the player a ship while it was joining
          if (player.shipId === undefined) return close(CLOSE.ROOM_NOT_FOUND, "room has no match");
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
          return;
        }
        case "ping":
          return out({ type: "pong", t: msg.t, tick: state.room?.match?.tick ?? 0 });
        case "netsim":
          if (!state.room) return close(CLOSE.BAD_MESSAGE, "join first");
          if (!config.enableNetsim) return close(CLOSE.UNKNOWN_TYPE, "netsim is disabled");
          return state.net.set({ latency: msg.latency, jitter: msg.jitter, drop: msg.drop });
        case "chat":
          if (!state.room) return close(CLOSE.BAD_MESSAGE, "join first");
          return state.room.say(state.id, msg.text);
        default:
          return assertNever(msg);
      }
    }

    // only inputs can be "lost" by the injector, chat and join cannot
    ws.on("message", (raw, isBinary) => {
      const data = toBuffer(raw);
      const droppable = isBinary || data.toString("utf8", 0, 16).startsWith('{"type":"input"');
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

// the compiler complains here if a message type gets no case above
function assertNever(value: never): never {
  throw new Error(`unhandled message ${JSON.stringify(value)}`);
}
