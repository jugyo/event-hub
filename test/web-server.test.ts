import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { InvocationRecord } from "@jugyo/duex";
import { DatabaseSync } from "node:sqlite";

import { run } from "../src/cli.ts";
import { initProject } from "../src/init.ts";
import { openProjectRuntime, readProjectStatus } from "../src/operations.ts";
import { EventStore } from "../src/storage/event-store.ts";
import { serveWeb, startWebServer, WebServerError } from "../src/web-server.ts";

const staticRoot = new URL("../src/web", import.meta.url).pathname;

test("serves static routes and keeps unknown API routes as JSON errors on loopback", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "event-hub web "));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initProject(root);
  const server = await startWebServer({ projectRoot: root, port: 0, staticRoot });
  t.after(() => server.close());

  assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+$/u);
  const page = await fetch(`${server.url}/plugins/example`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type") ?? "", /^text\/html/u);
  assert.match(await page.text(), /event-hub status/u);

  const api = await fetch(`${server.url}/api/v1/unknown`);
  assert.equal(api.status, 404);
  assert.match(api.headers.get("content-type") ?? "", /^application\/json/u);
  assert.deepEqual(await api.json(), {
    error: { code: "NOT_FOUND", message: "API route not found", details: null },
  });

  const post = await fetch(server.url, { method: "POST" });
  assert.equal(post.status, 405);
  assert.equal(post.headers.get("allow"), "GET");
});

test("serves a secret-free read-only dashboard API", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "event-hub dashboard "));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initProject(root);
  const server = await startWebServer({
    projectRoot: root,
    port: 0,
    staticRoot,
    statusProvider: async () => [
      {
        id: "source-a",
        kind: "source",
        state: "failed",
        lastRunAt: "2026-09-25T00:00:00.000Z",
        lastRunStartedAt: "2026-09-24T23:59:00.000Z",
        lastRunFinishedAt: "2026-09-25T00:00:00.000Z",
        lastInvocationId: "internal-invocation",
        pending: 2,
        pendingBreakdown: { pending: 1, retryWait: 1 },
        failure: "sentinel-secret-value",
        lastRunStatus: "failed",
        diagnostics: [],
        displayKind: "source",
        loadState: "loaded",
      },
    ],
  });
  t.after(() => server.close());

  const response = await fetch(`${server.url}/api/v1/dashboard`);
  assert.equal(response.status, 200);
  const body = (await response.json()) as Record<string, unknown>;
  assert.equal((body.summary as { pendingWork: number }).pendingWork, 2);
  const [plugin] = body.plugins as Array<{ lastRun: { startedAt: string; finishedAt: string } }>;
  assert.deepEqual(plugin.lastRun, {
    startedAt: "2026-09-24T23:59:00.000Z",
    finishedAt: "2026-09-25T00:00:00.000Z",
    status: "failed",
  });
  assert.doesNotMatch(JSON.stringify(body), /sentinel-secret-value|internal-invocation/u);

  const plugins = await fetch(`${server.url}/api/v1/plugins`);
  assert.equal(plugins.status, 200);
  assert.equal(((await plugins.json()) as { plugins: unknown[] }).plugins.length, 1);

  const invalid = await fetch(`${server.url}/api/v1/dashboard?unknown=true`);
  assert.equal(invalid.status, 400);
  assert.equal(((await invalid.json()) as { error: { code: string } }).error.code, "INVALID_QUERY");

  const post = await fetch(`${server.url}/api/v1/dashboard`, { method: "POST" });
  assert.equal(post.status, 405);
});

