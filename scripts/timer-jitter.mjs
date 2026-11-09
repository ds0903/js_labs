// setInterval(33) against an absolute-target setTimeout, 5 s each.
// For each: spread of the intervals, and how far the n-th tick ends up from
// the ideal start + n * 33 ms (setInterval drifts, the absolute target does not).
const STEP = 33;
const SECONDS = 5;

function report(name, times) {
  const gaps = times.slice(1).map((t, i) => t - times[i]);
  const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  const sd = Math.sqrt(gaps.reduce((a, g) => a + (g - mean) ** 2, 0) / gaps.length);
  const drift = times.map((t, i) => t - times[0] - i * STEP);
  const last = drift[drift.length - 1];
  const worst = Math.max(...drift.map(Math.abs));
  console.log(
    `${name.padEnd(18)} ticks ${times.length}  mean ${mean.toFixed(2)} ms  sd ${sd.toFixed(2)}  min ${Math.min(...gaps).toFixed(1)}  max ${Math.max(...gaps).toFixed(1)}  drift at end ${last.toFixed(1)} ms  worst drift ${worst.toFixed(1)} ms`,
  );
}

function withInterval() {
  return new Promise((resolve) => {
    const times = [];
    const id = setInterval(() => {
      times.push(performance.now());
      if (times.length > (SECONDS * 1000) / STEP) {
        clearInterval(id);
        resolve(times);
      }
    }, STEP);
  });
}

function withAbsoluteTarget() {
  return new Promise((resolve) => {
    const times = [];
    const start = performance.now();
    let n = 0;
    const tick = () => {
      times.push(performance.now());
      n++;
      if (times.length > (SECONDS * 1000) / STEP) return resolve(times);
      const wait = Math.max(0, start + (n + 1) * STEP - performance.now());
      setTimeout(tick, wait);
    };
    setTimeout(tick, STEP);
  });
}

report("setInterval(33)", await withInterval());
report("absolute target", await withAbsoluteTarget());
