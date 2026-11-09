import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

// Reads a match log back one event at a time. The file goes through a read
// stream and a line splitter, it is never loaded into memory as a whole.
// What a line holds is `unknown` until somebody checks it.
export async function* replay(file: string): AsyncGenerator<unknown> {
  const lines = createInterface({
    input: createReadStream(file),
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  for await (const line of lines) {
    if (line.length > 0) yield JSON.parse(line);
  }
}
