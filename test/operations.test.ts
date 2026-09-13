import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { initProject } from "../src/init.ts";
import { openProjectRuntime, projectStatus, tickProject } from "../src/operations.ts";
import { run } from "../src/cli.ts";
import type { SecretBackend } from "../src/secrets/backend.ts";
import type { InvocationRecord } from "@jugyo/duex";

const secrets = { get: () => undefined };

test("ticks and reports valid plugins while diagnosing invalid plugins", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "event-hub operations "));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initProject(root);
  const healthy = join(root, "sources", "healthy");
  const invalid = join(root, "sources", "invalid");
  await mkdir(healthy);
  await mkdir(invalid);
  await writeFile(join(healthy, "plugin.json"), `${JSON.stringify({
    id: "healthy", kind: "source", entry: "index.mjs", config: null, env: {},
    trigger: { type: "poll", everyMs: 60_000 },
  })}\n`);
  await writeFile(join(healthy, "index.mjs"), `export const execute = (_ctx, input) => ({ events: [], nextCursor: input.cursor, hasMore: false });\n`);
  await writeFile(join(invalid, "plugin.json"), "not json\n");

  const project = await openProjectRuntime(root, secrets);
  const schedule = project.runtime.getSchedule("plugin:source:healthy");
  project.runtime.store.updateSchedule(schedule.id, { nextRunAt: 0, updatedAt: Date.now() });
  project.close();

  const tick = await tickProject(root, secrets);
  assert.equal(tick.runs.length, 1);
  assert.equal(tick.runs[0].outcome, "completed");
  const statuses = await projectStatus(root, secrets);
  assert.deepEqual(statuses.map(({ id, state }) => ({ id, state })), [
    { id: "healthy", state: "ready" },
    { id: join(invalid, "plugin.json"), state: "invalid" },
  ]);
  assert.notEqual(statuses[0].lastRunAt, null);
  assert.match(statuses[1].failure ?? "", /MANIFEST_INVALID/);
});

test("status CLI separates human-readable and JSON output", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "event-hub status cli "));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initProject(root);
  const backend: SecretBackend = {
    create: async () => {}, update: async () => {}, delete: async () => {}, get: async () => "unused",
  };
  const output: string[] = [];
  const dependencies = { projectRoot: root, backend, readSecret: async () => "", out: (message: string) => output.push(message), error: () => {} };

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
  for (const [directory, id] of [[steady, "steady"], [flaky, "flaky"]] as const) {
    await writeFile(join(directory, "plugin.json"), `${JSON.stringify({
      id, kind: "source", entry: "index.mjs", config: null, env: {},
      trigger: { type: "poll", everyMs: 60_000 },
    })}\n`);
  }
  await writeFile(join(steady, "index.mjs"), `export const execute = ctx => ctx.run("fetch", () => ({
  events: [{
    id: "evt-steady-1", externalId: "steady-1", type: "example.changed", schemaVersion: 1,
    occurredAt: new Date().toISOString(), observedAt: new Date().toISOString(), payload: { ok: true },
  }],
  nextCursor: null, hasMore: false,
}));\n`);
  // DEFAULT_RETRY.initialDelayMs is 200ms. A slow child-process start can make a retry due
  // within the same tick, so this fixture uses a longer delay to keep the run count stable.
  await writeFile(join(flaky, "index.mjs"), `export const execute = ctx => ctx.run("fetch", () => { throw new Error("upstream is unreachable"); }, { retry: { maxAttempts: 3, initialDelayMs: 60_000 } });\n`);
  const makeDue = async (): Promise<void> => {
    const project = await openProjectRuntime(root, secrets);
    for (const id of ["plugin:source:steady", "plugin:source:flaky"]) {
      project.runtime.store.updateSchedule(id, { nextRunAt: Date.now(), updatedAt: Date.now() });
    }
    project.close();
  };
  await makeDue();
  const backend: SecretBackend = {
    create: async () => {}, update: async () => {}, delete: async () => {}, get: async () => "sentinel-secret-value",
  };
  const stdout: string[] = [];
  const dependencies = {
    projectRoot: root, backend, readSecret: async () => "", out: (message: string) => stdout.push(message), error: () => {},
  };

  assert.equal(await run(["tick", "--root", root], dependencies), 0);

  const logs = stdout.slice(0, -1);
  assert.ok(logs.length > 0);
  assert.ok(logs.every((line) => /^\[\d{2}:\d{2}:\d{2}\] /u.test(line)), logs.join("\n"));
  assert.ok(logs.every((line) => !line.slice(11).startsWith("{")), logs.join("\n"));
  const messages = logs.map((line) => line.slice(11));
  assert.ok(messages.includes("steady plugin.discovered (kind=source)"));
  assert.ok(messages.some((line) => /^steady plugin\.invocation_started \(invocationId=[0-9A-Z]+, kind=source\)$/u.test(line)), messages.join("\n"));
  assert.ok(messages.some((line) => line.startsWith("steady source.events_saved (")
    && line.includes("events=1, pages=1")), messages.join("\n"));
  assert.ok(messages.some((line) => line.startsWith("steady plugin.invocation_completed (")
    && line.includes("kind=source, events=1, pages=1")), messages.join("\n"));
  assert.ok(messages.some((line) => line.startsWith("WARNING: flaky step.retry_scheduled"))
    || messages.some((line) => line.startsWith("ERROR: flaky plugin.invocation_failed")), messages.join("\n"));
  assert.equal(stdout[stdout.length - 1], "Tick complete: 2 run(s), 2 invocation(s) created");
  assert.doesNotMatch(stdout.join("\n"), /sentinel-secret-value|upstream is unreachable/u);

  stdout.length = 0;
  await makeDue();
  assert.equal(await run(["tick", "--root", root, "--debug"], dependencies), 0);
  const debugMessages = stdout.map((line) => line.slice(11));
  assert.ok(debugMessages.some((line) => line.startsWith("steady source.window (")), debugMessages.join("\n"));
  assert.ok(debugMessages.some((line) => line.startsWith("steady plugin.process_spawned (")), debugMessages.join("\n"));
  assert.ok(debugMessages.some((line) => line.startsWith("steady step.started (") && line.includes("name=fetch")), debugMessages.join("\n"));
  assert.ok(debugMessages.some((line) => line.startsWith("steady invocation.started (")), debugMessages.join("\n"));
});

