import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import type { PlayerInfo, ServerMessage } from "shared/protocol";
import { startMatchLog } from "./log/matchlog.ts";
import { Match } from "./match.ts";
import { chat, roster } from "./protocol.ts";
import type { NewRoomRecord, Player, RoomRecord, SendOptions } from "./types.ts";

export class LimitError extends Error {
  override name = "LimitError";
}

type ChatMessage = Extract<ServerMessage, { type: "chat" }>;

// The events of a room and the arguments of each one (Node's EventEmitter
// takes this map as a type parameter, so `on("join", player => ...)` knows
// that `player` is a Player).
export interface RoomEvents {
  join: [Player];
  leave: [Player];
  chat: [ChatMessage];
  event: [RoomRecord]; // every record that goes to the match log
  empty: [Room];
}

export interface RoomInit {
  id: string;
  name: string;
  arena?: string;
  maxPlayers?: number;
}

// One room. Events: "join", "leave", "chat" (for whoever wants to react),
// "event" (every record that goes to the match log) and "empty".
export class Room extends EventEmitter<RoomEvents> {
  readonly players = new Map<string, Player>();
  readonly id: string;
  readonly name: string;
  readonly arena: string;
  readonly maxPlayers: number;
  // set by the RoomManager once the room exists (the match listens to the room)
  match: Match | null = null;

  constructor({ id, name, arena = "classic", maxPlayers = 8 }: RoomInit) {
    super();
    this.id = id;
    this.name = name;
    this.arena = arena;
    this.maxPlayers = maxPlayers;
  }

  get size(): number {
    return this.players.size;
  }

  record(event: NewRoomRecord): void {
    this.emit("event", { t: Date.now(), ...event });
  }

  // ship, sprite and color are there once a Match has created the ship
  listPlayers(): PlayerInfo[] {
    return [...this.players.values()].map(({ id, name, shipId, sprite, color }) => ({
      id,
      name,
      ...(shipId !== undefined && { ship: shipId, sprite, color }),
    }));
  }

  broadcast(message: ServerMessage, options?: SendOptions): void {
    for (const player of this.players.values()) player.send(message, options);
  }

  join(player: Player): boolean {
    if (this.players.size >= this.maxPlayers) return false;
    this.players.set(player.id, player);
    this.record({ type: "join", player: player.id, name: player.name });
    this.emit("join", player);
    this.broadcast(roster(this.listPlayers()));
    return true;
  }

  leave(playerId: string): void {
    const player = this.players.get(playerId);
    if (!player) return;
    this.players.delete(playerId);
    this.record({ type: "leave", player: playerId });
    this.emit("leave", player);
    if (this.players.size === 0) {
      this.emit("empty", this);
    } else {
      this.broadcast(roster(this.listPlayers()));
    }
  }

  say(playerId: string, text: string): void {
    const player = this.players.get(playerId);
    if (!player) return;
    const message = chat(player.name, text);
    this.record({ type: "chat", player: playerId, text });
    this.emit("chat", message);
    // chat can be dropped for a slow client, the roster cannot
    this.broadcast(message, { critical: false });
  }

  // used when the room is removed while nobody is inside (stale or shutdown)
  close(): void {
    this.record({ type: "close" });
    this.emit("empty", this);
  }
}

export interface RoomManagerOptions {
  maxRooms?: number;
  maxPlayers?: number;
  logDir?: string | null;
  staleRoomMs?: number;
  maxInputQueue?: number;
  onError?: (error: Error) => void;
}

export interface RoomListing {
  id: string;
  name: string;
  arena: string;
  players: number;
}

export class RoomManager {
  readonly rooms = new Map<string, Room>();
  #logs = new Set<Promise<void>>();
  readonly maxRooms: number;
  readonly maxPlayers: number;
  readonly logDir: string | null;
  readonly staleRoomMs: number;
  readonly maxInputQueue: number;
  readonly onError: (error: Error) => void;

  constructor({
    maxRooms = 20,
    maxPlayers = 8,
    logDir = null,
    staleRoomMs = 60_000,
    maxInputQueue = 3,
    onError,
  }: RoomManagerOptions = {}) {
    this.maxRooms = maxRooms;
    this.maxPlayers = maxPlayers;
    this.logDir = logDir;
    this.staleRoomMs = staleRoomMs;
    this.maxInputQueue = maxInputQueue;
    this.onError = onError ?? (() => {});
  }

  create({ name, arena = "classic" }: { name: string; arena?: string }): Room {
    if (this.rooms.size >= this.maxRooms) throw new LimitError("too many rooms");

    const slug =
      name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "") || "room";
    const id = `${slug.slice(0, 20)}-${randomBytes(3).toString("hex")}`;
    const room = new Room({ id, name, arena, maxPlayers: this.maxPlayers });
    room.match = new Match(room, { maxInputQueue: this.maxInputQueue });
    this.rooms.set(id, room);

    if (this.logDir) {
      const { done } = startMatchLog(room, this.logDir, { onError: this.onError });
      this.#logs.add(done);
      done.finally(() => this.#logs.delete(done));
    }
    // after the log is listening, so the first record is not lost
    room.record({ type: "open", room: id, name, arena });

    // an empty room is removed, and a room nobody ever joined too
    room.once("empty", () => this.rooms.delete(id));
    setTimeout(() => {
      if (this.rooms.get(id) === room && room.size === 0) room.close();
    }, this.staleRoomMs).unref();

    return room;
  }

  get(id: string): Room | undefined {
    return this.rooms.get(id);
  }

  list(): RoomListing[] {
    return [...this.rooms.values()].map((r) => ({
      id: r.id,
      name: r.name,
      arena: r.arena,
      players: r.size,
    }));
  }

  stats() {
    return [...this.rooms.values()].flatMap((r) =>
      r.match ? [{ id: r.id, ...r.match.stats() }] : [],
    );
  }

  closeAll(): void {
    for (const room of [...this.rooms.values()]) room.close();
  }

  // resolves when all match log files are written and closed
  async flush(): Promise<void> {
    await Promise.allSettled([...this.#logs]);
  }
}
