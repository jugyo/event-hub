import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { run } from "../src/cli.ts";
import { initProject } from "../src/init.ts";
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
  assert.match(await page.text(), /The local Web UI server is running/u);

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
