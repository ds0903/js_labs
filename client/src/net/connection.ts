import { Bus } from "shared/bus";
import { getCodec } from "shared/codec/index";
import {
  type ClientMessage,
  type CodecName,
  type Command,
  PROTOCOL_VERSION,
  parseServerText,
  type ServerMessage,
  type Snapshot,
} from "shared/protocol";
import { timed } from "../perf.ts";

// Close codes where a new attempt is pointless: the server said "no" for
// a reason that will not go away by itself (see CLOSE in shared/protocol.ts).
const FATAL = new Set([4400, 4401, 4402, 4404, 4409, 4429]);

export const backoff = (attempt: number, base = 500, max = 10000): number =>
  Math.min(max, base * 2 ** attempt) * (0.5 + Math.random() / 2);

// what send() accepts: the messages a player sends after the join
type ControlMessage = Extract<ClientMessage, { type: "chat" | "ping" | "netsim" }>;

export type ConnectionStatus = "connecting" | "open" | "reconnecting" | "closed";

// One WebSocket to one room. Events:
//   "status"   the new status
//   "message"  a control message (welcome, roster, chat, pong, event), already validated
//   "snapshot" { snap, size, at }  decoded by the codec chosen in join
//   "closed"   { code, reason }  - final, no more attempts
export interface ConnectionEvents {
  status: ConnectionStatus;
  message: ServerMessage;
  snapshot: { snap: Snapshot; size: number; at: number };
  closed: { code: number; reason: string };
}

export interface ConnectionOptions {
  url: string;
  room: string;
  name: string;
  codec?: CodecName;
  create?: (url: string) => WebSocket;
  delay?: (attempt: number) => number;
  now?: () => number;
}

// send() before the socket is open goes to a queue; after a drop the
// connection reopens and sends join again by itself. Inputs are different:
// an input that cannot be sent now is useless later, so sendInput drops it.
export class Connection extends Bus<ConnectionEvents> {
  status: ConnectionStatus = "connecting";
  bytesIn = 0;
  bytesOut = 0;
  readonly url: string;
  readonly room: string;
  readonly name: string;
  readonly codecName: CodecName;
  readonly codec: ReturnType<typeof getCodec>;
  readonly create: (url: string) => WebSocket;
  readonly delay: (attempt: number) => number;
  readonly now: () => number;
  #ws: WebSocket | null = null;
  #queue: string[] = [];
  #attempt = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #stopped = false;

  constructor({
    url,
    room,
    name,
    codec = "binary",
    create = (u) => new WebSocket(u),
    delay = backoff,
    now = () => performance.now(),
  }: ConnectionOptions) {
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

  #setStatus(status: ConnectionStatus): void {
    this.status = status;
    this.emit("status", status);
  }

  #raw(ws: WebSocket, data: string | ArrayBuffer): void {
    this.bytesOut += typeof data === "string" ? data.length : data.byteLength;
    ws.send(data);
  }

  #open(): void {
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
          v: PROTOCOL_VERSION,
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

  // `data` is whatever the socket delivered: a text frame, an ArrayBuffer, or
  // (the type allows it) a Blob. Everything that is not understood is dropped.
  #onMessage(data: unknown): void {
    const at = this.now();
    try {
      if (data instanceof ArrayBuffer) {
        // a binary frame is always a snapshot
        this.bytesIn += data.byteLength;
        const snap = timed("decode", () => this.codec.decodeSnapshot(data));
        this.emit("snapshot", { snap, size: data.byteLength, at });
        return;
      }
      if (typeof data !== "string") return;
      this.bytesIn += data.length;
      // the json codec sends snapshots as text, with "type" first
      if (data.startsWith('{"type":"snapshot"')) {
        const snap = this.codec.decodeSnapshot(data);
        this.emit("snapshot", { snap, size: data.length, at });
        return;
      }
      const parsed = parseServerText(data);
      if (parsed.ok) this.emit("message", parsed.msg);
    } catch {
      // a frame that cannot be decoded is dropped, like a lost packet
    }
  }

  #finish(detail: { code: number; reason: string }): void {
    this.#stopped = true;
    this.#setStatus("closed");
    this.emit("closed", detail);
  }

  get open(): boolean {
    return this.#ws?.readyState === 1 && this.status === "open";
  }

  // control messages to the server (chat, ping, netsim)
  send(message: ControlMessage): void {
    const text = JSON.stringify(message);
    if (this.open && this.#ws) this.#raw(this.#ws, text);
    else this.#queue.push(text);
  }

  // one input of the local player, through the codec
  sendInput(cmd: Command): void {
    if (this.open && this.#ws) this.#raw(this.#ws, this.codec.encodeInput(cmd));
  }

  close(): void {
    this.#stopped = true;
    clearTimeout(this.#timer);
    this.#ws?.close(1000);
  }
}

// The latency injector settings of the page (?lat=100&jitter=30&drop=2) go to
// the server in the socket URL; the server only listens if ENABLE_NETSIM is on.
export function wsUrl(
  loc: Pick<Location, "search" | "protocol" | "host"> = location,
): string {
  const page = new URLSearchParams(loc.search);
  const query = new URLSearchParams();
  for (const key of ["lat", "jitter", "drop"]) {
    const value = page.get(key);
    if (value !== null) query.set(key, value);
  }
  const suffix = query.size ? `?${query}` : "";
  return `${loc.protocol === "https:" ? "wss" : "ws"}://${loc.host}/ws${suffix}`;
}
