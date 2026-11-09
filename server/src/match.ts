import { id16, type Seq, seq, type Tick, tick } from "shared/brand";
import { getCodec } from "shared/codec/index";
import type { Command, EventMessage } from "shared/protocol";
import type { CommandInput } from "shared/sim/commands";
import { applyCommand, createMatch, DT, TICK_RATE } from "shared/sim/match";
import type { Ship } from "shared/sim/ship";
import { snapshotWorld } from "shared/sim/snapshot";
import type { World } from "shared/sim/world";
import { Bot } from "./bot.ts";
import type { Room } from "./rooms.ts";
import type { Player } from "./types.ts";

export const INTERVAL_MS = 1000 / TICK_RATE;
const HISTORY = 20_000; // about 11 minutes of ticks

// one connected player's state inside the match
interface Entry {
  player: Player;
  ship: Ship;
  input: CommandInput;
  queue: Command[];
  ack: Seq; // last input seq that was applied (or thrown away) for this player
  lastSeq: number; // newest input that was accepted into the queue
  credit: number;
}

export interface MatchOptions {
  maxInputQueue?: number;
  now?: () => number;
}

// Authoritative simulation of one room: collects the players' inputs, runs
// the shared world at 30 Hz and sends every player a snapshot.
export class Match {
  tick: Tick = tick(0);
  readonly players = new Map<string, Entry>();
  // AI players; they are in `players` too, this is only the list to ask for input
  readonly bots = new Map<string, Bot>();
  readonly room: Room;
  readonly world: World;
  readonly maxInputQueue: number;
  readonly now: () => number;
  #sim: ReturnType<typeof createMatch>;
  #timer: NodeJS.Timeout | null = null;
  #next = 0;
  #lastStart = 0;
  #index = 0;
  #botCount = 0;
  #durations: number[] = []; // last second of tick durations, ms
  // every tick of the match (the newest HISTORY of them), for percentiles over a whole run
  #history = new Float64Array(HISTORY);
  #historyCount = 0;
  #jitters: number[] = []; // |actual interval - 33.3|, ms
  overruns = 0;
  starved = 0;
  catchUps = 0;
  discarded = 0;

