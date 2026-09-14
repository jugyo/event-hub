import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { run } from "../src/cli.ts";
import { initProject } from "../src/init.ts";
import {
  KeychainSecretBackend,
  resolvePluginEnvironment,
  SecretBackendError,
  SecretConfigurationError,
  SecretService,
  type SecretBackend,
} from "../src/index.ts";

test("Keychain add and update do not pass secret values through arguments or output", async () => {
  const sentinel = "secret-only-on-stdin";
  const calls: Array<{ path: string; args: string[]; input?: string }> = [];
  let exists = false;
  const backend = new KeychainSecretBackend({
    projectRoot: "/example/project",
    runCommand: async (path, args, input) => {
      calls.push({ path, args, input });
      if (args[0] === "find-generic-password") return { code: exists ? 0 : 44, stdout: exists ? "stored\n" : "" };
      if (path !== "/usr/bin/clang") exists = true;
      return { code: 0, stdout: `untrusted command output: ${sentinel}` };
    },
  });

  await backend.create("WORK_TOKEN", sentinel);
  await backend.update("WORK_TOKEN", sentinel);

  const writes = calls.filter(({ path }) => path.endsWith("/write-keychain"));
  assert.equal(writes.length, 2);
  assert.deepEqual(
    writes.map(({ input }) => input),
    [sentinel, sentinel],
  );
  for (const { args } of calls) assert.doesNotMatch(JSON.stringify(args), new RegExp(sentinel));
});

test("Keychain helper failures produce a fixed error without secret values", async () => {
  const sentinel = "secret-from-failed-write";
  const backend = new KeychainSecretBackend({
    projectRoot: "/example/project",
    runCommand: async (path, args) => {
      if (args[0] === "find-generic-password") return { code: 44, stdout: "" };
      if (path === "/usr/bin/clang") return { code: 0, stdout: "" };
      return { code: 1, stdout: sentinel };
    },
  });

  await assert.rejects(
    backend.create("WORK_TOKEN", sentinel),
    (error: unknown) =>
      error instanceof SecretBackendError && error.code === "UNAVAILABLE" && !String(error).includes(sentinel),
  );
});

class FakeSecretBackend implements SecretBackend {
  readonly values = new Map<string, string>();
  unavailable = false;

  async create(name: string, value: string): Promise<void> {
    if (this.values.has(name)) throw new SecretBackendError("ALREADY_EXISTS");
    this.values.set(name, value);
  }
  async update(name: string, value: string): Promise<void> {
    if (!this.values.has(name)) throw new SecretBackendError("NOT_FOUND");
    this.values.set(name, value);
  }
  async get(name: string): Promise<string> {
    if (this.unavailable) throw new SecretBackendError("UNAVAILABLE");
    const value = this.values.get(name);
    if (value === undefined) throw new SecretBackendError("NOT_FOUND");
    return value;
  }
  async delete(name: string): Promise<void> {
    if (this.unavailable) throw new SecretBackendError("UNAVAILABLE");
    if (!this.values.delete(name)) throw new SecretBackendError("NOT_FOUND");
  }
}

async function project(t: { after(fn: () => Promise<void>): void }): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "event-hub-secrets-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initProject(root);
  return root;
}

test("creates, updates, lists, and deletes secrets with a fake backend", async (t) => {
  const root = await project(t);
  const backend = new FakeSecretBackend();
  const service = new SecretService(root, backend);

  await service.create("WORK_TOKEN", "first");
  assert.deepEqual(await service.list(), ["WORK_TOKEN"]);
  assert.equal(await service.get("WORK_TOKEN"), "first");

  await service.update("WORK_TOKEN", "second");
  assert.equal(await service.get("WORK_TOKEN"), "second");

  await service.delete("WORK_TOKEN");
  assert.deepEqual(await service.list(), []);
  await assert.rejects(service.get("WORK_TOKEN"), SecretConfigurationError);
});

