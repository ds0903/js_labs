import { ARENA } from "shared/sim/arena";
import type { PickupEffect } from "shared/sim/effects";
import type { Entity } from "shared/sim/entity";
import { mulberry32 } from "shared/sim/random";
import { isKind } from "shared/sim/world";
import type { Sheet } from "../assets/loader.ts";
import type { View } from "./canvas.ts";
import { lerpAngle, lerpWrapped } from "./interpolate.ts";

const GRID = 100;
const SHIP_MARGIN = 30;

// What the renderer needs to know about a thing it draws. Local entities and
// remote ones (from snapshots) are both turned into this, so drawing does not
// care where a thing comes from, and each kind carries exactly its own fields.
interface Point {
  readonly x: number;
  readonly y: number;
}
interface Base {
  id: number;
  pos: Point;
  prevPos: Point;
  angle: number;
  prevAngle: number;
  radius: number;
}
export type Drawable = Base &
  (
    | {
        kind: "ship";
        thrusting: boolean;
        grace: number;
        shield: number;
        sprite: string;
        color: string;
      }
    | { kind: "asteroid"; hunter: boolean }
    | { kind: "pickup"; effect: PickupEffect }
    | { kind: "bullet"; homing: boolean }
    | { kind: "particle"; ttl: number; maxTtl: number; color: string }
  );
type DrawOf<K extends Drawable["kind"]> = Extract<Drawable, { kind: K }>;

export interface Sprites {
  sheet?: Sheet | undefined;
}

// a simulation entity as something drawable (null: nothing to draw)
export function drawableOf(e: Entity): Drawable | null {
  const base = {
    id: e.id,
    pos: e.pos,
    prevPos: e.prevPos,
    angle: e.angle,
    prevAngle: e.prevAngle,
    radius: e.radius,
  };
  if (isKind(e, "ship")) {
    return {
      ...base,
      kind: "ship",
      thrusting: e.thrusting,
      grace: e.grace,
      shield: e.effects.shield,
      sprite: e.sprite,
      color: e.color,
    };
  }
  if (isKind(e, "asteroid"))
    return { ...base, kind: "asteroid", hunter: Boolean(e.parts.homing) };
  if (isKind(e, "bullet"))
    return { ...base, kind: "bullet", homing: Boolean(e.parts.homing) };
  if (isKind(e, "particle")) {
    return { ...base, kind: "particle", ttl: e.ttl, maxTtl: e.maxTtl, color: e.color };
  }
  if (isKind(e, "pickup") && e.parts.pickup) {
    return { ...base, kind: "pickup", effect: e.parts.pickup.effect };
  }
  return null;
}

const random = mulberry32(1337);
const stars = Array.from({ length: 160 }, () => ({
  x: random() * ARENA.width,
  y: random() * ARENA.height,
  r: 0.6 + random() * 1.4,
  a: 0.25 + random() * 0.6,
}));

