import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { initProject } from "../src/init.ts";
import { openProjectRuntime, projectStatus, tickProject } from "../src/operations.ts";
import { run } from "../src/cli.ts";
import type { SecretBackend } from "../src/secrets/backend.ts";
import { EventStore, type Json } from "../src/storage/event-store.ts";
import { EVENT_CONSUMER_WORKFLOW } from "../src/workflows.ts";
import { OAuthCredentialError } from "../src/oauth.ts";
import type { InvocationRecord, TickResult } from "@jugyo/duex";

const secrets = { get: () => undefined };

async function eventConsumer(root: string, id: string, source: string): Promise<void> {
  const directory = join(root, "consumers", id);
  await mkdir(directory);
  await writeFile(
    join(directory, "plugin.json"),
    `${JSON.stringify({
      id,
      kind: "consumer",
      entry: "index.mjs",
      config: null,
      env: {},
      trigger: { type: "events", eventTypes: ["example.changed"] },
    })}\n`,
  );
  await writeFile(join(directory, "index.mjs"), source);
}

function recordingConsumer(log: string): string {
  return `import { appendFile } from "node:fs/promises";
export const execute = (ctx, input) => ctx.run("record", async () => {
  await appendFile(${JSON.stringify(log)}, input.event.id + "\\n");
  return { recorded: input.event.id };
});\n`;
}

function withEventStore<T>(root: string, operation: (store: EventStore) => T): T {
  const store = new EventStore({
    path: join(root, ".event-hub", "events.sqlite"),
  });
  try {
    store.migrate();
    return operation(store);
  } finally {
    store.close();
  }
}

function appendEvents(root: string, ...events: { id: string; type?: string; payload?: Json }[]): void {
  const now = new Date().toISOString();
  withEventStore(root, (store) =>
    store.appendSourceBatch({
      sourceId: `source-${events[0].id}`,
      expectedCursor: null,
      nextCursor: null,
      updatedAt: now,
      events: events.map(({ id, type = "example.changed", payload = null }) => ({
        id,
        externalId: id,
        type,
        schemaVersion: 1,
        occurredAt: now,
        observedAt: now,
        payload,
      })),
    }),
  );
}

function setRetryDeadline(root: string, consumerId: string, nextAttemptAt: string): void {
  const db = new DatabaseSync(join(root, ".event-hub", "events.sqlite"));
  try {
    db.prepare(
      "UPDATE consumer_deliveries SET next_attempt_at = ? WHERE consumer_id = ? AND status = 'retry_wait'",
    ).run(nextAttemptAt, consumerId);
  } finally {
    db.close();
  }
}

async function lines(path: string): Promise<string[]> {
  try {
    return (await readFile(path, "utf8")).trim().split("\n").filter(Boolean);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function outcomes(tick: TickResult): { workflow: string; outcome: string }[] {
  return tick.runs.map(({ workflow, outcome }) => ({ workflow, outcome }));
}

test("tick delivers subscribed events to event consumers from registration onward", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "event-hub event consumer "));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initProject(root);
  const log = join(root, "delivered.log");
  await eventConsumer(root, "notify", recordingConsumer(log));
  appendEvents(root, { id: "before-registration" });

  assert.deepEqual((await tickProject(root, secrets)).runs, []);
  appendEvents(root, { id: "subscribed" }, { id: "other-type", type: "example.ignored" });
  assert.deepEqual(outcomes(await tickProject(root, secrets)), [
    { workflow: EVENT_CONSUMER_WORKFLOW, outcome: "completed" },
  ]);
  assert.deepEqual(await lines(log), ["subscribed"]);

  appendEvents(root, { id: "later" });
  await tickProject(root, secrets);
  assert.deepEqual((await tickProject(root, secrets)).runs, []);
  assert.deepEqual(await lines(log), ["subscribed", "later"]);
  withEventStore(root, (store) => {
    assert.equal(store.getDelivery("notify", "before-registration"), null);
    assert.equal(store.getDelivery("notify", "other-type"), null);
    assert.deepEqual(
      [store.getDelivery("notify", "later")?.status, store.getDelivery("notify", "later")?.attempt],
      ["completed", 1],
    );
  });
  const [status] = await projectStatus(root, secrets);
  assert.deepEqual(
    {
      id: status.id,
      state: status.state,
      pending: status.pending,
      failure: status.failure,
    },
    { id: "notify", state: "ready", pending: 0, failure: null },
  );
});

