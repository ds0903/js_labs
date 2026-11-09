import type { Ship } from "shared/sim/ship";
import type { World } from "shared/sim/world";

// Score board and event messages. Like the audio, it only listens to world
// events, the simulation does not know it exists.
export function connectHud(
  world: World,
  ships: readonly Ship[],
  element: HTMLElement,
): void {
  let message = "";
  let messageTimer: ReturnType<typeof setTimeout> | undefined;

  function render() {
    const lines = ships.map(
      (s) => `${s.name}  hp ${String(s.hp).padStart(3)}  score ${s.score}`,
    );
    if (message) lines.push("", message);
    element.textContent = lines.join("\n");
  }

  function say(text: string) {
    message = text;
    clearTimeout(messageTimer);
    messageTimer = setTimeout(() => {
      message = "";
      render();
    }, 2500);
    render();
  }

  world.on("hit", render);
  world.on("score", render);
  world.on("respawned", render);
  world.on("exploded", ({ entity }) => {
    // an asteroid has no name: the compiler made this check explicit
    if (entity.kind === "ship") say(`${entity.name} destroyed`);
  });
  world.on("pickup", ({ ship, effect }) => {
    say(`${ship.name} picked up ${effect}`);
  });

  render();
}
