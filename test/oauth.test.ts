import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  findOAuthCredential,
  OAuthCredentialError,
  OAuthCredentialService,
  resolvePluginEnvironment,
} from "../src/index.ts";
import { SecretBackendError, type SecretBackend } from "../src/secrets/backend.ts";
import type { OAuth2PkceCredential } from "../src/plugins/manifest.ts";
import type { OAuthCredentialBundle } from "../src/oauth.ts";
import { run } from "../src/cli.ts";

class MemoryBackend implements SecretBackend {
  values = new Map<string, string>();
  async create(name: string, value: string) {
    if (this.values.has(name)) throw new SecretBackendError("ALREADY_EXISTS");
    this.values.set(name, value);
  }
  async update(name: string, value: string) {
    if (!this.values.has(name)) throw new SecretBackendError("NOT_FOUND");
    this.values.set(name, value);
  }
  async get(name: string) {
    const value = this.values.get(name);
    if (value === undefined) throw new SecretBackendError("NOT_FOUND");
    return value;
  }
  async delete(name: string) {
    if (!this.values.delete(name)) throw new SecretBackendError("NOT_FOUND");
  }
}

const credential: OAuth2PkceCredential = {
  type: "oauth2-pkce",
  authorizationEndpoint: "https://provider.example/authorize",
  tokenEndpoint: "https://provider.example/token",
  clientId: "CLIENT_ID",
  scopes: ["read", "offline.access"],
  env: "ACCESS_TOKEN",
};

test("PKCE login opens authorization and stores a credential bundle", async () => {
  const backend = new MemoryBackend();
  let opened = "";
  let requestBody = "";
  const service = new OAuthCredentialService({
    backend,
    secrets: { get: async () => "public-client" },
    receiveAuthorization: async (redirect, state) => {
      redirect.port = "43123";
      assert.ok(state.length >= 32);
      return "authorization-code";
    },
    openBrowser: async (url) => {
      opened = url;
    },
    fetch: async (_url, init) => {
      requestBody = String(init?.body);
      return new Response(
        JSON.stringify({
          access_token: "access-secret",
          refresh_token: "refresh-secret",
          expires_in: 3600,
          scope: "read offline.access",
        }),
        { status: 200 },
      );
    },
    now: () => new Date("2026-09-24T00:00:00.000Z"),
  });
  await service.login("x-user", credential);
  const authorization = new URL(opened);
  assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");
  assert.equal(authorization.searchParams.get("redirect_uri"), "http://127.0.0.1:43123/callback");
  assert.ok(requestBody.includes("code_verifier="));
  const stored = JSON.parse(await backend.get("oauth:x-user")) as OAuthCredentialBundle;
  assert.equal(stored.accessToken, "access-secret");
  assert.equal(stored.refreshToken, "refresh-secret");
  assert.equal(opened.includes("access-secret"), false);
});

test("expired credentials refresh once concurrently and save refresh token rotation", async () => {
  const backend = new MemoryBackend();
  await backend.create(
    "oauth:x-user",
    JSON.stringify({
      accessToken: "old-access",
      refreshToken: "old-refresh",
      tokenType: "Bearer",
      expiresAt: "2026-09-23T23:59:00.000Z",
      scope: ["read"],
    }),
  );
  let requests = 0;
  const service = new OAuthCredentialService({
    backend,
    secrets: { get: async () => "public-client" },
    fetch: async () => {
      requests += 1;
      await new Promise((resolve) => setImmediate(resolve));
      return new Response(
        JSON.stringify({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 }),
        { status: 200 },
      );
    },
    now: () => new Date("2026-09-24T00:00:00.000Z"),
  });
  assert.deepEqual(
    await Promise.all([service.accessToken("x-user", credential), service.accessToken("x-user", credential)]),
    ["new-access", "new-access"],
  );
  assert.equal(requests, 1);
  const stored = JSON.parse(await backend.get("oauth:x-user")) as OAuthCredentialBundle;
  assert.equal(stored.refreshToken, "new-refresh");
});

