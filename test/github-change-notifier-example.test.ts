import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

import {
  discoverAndSyncPlugins,
  EVENT_CONSUMER_WORKFLOW,
  EventStore,
  pollSource,
  runConsumerPlugin,
  runPluginProcess,
  tickProject,
} from "../src/index.ts";
import type { Json, WorkflowContext } from "@jugyo/duex";
import type { SourcePollPage } from "../src/index.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXAMPLE = resolve(HERE, "../examples/github-change-notifier");
const NOW = new Date("2026-09-10T00:00:00.000Z");
const context: WorkflowContext = {
  invocationId: "example-test", workflowName: "example-test", scheduledAt: null, scheduledFrom: null,
  run: async (_name, operation) => operation(), sleep: async () => {},
  now: async () => NOW, uuid: async () => "00000000-0000-4000-8000-000000000000",
};

test("runs paginated GitHub collection, change notifications, and daily history summaries with fakes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "event-hub github example "));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(EXAMPLE, root, { recursive: true });
  const notifications = join(root, "notifications.jsonl");
  const notifier = join(root, "fake-notifier.mjs");
  await writeFile(notifier, `import { appendFile } from "node:fs/promises"; await appendFile(process.argv[2], JSON.stringify({ title: process.argv[3], message: process.argv[4] }) + "\\n");\n`);

  const githubRequests: URL[] = [];
  const geminiPrompts: string[] = [];
  const commits = [
    { sha: "aaa", html_url: "https://example.test/aaa", author: { login: "alice" }, commit: { message: "cherry-picked change", author: { date: "2020-01-01T00:00:00.000Z" }, committer: { date: "2026-09-09T12:00:00.000Z" } } },
    { sha: "bbb", html_url: "https://example.test/bbb", author: { login: "bob" }, commit: { message: "second change", author: { date: "2026-09-09T22:00:00.000Z" }, committer: { date: "2026-09-09T23:00:00.000Z" } } },
  ];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname.includes("/repos/example/project/commits")) {
      githubRequests.push(url);
      const page = Number(url.searchParams.get("page"));
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(page <= commits.length ? [commits[page - 1]] : []));
      return;
    }
    if (url.pathname.includes(":generateContent")) {
      let body = "";
      for await (const chunk of request) body += chunk;
      geminiPrompts.push(JSON.parse(body).contents[0].parts[0].text);
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: `Summary ${geminiPrompts.length}` }] } }] }));
      return;
    }
    response.statusCode = 404; response.end();
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  t.after(() => new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose())));
  const address = server.address();
  if (typeof address === "string" || address === null) throw new Error("fake server did not start");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const manifests = [
    join(root, "sources/github/plugin.json"),
    join(root, "consumers/change-notification/plugin.json"),
    join(root, "consumers/daily-summary/plugin.json"),
  ];
  for (const path of manifests) {
    const manifest = JSON.parse(await readFile(path, "utf8"));
    manifest.config.repository ??= "example/project";
    if (manifest.kind === "source") { manifest.config.repository = "example/project"; manifest.config.apiBaseUrl = baseUrl; manifest.config.perPage = 1; }
    else {
      manifest.config.geminiBaseUrl = baseUrl;
      manifest.config.notification = { command: process.execPath, args: [notifier, notifications, "{title}", "{message}"] };
    }
    await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
  }

  const store = new EventStore({ path: join(root, ".event-hub", "events.sqlite") });
  store.migrate();
  t.after(() => store.close());
  const discovery = await discoverAndSyncPlugins({ projectRoot: root, store, now: NOW.toISOString() });
  assert.deepEqual(discovery.diagnostics, []);
  assert.deepEqual(discovery.plugins.map(({ id }) => id), ["github.change-notification", "github.commits", "github.daily-summary"]);
  const secrets = { get: (name: string) => name === "WORK_GITHUB_TOKEN" ? "fake-github-token" : "fake-gemini-key" };
  // The first tick subscribes the event consumer before any event is stored.
  assert.deepEqual((await tickProject(root, secrets)).runs, []);
  const source = discovery.plugins.find(({ id }) => id === "github.commits")!;
  const sourceManifest = source.manifest as { config: Json; env: Record<string, string> };
  const collected = await pollSource({
    sourceId: source.id, store, config: sourceManifest.config, now: () => NOW,
    poll: (input) => runPluginProcess({ context, entry: pathToFileURL(source.entrypoint).href, input: input as unknown as Json, env: sourceManifest.env, secrets }) as unknown as Promise<SourcePollPage>,
  });
  assert.equal(collected.insertedEvents, 2);
  assert.equal(githubRequests.length, 3);
  assert.equal(githubRequests[0].searchParams.get("since"), "2026-09-09T00:00:00.000Z");
  const history = store.queryHistory({ from: "2026-09-09T00:00:00.000Z", to: NOW.toISOString() }).events;
  assert.deepEqual(history.map(({ occurredAt }) => occurredAt), ["2026-09-09T12:00:00.000Z", "2026-09-09T23:00:00.000Z"]);
  assert.equal((history[0].payload as { authoredAt: Json }).authoredAt, "2020-01-01T00:00:00.000Z");

  const delivered = await tickProject(root, secrets);
  assert.deepEqual(delivered.runs.map(({ workflow, outcome }) => ({ workflow, outcome })), [
    { workflow: EVENT_CONSUMER_WORKFLOW, outcome: "completed" },
    { workflow: EVENT_CONSUMER_WORKFLOW, outcome: "completed" },
  ]);
  assert.deepEqual(history.map(({ id }) => store.getDelivery("github.change-notification", id)?.status), ["completed", "completed"]);

  const daily = discovery.plugins.find(({ id }) => id === "github.daily-summary")!;
  const dailyManifest = daily.manifest as { config: Json; env: Record<string, string> };
  const dailyResult = await runConsumerPlugin({
    context, store, entry: pathToFileURL(daily.entrypoint).href, env: dailyManifest.env, secrets,
    input: { scheduledAt: NOW.toISOString(), window: { from: "2026-09-09T00:00:00.000Z", to: NOW.toISOString() }, config: dailyManifest.config },
  });
  assert.deepEqual((dailyResult as { counts: Json }).counts, { day: 2, week: 2 });
  assert.equal(geminiPrompts.length, 3);
  const sent = (await readFile(notifications, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(sent.map(({ title, message }) => ({ title, message })), [
    { title: "Changes in example/project", message: "Summary 1" },
    { title: "Changes in example/project", message: "Summary 2" },
    { title: "GitHub daily summary", message: "Summary 3" },
  ]);

  await rm(join(root, "consumers/change-notification"), { recursive: true });
  const afterRemoval = await discoverAndSyncPlugins({ projectRoot: root, store, now: "2026-09-10T01:00:00.000Z" });
  assert.deepEqual(afterRemoval.plugins.map(({ id }) => id), ["github.commits", "github.daily-summary"]);
});
