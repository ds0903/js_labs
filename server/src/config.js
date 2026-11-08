import { accessSync, constants, mkdirSync } from "node:fs";
import path from "node:path";

export class ConfigError extends Error {
  name = "ConfigError";
}

// Reads and checks everything the server takes from the environment.
// All problems are collected and reported together, so one run is enough
// to fix a bad .env.
export function loadConfig(env = process.env) {
  const errors = [];

  const int = (name, fallback, min, max) => {
    const raw = env[name];
    if (raw === undefined || raw === "") return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < min || value > max) {
      errors.push(`${name} must be an integer from ${min} to ${max}, got "${raw}"`);
      return fallback;
    }
    return value;
  };
  const flag = (name) => ["1", "true", "yes"].includes(String(env[name]).toLowerCase());

  const port = int("PORT", 3000, 0, 65535);
  const host = env.HOST || "127.0.0.1";
  const logDir = path.resolve(
    env.LOG_DIR || path.join(import.meta.dirname, "..", "logs"),
  );
  const clientDir = path.resolve(
    env.CLIENT_DIR || path.join(import.meta.dirname, "..", "..", "client", "dist"),
  );

  try {
    mkdirSync(logDir, { recursive: true });
    accessSync(logDir, constants.W_OK);
  } catch (error) {
    errors.push(`LOG_DIR "${logDir}" is not usable: ${error.message}`);
  }

  const config = {
    port,
    host,
    logDir,
    clientDir,
    maxRooms: int("MAX_ROOMS", 20, 1, 1000),
    maxPlayers: int("MAX_PLAYERS", 8, 1, 64),
    maxMessageBytes: int("MAX_MESSAGE_BYTES", 4096, 64, 1_048_576),
    maxBodyBytes: int("MAX_BODY_BYTES", 1024, 16, 1_048_576),
    rateLimitPerSec: int("RATE_LIMIT_PER_SEC", 20, 1, 1000),
    bufferedLimit: int("BUFFERED_LIMIT", 65_536, 1024, 64_000_000),
    joinTimeoutMs: int("JOIN_TIMEOUT_MS", 5000, 10, 60_000),
    pingIntervalMs: int("PING_INTERVAL_MS", 15_000, 10, 120_000),
    staleRoomMs: int("STALE_ROOM_MS", 60_000, 10, 3_600_000),
    enableSlow: flag("ENABLE_SLOW"),
    slowMs: int("SLOW_MS", 300, 1, 10_000),
  };

  if (errors.length > 0) throw new ConfigError(errors.join("; "));
  return Object.freeze(config);
}
