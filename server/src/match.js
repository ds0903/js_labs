import { getCodec } from "shared/codec/index";
import { applyCommand, createMatch, DT, TICK_RATE } from "shared/sim/match";
import { id16, snapshotWorld } from "shared/sim/snapshot";

export const INTERVAL_MS = 1000 / TICK_RATE;

// Events of the world that clients need as messages: sounds, particles, text.
const FORWARDED = {
  fired: ({ ship }) => ({ ship: id16(ship.id) }),
  hit: ({ target }) => ({ target: id16(target.id), x: target.pos.x, y: target.pos.y }),
  exploded: ({ entity }) => ({
    kind: entity.kind,
    id: id16(entity.id),
    x: entity.pos.x,
    y: entity.pos.y,
    color: entity.color ?? "#b0a090",
  }),
  pickup: ({ ship, effect }) => ({ ship: id16(ship.id), effect }),
  respawned: ({ ship }) => ({ ship: id16(ship.id) }),
};

// Authoritative simulation of one room: collects the players' inputs, runs
// the shared world at 30 Hz and sends every player a snapshot.
export class Match {
  tick = 0;
  players = new Map(); // player id -> { player, ship, input, queue, ack, ... }
  #sim;
  #timer = null;
  #next = 0;
  #lastStart = 0;
  #index = 0;
  #durations = []; // last second of tick durations, ms
  #jitters = []; // |actual interval - 33.3|, ms
  overruns = 0;
  starved = 0;
  catchUps = 0;
  discarded = 0;

  constructor(room, { maxInputQueue = 3, now = () => performance.now() } = {}) {
    this.room = room;
    this.maxInputQueue = maxInputQueue;
    this.now = now;
    this.#sim = createMatch({
      arena: room.arena,
      seed: Math.floor(Math.random() * 2 ** 31),
    });
    this.world = this.#sim.world;

    for (const [name, pick] of Object.entries(FORWARDED)) {
      this.world.addEventListener(name, (event) => {
        // chat-like traffic: a slow client may lose it
        room.broadcast(
          { type: "event", name, ...pick(event.detail) },
          { critical: false },
        );
      });
    }
    room.on("join", (player) => this.addPlayer(player));
    room.on("leave", (player) => this.removePlayer(player.id));
    room.once("empty", () => this.stop());
  }

  addPlayer(player) {
    const { ship, input } = this.#sim.addShip(this.#index++, player.name);
    player.shipId = id16(ship.id);
    player.sprite = ship.sprite;
    player.color = ship.color;
    this.players.set(player.id, {
      player,
      ship,
      input,
      queue: [],
      ack: 0,
      lastSeq: 0,
      credit: 5,
    });
    this.start();
  }

  removePlayer(id) {
    const entry = this.players.get(id);
    if (!entry) return;
    entry.ship.kill();
    this.players.delete(id);
    if (this.players.size === 0) this.stop();
  }

  // An input from the network. Returns false when it was not accepted.
  // The caller has already checked its shape (checkCommand).
  input(playerId, cmd) {
    const entry = this.players.get(playerId);
    if (!entry || cmd.seq <= entry.lastSeq) return false; // duplicate or old
    entry.lastSeq = cmd.seq;
    if (entry.queue.length >= 64) return false;
    entry.queue.push(cmd);
    return true;
  }

  start() {
    if (this.#timer) return;
    this.#next = this.now() + INTERVAL_MS;
    this.#lastStart = 0;
    this.#timer = setTimeout(() => this.#loop(), INTERVAL_MS).unref();
  }

  stop() {
    clearTimeout(this.#timer);
    this.#timer = null;
  }

  // Each tick is scheduled against an absolute target time. setInterval(33)
  // would add the delay of every tick to the next one and drift.
  #loop() {
    const started = this.now();
    if (this.#lastStart)
      this.#push(this.#jitters, Math.abs(started - this.#lastStart - INTERVAL_MS));
    this.#lastStart = started;

    this.runTick();

    const ended = this.now();
    this.#push(this.#durations, ended - started);
    this.#next += INTERVAL_MS;
    let wait = this.#next - ended;
    if (wait < 0) {
      // the tick took longer than the interval: CPU-bound. Do not try to
      // catch up with a burst of ticks, start again from now.
      this.overruns++;
      this.#next = ended + INTERVAL_MS;
      wait = INTERVAL_MS;
    }
    this.#timer = setTimeout(() => this.#loop(), wait).unref();
  }

  #push(list, value) {
    list.push(value);
    if (list.length > TICK_RATE * 2) list.shift();
  }

  // one step of the world; public so tests can drive it without timers
  runTick() {
    for (const entry of this.players.values()) this.#consume(entry);
    this.world.step(DT);
    this.tick++;
    this.#broadcast();
  }

  // Exactly one input per tick moves a ship, the same step the client
  // predicted. Extra inputs (the queue grew after a network burst) are
  // applied as ship-only steps; no input at all freezes the ship for the tick.
  #consume(entry) {
    const { ship, queue } = entry;
    ship.idle = false; // a tick without input may have left it set
    while (queue.length > this.maxInputQueue) {
      this.#apply(entry, queue.shift());
      if (ship.alive) ship.update(DT);
      this.catchUps++;
    }
    entry.credit = Math.min(entry.credit + 1.1, 10);
    const cmd = queue.shift();
    ship.idle = !cmd;
    if (cmd) this.#apply(entry, cmd);
    else this.starved++;
  }

  // speed hack guard: a client that sends more than ~33 inputs per second
  // runs out of credit, and its surplus inputs are acknowledged but ignored
  #apply(entry, cmd) {
    entry.ack = cmd.seq;
    if (entry.credit < 1) {
      this.discarded++;
      entry.ship.idle = true;
      return;
    }
    entry.credit -= 1;
    applyCommand(entry.ship, entry.input, cmd);
  }

  #broadcast() {
    if (this.players.size === 0) return;
    const base = snapshotWorld(this.world, this.tick);
    const encoded = new Map(); // players with the same ack and codec share the bytes
    for (const { player, ack } of this.players.values()) {
      const key = `${player.codec}:${ack}`;
      if (!encoded.has(key)) {
        encoded.set(key, getCodec(player.codec).encodeSnapshot({ ...base, ack }));
      }
      player.sendGame(encoded.get(key));
    }
  }

  stats() {
    const sorted = [...this.#durations].sort((a, b) => a - b);
    const avg = (list) =>
      list.length ? list.reduce((a, b) => a + b, 0) / list.length : 0;
    const round = (n) => Math.round(n * 100) / 100;
    return {
      tick: this.tick,
      players: this.players.size,
      entities: this.world.size,
      tickMs: {
        avg: round(avg(this.#durations)),
        p95: round(sorted[Math.floor(sorted.length * 0.95)] ?? 0),
        max: round(sorted.at(-1) ?? 0),
      },
      jitterMs: {
        avg: round(avg(this.#jitters)),
        max: round(Math.max(0, ...this.#jitters)),
      },
      overruns: this.overruns,
      starvedTicks: this.starved,
      catchUpSteps: this.catchUps,
      discardedInputs: this.discarded,
    };
  }
}
