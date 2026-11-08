// Loading screen drawn on the game canvas: title, a real progress bar
// (finished items / all items) and, if something fails, the reason and a
// Retry button.
export function createLoadingScreen(view, overlay) {
  const state = { progress: 0, label: "starting", error: "", hint: "Esc cancels" };
  let button = null;

  function draw() {
    const { ctx, dpr } = view;
    const w = window.innerWidth;
    const h = window.innerHeight;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#070b14";
    ctx.fillRect(0, 0, w, h);

    ctx.textAlign = "center";
    ctx.fillStyle = "#cfe3ff";
    ctx.font = "bold 36px sans-serif";
    ctx.fillText("SPACE ARENA", w / 2, h / 2 - 50);

    const barW = Math.min(360, w - 80);
    const barX = (w - barW) / 2;
    const barY = h / 2 - 10;
    ctx.fillStyle = "#16203a";
    ctx.fillRect(barX, barY, barW, 14);
    ctx.fillStyle = state.error ? "#ff6b6b" : "#5b8def";
    ctx.fillRect(barX, barY, barW * state.progress, 14);

    ctx.font = "14px ui-monospace, Consolas, monospace";
    ctx.fillStyle = "#8fa3c8";
    ctx.fillText(
      `${Math.round(state.progress * 100)}%  ${state.label}`,
      w / 2,
      barY + 40,
    );

    if (state.error) {
      ctx.fillStyle = "#ff6b6b";
      ctx.fillText(state.error, w / 2, barY + 66);
    } else {
      ctx.fillStyle = "#56668a";
      ctx.fillText(state.hint, w / 2, barY + 66);
    }
  }

  window.addEventListener("resize", draw);
  draw();

  return {
    state,
    progress(fraction, label) {
      state.progress = fraction;
      state.label = label;
      state.error = "";
      draw();
    },
    // shows the error and resolves when the user presses Retry
    fail(message) {
      state.error = message;
      draw();
      return new Promise((resolve) => {
        button = document.createElement("button");
        button.id = "retry";
        button.textContent = "Retry";
        button.style.cssText = `position:fixed;left:50%;top:${window.innerHeight / 2 + 100}px;transform:translateX(-50%)`;
        button.addEventListener("click", () => {
          button.remove();
          state.progress = 0;
          state.error = "";
          draw();
          resolve();
        });
        overlay.append(button);
      });
    },
    done() {
      window.removeEventListener("resize", draw);
    },
  };
}
