import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { defineWorkflow, RuntimeApi, SqliteStore, WorkflowRegistry } from "@jugyo/duex";
import { EventStore, syncPluginSchedules } from "../src/index.ts";
import type { Json, PluginRegistration } from "../src/index.ts";

const NOW = Date.parse("2026-03-07T16:00:00.000Z");
const workflows = [
  defineWorkflow({ name: "source", version: "1", run: () => null }),
  defineWorkflow({ name: "daily", version: "1", run: () => null }),
];
const secrets = { get: () => undefined };

function registration(id: string, kind: "source" | "consumer", trigger: Json): PluginRegistration {
  return {
    id,
    kind,
    directory: `/plugins/${id}`,
    entrypoint: `/plugins/${id}/index.mjs`,
    active: true,
    manifest: { id, kind, entry: "index.mjs", config: null, env: {}, trigger },
    createdAt: new Date(NOW).toISOString(),
    updatedAt: new Date(NOW).toISOString(),
  };
}

test("registration resync does not duplicate polling or daily schedules", () => {
  const store = new SqliteStore({ path: ":memory:" });
  const runtime = new RuntimeApi({
    store,
    registry: new WorkflowRegistry(workflows),
    now: () => NOW,
  });
  runtime.init();
  const eventStore = new EventStore({ path: ":memory:" });
  eventStore.migrate();
  const plugins = [
    registration("github", "source", { type: "poll", everyMs: 60_000 }),
    registration("digest", "consumer", {
      type: "daily",
      at: "09:00",
      timezone: "Asia/Tokyo",
    }),
  ];
  const first = syncPluginSchedules({
    runtime,
    store: eventStore,
    secrets,
    plugins,
    sourceWorkflow: "source",
    dailyConsumerWorkflow: "daily",
  });
  const second = syncPluginSchedules({
    runtime,
    store: eventStore,
    secrets,
    plugins,
    sourceWorkflow: "source",
    dailyConsumerWorkflow: "daily",
  });

  assert.deepEqual(first.created, ["plugin:source:github", "plugin:consumer:digest"]);
  assert.deepEqual(second, { created: [], updated: [], disabled: [] });
  assert.equal(runtime.listSchedules().length, 2);
  runtime.close();
  eventStore.close();
});

test("disables schedules for removed plugins and reuses them when plugins return", () => {
  const store = new SqliteStore({ path: ":memory:" });
  const runtime = new RuntimeApi({
    store,
    registry: new WorkflowRegistry(workflows),
    now: () => NOW,
  });
  runtime.init();
  const eventStore = new EventStore({ path: ":memory:" });
  eventStore.migrate();
  const plugin = registration("digest", "consumer", {
    type: "daily",
    at: "09:00",
    timezone: "Asia/Tokyo",
  });
  syncPluginSchedules({
    runtime,
    store: eventStore,
    secrets,
    plugins: [plugin],
    dailyConsumerWorkflow: "daily",
  });
  assert.deepEqual(
    syncPluginSchedules({
      runtime,
      store: eventStore,
      secrets,
      plugins: [],
      dailyConsumerWorkflow: "daily",
    }).disabled,
    ["plugin:consumer:digest"],
  );
  assert.deepEqual(
    syncPluginSchedules({
      runtime,
      store: eventStore,
      secrets,
      plugins: [plugin],
      dailyConsumerWorkflow: "daily",
    }).updated,
    ["plugin:consumer:digest"],
  );
  assert.equal(runtime.listSchedules().length, 1);
  runtime.close();
  eventStore.close();
});

test("does not disable plugin-prefixed schedules outside the synchronization layer's ownership", () => {
  const store = new SqliteStore({ path: ":memory:" });
  const runtime = new RuntimeApi({
    store,
    registry: new WorkflowRegistry(workflows),
    now: () => NOW,
  });
  runtime.init();
  const eventStore = new EventStore({ path: ":memory:" });
  eventStore.migrate();
  runtime.createSchedule({
    id: "plugin:maintenance",
    workflow: "source",
    every: 60_000,
  });

  assert.deepEqual(
    syncPluginSchedules({
      runtime,
      store: eventStore,
      secrets,
      plugins: [],
      sourceWorkflow: "source",
      dailyConsumerWorkflow: "daily",
    }),
    { created: [], updated: [], disabled: [] },
  );
  assert.equal(runtime.getSchedule("plugin:maintenance").enabled, true);
  runtime.close();
  eventStore.close();
});

