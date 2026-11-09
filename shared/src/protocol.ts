// The wire protocol: one schema per message, the TypeScript types are inferred
// from the schemas, so the shape that is checked at runtime and the shape the
// compiler knows are the same thing. Everything that crosses the network is
// `unknown` until it has passed through one of the parse functions here (or
// through the binary decoder in codec/binary.ts, which does the same by hand).
//
// Control messages are always JSON text, whatever the codec is:
//   client -> server: join, chat, ping, netsim (and input with the json codec)
//   server -> client: welcome, roster, chat, pong, event (and snapshot, json codec)
// Game messages (input up, snapshot down) go through the codec of the join.
import { z } from "zod";
import {
  type EntityId,
  isEntityId,
  isSeq,
  isTick,
  type Seq,
  type Tick,
} from "./brand.ts";
import { PICKUP_EFFECTS } from "./sim/effects.ts";

// Version of the whole wire protocol (JSON control messages and both codecs).
export const PROTOCOL_VERSION = 1;

// Frame kinds of the binary codec (first byte of every binary frame).
export const MSG = { INPUT: 1, SNAPSHOT: 2 } as const;

export const CODEC_NAMES = ["binary", "json"] as const;
export type CodecName = (typeof CODEC_NAMES)[number];

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
} as const;

// ---- building blocks

const ROOM_ID = /^[A-Za-z0-9_-]{1,40}$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: the point is to reject them
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

const text = (min: number, max: number) =>
  z
    .string()
    .min(min)
    .max(max)
    .refine((s) => !CONTROL_CHARS.test(s), "control characters");

// z.custom<T> is a schema whose output type is T: the guard is the proof
const EntityIdSchema = z.custom<EntityId>(
  (v) => typeof v === "number" && isEntityId(v),
  "bad entity id",
);
const TickSchema = z.custom<Tick>((v) => typeof v === "number" && isTick(v), "bad tick");
const SeqSchema = z.custom<Seq>((v) => typeof v === "number" && isSeq(v), "bad seq");

// ---- game messages: input up, snapshot down

export const CommandSchema = z.strictObject({
  seq: SeqSchema,
  tick: TickSchema, // newest server tick the client has seen
  thrust: z.boolean(),
  turn: z.union([z.literal(-1), z.literal(0), z.literal(1)]),
  fire: z.boolean(),
});
export type Command = z.infer<typeof CommandSchema>;

const body = {
  id: EntityIdSchema,
  x: z.number(),
  y: z.number(),
  vx: z.number(),
  vy: z.number(),
  angle: z.number(), // (-pi, pi]
  radius: z.number(),
};

export const SnapshotEntitySchema = z.discriminatedUnion("kind", [
  z.strictObject({
    ...body,
    kind: z.literal("ship"),
    thrusting: z.boolean(),
    hp: z.number(),
    cooldown: z.number(),
    grace: z.number(),
    shield: z.number(),
    rapid: z.number(),
    homing: z.number(),
    score: z.number(),
  }),
  z.strictObject({
    ...body,
    kind: z.literal("bullet"),
    owner: EntityIdSchema,
    srcSeq: z.number(), // low 16 bits of the input that fired it
    homing: z.boolean(),
  }),
  z.strictObject({ ...body, kind: z.literal("asteroid"), hunter: z.boolean() }),
  z.strictObject({ ...body, kind: z.literal("pickup"), effect: z.enum(PICKUP_EFFECTS) }),
]);

// readonly: a snapshot is a fact about the past, nobody edits it
export type SnapshotEntity = Readonly<z.infer<typeof SnapshotEntitySchema>>;
export type ShipRecord = Extract<SnapshotEntity, { kind: "ship" }>;
export type BulletRecord = Extract<SnapshotEntity, { kind: "bullet" }>;

export const SnapshotSchema = z.strictObject({
  tick: TickSchema,
  ack: SeqSchema, // last input seq the server applied for this client
  entities: z.array(SnapshotEntitySchema),
});
export interface Snapshot {
  readonly tick: Tick;
  readonly ack: Seq;
  readonly entities: readonly SnapshotEntity[];
}

// ---- client -> server

export const ClientMessageSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("join"),
    v: z.literal(PROTOCOL_VERSION),
    room: z.string().regex(ROOM_ID),
    name: text(1, 16),
    codec: z.enum(CODEC_NAMES).optional(),
  }),
  z.strictObject({ type: z.literal("chat"), text: text(1, 200) }),
  z.strictObject({ type: z.literal("ping"), t: z.number().min(0).max(1e15) }),
  z.strictObject({
    type: z.literal("netsim"),
    latency: z.number().min(0).max(2000),
    jitter: z.number().min(0).max(1000),
    drop: z.number().min(0).max(50),
  }),
  CommandSchema.extend({ type: z.literal("input") }), // json codec only
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;

