// A scripted player, for a second ship in the room without a second browser.
//   node scripts/bot.mjs <roomId> [name] [seconds] [ws-url]
// It flies in curves and shoots, at 30 inputs per second like the real client.

import { decodeSnapshot, encodeInput } from "shared/codec/binary";
import WebSocket from "ws";

const [room, name = "Bot", seconds = "60", url = "ws://127.0.0.1:3000/ws"] =
  process.argv.slice(2);
if (!room) throw new Error("usage: node scripts/bot.mjs <roomId> [name] [seconds] [url]");

const phase = Math.random() * 100;
const ws = new WebSocket(url);
ws.binaryType = "arraybuffer";
let seq = 0;
let tick = 0;
let timer = null;

ws.on("open", () => {
  ws.send(JSON.stringify({ type: "join", v: 1, room, name, codec: "binary" }));
  timer = setInterval(() => {
    const step = seq++;
    ws.send(
      encodeInput({
        seq: seq,
        tick,
        thrust: (step + phase) % 90 < 60,
        turn: (Math.floor((step + phase) / 25) % 3) - 1,
        fire: step % 20 === 0,
      }),
    );
  }, 1000 / 30);
  setTimeout(() => ws.close(), Number(seconds) * 1000);
});

ws.on("message", (data, isBinary) => {
  if (isBinary) tick = decodeSnapshot(data).tick;
});
ws.on("close", () => {
  clearInterval(timer);
  process.exit(0);
});
ws.on("error", (error) => {
  console.error(error.message);
  process.exit(1);
});
