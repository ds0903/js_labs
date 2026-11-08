import { ARENA } from "shared/sim/arena";

// Canvas that fills the window and stays sharp on hi-dpi screens.
// The backing store is cssSize * devicePixelRatio, the CSS size stays
// the same, so one drawing unit is not one physical pixel.
export function createView(canvas) {
  const ctx = canvas.getContext("2d");

  const view = {
    canvas,
    ctx,
    dpr: 1,
    scale: 1, // arena units -> css pixels
    offsetX: 0, // css pixels, arena is centered in the window
    offsetY: 0,
  };

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    const width = window.innerWidth;
    const height = window.innerHeight;

    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;

    view.dpr = dpr;
    view.scale = Math.min(width / ARENA.width, height / ARENA.height);
    view.offsetX = (width - ARENA.width * view.scale) / 2;
    view.offsetY = (height - ARENA.height * view.scale) / 2;
  }

  window.addEventListener("resize", resize);
  resize();

  return view;
}
