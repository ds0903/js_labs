// DOM for the lobby. Resolves with { name, room } when the player joins.
export function showLobby(root, lobby) {
  return new Promise((resolve) => {
    const panel = document.createElement("div");
    panel.className = "panel";
    panel.innerHTML = `
      <h1>SPACE ARENA</h1>
      <label>Name <input id="name" maxlength="16" value="Pilot" /></label>
      <p id="status">loading rooms...</p>
      <ul id="rooms"></ul>
      <form id="create">
        <input id="room-name" maxlength="24" placeholder="new room" />
        <select id="arena">
          <option>classic</option>
          <option>rocks</option>
          <option>duel</option>
        </select>
        <button>Create</button>
      </form>`;
    root.append(panel);

    const nameInput = panel.querySelector("#name");
    const status = panel.querySelector("#status");
    const list = panel.querySelector("#rooms");
    const form = panel.querySelector("#create");

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const roomName = form.querySelector("#room-name").value.trim();
      if (!roomName) return;
      try {
        await lobby.create(roomName, form.querySelector("#arena").value);
        form.querySelector("#room-name").value = "";
      } catch (error) {
        status.textContent = `Cannot create room: ${error.message}`;
        status.className = "error";
      }
    });

    // Rows are kept by room id: the list refreshes every few seconds and
    // rebuilding it would pull the button away from under the mouse mid-click.
    const rows = new Map();

    function makeRow(room) {
      const item = document.createElement("li");
      const label = document.createElement("span");
      const button = document.createElement("button");
      button.textContent = "Join";
      button.addEventListener("click", () =>
        lobby.join(room.id, nameInput.value.trim() || "Pilot"),
      );
      item.append(label, button);
      return { item, label };
    }

    function showRooms(rooms) {
      status.textContent = rooms.length ? "Pick a room" : "No rooms";
      status.className = "";
      const alive = new Set(rooms.map((room) => room.id));
      for (const [id, row] of rows) {
        if (alive.has(id)) continue;
        row.item.remove();
        rows.delete(id);
      }
      for (const room of rooms) {
        if (!rows.has(room.id)) {
          const row = makeRow(room);
          rows.set(room.id, row);
          list.append(row.item);
        }
        rows.get(room.id).label.textContent =
          `${room.name} (${room.arena}, ${room.players} players)`;
      }
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