test("tick retries temporary delivery failures after their deadline and fails terminal or exhausted deliveries", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "event-hub event retry "));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initProject(root);
  const log = join(root, "attempts.log");
  const marker = join(root, "failed-once");
  await eventConsumer(
    root,
    "flaky",
    `import { access, appendFile, writeFile } from "node:fs/promises";
export const execute = (ctx, input) => ctx.run("deliver", async () => {
  const { id, payload } = input.event;
  await appendFile(${JSON.stringify(log)}, id + "\\n");
  if (payload.mode === "once") {
    try { await access(${JSON.stringify(marker)}); }
    catch { await writeFile(${JSON.stringify(marker)}, "failed"); throw new Error("temporary"); }
  }
  if (payload.mode === "always") throw new Error("temporary");
  if (payload.mode === "terminal") { const error = new Error("rejected"); error.terminal = true; throw error; }
  return { delivered: id };
});\n`,
  );
  await tickProject(root, secrets);
  appendEvents(
    root,
    { id: "terminal", payload: { mode: "terminal" } },
    { id: "once", payload: { mode: "once" } },
    { id: "always", payload: { mode: "always" } },
    { id: "ok", payload: { mode: "ok" } },
  );
  const states = () =>
    withEventStore(root, (store) =>
      Object.fromEntries(
        ["terminal", "once", "always", "ok"].map((id) => {
          const delivery = store.getDelivery("flaky", id);
          return [id, `${delivery?.status}:${delivery?.attempt}`];
        }),
      ),
    );

  assert.deepEqual(
    outcomes(await tickProject(root, secrets))
      .map(({ outcome }) => outcome)
      .sort(),
    ["completed", "failed", "failed", "failed"],
  );
  assert.deepEqual(states(), {
    terminal: "failed:1",
    once: "retry_wait:1",
    always: "retry_wait:1",
    ok: "completed:1",
  });
  assert.equal((await projectStatus(root, secrets))[0].pending, 2);

  setRetryDeadline(root, "flaky", "2999-01-01T00:00:00.000Z");
  assert.deepEqual((await tickProject(root, secrets)).runs, []);

  setRetryDeadline(root, "flaky", "2000-01-01T00:00:00.000Z");
  assert.deepEqual(
    outcomes(await tickProject(root, secrets))
      .map(({ outcome }) => outcome)
      .sort(),
    ["completed", "failed"],
  );
  assert.deepEqual(states(), {
    terminal: "failed:1",
    once: "completed:2",
    always: "retry_wait:2",
    ok: "completed:1",
  });

  setRetryDeadline(root, "flaky", "2000-01-01T00:00:00.000Z");
  assert.deepEqual(
    outcomes(await tickProject(root, secrets)).map(({ outcome }) => outcome),
    ["failed"],
  );
  assert.deepEqual(states(), {
    terminal: "failed:1",
    once: "completed:2",
    always: "failed:3",
    ok: "completed:1",
  });
  assert.deepEqual((await tickProject(root, secrets)).runs, []);
  assert.deepEqual((await lines(log)).sort(), ["always", "always", "always", "ok", "once", "once", "terminal"]);

  const [status] = await projectStatus(root, secrets);
  assert.deepEqual({ state: status.state, pending: status.pending }, { state: "failed", pending: 0 });
  assert.notEqual(status.failure, null);
});

