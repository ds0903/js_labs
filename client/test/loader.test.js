import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { afterEach, test } from "node:test";
import { HttpError, isTransient, loadAll, withRetry } from "../src/assets/loader.js";
import { Lobby } from "../src/net/lobby.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason);
    });
  });
}

// fake fetch: every request takes `ms`, urls can be mapped to a status
function fakeFetch({ ms = 0, status = {}, calls = [] } = {}) {
  globalThis.fetch = async (url, { signal } = {}) => {
    calls.push({ url, signal });
    await wait(ms, signal);
    const code = status[url] ?? 200;
    return new Response(code === 200 ? new ArrayBuffer(8) : "nope", { status: code });
  };
  return calls;
}

const ctx = { decodeAudioData: async (buffer) => ({ bytes: buffer.byteLength }) };
const manifest = {
  sounds: { a: "/a.wav", b: "/b.wav", c: "/c.wav", d: "/d.wav" },
};

test("what counts as transient", () => {
  assert.equal(isTransient(new HttpError(503, "/x")), true);
  assert.equal(isTransient(new HttpError(404, "/x")), false);
  assert.equal(isTransient(new HttpError(400, "/x")), false);
  assert.equal(isTransient(new TypeError("Failed to fetch")), true);
  assert.equal(isTransient(new SyntaxError("bad json")), false);
  assert.equal(isTransient(new DOMException("t", "TimeoutError")), true);
  assert.equal(isTransient(new DOMException("a", "AbortError")), false);
});

test("withRetry: retries a 503 with growing, jittered delays and then succeeds", async () => {
  let calls = 0;
  const delays = [];
  const result = await withRetry(
    async () => {
      calls++;
      if (calls < 3) throw new HttpError(503, "/x");
      return "ok";
    },
    { attempts: 3, baseMs: 20, onRetry: ({ delay }) => delays.push(delay) },
  );
  assert.equal(result, "ok");
  assert.equal(calls, 3);
  assert.ok(delays[0] >= 10 && delays[0] <= 20, `first delay ${delays[0]}`);
  assert.ok(delays[1] >= 20 && delays[1] <= 40, `second delay ${delays[1]}`);
});

test("withRetry: never retries a 4xx", async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(
      async () => {
        calls++;
        throw new HttpError(404, "/x");
      },
      { attempts: 5, baseMs: 1 },
    ),
    { status: 404 },
  );
  assert.equal(calls, 1);
});

test("withRetry: gives up after the last attempt", async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(
      async () => {
        calls++;
        throw new HttpError(500, "/x");
      },
      { attempts: 3, baseMs: 1 },
    ),
  );
  assert.equal(calls, 3);
});

test("withRetry: abort during the backoff pause stops it at once", async () => {
  const controller = new AbortController();
  const started = Date.now();
  const promise = withRetry(
    async () => {
      throw new HttpError(503, "/x");
    },
    { attempts: 5, baseMs: 5000, signal: controller.signal },
  );
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(promise, { name: "AbortError" });
  assert.ok(Date.now() - started < 1000);
});

test("loadAll: progress is real, ends at 1, concurrent beats sequential", async () => {
  fakeFetch({ ms: 60 });

  const progress = [];
  let t = Date.now();
  const concurrent = await loadAll(manifest, {
    ctx,
    onProgress: (p) => progress.push(p),
  });
  const concurrentMs = Date.now() - t;

  t = Date.now();
  await loadAll(manifest, { ctx, sequential: true });
  const sequentialMs = Date.now() - t;

  assert.deepEqual(progress, [0.25, 0.5, 0.75, 1]);
  assert.equal(Object.keys(concurrent.sounds).length, 4);
  assert.ok(
    sequentialMs > concurrentMs * 2,
    `sequential ${sequentialMs} ms, concurrent ${concurrentMs} ms`,
  );
});

test("loadAll: an optional item may fail, the rest loads", async () => {
  fakeFetch({ status: { "/ghost.wav": 404 } });
  const result = await loadAll(manifest, {
    ctx,
    extra: [
      {
        key: "sound:ghost",
        type: "audio",
        name: "ghost",
        url: "/ghost.wav",
        optional: true,
      },
    ],
  });
  assert.equal(Object.keys(result.sounds).length, 4);
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].error.status, 404);
});

test("loadAll: a required failure rejects and aborts the other requests", async () => {
  const calls = fakeFetch({ ms: 100, status: { "/a.wav": 404 } });
  await assert.rejects(loadAll(manifest, { ctx }), { status: 404 });
  await wait(10);
  const others = calls.filter((c) => c.url !== "/a.wav");
  assert.ok(others.length > 0);
  assert.ok(
    others.every((c) => c.signal.aborted),
    "no orphaned requests",
  );
});

test("lobby: refresh emits rooms, leave aborts the request in flight", async () => {
  const rooms = [{ id: "r1", name: "One", arena: "classic", players: 0 }];
  const calls = [];
  globalThis.fetch = async (_url, { signal }) => {
    calls.push(signal);
    await wait(30, signal);
    return Response.json(rooms);
  };

  const lobby = new Lobby({ intervalMs: 10_000 });
  const events = [];
  lobby.addEventListener("rooms", (e) => events.push(["rooms", e.detail]));
  lobby.addEventListener("error", (e) => events.push(["error", e.detail]));

  lobby.start();
  await wait(60);
  assert.deepEqual(events, [["rooms", rooms]]);

  const refreshing = lobby.refresh(); // starts a new request
  lobby.leave(); // abort while it is in flight
  await refreshing;
  assert.equal(calls.at(-1).aborted, true);
  assert.equal(events.length, 1, "an aborted refresh emits nothing");
});

test("lobby: a hanging server gives a timeout error, not an endless wait", async () => {
  globalThis.fetch = (_url, { signal }) => wait(10_000, signal);
  const lobby = new Lobby({ timeoutMs: 30, intervalMs: 10_000 });
  const errors = [];
  lobby.addEventListener("error", (e) => errors.push(e.detail));
  lobby.start();
  await wait(120);
  lobby.leave();
  assert.equal(errors.length, 1);
  assert.equal(errors[0].name, "TimeoutError");
});

test("the simulation does not import audio, hud or ui modules", () => {
  const dir = new URL("../src/sim/", import.meta.url);
  for (const file of readdirSync(dir)) {
    const source = readFileSync(new URL(file, dir), "utf8");
    const imports = source.match(/^import .* from .*$/gm) ?? [];
    for (const line of imports) {
      assert.doesNotMatch(line, /audio|hud|ui\/|loader/, `${file}: ${line}`);
    }
  }
});
