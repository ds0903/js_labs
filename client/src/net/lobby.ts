import { Bus } from "shared/bus";
import { type RoomListing, RoomListingSchema, RoomListSchema } from "shared/protocol";
import { fetchJson, postJson } from "../assets/loader.ts";

export interface LobbyEvents {
  rooms: RoomListing[];
  error: Error;
  joined: { room: RoomListing; name: string };
}

export interface LobbyOptions {
  url?: string;
  intervalMs?: number;
  timeoutMs?: number;
}

// Room list over HTTP. It knows nothing about the DOM: the view listens to
// "rooms", "error" and "joined". What the server sends is `unknown` until the
// schema has parsed it.
export class Lobby extends Bus<LobbyEvents> {
  rooms: RoomListing[] = [];
  readonly url: string;
  readonly intervalMs: number;
  readonly timeoutMs: number;
  #controller: AbortController | null = null;
  #timer: ReturnType<typeof setInterval> | undefined;
  #busy = false;

  constructor({
    url = "/api/rooms",
    intervalMs = 3000,
    timeoutMs = 2500,
  }: LobbyOptions = {}) {
    super();
    this.url = url;
    this.intervalMs = intervalMs;
    this.timeoutMs = timeoutMs;
  }

  // starts refreshing the list until leave() is called
  start(): void {
    this.#controller = new AbortController();
    this.refresh();
    this.#timer = setInterval(() => this.refresh(), this.intervalMs);
  }

  async refresh(): Promise<void> {
    if (this.#busy || !this.#controller) return; // no overlapping requests
    this.#busy = true;
    const { signal } = this.#controller;
    try {
      this.rooms = RoomListSchema.parse(
        await fetchJson(this.url, { signal, timeoutMs: this.timeoutMs }),
      );
      this.emit("rooms", this.rooms);
    } catch (error) {
      if (!signal.aborted) this.emit("error", toError(error));
    } finally {
      this.#busy = false;
    }
  }

  // creates a room on the server; the refused case (429, 400) throws with the
  // server's explanation as the message
  async create(name: string, arena: string): Promise<RoomListing> {
    const room = RoomListingSchema.parse(
      await postJson(this.url, { name, arena }, { timeoutMs: this.timeoutMs }),
    );
    this.rooms = [...this.rooms, room];
    this.emit("rooms", this.rooms);
    return room;
  }

  join(roomId: string, name: string): void {
    const room = this.rooms.find((r) => r.id === roomId);
    if (!room) {
      this.emit("error", new Error("room not found"));
      return;
    }
    this.emit("joined", { room, name });
  }

  // stops the timer and cancels the request that is still in flight
  leave(): void {
    clearInterval(this.#timer);
    this.#controller?.abort();
    this.#controller = null;
  }
}

// whatever was thrown, as an Error the view can show
const toError = (error: unknown): Error =>
  error instanceof Error ? error : new Error(String(error));
