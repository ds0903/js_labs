import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { startMatchLog } from "./log/matchlog.js";
import { Match } from "./match.js";
import { chat, roster } from "./protocol.js";

export class LimitError extends Error {
  name = "LimitError";
}

// One room. Events: "join", "leave", "chat" (for whoever wants to react),
// "event" (every record that goes to the match log) and "empty".
export class Room extends EventEmitter {
  players = new Map(); // id -> { id, name, send(message, { critical }) }

  constructor({ id, name, arena = "classic", maxPlayers = 8 }) {
    super();
    this.id = id;
    this.name = name;
    this.arena = arena;
    this.maxPlayers = maxPlayers;
  }

  get size() {
    return this.players.size;
  }

  record(event) {
    this.emit("event", { t: Date.now(), ...event });
  }

  // ship, sprite and color are there once a Match has created the ship
  listPlayers() {
    return [...this.players.values()].map(({ id, name, shipId, sprite, color }) => ({
      id,
      name,
      ...(shipId !== undefined && { ship: shipId, sprite, color }),
    }));
  }

  broadcast(message, options) {
    for (const player of this.players.values()) player.send(message, options);
  }

  join(player) {
    if (this.players.size >= this.maxPlayers) return false;
    this.players.set(player.id, player);
    this.record({ type: "join", player: player.id, name: player.name });
    this.emit("join", player);
    this.broadcast(roster(this.listPlayers()));
    return true;
  }

  leave(playerId) {
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

  say(playerId, text) {
    const player = this.players.get(playerId);
    if (!player) return;
    const message = chat(player.name, text);
    this.record({ type: "chat", player: playerId, text });
    this.emit("chat", message);
    // chat can be dropped for a slow client, the roster cannot
    this.broadcast(message, { critical: false });
  }

  // used when the room is removed while nobody is inside (stale or shutdown)
  close() {
    this.record({ type: "close" });
    this.emit("empty", this);
  }
}

export class RoomManager {
  rooms = new Map();
  #logs = new Set();

  constructor({
    maxRooms = 20,
    maxPlayers = 8,
    logDir = null,
    staleRoomMs = 60_000,
    maxInputQueue = 3,
    onError,
  } = {}) {
    this.maxRooms = maxRooms;
    this.maxPlayers = maxPlayers;
    this.logDir = logDir;
    this.staleRoomMs = staleRoomMs;
    this.maxInputQueue = maxInputQueue;
    this.onError = onError ?? (() => {});
  }

  create({ name, arena = "classic" }) {
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

  get(id) {
    return this.rooms.get(id);
  }

  list() {
    return [...this.rooms.values()].map((r) => ({
      id: r.id,
      name: r.name,
      arena: r.arena,
      players: r.size,
    }));
  }

  stats() {
    return [...this.rooms.values()].map((r) => ({ id: r.id, ...r.match.stats() }));
  }

  closeAll() {
    for (const room of [...this.rooms.values()]) room.close();
  }

  // resolves when all match log files are written and closed
  async flush() {
    await Promise.allSettled([...this.#logs]);
  }
}
