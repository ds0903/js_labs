import type { CodecName, Command, Snapshot } from "../protocol.ts";
import * as binary from "./binary.ts";
import * as json from "./json.ts";

// what goes over the socket: a text frame or a binary one
export type Frame = string | ArrayBuffer;
// what comes in: a browser gives an ArrayBuffer, `ws` a Buffer
export type IncomingFrame = Frame | ArrayBufferView;

// The flag in the join message picks one of two implementations of this.
export interface Codec {
  readonly name: CodecName;
  readonly binary: boolean;
  encodeInput(cmd: Command): Frame;
  decodeInput(frame: IncomingFrame): Command;
  encodeSnapshot(snap: Snapshot): Frame;
  decodeSnapshot(frame: IncomingFrame): Snapshot;
}

function binaryFrame(frame: IncomingFrame): binary.BinaryFrame {
  if (typeof frame === "string") throw new binary.CodecError("expected a binary frame");
  return frame;
}

function textFrame(frame: IncomingFrame): string {
  if (typeof frame !== "string") throw new Error("expected a text frame");
  return frame;
}

const binaryCodec: Codec = {
  name: "binary",
  binary: true,
  encodeInput: binary.encodeInput,
  decodeInput: (frame) => binary.decodeInput(binaryFrame(frame)),
  encodeSnapshot: binary.encodeSnapshot,
  decodeSnapshot: (frame) => binary.decodeSnapshot(binaryFrame(frame)),
};

const jsonCodec: Codec = {
  name: "json",
  binary: false,
  encodeInput: json.encodeInput,
  decodeInput: (frame) => json.decodeInput(textFrame(frame)),
  encodeSnapshot: json.encodeSnapshot,
  decodeSnapshot: (frame) => json.decodeSnapshot(textFrame(frame)),
};

const codecs: Record<CodecName, Codec> = { binary: binaryCodec, json: jsonCodec };

export function getCodec(name: CodecName): Codec {
  return codecs[name];
}
