import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { Json, Logger, WorkflowContext } from "@jugyo/duex";
import type { HistoryPage, HistoryQuery } from "../../storage/event-store.ts";
import type { HostToPluginMessage, PluginErrorCode, PluginToHostMessage } from "./contract.ts";

export type PluginProcessErrorCode =
  PluginErrorCode | "PLUGIN_PROCESS_EXITED" | "PLUGIN_PROCESS_DISCONNECTED" | "PLUGIN_TIMEOUT";

const errorMessages: Record<PluginProcessErrorCode, string> = {
  PLUGIN_STEP_FAILED: "plugin step failed",
  PLUGIN_PROTOCOL_VIOLATION: "plugin protocol violation",
  PLUGIN_IMPORT_FAILED: "plugin import failed",
  PLUGIN_EXECUTION_FAILED: "plugin execution failed",
  PLUGIN_PROCESS_EXITED: "plugin process exited before completion",
  PLUGIN_PROCESS_DISCONNECTED: "plugin process disconnected before completion",
  PLUGIN_TIMEOUT: "plugin execution timed out",
};
const workerPath = fileURLToPath(
  new URL(import.meta.url.endsWith(".ts") ? "./worker.ts" : "./worker.js", import.meta.url),
);

export interface SecretProvider {
  get(name: string): Promise<string | undefined> | string | undefined;
}
export interface RunPluginProcessOptions {
  context: WorkflowContext;
  entry: string;
  input: Json;
  env: Record<string, string>;
  secrets: SecretProvider;
  timeoutMs?: number;
  onSpawn?: (child: ChildProcess) => void;
  queryHistory?: (query: HistoryQuery) => HistoryPage;
  logger?: Logger;
}

export class PluginProcessError extends Error {
  readonly code: PluginProcessErrorCode;
  readonly terminal: boolean;
  constructor(code: PluginProcessErrorCode, terminal = false) {
    super(errorMessages[code]);
    this.name = "PluginProcessError";
    this.code = code;
    this.terminal = terminal;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}
function isJson(value: unknown): value is Json {
  if (value === null || typeof value === "boolean" || typeof value === "string") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJson);
  return isRecord(value) && Object.values(value).every(isJson);
}
function isRetryPolicy(value: unknown): boolean {
  if (!isRecord(value) || !hasOnlyKeys(value, ["maxAttempts", "initialDelayMs", "factor", "maxDelayMs"])) return false;
  return (
    Number.isInteger(value.maxAttempts) &&
    (value.maxAttempts as number) > 0 &&
    typeof value.initialDelayMs === "number" &&
    Number.isFinite(value.initialDelayMs) &&
    value.initialDelayMs >= 0 &&
    (value.factor === undefined ||
      (typeof value.factor === "number" && Number.isFinite(value.factor) && value.factor >= 0)) &&
    (value.maxDelayMs === undefined ||
      (typeof value.maxDelayMs === "number" && Number.isFinite(value.maxDelayMs) && value.maxDelayMs >= 0))
  );
}
function isRequestId(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}
function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
function isHistoryQuery(value: unknown): value is HistoryQuery {
  if (!isRecord(value) || !hasOnlyKeys(value, ["from", "to", "eventTypes", "sourceIds", "limit", "after"]))
    return false;
  return (
    typeof value.from === "string" &&
    typeof value.to === "string" &&
    (value.eventTypes === undefined || isStringArray(value.eventTypes)) &&
    (value.sourceIds === undefined || isStringArray(value.sourceIds)) &&
    (value.limit === undefined || Number.isInteger(value.limit)) &&
    (value.after === undefined || typeof value.after === "string")
  );
}
const pluginErrorCodes = new Set<PluginErrorCode>([
  "PLUGIN_STEP_FAILED",
  "PLUGIN_PROTOCOL_VIOLATION",
  "PLUGIN_IMPORT_FAILED",
  "PLUGIN_EXECUTION_FAILED",
]);

function parsePluginMessage(raw: unknown): PluginToHostMessage | null {
  if (!isRecord(raw) || typeof raw.type !== "string") return null;
  if (raw.type === "step.request") {
    if (
      !hasOnlyKeys(raw, ["type", "requestId", "name", "retry"]) ||
      !isRequestId(raw.requestId) ||
      typeof raw.name !== "string" ||
      raw.name === "" ||
      (raw.retry !== undefined && !isRetryPolicy(raw.retry))
    )
      return null;
    return raw as unknown as PluginToHostMessage;
  }
  if (raw.type === "history.request") {
    return hasOnlyKeys(raw, ["type", "requestId", "query"]) && isRequestId(raw.requestId) && isHistoryQuery(raw.query)
      ? (raw as unknown as PluginToHostMessage)
      : null;
  }
  if (raw.type === "step.executed") {
    if (!hasOnlyKeys(raw, ["type", "requestId", "result", "errorCode", "terminal"]) || !isRequestId(raw.requestId))
      return null;
    const hasResult = Object.hasOwn(raw, "result");
    const hasError = Object.hasOwn(raw, "errorCode");
    if (
      hasResult === hasError ||
      (hasResult && !isJson(raw.result)) ||
      (hasError && (typeof raw.errorCode !== "string" || !pluginErrorCodes.has(raw.errorCode as PluginErrorCode))) ||
      (raw.terminal !== undefined && typeof raw.terminal !== "boolean")
    )
      return null;
    return raw as unknown as PluginToHostMessage;
  }
  if (raw.type === "plugin.completed") {
    return hasOnlyKeys(raw, ["type", "result"]) && isJson(raw.result) ? (raw as unknown as PluginToHostMessage) : null;
  }
  if (raw.type === "plugin.failed") {
    return hasOnlyKeys(raw, ["type", "errorCode", "terminal"]) &&
      typeof raw.errorCode === "string" &&
      pluginErrorCodes.has(raw.errorCode as PluginErrorCode) &&
      (raw.terminal === undefined || typeof raw.terminal === "boolean")
      ? (raw as unknown as PluginToHostMessage)
      : null;
  }
  return null;
}

