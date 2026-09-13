import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { PluginProcessError, runPluginProcess } from "../src/index.ts";
import { defineWorkflow, InvocationRunner, JsonLogger, RuntimeApi, SqliteStore, WorkflowRegistry } from "@jugyo/duex";
import type { Json, WorkflowContext, WorkflowDefinition } from "@jugyo/duex";

const secrets = (values: Record<string, string>) => ({ get: (name: string) => values[name] });
const directContext: WorkflowContext = {
  invocationId: "direct",
  workflowName: "direct",
  scheduledAt: null,
  scheduledFrom: null,
  run: async (_name, operation) => operation(),
  sleep: async () => {},
  now: async () => new Date(0),
  uuid: async () => "00000000-0000-4000-8000-000000000000",
};

async function fixture(t: { after(fn: () => Promise<void>): void }, code: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "event-hub-process-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "plugin.mjs");
  await writeFile(path, code);
  return pathToFileURL(path).href;
}

function runtime(workflows: WorkflowDefinition[], logger?: JsonLogger) {
  const store = new SqliteStore({ path: ":memory:" });
  const registry = new WorkflowRegistry(workflows);
  let now = Date.UTC(2026, 8, 10);
  const clock = () => now;
  const api = new RuntimeApi({ store, registry, now: clock, logger });
  api.init();
  return {
    api,
    store,
    runner: new InvocationRunner({ store, registry, now: clock, logger }),
    advance(ms: number) { now += ms; },
    close() { api.close(); },
  };
}

test("reuses completed steps and retries only unfinished steps after a real child-process crash", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "event-hub-recovery-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const completedFile = join(directory, "completed");
  const crashFile = join(directory, "crashed");
  const entry = await fixture(t, `
import { access, appendFile, writeFile } from "node:fs/promises";
export async function execute(ctx, input) {
  const first = await ctx.run("fetch", async () => {
    await appendFile(input.completedFile, "fetch\\n");
    return { value: "fetched", pid: process.pid };
  });
  const second = await ctx.run("summarize", async () => {
    try { await access(input.crashFile); }
    catch { await writeFile(input.crashFile, "crashed"); process.exit(17); }
    await appendFile(input.completedFile, "summarize\\n");
    return { value: "summarized", pid: process.pid };
  }, { retry: { maxAttempts: 2, initialDelayMs: 10 } });
  return { first, second };
}`);
  const workflow = defineWorkflow({
    name: "plugin-recovery", version: "ipc-v1",
    run: (context) => runPluginProcess({ context, entry, input: { completedFile, crashFile }, env: {}, secrets: secrets({}) }),
  });
  const harness = runtime([workflow]);
  t.after(() => harness.close());
  const invocation = await harness.api.invoke({ workflow: workflow.name });

  const first = await harness.runner.run(invocation.invocation.id);
  assert.equal(first.outcome, "retry_wait");
  assert.deepEqual(first.steps, { replayed: 0, executed: 1 });
  harness.advance(10);
  assert.equal(harness.store.wakeDueInvocations(Date.UTC(2026, 8, 10) + 10), 1);
  const second = await harness.runner.run(invocation.invocation.id);

  assert.equal(second.outcome, "completed");
  assert.deepEqual(second.steps, { replayed: 1, executed: 1 });
  assert.equal(await readFile(completedFile, "utf8"), "fetch\nsummarize\n");
  const output = second.invocation.output as { first: { pid: number }; second: { pid: number } };
  assert.notEqual(output.first.pid, output.second.pid);
});

test("debug logs track real child-process startup, failure, and journal replay", async (t) => {
  const marker = join(await mkdtemp(join(tmpdir(), "event-hub-log-recovery-")), "marker");
  t.after(() => rm(join(marker, ".."), { recursive: true, force: true }));
  const entry = await fixture(t, `
import { access, writeFile } from "node:fs/promises";
export async function execute(ctx, input) {
  await ctx.run("kept", () => ({ ok: true }));
  return ctx.run("crash-once", async () => {
    try { await access(input.marker); } catch { await writeFile(input.marker, "x"); process.exit(9); }
    return { ok: true };
  }, { retry: { maxAttempts: 2, initialDelayMs: 1 } });
}`);
  const logs: string[] = [];
  const logger = new JsonLogger({ level: "debug", write: (line) => logs.push(line) });
  const workflow = defineWorkflow({ name: "logged-recovery", version: "1", run: (context) => runPluginProcess({ context, entry, input: { marker }, env: {}, secrets: secrets({}), logger }) });
  const harness = runtime([workflow], logger);
  t.after(() => harness.close());
  const invocation = await harness.api.invoke({ workflow: workflow.name });
  assert.equal((await harness.runner.run(invocation.invocation.id)).outcome, "retry_wait");
  harness.advance(1);
  harness.store.wakeDueInvocations(Date.UTC(2026, 8, 10) + 1);
  assert.equal((await harness.runner.run(invocation.invocation.id)).outcome, "completed");
  const events = logs.map((line) => JSON.parse(line).event);
  assert.ok(events.includes("plugin.process_failed"));
  assert.ok(events.includes("step.replayed"));
  assert.ok(events.includes("step.retry_scheduled"));
  const failed = logs.map((line) => JSON.parse(line)).find((line) => line.event === "plugin.process_failed");
  assert.equal(failed.exitCode, 9);
  assert.equal(failed.signal, null);
  const completed = logs.map((line) => JSON.parse(line)).find((line) => line.event === "plugin.process_completed");
  assert.equal(completed.termination, "protocol_complete");
  assert.ok(Object.hasOwn(completed, "exitCode"));
  assert.ok(Object.hasOwn(completed, "signal"));
});

