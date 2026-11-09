import http from "node:http";
import { pathToFileURL } from "node:url";
import { ConfigError, loadConfig, type ServerConfig } from "./config.ts";
import { createHandler, HttpError, sendJson } from "./http.ts";
import { CLOSE } from "./protocol.ts";
import { RoomManager } from "./rooms.ts";
import type { Logger } from "./types.ts";
import { attachWebSocket } from "./ws.ts";

const stamp = () => new Date().toISOString();
export const consoleLog: Logger = {
  info: (...args) => console.log(stamp(), "INFO", ...args),
  warn: (...args) => console.warn(stamp(), "WARN", ...args),
  error: (...args) => console.error(stamp(), "ERROR", ...args),
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < end) await sleep(20);
}

export function createApp(
  config: ServerConfig = loadConfig(),
  { log = consoleLog }: { log?: Logger } = {},
) {
  const stats = { dropped: 0 };
  const rooms = new RoomManager({
    ...config,
    onError: (error) => log.error("match log failed", error.message),
  });

  const server = http.createServer();
  const { wss, stopHeartbeat } = attachWebSocket(server, { rooms, config, stats, log });
  const handle = createHandler({
    config,
    rooms,
    stats,
    connections: () => wss.clients.size,
  });

  server.on("request", (req, res) => {
    handle(req, res).catch((error: unknown) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (error instanceof HttpError) {
        // the connection is closed after an error, so an unread body does no harm
        sendJson(res, error.status, { error: error.message }, { Connection: "close" });
        return;
      }
      log.error("request failed", req.method, req.url, error);
      sendJson(res, 500, { error: "internal error" });
    });
  });
  server.on("error", (error) => log.error("http server error", error.message));

  return {
    server,
    wss,
    rooms,
    config,

    listen(): Promise<number> {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(config.port, config.host, () => {
          server.off("error", reject);
          const address = server.address();
          // a string only for a pipe or a socket file, which we never listen on
          if (address === null || typeof address === "string") {
            reject(new Error("server has no TCP address"));
            return;
          }
          resolve(address.port);
        });
      });
    },

    // stop accepting, say goodbye to every socket, flush the match logs
    async close(): Promise<void> {
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeIdleConnections();
      for (const ws of wss.clients) ws.close(CLOSE.GOING_AWAY, "server shutting down");
      await waitFor(() => wss.clients.size === 0, 1000);
      for (const ws of wss.clients) ws.terminate();
      stopHeartbeat();
      rooms.closeAll();
      await rooms.flush();
      server.closeAllConnections();
      await closed;
    },
  };
}

export type App = ReturnType<typeof createApp>;

export interface ShutdownOptions {
  exit?: (code: number) => void;
  log?: Logger;
}

// close everything, then exit with code 0
export function createShutdown(
  app: Pick<App, "close">,
  { exit = process.exit, log = consoleLog }: ShutdownOptions = {},
) {
  return async (signal: string): Promise<void> => {
    log.info(`${signal} received, shutting down`);
    try {
      await app.close();
      log.info("bye");
      exit(0);
    } catch (error) {
      log.error("shutdown failed", error);
      exit(1);
    }
  };
}

export function installShutdown(app: Pick<App, "close">, options?: ShutdownOptions): void {
  const shutdown = createShutdown(app, options);
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, () => shutdown(signal));
}

async function main(): Promise<void> {
  let config: ServerConfig;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      consoleLog.error(`bad configuration: ${error.message}`);
      process.exit(2);
    }
    throw error;
  }
  const app = createApp(config);
  installShutdown(app);
  const port = await app.listen();
  consoleLog.info(`listening on http://${config.host}:${port}, logs in ${config.logDir}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