export async function resolvePluginEnvironment(
  mapping: Record<string, string>,
  secrets: SecretProvider,
): Promise<NodeJS.ProcessEnv> {
  const environment: NodeJS.ProcessEnv = {};
  for (const [pluginName, managedName] of Object.entries(mapping)) {
    const value = await secrets.get(managedName);
    if (value !== undefined) environment[pluginName] = value;
  }
  return environment;
}

export async function runPluginProcess(options: RunPluginProcessOptions): Promise<Json> {
  const child = fork(workerPath, [], {
    env: await resolvePluginEnvironment(options.env, options.secrets),
    execArgv: workerPath.endsWith(".ts") ? ["--experimental-strip-types"] : [],
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  options.logger?.debug("plugin.process_spawned", { pid: child.pid ?? null });
  const exited = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  let protocolCompleted = false;
  try {
    options.onSpawn?.(child);
    const result = await drivePlugin(child, options);
    protocolCompleted = true;
    return result;
  } finally {
    child.removeAllListeners("message");
    if (child.connected && child.exitCode === null && child.signalCode === null) child.disconnect();
    if (child.exitCode === null && child.signalCode === null) child.kill();
    const exit = await exited;
    const fields = { exitCode: exit.code, signal: exit.signal };
    if (protocolCompleted)
      options.logger?.debug("plugin.process_completed", {
        ...fields,
        termination: "protocol_complete",
      });
    else
      options.logger?.debug("plugin.process_failed", {
        ...fields,
        termination: "process_exit",
      });
  }
}

function drivePlugin(child: ChildProcess, options: RunPluginProcessOptions): Promise<Json> {
  return new Promise<Json>((resolve, reject) => {
    let settled = false;
    let processFailed = false;
    let chain = Promise.resolve();
    const executing = new Map<number, { resolve: (result: Json) => void; reject: (error: Error) => void }>();
    const pending = new Set<number>();
    const seen = new Set<number>();
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const processFailure = (code: "PLUGIN_PROCESS_EXITED" | "PLUGIN_PROCESS_DISCONNECTED" | "PLUGIN_TIMEOUT"): void => {
      if (processFailed) return;
      processFailed = true;
      const error = new PluginProcessError(code);
      if (executing.size === 0) return finish(() => reject(error));
      for (const waiter of executing.values()) waiter.reject(error);
      executing.clear();
    };
    const protocolViolation = (): void =>
      finish(() => reject(new PluginProcessError("PLUGIN_PROTOCOL_VIOLATION", true)));
    const send = (message: HostToPluginMessage): void => {
      if (!settled && child.connected) child.send(message);
    };
    const timer = setTimeout(() => processFailure("PLUGIN_TIMEOUT"), options.timeoutMs ?? 30_000);
    timer.unref();

    child.once("error", () => processFailure("PLUGIN_PROCESS_EXITED"));
    child.once("disconnect", () => processFailure("PLUGIN_PROCESS_DISCONNECTED"));
    child.once("exit", () => processFailure("PLUGIN_PROCESS_EXITED"));
    child.on("message", (raw) => {
      const message = parsePluginMessage(raw);
      if (message === null) return protocolViolation();
      if (message.type === "plugin.completed") {
        if (pending.size > 0) return protocolViolation();
        return finish(() => resolve(message.result));
      }
      if (message.type === "plugin.failed") {
        chain = chain.then(() => {
          throw new PluginProcessError(message.errorCode, message.terminal);
        });
        chain.catch((error) => finish(() => reject(error)));
        return;
      }
      if (message.type === "history.request") {
        if (seen.has(message.requestId) || pending.size > 0 || !options.queryHistory) return protocolViolation();
        seen.add(message.requestId);
        pending.add(message.requestId);
        chain = chain.then(() => {
          const page = options.queryHistory!(message.query);
          options.logger?.debug("consumer.history_queried", {
            from: message.query.from,
            to: message.query.to,
            events: page.events.length,
            hasMore: page.nextCursor !== null,
          });
          send({ type: "history.result", requestId: message.requestId, page });
          pending.delete(message.requestId);
        });
        chain.catch(() => protocolViolation());
        return;
      }
      if (message.type === "step.request") {
        if (seen.has(message.requestId) || pending.size > 0) return protocolViolation();
        seen.add(message.requestId);
        pending.add(message.requestId);
        chain = chain.then(async () => {
          try {
            options.logger?.debug("plugin.step_requested", {
              name: message.name,
            });
            const result = await options.context.run(
              message.name,
              () =>
                new Promise<Json>((resolveStep, rejectStep) => {
                  executing.set(message.requestId, {
                    resolve: resolveStep,
                    reject: rejectStep,
                  });
                  send({ type: "step.execute", requestId: message.requestId });
                }),
              { retry: message.retry },
            );
            send({ type: "step.result", requestId: message.requestId, result });
          } finally {
            pending.delete(message.requestId);
            executing.delete(message.requestId);
          }
        });
        chain.catch((error) => finish(() => reject(error)));
        return;
      }
      const waiter = executing.get(message.requestId);
      if (!waiter) return protocolViolation();
      executing.delete(message.requestId);
      if (message.errorCode !== undefined) waiter.reject(new PluginProcessError(message.errorCode, message.terminal));
      else waiter.resolve(message.result ?? null);
    });
    send({ type: "start", entry: options.entry, input: options.input });
  });
}
