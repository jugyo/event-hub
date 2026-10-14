import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { run } from "../src/cli.ts";
import { initProject } from "../src/init.ts";
import type { SecretBackend } from "../src/secrets/backend.ts";
import { EventStore, type Json } from "../src/storage/event-store.ts";

const backend: SecretBackend = {
  create: async () => {},
  update: async () => {},
  delete: async () => {},
  get: async () => "sentinel-secret-value",
};

interface Captured {
  out: string[];
  error: string[];
  dependencies: Parameters<typeof run>[1];
}

function capture(root: string): Captured {
  const out: string[] = [];
  const error: string[] = [];
  return {
    out,
    error,
    dependencies: {
      projectRoot: root,
      backend,
      readSecret: async () => "",
      out: (message: string) => out.push(message),
      error: (message: string) => error.push(message),
    },
  };
}

async function sourcePlugin(root: string, id: string): Promise<void> {
  const directory = join(root, "sources", id);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "plugin.json"),
    `${JSON.stringify({
      id,
      kind: "source",
      entry: "index.mjs",
      config: { owner: "jugyo" },
      env: { TOKEN: "WORK_GITHUB_TOKEN" },
      trigger: { type: "poll", every: "5m" },
    })}\n`,
  );
  await writeFile(join(directory, "index.mjs"), "export const collect = () => ({ events: [], cursor: null });\n");
}

function storeEvents(
  root: string,
  sourceId: string,
  events: Array<{ id: string; type: string; schemaVersion?: number; occurredAt: string; payload?: Json }>,
): void {
  const store = new EventStore({ path: join(root, ".event-hub", "events.sqlite") });
  try {
    store.migrate();
    store.appendSourceBatch({
      sourceId,
      expectedCursor: null,
      nextCursor: null,
      updatedAt: "2026-10-10T00:00:00.000Z",
      events: events.map(({ id, type, schemaVersion = 1, occurredAt, payload = null }) => ({
        id,
        externalId: id,
        type,
        schemaVersion,
        occurredAt,
        observedAt: "2026-10-10T00:00:00.000Z",
        payload,
      })),
    });
  } finally {
    store.close();
  }
}

async function project(t: { after(fn: () => unknown): void }): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "event-hub inspect "));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initProject(root);
  return root;
}

test("plugins lists every plugin with its trigger and code location", async (t) => {
  const root = await project(t);
  await sourcePlugin(root, "demo");
  const { out, dependencies } = capture(root);

  assert.equal(await run(["plugins", "--root", root], dependencies), 0);
  const [line] = out;
  const fields = line.split("\t");
  assert.deepEqual(fields.slice(0, 4), ["demo", "source", "ready", "poll every 300000ms"]);
  assert.ok(fields.includes("lastRun=-"), line);
  assert.ok(
    fields.some((field) => field === `directory=${join(root, "sources", "demo")}`),
    line,
  );
  assert.ok(
    fields.some((field) => field.endsWith(join("sources", "demo", "index.mjs"))),
    line,
  );

  out.length = 0;
  assert.equal(await run(["plugins", "--root", root, "--json"], dependencies), 0);
  const listed = (JSON.parse(out[0]) as { plugins: Array<Record<string, unknown>> }).plugins;
  assert.deepEqual(Object.keys(listed[0]), [
    "id",
    "kind",
    "state",
    "trigger",
    "lastRunAt",
    "failure",
    "directory",
    "entrypoint",
  ]);
  assert.equal(listed[0].entrypoint !== null, true);
});

