// Close codes where a new attempt is pointless: the server said "no" for
// a reason that will not go away by itself (see server/src/protocol.js).
const FATAL = new Set([4400, 4401, 4402, 4404, 4409, 4429]);

export const backoff = (attempt, base = 500, max = 10000) =>
  Math.min(max, base * 2 ** attempt) * (0.5 + Math.random() / 2);

// One WebSocket to one room. Events:
//   "status"  detail: "connecting" | "open" | "reconnecting" | "closed"
//   "message" detail: parsed server message
//   "closed"  detail: { code, reason }  - final, no more attempts
// send() before the socket is open goes to a queue; after a drop the
// connection reopens and sends join again by itself.
export class Connection extends EventTarget {
  status = "connecting";
  #ws = null;
  #queue = [];
  #attempt = 0;
  #timer = 0;
  #stopped = false;

  constructor({ url, room, name, create = (u) => new WebSocket(u), delay = backoff }) {
    super();
    this.url = url;
    this.room = room;
    this.name = name;
    this.create = create;
    this.delay = delay;
    this.#open();
  }

  #setStatus(status) {
    this.status = status;
    this.dispatchEvent(new CustomEvent("status", { detail: status }));
  }

  #open() {
    const ws = this.create(this.url);
    this.#ws = ws;

    ws.addEventListener("open", () => {
      this.#attempt = 0;
      // join goes first, queued messages after it
      ws.send(JSON.stringify({ type: "join", v: 1, room: this.room, name: this.name }));
      for (const text of this.#queue.splice(0)) ws.send(text);
      this.#setStatus("open");
    });

    ws.addEventListener("message", (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return; // the server only sends JSON, ignore anything else
      }
      this.dispatchEvent(new CustomEvent("message", { detail: message }));
    });

    ws.addEventListener("close", (event) => {
      if (this.#stopped || this.#ws !== ws) return;
      if (FATAL.has(event.code)) {
        this.#finish({ code: event.code, reason: event.reason });
        return;
      }
      this.#setStatus("reconnecting");
      this.#timer = setTimeout(() => this.#open(), this.delay(this.#attempt++));
    });
    // "error" is always followed by "close", which does the work
  }

  #finish(detail) {
    this.#stopped = true;
    this.#setStatus("closed");
    this.dispatchEvent(new CustomEvent("closed", { detail }));
  }

  send(message) {
    const text = JSON.stringify(message);
    if (this.#ws?.readyState === 1 && this.status === "open") this.#ws.send(text);
    else this.#queue.push(text);
  }

  close() {
    this.#stopped = true;
    clearTimeout(this.#timer);
    this.#ws?.close(1000);
  }
}

export const wsUrl = (loc = location) =>
  `${loc.protocol === "https:" ? "wss" : "ws"}://${loc.host}/ws`;
