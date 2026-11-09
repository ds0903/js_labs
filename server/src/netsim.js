// Latency injector for one connection. `latency` is the extra round trip in
// ms (half of it in each direction), `jitter` is +- ms on the round trip,
// `drop` is the percentage of game frames that are lost. Control messages
// (join, chat, ping) are delayed but never dropped.
//
// Delivery order is kept, as it is on TCP: a delayed frame never overtakes
// an earlier one, it waits for it. Frames of one direction sit in one queue
// and a single timer releases them, because separate setTimeout calls with
// almost equal delays can fire in the wrong order (that happened: the first
// version swapped two inputs now and then, and the client saw it as a
// correction of one step).
export function createNetSim(
  initial = {},
  { now = () => performance.now(), random = Math.random } = {},
) {
  const sim = { latency: 0, jitter: 0, drop: 0, ...initial };
  const lanes = {
    in: { items: [], timer: null, last: 0 },
    out: { items: [], timer: null, last: 0 },
  };

  function pump(lane) {
    if (lane.timer || lane.items.length === 0) return;
    lane.timer = setTimeout(
      () => {
        lane.timer = null;
        const t = now();
        // a timer may fire a hair early, 1 ms of slack
        while (lane.items.length > 0 && lane.items[0].due <= t + 1)
          lane.items.shift().fn();
        pump(lane);
      },
      Math.max(0, lane.items[0].due - now()),
    );
  }

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
      const lane = lanes[direction];
      // switched off while frames are still waiting: the new ones queue up
      // behind them instead of overtaking
      if (!this.active && lane.items.length === 0) return fn();
      if (droppable && random() * 100 < sim.drop) return;
      const wait = Math.max(0, sim.latency / 2 + (random() * 2 - 1) * (sim.jitter / 2));
      lane.last = Math.max(now() + wait, lane.last);
      lane.items.push({ due: lane.last, fn });
      pump(lane);
    },
  };
}