test("classifies invalid consumers without changing persistent state during GET", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "event-hub readonly dashboard "));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initProject(root);
  const invalid = join(root, "consumers", "invalid-consumer");
  await mkdir(invalid);
  await writeFile(join(invalid, "plugin.json"), '{"id":"SECRET_SENTINEL_VALUE","kind":"consumer"}\n');
  const server = await startWebServer({ projectRoot: root, port: 0, staticRoot });
  t.after(() => server.close());

  const response = await fetch(`${server.url}/api/v1/dashboard`);
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    summary: { sources: number; consumers: number; unhealthy: number; pendingWork: number };
    plugins: Array<{ id: string; kind: string; loadState: string }>;
  };
  assert.deepEqual(body.summary, { sources: 0, consumers: 1, unhealthy: 1, pendingWork: 0 });
  assert.deepEqual(
    body.plugins.map(({ id, kind, loadState }) => ({ id, kind, loadState })),
    [{ id: "invalid-consumer-1", kind: "consumer", loadState: "invalid" }],
  );
  assert.doesNotMatch(JSON.stringify(body), /SECRET_SENTINEL_VALUE/u);
  assert.equal(JSON.stringify(body).includes(root), false);
  assert.equal(existsSync(join(root, ".event-hub", "events.sqlite")), false);
  assert.equal(existsSync(join(root, ".event-hub", "runtime.sqlite")), false);
});

test("reports saved missing and disabled consumers and counts only pending and retry_wait", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "event-hub saved dashboard "));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initProject(root);
  const plugin = join(root, "consumers", "daily");
  await mkdir(plugin);
  await writeFile(
    join(plugin, "plugin.json"),
    `${JSON.stringify({
      id: "daily",
      kind: "consumer",
      entry: "index.mjs",
      config: null,
      env: {},
      trigger: { type: "daily", at: "09:00", timezone: "UTC" },
    })}\n`,
  );
  await writeFile(join(plugin, "index.mjs"), "export const execute = () => null;\n");
  const project = await openProjectRuntime(root, { get: () => undefined });
  const now = Date.now();
  for (const [index, status] of (["pending", "retry_wait", "running", "sleeping"] as const).entries()) {
    project.runtime.store.insertInvocation({
      id: `inv-${index}`,
      workflowName: "event-hub.consumer.daily",
      workflowVersion: "1",
      status,
      availableAt: now,
      idempotencyKey: null,
      scheduleId: null,
      scheduledAt: null,
      scheduledFrom: null,
      input: { pluginId: "daily" },
      output: undefined,
      error: null,
      createdAt: now + index,
      updatedAt: now + index,
    } satisfies InvocationRecord);
  }
  project.close();
  await rm(plugin, { recursive: true });

  const [missing] = await readProjectStatus(root);
  assert.equal(missing.loadState, "missing");
  assert.equal(missing.pending, 2);

  const synced = await openProjectRuntime(root, { get: () => undefined });
  synced.close();
  const [disabled] = await readProjectStatus(root);
  assert.equal(disabled.loadState, "disabled");
  assert.equal(disabled.pending, 2);

  await mkdir(plugin);
  await writeFile(
    join(plugin, "plugin.json"),
    `${JSON.stringify({
      id: "daily",
      kind: "consumer",
      entry: "index.mjs",
      config: null,
      env: {},
      trigger: { type: "daily", at: "09:00", timezone: "UTC" },
    })}\n`,
  );
  await writeFile(join(plugin, "index.mjs"), "export const execute = () => null;\n");
  const server = await startWebServer({ projectRoot: root, port: 0, staticRoot });
  t.after(() => server.close());
  const restored = (await (await fetch(`${server.url}/api/v1/dashboard`)).json()) as {
    plugins: Array<{ loadState: string; pendingWork: number }>;
  };
  assert.equal(restored.plugins.length, 1);
  assert.equal(restored.plugins[0].loadState, "loaded");
  assert.equal(restored.plugins[0].pendingWork, 2);
  const database = new DatabaseSync(join(root, ".event-hub", "events.sqlite"), { readOnly: true });
  const registration = database.prepare("SELECT active FROM plugin_registrations WHERE plugin_id = 'daily'").get() as {
    active: number;
  };
  database.close();
  assert.equal(registration.active, 0);
});