test("status keeps a failed delivery visible after later deliveries succeed without blocking other consumers", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "event-hub event status "));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initProject(root);
  const failingLog = join(root, "failing.log");
  const healthyLog = join(root, "healthy.log");
  await eventConsumer(
    root,
    "failing",
    `import { appendFile } from "node:fs/promises";
export const execute = (ctx, input) => ctx.run("deliver", async () => {
  await appendFile(${JSON.stringify(failingLog)}, input.event.id + "\\n");
  if (input.event.payload.mode === "terminal") { const error = new Error("rejected"); error.terminal = true; throw error; }
  return { delivered: input.event.id };
});\n`,
  );
  await eventConsumer(root, "healthy", recordingConsumer(healthyLog));
  await tickProject(root, secrets);

  appendEvents(root, { id: "boom", payload: { mode: "terminal" } });
  await tickProject(root, secrets);
  appendEvents(root, { id: "fine", payload: { mode: "ok" } });
  await tickProject(root, secrets);

  assert.deepEqual(await lines(failingLog), ["boom", "fine"]);
  assert.deepEqual(await lines(healthyLog), ["boom", "fine"]);
  const statuses = await projectStatus(root, secrets);
  assert.deepEqual(
    statuses.map(({ id, state, pending, failure }) => ({
      id,
      state,
      pending,
      failure,
    })),
    [
      {
        id: "failing",
        state: "failed",
        pending: 0,
        failure: "event boom failed: PLUGIN_STEP_FAILED",
      },
      { id: "healthy", state: "ready", pending: 0, failure: null },
    ],
  );
});

test("status exposes OAuth reauthorization as a terminal event-consumer failure", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "event-hub oauth consumer "));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initProject(root);
  const directory = join(root, "consumers", "oauth-consumer");
  await mkdir(directory);
  await writeFile(
    join(directory, "plugin.json"),
    `${JSON.stringify({
      id: "oauth-consumer",
      kind: "consumer",
      entry: "index.mjs",
      config: null,
      env: {},
      credentials: {
        account: {
          type: "oauth2-pkce",
          authorizationEndpoint: "https://provider.example/authorize",
          tokenEndpoint: "https://provider.example/token",
          clientId: "CLIENT_ID",
          scopes: ["read"],
          env: "ACCESS_TOKEN",
        },
      },
      trigger: { type: "events", eventTypes: ["example.changed"] },
    })}\n`,
  );
  await writeFile(join(directory, "index.mjs"), "export const execute = () => null;\n");
  const credentialProvider = {
    get: () => undefined,
    getOAuthAccessToken: async () => {
      throw new OAuthCredentialError("OAUTH_REAUTHORIZATION_REQUIRED");
    },
  };

  await tickProject(root, credentialProvider);
  appendEvents(root, { id: "requires-login" });
  await tickProject(root, credentialProvider);

  withEventStore(root, (store) => {
    const delivery = store.getDelivery("oauth-consumer", "requires-login");
    assert.equal(delivery?.status, "failed");
    assert.equal(delivery?.attempt, 1);
    assert.equal(delivery?.errorCode, "OAUTH_REAUTHORIZATION_REQUIRED");
  });
  const [status] = await projectStatus(root, credentialProvider);
  assert.equal(status.state, "failed");
  assert.equal(status.pending, 0);
  assert.equal(status.failure, "event requires-login failed: OAUTH_REAUTHORIZATION_REQUIRED");
});

test("concurrent ticks execute a delivery attempt once", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "event-hub event concurrency "));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initProject(root);
  const log = join(root, "delivered.log");
  await eventConsumer(root, "notify", recordingConsumer(log));
  await tickProject(root, secrets);
  appendEvents(root, { id: "shared" });

  const ticks = await Promise.all([tickProject(root, secrets), tickProject(root, secrets), tickProject(root, secrets)]);
  assert.equal(ticks.flatMap(({ runs }) => runs).filter(({ outcome }) => outcome === "completed").length, 1);
  assert.deepEqual(await lines(log), ["shared"]);
  withEventStore(root, (store) => assert.equal(store.getDelivery("notify", "shared")?.attempt, 1));
});

