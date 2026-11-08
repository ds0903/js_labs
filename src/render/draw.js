import { ARENA } from "../sim/arena.js";
import { mulberry32 } from "../sim/random.js";
import { lerpAngle, lerpWrapped } from "./interpolate.js";

const GRID = 100;
const SHIP_MARGIN = 30;

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

function drawShip(ctx, ship, x, y, angle, now) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);

  if (ship.thrusting) {
    const length = 16 + 8 * Math.sin(now / 35);
    ctx.fillStyle = "#ff9d3c";
    ctx.beginPath();
    ctx.moveTo(-9, -5);
    ctx.lineTo(-9 - length, 0);
    ctx.lineTo(-9, 5);
    ctx.closePath();
    ctx.fill();
  }

  // blink while protected after a respawn
  ctx.globalAlpha = ship.grace > 0 && Math.floor(now / 100) % 2 === 0 ? 0.35 : 1;
  ctx.fillStyle = ship.color;
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
  ctx.globalAlpha = 1;

  if (ship.effects.shield > 0) {
    ctx.strokeStyle = "rgba(120, 220, 255, 0.8)";
    ctx.beginPath();
    ctx.arc(0, 0, 22, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

// every asteroid gets its own lumpy outline, the same on every frame
const outlines = new Map();
function outlineFor(id) {
  if (!outlines.has(id)) {
    const rand = mulberry32(id * 7919);
    outlines.set(
      id,
      Array.from({ length: 10 }, () => 0.75 + rand() * 0.4),
    );
  }
  return outlines.get(id);
}

function drawAsteroid(ctx, a, x, y, angle) {
  const outline = outlineFor(a.id);
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.fillStyle = a.parts.homing ? "#6b3a3a" : "#4a4d57";
  ctx.strokeStyle = a.parts.homing ? "#ff6b6b" : "#9aa0b0";
  ctx.lineWidth = 2;
  ctx.beginPath();
  outline.forEach((k, i) => {
    const t = (i / outline.length) * Math.PI * 2;
    const px = Math.cos(t) * a.radius * k;
    const py = Math.sin(t) * a.radius * k;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  });
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

const PICKUP_STYLE = {
  shield: { color: "#78dcff", letter: "S" },
  rapid: { color: "#ffe066", letter: "R" },
  homing: { color: "#ff8fa3", letter: "H" },
};

function drawPickup(ctx, p, x, y, now) {
  const style = PICKUP_STYLE[p.parts.pickup.effect];
  const pulse = 1 + 0.1 * Math.sin(now / 200);
  ctx.save();
  ctx.translate(x, y);
  ctx.strokeStyle = style.color;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(0, 0, p.radius * pulse, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = style.color;
  ctx.font = "bold 16px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(style.letter, 0, 1);
  ctx.restore();
}

function drawBullet(ctx, b, x, y) {
  ctx.fillStyle = b.parts.homing ? "#ff8fa3" : "#fff7b0";
  ctx.beginPath();
  ctx.arc(x, y, b.radius + 1, 0, Math.PI * 2);
  ctx.fill();
}

function drawParticle(ctx, p, x, y) {
  ctx.globalAlpha = Math.max(0, p.ttl / p.maxTtl);
  ctx.fillStyle = p.color;
  ctx.fillRect(x - 1.5, y - 1.5, 3, 3);
  ctx.globalAlpha = 1;
}

// Every entity is drawn between its previous and current position,
// alpha says how far between the two simulation steps we are.
export function drawScene(view, world, alpha, now) {
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

  for (const e of world) {
    const x = lerpWrapped(e.prevPos.x, e.pos.x, alpha, ARENA.width);
    const y = lerpWrapped(e.prevPos.y, e.pos.y, alpha, ARENA.height);
    const angle = lerpAngle(e.prevAngle, e.angle, alpha);

    if (e.kind === "ship") {
      // near an edge also draw the copy that sticks out on the other side
      for (const dx of [-ARENA.width, 0, ARENA.width]) {
        for (const dy of [-ARENA.height, 0, ARENA.height]) {
          const sx = x + dx;
          const sy = y + dy;
          if (sx < -SHIP_MARGIN || sx > ARENA.width + SHIP_MARGIN) continue;
          if (sy < -SHIP_MARGIN || sy > ARENA.height + SHIP_MARGIN) continue;
          drawShip(ctx, e, sx, sy, angle, now);
        }
      }
    } else if (e.kind === "asteroid") drawAsteroid(ctx, e, x, y, angle);
    else if (e.kind === "pickup") drawPickup(ctx, e, x, y, now);
    else if (e.kind === "bullet") drawBullet(ctx, e, x, y);
    else if (e.kind === "particle") drawParticle(ctx, e, x, y);
  }

  ctx.restore();

  ctx.strokeStyle = "#2a3a5c";
  ctx.lineWidth = 3;
  ctx.strokeRect(0, 0, ARENA.width, ARENA.height);
}
