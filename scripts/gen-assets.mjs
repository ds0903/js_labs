// Generates the game assets so the repo does not depend on downloaded art:
//   client/public/assets/sprites.png  sprite sheet, 4x3 cells of 64x64
//   client/public/assets/*.wav        three short sounds
// Run: node scripts/gen-assets.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import zlib from "node:zlib";

const OUT = new URL("../client/public/assets/", import.meta.url);
mkdirSync(OUT, { recursive: true });

// ---------- sprites ----------

const CELL = 64;
const COLS = 4;
const ROWS = 3;
const W = CELL * COLS;
const H = CELL * ROWS;
const pixels = new Uint8Array(W * H * 4);

function hex(color) {
  return [1, 3, 5].map((i) => Number.parseInt(color.slice(i, i + 2), 16));
}

// signed distance to a polygon (negative inside)
function polygonSdf(points) {
  return (x, y) => {
    let dist = Number.POSITIVE_INFINITY;
    let inside = false;
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
      const [ax, ay] = points[j];
      const [bx, by] = points[i];
      const ex = bx - ax;
      const ey = by - ay;
      const t = Math.max(
        0,
        Math.min(1, ((x - ax) * ex + (y - ay) * ey) / (ex * ex + ey * ey)),
      );
      dist = Math.min(dist, Math.hypot(x - ax - ex * t, y - ay - ey * t));
      if (ay > y !== by > y && x < ((bx - ax) * (y - ay)) / (by - ay) + ax)
        inside = !inside;
    }
    return inside ? -dist : dist;
  };
}

const circleSdf = (r) => (x, y) => Math.hypot(x, y) - r;
const ringSdf = (r, w) => (x, y) => Math.abs(Math.hypot(x, y) - r) - w / 2;
const outline = (sdf, w) => (x, y) => Math.abs(sdf(x, y)) - w / 2;
function lineSdf([ax, ay], [bx, by], w) {
  return (x, y) => {
    const ex = bx - ax;
    const ey = by - ay;
    const t = Math.max(
      0,
      Math.min(1, ((x - ax) * ex + (y - ay) * ey) / (ex * ex + ey * ey)),
    );
    return Math.hypot(x - ax - ex * t, y - ay - ey * t) - w / 2;
  };
}

// draws a shape into cell (col,row); coordinates are centered on the cell
function paint(col, row, sdf, color, alpha = 1) {
  const [r, g, b] = hex(color);
  for (let py = 0; py < CELL; py++) {
    for (let px = 0; px < CELL; px++) {
      const cover = Math.max(
        0,
        Math.min(1, 0.5 - sdf(px - CELL / 2 + 0.5, py - CELL / 2 + 0.5)),
      );
      if (cover === 0) continue;
      const i = ((row * CELL + py) * W + col * CELL + px) * 4;
      const a = cover * alpha;
      const old = pixels[i + 3] / 255;
      const outA = a + old * (1 - a);
      pixels[i] = (r * a + pixels[i] * old * (1 - a)) / outA;
      pixels[i + 1] = (g * a + pixels[i + 1] * old * (1 - a)) / outA;
      pixels[i + 2] = (b * a + pixels[i + 2] * old * (1 - a)) / outA;
      pixels[i + 3] = outA * 255;
    }
  }
}

// ships point to the right (+x), the game rotates them
const shipShape = polygonSdf([
  [30, 0],
  [-20, -18],
  [-10, 0],
  [-20, 18],
]);
paint(0, 0, shipShape, "#cfe3ff");
paint(0, 0, outline(shipShape, 2.4), "#5b8def");
paint(1, 0, shipShape, "#ffd9a8");
paint(1, 0, outline(shipShape, 2.4), "#e08a3c");

// the same lumpy rock, grey and red
let seed = 7;
const rand = () => {
  seed = (seed * 16807) % 2147483647;
  return seed / 2147483647;
};
const rock = polygonSdf(
  Array.from({ length: 10 }, (_, i) => {
    const t = (i / 10) * Math.PI * 2;
    const k = 22 + rand() * 6;
    return [Math.cos(t) * k, Math.sin(t) * k];
  }),
);
paint(2, 0, rock, "#4a4d57");
paint(2, 0, outline(rock, 2.4), "#9aa0b0");
paint(3, 0, rock, "#6b3a3a");
paint(3, 0, outline(rock, 2.4), "#ff6b6b");

// pickups: ring + a symbol
paint(0, 1, ringSdf(20, 4), "#78dcff");
paint(0, 1, circleSdf(8), "#78dcff", 0.8);
paint(1, 1, ringSdf(20, 4), "#ffe066");
for (const dx of [-9, 0, 9]) paint(1, 1, lineSdf([dx, -8], [dx, 8], 4), "#ffe066");
paint(2, 1, ringSdf(20, 4), "#ff8fa3");
paint(2, 1, ringSdf(8, 3), "#ff8fa3");
paint(2, 1, lineSdf([-14, 0], [14, 0], 2.5), "#ff8fa3");
paint(2, 1, lineSdf([0, -14], [0, 14], 2.5), "#ff8fa3");

// bullets with a soft glow
paint(3, 1, circleSdf(10), "#fff7b0", 0.25);
paint(3, 1, circleSdf(6), "#fff7b0", 0.5);
paint(3, 1, circleSdf(3.5), "#ffffff");
paint(0, 2, circleSdf(10), "#ff8fa3", 0.25);
paint(0, 2, circleSdf(6), "#ff8fa3", 0.5);
paint(0, 2, circleSdf(3.5), "#ffffff");

function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(rgba.buffer, y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8); // 8 bit, RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

writeFileSync(new URL("sprites.png", OUT), encodePng(W, H, pixels));

// ---------- sounds ----------

const RATE = 22050;

function wav(samples) {
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) => {
    data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, s)) * 32767), i * 2);
  });
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(RATE, 24);
  header.writeUInt32LE(RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

function sound(seconds, fn) {
  return wav(
    Array.from({ length: Math.floor(seconds * RATE) }, (_, i) => fn(i / RATE, i)),
  );
}

let noiseSeed = 12345;
const noise = () => {
  noiseSeed = (noiseSeed * 1103515245 + 12345) & 0x7fffffff;
  return noiseSeed / 0x3fffffff - 1;
};

// laser: falling pitch
writeFileSync(
  new URL("shoot.wav", OUT),
  sound(0.15, (t) => {
    const freq = 900 - 4000 * t;
    return Math.sign(Math.sin(2 * Math.PI * freq * t)) * 0.25 * Math.exp(-t * 18);
  }),
);

// hit: short noisy tick
writeFileSync(
  new URL("hit.wav", OUT),
  sound(
    0.1,
    (t) => (noise() * 0.6 + Math.sin(2 * Math.PI * 180 * t) * 0.4) * Math.exp(-t * 35),
  ),
);

// explosion: low-passed noise with a decaying thump
let low = 0;
writeFileSync(
  new URL("explosion.wav", OUT),
  sound(0.7, (t) => {
    low += (noise() - low) * 0.12;
    return (low * 1.6 + Math.sin(2 * Math.PI * 55 * t) * 0.5) * Math.exp(-t * 5) * 0.8;
  }),
);

console.log("assets written to public/assets");