test("plugins <id> adds the manifest and rejects an unknown id", async (t) => {
  const root = await project(t);
  await sourcePlugin(root, "demo");
  const { out, error, dependencies } = capture(root);

  assert.equal(await run(["plugins", "demo", "--root", root], dependencies), 0);
  const detail = out.join("\n");
  assert.ok(detail.includes('config: {"owner":"jugyo"}'), detail);
  assert.ok(detail.includes('env: {"TOKEN":"WORK_GITHUB_TOKEN"}'), detail);
  // Only the reference name is printed; the backend value never reaches the output.
  assert.doesNotMatch(out.join("\n"), /sentinel-secret-value/u);

  out.length = 0;
  assert.equal(await run(["plugins", "demo", "--root", root, "--json"], dependencies), 0);
  const { plugin } = JSON.parse(out[0]) as { plugin: Record<string, unknown> };
  assert.deepEqual(plugin.config, { owner: "jugyo" });
  assert.deepEqual(plugin.env, { TOKEN: "WORK_GITHUB_TOKEN" });
  assert.deepEqual(plugin.trigger, { type: "poll", everyMs: 300_000 });

  assert.equal(await run(["plugins", "missing", "--root", root], dependencies), 2);
  assert.deepEqual(error, ["Plugin not found: missing"]);
});

test("types groups stored events by source, type, and schema version", async (t) => {
  const root = await project(t);
  storeEvents(root, "demo", [
    { id: "e1", type: "demo.changed", occurredAt: "2026-10-01T00:00:00.000Z", payload: { a: 1 } },
    { id: "e2", type: "demo.changed", occurredAt: "2026-10-03T00:00:00.000Z", payload: { a: 2 } },
    { id: "e3", type: "demo.changed", schemaVersion: 2, occurredAt: "2026-10-05T00:00:00.000Z", payload: { b: "x" } },
  ]);
  storeEvents(root, "other", [{ id: "e4", type: "other.changed", occurredAt: "2026-10-06T00:00:00.000Z" }]);
  const { out, dependencies } = capture(root);

  assert.equal(await run(["types", "--root", root, "--json"], dependencies), 0);
  const { types } = JSON.parse(out[0]) as { types: Array<Record<string, unknown>> };
  assert.deepEqual(types, [
    {
      sourceId: "demo",
      type: "demo.changed",
      schemaVersion: 1,
      count: 2,
      firstOccurredAt: "2026-10-01T00:00:00.000Z",
      lastOccurredAt: "2026-10-03T00:00:00.000Z",
      samplePayload: { a: 2 },
    },
    {
      sourceId: "demo",
      type: "demo.changed",
      schemaVersion: 2,
      count: 1,
      firstOccurredAt: "2026-10-05T00:00:00.000Z",
      lastOccurredAt: "2026-10-05T00:00:00.000Z",
      samplePayload: { b: "x" },
    },
    {
      sourceId: "other",
      type: "other.changed",
      schemaVersion: 1,
      count: 1,
      firstOccurredAt: "2026-10-06T00:00:00.000Z",
      lastOccurredAt: "2026-10-06T00:00:00.000Z",
      samplePayload: null,
    },
  ]);

  out.length = 0;
  assert.equal(await run(["types", "--root", root, "--source", "other", "--json"], dependencies), 0);
  assert.deepEqual(
    (JSON.parse(out[0]) as { types: Array<{ sourceId: string }> }).types.map(({ sourceId }) => sourceId),
    ["other"],
  );

  out.length = 0;
  assert.equal(await run(["types", "--root", root], dependencies), 0);
  assert.ok(
    out.some((line) => line.startsWith("demo\tdemo.changed\tschemaVersion=1\tcount=2")),
    out.join("\n"),
  );
  assert.ok(out.includes('\tsample={"b":"x"}'), out.join("\n"));
});

