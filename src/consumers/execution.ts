import type { Logger, RetryPolicy, WorkflowContext } from "@jugyo/duex";
import { TerminalError } from "@jugyo/duex";
import type { EventRecord, EventStore, HistoryPage, Json } from "../storage/event-store.ts";
import {
  PluginProcessError,
  runPluginProcess,
  type RunPluginProcessOptions,
  type SecretProvider,
} from "../plugins/process/executor.ts";
import type { OAuth2PkceCredential } from "../plugins/manifest.ts";
import { OAuthCredentialError } from "../oauth.ts";

const DEFAULT_DELIVERY_RETRY: Required<RetryPolicy> = {
  maxAttempts: 3,
  initialDelayMs: 200,
  factor: 2,
  maxDelayMs: 30_000,
};

export interface RunConsumerPluginOptions {
  context: WorkflowContext;
  store: EventStore;
  entry: string;
  input: Json;
  env: Record<string, string>;
  credentials?: Record<string, OAuth2PkceCredential>;
  secrets: SecretProvider;
  timeoutMs?: number;
  onSpawn?: RunPluginProcessOptions["onSpawn"];
  logger?: Logger;
  onHistoryQuery?: (page: HistoryPage) => void;
}

export interface DeliverConsumerEventOptions extends Omit<RunConsumerPluginOptions, "input"> {
  consumerId: string;
  event: EventRecord;
  config: Json;
  retry?: RetryPolicy;
  now?: () => Date;
}

export async function runConsumerPlugin(options: RunConsumerPluginOptions): Promise<Json> {
  return runPluginProcess({
    context: options.context,
    entry: options.entry,
    input: options.input,
    env: options.env,
    credentials: options.credentials,
    secrets: options.secrets,
    timeoutMs: options.timeoutMs,
    onSpawn: options.onSpawn,
    queryHistory: (query) => {
      const page = options.store.queryHistory(query);
      options.onHistoryQuery?.(page);
      return page;
    },
    logger: options.logger,
  });
}

function retryDelay(attempt: number, policy: Required<RetryPolicy>): number {
  return Math.min(policy.initialDelayMs * policy.factor ** Math.max(0, attempt - 1), policy.maxDelayMs);
}

function publicErrorCode(error: unknown): string {
  return error instanceof PluginProcessError || error instanceof OAuthCredentialError
    ? error.code
    : "CONSUMER_EXECUTION_FAILED";
}

export async function deliverConsumerEvent(options: DeliverConsumerEventOptions): Promise<Json> {
  const now = options.now ?? (() => new Date());
  const logger = options.logger?.child({
    pluginId: options.consumerId,
    invocationId: options.context.invocationId,
  });
  const attemptedAt = now();
  const delivery = options.store.beginDeliveryAttempt(options.consumerId, options.event.id, attemptedAt.toISOString());
  const retry = { ...DEFAULT_DELIVERY_RETRY, ...(options.retry ?? {}) };
  logger?.info("plugin.invocation_started", { kind: "event_consumer" });
  logger?.debug("consumer.event_started", {
    eventId: options.event.id,
    eventType: options.event.type,
    attempt: delivery.attempt,
  });
  try {
    const result = await runConsumerPlugin({
      ...options,
      logger,
      input: {
        event: {
          seq: options.event.seq,
          id: options.event.id,
          sourceId: options.event.sourceId,
          externalId: options.event.externalId,
          type: options.event.type,
          schemaVersion: options.event.schemaVersion,
          occurredAt: options.event.occurredAt,
          observedAt: options.event.observedAt,
          payload: options.event.payload,
        },
        config: options.config,
      },
    });
    options.store.completeDelivery(options.consumerId, options.event.id, now().toISOString());
    logger?.info("consumer.events_processed", { events: 1 });
    logger?.info("plugin.invocation_completed", {
      kind: "event_consumer",
      events: 1,
    });
    return result;
  } catch (error) {
    const code = publicErrorCode(error);
    if (
      error instanceof TerminalError ||
      (error instanceof OAuthCredentialError && error.code === "OAUTH_REAUTHORIZATION_REQUIRED") ||
      (error instanceof PluginProcessError && error.terminal) ||
      delivery.attempt >= retry.maxAttempts
    ) {
      options.store.failDelivery(options.consumerId, options.event.id, now().toISOString(), code);
    } else {
      const nextAttemptAt = new Date(attemptedAt.getTime() + retryDelay(delivery.attempt, retry));
      options.store.retryDelivery(options.consumerId, options.event.id, nextAttemptAt.toISOString(), code);
    }
    logger?.warn("consumer.event_failed", {
      eventId: options.event.id,
      eventType: options.event.type,
      attempt: delivery.attempt,
      code,
    });
    logger?.error("plugin.invocation_failed", { kind: "event_consumer", code });
    throw error;
  }
}
