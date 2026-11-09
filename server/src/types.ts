import type { EntityId } from "shared/brand";
import type { CodecName, ServerMessage } from "shared/protocol";

export interface Logger {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

// what goes to a client: a message (sent as JSON text) or a frame that a
// codec has already encoded
export type Outgoing = ServerMessage | string | ArrayBuffer | ArrayBufferView;

export interface SendOptions {
  // false: may be dropped for a client that reads too slowly
  critical?: boolean;
  // a game frame (snapshot): the latency injector may drop it
  game?: boolean;
}

// One connected player as the rooms and the match see it.
export interface Player {
  readonly id: string;
  readonly name: string;
  readonly codec: CodecName;
  // there once a Match has created the ship
  shipId?: EntityId;
  sprite?: string;
  color?: string;
  send(message: Outgoing, options?: SendOptions): void;
  sendGame(frame: string | ArrayBuffer): void;
}

// what is written to the match log
export type RoomRecord = { readonly t: number } & (
  | { readonly type: "open"; readonly room: string; readonly name: string; readonly arena: string }
  | { readonly type: "join"; readonly player: string; readonly name: string }
  | { readonly type: "leave"; readonly player: string }
  | { readonly type: "chat"; readonly player: string; readonly text: string }
  | { readonly type: "close" }
);
// a record before the room puts the time on it
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type NewRoomRecord = DistributiveOmit<RoomRecord, "t">;
