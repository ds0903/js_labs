import { z } from "zod";

// What /assets/manifest.json must look like. It comes over HTTP, so it is
// `unknown` until this schema has parsed it.
const FrameSchema = z.tuple([z.number(), z.number(), z.number(), z.number()]);
export type Frames = Record<string, readonly [number, number, number, number]>;

export const ManifestSchema = z.object({
  sprites: z
    .record(
      z.string(),
      z.object({ url: z.string(), frames: z.record(z.string(), FrameSchema) }),
    )
    .optional(),
  sounds: z.record(z.string(), z.string()).optional(),
  arenas: z
    .record(z.string(), z.object({ asteroids: z.number(), pickups: z.boolean() }))
    .optional(),
});
export type Manifest = z.infer<typeof ManifestSchema>;

export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, url: string) {
    super(`HTTP ${status} for ${url}`);
    this.name = "HttpError";
    this.status = status;
  }
}

// a thrown value can be anything: look at its name without trusting its type
const nameOf = (err: unknown): string | undefined =>
  typeof err === "object" && err !== null && "name" in err ? String(err.name) : undefined;

export const isAbort = (err: unknown): boolean => nameOf(err) === "AbortError";

// What is worth another try: server errors, network failures, timeouts.
// A 404, a broken JSON or a file that cannot be decoded will fail again.
export function isTransient(err: unknown): boolean {
  if (err instanceof HttpError) return err.status >= 500;
  if (nameOf(err) === "TimeoutError") return true;
  return err instanceof TypeError; // fetch rejects with TypeError on network errors
}

function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export interface FetchOptions {
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
  accept?: string;
}

// fetch does not reject on 404/500, so the status is checked here once
// `accept` matters in dev: Vite answers an unknown path with index.html and
// status 200 unless the request says it wants an image or a sound.
async function fetchChecked(
  url: string,
  { signal, timeoutMs = 8000, accept }: FetchOptions = {},
): Promise<Response> {
  const response = await fetch(url, {
    signal: withTimeout(signal, timeoutMs),
    headers: accept ? { Accept: accept } : {},
  });
  if (!response.ok) throw new HttpError(response.status, url);
  return response;
}

// the body is `unknown`: the caller parses it with a schema
export async function fetchJson(url: string, options?: FetchOptions): Promise<unknown> {
  return (await fetchChecked(url, options)).json();
}

export const loadJson = fetchJson;

// POST with a JSON body. The server explains a refusal as { error }, so the
// error message is taken from there when it can be read.
export async function postJson(
  url: string,
  body: unknown,
  { signal, timeoutMs = 8000 }: FetchOptions = {},
): Promise<unknown> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: withTimeout(signal, timeoutMs),
  });
  if (!response.ok) {
    const error = new HttpError(response.status, url);
    const detail: unknown = await response.json().catch(() => null);
    if (
      typeof detail === "object" &&
      detail !== null &&
      "error" in detail &&
      typeof detail.error === "string"
    ) {
      error.message = detail.error;
    }
    throw error;
  }
  return response.json();
}

export async function loadImage(
  url: string,
  options?: FetchOptions,
): Promise<ImageBitmap> {
  const response = await fetchChecked(url, { ...options, accept: "image/*" });
  return createImageBitmap(await response.blob());
}

