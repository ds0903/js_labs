import { randomBytes } from "node:crypto";
import { seq, tick } from "shared/brand";
import type { CodecName, Command } from "shared/protocol";
import { ARENA } from "shared/sim/arena";
import { normalizeAngle } from "shared/sim/snapshot";
import type { Match } from "./match.ts";
import type { Player } from "./types.ts";

interface Point {
  readonly x: number;
  readonly y: number;
}

// shortest vector from `from` to `to` on the arena that wraps around
function wrappedDelta(from: Point, to: Point): Point {
  let dx = to.x - from.x;
  let dy = to.y - from.y;
  if (dx > ARENA.width / 2) dx -= ARENA.width;
  if (dx < -ARENA.width / 2) dx += ARENA.width;
  if (dy > ARENA.height / 2) dy -= ARENA.height;
  if (dy < -ARENA.height / 2) dy += ARENA.height;
  return { x: dx, y: dy };
}

const AIM_TOLERANCE = 0.12; // rad: fire when the nose is this close to the target
const FIRE_RANGE = 650;
const KEEP_DISTANCE = 200; // closer than this the bot stops thrusting at its target
const ROCK_MARGIN = 90; // start steering away from a rock this far from its edge

// An AI player. It has no socket: it is a Player whose "network" is a method.
// Every tick Match asks it to think(), and it answers with a Command sent
// through Match.input(), the same door a human's input comes in through, so
// the match applies the same rules (queue, credit, one input per tick) and
// cannot tell the difference.
export class Bot implements Player {
  readonly id = `bot-${randomBytes(3).toString("hex")}`;
  readonly codec: CodecName = "binary";
  shipId?: Player["shipId"];
  sprite?: string;
  color?: string;
  readonly name: string;
  #seq = 0;

  constructor(name: string) {
    this.name = name;
  }

  // nobody listens to a bot
  send(): void {}
  sendGame(): void {}

  think(match: Match): void {
    const me = match.players.get(this.id);
    if (!me) return;
    const { ship } = me;
    if (!ship.alive) {
      this.#send(match, { thrust: false, turn: 0, fire: false });
      return;
    }

    // the nearest enemy ship that is alive
    let target: Point | null = null;
    let targetDistance = Number.POSITIVE_INFINITY;
    for (const [id, other] of match.players) {
      if (id === this.id || !other.ship.alive) continue;
      const d = wrappedDelta(ship.pos, other.ship.pos);
      const distance = Math.hypot(d.x, d.y);
      if (distance < targetDistance) {
        targetDistance = distance;
        target = d;
      }
    }

    // a rock that is about to be hit beats everything else
    for (const rock of match.world.ofKind("asteroid")) {
      const d = wrappedDelta(ship.pos, rock.pos);
      const distance = Math.hypot(d.x, d.y);
      if (distance < rock.radius + ship.radius + ROCK_MARGIN) {
        const away = normalizeAngle(Math.atan2(-d.y, -d.x) - ship.angle);
        this.#send(match, {
          thrust: Math.abs(away) < 1,
          turn: away > 0 ? 1 : -1,
          fire: false,
        });
        return;
      }
    }

    if (!target) {
      // nobody to chase: circle and shoot at nothing
      this.#send(match, { thrust: match.tick % 60 < 40, turn: 1, fire: false });
      return;
    }

    const wanted = normalizeAngle(Math.atan2(target.y, target.x) - ship.angle);
    this.#send(match, {
      thrust: Math.abs(wanted) < 0.6 && targetDistance > KEEP_DISTANCE,
      turn: Math.abs(wanted) < 0.04 ? 0 : wanted > 0 ? 1 : -1,
      fire: Math.abs(wanted) < AIM_TOLERANCE && targetDistance < FIRE_RANGE,
    });
  }

  #send(match: Match, keys: Pick<Command, "thrust" | "turn" | "fire">): void {
    match.input(this.id, { seq: seq(++this.#seq), tick: tick(match.tick), ...keys });
  }
}