test("default workflows cover registration sync, polling, daily aggregation, and restart", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "event-hub-scheduling-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sourceEntry = join(directory, "source.mjs");
  const consumerEntry = join(directory, "consumer.mjs");
  await writeFile(
    sourceEntry,
    `
export const execute = (ctx, input) => ctx.run("fetch", () => ({
  events: [{ id: "event-1", externalId: "event-1", type: "example.changed", schemaVersion: 1,
    occurredAt: input.to, observedAt: input.to, payload: { collected: true } }],
  nextCursor: "event-1", hasMore: false,
}));`,
  );
  await writeFile(
    consumerEntry,
    `
export async function execute(ctx, input) {
  const to = input.window.to;
  const from = new Date(Date.parse(to) - 7 * 24 * 60 * 60 * 1000).toISOString();
  const history = await ctx.queryHistory({ from, to });
  return ctx.run("aggregate", () => ({ count: history.events.length, scheduledAt: input.scheduledAt, window: input.window }));
}`,
  );

  const eventStore = new EventStore({ path: join(directory, "events.sqlite") });
  eventStore.migrate();
  t.after(() => eventStore.close());
  const sourceRegistration = {
    id: "source",
    kind: "source" as const,
    directory,
    entrypoint: sourceEntry,
    manifest: {
      id: "source",
      kind: "source",
      entry: "source.mjs",
      config: null,
      env: {},
      trigger: { type: "poll", everyMs: 60_000 },
    },
  };
  const consumerRegistration = {
    id: "digest",
    kind: "consumer" as const,
    directory,
    entrypoint: consumerEntry,
    manifest: {
      id: "digest",
      kind: "consumer",
      entry: "consumer.mjs",
      config: null,
      env: {},
      trigger: { type: "daily", at: "01:02", timezone: "Asia/Tokyo" },
    },
  };
  eventStore.syncPluginRegistrations([sourceRegistration, consumerRegistration], new Date(NOW).toISOString());
  let plugins = eventStore.listPluginRegistrations({ activeOnly: true });
  const runtimePath = join(directory, "runtime.sqlite");
  let clock = NOW;
  const openRuntime = () => {
    const api = new RuntimeApi({
      store: new SqliteStore({ path: runtimePath }),
      registry: new WorkflowRegistry(),
      now: () => clock,
    });
    api.init();
    return api;
  };

  let runtime = openRuntime();
  syncPluginSchedules({ runtime, store: eventStore, secrets, plugins });
  clock += 60_000;
  await runtime.tick({ maxRuns: 10 });
  assert.deepEqual(
    eventStore
      .queryHistory({
        from: new Date(NOW).toISOString(),
        to: new Date(clock + 1).toISOString(),
      })
      .events.map(({ id }) => id),
    ["event-1"],
  );

  clock += 60_000;
  runtime.materializeSchedules();
  eventStore.syncPluginRegistrations(
    [
      sourceRegistration,
      {
        ...consumerRegistration,
        manifest: {
          ...consumerRegistration.manifest,
          trigger: { type: "daily", at: "09:00", timezone: "America/New_York" },
        },
      },
    ],
    new Date(clock).toISOString(),
  );
  plugins = eventStore.listPluginRegistrations({ activeOnly: true });
  syncPluginSchedules({ runtime, store: eventStore, secrets, plugins });

  clock += 3 * 60 * 60_000;
  await runtime.tick({ maxRuns: 10 });
  const daily = runtime.listInvocations({
    scheduleId: "plugin:consumer:digest",
  })[0];
  assert.deepEqual(daily.output, {
    count: 1,
    scheduledAt: "2026-03-07T16:02:00.000Z",
    window: {
      from: "2026-03-06T16:02:00.000Z",
      to: "2026-03-07T16:02:00.000Z",
    },
  });
  const invocationCount = runtime.listInvocations({ limit: 100 }).length;
  syncPluginSchedules({ runtime, store: eventStore, secrets, plugins });
  runtime.close();

  runtime = openRuntime();
  syncPluginSchedules({ runtime, store: eventStore, secrets, plugins });
  await runtime.tick({ maxRuns: 10 });
  assert.equal(runtime.listInvocations({ limit: 100 }).length, invocationCount);
  assert.deepEqual(syncPluginSchedules({ runtime, store: eventStore, secrets, plugins: [] }).disabled, [
    "plugin:consumer:digest",
    "plugin:source:source",
  ]);
  syncPluginSchedules({ runtime, store: eventStore, secrets, plugins });
  assert.equal(runtime.listSchedules().length, 2);
  runtime.close();
});