test("a plugin in retry_wait does not block another healthy invocation", async (t) => {
  const waitingEntry = await fixture(t, `export const execute = ctx => ctx.run("wait", () => { throw new Error("secret detail"); }, { retry: { maxAttempts: 2, initialDelayMs: 1000 } });`);
  const healthyEntry = await fixture(t, `export const execute = ctx => ctx.run("ok", () => ({ ok: true }));`);
  const waiting = defineWorkflow({ name: "waiting", version: "1", run: (context) => runPluginProcess({ context, entry: waitingEntry, input: null, env: {}, secrets: secrets({}) }) });
  const healthy = defineWorkflow({ name: "healthy", version: "1", run: (context) => runPluginProcess({ context, entry: healthyEntry, input: null, env: {}, secrets: secrets({}) }) });
  const harness = runtime([waiting, healthy]);
  t.after(() => harness.close());
  const waitingInvocation = await harness.api.invoke({ workflow: waiting.name });
  const healthyInvocation = await harness.api.invoke({ workflow: healthy.name });
  assert.equal((await harness.runner.run(waitingInvocation.invocation.id)).outcome, "retry_wait");
  assert.equal((await harness.runner.run(healthyInvocation.invocation.id)).outcome, "completed");
});

test("does not automatically persist resolved secrets in inputs, journals, logs, or fixed errors", async (t) => {
  const secret = "must-not-appear-in-persisted-state";
  const logs: string[] = [];
  const entry = await fixture(t, `export const execute = ctx => ctx.run("secret-error", () => { throw new Error(process.env.TOKEN); }, { retry: { maxAttempts: 1, initialDelayMs: 1 } });`);
  const workflow = defineWorkflow({ name: "secret-error", version: "1", run: (context) => runPluginProcess({ context, entry, input: { public: true }, env: { TOKEN: "TOKEN_REF" }, secrets: secrets({ TOKEN_REF: secret }) }) });
  const harness = runtime([workflow], new JsonLogger({ write: (line) => logs.push(line) }));
  t.after(() => harness.close());
  const invocation = await harness.api.invoke({ workflow: workflow.name });
  const result = await harness.runner.run(invocation.invocation.id);
  const recorded = JSON.stringify({ invocation: result.invocation, journal: harness.api.getJournal(invocation.invocation.id), logs });
  assert.equal(result.outcome, "failed");
  assert.equal(result.invocation.error?.message, "plugin step failed");
  assert.doesNotMatch(recorded, new RegExp(secret));
});

test("passes only declared environment variables and resolves fresh values for every execution", async (t) => {
  const entry = await fixture(t, `export const execute = async ctx => ctx.run("environment", () => ({ token: process.env.TOKEN ?? null, leaked: process.env.EH_PARENT_SENTINEL ?? null }));`);
  const original = process.env.EH_PARENT_SENTINEL;
  process.env.EH_PARENT_SENTINEL = "parent-secret";
  t.after(async () => { if (original === undefined) delete process.env.EH_PARENT_SENTINEL; else process.env.EH_PARENT_SENTINEL = original; });
  let value = "first";
  const provider = { get: () => value };
  assert.deepEqual(await runPluginProcess({ context: directContext, entry, input: null, env: { TOKEN: "REF" }, secrets: provider }), { token: "first", leaked: null });
  value = "second";
  assert.deepEqual(await runPluginProcess({ context: directContext, entry, input: null, env: { TOKEN: "REF" }, secrets: provider }), { token: "second", leaked: null });
});

for (const [name, source, code] of [
  ["import failure", null, "PLUGIN_IMPORT_FAILED"],
  ["invalid response", `export const execute = () => { process.send({ type: "unknown", secret: process.env.SECRET }); return new Promise(() => {}); };`, "PLUGIN_PROTOCOL_VIOLATION"],
] as const) {
  test(`${name} becomes a plugin-scoped failure with a fixed diagnostic`, async (t) => {
    const entry = source === null ? "file:///definitely/missing/plugin.mjs" : await fixture(t, source);
    await assert.rejects(runPluginProcess({ context: directContext, entry, input: null, env: { SECRET: "REF" }, secrets: secrets({ REF: "hidden" }), timeoutMs: 1000 }),
      (error: unknown) => error instanceof PluginProcessError && error.code === code && !error.message.includes("hidden"));
  });
}
