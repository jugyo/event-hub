import {
  defineWorkflow,
  SuspendInvocation,
  TerminalError,
  type Json,
  type WorkflowContext,
  type WorkflowDefinition,
  type Logger,
} from "@jugyo/duex";
import { deliverConsumerEvent, runConsumerPlugin } from "./consumers/execution.ts";
import type { NormalizedPluginManifest, NormalizedSourcePluginManifest } from "./plugins/manifest.ts";
import { runPluginProcess, type SecretProvider } from "./plugins/process/executor.ts";
import { pollSource, type SourcePollPage } from "./sources/polling.ts";
import type { EventInput, EventStore, PluginRegistration } from "./storage/event-store.ts";

export const SOURCE_POLL_WORKFLOW = "event-hub.source.poll";
export const DAILY_CONSUMER_WORKFLOW = "event-hub.consumer.daily";
export const EVENT_CONSUMER_WORKFLOW = "event-hub.consumer.event";

// Delivery state owns event-consumer retries, so the runtime must not also retry plugin steps.
const SINGLE_ATTEMPT = { maxAttempts: 1, initialDelayMs: 0 };

export interface PluginWorkflowOptions {
  store: EventStore;
  secrets: SecretProvider;
  sourceWorkflow?: string;
  dailyConsumerWorkflow?: string;
  pluginTimeoutMs?: number;
  logger?: Logger;
}

interface PluginWorkflowInput {
  pluginId: string;
}

function inputPluginId(input: unknown): string {
  if (
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input) ||
    typeof (input as { pluginId?: unknown }).pluginId !== "string"
  ) {
    throw new TerminalError("plugin workflow input is invalid");
  }
  return (input as PluginWorkflowInput).pluginId;
}

function registration(store: EventStore, pluginId: string, kind: "source" | "consumer"): PluginRegistration {
  const plugin = store.listPluginRegistrations({ activeOnly: true }).find(({ id }) => id === pluginId);
  if (!plugin || plugin.kind !== kind)
    throw new TerminalError(`active ${kind} plugin ${JSON.stringify(pluginId)} not found`);
  return plugin;
}

function sourcePage(value: Json): SourcePollPage {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TerminalError("source plugin returned an invalid page");
  }
  const page = value as Record<string, Json>;
  if (
    !Array.isArray(page.events) ||
    typeof page.hasMore !== "boolean" ||
    !("nextCursor" in page) ||
    !page.events.every(isEventInput)
  ) {
    throw new TerminalError("source plugin returned an invalid page");
  }
  return {
    events: page.events as unknown as EventInput[],
    nextCursor: page.nextCursor,
    hasMore: page.hasMore,
  };
}

function isEventInput(value: Json): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const event = value as Record<string, Json>;
  return (
    ["id", "externalId", "type", "occurredAt", "observedAt"].every((key) => typeof event[key] === "string") &&
    Number.isInteger(event.schemaVersion) &&
    Number(event.schemaVersion) > 0 &&
    "payload" in event
  );
}

