import { commandInput, NET_CONTROLS } from "./commands.js";
import { ARENAS, PLAYERS, populate } from "./game.js";
import { Ship } from "./ship.js";
import { World } from "./world.js";

export const TICK_RATE = 30;
export const DT = 1 / TICK_RATE;

// One authoritative world. The server runs it, tests and the determinism
// check run it too; the client never runs it, it predicts one ship.
export function createMatch({ arena = "classic", seed = 1 } = {}) {
  const world = new World({ seed });
  populate(world, ARENAS[arena] ?? ARENAS.classic);

  function addShip(index, name) {
    const input = commandInput();
    const style = PLAYERS[index % PLAYERS.length];
    const ship = new Ship({ input, controls: NET_CONTROLS, ...style, name });
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
export function applyCommand(ship, input, cmd) {
  input.cmd = cmd;
  if (cmd.fire) ship.fire();
}
