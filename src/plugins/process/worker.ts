import type { Json } from "@jugyo/duex";
import type { HistoryPage } from "../../storage/event-store.ts";
import type {
  HostToPluginMessage,
  PluginErrorCode,
  PluginModule,
  PluginStepContext,
  PluginToHostMessage,
} from "./contract.ts";

let nextRequestId = 0;
const pending = new Map<
  number,
  | {
      type: "step";
      operation: () => Promise<Json> | Json;
      resolve: (value: Json) => void;
    }
  | { type: "history"; resolve: (value: HistoryPage) => void }
>();

class PluginProtocolError extends Error {
  readonly terminal = true;
}

function publicErrorCode(error: unknown, fallback: PluginErrorCode): PluginErrorCode {
  return error instanceof PluginProtocolError ? "PLUGIN_PROTOCOL_VIOLATION" : fallback;
}

function send(message: PluginToHostMessage): void {
  process.send?.(message);
}

const context: PluginStepContext = {
  run<T extends Json>(
    name: string,
    operation: () => Promise<T> | T,
    options?: Parameters<PluginStepContext["run"]>[2],
  ): Promise<T> {
    if (pending.size > 0) throw new PluginProtocolError("nested or concurrent durable plugin steps are not allowed");
    const requestId = nextRequestId++;
    return new Promise<T>((resolve) => {
      pending.set(requestId, {
        type: "step",
        operation: operation as () => Promise<Json> | Json,
        resolve: resolve as (value: Json) => void,
      });
      send({ type: "step.request", requestId, name, retry: options?.retry });
    });
  },
  queryHistory(query) {
    if (pending.size > 0) throw new PluginProtocolError("concurrent plugin context calls are not allowed");
    const requestId = nextRequestId++;
    return new Promise<HistoryPage>((resolve) => {
      pending.set(requestId, { type: "history", resolve });
      send({ type: "history.request", requestId, query });
    });
  },
};

process.on("message", async (raw: HostToPluginMessage) => {
  try {
    if (raw?.type === "start") {
      let plugin: PluginModule;
      try {
        plugin = (await import(raw.entry)) as PluginModule;
      } catch {
        send({
          type: "plugin.failed",
          errorCode: "PLUGIN_IMPORT_FAILED",
          terminal: true,
        });
        return;
      }
      if (typeof plugin.execute !== "function") {
        send({
          type: "plugin.failed",
          errorCode: "PLUGIN_IMPORT_FAILED",
          terminal: true,
        });
        return;
      }
      const result = await plugin.execute(context, raw.input);
      if (pending.size > 0) throw new PluginProtocolError("plugin completed with an outstanding durable step");
      send({ type: "plugin.completed", result });
      return;
    }

    const request = pending.get(raw?.requestId);
    if (!request) throw new PluginProtocolError("unknown step request");
    if (raw.type === "step.execute") {
      if (request.type !== "step") throw new PluginProtocolError("unexpected step response");
      try {
        send({
          type: "step.executed",
          requestId: raw.requestId,
          result: await request.operation(),
        });
      } catch (error) {
        send({
          type: "step.executed",
          requestId: raw.requestId,
          errorCode: publicErrorCode(error, "PLUGIN_STEP_FAILED"),
          terminal: error instanceof Error && (error as Error & { terminal?: boolean }).terminal === true,
        });
      }
      return;
    }
    if (raw.type === "history.result") {
      if (request.type !== "history") throw new PluginProtocolError("unexpected history response");
      pending.delete(raw.requestId);
      request.resolve(raw.page);
      return;
    }
    if (raw.type !== "step.result") throw new PluginProtocolError("unknown host message");
    if (request.type !== "step") throw new PluginProtocolError("unexpected step result");
    pending.delete(raw.requestId);
    request.resolve(raw.result);
  } catch (error) {
    send({
      type: "plugin.failed",
      errorCode: publicErrorCode(error, "PLUGIN_EXECUTION_FAILED"),
      terminal: error instanceof Error && (error as Error & { terminal?: boolean }).terminal === true,
    });
  }
});