function drawBackground(ctx: CanvasRenderingContext2D) {
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

// sprite sheets point right (+x), `size` is the width of the whole 64x64 cell
function drawSprite(
  ctx: CanvasRenderingContext2D,
  sheet: Sheet,
  name: string,
  size: number,
) {
  const frame = sheet.frames[name];
  if (!frame) return; // a name the sheet does not have: draw nothing
  const [sx, sy, sw, sh] = frame;
  ctx.drawImage(sheet.image, sx, sy, sw, sh, -size / 2, -size / 2, size, size);
}

function drawShip(
  ctx: CanvasRenderingContext2D,
  ship: DrawOf<"ship">,
  x: number,
  y: number,
  angle: number,
  now: number,
  sheet: Sheet | undefined,
) {
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
  if (sheet) {
    drawSprite(ctx, sheet, ship.sprite, 46);
  } else {
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
  }
  ctx.globalAlpha = 1;

  if (ship.shield > 0) {
    ctx.strokeStyle = "rgba(120, 220, 255, 0.8)";
    ctx.beginPath();
    ctx.arc(0, 0, 22, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

// every asteroid gets its own lumpy outline, the same on every frame
const outlines = new Map<number, number[]>();
function outlineFor(id: number): number[] {
  let outline = outlines.get(id);
  if (!outline) {
    const rand = mulberry32(id * 7919);
    outline = Array.from({ length: 10 }, () => 0.75 + rand() * 0.4);
    outlines.set(id, outline);
  }
  return outline;
}

function drawAsteroid(
  ctx: CanvasRenderingContext2D,
  a: DrawOf<"asteroid">,
  x: number,
  y: number,
  angle: number,
  sheet: Sheet | undefined,
) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  if (sheet) {
    // the rock in the sheet has a radius of about 25 of 64 pixels
    drawSprite(
      ctx,
      sheet,
      a.hunter ? "asteroidHunter" : "asteroid",
      (a.radius / 25) * 64,
    );
    ctx.restore();
    return;
  }
  const outline = outlineFor(a.id);
  ctx.fillStyle = a.hunter ? "#6b3a3a" : "#4a4d57";
  ctx.strokeStyle = a.hunter ? "#ff6b6b" : "#9aa0b0";
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

const PICKUP_STYLE: Record<
  PickupEffect,
  { color: string; letter: string; sprite: string }
> = {
  shield: { color: "#78dcff", letter: "S", sprite: "pickupShield" },
  rapid: { color: "#ffe066", letter: "R", sprite: "pickupRapid" },
  homing: { color: "#ff8fa3", letter: "H", sprite: "pickupHoming" },
};

function drawPickup(
  ctx: CanvasRenderingContext2D,
  p: DrawOf<"pickup">,
  x: number,
  y: number,
  now: number,
  sheet: Sheet | undefined,
) {
  const style = PICKUP_STYLE[p.effect];
  const pulse = 1 + 0.1 * Math.sin(now / 200);
  ctx.save();
  ctx.translate(x, y);
  if (sheet) {
    drawSprite(ctx, sheet, style.sprite, 45 * pulse);
    ctx.restore();
    return;
  }
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

function drawBullet(
  ctx: CanvasRenderingContext2D,
  b: DrawOf<"bullet">,
  x: number,
  y: number,
  sheet: Sheet | undefined,
) {
  if (sheet) {
    ctx.save();
    ctx.translate(x, y);
    drawSprite(ctx, sheet, b.homing ? "bulletHoming" : "bullet", 40);
    ctx.restore();
    return;
  }
  ctx.fillStyle = b.homing ? "#ff8fa3" : "#fff7b0";
  ctx.beginPath();
  ctx.arc(x, y, b.radius + 1, 0, Math.PI * 2);
  ctx.fill();
}

function drawParticle(
  ctx: CanvasRenderingContext2D,
  p: DrawOf<"particle">,
  x: number,
  y: number,
) {
  ctx.globalAlpha = Math.max(0, p.ttl / p.maxTtl);
  ctx.fillStyle = p.color;
  ctx.fillRect(x - 1.5, y - 1.5, 3, 3);
  ctx.globalAlpha = 1;
}

// Every thing is drawn between its previous and current position,
// alpha says how far between the two simulation steps we are.
export function drawScene(
  view: View,
  scene: Iterable<Drawable>,
  alpha: number,
  now: number,
  sprites?: Sprites,
): void {
  const { ctx, canvas, dpr, scale } = view;
  const sheet = sprites?.sheet; // without it everything is drawn as vector shapes

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

  for (const e of scene) {
    const x = lerpWrapped(e.prevPos.x, e.pos.x, alpha, ARENA.width);
    const y = lerpWrapped(e.prevPos.y, e.pos.y, alpha, ARENA.height);
    const angle = lerpAngle(e.prevAngle, e.angle, alpha);

    switch (e.kind) {
      case "ship":
        // near an edge also draw the copy that sticks out on the other side
        for (const dx of [-ARENA.width, 0, ARENA.width]) {
          for (const dy of [-ARENA.height, 0, ARENA.height]) {
            const sx = x + dx;
            const sy = y + dy;
            if (sx < -SHIP_MARGIN || sx > ARENA.width + SHIP_MARGIN) continue;
            if (sy < -SHIP_MARGIN || sy > ARENA.height + SHIP_MARGIN) continue;
            drawShip(ctx, e, sx, sy, angle, now, sheet);
          }
        }
        break;
      case "asteroid":
        drawAsteroid(ctx, e, x, y, angle, sheet);
        break;
      case "pickup":
        drawPickup(ctx, e, x, y, now, sheet);
        break;
      case "bullet":
        drawBullet(ctx, e, x, y, sheet);
        break;
      case "particle":
        drawParticle(ctx, e, x, y);
        break;
      default:
        assertNever(e);
    }
  }

  ctx.restore();

  ctx.strokeStyle = "#2a3a5c";
  ctx.lineWidth = 3;
  ctx.strokeRect(0, 0, ARENA.width, ARENA.height);
}

// the compiler complains here when a new kind of thing has no drawing code
function assertNever(value: never): never {
  throw new Error(`cannot draw ${JSON.stringify(value)}`);
}
