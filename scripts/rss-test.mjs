// Downloads a 200 MB log at a limited speed from two servers and records the
// server's RSS every 250 ms: the real one (streams) and a naive one (readFile).
//   node scripts/rss-test.mjs            -> docs/rss.svg, numbers on stdout
import { spawn } from "node:child_process";
import { mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { makeLog } from "./make-log.mjs";

const MB = 1024 * 1024;
// Nominal client speed in bytes per second. The real speed is lower: on Windows
// setTimeout cannot wait less than about 15 ms, so a 200 MB download took ~50 s (~4 MB/s).
const RATE = 10 * MB;
const SIZE_MB = 200;
const root = path.resolve(import.meta.dirname, "..");
const dir = path.join(os.tmpdir(), "arena-rss");
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
const file = path.join(dir, "big.ndjson");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function health(port) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: "127.0.0.1", port, path: "/health" }, (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve(JSON.parse(body)));
      })
      .on("error", reject);
  });
}

async function waitReady(port) {
  for (let i = 0; i < 100; i++) {
    try {
      return await health(port);
    } catch {
      await sleep(100);
    }
  }
  throw new Error(`server on ${port} did not start`);
}

// reads the response slowly: pauses after every chunk
function slowDownload(port, urlPath) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: "127.0.0.1", port, path: urlPath }, (res) => {
        let total = 0;
        res.on("data", (chunk) => {
          total += chunk.length;
          res.pause();
          setTimeout(() => res.resume(), (chunk.length / RATE) * 1000);
        });
        res.on("end", () => resolve(total));
        res.on("error", reject);
      })
      .on("error", reject);
  });
}

async function measure(name, child, port, urlPath) {
  await waitReady(port);
  await sleep(500);
  const samples = [];
  const started = Date.now();
  let running = true;
  const sampler = (async () => {
    while (running) {
      const { rss } = await health(port).catch(() => ({ rss: null }));
      if (rss) samples.push([(Date.now() - started) / 1000, rss / MB]);
      await sleep(250);
    }
  })();
  const bytes = await slowDownload(port, urlPath);
  await sleep(1000);
  running = false;
  await sampler;
  child.kill();
  const values = samples.map((s) => s[1]);
  const result = {
    name,
    downloadedMB: Math.round(bytes / MB),
    seconds: Math.round(samples.at(-1)[0] - 1),
    startMB: Math.round(values[0]),
    peakMB: Math.round(Math.max(...values)),
    samples,
  };
  console.log(
    `${name}: downloaded ${result.downloadedMB} MB, rss at start ${result.startMB} MB, peak ${result.peakMB} MB`,
  );
  return result;
}

function svg(results) {
  const W = 720;
  const H = 360;
  const pad = { l: 56, r: 20, t: 20, b: 44 };
  const maxT = Math.max(...results.flatMap((r) => r.samples.map((s) => s[0])));
  const maxM =
    Math.ceil(Math.max(...results.flatMap((r) => r.samples.map((s) => s[1]))) / 100) *
    100;
  const x = (t) => pad.l + (t / maxT) * (W - pad.l - pad.r);
  const y = (m) => H - pad.b - (m / maxM) * (H - pad.t - pad.b);
  const colors = ["#2a7de1", "#d6453d"];
  let out = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" font-family="sans-serif" font-size="12">`;
  out += `<title>Server RSS while one client downloads a ${SIZE_MB} MB log</title>`;
  out += `<rect width="${W}" height="${H}" fill="#ffffff"/>`;
  for (let m = 0; m <= maxM; m += 100) {
    out += `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(m)}" y2="${y(m)}" stroke="#e3e6ea"/>`;
    out += `<text x="${pad.l - 8}" y="${y(m) + 4}" text-anchor="end" fill="#555">${m}</text>`;
  }
  for (let t = 0; t <= maxT; t += 5) {
    out += `<text x="${x(t)}" y="${H - pad.b + 18}" text-anchor="middle" fill="#555">${t}</text>`;
  }
  out += `<text x="${W / 2}" y="${H - 6}" text-anchor="middle" fill="#333">seconds</text>`;
  out += `<text x="14" y="${H / 2}" text-anchor="middle" fill="#333" transform="rotate(-90 14 ${H / 2})">server RSS, MB</text>`;
  results.forEach((r, i) => {
    const points = r.samples
      .map(([t, m]) => `${x(t).toFixed(1)},${y(m).toFixed(1)}`)
      .join(" ");
    out += `<polyline fill="none" stroke="${colors[i]}" stroke-width="2" points="${points}"/>`;
    out += `<text x="${pad.l + 12}" y="${pad.t + 16 + i * 16}" fill="${colors[i]}">${r.name} (peak ${r.peakMB} MB)</text>`;
  });
  return `${out}</svg>\n`;
}

console.log(`making ${SIZE_MB} MB log...`);
await makeLog(file, SIZE_MB);
console.log(`file: ${Math.round(statSync(file).size / MB)} MB`);

const real = spawn(process.execPath, ["server/src/index.ts"], {
  cwd: root,
  env: { ...process.env, PORT: "3100", LOG_DIR: dir, HOST: "127.0.0.1" },
  stdio: "ignore",
});
const streams = await measure(
  "streams (this server)",
  real,
  3100,
  "/api/replays/big.ndjson",
);

const naive = spawn(process.execPath, ["scripts/naive-server.mjs"], {
  cwd: root,
  env: { ...process.env, PORT: "3101", FILE: file },
  stdio: "ignore",
});
const readFileRun = await measure("readFile (naive)", naive, 3101, "/big.ndjson");

writeFileSync(path.join(root, "docs", "rss.svg"), svg([streams, readFileRun]));
console.log("wrote docs/rss.svg");
rmSync(dir, { recursive: true, force: true });
