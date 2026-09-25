import type { Json, RetryPolicy } from "@jugyo/duex";
import type { EventInput, HistoryPage, HistoryQuery } from "../../storage/event-store.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function isFiniteJson(value: unknown, ancestors = new Set<object>()): value is Json {
  if (value === null || typeof value === "boolean" || typeof value === "string") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false;
  if (ancestors.has(value)) return false;
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index) || !isFiniteJson(value[index], ancestors)) return false;
      }
      return true;
    }
    if (!isRecord(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
    if (Reflect.ownKeys(value).some((key) => typeof key !== "string")) return false;
    return Object.values(value).every((item) => isFiniteJson(item, ancestors));
  } finally {
    ancestors.delete(value);
  }
}

function isUtcTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

export function isEventInput(value: unknown): value is EventInput {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["id", "externalId", "type", "schemaVersion", "occurredAt", "observedAt", "payload"])
  )
    return false;
  return (
    typeof value.id === "string" &&
    value.id !== "" &&
    typeof value.externalId === "string" &&
    value.externalId !== "" &&
    typeof value.type === "string" &&
    value.type !== "" &&
    Number.isInteger(value.schemaVersion) &&
    (value.schemaVersion as number) > 0 &&
    isUtcTimestamp(value.occurredAt) &&
    isUtcTimestamp(value.observedAt) &&
    isFiniteJson(value.payload)
  );
}

export interface PluginStepContext {
  run<T extends Json>(name: string, operation: () => Promise<T> | T, options?: { retry?: RetryPolicy }): Promise<T>;
  queryHistory(query: HistoryQuery): Promise<HistoryPage>;
  emit(events: EventInput | EventInput[]): Promise<void>;
}

export interface PluginModule {
  execute(context: PluginStepContext, input: Json): Promise<Json> | Json;
}

export type PluginErrorCode =
  "PLUGIN_STEP_FAILED" | "PLUGIN_PROTOCOL_VIOLATION" | "PLUGIN_IMPORT_FAILED" | "PLUGIN_EXECUTION_FAILED";

export type HostToPluginMessage =
  | { type: "start"; entry: string; input: Json }
  | { type: "step.execute"; requestId: number }
  | { type: "step.result"; requestId: number; result: Json }
  | { type: "history.result"; requestId: number; page: HistoryPage }
  | { type: "emit.result"; requestId: number };

export type PluginToHostMessage =
  | {
      type: "step.request";
      requestId: number;
      name: string;
      retry?: RetryPolicy;
    }
  | { type: "history.request"; requestId: number; query: HistoryQuery }
  | { type: "emit.request"; requestId: number; events: EventInput[] }
  | {
      type: "step.executed";
      requestId: number;
      result?: Json;
      errorCode?: PluginErrorCode;
      terminal?: boolean;
    }
  | { type: "plugin.completed"; result: Json }
  | { type: "plugin.failed"; errorCode: PluginErrorCode; terminal?: boolean };
