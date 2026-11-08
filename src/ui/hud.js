// Score board and event messages. Like the audio, it only listens to world
// events, the simulation does not know it exists.
export function connectHud(world, ships, element) {
  let message = "";
  let messageTimer = 0;

  function render() {
    const lines = ships.map(
      (s) => `${s.name}  hp ${String(s.hp).padStart(3)}  score ${s.score}`,
    );
    if (message) lines.push("", message);
    element.textContent = lines.join("\n");
  }

  function say(text) {
    message = text;
    clearTimeout(messageTimer);
    messageTimer = setTimeout(() => {
      message = "";
      render();
    }, 2500);
    render();
  }

  world.addEventListener("hit", render);
  world.addEventListener("score", render);
  world.addEventListener("respawned", render);
  world.addEventListener("exploded", ({ detail }) => {
    if (detail.entity.kind === "ship") say(`${detail.entity.name} destroyed`);
  });
  world.addEventListener("pickup", ({ detail }) => {
    say(`${detail.ship.name} picked up ${detail.effect}`);
  });

  render();
}
