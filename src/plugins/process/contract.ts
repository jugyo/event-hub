import type { Json, RetryPolicy } from "@jugyo/duex";
import type { HistoryPage, HistoryQuery } from "../../storage/event-store.ts";

export interface PluginStepContext {
  run<T extends Json>(name: string, operation: () => Promise<T> | T, options?: { retry?: RetryPolicy }): Promise<T>;
  queryHistory(query: HistoryQuery): Promise<HistoryPage>;
}

export interface PluginModule {
  execute(context: PluginStepContext, input: Json): Promise<Json> | Json;
}

export type PluginErrorCode =
  | "PLUGIN_STEP_FAILED"
  | "PLUGIN_PROTOCOL_VIOLATION"
  | "PLUGIN_IMPORT_FAILED"
  | "PLUGIN_EXECUTION_FAILED";

export type HostToPluginMessage =
  | { type: "start"; entry: string; input: Json }
  | { type: "step.execute"; requestId: number }
  | { type: "step.result"; requestId: number; result: Json }
  | { type: "history.result"; requestId: number; page: HistoryPage };

export type PluginToHostMessage =
  | { type: "step.request"; requestId: number; name: string; retry?: RetryPolicy }
  | { type: "history.request"; requestId: number; query: HistoryQuery }
  | { type: "step.executed"; requestId: number; result?: Json; errorCode?: PluginErrorCode; terminal?: boolean }
  | { type: "plugin.completed"; result: Json }
  | { type: "plugin.failed"; errorCode: PluginErrorCode; terminal?: boolean };