  constructor(
    room: Room,
    { maxInputQueue = 3, now = () => performance.now() }: MatchOptions = {},
  ) {
    this.room = room;
    this.maxInputQueue = maxInputQueue;
    this.now = now;
    this.#sim = createMatch({
      arena: room.arena,
      seed: Math.floor(Math.random() * 2 ** 31),
    });
    this.world = this.#sim.world;

    // Events of the world that clients need as messages: sounds, particles,
    // text. Chat-like traffic: a slow client may lose it.
    const forward = (message: EventMessage) =>
      room.broadcast(message, { critical: false });
    this.world.on("fired", ({ ship }) =>
      forward({ type: "event", name: "fired", ship: id16(ship.id) }),
    );
    this.world.on("hit", ({ target }) =>
      forward({
        type: "event",
        name: "hit",
        target: id16(target.id),
        x: target.pos.x,
        y: target.pos.y,
      }),
    );
    this.world.on("exploded", ({ entity }) =>
      forward({
        type: "event",
        name: "exploded",
        kind: entity.kind,
        id: id16(entity.id),
        x: entity.pos.x,
        y: entity.pos.y,
        color: entity.kind === "ship" ? entity.color : "#b0a090",
      }),
    );
    this.world.on("pickup", ({ ship, effect }) =>
      forward({ type: "event", name: "pickup", ship: id16(ship.id), effect }),
    );
    this.world.on("respawned", ({ ship }) =>
      forward({ type: "event", name: "respawned", ship: id16(ship.id) }),
    );

    room.on("join", (player) => this.addPlayer(player));
    room.on("leave", (player) => this.removePlayer(player.id));
    room.once("empty", () => this.stop());
  }

  addPlayer(player: Player): void {
    const { ship, input } = this.#sim.addShip(this.#index++, player.name);
    player.shipId = id16(ship.id);
    player.sprite = ship.sprite;
    player.color = ship.color;
    this.players.set(player.id, {
      player,
      ship,
      input,
      queue: [],
      ack: seq(0),
      lastSeq: 0,
      credit: 5,
    });
    this.start();
  }

  removePlayer(id: string): void {
    const entry = this.players.get(id);
    if (!entry) return;
    entry.ship.kill();
    this.players.delete(id);
    this.bots.delete(id);
    if (this.players.size === 0) this.stop();
  }

  // Puts an AI player into the room. It joins like anybody else (roster, ship,
  // snapshots) and returns null when the room is full.
  addBot(): Bot | null {
    const bot = new Bot(`Bot ${++this.#botCount}`);
    if (!this.room.join(bot)) return null;
    this.bots.set(bot.id, bot);
    return bot;
  }

  // a room with only bots in it would run forever for nobody
  #dropBots(): void {
    for (const id of [...this.bots.keys()]) this.room.leave(id);
  }

  // An input from the network. Returns false when it was not accepted.
  // The caller got it from a decoder or a schema, so its shape is checked.
  input(playerId: string, cmd: Command): boolean {
    const entry = this.players.get(playerId);
    if (!entry || cmd.seq <= entry.lastSeq) return false; // duplicate or old
    entry.lastSeq = cmd.seq;
    if (entry.queue.length >= 64) return false;
    entry.queue.push(cmd);
    return true;
  }

  start(): void {
    if (this.#timer) return;
    this.#next = this.now() + INTERVAL_MS;
    this.#lastStart = 0;
    this.#timer = setTimeout(() => this.#loop(), INTERVAL_MS).unref();
  }

  stop(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
  }

  // Each tick is scheduled against an absolute target time. setInterval(33)
  // would add the delay of every tick to the next one and drift.
  #loop(): void {
    const started = this.now();
    if (this.#lastStart)
      this.#push(this.#jitters, Math.abs(started - this.#lastStart - INTERVAL_MS));
    this.#lastStart = started;

    this.runTick();
    if (this.#timer === null) return; // the match ended during the tick

    const ended = this.now();
    this.#push(this.#durations, ended - started);
    this.#history[this.#historyCount++ % HISTORY] = ended - started;
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

  #push(list: number[], value: number): void {
    list.push(value);
    if (list.length > TICK_RATE * 2) list.shift();
  }

  // one step of the world; public so tests can drive it without timers
  runTick(): void {
    if (this.bots.size > 0) {
      // bots send their input the way a client does, before the tick consumes it
      if (this.room.players.size === this.bots.size) this.#dropBots();
      else for (const bot of this.bots.values()) bot.think(this);
    }
    for (const entry of this.players.values()) this.#consume(entry);
    this.world.step(DT);
    this.tick = tick(this.tick + 1);
    this.#broadcast();
  }

  // Exactly one input per tick moves a ship, the same step the client
  // predicted. Extra inputs (the queue grew after a network burst) are
  // applied as ship-only steps; no input at all freezes the ship for the tick.
  #consume(entry: Entry): void {
    const { ship, queue } = entry;
    ship.idle = false; // a tick without input may have left it set
    while (queue.length > this.maxInputQueue) {
      const extra = queue.shift();
      if (extra) this.#apply(entry, extra);
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
  #apply(entry: Entry, cmd: Command): void {
    entry.ack = cmd.seq;
    if (entry.credit < 1) {
      this.discarded++;
      entry.ship.idle = true;
      return;
    }
    entry.credit -= 1;
    applyCommand(entry.ship, entry.input, cmd);
  }

  #broadcast(): void {
    if (this.players.size === 0) return;
    const base = snapshotWorld(this.world, this.tick, seq(0)); // the world part is the same for all
    const encoded = new Map<string, string | ArrayBuffer>(); // same ack and codec: same bytes
    for (const { player, ack } of this.players.values()) {
      const key = `${player.codec}:${ack}`;
      let frame = encoded.get(key);
      if (frame === undefined) {
        frame = getCodec(player.codec).encodeSnapshot({ ...base, ack });
        encoded.set(key, frame);
      }
      player.sendGame(frame);
    }
  }

  #historyStats() {
    const count = Math.min(this.#historyCount, HISTORY);
    const sorted = Array.from(this.#history.subarray(0, count)).sort((a, b) => a - b);
    const at = (q: number) =>
      Math.round((sorted[Math.floor((count - 1) * q)] ?? 0) * 100) / 100;
    return { count, p50: at(0.5), p95: at(0.95), p99: at(0.99), max: at(1) };
  }

  stats() {
    const sorted = [...this.#durations].sort((a, b) => a - b);
    const avg = (list: number[]) =>
      list.length ? list.reduce((a, b) => a + b, 0) / list.length : 0;
    const round = (n: number) => Math.round(n * 100) / 100;
    return {
      tick: this.tick,
      players: this.players.size,
      bots: this.bots.size,
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
      // over the whole life of the match, not only the last second
      tickHistoryMs: this.#historyStats(),
      overruns: this.overruns,
      starvedTicks: this.starved,
      catchUpSteps: this.catchUps,
      discardedInputs: this.discarded,
    };
  }
}
