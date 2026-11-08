import http from "node:http";
import { pathToFileURL } from "node:url";
import { ConfigError, loadConfig } from "./config.js";
import { createHandler, HttpError, sendJson } from "./http.js";
import { CLOSE } from "./protocol.js";
import { RoomManager } from "./rooms.js";
import { attachWebSocket } from "./ws.js";

const stamp = () => new Date().toISOString();
export const consoleLog = {
  info: (...args) => console.log(stamp(), "INFO", ...args),
  warn: (...args) => console.warn(stamp(), "WARN", ...args),
  error: (...args) => console.error(stamp(), "ERROR", ...args),
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < end) await sleep(20);
}

export function createApp(config = loadConfig(), { log = consoleLog } = {}) {
  const stats = { dropped: 0 };
  const rooms = new RoomManager({
    ...config,
    onError: (error) => log.error("match log failed", error.message),
  });

  let wsPart = null;
  const handle = createHandler({
    config,
    rooms,
    stats,
    connections: () => wsPart?.wss.clients.size ?? 0,
  });

  const server = http.createServer((req, res) => {
    handle(req, res).catch((error) => {
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
  wsPart = attachWebSocket(server, { rooms, config, stats, log });
  const { wss } = wsPart;

  return {
    server,
    wss,
    rooms,
    config,

    listen() {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(config.port, config.host, () => {
          server.off("error", reject);
          resolve(server.address().port);
        });
      });
    },

    // stop accepting, say goodbye to every socket, flush the match logs
    async close() {
      const closed = new Promise((resolve) => server.close(resolve));
      server.closeIdleConnections();
      for (const ws of wss.clients) ws.close(CLOSE.GOING_AWAY, "server shutting down");
      await waitFor(() => wss.clients.size === 0, 1000);
      for (const ws of wss.clients) ws.terminate();
      wsPart.stopHeartbeat();
      rooms.closeAll();
      await rooms.flush();
      server.closeAllConnections();
      await closed;
    },
  };
}

// close everything, then exit with code 0
export function createShutdown(app, { exit = process.exit, log = consoleLog } = {}) {
  return async (signal) => {
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

export function installShutdown(app, options) {
  const shutdown = createShutdown(app, options);
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, () => shutdown(signal));
}

async function main() {
  let config;
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
