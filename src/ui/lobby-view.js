// DOM for the lobby. Resolves with { name, room } when the player joins.
export function showLobby(root, lobby) {
  return new Promise((resolve) => {
    const panel = document.createElement("div");
    panel.className = "panel";
    panel.innerHTML = `
      <h1>SPACE ARENA</h1>
      <label>Name <input id="name" maxlength="16" value="Pilot" /></label>
      <p id="status">loading rooms...</p>
      <ul id="rooms"></ul>`;
    root.append(panel);

    const nameInput = panel.querySelector("#name");
    const status = panel.querySelector("#status");
    const list = panel.querySelector("#rooms");

    function showRooms(rooms) {
      status.textContent = rooms.length ? "Pick a room" : "No rooms";
      status.className = "";
      list.replaceChildren(
        ...rooms.map((room) => {
          const item = document.createElement("li");
          const label = document.createElement("span");
          label.textContent = `${room.name}  (${room.players} players)`;
          const button = document.createElement("button");
          button.textContent = "Join";
          button.addEventListener("click", () =>
            lobby.join(room.id, nameInput.value.trim() || "Pilot"),
          );
          item.append(label, button);
          return item;
        }),
      );
    }

    lobby.addEventListener("rooms", (e) => showRooms(e.detail));
    lobby.addEventListener("error", (e) => {
      status.textContent = `Cannot load rooms: ${e.detail.message}. Trying again...`;
      status.className = "error";
    });
    lobby.addEventListener(
      "joined",
      (e) => {
        lobby.leave();
        panel.remove();
        resolve(e.detail);
      },
      { once: true },
    );

    lobby.start();
  });
}