test("rejects invalid projects and reports a port conflict without sensitive details", async (t) => {
  const invalidRoot = await mkdtemp(join(tmpdir(), "event-hub invalid web "));
  t.after(() => rm(invalidRoot, { recursive: true, force: true }));
  await assert.rejects(
    startWebServer({ projectRoot: invalidRoot, port: 0, staticRoot }),
    /Invalid event-hub project: event-hub.json is missing or invalid/u,
  );

  const root = await mkdtemp(join(tmpdir(), "event-hub conflicting web "));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initProject(root);
  const occupied = createServer();
  await new Promise<void>((resolvePromise) => occupied.listen(0, "127.0.0.1", resolvePromise));
  t.after(() => occupied.close());
  const address = occupied.address();
  assert.ok(address && typeof address === "object");
  await assert.rejects(
    startWebServer({ projectRoot: root, port: address.port, staticRoot }),
    (error: unknown) => error instanceof WebServerError && error.message === `Port ${address.port} is already in use`,
  );
});

test("web CLI validates ports, uses the selected root, and prints the started URL", async () => {
  const output: string[] = [];
  const errors: string[] = [];
  const calls: Array<{ projectRoot: string; port: number }> = [];
  const dependencies = {
    projectRoot: "/current/project",
    readSecret: async () => "",
    out: (message: string) => output.push(message),
    error: (message: string) => errors.push(message),
    serveWeb: async (options: {
      projectRoot: string;
      port: number;
      signal: AbortSignal;
      onStarted(url: string): void;
    }) => {
      calls.push({ projectRoot: options.projectRoot, port: options.port });
      options.onStarted(`http://127.0.0.1:${options.port}`);
      return `http://127.0.0.1:${options.port}`;
    },
  };

  assert.equal(await run(["web", "--root", "./chosen", "--port", "4321"], dependencies), 0);
  assert.deepEqual(calls, [{ projectRoot: join(process.cwd(), "chosen"), port: 4321 }]);
  assert.deepEqual(output, ["Web UI: http://127.0.0.1:4321"]);
  assert.equal(await run(["web", "--port", "65536"], dependencies), 2);
  assert.deepEqual(errors, ["Invalid port: expected an integer from 1 to 65535"]);
});

test("serveWeb closes the listener when its signal is aborted", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "event-hub signalled web "));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initProject(root);
  const controller = new AbortController();
  let url = "";
  await serveWeb({
    projectRoot: root,
    port: 0,
    staticRoot,
    signal: controller.signal,
    onStarted: (startedUrl) => {
      url = startedUrl;
      controller.abort();
    },
  });
  await assert.rejects(fetch(url));
});

test("serves plugin details with a pending work breakdown and 404s unknown plugins", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "event-hub plugin detail "));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initProject(root);
  const server = await startWebServer({
    projectRoot: root,
    port: 0,
    staticRoot,
    statusProvider: async () => [
      {
        id: "source-a",
        kind: "source",
        state: "failed",
        lastRunAt: "2026-09-25T00:00:00.000Z",
        lastRunStartedAt: "2026-09-24T23:59:00.000Z",
        lastRunFinishedAt: "2026-09-25T00:00:00.000Z",
        lastInvocationId: "internal-invocation",
        pending: 3,
        pendingBreakdown: { pending: 2, retryWait: 1 },
        failure: "sentinel-secret-value",
        lastRunStatus: "failed",
        diagnostics: [],
        displayKind: "source",
        loadState: "loaded",
      },
    ],
  });
  t.after(() => server.close());

  const response = await fetch(`${server.url}/api/v1/plugins/source-a`);
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    plugin: { id: string; pendingWork: number; pendingWorkBreakdown: Record<string, number>; failure: unknown };
  };
  assert.equal(body.plugin.id, "source-a");
  assert.equal(body.plugin.pendingWork, 3);
  assert.deepEqual(body.plugin.pendingWorkBreakdown, { pending: 2, retry_wait: 1 });
  assert.deepEqual(body.plugin.failure, {
    code: "PLUGIN_EXECUTION_FAILED",
    message: "The plugin did not complete successfully",
    occurredAt: "2026-09-25T00:00:00.000Z",
  });
  assert.doesNotMatch(JSON.stringify(body), /sentinel-secret-value|internal-invocation/u);

  const missing = await fetch(`${server.url}/api/v1/plugins/unknown-source`);
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), {
    error: { code: "NOT_FOUND", message: "Plugin not found", details: null },
  });

  const query = await fetch(`${server.url}/api/v1/plugins/source-a?unknown=true`);
  assert.equal(query.status, 400);
  assert.equal(((await query.json()) as { error: { code: string } }).error.code, "INVALID_QUERY");

  const post = await fetch(`${server.url}/api/v1/plugins/source-a`, { method: "POST" });
  assert.equal(post.status, 405);
});

