// Side panel with the room's players and chat. It only talks to the
// connection: events in, send() out.
export function createChatView(root, connection, { roomName, selfName }) {
  const panel = document.createElement("div");
  panel.className = "chat";
  panel.innerHTML = `
    <h2></h2>
    <p class="conn"></p>
    <ul class="players"></ul>
    <div class="log"></div>
    <input class="line" maxlength="200" placeholder="Enter to chat" />`;
  root.append(panel);

  const title = panel.querySelector("h2");
  const conn = panel.querySelector(".conn");
  const players = panel.querySelector(".players");
  const log = panel.querySelector(".log");
  const line = panel.querySelector(".line");
  title.textContent = roomName;

  function addLine(text, className = "") {
    const row = document.createElement("div");
    row.textContent = text;
    row.className = className;
    log.append(row);
    while (log.children.length > 50) log.firstChild.remove();
    log.scrollTop = log.scrollHeight;
  }

  connection.addEventListener("status", (e) => {
    conn.textContent = e.detail === "open" ? "" : e.detail;
    conn.className = `conn ${e.detail}`;
  });

  connection.addEventListener("message", (e) => {
    const message = e.detail;
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

  connection.addEventListener("closed", (e) => {
    const { code, reason } = e.detail;
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
  const focusOnEnter = (e) => {
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
