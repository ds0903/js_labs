// Two ways a Node process dies, and how the server avoids both.
//   node scripts/crash-demo.mjs
import { spawnSync } from "node:child_process";

function run(title, code) {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
    encoding: "utf8",
  });
  console.log(`--- ${title}`);
  console.log(`exit code: ${result.status}`);
  const lines = result.stderr.split("\n").filter((l) => l.trim());
  console.log(lines.slice(0, 6).join("\n") || "(no output)");
  console.log();
}

run(
  "1. 'error' event with no listener (a socket or a stream breaks)",
  `import { EventEmitter } from "node:events";
const socket = new EventEmitter();
socket.emit("error", new Error("ECONNRESET: peer went away"));
console.log("not reached");`,
);

run(
  "1b. the same, with a listener",
  `import { EventEmitter } from "node:events";
const socket = new EventEmitter();
socket.on("error", (e) => console.error("handled:", e.message));
socket.emit("error", new Error("ECONNRESET: peer went away"));`,
);

run(
  "2. rejected promise nobody awaits",
  `async function handler() { throw new Error("bad message"); }
handler();
setTimeout(() => console.log("not reached"), 100);`,
);

run(
  "2b. the same, with .catch",
  `async function handler() { throw new Error("bad message"); }
handler().catch((e) => console.error("handled:", e.message));`,
);
