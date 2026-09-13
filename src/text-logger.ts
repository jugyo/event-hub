import type { Json, LogLevel, Logger } from "@jugyo/duex";

export interface TextLoggerOptions {
  level?: LogLevel;
  write?: (line: string) => void;
  base?: Record<string, Json>;
  now?: () => number;
}

const LEVELS: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const LEVEL_PREFIX: Record<LogLevel, string> = {
  debug: "",
  info: "",
  warn: "WARNING: ",
  error: "ERROR: ",
};

const SAFE_FIELDS = new Set([
  "kind",
  "code",
  "plugins",
  "created",
  "updated",
  "disabled",
  "invocationId",
  "events",
  "pages",
  "pid",
  "exitCode",
  "signal",
  "termination",
  "name",
  "from",
  "to",
  "backfillLimited",
  "page",
  "insertedEvents",
  "hasMore",
  "cursorUpdated",
  "eventId",
  "eventType",
  "attempt",
  "maxAttempts",
  "scheduledAt",
  "seq",
  "durationMs",
  "exhausted",
  "terminal",
  "delayMs",
  "availableAt",
  "wakeAt",
  "workflow",
  "status",
  "errorName",
  "scheduleId",
  "nextRunAt",
  "dropped",
  "deferred",
  "id",
  "lease",
  "runs",
  "materialized",
  "recovered",
  "woken",
  "skipped",
  "invocationVersion",
  "registeredVersion",
]);

const MAX_TEXT_LENGTH = 120;

function text(value: Json): string {
  const raw = typeof value === "string" ? value : String(value);
  const singleLine = raw.replace(/\s+/gu, " ").trim();
  return singleLine.length > MAX_TEXT_LENGTH
    ? `${singleLine.slice(0, MAX_TEXT_LENGTH - 1)}…`
    : singleLine;
}

function time(epochMs: number): string {
  const date = new Date(epochMs);
  const pad = (part: number): string => String(part).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function details(fields: Record<string, Json>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(fields)) {
    if (!SAFE_FIELDS.has(key) || value === null || value === undefined) continue;
    parts.push(`${key}=${text(value)}`);
  }
  return parts.length === 0 ? "" : ` (${parts.join(", ")})`;
}

function echoesCallerLine(event: string, fields: Record<string, Json>): boolean {
  if (event === "tick.finished") return true;
  return fields.pluginId !== undefined
    && (event === "invocation.started" || event === "invocation.completed");
}

export function formatLogLine(
  level: LogLevel,
  event: string,
  fields: Record<string, Json>,
  at: number,
): string {
  const owner = typeof fields.pluginId === "string" && fields.pluginId.length > 0
    ? `${text(fields.pluginId)} `
    : "";
  return `[${time(at)}] ${LEVEL_PREFIX[level]}${owner}${event}${details(fields)}`;
}

export class TextLogger implements Logger {
  #level: LogLevel;
  #write: (line: string) => void;
  #base: Record<string, Json>;
  #now: () => number;

  constructor(options: TextLoggerOptions = {}) {
    this.#level = options.level ?? "info";
    this.#write = options.write ?? ((line) => process.stdout.write(`${line}\n`));
    this.#base = options.base ?? {};
    this.#now = options.now ?? Date.now;
  }

  log(level: LogLevel, event: string, fields: Record<string, Json> = {}): void {
    if (LEVELS[level] < LEVELS[this.#level]) return;
    const fieldsWithBase = { ...this.#base, ...fields };
    if (this.#level !== "debug" && echoesCallerLine(event, fieldsWithBase)) return;
    try {
      this.#write(formatLogLine(level, event, fieldsWithBase, this.#now()));
    } catch {
      // Logging must never change workflow results.
    }
  }

  debug(event: string, fields?: Record<string, Json>): void {
    this.log("debug", event, fields);
  }

  info(event: string, fields?: Record<string, Json>): void {
    this.log("info", event, fields);
  }

  warn(event: string, fields?: Record<string, Json>): void {
    this.log("warn", event, fields);
  }

  error(event: string, fields?: Record<string, Json>): void {
    this.log("error", event, fields);
  }

  child(fields: Record<string, Json>): Logger {
    return new TextLogger({
      level: this.#level,
      write: this.#write,
      base: { ...this.#base, ...fields },
      now: this.#now,
    });
  }
}

