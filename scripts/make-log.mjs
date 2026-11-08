// Writes a big match log (NDJSON) without holding it in memory:
// generator -> toNdjson transform -> file, with backpressure all the way.
//   node scripts/make-log.mjs <file> [megabytes]
import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";
import { toNdjson } from "../server/src/log/matchlog.js";

function* events(bytes) {
  const names = ["Ann", "Bob", "Cat", "Dan"];
  let size = 0;
  for (let i = 0; size < bytes; i++) {
    const event = {
      t: 1700000000000 + i * 16,
      type: i % 10 === 0 ? "chat" : "tick",
      from: names[i % 4],
      text: `message number ${i} with some padding to look like a real line`,
      x: (i * 7) % 1600,
      y: (i * 13) % 900,
    };
    size += JSON.stringify(event).length + 1;
    yield event;
  }
}

export async function makeLog(file, megabytes) {
  await pipeline(
    Readable.from(events(megabytes * 1024 * 1024)),
    toNdjson(),
    createWriteStream(file),
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [file, mb = "200"] = process.argv.slice(2);
  if (!file) throw new Error("usage: node scripts/make-log.mjs <file> [megabytes]");
  const started = Date.now();
  await makeLog(file, Number(mb));
  console.log(
    `wrote ${file} (${mb} MB) in ${((Date.now() - started) / 1000).toFixed(1)} s`,
  );
}
