import { ARENA } from "shared/sim/arena";

export interface View {
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  dpr: number;
  scale: number; // arena units -> css pixels
  offsetX: number; // css pixels, arena is centered in the window
  offsetY: number;
}

// Canvas that fills the window and stays sharp on hi-dpi screens.
// The backing store is cssSize * devicePixelRatio, the CSS size stays
// the same, so one drawing unit is not one physical pixel.
export function createView(canvas: HTMLCanvasElement): View {
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("this browser has no 2d canvas");

  const view: View = { canvas, ctx, dpr: 1, scale: 1, offsetX: 0, offsetY: 0 };

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
