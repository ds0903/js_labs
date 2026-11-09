import type { Command } from "../protocol.ts";
import { type CommandInput, commandInput, NET_CONTROLS } from "./commands.ts";
import { ARENAS, isArenaName, populate, styleFor } from "./game.ts";
import { Ship } from "./ship.ts";
import { World } from "./world.ts";

export const TICK_RATE = 30;
export const DT = 1 / TICK_RATE;

export interface Match {
  world: World;
  addShip(index: number, name: string): { ship: Ship; input: CommandInput };
}

// One authoritative world. The server runs it, tests and the determinism
// check run it too; the client never runs it, it predicts one ship.
export function createMatch({
  arena = "classic",
  seed = 1,
}: {
  arena?: string;
  seed?: number;
} = {}): Match {
  const world = new World({ seed });
  populate(world, isArenaName(arena) ? ARENAS[arena] : ARENAS.classic);

  function addShip(index: number, name: string) {
    const input = commandInput();
    const ship = new Ship({ input, controls: NET_CONTROLS, ...styleFor(index), name });
    ship.reset(world.randomSpot(200));
    ship.grace = 0;
    world.spawn(ship);
    return { ship, input };
  }

  return { world, addShip };
}

// The single place where a command becomes a change of the ship. The server,
// the client's prediction and the replay after a snapshot all call it, so
// they cannot drift apart. The caller then steps the world (or only the ship).
export function applyCommand(ship: Ship, input: CommandInput, cmd: Command): void {
  input.cmd = cmd;
  if (cmd.fire) ship.fire();
}
