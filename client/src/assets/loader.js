export class HttpError extends Error {
  constructor(status, url) {
    super(`HTTP ${status} for ${url}`);
    this.name = "HttpError";
    this.status = status;
  }
}

export const isAbort = (err) => err?.name === "AbortError";

// What is worth another try: server errors, network failures, timeouts.
// A 404, a broken JSON or a file that cannot be decoded will fail again.
export function isTransient(err) {
  if (err instanceof HttpError) return err.status >= 500;
  if (err?.name === "TimeoutError") return true;
  return err instanceof TypeError; // fetch rejects with TypeError on network errors
}

function withTimeout(signal, ms) {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

// fetch does not reject on 404/500, so the status is checked here once
// `accept` matters in dev: Vite answers an unknown path with index.html and
// status 200 unless the request says it wants an image or a sound.
async function fetchChecked(url, { signal, timeoutMs = 8000, accept } = {}) {
  const response = await fetch(url, {
    signal: withTimeout(signal, timeoutMs),
    headers: accept ? { Accept: accept } : undefined,
  });
  if (!response.ok) throw new HttpError(response.status, url);
  return response;
}

export async function fetchJson(url, options) {
  return (await fetchChecked(url, options)).json();
}

export const loadJson = fetchJson;

export async function loadImage(url, options) {
  const response = await fetchChecked(url, { ...options, accept: "image/*" });
  return createImageBitmap(await response.blob());
}

export async function loadAudio(ctx, url, options) {
  const response = await fetchChecked(url, { ...options, accept: "audio/*" });
  return ctx.decodeAudioData(await response.arrayBuffer());
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

// Retries fn on transient errors with exponential backoff and jitter:
// baseMs, 2*baseMs, 4*baseMs..., each multiplied by a random 0.5-1.
export async function withRetry(
  fn,
  { attempts = 3, baseMs = 250, signal, onRetry } = {},
) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (signal?.aborted || isAbort(error)) throw error;
      if (!isTransient(error) || attempt >= attempts) throw error;
      const delay = baseMs * 2 ** (attempt - 1) * (0.5 + Math.random() * 0.5);
      onRetry?.({ attempt, delay, error });
      await sleep(delay, signal);
    }
  }
}

// dev helper: ?slow=300 sends every asset request through the delaying middleware
const slowMs = Number(new URLSearchParams(globalThis.location?.search).get("slow") || 0);
export const devUrl = (url) => (slowMs ? `/slow/${slowMs}${url}` : url);

function entriesOf(manifest, extra) {
  return [
    ...Object.entries(manifest.sprites ?? {}).map(([name, sprite]) => ({
      key: `sprite:${name}`,
      type: "image",
      group: "sprites",
      name,
      url: sprite.url,
      frames: sprite.frames,
    })),
    ...Object.entries(manifest.sounds ?? {}).map(([name, url]) => ({
      key: `sound:${name}`,
      type: "audio",
      group: "sounds",
      name,
      url,
    })),
    ...extra,
  ];
}

// Loads everything from the manifest at the same time (Promise.all).
// onProgress(fraction, key) is called after every finished item.
// Items with `optional: true` may fail: they end up in result.failed and
// the rest still loads. A failed required item aborts the other requests.
export async function loadAll(
  manifest,
  {
    ctx,
    signal,
    onProgress = () => {},
    onRetry,
    sequential = false,
    extra = [],
    timeoutMs,
    retry,
  } = {},
) {
  const items = entriesOf(manifest, extra);
  const result = { sprites: {}, sounds: {}, json: {}, failed: [] };
  const inner = new AbortController();
  const allSignal = signal ? AbortSignal.any([signal, inner.signal]) : inner.signal;
  let done = 0;

  function load(item) {
    const url = devUrl(item.url);
    const options = { signal: allSignal, timeoutMs };
    if (item.type === "image") return loadImage(url, options);
    if (item.type === "audio") return loadAudio(ctx, url, options);
    return loadJson(url, options);
  }

  function store(item, value) {
    if (item.type === "image")
      result.sprites[item.name] = { image: value, frames: item.frames };
    else if (item.type === "audio") result.sounds[item.name] = value;
    else result.json[item.name] = value;
  }

  async function run(item) {
    try {
      const value = await withRetry(() => load(item), {
        ...retry,
        signal: allSignal,
        onRetry: (info) => onRetry?.({ key: item.key, ...info }),
      });
      store(item, value);
    } catch (error) {
      if (!item.optional || isAbort(error)) throw error;
      result.failed.push({ key: item.key, error });
    }
    done++;
    onProgress(done / items.length, item.key);
  }

  try {
    if (sequential) {
      for (const item of items) await run(item);
    } else {
      await Promise.all(items.map(run));
    }
  } catch (error) {
    inner.abort(); // do not leave the other requests running
    throw error;
  }
  return result;
}
