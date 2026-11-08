// The text codec, kept for comparison with the binary one (?codec=json).
export const name = "json";
export const binary = false;

export const encodeInput = (cmd) => JSON.stringify({ type: "input", ...cmd });

export function decodeInput(text) {
  const { type, ...cmd } = JSON.parse(text);
  if (type !== "input") throw new Error("not an input");
  return cmd;
}

export const encodeSnapshot = (snap) => JSON.stringify({ type: "snapshot", ...snap });

export function decodeSnapshot(text) {
  const { type, ...snap } = JSON.parse(text);
  if (type !== "snapshot") throw new Error("not a snapshot");
  return snap;
}
