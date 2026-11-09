import { on } from "node:events";
import { createWriteStream } from "node:fs";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Room } from "../rooms.ts";
import type { RoomRecord } from "../types.ts";

// events (objects) in, NDJSON lines (strings) out
export function toNdjson(): Transform {
  return new Transform({
    writableObjectMode: true,
    transform(event, _encoding, callback) {
      try {
        callback(null, `${JSON.stringify(event)}\n`);
      } catch (error) {
        callback(error instanceof Error ? error : new Error(String(error)));
      }
    },
  });
}

// Every room emits "event" for things worth keeping and "empty" at the end.
// The iterator is created at once, so nothing emitted after this call is
// lost, and it closes by itself when "empty" arrives.
function roomEvents(room: Room): Readable {
  const iterator = on(room, "event", { close: ["empty"] });
  return Readable.from(
    (async function* (): AsyncGenerator<RoomRecord> {
      for await (const [event] of iterator) yield event;
    })(),
  );
}

// Writes the log of one room: room events -> Transform -> file.
// `done` resolves when the room is empty and the file is flushed and closed.
export function startMatchLog(
  room: Room,
  dir: string,
  { onError = (_error: Error) => {} }: { onError?: (error: Error) => void } = {},
): { file: string; done: Promise<void> } {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(dir, `${room.id}-${stamp}.ndjson`);
  const done = pipeline(roomEvents(room), toNdjson(), createWriteStream(file)).catch(
    (error: unknown) => {
      onError(error instanceof Error ? error : new Error(String(error)));
    },
  );
  return { file, done };
}
