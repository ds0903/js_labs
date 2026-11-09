import type { RoomListing } from "shared/protocol";
import { query } from "../dom.ts";
import type { Lobby } from "../net/lobby.ts";

interface Row {
  item: HTMLLIElement;
  label: HTMLSpanElement;
}

// DOM for the lobby. Resolves with { name, room } when the player joins.
export function showLobby(
  root: HTMLElement,
  lobby: Lobby,
): Promise<{ name: string; room: RoomListing }> {
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

    const nameInput = query(panel, "#name", HTMLInputElement);
    const status = query(panel, "#status", HTMLParagraphElement);
    const list = query(panel, "#rooms", HTMLUListElement);
    const form = query(panel, "#create", HTMLFormElement);
    const roomName = query(form, "#room-name", HTMLInputElement);
    const arena = query(form, "#arena", HTMLSelectElement);

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const name = roomName.value.trim();
      if (!name) return;
      try {
        await lobby.create(name, arena.value);
        roomName.value = "";
      } catch (error) {
        status.textContent = `Cannot create room: ${error instanceof Error ? error.message : error}`;
        status.className = "error";
      }
    });

    // Rows are kept by room id: the list refreshes every few seconds and
    // rebuilding it would pull the button away from under the mouse mid-click.
    const rows = new Map<string, Row>();

    function makeRow(room: RoomListing): Row {
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

    function showRooms(rooms: readonly RoomListing[]) {
      status.textContent = rooms.length ? "Pick a room" : "No rooms";
      status.className = "";
      const alive = new Set(rooms.map((room) => room.id));
      for (const [id, row] of rows) {
        if (alive.has(id)) continue;
        row.item.remove();
        rows.delete(id);
      }
      for (const room of rooms) {
        let row = rows.get(room.id);
        if (!row) {
          row = makeRow(room);
          rows.set(room.id, row);
          list.append(row.item);
        }
        row.label.textContent = `${room.name} (${room.arena}, ${room.players} players)`;
      }
    }

    lobby.on("rooms", showRooms);
    lobby.on("error", (error) => {
      status.textContent = `Cannot load rooms: ${error.message}. Trying again...`;
      status.className = "error";
    });
    const stopJoined = lobby.on("joined", (joined) => {
      stopJoined();
      lobby.leave();
      panel.remove();
      resolve(joined);
    });

    lobby.start();
  });
}
