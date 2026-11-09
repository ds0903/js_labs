import { type Command, JsonInputSchema, JsonSnapshotSchema, type Snapshot } from "../protocol.ts";

// The text codec, kept for comparison with the binary one (?codec=json).
// A decoder is a validator here too: the zod schema throws on anything that
// is not exactly an input or a snapshot.
export const name = "json";
export const binary = false;

export const encodeInput = (cmd: Command): string =>
  JSON.stringify({ type: "input", ...cmd });

export function decodeInput(text: string): Command {
  const { type: _type, ...cmd } = JsonInputSchema.parse(JSON.parse(text));
  return cmd;
}

export const encodeSnapshot = (snap: Snapshot): string =>
  JSON.stringify({ type: "snapshot", ...snap });

export function decodeSnapshot(text: string): Snapshot {
  const { type: _type, ...snap } = JsonSnapshotSchema.parse(JSON.parse(text));
  return snap;
}