test("missing credentials require explicit interactive login", async () => {
  const backend = new MemoryBackend();
  const service = new OAuthCredentialService({ backend, secrets: { get: async () => "client" } });
  await assert.rejects(
    service.accessToken("x-user", credential),
    (error: unknown) => error instanceof OAuthCredentialError && error.code === "OAUTH_REAUTHORIZATION_REQUIRED",
  );
  assert.equal(await service.status("x-user"), "missing");
});

test("invalid_grant is persisted as a reauthorization-required status", async () => {
  const backend = new MemoryBackend();
  await backend.create(
    "oauth:x-user",
    JSON.stringify({
      accessToken: "old",
      refreshToken: "invalid",
      tokenType: "Bearer",
      expiresAt: "2026-09-23T23:59:00.000Z",
      scope: ["read"],
    }),
  );
  const service = new OAuthCredentialService({
    backend,
    secrets: { get: async () => "client" },
    fetch: async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }),
    now: () => new Date("2026-09-24T00:00:00.000Z"),
  });
  await assert.rejects(
    service.accessToken("x-user", credential),
    (error: unknown) => error instanceof OAuthCredentialError && error.code === "OAUTH_REAUTHORIZATION_REQUIRED",
  );
  assert.equal(await service.status("x-user"), "reauthorization_required");
});

test("plugin environment receives only explicitly mapped values", async () => {
  const environment: NodeJS.ProcessEnv = await resolvePluginEnvironment(
    { ORDINARY_TOKEN: "ORDINARY_REF" },
    {
      get: async () => "ordinary-secret",
      getOAuthAccessToken: async () => "oauth-access-secret",
    },
    { "x-user": credential },
  );
  assert.equal(environment.PATH, undefined);
  assert.equal(environment.HOME, undefined);
  assert.deepEqual(environment, { ORDINARY_TOKEN: "ordinary-secret", ACCESS_TOKEN: "oauth-access-secret" });
});

test("auth CLI isolates invalid manifests and uses only validated credentials", async () => {
  const root = await mkdtemp(join(tmpdir(), "event-hub oauth cli "));
  const backend = new MemoryBackend();
  const output: string[] = [];
  try {
    await mkdir(join(root, "sources", "oauth"), { recursive: true });
    await mkdir(join(root, "sources", "broken"));
    await mkdir(join(root, "sources", "insecure"));
    await writeFile(join(root, "event-hub.json"), "{}\n");
    await writeFile(
      join(root, "sources", "oauth", "plugin.json"),
      `${JSON.stringify({
        id: "oauth-source",
        kind: "source",
        entry: "index.mjs",
        config: null,
        env: {},
        credentials: { "x-user": credential },
        trigger: { type: "poll", everyMs: 60_000 },
      })}\n`,
    );
    await writeFile(join(root, "sources", "oauth", "index.mjs"), "export const execute = () => null;\n");
    await writeFile(join(root, "sources", "broken", "plugin.json"), "{ not-json\n");
    await writeFile(
      join(root, "sources", "insecure", "plugin.json"),
      `${JSON.stringify({
        id: "insecure-source",
        kind: "source",
        entry: "index.mjs",
        config: null,
        env: {},
        credentials: {
          insecure: { ...credential, authorizationEndpoint: "http://provider.example/authorize" },
        },
        trigger: { type: "poll", everyMs: 60_000 },
      })}\n`,
    );
    await writeFile(join(root, "sources", "insecure", "index.mjs"), "export const execute = () => null;\n");
    await backend.create(
      "oauth:x-user",
      JSON.stringify({
        accessToken: "must-not-print",
        refreshToken: "also-hidden",
        tokenType: "Bearer",
        expiresAt: "2026-09-25T00:00:00.000Z",
        scope: ["read"],
      }),
    );
    const dependencies = {
      projectRoot: root,
      backend,
      readSecret: async () => "",
      out: (message: string) => output.push(message),
      error: (message: string) => output.push(message),
    };
    assert.equal(await run(["auth", "status", "x-user", "--json"], dependencies), 0);
    assert.equal(await run(["auth", "logout", "x-user"], dependencies), 0);
    assert.equal(await findOAuthCredential(root, "insecure"), null);
    assert.deepEqual(output, [
      JSON.stringify({ id: "x-user", status: "available" }),
      "OAuth credential deleted: x-user",
    ]);
    assert.equal(output.join("\n").includes("must-not-print"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
