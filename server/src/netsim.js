// Latency injector for one connection. `latency` is the extra round trip in
// ms (half of it in each direction), `jitter` is +- ms on the round trip,
// `drop` is the percentage of game frames that are lost. Control messages
// (join, chat, ping) are delayed but never dropped.
//
// Delivery order is kept, as it is on TCP: a delayed frame never overtakes
// an earlier one, it waits for it.
export function createNetSim(
  initial = {},
  { now = () => performance.now(), random = Math.random } = {},
) {
  const sim = { latency: 0, jitter: 0, drop: 0, ...initial };
  const lastDue = { in: 0, out: 0 };

  return {
    sim,
    set(next) {
      Object.assign(sim, next);
    },
    get active() {
      return sim.latency > 0 || sim.jitter > 0 || sim.drop > 0;
    },
    // runs fn now, later, or never
    run(direction, fn, { droppable = false } = {}) {
      if (!this.active) return fn();
      if (droppable && random() * 100 < sim.drop) return;
      const wait = Math.max(0, sim.latency / 2 + (random() * 2 - 1) * (sim.jitter / 2));
      const due = Math.max(now() + wait, lastDue[direction]);
      lastDue[direction] = due;
      setTimeout(fn, Math.max(0, due - now()));
    },
  };
}
