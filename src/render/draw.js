import { ARENA } from "../sim/arena.js";
import { lerpAngle, lerpWrapped } from "./interpolate.js";

const GRID = 100;
const SHIP_MARGIN = 30;

// small seeded generator so the stars are the same on every start
function mulberry32(seed) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const random = mulberry32(1337);
const stars = Array.from({ length: 160 }, () => ({
  x: random() * ARENA.width,
  y: random() * ARENA.height,
  r: 0.6 + random() * 1.4,
  a: 0.25 + random() * 0.6,
}));

function drawBackground(ctx) {
  ctx.fillStyle = "#070b14";
  ctx.fillRect(0, 0, ARENA.width, ARENA.height);

  ctx.strokeStyle = "rgba(120, 160, 220, 0.08)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = GRID; x < ARENA.width; x += GRID) {
    ctx.moveTo(x, 0);
    ctx.lineTo(x, ARENA.height);
  }
  for (let y = GRID; y < ARENA.height; y += GRID) {
    ctx.moveTo(0, y);
    ctx.lineTo(ARENA.width, y);
  }
  ctx.stroke();

  for (const star of stars) {
    ctx.fillStyle = `rgba(255, 255, 255, ${star.a})`;
    ctx.beginPath();
    ctx.arc(star.x, star.y, star.r, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawShip(ctx, x, y, angle, thrusting, now) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);

  if (thrusting) {
    const length = 16 + 8 * Math.sin(now / 35);
    ctx.fillStyle = "#ff9d3c";
    ctx.beginPath();
    ctx.moveTo(-9, -5);
    ctx.lineTo(-9 - length, 0);
    ctx.lineTo(-9, 5);
    ctx.closePath();
    ctx.fill();
  }

  ctx.fillStyle = "#cfe3ff";
  ctx.strokeStyle = "#5b8def";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(20, 0);
  ctx.lineTo(-13, -12);
  ctx.lineTo(-7, 0);
  ctx.lineTo(-13, 12);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  ctx.restore();
}

// prev and curr are two consecutive simulation states, alpha says how far
// between them the picture should be.
export function drawScene(view, prev, curr, alpha, now) {
  const { ctx, canvas, dpr, scale } = view;

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // arena units -> device pixels
  const s = scale * dpr;
  ctx.setTransform(s, 0, 0, s, view.offsetX * dpr, view.offsetY * dpr);

  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, ARENA.width, ARENA.height);
  ctx.clip();

  drawBackground(ctx);

  const x = lerpWrapped(prev.x, curr.x, alpha, ARENA.width);
  const y = lerpWrapped(prev.y, curr.y, alpha, ARENA.height);
  const angle = lerpAngle(prev.angle, curr.angle, alpha);

  // near an edge also draw the copy that sticks out on the opposite side
  for (const dx of [-ARENA.width, 0, ARENA.width]) {
    for (const dy of [-ARENA.height, 0, ARENA.height]) {
      const sx = x + dx;
      const sy = y + dy;
      if (sx < -SHIP_MARGIN || sx > ARENA.width + SHIP_MARGIN) continue;
      if (sy < -SHIP_MARGIN || sy > ARENA.height + SHIP_MARGIN) continue;
      drawShip(ctx, sx, sy, angle, curr.thrusting, now);
    }
  }

  ctx.restore();

  ctx.strokeStyle = "#2a3a5c";
  ctx.lineWidth = 3;
  ctx.strokeRect(0, 0, ARENA.width, ARENA.height);
}