test("removing an event consumer stops new deliveries and retains delivery state", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "event-hub event removal "));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initProject(root);
  const log = join(root, "delivered.log");
  await eventConsumer(root, "notify", recordingConsumer(log));
  await tickProject(root, secrets);
  appendEvents(root, { id: "kept" });
  await tickProject(root, secrets);

  await rm(join(root, "consumers", "notify"), { recursive: true });
  appendEvents(root, { id: "after-removal" });
  assert.deepEqual((await tickProject(root, secrets)).runs, []);
  assert.deepEqual(await lines(log), ["kept"]);
  withEventStore(root, (store) => {
    assert.equal(store.getDelivery("notify", "kept")?.status, "completed");
    assert.equal(store.getDelivery("notify", "after-removal"), null);
  });
  assert.deepEqual(await projectStatus(root, secrets), []);
});

test("ticks and reports valid plugins while diagnosing invalid plugins", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "event-hub operations "));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initProject(root);
  const healthy = join(root, "sources", "healthy");
  const invalid = join(root, "sources", "invalid");
  await mkdir(healthy);
  await mkdir(invalid);
  await writeFile(
    join(healthy, "plugin.json"),
    `${JSON.stringify({
      id: "healthy",
      kind: "source",
      entry: "index.mjs",
      config: null,
      env: {},
      trigger: { type: "poll", everyMs: 60_000 },
    })}\n`,
  );
  await writeFile(
    join(healthy, "index.mjs"),
    `export const execute = (_ctx, input) => ({ events: [], nextCursor: input.cursor, hasMore: false });\n`,
  );
  await writeFile(join(invalid, "plugin.json"), "not json\n");

  const project = await openProjectRuntime(root, secrets);
  const schedule = project.runtime.getSchedule("plugin:source:healthy");
  project.runtime.store.updateSchedule(schedule.id, {
    nextRunAt: 0,
    updatedAt: Date.now(),
  });
  project.close();

  const tick = await tickProject(root, secrets);
  assert.equal(tick.runs.length, 1);
  assert.equal(tick.runs[0].outcome, "completed");
  const statuses = await projectStatus(root, secrets);
  assert.deepEqual(
    statuses.map(({ id, state }) => ({ id, state })),
    [
      { id: "healthy", state: "ready" },
      { id: join(invalid, "plugin.json"), state: "invalid" },
    ],
  );
  assert.notEqual(statuses[0].lastRunAt, null);
  assert.match(statuses[1].failure ?? "", /MANIFEST_INVALID/);
});

test("status CLI separates human-readable and JSON output", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "event-hub status cli "));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initProject(root);
  const backend: SecretBackend = {
    create: async () => {},
    update: async () => {},
    delete: async () => {},
    get: async () => "unused",
  };
  const output: string[] = [];
  const dependencies = {
    projectRoot: root,
    backend,
    readSecret: async () => "",
    out: (message: string) => output.push(message),
    error: () => {},
  };

  assert.equal(await run(["status"], dependencies), 0);
  assert.deepEqual(output, ["No plugins found"]);
  output.length = 0;
  assert.equal(await run(["status", "--json"], dependencies), 0);
  assert.deepEqual(JSON.parse(output[0]), { plugins: [] });
});

