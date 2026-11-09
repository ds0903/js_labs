// The messages themselves (schemas, types, parsing, close codes) live in
// shared/protocol.ts: the client needs exactly the same definitions. What is
// left here are the builders of the messages only the server sends.
import type { EntityId } from "shared/brand";
import {
  CLOSE,
  type PlayerInfo,
  PROTOCOL_VERSION,
  type ServerMessage,
} from "shared/protocol";

export { CLOSE, PROTOCOL_VERSION };

type MessageOf<T extends ServerMessage["type"]> = Extract<ServerMessage, { type: T }>;

export const welcome = (
  id: string,
  room: string,
  ship: EntityId,
  players: PlayerInfo[],
  tickRate: number,
  netsim = false,
): MessageOf<"welcome"> => ({
  type: "welcome",
  v: PROTOCOL_VERSION,
  id,
  room,
  ship,
  players,
  tickRate,
  netsim,
});

export const roster = (players: PlayerInfo[]): MessageOf<"roster"> => ({
  type: "roster",
  players,
});

export const chat = (
  from: string,
  message: string,
  t = Date.now(),
): MessageOf<"chat"> => ({
  type: "chat",
  from,
  text: message,
  t,
});
