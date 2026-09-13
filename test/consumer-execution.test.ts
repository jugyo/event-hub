import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import {
  deliverConsumerEvent,
  EventStore,
  runConsumerPlugin,
  type EventInput,
} from "../src/index.ts";
import type { WorkflowContext } from "@jugyo/duex";
import { JsonLogger } from "@jugyo/duex";
import { TextLogger } from "../src/text-logger.ts";

const NOW = new Date("2026-09-10T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const secrets = { get: () => undefined };
const context: WorkflowContext = {
  invocationId: "consumer-test",
  workflowName: "consumer-test",
  scheduledAt: null,
  scheduledFrom: null,
  run: async (_name, operation) => operation(),
  sleep: async () => {},
  now: async () => NOW,
  uuid: async () => "00000000-0000-4000-8000-000000000000",
};

function event(id: string, occurredAt: string): EventInput {
  return {
    id,
    externalId: id,
    type: "example.changed",
    schemaVersion: 1,
    occurredAt,
    observedAt: NOW.toISOString(),
    payload: { id },
  };
}

async function plugin(t: { after(fn: () => Promise<void>): void }, source: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "event-hub-consumer-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "plugin.mjs");
  await writeFile(path, source);
  return pathToFileURL(path).href;
}

function preparedStore() {
  const store = new EventStore({ path: ":memory:" });
  store.migrate();
  store.registerConsumer("consumer-a", new Date(NOW.getTime() - 2 * DAY).toISOString());
  store.registerConsumer("consumer-b", new Date(NOW.getTime() - 2 * DAY).toISOString());
  store.appendSourceBatch({
    sourceId: "source-a",
    expectedCursor: null,
    nextCursor: null,
    updatedAt: NOW.toISOString(),
    events: [event("new-event", new Date(NOW.getTime() - DAY).toISOString())],
  });
  return store;
}

test("completes or terminally fails each consumer delivery independently", async (t) => {
  const store = preparedStore();
  t.after(() => store.close());
  const failedEntry = await plugin(t, `
export const execute = ctx => ctx.run("notify", () => {
  const error = new Error("private failure"); error.terminal = true; throw error;
});`);
  const completedEntry = await plugin(t, `export const execute = ctx => ctx.run("notify", () => ({ sent: true }));`);
  const a = store.matchConsumerEvents("consumer-a", ["example.changed"], 100, NOW.toISOString())[0]!;
  const b = store.matchConsumerEvents("consumer-b", ["example.changed"], 100, NOW.toISOString())[0]!;
  const logs: string[] = [];
  const logger = new JsonLogger({ write: (line) => logs.push(line) });

  await assert.rejects(deliverConsumerEvent({
    consumerId: "consumer-a", event: a.event, config: null, store, context,
    entry: failedEntry, env: {}, secrets, now: () => NOW, logger,
  }));
  assert.deepEqual(await deliverConsumerEvent({
    consumerId: "consumer-b", event: b.event, config: null, store, context,
    entry: completedEntry, env: {}, secrets, now: () => NOW, logger,
  }), { sent: true });

  assert.equal(store.getDelivery("consumer-a", "new-event")?.status, "failed");
  assert.equal(store.getDelivery("consumer-a", "new-event")?.errorCode, "PLUGIN_STEP_FAILED");
  assert.equal(store.getDelivery("consumer-b", "new-event")?.status, "completed");
  const parsed = logs.map((line) => JSON.parse(line));
  assert.ok(parsed.some((line) => line.event === "plugin.invocation_failed" && line.pluginId === "consumer-a" && line.invocationId === "consumer-test"));
  assert.ok(parsed.some((line) => line.event === "plugin.invocation_completed" && line.pluginId === "consumer-b" && line.events === 1));
});

test("holds temporary failures until retry time and does not redeliver after success", async (t) => {
  const store = preparedStore();
  t.after(() => store.close());
  const marker = join(await mkdtemp(join(tmpdir(), "event-hub-retry-")), "attempted");
  t.after(() => rm(join(marker, ".."), { recursive: true, force: true }));
  const entry = await plugin(t, `
import { access, writeFile } from "node:fs/promises";
export const execute = ctx => ctx.run("notify", async () => {
  try { await access(${JSON.stringify(marker)}); }
  catch { await writeFile(${JSON.stringify(marker)}, "once"); throw new Error("temporary"); }
  return { sent: true };
});`);
  const delivery = store.matchConsumerEvents("consumer-a", ["example.changed"], 100, NOW.toISOString())[0]!;
  const logs: string[] = [];
  const logger = new JsonLogger({ write: (line) => logs.push(line) });

  await assert.rejects(deliverConsumerEvent({
    consumerId: "consumer-a", event: delivery.event, config: null, store, context,
    entry, env: {}, secrets, retry: { maxAttempts: 2, initialDelayMs: 1_000 }, now: () => NOW, logger,
  }));
  assert.equal(store.getDelivery("consumer-a", "new-event")?.status, "retry_wait");
  assert.equal(store.getDelivery("consumer-a", "new-event")?.nextAttemptAt, "2026-09-10T12:00:01.000Z");
  assert.equal(store.listReadyDeliveries("consumer-a", NOW.toISOString()).length, 0);

  const retryAt = new Date(NOW.getTime() + 1_000);
  assert.deepEqual(store.listReadyDeliveries("consumer-a", retryAt.toISOString()).map(({ event }) => event.id), ["new-event"]);
  await deliverConsumerEvent({
    consumerId: "consumer-a", event: delivery.event, config: null, store, context,
    entry, env: {}, secrets, retry: { maxAttempts: 2, initialDelayMs: 1_000 }, now: () => retryAt, logger,
  });
  assert.equal(store.getDelivery("consumer-a", "new-event")?.status, "completed");
  assert.equal(store.getDelivery("consumer-a", "new-event")?.attempt, 2);
  assert.ok(logs.map((line) => JSON.parse(line)).some((line) => line.event === "consumer.event_failed" && line.level === "warn" && line.pluginId === "consumer-a"));
  await assert.rejects(deliverConsumerEvent({
    consumerId: "consumer-a", event: delivery.event, config: null, store, context,
    entry, env: {}, secrets, now: () => retryAt,
  }), /not runnable/);
});

test("tracks event-consumer processing and failures in readable text", async (t) => {
  const store = preparedStore();
  t.after(() => store.close());
  const failedEntry = await plugin(t, `
export const execute = ctx => ctx.run("notify", () => { throw new Error("private failure"); });`);
  const completedEntry = await plugin(t, `export const execute = ctx => ctx.run("notify", () => ({ sent: true }));`);
  const a = store.matchConsumerEvents("consumer-a", ["example.changed"], 100, NOW.toISOString())[0]!;
  const b = store.matchConsumerEvents("consumer-b", ["example.changed"], 100, NOW.toISOString())[0]!;
  const lines: string[] = [];
  const logger = new TextLogger({ write: (line) => lines.push(line), now: () => NOW.getTime() });

  await deliverConsumerEvent({
    consumerId: "consumer-b", event: b.event, config: null, store, context,
    entry: completedEntry, env: {}, secrets, now: () => NOW, logger,
  });
  await assert.rejects(deliverConsumerEvent({
    consumerId: "consumer-a", event: a.event, config: null, store, context,
    entry: failedEntry, env: {}, secrets, retry: { maxAttempts: 2, initialDelayMs: 1_000 }, now: () => NOW, logger,
  }));

  const messages = lines.map((line) => line.slice(11));
  assert.ok(lines.every((line) => /^\[\d{2}:\d{2}:\d{2}\] /u.test(line)));
  assert.deepEqual(messages, [
    "consumer-b plugin.invocation_started (invocationId=consumer-test, kind=event_consumer)",
    "consumer-b consumer.events_processed (invocationId=consumer-test, events=1)",
    "consumer-b plugin.invocation_completed (invocationId=consumer-test, kind=event_consumer, events=1)",
    "consumer-a plugin.invocation_started (invocationId=consumer-test, kind=event_consumer)",
    "WARNING: consumer-a consumer.event_failed (invocationId=consumer-test, eventId=new-event, eventType=example.changed, attempt=1, code=PLUGIN_STEP_FAILED)",
    "ERROR: consumer-a plugin.invocation_failed (invocationId=consumer-test, kind=event_consumer, code=PLUGIN_STEP_FAILED)",
  ]);
  assert.doesNotMatch(messages.join("\n"), /private failure/u);
});

test("queries processed events over seven-day and 24-hour windows without changing delivery state", async (t) => {
  const store = new EventStore({ path: ":memory:" });
  store.migrate();
  t.after(() => store.close());
  store.registerConsumer("consumer-a", new Date(NOW.getTime() - 8 * DAY).toISOString());
  store.appendSourceBatch({
    sourceId: "source-a", expectedCursor: null, nextCursor: null, updatedAt: NOW.toISOString(),
    events: [
      event("week-event", new Date(NOW.getTime() - 6 * DAY).toISOString()),
      event("day-event", new Date(NOW.getTime() - 12 * 60 * 60 * 1000).toISOString()),
    ],
  });
  const deliveries = store.matchConsumerEvents("consumer-a", ["example.changed"], 100, NOW.toISOString());
  store.beginDeliveryAttempt("consumer-a", "week-event", NOW.toISOString());
  store.completeDelivery("consumer-a", "week-event", NOW.toISOString());
  assert.equal(deliveries.length, 2);
  const entry = await plugin(t, `
export async function execute(ctx, input) {
  const week = await ctx.queryHistory({ from: input.weekFrom, to: input.to });
  const day = await ctx.queryHistory({ from: input.dayFrom, to: input.to });
  return { week: week.events.map(event => event.id), day: day.events.map(event => event.id) };
}`);

  const before = [store.getDelivery("consumer-a", "week-event"), store.getDelivery("consumer-a", "day-event")];
  const result = await runConsumerPlugin({
    context, store, entry, env: {}, secrets,
    input: {
      weekFrom: new Date(NOW.getTime() - 7 * DAY).toISOString(),
      dayFrom: new Date(NOW.getTime() - DAY).toISOString(),
      to: NOW.toISOString(),
    },
  });
  assert.deepEqual(result, { week: ["week-event", "day-event"], day: ["day-event"] });
  assert.deepEqual(
    [store.getDelivery("consumer-a", "week-event"), store.getDelivery("consumer-a", "day-event")],
    before,
  );
});
