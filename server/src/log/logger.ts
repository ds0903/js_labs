import pino from "pino";
import type { Logger } from "../types.ts";

type Fields = Record<string, unknown>;

const isFields = (value: unknown): value is Fields =>
  typeof value === "object" && value !== null && !(value instanceof Error);

// Structured JSON lines on stdout (the platform collects stdout; files are not
// the place for logs in a container). Call it as log.info("text") or
// log.info({ roomId, playerId }, "player.joined"): a leading object becomes
// fields of the line, an Error becomes `err` with its stack.
export function createLogger(level: string, version: string): Logger {
  const base = pino({
    level,
    base: { version },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
  });

  function write(severity: "info" | "warn" | "error", args: unknown[]): void {
    const [first, ...rest] = args;
    const fields: Fields = isFields(first) ? first : {};
    const parts = isFields(first) ? rest : args;
    const error = parts.find((part): part is Error => part instanceof Error);
    const text = parts
      .map((part) => (part instanceof Error ? part.message : String(part)))
      .join(" ");
    base[severity]({ ...fields, ...(error && { err: error }) }, text);
  }

  return {
    info: (...args) => write("info", args),
    warn: (...args) => write("warn", args),
    error: (...args) => write("error", args),
  };
}
