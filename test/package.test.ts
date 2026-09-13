import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// During migration, @jugyo/duex is an external package resolved through file:../mini-restate,
// so its tarball is also built from the adjacent checkout.
const duexRoot = resolve(repositoryRoot, "..", "mini-restate");

function run(command: string, args: string[], cwd: string) {
  return spawnSync(command, args, { cwd, encoding: "utf8" });
}

// npm pack mixes prepack output into stdout and prints the JSON array last.
// Script logs may also contain `[`, so parse from the last line that starts with `[`.
function pack(packageRoot: string, destination: string) {
  const result = run("npm", ["pack", "--json", "--pack-destination", destination], packageRoot);
  assert.equal(result.status, 0, result.stderr);
  const starts = [...result.stdout.matchAll(/^\[/gm)].map((match) => match.index);
  const start = starts.at(-1);
  assert.notEqual(start, undefined, result.stdout);
  const [{ filename }] = JSON.parse(result.stdout.slice(start)) as [{ filename: string }];
  return join(destination, filename);
}

test("installs the packed package and initializes a directory containing spaces", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "event-hub package "));
  try {
    const tarball = pack(repositoryRoot, temporaryRoot);
    const duexTarball = pack(duexRoot, temporaryRoot);

    const installRoot = join(temporaryRoot, "installed application");
    const projectRoot = join(temporaryRoot, "project with spaces");
    await writeFile(join(temporaryRoot, "package.json"), "{}\n");
    const install = run("npm", ["install", "--prefix", installRoot, duexTarball, tarball], temporaryRoot);
    assert.equal(install.status, 0, install.stderr);

    const duexImport = run(
      "node",
      ["--input-type=module", "--eval", "import { defineWorkflow } from '@jugyo/duex'; if (typeof defineWorkflow !== 'function') process.exit(1)"],
      installRoot,
    );
    assert.equal(duexImport.status, 0, duexImport.stderr);

    const executable = join(installRoot, "node_modules", ".bin", "event-hub");
    const first = run(executable, ["init", projectRoot], temporaryRoot);
    assert.equal(first.status, 0, first.stderr);
    const config = await readFile(join(projectRoot, "event-hub.json"), "utf8");

    const second = run(executable, ["init", projectRoot], temporaryRoot);
    assert.equal(second.status, 2);
    assert.match(second.stderr, /targets already exist/);
    assert.equal(await readFile(join(projectRoot, "event-hub.json"), "utf8"), config);

    const packageFiles = run("tar", ["-tf", tarball], temporaryRoot);
    assert.equal(packageFiles.status, 0, packageFiles.stderr);
    // Resolve @jugyo/duex distribution files from the dependency package, not the application tarball.
    assert.doesNotMatch(packageFiles.stdout, /package\/dist\/src\/mini-restate\.js/);
    assert.doesNotMatch(packageFiles.stdout, /package\/dist\/mini-restate\//);

    const duexFiles = run("tar", ["-tf", duexTarball], temporaryRoot);
    assert.equal(duexFiles.status, 0, duexFiles.stderr);
    assert.match(duexFiles.stdout, /package\/dist\/src\/index\.js/);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("runs the primary operational scenario using only packed packages", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "event-hub acceptance "));
  try {
    const tarball = pack(repositoryRoot, temporaryRoot);
    const duexTarball = pack(duexRoot, temporaryRoot);
    const installRoot = join(temporaryRoot, "clean installed application");
    const projectRoot = join(temporaryRoot, "operated project");
    const install = run("npm", ["install", "--prefix", installRoot, duexTarball, tarball], temporaryRoot);
    assert.equal(install.status, 0, install.stderr);

    const runner = join(installRoot, "acceptance.mjs");
    await writeFile(runner, `
import assert from "node:assert/strict";
import { access, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  EventStore, SecretService, initProject, openProjectRuntime, projectStatus, tickProject,
} from "event-hub";

const root = process.argv[2];
const hidden = "acceptance-secret-must-not-be-persisted";
const values = new Map();
const backend = {
  async create(name, value) { assert.equal(values.has(name), false); values.set(name, value); },
  async update(name, value) { assert.equal(values.has(name), true); values.set(name, value); },
  async get(name) { assert.equal(values.has(name), true); return values.get(name); },
  async delete(name) { values.delete(name); },
};
const secrets = new SecretService(root, backend);
await initProject(root);
await secrets.create("API_TOKEN", hidden);
assert.deepEqual(await secrets.list(), ["API_TOKEN"]);
assert.doesNotMatch(await readFile(join(root, "event-hub.json"), "utf8"), new RegExp(hidden));

async function plugin(kind, directory, manifest, source) {
  const path = join(root, kind === "source" ? "sources" : "consumers", directory);
  await mkdir(path);
  await writeFile(join(path, "plugin.json"), JSON.stringify(manifest, null, 2) + "\\n");
  await writeFile(join(path, "index.mjs"), source);
  return path;
}
const now = Date.now();
const iso = offset => new Date(now + offset).toISOString();
const healthy = await plugin("source", "healthy", {
  id: "healthy", kind: "source", entry: "index.mjs", config: { revision: 1 },
  env: { TOKEN: "API_TOKEN" }, trigger: { type: "poll", everyMs: 60000, backfillMs: 604800000 },
}, \`export async function execute(ctx, input) {
  return ctx.run("fake-api", () => {
    if (process.env.TOKEN !== "acceptance-" + "secret-must-not-be-persisted" || process.env.EH_PARENT_SENTINEL !== undefined) throw new Error("environment mapping failed");
    return { events: [
      { id: "old-event", externalId: "old-event", type: "example.changed", schemaVersion: 1,
        occurredAt: new Date(Date.parse(input.to) - 6 * 86400000).toISOString(), observedAt: input.to, payload: { age: "week" } },
      { id: "recent-event", externalId: "recent-event", type: "example.changed", schemaVersion: 1,
        occurredAt: input.to, observedAt: input.to, payload: { age: "recent", revision: input.config.revision } }
    ], nextCursor: "healthy-1", hasMore: false };
  });
}\`);
const crash = await plugin("source", "crash-once", {
  id: "crash-once", kind: "source", entry: "index.mjs", config: { marker: join(root, ".event-hub", "crashed") },
  env: {}, trigger: { type: "poll", everyMs: 60000 },
}, \`import { access, writeFile } from "node:fs/promises";
export async function execute(ctx, input) {
  await ctx.run("fake-api", async () => { try { await access(input.config.marker); } catch { await writeFile(input.config.marker, "once"); process.exit(17); } return { resumed: true }; }, { retry: { maxAttempts: 2, initialDelayMs: 1 } });
  return { events: [], nextCursor: "recovered", hasMore: false };
}\`);
await plugin("consumer", "weekly", {
  id: "weekly", kind: "consumer", entry: "index.mjs", config: null, env: {},
  trigger: { type: "daily", at: "00:00", timezone: "UTC" },
}, \`import { writeFile } from "node:fs/promises";
export async function execute(ctx, input) {
  const from = new Date(Date.parse(input.scheduledAt) - 7 * 86400000).toISOString();
  const history = await ctx.queryHistory({ from, to: new Date(Date.parse(input.scheduledAt) + 1).toISOString() });
  return ctx.run("fake-backend", async () => { await writeFile(${JSON.stringify(join(projectRoot, ".event-hub", "weekly.json"))}, JSON.stringify(history.events.map(event => event.id))); return { count: history.events.length }; });
}\`);
await mkdir(join(root, "sources", "invalid"));
await writeFile(join(root, "sources", "invalid", "plugin.json"), "not json\\n");

async function makeDue(ids) {
  const project = await openProjectRuntime(root, secrets);
  for (const id of ids) project.runtime.store.updateSchedule(id, { nextRunAt: Date.now() - 1, updatedAt: Date.now() });
  project.close();
}
process.env.EH_PARENT_SENTINEL = "parent-secret-that-must-not-leak";
await makeDue(["plugin:source:healthy", "plugin:source:crash-once"]);
const first = await tickProject(root, secrets, 2);
assert.equal(first.runs.some(run => run.outcome === "retry_wait"), true);
assert.equal(first.runs.some(run => run.outcome === "completed"), true);
await new Promise(resolve => setTimeout(resolve, 10));
const resumed = await tickProject(root, secrets, 10);
assert.equal(resumed.runs.some(run => run.outcome === "completed"), true, JSON.stringify(resumed));

await makeDue(["plugin:consumer:weekly"]);
const aggregated = await tickProject(root, secrets, 10);
assert.equal(aggregated.runs.some(run => run.outcome === "completed"), true);
assert.deepEqual(JSON.parse(await readFile(join(root, ".event-hub", "weekly.json"), "utf8")), ["old-event", "recent-event"]);
let statuses = await projectStatus(root, secrets);
assert.equal(statuses.find(status => status.id === "healthy")?.state, "ready");
assert.equal(statuses.find(status => status.id === "crash-once")?.state, "ready");
assert.equal(statuses.some(status => status.state === "invalid" && status.failure.includes("MANIFEST_INVALID")), true);

const healthyManifestPath = join(healthy, "plugin.json");
const updatedManifest = JSON.parse(await readFile(healthyManifestPath, "utf8"));
updatedManifest.config.revision = 2;
delete updatedManifest.trigger.backfillMs;
await writeFile(healthyManifestPath, JSON.stringify(updatedManifest, null, 2) + "\\n");
let store = new EventStore({ path: join(root, ".event-hub", "events.sqlite") });
store.migrate();
store.appendSourceBatch({ sourceId: "healthy", expectedCursor: "healthy-1", nextCursor: "healthy-1",
  updatedAt: iso(-3 * 86400000), events: [] });
store.close();
await makeDue(["plugin:source:healthy"]);
const limited = await tickProject(root, secrets, 10);
const limitedRun = limited.runs.find(run => run.outcome === "completed");
assert.ok(limitedRun);
const limitedProject = await openProjectRuntime(root, secrets);
const limitedInvocation = limitedProject.runtime.listInvocations({ scheduleId: "plugin:source:healthy" })[0];
limitedProject.close();
assert.equal(limitedInvocation.output.diagnostic.code, "SOURCE_BACKFILL_LIMITED");

await rm(crash, { recursive: true });
await projectStatus(root, secrets);
store = new EventStore({ path: join(root, ".event-hub", "events.sqlite") });
store.migrate();
assert.deepEqual(store.queryHistory({ from: iso(-7 * 86400000), to: iso(86400000) }).events.map(event => event.id), ["old-event", "recent-event"]);
assert.equal(store.listPluginRegistrations().find(plugin => plugin.id === "crash-once")?.active, false);
store.close();
statuses = await projectStatus(root, secrets);
assert.equal(statuses.some(status => status.id === "crash-once"), false);

await secrets.update("API_TOKEN", hidden + "-updated");
await secrets.delete("API_TOKEN");
assert.deepEqual(await secrets.list(), []);
async function persistedFiles(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await persistedFiles(path)); else result.push(path);
  }
  return result;
}
for (const path of await persistedFiles(root)) {
  const content = await readFile(path);
  assert.equal(content.includes(Buffer.from(hidden)), false, \`secret persisted in \${path}\`);
}
console.log(JSON.stringify({ first: first.runs.map(run => run.outcome), resumed: resumed.runs.map(run => run.outcome), plugins: statuses.map(({ id, state }) => ({ id, state })) }));
`);

    const acceptance = run("node", [runner, projectRoot], installRoot);
    assert.equal(acceptance.status, 0, `${acceptance.stdout}\n${acceptance.stderr}`);
    const evidence = JSON.parse(acceptance.stdout) as { first: string[]; resumed: string[] };
    assert.ok(evidence.first.includes("retry_wait"));
    assert.ok(evidence.resumed.includes("completed"));
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
