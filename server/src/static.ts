import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { pipeline } from "node:stream";

const MIME: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".wav": "audio/wav",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
  ".map": "application/json",
};

export const mimeFor = (file: string): string =>
  MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream";

// Maps a URL path to a file inside `root`, or returns null if the path is
// not allowed: bad encoding, NUL byte, backslash, any ".." segment (also
// when it was percent-encoded), or a result outside of root.
export function resolveStaticPath(root: string, urlPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes("\0") || decoded.includes("\\")) return null;
  if (decoded.split("/").includes("..")) return null;

  const relative = decoded === "/" ? "/index.html" : decoded;
  const file = path.resolve(root, `.${relative}`);
  if (file !== root && !file.startsWith(root + path.sep)) return null;
  return file;
}

// Streams the file to the response, it is never read into memory whole.
export async function serveStatic(
  root: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  // raw path: new URL() would quietly collapse ".." before the guard sees it.
  // `req.url` is optional in the types (it is not set on a client request).
  const pathname = (req.url ?? "/").split(/[?#]/)[0] ?? "/";
  const file = resolveStaticPath(root, pathname);
  if (!file) {
    res.writeHead(400, { "Content-Type": "text/plain" }).end("bad path");
    return;
  }

  let info: Awaited<ReturnType<typeof stat>> | null;
  try {
    info = await stat(file);
  } catch {
    info = null;
  }
  if (!info?.isFile()) {
    res.writeHead(404, { "Content-Type": "text/plain" }).end("not found");
    return;
  }

  res.writeHead(200, { "Content-Type": mimeFor(file), "Content-Length": info.size });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  pipeline(createReadStream(file), res, () => {});
}