export function createPluginWorkflows(options: PluginWorkflowOptions): WorkflowDefinition[] {
  return [
    defineWorkflow({
      name: options.sourceWorkflow ?? SOURCE_POLL_WORKFLOW,
      version: "1",
      async run(context, input: unknown) {
        const pluginId = inputPluginId(input);
        const plugin = registration(options.store, pluginId, "source");
        const manifest = plugin.manifest as unknown as NormalizedSourcePluginManifest;
        const logger = options.logger?.child({
          pluginId,
          invocationId: context.invocationId,
        });
        logger?.info("plugin.invocation_started", { kind: "source" });
        const now = await context.now("poll-time");
        try {
          const result = await pollSource({
            sourceId: pluginId,
            store: options.store,
            config: manifest.config,
            backfillMs: manifest.trigger.backfillMs,
            now: () => now,
            logger,
            poll: async (pollInput) =>
              sourcePage(
                await runPluginProcess({
                  context,
                  entry: plugin.entrypoint,
                  input: pollInput as unknown as Json,
                  env: manifest.env,
                  secrets: options.secrets,
                  timeoutMs: options.pluginTimeoutMs,
                  logger,
                }),
              ),
          });
          logger?.info("plugin.invocation_completed", {
            kind: "source",
            events: result.insertedEvents,
            pages: result.pages,
          });
          return result as unknown as Json;
        } catch (error) {
          // A retry or sleep is not a failure; the runtime already logs the suspension.
          if (error instanceof SuspendInvocation) throw error;
          logger?.error("plugin.invocation_failed", {
            kind: "source",
            code: error instanceof Error && "code" in error ? String(error.code) : "SOURCE_EXECUTION_FAILED",
          });
          throw error;
        }
      },
    }),
    defineWorkflow({
      name: options.dailyConsumerWorkflow ?? DAILY_CONSUMER_WORKFLOW,
      version: "1",
      async run(context, input: unknown) {
        const pluginId = inputPluginId(input);
        const plugin = registration(options.store, pluginId, "consumer");
        const manifest = plugin.manifest as unknown as NormalizedPluginManifest;
        const logger = options.logger?.child({
          pluginId,
          invocationId: context.invocationId,
        });
        if (
          context.scheduledAt === null ||
          context.scheduledFrom === null ||
          manifest.kind !== "consumer" ||
          manifest.trigger.type !== "daily"
        ) {
          throw new TerminalError("daily consumer invocation is missing its schedule slot");
        }
        const to = context.scheduledAt.getTime();
        const from = context.scheduledFrom.getTime();
        let historyEvents = 0;
        logger?.info("plugin.invocation_started", { kind: "daily_consumer" });
        logger?.debug("consumer.daily_window", {
          scheduledAt: context.scheduledAt.toISOString(),
          from: new Date(from).toISOString(),
          to: new Date(to).toISOString(),
        });
        try {
          const result = await runConsumerPlugin({
            context,
            store: options.store,
            entry: plugin.entrypoint,
            input: {
              scheduledAt: new Date(to).toISOString(),
              window: {
                from: new Date(from).toISOString(),
                to: new Date(to).toISOString(),
              },
              config: manifest.config,
            },
            env: manifest.env,
            secrets: options.secrets,
            timeoutMs: options.pluginTimeoutMs,
            logger,
            onHistoryQuery: (page) => {
              historyEvents += page.events.length;
            },
          });
          logger?.info("plugin.invocation_completed", {
            kind: "daily_consumer",
            events: historyEvents,
          });
          return result;
        } catch (error) {
          if (error instanceof SuspendInvocation) throw error;
          logger?.error("plugin.invocation_failed", {
            kind: "daily_consumer",
            code: error instanceof Error && "code" in error ? String(error.code) : "CONSUMER_EXECUTION_FAILED",
          });
          throw error;
        }
      },
    }),
    defineWorkflow({
      name: EVENT_CONSUMER_WORKFLOW,
      version: "1",
      // One invocation is one delivery attempt; a later attempt is a new invocation.
      async run(context, input: unknown) {
        const pluginId = inputPluginId(input);
        const eventId = (input as { eventId?: unknown }).eventId;
        if (typeof eventId !== "string") throw new TerminalError("event consumer invocation input is invalid");
        const plugin = registration(options.store, pluginId, "consumer");
        const manifest = plugin.manifest as unknown as NormalizedPluginManifest;
        if (manifest.kind !== "consumer" || manifest.trigger.type !== "events") {
          throw new TerminalError(`consumer plugin ${JSON.stringify(pluginId)} is not event-triggered`);
        }
        const delivery = options.store.getDelivery(pluginId, eventId);
        const now = new Date().toISOString();
        if (
          !delivery ||
          !(
            delivery.status === "pending" ||
            (delivery.status === "retry_wait" && delivery.nextAttemptAt !== null && delivery.nextAttemptAt <= now)
          )
        ) {
          return null;
        }
        const singleAttempt: WorkflowContext = {
          invocationId: context.invocationId,
          workflowName: context.workflowName,
          scheduledAt: context.scheduledAt,
          scheduledFrom: context.scheduledFrom,
          run: (name, operation) => context.run(name, operation, { retry: SINGLE_ATTEMPT }),
          sleep: (name, duration) => context.sleep(name, duration),
          now: (name) => context.now(name),
          uuid: (name) => context.uuid(name),
        };
        return deliverConsumerEvent({
          context: singleAttempt,
          store: options.store,
          consumerId: pluginId,
          event: delivery.event,
          config: manifest.config,
          entry: plugin.entrypoint,
          env: manifest.env,
          secrets: options.secrets,
          timeoutMs: options.pluginTimeoutMs,
          logger: options.logger,
        });
      },
    }),
  ];
}