export async function loadAudio(
  ctx: Pick<BaseAudioContext, "decodeAudioData">,
  url: string,
  options?: FetchOptions,
): Promise<AudioBuffer> {
  const response = await fetchChecked(url, { ...options, accept: "audio/*" });
  return ctx.decodeAudioData(await response.arrayBuffer());
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export interface RetryOptions {
  attempts?: number;
  baseMs?: number;
  signal?: AbortSignal | undefined;
  onRetry?:
    | ((info: { attempt: number; delay: number; error: unknown }) => void)
    | undefined;
}

// Retries fn on transient errors with exponential backoff and jitter:
// baseMs, 2*baseMs, 4*baseMs..., each multiplied by a random 0.5-1.
export async function withRetry<T>(
  fn: () => Promise<T>,
  { attempts = 3, baseMs = 250, signal, onRetry }: RetryOptions = {},
): Promise<T> {
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
export const devUrl = (url: string): string => (slowMs ? `/slow/${slowMs}${url}` : url);

export interface Sheet {
  image: ImageBitmap;
  frames: Frames;
}

// one thing to load; `extra` items (the ?inject= experiments) have the same shape
export interface LoadItem {
  key: string;
  type: "image" | "audio" | "json";
  name: string;
  url: string;
  frames?: Frames;
  optional?: boolean;
}

export interface Assets {
  sprites: Record<string, Sheet>;
  sounds: Record<string, AudioBuffer>;
  json: Record<string, unknown>;
  failed: { key: string; error: unknown }[];
}

// what one load produced, tagged so `store` can tell which it got
type Loaded =
  | { type: "image"; value: ImageBitmap }
  | { type: "audio"; value: AudioBuffer }
  | { type: "json"; value: unknown };

function entriesOf(manifest: Manifest, extra: readonly LoadItem[]): LoadItem[] {
  return [
    ...Object.entries(manifest.sprites ?? {}).map(([name, sprite]) => ({
      key: `sprite:${name}`,
      type: "image" as const,
      name,
      url: sprite.url,
      frames: sprite.frames,
    })),
    ...Object.entries(manifest.sounds ?? {}).map(([name, url]) => ({
      key: `sound:${name}`,
      type: "audio" as const,
      name,
      url,
    })),
    ...extra,
  ];
}

export interface LoadAllOptions {
  ctx?: Pick<BaseAudioContext, "decodeAudioData">;
  signal?: AbortSignal;
  onProgress?: (fraction: number, key: string) => void;
  onRetry?: (info: {
    key: string;
    attempt: number;
    delay: number;
    error: unknown;
  }) => void;
  sequential?: boolean;
  extra?: readonly LoadItem[];
  timeoutMs?: number | undefined;
  retry?: RetryOptions;
}

// Loads everything from the manifest at the same time (Promise.all).
// onProgress(fraction, key) is called after every finished item.
// Items with `optional: true` may fail: they end up in result.failed and
// the rest still loads. A failed required item aborts the other requests.
export async function loadAll(
  manifest: Manifest,
  {
    ctx,
    signal,
    onProgress = () => {},
    onRetry,
    sequential = false,
    extra = [],
    timeoutMs,
    retry,
  }: LoadAllOptions = {},
): Promise<Assets> {
  const items = entriesOf(manifest, extra);
  const result: Assets = { sprites: {}, sounds: {}, json: {}, failed: [] };
  const inner = new AbortController();
  const allSignal = signal ? AbortSignal.any([signal, inner.signal]) : inner.signal;
  let done = 0;

  async function load(item: LoadItem): Promise<Loaded> {
    const url = devUrl(item.url);
    const options = { signal: allSignal, timeoutMs };
    switch (item.type) {
      case "image":
        return { type: "image", value: await loadImage(url, options) };
      case "audio":
        if (!ctx) throw new Error("no AudioContext to decode sounds with");
        return { type: "audio", value: await loadAudio(ctx, url, options) };
      case "json":
        return { type: "json", value: await loadJson(url, options) };
    }
  }

  function store(item: LoadItem, loaded: Loaded): void {
    switch (loaded.type) {
      case "image":
        result.sprites[item.name] = { image: loaded.value, frames: item.frames ?? {} };
        break;
      case "audio":
        result.sounds[item.name] = loaded.value;
        break;
      case "json":
        result.json[item.name] = loaded.value;
        break;
    }
  }

  async function run(item: LoadItem): Promise<void> {
    try {
      const loaded = await withRetry(() => load(item), {
        ...retry,
        signal: allSignal,
        onRetry: (info) => onRetry?.({ key: item.key, ...info }),
      });
      store(item, loaded);
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