test("retrying delete repairs the catalog after config persistence fails following backend deletion", async (t) => {
  const root = await project(t);
  const backend = new FakeSecretBackend();
  const service = new SecretService(root, backend);
  await service.create("WORK_TOKEN", "temporary-value");

  let failWrite = true;
  const retryable = new SecretService(root, backend, async (path, config) => {
    if (failWrite) {
      failWrite = false;
      throw new Error("simulated config write failure");
    }
    await writeFile(path, `${JSON.stringify(config, null, 2)}\n`);
  });

  await assert.rejects(retryable.delete("WORK_TOKEN"), /simulated config write failure/);
  assert.equal(backend.values.has("WORK_TOKEN"), false);
  assert.deepEqual(await service.list(), ["WORK_TOKEN"]);

  await retryable.delete("WORK_TOKEN");
  assert.deepEqual(await service.list(), []);
});

test("retains the catalog and value when the backend is unavailable during deletion", async (t) => {
  const root = await project(t);
  const backend = new FakeSecretBackend();
  const service = new SecretService(root, backend);
  await service.create("WORK_TOKEN", "temporary-value");
  backend.unavailable = true;

  await assert.rejects(
    service.delete("WORK_TOKEN"),
    (error: unknown) => error instanceof SecretBackendError && error.code === "UNAVAILABLE",
  );
  assert.deepEqual(await service.list(), ["WORK_TOKEN"]);
  assert.equal(backend.values.get("WORK_TOKEN"), "temporary-value");
});

test("uses a fixed error for unavailable backends without blocking another backend", async (t) => {
  const root = await project(t);
  const unavailable = new FakeSecretBackend();
  const healthy = new FakeSecretBackend();
  await new SecretService(root, unavailable).create("TOKEN", "hidden");
  healthy.values.set("TOKEN", "available");
  unavailable.unavailable = true;

  await assert.rejects(
    new SecretService(root, unavailable).get("TOKEN"),
    (error: unknown) => error instanceof SecretBackendError && error.code === "UNAVAILABLE",
  );
  assert.equal(await new SecretService(root, healthy).get("TOKEN"), "available");
});

test("resolves only reference names explicitly mapped by the manifest", async (t) => {
  const root = await project(t);
  const backend = new FakeSecretBackend();
  const service = new SecretService(root, backend);
  await service.create("WORK_TOKEN", "mapped-value");
  backend.values.set("UNDECLARED", "must-not-leak");

  assert.deepEqual(await resolvePluginEnvironment({ GITHUB_TOKEN: "WORK_TOKEN" }, service), {
    GITHUB_TOKEN: "mapped-value",
  });
});

test("CLI does not expose secret values in output, configuration, manifests, or plist files", async (t) => {
  const root = await project(t);
  const backend = new FakeSecretBackend();
  const sentinel = "sentinel-must-never-be-persisted-or-printed";
  const output: string[] = [];
  const errors: string[] = [];
  await writeFile(join(root, "plugin.json"), `${JSON.stringify({ env: { TOKEN: "WORK_TOKEN" } })}\n`);
  await writeFile(join(root, "job.plist"), "<plist><dict/></plist>\n");

  const result = await run(["secret", "add", "WORK_TOKEN"], {
    projectRoot: root,
    backend,
    readSecret: async () => sentinel,
    out: (message) => output.push(message),
    error: (message) => errors.push(message),
  });

  assert.equal(result, 0);
  assert.deepEqual(errors, []);
  assert.doesNotMatch(JSON.stringify(output), new RegExp(sentinel));
  for (const file of ["event-hub.json", "plugin.json", "job.plist"]) {
    assert.doesNotMatch(await readFile(join(root, file), "utf8"), new RegExp(sentinel));
  }
  assert.deepEqual(JSON.parse(await readFile(join(root, "event-hub.json"), "utf8")).secrets, {
    WORK_TOKEN: { backend: "keychain" },
  });
});

test("CLI does not accept secret values in arguments", async (t) => {
  const root = await project(t);
  const backend = new FakeSecretBackend();
  let read = false;
  const errors: string[] = [];
  const result = await run(["secret", "add", "TOKEN", "argv-secret"], {
    projectRoot: root,
    backend,
    readSecret: async () => {
      read = true;
      return "unused";
    },
    out: () => {},
    error: (message) => errors.push(message),
  });
  assert.equal(result, 2);
  assert.equal(read, false);
  assert.equal(backend.values.size, 0);
  assert.ok(errors.some((message) => message.startsWith("Usage:")));
});
