import { accessSync, constants, mkdirSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

export class ConfigError extends Error {
  override name = "ConfigError";
}

// An integer variable with a default and a range. The variable is a string
// (or missing, or empty), the result is a number. The message is shared by all
// three checks, so a bad value reads the same whatever is wrong with it.
const int = (fallback: number, min: number, max: number) => {
  const error = `must be an integer from ${min} to ${max}`;
  return z
    .string()
    .optional()
    .transform((raw) => (raw === undefined || raw === "" ? fallback : Number(raw)))
    .pipe(z.number({ error }).int({ error }).min(min, { error }).max(max, { error }));
};

const DEFAULT_LOG_DIR = path.join(import.meta.dirname, "..", "logs");

const flag = z
  .string()
  .optional()
  .transform((raw) => ["1", "true", "yes"].includes(String(raw).toLowerCase()));

// Everything the server takes from the environment: one schema, the defaults
// are in it, and the type `ServerConfig` is inferred from it.
const EnvSchema = z
  .object({
    PORT: int(3000, 0, 65535),
    HOST: z.string().optional(),
    LOG_DIR: z.string().optional(),
    CLIENT_DIR: z.string().optional(),
    MAX_ROOMS: int(20, 1, 1000),
    MAX_PLAYERS: int(8, 1, 64),
    MAX_MESSAGE_BYTES: int(4096, 64, 1_048_576),
    MAX_BODY_BYTES: int(1024, 16, 1_048_576),
    RATE_LIMIT_PER_SEC: int(20, 1, 1000),
    INPUT_RATE_PER_SEC: int(90, 1, 1000),
    MAX_INPUT_QUEUE: int(3, 1, 30),
    ENABLE_NETSIM: flag,
    BUFFERED_LIMIT: int(65_536, 1024, 64_000_000),
    JOIN_TIMEOUT_MS: int(5000, 10, 60_000),
    PING_INTERVAL_MS: int(15_000, 10, 120_000),
    STALE_ROOM_MS: int(60_000, 10, 3_600_000),
    ENABLE_SLOW: flag,
    SLOW_MS: int(300, 1, 10_000),
    // production: where the page may come from, and how many sockets one address may hold
    ALLOWED_ORIGINS: z.string().optional(),
    MAX_CONNECTIONS_PER_IP: int(20, 1, 10_000),
    TRUST_PROXY: flag,
    LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).optional(),
    GIT_SHA: z.string().optional(),
  })
  .transform((env) => ({
    port: env.PORT,
    host: env.HOST || "127.0.0.1",
    logDir: path.resolve(env.LOG_DIR || DEFAULT_LOG_DIR),
    clientDir: path.resolve(
      env.CLIENT_DIR || path.join(import.meta.dirname, "..", "..", "client", "dist"),
    ),
    maxRooms: env.MAX_ROOMS,
    maxPlayers: env.MAX_PLAYERS,
    maxMessageBytes: env.MAX_MESSAGE_BYTES,
    maxBodyBytes: env.MAX_BODY_BYTES,
    rateLimitPerSec: env.RATE_LIMIT_PER_SEC,
    inputRatePerSec: env.INPUT_RATE_PER_SEC,
    maxInputQueue: env.MAX_INPUT_QUEUE,
    enableNetsim: env.ENABLE_NETSIM,
    bufferedLimit: env.BUFFERED_LIMIT,
    joinTimeoutMs: env.JOIN_TIMEOUT_MS,
    pingIntervalMs: env.PING_INTERVAL_MS,
    staleRoomMs: env.STALE_ROOM_MS,
    enableSlow: env.ENABLE_SLOW,
    slowMs: env.SLOW_MS,
    // empty list: any origin may connect (development)
    allowedOrigins: (env.ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
    maxConnectionsPerIp: env.MAX_CONNECTIONS_PER_IP,
    trustProxy: env.TRUST_PROXY,
    logLevel: env.LOG_LEVEL ?? "info",
    version: env.GIT_SHA || "dev",
  }));

export type ServerConfig = Readonly<z.output<typeof EnvSchema>>;

// Reads and checks everything the server takes from the environment.
// All problems are collected and reported together, so one run is enough
// to fix a bad .env.
export function loadConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): ServerConfig {
  const errors: string[] = [];

  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const name = String(issue.path[0]);
      errors.push(`${name} ${issue.message}, got "${env[name]}"`);
    }
  }

  // checked even when something else is wrong, so all problems come at once
  const logDir = path.resolve(env.LOG_DIR || DEFAULT_LOG_DIR);
  try {
    mkdirSync(logDir, { recursive: true });
    accessSync(logDir, constants.W_OK);
  } catch (error) {
    // `error` is unknown in a catch: say so, do not assume it is an Error
    const reason = error instanceof Error ? error.message : String(error);
    errors.push(`LOG_DIR "${logDir}" is not usable: ${reason}`);
  }

  if (!parsed.success || errors.length > 0) throw new ConfigError(errors.join("; "));
  return Object.freeze(parsed.data);
}