test("serves stored events newest first and validates the event query", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "event-hub events api "));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initProject(root);
  const store = new EventStore({ path: join(root, ".event-hub", "events.sqlite") });
  store.migrate();
  const event = (id: string, externalId: string, occurredAt: string) => ({
    id,
    externalId,
    type: "example.changed",
    schemaVersion: 1,
    occurredAt,
    observedAt: "2026-09-25T00:00:00.000Z",
    payload: { note: "visible" },
  });
  store.appendSourceBatch({
    sourceId: "source-a",
    expectedCursor: null,
    nextCursor: null,
    updatedAt: "2026-09-25T00:00:00.000Z",
    events: [
      event("evt-oldest", "1", "2026-09-24T00:00:00.000Z"),
      event("evt-b", "2", "2026-09-24T12:00:00.000Z"),
      event("evt-a", "3", "2026-09-24T12:00:00.000Z"),
    ],
  });
  store.appendSourceBatch({
    sourceId: "source-b",
    expectedCursor: null,
    nextCursor: null,
    updatedAt: "2026-09-25T00:00:00.000Z",
    events: [event("evt-other", "4", "2026-09-24T23:00:00.000Z")],
  });
  store.close();

  const server = await startWebServer({ projectRoot: root, port: 0, staticRoot });
  t.after(() => server.close());

  const response = await fetch(`${server.url}/api/v1/events?sourceId=source-a`);
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    events: Array<{ id: string; sourceId: string; occurredAt: string }>;
    page: { nextCursor: string | null; limit: number };
  };
  assert.deepEqual(
    body.events.map(({ id }) => id),
    ["evt-b", "evt-a", "evt-oldest"],
  );
  assert.deepEqual(body.page, { nextCursor: null, limit: 20 });
  assert.equal(
    body.events.every(({ sourceId }) => sourceId === "source-a"),
    true,
  );

  const limited = (await (await fetch(`${server.url}/api/v1/events?sourceId=source-a&limit=1`)).json()) as {
    events: Array<{ id: string }>;
    page: { limit: number };
  };
  assert.deepEqual(
    limited.events.map(({ id }) => id),
    ["evt-b"],
  );
  assert.equal(limited.page.limit, 1);

  const empty = (await (await fetch(`${server.url}/api/v1/events?sourceId=unknown-source`)).json()) as {
    events: unknown[];
  };
  assert.deepEqual(empty.events, []);

  for (const query of [
    "",
    "?limit=20",
    "?sourceId=source-a&limit=0",
    "?sourceId=source-a&limit=101",
    "?sourceId=source-a&limit=abc",
    "?sourceId=source-a&type=example.changed",
    "?sourceId=source-a&sourceId=source-b",
  ]) {
    const invalid = await fetch(`${server.url}/api/v1/events${query}`);
    assert.equal(invalid.status, 400, query);
    const error = (await invalid.json()) as { error: { code: string; message: string; details: { fields: string[] } } };
    assert.equal(error.error.code, "INVALID_QUERY");
    assert.equal(error.error.message, "Invalid query");
    assert.ok(error.error.details.fields.length > 0, query);
  }

  const post = await fetch(`${server.url}/api/v1/events?sourceId=source-a`, { method: "POST" });
  assert.equal(post.status, 405);
});

test("reads event history without creating the event store", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "event-hub events readonly "));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initProject(root);
  const server = await startWebServer({ projectRoot: root, port: 0, staticRoot });
  t.after(() => server.close());

  const response = await fetch(`${server.url}/api/v1/events?sourceId=source-a`);
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()) as unknown, { events: [], page: { nextCursor: null, limit: 20 } });
  assert.equal(existsSync(join(root, ".event-hub", "events.sqlite")), false);
});
