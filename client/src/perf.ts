// Spans for the DevTools Performance panel (the "Timings" track). Off unless the
// address has ?perf: the browser keeps every measure it is given, and the game
// makes about a hundred per second.
const enabled = new URLSearchParams(globalThis.location?.search).has("perf");

export function timed<T>(name: string, fn: () => T): T {
  if (!enabled) return fn();
  const start = performance.now();
  try {
    return fn();
  } finally {
    performance.measure(name, { start, end: performance.now() });
  }
}
