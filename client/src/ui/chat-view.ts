import { query } from "../dom.ts";
import type { Connection } from "../net/connection.ts";

export interface ChatOptions {
  roomName: string;
  selfName: string;
}

// Side panel with the room's players and chat. It only talks to the
// connection: events in, send() out.
export function createChatView(
  root: HTMLElement,
  connection: Connection,
  { roomName, selfName }: ChatOptions,
): { dispose(): void } {
  const panel = document.createElement("div");
  panel.className = "chat";
  panel.innerHTML = `
    <h2></h2>
    <p class="conn"></p>
    <ul class="players"></ul>
    <div class="log"></div>
    <input class="line" maxlength="200" placeholder="Enter to chat" />`;
  root.append(panel);

  const title = query(panel, "h2", HTMLHeadingElement);
  const conn = query(panel, ".conn", HTMLParagraphElement);
  const players = query(panel, ".players", HTMLUListElement);
  const log = query(panel, ".log", HTMLDivElement);
  const line = query(panel, ".line", HTMLInputElement);
  title.textContent = roomName;

  function addLine(text: string, className = "") {
    const row = document.createElement("div");
    row.textContent = text;
    row.className = className;
    log.append(row);
    while (log.children.length > 50) log.firstElementChild?.remove();
    log.scrollTop = log.scrollHeight;
  }

  connection.on("status", (status) => {
    conn.textContent = status === "open" ? "" : status;
    conn.className = `conn ${status}`;
  });

  connection.on("message", (message) => {
    if (message.type === "roster" || message.type === "welcome") {
      players.replaceChildren(
        ...message.players.map((p) => {
          const item = document.createElement("li");
          item.textContent = p.name === selfName ? `${p.name} (you)` : p.name;
          return item;
        }),
      );
    }
    if (message.type === "chat") addLine(`${message.from}: ${message.text}`);
  });

  connection.on("closed", ({ code, reason }) => {
    addLine(`disconnected (${code}${reason ? `: ${reason}` : ""})`, "error");
    line.disabled = true;
  });

  line.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && line.value.trim()) {
      connection.send({ type: "chat", text: line.value.trim() });
      line.value = "";
    }
    if (e.key === "Escape") line.blur();
  });

  // Enter anywhere in the game focuses the chat line
  const focusOnEnter = (e: KeyboardEvent) => {
    if (e.code === "Enter" && document.activeElement !== line) {
      e.preventDefault();
      line.focus();
    }
  };
  window.addEventListener("keydown", focusOnEnter);

  return {
    dispose() {
      window.removeEventListener("keydown", focusOnEnter);
      panel.remove();
    },
  };
}
