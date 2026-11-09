// The numbers shown in the netgraph overlay. All the time and byte counters
// are fed in from outside, so the maths can be tested without a browser.
export function createNetStats() {
  let rtt = null;
  let lastSnapshotAt = null;
  let lastTick = 0;
  const corrections = []; // magnitude of the last 30 reconciliations
  const gaps = []; // time between snapshots, ms
  let rate = { inPerSec: 0, outPerSec: 0 };
  let mark = null; // { at, bytesIn, bytesOut }
  let max = 0;

  return {
    onPong(ms) {
      rtt = rtt === null ? ms : rtt + (ms - rtt) * 0.2;
    },

    onSnapshot(at, tick) {
      if (lastSnapshotAt !== null) {
        gaps.push(at - lastSnapshotAt);
        if (gaps.length > 60) gaps.shift();
      }
      lastSnapshotAt = at;
      lastTick = tick;
    },

    onCorrection(magnitude) {
      corrections.push(magnitude);
      if (corrections.length > 30) corrections.shift();
      max = Math.max(max, magnitude);
    },

    // call about twice a second with the connection's running byte totals
    sampleBytes(at, bytesIn, bytesOut) {
      if (mark && at - mark.at >= 500) {
        const seconds = (at - mark.at) / 1000;
        rate = {
          inPerSec: (bytesIn - mark.bytesIn) / seconds,
          outPerSec: (bytesOut - mark.bytesOut) / seconds,
        };
        mark = { at, bytesIn, bytesOut };
      } else if (!mark) {
        mark = { at, bytesIn, bytesOut };
      }
    },

    snapshot(now) {
      const avg = corrections.length
        ? corrections.reduce((a, b) => a + b, 0) / corrections.length
        : 0;
      return {
        rtt,
        snapshotAge: lastSnapshotAt === null ? null : now - lastSnapshotAt,
        tick: lastTick,
        gapMax: gaps.length ? Math.max(...gaps) : 0,
        correctionLast: corrections.at(-1) ?? 0,
        correctionAvg: avg,
        correctionMax: max,
        inKBs: rate.inPerSec / 1024,
        outKBs: rate.outPerSec / 1024,
      };
    },

    resetMax() {
      max = 0;
    },
  };
}

const f = (n, digits = 1) => (n === null || n === undefined ? "-" : n.toFixed(digits));

// text for the pre#hud element
export function netgraphLines(s, extra) {
  return [
    `rtt        ${f(s.rtt, 0)} ms`,
    `snap age   ${f(s.snapshotAge, 0)} ms (gap max ${f(s.gapMax, 0)})`,
    `tick       ${s.tick}`,
    `down/up    ${f(s.inKBs)} / ${f(s.outKBs)} KB/s`,
    `pending    ${extra.pending} inputs`,
    `correction ${f(s.correctionLast, 2)} px (avg ${f(s.correctionAvg, 2)}, max ${f(s.correctionMax, 1)})`,
    `interp     ${extra.delayMs} ms   predict ${extra.predict ? "on" : "off"}   codec ${extra.codec}`,
    `net sim    ${extra.netsim}`,
    "[ ] delay   P predict   L latency preset",
  ];
}
