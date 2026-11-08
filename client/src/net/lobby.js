import { fetchJson, postJson } from "../assets/loader.js";

// Room list over HTTP. It extends EventTarget and knows nothing about the
// DOM: the view listens to "rooms", "error" and "joined".
export class Lobby extends EventTarget {
  rooms = [];
  #controller = null;
  #timer = 0;
  #busy = false;

  constructor({ url = "/api/rooms", intervalMs = 3000, timeoutMs = 2500 } = {}) {
    super();
    this.url = url;
    this.intervalMs = intervalMs;
    this.timeoutMs = timeoutMs;
  }

  // starts refreshing the list until leave() is called
  start() {
    this.#controller = new AbortController();
    this.refresh();
    this.#timer = setInterval(() => this.refresh(), this.intervalMs);
  }

  async refresh() {
    if (this.#busy || !this.#controller) return; // no overlapping requests
    this.#busy = true;
    const { signal } = this.#controller;
    try {
      this.rooms = await fetchJson(this.url, { signal, timeoutMs: this.timeoutMs });
      this.dispatchEvent(new CustomEvent("rooms", { detail: this.rooms }));
    } catch (error) {
      if (!signal.aborted)
        this.dispatchEvent(new CustomEvent("error", { detail: error }));
    } finally {
      this.#busy = false;
    }
  }

  // creates a room on the server; the refused case (429, 400) throws with the
  // server's explanation as the message
  async create(name, arena) {
    const room = await postJson(this.url, { name, arena }, { timeoutMs: this.timeoutMs });
    this.rooms = [...this.rooms, room];
    this.dispatchEvent(new CustomEvent("rooms", { detail: this.rooms }));
    return room;
  }

  join(roomId, name) {
    const room = this.rooms.find((r) => r.id === roomId);
    if (!room) {
      this.dispatchEvent(
        new CustomEvent("error", { detail: new Error("room not found") }),
      );
      return;
    }
    this.dispatchEvent(new CustomEvent("joined", { detail: { room, name } }));
  }

  // stops the timer and cancels the request that is still in flight
  leave() {
    clearInterval(this.#timer);
    this.#controller?.abort();
    this.#controller = null;
  }
}