test("normal tick logs expose starts, counts, and retries as readable text", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "event-hub text log "));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initProject(root);
  const steady = join(root, "sources", "steady");
  const flaky = join(root, "sources", "flaky");
  await mkdir(steady);
  await mkdir(flaky);
  for (const [directory, id] of [
    [steady, "steady"],
    [flaky, "flaky"],
  ] as const) {
    await writeFile(
      join(directory, "plugin.json"),
      `${JSON.stringify({
        id,
        kind: "source",
        entry: "index.mjs",
        config: null,
        env: {},
        trigger: { type: "poll", everyMs: 60_000 },
      })}\n`,
    );
  }
  await writeFile(
    join(steady, "index.mjs"),
    `export const execute = ctx => ctx.run("fetch", () => ({
  events: [{
    id: "evt-steady-1", externalId: "steady-1", type: "example.changed", schemaVersion: 1,
    occurredAt: new Date().toISOString(), observedAt: new Date().toISOString(), payload: { ok: true },
  }],
  nextCursor: null, hasMore: false,
}));\n`,
  );
  // DEFAULT_RETRY.initialDelayMs is 200ms. A slow child-process start can make a retry due
  // within the same tick, so this fixture uses a longer delay to keep the run count stable.
  await writeFile(
    join(flaky, "index.mjs"),
    `export const execute = ctx => ctx.run("fetch", () => { throw new Error("upstream is unreachable"); }, { retry: { maxAttempts: 3, initialDelayMs: 60_000 } });\n`,
  );
  const makeDue = async (): Promise<void> => {
    const project = await openProjectRuntime(root, secrets);
    for (const id of ["plugin:source:steady", "plugin:source:flaky"]) {
      project.runtime.store.updateSchedule(id, {
        nextRunAt: Date.now(),
        updatedAt: Date.now(),
      });
    }
    project.close();
  };
  await makeDue();
  const backend: SecretBackend = {
    create: async () => {},
    update: async () => {},
    delete: async () => {},
    get: async () => "sentinel-secret-value",
  };
  const stdout: string[] = [];
  const dependencies = {
    projectRoot: root,
    backend,
    readSecret: async () => "",
    out: (message: string) => stdout.push(message),
    error: () => {},
  };

  assert.equal(await run(["tick", "--root", root], dependencies), 0);

  const logs = stdout.slice(0, -1);
  assert.ok(logs.length > 0);
  assert.ok(
    logs.every((line) => /^\[\d{2}:\d{2}:\d{2}\] /u.test(line)),
    logs.join("\n"),
  );
  assert.ok(
    logs.every((line) => !line.slice(11).startsWith("{")),
    logs.join("\n"),
  );
  const messages = logs.map((line) => line.slice(11));
  assert.ok(messages.includes("steady plugin.discovered (kind=source)"));
  assert.ok(
    messages.some((line) => /^steady plugin\.invocation_started \(invocationId=[0-9A-Z]+, kind=source\)$/u.test(line)),
    messages.join("\n"),
  );
  assert.ok(
    messages.some((line) => line.startsWith("steady source.events_saved (") && line.includes("events=1, pages=1")),
    messages.join("\n"),
  );
  assert.ok(
    messages.some(
      (line) =>
        line.startsWith("steady plugin.invocation_completed (") && line.includes("kind=source, events=1, pages=1"),
    ),
    messages.join("\n"),
  );
  assert.ok(
    messages.some((line) => line.startsWith("WARNING: flaky step.retry_scheduled")) ||
      messages.some((line) => line.startsWith("ERROR: flaky plugin.invocation_failed")),
    messages.join("\n"),
  );
  assert.equal(stdout[stdout.length - 1], "Tick complete: 2 run(s), 2 invocation(s) created");
  assert.doesNotMatch(stdout.join("\n"), /sentinel-secret-value|upstream is unreachable/u);

  stdout.length = 0;
  await makeDue();
  assert.equal(await run(["tick", "--root", root, "--debug"], dependencies), 0);
  const debugMessages = stdout.map((line) => line.slice(11));
  assert.ok(
    debugMessages.some((line) => line.startsWith("steady source.window (")),
    debugMessages.join("\n"),
  );
  assert.ok(
    debugMessages.some((line) => line.startsWith("steady plugin.process_spawned (")),
    debugMessages.join("\n"),
  );
  assert.ok(
    debugMessages.some((line) => line.startsWith("steady step.started (") && line.includes("name=fetch")),
    debugMessages.join("\n"),
  );
  assert.ok(
    debugMessages.some((line) => line.startsWith("steady invocation.started (")),
    debugMessages.join("\n"),
  );
});