test("tick emits plugin-scoped logs and keeps --debug --json stdout as one JSON value", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "event-hub logging cli "));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initProject(root);
  const plugin = join(root, "sources", "logged");
  await mkdir(plugin);
  await writeFile(join(plugin, "plugin.json"), `${JSON.stringify({
    id: "logged", kind: "source", entry: "index.mjs", config: null, env: {},
    trigger: { type: "poll", everyMs: 60_000 },
  })}\n`);
  await writeFile(join(plugin, "index.mjs"), `export const execute = ctx => ctx.run("fetch", () => ({ events: [], nextCursor: null, hasMore: false }));\n`);
  const project = await openProjectRuntime(root, secrets);
  const schedule = project.runtime.getSchedule("plugin:source:logged");
  project.runtime.store.updateSchedule(schedule.id, { nextRunAt: 0, updatedAt: Date.now() });
  project.close();
  const backend: SecretBackend = {
    create: async () => {}, update: async () => {}, delete: async () => {}, get: async () => "sentinel-secret-value",
  };
  const stdout: string[] = [];
  const stderr: string[] = [];
  const dependencies = {
    projectRoot: root, backend, readSecret: async () => "", out: (message: string) => stdout.push(message), error: (message: string) => stderr.push(message),
  };

  assert.equal(await run(["tick", "--debug", "--json"], dependencies), 0);
  assert.equal(stdout.length, 1);
  assert.equal(JSON.parse(stdout[0]).runs.length, 1);
  const logs = stderr.map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.ok(logs.some(({ event, pluginId }) => event === "plugin.invocation_started" && pluginId === "logged"));
  assert.ok(logs.some(({ event, pluginId }) => event === "step.started" && pluginId === "logged"));
  assert.ok(logs.some(({ event }) => event === "source.page_completed"));
  assert.ok(logs.some(({ event }) => event === "plugin.process_spawned"));
  assert.ok(logs.every((line) => typeof line.ts === "string" && typeof line.level === "string" && typeof line.event === "string"));
  assert.doesNotMatch(JSON.stringify({ stdout, stderr }), /sentinel-secret-value/);
});

test("status counts pending invocations beyond 10,000 without truncation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "event-hub large status "));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initProject(root);
  const plugin = join(root, "sources", "many");
  await mkdir(plugin);
  await writeFile(join(plugin, "plugin.json"), `${JSON.stringify({
    id: "many", kind: "source", entry: "index.mjs", config: null, env: {},
    trigger: { type: "poll", everyMs: 60_000 },
  })}\n`);
  await writeFile(join(plugin, "index.mjs"), "export const execute = () => ({ events: [], nextCursor: null, hasMore: false });\n");

  const project = await openProjectRuntime(root, secrets);
  const now = Date.now();
  project.runtime.store.transaction(() => {
    for (let index = 0; index < 10_001; index += 1) {
      const retrying = index === 10_000;
      const invocation: InvocationRecord = {
        id: `inv_test_${String(index).padStart(5, "0")}`,
        workflowName: "event-hub.source.poll", workflowVersion: "1", status: retrying ? "retry_wait" : "pending",
        availableAt: now, idempotencyKey: null, scheduleId: "plugin:source:many",
        scheduledAt: null, scheduledFrom: null, input: { pluginId: "many" }, output: undefined,
        error: retrying ? { name: "Error", message: "Temporary collection failure", terminal: false } : null,
        createdAt: now + index, updatedAt: now + index,
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
    create: async () => {}, update: async () => {}, delete: async () => {}, get: async () => "unused",
  };
  const roots: string[] = [];
  const output: string[] = [];
  const result = await run(["status", "--root", root, "--json"], {
    projectRoot: "/different/current/directory",
    createBackend: (projectRoot) => { roots.push(projectRoot); return backend; },
    readSecret: async () => "", out: (message) => output.push(message), error: () => {},
  });

  assert.equal(result, 0);
  assert.deepEqual(roots, [root]);
  assert.deepEqual(JSON.parse(output[0]), { plugins: [] });
});
