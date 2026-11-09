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
export interface NetSimSettings {
  latency: number;
  jitter: number;
  drop: number;
}

export type Direction = "in" | "out";

interface Lane {
  items: { due: number; fn: () => void }[];
  timer: NodeJS.Timeout | null;
  last: number;
}

export interface NetSim {
  readonly sim: NetSimSettings;
  readonly active: boolean;
  set(next: Partial<NetSimSettings>): void;
  // runs fn now, later, or never
  run(direction: Direction, fn: () => void, options?: { droppable?: boolean }): void;
}

export interface NetSimClock {
  now?: () => number;
  random?: () => number;
}

export function createNetSim(
  initial: Partial<NetSimSettings> = {},
  { now = () => performance.now(), random = Math.random }: NetSimClock = {},
): NetSim {
  const sim: NetSimSettings = { latency: 0, jitter: 0, drop: 0, ...initial };
  const lanes: Record<Direction, Lane> = {
    in: { items: [], timer: null, last: 0 },
    out: { items: [], timer: null, last: 0 },
  };
  const isActive = () => sim.latency > 0 || sim.jitter > 0 || sim.drop > 0;

  function pump(lane: Lane): void {
    const first = lane.items[0];
    if (lane.timer || !first) return;
    lane.timer = setTimeout(
      () => {
        lane.timer = null;
        const t = now();
        // a timer may fire a hair early, 1 ms of slack
        for (let item = lane.items[0]; item && item.due <= t + 1; item = lane.items[0]) {
          lane.items.shift();
          item.fn();
        }
        pump(lane);
      },
      Math.max(0, first.due - now()),
    );
  }

  return {
    sim,
    set(next) {
      Object.assign(sim, next);
    },
    get active() {
      return isActive();
    },
    run(direction, fn, { droppable = false } = {}) {
      const lane = lanes[direction];
      // switched off while frames are still waiting: the new ones queue up
      // behind them instead of overtaking
      if (!isActive() && lane.items.length === 0) return fn();
      if (droppable && random() * 100 < sim.drop) return;
      const wait = Math.max(0, sim.latency / 2 + (random() * 2 - 1) * (sim.jitter / 2));
      lane.last = Math.max(now() + wait, lane.last);
      lane.items.push({ due: lane.last, fn });
      pump(lane);
    },
  };
}
