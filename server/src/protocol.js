// Messages between client and server: JSON text frames with a "type" field.
//
// client -> server
//   { type: "join", v: 1, room: "<id>", name: "<1-16 chars>" }   must be first
//   { type: "chat", text: "<1-200 chars>" }
// server -> client
//   { type: "welcome", v, id, room, players }
//   { type: "roster", players: [{ id, name }] }
//   { type: "chat", from, text, t }

export const PROTOCOL_VERSION = 1;

// Close codes. 1xxx are standard, 4xxx are ours (4000-4999 are free to use).
export const CLOSE = {
  GOING_AWAY: 1001,
  TOO_BIG: 1009, // sent by ws itself when a frame is bigger than maxPayload
  BAD_MESSAGE: 4400, // not JSON, wrong shape, binary frame, chat before join
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

// Checks one incoming frame. Never throws: a bad frame is a normal result
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
      if (!onlyKeys(msg, ["type", "v", "room", "name"])) {
        return fail(CLOSE.BAD_MESSAGE, "unexpected field in join");
      }
      if (msg.v !== PROTOCOL_VERSION)
        return fail(CLOSE.BAD_VERSION, "unsupported version");
      if (typeof msg.room !== "string" || !ROOM_ID.test(msg.room)) {
        return fail(CLOSE.BAD_MESSAGE, "bad room id");
      }
      if (!text(msg.name, 1, 16)) return fail(CLOSE.BAD_MESSAGE, "bad name");
      return { ok: true, msg };
    case "chat":
      if (!onlyKeys(msg, ["type", "text"])) {
        return fail(CLOSE.BAD_MESSAGE, "unexpected field in chat");
      }
      if (!text(msg.text, 1, 200)) return fail(CLOSE.BAD_MESSAGE, "bad chat text");
      return { ok: true, msg };
    default:
      return fail(CLOSE.UNKNOWN_TYPE, "unknown type");
  }
}

export const welcome = (id, room, players) => ({
  type: "welcome",
  v: PROTOCOL_VERSION,
  id,
  room,
  players,
});
export const roster = (players) => ({ type: "roster", players });
export const chat = (from, message, t = Date.now()) => ({
  type: "chat",
  from,
  text: message,
  t,
});