test("events filters stored history and prints one event per line", async (t) => {
  const root = await project(t);
  storeEvents(root, "demo", [
    { id: "e1", type: "demo.changed", occurredAt: "2026-10-01T00:00:00.000Z" },
    { id: "e2", type: "demo.removed", occurredAt: "2026-10-03T00:00:00.000Z" },
    { id: "e3", type: "demo.changed", occurredAt: "2026-10-05T00:00:00.000Z" },
  ]);
  storeEvents(root, "other", [{ id: "e4", type: "demo.changed", occurredAt: "2026-10-04T00:00:00.000Z" }]);
  const { out, error, dependencies } = capture(root);

  const ids = async (...argv: string[]): Promise<string[]> => {
    out.length = 0;
    assert.equal(await run(["events", "--root", root, "--json", ...argv], dependencies), 0, argv.join(" "));
    return out.map((line) => (JSON.parse(line) as { id: string }).id);
  };

  assert.deepEqual(await ids(), ["e3", "e4", "e2", "e1"]);
  assert.deepEqual(await ids("--source", "demo"), ["e3", "e2", "e1"]);
  assert.deepEqual(await ids("--type", "demo.removed"), ["e2"]);
  assert.deepEqual(await ids("--type", "demo.removed", "--type", "demo.changed"), ["e3", "e4", "e2", "e1"]);
  // The window is half-open: an event exactly at `to` is excluded and one exactly at `from` is kept.
  assert.deepEqual(await ids("--from", "2026-10-03T00:00:00Z", "--to", "2026-10-05T00:00:00Z"), ["e4", "e2"]);
  assert.deepEqual(await ids("--limit", "1"), ["e3"]);

  out.length = 0;
  assert.equal(await run(["events", "--root", root, "--limit", "1"], dependencies), 0);
  assert.deepEqual(out, ["2026-10-05T00:00:00.000Z\tdemo\tdemo.changed\te3\tnull"]);

  out.length = 0;
  assert.equal(await run(["events", "--root", root, "--json", "--limit", "1"], dependencies), 0);
  assert.deepEqual(Object.keys(JSON.parse(out[0]) as Record<string, unknown>).sort(), [
    "externalId",
    "id",
    "observedAt",
    "occurredAt",
    "payload",
    "schemaVersion",
    "sourceId",
    "type",
  ]);

  for (const argv of [
    ["--from", "2026-10-01"],
    ["--to", "not-a-date"],
    ["--from", "2026-10-05T00:00:00Z", "--to", "2026-10-01T00:00:00Z"],
  ]) {
    error.length = 0;
    assert.equal(await run(["events", "--root", root, ...argv], dependencies), 2, argv.join(" "));
    assert.equal(error.length, 1, argv.join(" "));
  }
});

test("empty results are reported without an error", async (t) => {
  const root = await project(t);
  const { out, dependencies } = capture(root);

  assert.equal(await run(["plugins", "--root", root], dependencies), 0);
  assert.deepEqual(out, ["No plugins found"]);
  out.length = 0;
  assert.equal(await run(["types", "--root", root], dependencies), 0);
  assert.deepEqual(out, ["No events found"]);
  out.length = 0;
  assert.equal(await run(["events", "--root", root], dependencies), 0);
  assert.deepEqual(out, ["No events found"]);
  out.length = 0;
  assert.equal(await run(["events", "--root", root, "--json"], dependencies), 0);
  assert.deepEqual(out, []);
});

test("help documents the options, the output fields, and the investigation order", async (t) => {
  const root = await project(t);
  const { out, dependencies } = capture(root);

  assert.equal(await run(["--help"], dependencies), 0);
  const general = out.join("\n");
  for (const fragment of [
    "event-hub plugins --json",
    "event-hub types --json",
    "event-hub events --source <id> --type <t> --json | jq",
    "Read the plugin code",
    "--root <directory>",
  ]) {
    assert.ok(general.includes(fragment), fragment);
  }

  for (const [command, fragments] of [
    ["plugins", ["Usage: event-hub plugins", "entrypoint", "Examples:", "reference"]],
    ["types", ["Usage: event-hub types", "--source <id>", "samplePayload", "Examples:"]],
    ["events", ["Usage: event-hub events", "--limit <n>", "[from, to)", "observedAt", "Examples:"]],
    ["status", ["Usage: event-hub status"]],
    ["secret", ["Usage: event-hub secret"]],
  ] as const) {
    out.length = 0;
    assert.equal(await run([command, "--help"], dependencies), 0);
    const text = out.join("\n");
    for (const fragment of fragments) assert.ok(text.includes(fragment), `${command}: ${fragment}`);
  }

  out.length = 0;
  assert.equal(await run(["events", "-h"], dependencies), 0);
  assert.ok(out.join("\n").startsWith("Usage: event-hub events"));
});
