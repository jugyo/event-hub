import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { discoverAndSyncPlugins, EventStore } from "../src/index.ts";

const T1 = "2026-09-09T00:00:00.000Z";
const T2 = "2026-09-09T01:00:00.000Z";
const T3 = "2026-09-09T02:00:00.000Z";

function sourceManifest(id: string, entry = "index.mjs", everyMs = 60_000) {
  return {
    id,
    kind: "source",
    entry,
    config: { repository: "example/project" },
    env: { GITHUB_TOKEN: "WORK_GITHUB_TOKEN" },
    trigger: { type: "poll", everyMs },
  };
}

function consumerManifest(id: string, entry = "index.mjs") {
  return {
    id,
    kind: "consumer",
    entry,
    config: {},
    env: {},
    trigger: { type: "events", eventTypes: ["example.changed"] },
  };
}

async function writePlugin(
  root: string,
  kind: "sources" | "consumers",
  name: string,
  manifest: unknown,
  code = "export const value = 1;\n",
) {
  const directory = join(root, kind, name);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "plugin.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  if (typeof manifest === "object" && manifest && "entry" in manifest && typeof manifest.entry === "string") {
    await writeFile(join(directory, manifest.entry), code);
  }
  return directory;
}

test("registers valid plugins while diagnosing invalid plugins", async () => {
  const root = await mkdtemp(join(tmpdir(), "event-hub discovery "));
  const store = new EventStore({
    path: join(root, ".event-hub", "state.sqlite"),
  });
  try {
    store.migrate();
    const validDirectory = await writePlugin(root, "sources", "valid", sourceManifest("source.valid"));
    await writePlugin(root, "consumers", "wrong-kind", sourceManifest("source.wrong-kind"));
    const missingEntry = join(root, "consumers", "missing-entry");
    await mkdir(missingEntry, { recursive: true });
    await writeFile(join(missingEntry, "plugin.json"), JSON.stringify(consumerManifest("consumer.missing")));
    const broken = join(root, "sources", "broken");
    await mkdir(broken, { recursive: true });
    await writeFile(join(broken, "plugin.json"), "not json");

    const result = await discoverAndSyncPlugins({
      projectRoot: root,
      store,
      now: T1,
    });

    assert.deepEqual(
      result.plugins.map(({ id }) => id),
      ["source.valid"],
    );
    assert.deepEqual(result.diagnostics.map(({ code }) => code).sort(), [
      "ENTRYPOINT_MISSING",
      "KIND_MISMATCH",
      "MANIFEST_INVALID",
    ]);
    assert.ok(result.diagnostics.every(({ path }) => path.startsWith(root)));
    assert.equal(result.diagnostics.find(({ id }) => id === "consumer.missing")?.code, "ENTRYPOINT_MISSING");
    assert.deepEqual(
      store.listPluginRegistrations({ activeOnly: true }).map(({ id, directory }) => ({ id, directory })),
      [{ id: "source.valid", directory: validDirectory }],
    );
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("applies additions, updates, and removals on the next sync while preserving stable-ID state", async () => {
  const root = await mkdtemp(join(tmpdir(), "event-hub sync "));
  const store = new EventStore({
    path: join(root, ".event-hub", "state.sqlite"),
  });
  try {
    store.migrate();
    const sourceDirectory = await writePlugin(root, "sources", "source", sourceManifest("source.stable"));
    const consumerDirectory = await writePlugin(root, "consumers", "consumer", consumerManifest("consumer.stable"));
    await discoverAndSyncPlugins({ projectRoot: root, store, now: T1 });
    store.appendSourceBatch({
      sourceId: "source.stable",
      expectedCursor: null,
      nextCursor: { page: 3 },
      updatedAt: T1,
      events: [],
    });
    store.registerConsumer("consumer.stable", T1);

    await writeFile(
      join(sourceDirectory, "plugin.json"),
      `${JSON.stringify(sourceManifest("source.stable", "index.mjs", 120_000))}\n`,
    );
    await rm(consumerDirectory, { recursive: true });
    await writePlugin(root, "consumers", "added", consumerManifest("consumer.added"));
    await discoverAndSyncPlugins({ projectRoot: root, store, now: T2 });

    assert.deepEqual(store.getSourceCheckpoint("source.stable")?.cursor, {
      page: 3,
    });
    assert.doesNotThrow(() => store.matchConsumerEvents("consumer.stable", ["example.changed"], 10, T3));
    const registrations = store.listPluginRegistrations();
    assert.deepEqual(
      registrations.map(({ id, active }) => ({ id, active })),
      [
        { id: "consumer.added", active: true },
        { id: "consumer.stable", active: false },
        { id: "source.stable", active: true },
      ],
    );
    const source = registrations.find(({ id }) => id === "source.stable")!;
    assert.equal(source.createdAt, T1);
    assert.equal(source.updatedAt, T2);
    assert.equal((source.manifest as { trigger: { everyMs: number } }).trigger.everyMs, 120_000);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects duplicate IDs and static cross-plugin imports per plugin", async () => {
  const root = await mkdtemp(join(tmpdir(), "event-hub dependency "));
  const store = new EventStore({ path: ":memory:" });
  try {
    store.migrate();
    await writePlugin(root, "sources", "shared-a", sourceManifest("duplicate.id"));
    await writePlugin(root, "sources", "shared-b", sourceManifest("duplicate.id"));
    await writePlugin(root, "sources", "target", sourceManifest("source.target"));
    await writePlugin(
      root,
      "consumers",
      "dependent",
      consumerManifest("consumer.dependent"),
      'import "../../sources/target/index.mjs";\nexport const value = 1;\n',
    );
    await writePlugin(root, "consumers", "independent", consumerManifest("consumer.independent"));
    await writePlugin(
      root,
      "consumers",
      "examples-only",
      consumerManifest("consumer.examples-only"),
      `// import "../../sources/target/index.mjs";
const documentation = 'require("../../sources/target/index.mjs")';
const pattern = /import "..\\/..\\/sources\\/target\\/index.mjs"/giu;
export { documentation, pattern };
`,
    );

    const result = await discoverAndSyncPlugins({
      projectRoot: root,
      store,
      now: T1,
    });

    assert.deepEqual(
      result.plugins.map(({ id }) => id),
      ["consumer.examples-only", "consumer.independent", "source.target"],
    );
    assert.equal(result.diagnostics.filter(({ code }) => code === "DUPLICATE_ID").length, 2);
    assert.equal(result.diagnostics.find(({ id }) => id === "consumer.dependent")?.code, "CROSS_PLUGIN_IMPORT");
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("diagnoses an invalid IANA time zone in a daily trigger", async () => {
  const root = await mkdtemp(join(tmpdir(), "event-hub timezone "));
  const store = new EventStore({ path: ":memory:" });
  try {
    store.migrate();
    const manifest = {
      ...consumerManifest("consumer.invalid-timezone"),
      trigger: { type: "daily", at: "09:00", timezone: "Not/A_Zone" },
    };
    await writePlugin(root, "consumers", "invalid-timezone", manifest);

    const result = await discoverAndSyncPlugins({
      projectRoot: root,
      store,
      now: T1,
    });

    assert.deepEqual(result.plugins, []);
    assert.equal(result.diagnostics[0]?.code, "MANIFEST_INVALID");
    assert.equal(result.diagnostics[0]?.id, "consumer.invalid-timezone");
    assert.match(result.diagnostics[0]?.message ?? "", /trigger/);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("validates provider-neutral OAuth 2.0 PKCE credential declarations", async () => {
  const root = await mkdtemp(join(tmpdir(), "event-hub oauth manifest "));
  const store = new EventStore({ path: join(root, ".event-hub", "state.sqlite") });
  try {
    store.migrate();
    await writePlugin(root, "sources", "valid", {
      ...sourceManifest("source.oauth"),
      env: {},
      credentials: {
        account: {
          type: "oauth2-pkce",
          authorizationEndpoint: "https://provider.example/authorize",
          tokenEndpoint: "https://provider.example/token",
          clientId: "CLIENT_ID",
          scopes: ["read", "offline.access"],
          env: "ACCESS_TOKEN",
        },
      },
    });
    await writePlugin(root, "sources", "invalid", {
      ...sourceManifest("source.invalid-oauth"),
      credentials: {
        account: {
          type: "oauth2-pkce",
          authorizationEndpoint: "http://provider.example/authorize",
          tokenEndpoint: "https://provider.example/token",
          clientId: "CLIENT_ID",
          scopes: ["read"],
          env: "GITHUB_TOKEN",
        },
      },
    });
    const result = await discoverAndSyncPlugins({ projectRoot: root, store });
    assert.deepEqual(
      result.plugins.map(({ id }) => id),
      ["source.oauth"],
    );
    assert.equal(result.diagnostics.find(({ id }) => id === "source.invalid-oauth")?.code, "MANIFEST_INVALID");
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects credentials that target the same plugin environment variable", async () => {
  const root = await mkdtemp(join(tmpdir(), "event-hub oauth env conflict "));
  const store = new EventStore({ path: join(root, ".event-hub", "state.sqlite") });
  const declaration = (host: string) => ({
    type: "oauth2-pkce",
    authorizationEndpoint: `https://${host}/authorize`,
    tokenEndpoint: `https://${host}/token`,
    clientId: "CLIENT_ID",
    scopes: ["read"],
    env: "ACCESS_TOKEN",
  });
  try {
    store.migrate();
    await writePlugin(root, "sources", "duplicate-env", {
      ...sourceManifest("source.duplicate-env"),
      credentials: {
        first: declaration("first.example"),
        second: declaration("second.example"),
      },
    });

    const result = await discoverAndSyncPlugins({ projectRoot: root, store });
    assert.deepEqual(result.plugins, []);
    assert.equal(result.diagnostics[0]?.code, "MANIFEST_INVALID");
    assert.equal(result.diagnostics[0]?.id, "source.duplicate-env");
    assert.match(result.diagnostics[0]?.message ?? "", /distinct plugin environment variables/);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects conflicting provider declarations for a shared credential ID", async () => {
  const root = await mkdtemp(join(tmpdir(), "event-hub oauth conflict "));
  const store = new EventStore({ path: join(root, ".event-hub", "state.sqlite") });
  const oauth = (host: string, env: string) => ({
    type: "oauth2-pkce",
    authorizationEndpoint: `https://${host}/authorize`,
    tokenEndpoint: `https://${host}/token`,
    clientId: "CLIENT_ID",
    scopes: ["read"],
    env,
  });
  try {
    store.migrate();
    await writePlugin(root, "sources", "conflict-a", {
      ...sourceManifest("source.conflict-a"),
      credentials: { shared: oauth("a.example", "ACCESS_TOKEN") },
    });
    await writePlugin(root, "sources", "conflict-b", {
      ...sourceManifest("source.conflict-b"),
      credentials: { shared: oauth("b.example", "ACCESS_TOKEN") },
    });
    await writePlugin(root, "sources", "reusable-a", {
      ...sourceManifest("source.reusable-a"),
      credentials: { reusable: oauth("same.example", "FIRST_TOKEN") },
    });
    await writePlugin(root, "consumers", "reusable-b", {
      ...consumerManifest("consumer.reusable-b"),
      credentials: { reusable: oauth("same.example", "SECOND_TOKEN") },
    });

    const result = await discoverAndSyncPlugins({ projectRoot: root, store });
    assert.deepEqual(
      result.plugins.map(({ id }) => id),
      ["consumer.reusable-b", "source.reusable-a"],
    );
    assert.deepEqual(
      result.diagnostics
        .filter(({ code }) => code === "CREDENTIAL_CONFLICT")
        .map(({ id }) => id)
        .sort(),
      ["source.conflict-a", "source.conflict-b"],
    );
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
