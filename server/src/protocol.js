// Messages between client and server. Control messages are JSON text frames
// with a "type" field; game messages (input, snapshot) go through the codec
// chosen in join: binary frames, or JSON text with the "json" codec.
//
// client -> server
//   { type: "join", v: 1, room, name, codec?: "binary" | "json" }   must be first
//   { type: "chat", text: "<1-200 chars>" }
//   { type: "ping", t }                       answered with pong, to measure RTT
//   { type: "netsim", latency, jitter, drop } latency injector, if the server allows it
//   input                                     { seq, tick, thrust, turn, fire }
// server -> client
//   { type: "welcome", v, id, room, ship, players, tickRate }
//   { type: "roster", players: [{ id, name, ship, sprite, color }] }
//   { type: "chat", from, text, t }
//   { type: "pong", t, tick }
//   { type: "event", name, ... }              fired, hit, exploded, pickup, respawned
//   snapshot                                  { tick, ack, entities }

import { CODEC_NAMES, PROTOCOL_VERSION } from "shared/protocol";
import { checkCommand } from "shared/sim/commands";

export { PROTOCOL_VERSION };

// Close codes. 1xxx are standard, 4xxx are ours (4000-4999 are free to use).
export const CLOSE = {
  GOING_AWAY: 1001,
  TOO_BIG: 1009, // sent by ws itself when a frame is bigger than maxPayload
  BAD_MESSAGE: 4400, // not JSON, wrong shape, bad input, chat before join
  UNKNOWN_TYPE: 4401,
  BAD_VERSION: 4402,
  ROOM_NOT_FOUND: 4404,
  JOIN_TIMEOUT: 4408,
  ROOM_FULL: 4409,
  SLOW_CLIENT: 4413,
  RATE_LIMIT: 4429,
};

const ROOM_ID = /^[A-Za-z0-9_-]{1,40}$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: the point is to reject them
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

const fail = (code, reason) => ({ ok: false, code, reason });
const text = (value, min, max) =>
  typeof value === "string" &&
  value.length >= min &&
  value.length <= max &&
  !CONTROL_CHARS.test(value);
const onlyKeys = (msg, keys) => Object.keys(msg).every((key) => keys.includes(key));
const inRange = (value, min, max) =>
  typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;

// Checks one incoming text frame. Never throws: a bad frame is a normal result
// that the caller turns into a close code.
export function validate(raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return fail(CLOSE.BAD_MESSAGE, "not json");
  }
  if (msg === null || typeof msg !== "object" || Array.isArray(msg)) {
    return fail(CLOSE.BAD_MESSAGE, "not an object");
  }
  if (typeof msg.type !== "string") return fail(CLOSE.BAD_MESSAGE, "no type");

  switch (msg.type) {
    case "join":
      if (!onlyKeys(msg, ["type", "v", "room", "name", "codec"])) {
        return fail(CLOSE.BAD_MESSAGE, "unexpected field in join");
      }
      if (msg.v !== PROTOCOL_VERSION)
        return fail(CLOSE.BAD_VERSION, "unsupported version");
      if (typeof msg.room !== "string" || !ROOM_ID.test(msg.room)) {
        return fail(CLOSE.BAD_MESSAGE, "bad room id");
      }
      if (!text(msg.name, 1, 16)) return fail(CLOSE.BAD_MESSAGE, "bad name");
      if (msg.codec !== undefined && !CODEC_NAMES.includes(msg.codec)) {
        return fail(CLOSE.BAD_MESSAGE, "bad codec");
      }
      return { ok: true, msg };
    case "chat":
      if (!onlyKeys(msg, ["type", "text"])) {
        return fail(CLOSE.BAD_MESSAGE, "unexpected field in chat");
      }
      if (!text(msg.text, 1, 200)) return fail(CLOSE.BAD_MESSAGE, "bad chat text");
      return { ok: true, msg };
    case "ping":
      if (!onlyKeys(msg, ["type", "t"]) || !inRange(msg.t, 0, 1e15)) {
        return fail(CLOSE.BAD_MESSAGE, "bad ping");
      }
      return { ok: true, msg };
    case "netsim":
      if (
        !onlyKeys(msg, ["type", "latency", "jitter", "drop"]) ||
        !inRange(msg.latency, 0, 2000) ||
        !inRange(msg.jitter, 0, 1000) ||
        !inRange(msg.drop, 0, 50)
      ) {
        return fail(CLOSE.BAD_MESSAGE, "bad netsim");
      }
      return { ok: true, msg };
    case "input": {
      const { type, ...cmd } = msg;
      if (!onlyKeys(cmd, ["seq", "tick", "thrust", "turn", "fire"])) {
        return fail(CLOSE.BAD_MESSAGE, "unexpected field in input");
      }
      const problem = checkCommand(cmd);
      if (problem) return fail(CLOSE.BAD_MESSAGE, problem);
      return { ok: true, msg: { type, ...cmd } };
    }
    default:
      return fail(CLOSE.UNKNOWN_TYPE, "unknown type");
  }
}

export const welcome = (id, room, ship, players, tickRate) => ({
  type: "welcome",
  v: PROTOCOL_VERSION,
  id,
  room,
  ship,
  players,
  tickRate,
});
export const roster = (players) => ({ type: "roster", players });
export const chat = (from, message, t = Date.now()) => ({
  type: "chat",
  from,
  text: message,
  t,
});
