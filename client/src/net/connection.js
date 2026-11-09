import { getCodec } from "shared/codec/index";

// Close codes where a new attempt is pointless: the server said "no" for
// a reason that will not go away by itself (see server/src/protocol.js).
const FATAL = new Set([4400, 4401, 4402, 4404, 4409, 4429]);

export const backoff = (attempt, base = 500, max = 10000) =>
  Math.min(max, base * 2 ** attempt) * (0.5 + Math.random() / 2);

// One WebSocket to one room. Events:
//   "status"   detail: "connecting" | "open" | "reconnecting" | "closed"
//   "message"  detail: parsed control message (welcome, roster, chat, pong, event)
//   "snapshot" detail: { snap, size, at }  decoded by the codec chosen in join
//   "closed"   detail: { code, reason }  - final, no more attempts
// send() before the socket is open goes to a queue; after a drop the
// connection reopens and sends join again by itself. Inputs are different:
// an input that cannot be sent now is useless later, so sendInput drops it.
export class Connection extends EventTarget {
  status = "connecting";
  bytesIn = 0;
  bytesOut = 0;
  #ws = null;
  #queue = [];
  #attempt = 0;
  #timer = 0;
  #stopped = false;

  constructor({
    url,
    room,
    name,
    codec = "binary",
    create = (u) => new WebSocket(u),
    delay = backoff,
    now = () => performance.now(),
  }) {
    super();
    this.url = url;
    this.room = room;
    this.name = name;
    this.codecName = codec;
    this.codec = getCodec(codec);
    this.create = create;
    this.delay = delay;
    this.now = now;
    this.#open();
  }

  #setStatus(status) {
    this.status = status;
    this.dispatchEvent(new CustomEvent("status", { detail: status }));
  }

  #raw(ws, data) {
    this.bytesOut += typeof data === "string" ? data.length : data.byteLength;
    ws.send(data);
  }

  #open() {
    const ws = this.create(this.url);
    ws.binaryType = "arraybuffer";
    this.#ws = ws;

    ws.addEventListener("open", () => {
      this.#attempt = 0;
      // join goes first, queued messages after it
      this.#raw(
        ws,
        JSON.stringify({
          type: "join",
          v: 1,
          room: this.room,
          name: this.name,
          codec: this.codecName,
        }),
      );
      for (const text of this.#queue.splice(0)) this.#raw(ws, text);
      this.#setStatus("open");
    });

    ws.addEventListener("message", (event) => this.#onMessage(event.data));

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

  #onMessage(data) {
    const at = this.now();
    try {
      if (typeof data !== "string") {
        // a binary frame is always a snapshot
        this.bytesIn += data.byteLength;
        const snap = this.codec.decodeSnapshot(data);
        this.dispatchEvent(
          new CustomEvent("snapshot", { detail: { snap, size: data.byteLength, at } }),
        );
        return;
      }
      this.bytesIn += data.length;
      const message = JSON.parse(data);
      if (message.type === "snapshot") {
        const snap = this.codec.decodeSnapshot(data);
        this.dispatchEvent(
          new CustomEvent("snapshot", { detail: { snap, size: data.length, at } }),
        );
      } else {
        this.dispatchEvent(new CustomEvent("message", { detail: message }));
      }
    } catch {
      // a frame that cannot be decoded is dropped, like a lost packet
    }
  }

  #finish(detail) {
    this.#stopped = true;
    this.#setStatus("closed");
    this.dispatchEvent(new CustomEvent("closed", { detail }));
  }

  get open() {
    return this.#ws?.readyState === 1 && this.status === "open";
  }

  send(message) {
    const text = JSON.stringify(message);
    if (this.open) this.#raw(this.#ws, text);
    else this.#queue.push(text);
  }

  // one input of the local player, through the codec
  sendInput(cmd) {
    if (this.open) this.#raw(this.#ws, this.codec.encodeInput(cmd));
  }

  close() {
    this.#stopped = true;
    clearTimeout(this.#timer);
    this.#ws?.close(1000);
  }
}

// The latency injector settings of the page (?lat=100&jitter=30&drop=2) go to
// the server in the socket URL; the server only listens if ENABLE_NETSIM is on.
export function wsUrl(loc = location) {
  const page = new URLSearchParams(loc.search ?? "");
  const query = new URLSearchParams();
  for (const key of ["lat", "jitter", "drop"]) {
    if (page.has(key)) query.set(key, page.get(key));
  }
  const suffix = query.size ? `?${query}` : "";
  return `${loc.protocol === "https:" ? "wss" : "ws"}://${loc.host}/ws${suffix}`;
}