// ---- server -> client

const PlayerInfoSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  // there once a Match has created the ship
  ship: EntityIdSchema.optional(),
  sprite: z.string().optional(),
  color: z.string().optional(),
});
export type PlayerInfo = z.infer<typeof PlayerInfoSchema>;

const EventSchema = z.discriminatedUnion("name", [
  z.strictObject({
    type: z.literal("event"),
    name: z.literal("fired"),
    ship: EntityIdSchema,
  }),
  z.strictObject({
    type: z.literal("event"),
    name: z.literal("hit"),
    target: EntityIdSchema,
    x: z.number(),
    y: z.number(),
  }),
  z.strictObject({
    type: z.literal("event"),
    name: z.literal("exploded"),
    kind: z.string(),
    id: EntityIdSchema,
    x: z.number(),
    y: z.number(),
    color: z.string(),
  }),
  z.strictObject({
    type: z.literal("event"),
    name: z.literal("pickup"),
    ship: EntityIdSchema,
    effect: z.enum(PICKUP_EFFECTS),
  }),
  z.strictObject({
    type: z.literal("event"),
    name: z.literal("respawned"),
    ship: EntityIdSchema,
  }),
]);

// a plain union: the five events share type "event" and differ by `name`, which
// a discriminated union on `type` cannot express
export const ServerMessageSchema = z.union([
  z.strictObject({
    type: z.literal("welcome"),
    v: z.literal(PROTOCOL_VERSION),
    id: z.string(),
    room: z.string(),
    ship: EntityIdSchema,
    players: z.array(PlayerInfoSchema),
    tickRate: z.number().positive(),
    netsim: z.boolean(),
  }),
  z.strictObject({ type: z.literal("roster"), players: z.array(PlayerInfoSchema) }),
  z.strictObject({
    type: z.literal("chat"),
    from: z.string(),
    text: z.string(),
    t: z.number(),
  }),
  z.strictObject({ type: z.literal("pong"), t: z.number(), tick: z.number() }),
  EventSchema,
]);
export type ServerMessage = z.infer<typeof ServerMessageSchema>;
export type EventMessage = Extract<ServerMessage, { type: "event" }>;

// JSON game frames (the "json" codec)
export const JsonInputSchema = CommandSchema.extend({ type: z.literal("input") });
export const JsonSnapshotSchema = SnapshotSchema.extend({ type: z.literal("snapshot") });

// ---- the room list (HTTP, GET /api/rooms)

export const RoomListingSchema = z.object({
  id: z.string(),
  name: z.string(),
  arena: z.string(),
  players: z.number().int().min(0),
});
export type RoomListing = z.infer<typeof RoomListingSchema>;
export const RoomListSchema = z.array(RoomListingSchema);

// ---- parsing: a bad message is a normal result, never an exception

export type ParseResult<T> =
  | { readonly ok: true; readonly msg: T }
  | { readonly ok: false; readonly code: number; readonly reason: string };

const fail = (code: number, reason: string): ParseResult<never> => ({
  ok: false,
  code,
  reason,
});

const CLIENT_TYPES: readonly string[] = ["join", "chat", "ping", "netsim", "input"];

// `data` is whatever JSON.parse gave, so: unknown
export function parseClientMessage(data: unknown): ParseResult<ClientMessage> {
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return fail(CLOSE.BAD_MESSAGE, "not an object");
  }
  const type = "type" in data ? data.type : undefined;
  if (typeof type !== "string") return fail(CLOSE.BAD_MESSAGE, "no type");
  if (!CLIENT_TYPES.includes(type)) return fail(CLOSE.UNKNOWN_TYPE, "unknown type");

  const parsed = ClientMessageSchema.safeParse(data);
  if (parsed.success) return { ok: true, msg: parsed.data };

  const { issues } = parsed.error;
  // the version is the only thing wrong with a join: its own close code
  if (type === "join" && issues.every((issue) => issue.path[0] === "v")) {
    return fail(CLOSE.BAD_VERSION, "unsupported version");
  }
  const first = issues[0];
  const where = first ? first.path.join(".") : "";
  return fail(CLOSE.BAD_MESSAGE, `bad ${type}${where ? ` (${where})` : ""}`);
}

export function parseClientText(raw: string): ParseResult<ClientMessage> {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return fail(CLOSE.BAD_MESSAGE, "not json");
  }
  return parseClientMessage(data);
}

export function parseServerText(raw: string): ParseResult<ServerMessage> {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return fail(CLOSE.BAD_MESSAGE, "not json");
  }
  const parsed = ServerMessageSchema.safeParse(data);
  if (parsed.success) return { ok: true, msg: parsed.data };
  return fail(CLOSE.BAD_MESSAGE, "unexpected server message");
}
