// JSON against the binary codec on a real simulated match: 4 players,
// classic arena, 600 ticks (20 s) of scripted flying and shooting.
//   node scripts/codec-bench.mjs
import * as binary from "shared/codec/binary";
import * as json from "shared/codec/json";
import { applyCommand, createMatch, DT, TICK_RATE } from "shared/sim/match";
import { scriptedCommand } from "shared/sim/replay";
import { snapshotWorld } from "shared/sim/snapshot";

const TICKS = 600;
const { world, addShip } = createMatch({ arena: "classic", seed: 11 });
const players = [0, 1, 2, 3].map((i) => addShip(i, `P${i}`));

const snapshots = [];
const commands = [];
for (let step = 0; step < TICKS; step++) {
  players.forEach(({ ship, input }, i) => {
    const cmd = scriptedCommand(step, i);
    if (i === 0) commands.push(cmd);
    applyCommand(ship, input, cmd);
  });
  world.step(DT);
  snapshots.push(snapshotWorld(world, step + 1, step + 1));
}

const entities = snapshots.reduce((n, s) => n + s.entities.length, 0) / snapshots.length;

// a codec pass: bytes and time for encode + decode of every snapshot / input
function run(codec) {
  const text = codec.name === "json";
  const size = (frame) => (text ? Buffer.byteLength(frame) : frame.byteLength);

  for (let round = 0; round < 3; round++) {
    for (const s of snapshots) codec.decodeSnapshot(codec.encodeSnapshot(s)); // warm up
  }
  let snapBytes = 0;
  let t = performance.now();
  const rounds = 20;
  for (let round = 0; round < rounds; round++) {
    for (const s of snapshots) {
      const frame = codec.encodeSnapshot(s);
      if (round === 0) snapBytes += size(frame);
      codec.decodeSnapshot(frame);
    }
  }
  const snapUs = ((performance.now() - t) * 1000) / (rounds * snapshots.length);

  let inputBytes = 0;
  t = performance.now();
  for (let round = 0; round < rounds; round++) {
    for (const c of commands) {
      const frame = codec.encodeInput(c);
      if (round === 0) inputBytes += size(frame);
      codec.decodeInput(frame);
    }
  }
  const inputUs = ((performance.now() - t) * 1000) / (rounds * commands.length);

  return {
    codec: codec.name,
    bytesPerSnapshot: snapBytes / snapshots.length,
    downKBs: ((snapBytes / snapshots.length) * TICK_RATE) / 1024,
    bytesPerInput: inputBytes / commands.length,
    upKBs: ((inputBytes / commands.length) * TICK_RATE) / 1024,
    snapshotUs: snapUs,
    inputUs,
  };
}

console.log(`${TICKS} ticks, average ${entities.toFixed(1)} entities per snapshot`);
const rows = [run(json), run(binary)];
for (const r of rows) {
  console.log(
    `${r.codec.padEnd(7)} snapshot ${r.bytesPerSnapshot.toFixed(0).padStart(6)} B  ` +
      `down ${r.downKBs.toFixed(2).padStart(6)} KB/s  input ${r.bytesPerInput.toFixed(1).padStart(5)} B  ` +
      `up ${r.upKBs.toFixed(2).padStart(5)} KB/s  snapshot enc+dec ${r.snapshotUs.toFixed(1)} us  input enc+dec ${r.inputUs.toFixed(2)} us`,
  );
}
console.log(
  `ratio: ${(rows[0].bytesPerSnapshot / rows[1].bytesPerSnapshot).toFixed(1)}x smaller`,
);