test("tick emits plugin-scoped logs and keeps --debug --json stdout as one JSON value", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "event-hub logging cli "));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initProject(root);
  const plugin = join(root, "sources", "logged");
  await mkdir(plugin);
  await writeFile(
    join(plugin, "plugin.json"),
    `${JSON.stringify({
      id: "logged",
      kind: "source",
      entry: "index.mjs",
      config: null,
      env: {},
      trigger: { type: "poll", everyMs: 60_000 },
    })}\n`,
  );
  await writeFile(
    join(plugin, "index.mjs"),
    `export const execute = ctx => ctx.run("fetch", () => ({ events: [], nextCursor: null, hasMore: false }));\n`,
  );
  const project = await openProjectRuntime(root, secrets);
  const schedule = project.runtime.getSchedule("plugin:source:logged");
  project.runtime.store.updateSchedule(schedule.id, {
    nextRunAt: 0,
    updatedAt: Date.now(),
  });
  project.close();
  const backend: SecretBackend = {
    create: async () => {},
    update: async () => {},
    delete: async () => {},
    get: async () => "sentinel-secret-value",
  };
  const stdout: string[] = [];
  const stderr: string[] = [];
  const dependencies = {
    projectRoot: root,
    backend,
    readSecret: async () => "",
    out: (message: string) => stdout.push(message),
    error: (message: string) => stderr.push(message),
  };

  assert.equal(await run(["tick", "--debug", "--json"], dependencies), 0);
  assert.equal(stdout.length, 1);
  assert.equal(JSON.parse(stdout[0]).runs.length, 1);
  const logs = stderr.map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.ok(logs.some(({ event, pluginId }) => event === "plugin.invocation_started" && pluginId === "logged"));
  assert.ok(logs.some(({ event, pluginId }) => event === "step.started" && pluginId === "logged"));
  assert.ok(logs.some(({ event }) => event === "source.page_completed"));
  assert.ok(logs.some(({ event }) => event === "plugin.process_spawned"));
  assert.ok(
    logs.every(
      (line) => typeof line.ts === "string" && typeof line.level === "string" && typeof line.event === "string",
    ),
  );
  assert.doesNotMatch(JSON.stringify({ stdout, stderr }), /sentinel-secret-value/);
});

test("status counts pending invocations beyond 10,000 without truncation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "event-hub large status "));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initProject(root);
  const plugin = join(root, "sources", "many");
  await mkdir(plugin);
  await writeFile(
    join(plugin, "plugin.json"),
    `${JSON.stringify({
      id: "many",
      kind: "source",
      entry: "index.mjs",
      config: null,
      env: {},
      trigger: { type: "poll", everyMs: 60_000 },
    })}\n`,
  );
  await writeFile(
    join(plugin, "index.mjs"),
    "export const execute = () => ({ events: [], nextCursor: null, hasMore: false });\n",
  );

  const project = await openProjectRuntime(root, secrets);
  const now = Date.now();
  project.runtime.store.transaction(() => {
    for (let index = 0; index < 10_001; index += 1) {
      const retrying = index === 10_000;
      const invocation: InvocationRecord = {
        id: `inv_test_${String(index).padStart(5, "0")}`,
        workflowName: "event-hub.source.poll",
        workflowVersion: "1",
        status: retrying ? "retry_wait" : "pending",
        availableAt: now,
        idempotencyKey: null,
        scheduleId: "plugin:source:many",
        scheduledAt: null,
        scheduledFrom: null,
        input: { pluginId: "many" },
        output: undefined,
        error: retrying
          ? {
              name: "Error",
              message: "Temporary collection failure",
              terminal: false,
            }
          : null,
        createdAt: now + index,
        updatedAt: now + index,
      };
      project.runtime.store.insertInvocation(invocation);
    }
  });
  project.close();

  const [status] = await projectStatus(root, secrets);
  assert.equal(status.id, "many");
  assert.equal(status.pending, 10_001);
  assert.equal(status.state, "failed");
  assert.equal(status.failure, "Temporary collection failure");
});

test("uses the project root selected by --root to create the default backend", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "event-hub selected root "));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initProject(root);
  const backend: SecretBackend = {
    create: async () => {},
    update: async () => {},
    delete: async () => {},
    get: async () => "unused",
  };
  const roots: string[] = [];
  const output: string[] = [];
  const result = await run(["status", "--root", root, "--json"], {
    projectRoot: "/different/current/directory",
    createBackend: (projectRoot) => {
      roots.push(projectRoot);
      return backend;
    },
    readSecret: async () => "",
    out: (message) => output.push(message),
    error: () => {},
  });

  assert.equal(result, 0);
  assert.deepEqual(roots, [root]);
  assert.deepEqual(JSON.parse(output[0]), { plugins: [] });
});
