import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";

import type { OAuth2PkceCredential } from "./plugins/manifest.ts";
import { discoverPlugins } from "./plugins/discovery.ts";
import { SecretBackendError, type SecretBackend } from "./secrets/backend.ts";
interface SecretProvider {
  get(name: string): Promise<string | undefined> | string | undefined;
}

export interface OAuthCredentialBundle {
  accessToken: string;
  refreshToken: string | null;
  tokenType: string;
  expiresAt: string;
  scope: string[];
  reauthorizationRequired?: boolean;
}

export type OAuthCredentialStatus = "available" | "missing" | "reauthorization_required";

export class OAuthCredentialError extends Error {
  readonly code: "OAUTH_REAUTHORIZATION_REQUIRED" | "OAUTH_REQUEST_FAILED" | "OAUTH_CALLBACK_FAILED";
  constructor(code: OAuthCredentialError["code"]) {
    const messages = {
      OAUTH_REAUTHORIZATION_REQUIRED: "OAuth credential requires interactive login",
      OAUTH_REQUEST_FAILED: "OAuth provider request failed",
      OAUTH_CALLBACK_FAILED: "OAuth authorization callback failed",
    };
    super(messages[code]);
    this.name = "OAuthCredentialError";
    this.code = code;
  }
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  token_type?: string;
  expires_in: number;
  scope?: string;
  error?: string;
}

export interface OAuthCredentialServiceOptions {
  backend: SecretBackend;
  secrets: SecretProvider;
  fetch?: typeof fetch;
  now?: () => Date;
  openBrowser?: (url: string) => Promise<void>;
  receiveAuthorization?: (url: URL, state: string, timeoutMs: number) => Promise<string>;
  refreshLeewayMs?: number;
}

const accountName = (id: string): string => `oauth:${id}`;

function encodeBase64Url(value: Buffer): string {
  return value.toString("base64url");
}

function parseBundle(raw: string): OAuthCredentialBundle {
  try {
    const value = JSON.parse(raw) as Partial<OAuthCredentialBundle>;
    if (
      typeof value.accessToken !== "string" ||
      !(typeof value.refreshToken === "string" || value.refreshToken === null) ||
      typeof value.tokenType !== "string" ||
      typeof value.expiresAt !== "string" ||
      !Array.isArray(value.scope) ||
      value.scope.some((scope) => typeof scope !== "string") ||
      (value.reauthorizationRequired !== undefined && typeof value.reauthorizationRequired !== "boolean")
    )
      throw new Error();
    return value as OAuthCredentialBundle;
  } catch {
    throw new OAuthCredentialError("OAUTH_REAUTHORIZATION_REQUIRED");
  }
}

async function defaultOpenBrowser(url: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("/usr/bin/open", [url], { env: {}, stdio: "ignore" });
    child.once("error", reject);
    child.once("close", (code) => (code === 0 ? resolve() : reject(new Error("browser failed"))));
  });
}

async function defaultReceiveAuthorization(url: URL, expectedState: string, timeoutMs: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const server = createServer((request, response) => {
      const callback = new URL(request.url ?? "/", url);
      const state = callback.searchParams.get("state") ?? "";
      const expected = Buffer.from(expectedState);
      const received = Buffer.from(state);
      const validState = expected.length === received.length && timingSafeEqual(expected, received);
      const code = callback.searchParams.get("code");
      if (callback.pathname !== "/callback" || !validState || !code) {
        response.writeHead(400, { "content-type": "text/plain; charset=utf-8" }).end("Authorization failed");
        return;
      }
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8" }).end("Authorization complete");
      clearTimeout(timer);
      server.close(() => resolve(code));
    });
    const timer = setTimeout(
      () => server.close(() => reject(new OAuthCredentialError("OAUTH_CALLBACK_FAILED"))),
      timeoutMs,
    );
    server.once("error", () => reject(new OAuthCredentialError("OAUTH_CALLBACK_FAILED")));
    server.listen(0, "127.0.0.1", () => {
      url.port = String((server.address() as AddressInfo).port);
    });
  });
}

export class OAuthCredentialService {
  readonly #options: OAuthCredentialServiceOptions;
  readonly #refreshes = new Map<string, Promise<string>>();
  constructor(options: OAuthCredentialServiceOptions) {
    this.#options = options;
  }

  async #read(id: string): Promise<OAuthCredentialBundle | null> {
    try {
      return parseBundle(await this.#options.backend.get(accountName(id)));
    } catch (error) {
      if (error instanceof SecretBackendError && error.code === "NOT_FOUND") return null;
      throw error;
    }
  }

  async #save(id: string, bundle: OAuthCredentialBundle): Promise<void> {
    const value = JSON.stringify(bundle);
    try {
      await this.#options.backend.update(accountName(id), value);
    } catch (error) {
      if (!(error instanceof SecretBackendError) || error.code !== "NOT_FOUND") throw error;
      await this.#options.backend.create(accountName(id), value);
    }
  }

  async status(id: string): Promise<OAuthCredentialStatus> {
    const bundle = await this.#read(id);
    if (!bundle) return "missing";
    if (
      bundle.reauthorizationRequired ||
      (Date.parse(bundle.expiresAt) <= (this.#options.now ?? (() => new Date()))().getTime() && !bundle.refreshToken)
    )
      return "reauthorization_required";
    return "available";
  }

  async logout(id: string): Promise<void> {
    try {
      await this.#options.backend.delete(accountName(id));
    } catch (error) {
      if (!(error instanceof SecretBackendError) || error.code !== "NOT_FOUND") throw error;
    }
  }

  async #tokenRequest(config: OAuth2PkceCredential, body: URLSearchParams): Promise<TokenResponse> {
    let response: Response;
    try {
      response = await (this.#options.fetch ?? fetch)(config.tokenEndpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
      });
    } catch {
      throw new OAuthCredentialError("OAUTH_REQUEST_FAILED");
    }
    const value = (await response.json().catch(() => null)) as TokenResponse | null;
    if (!response.ok || !value || typeof value.access_token !== "string" || !Number.isFinite(value.expires_in)) {
      if (value?.error === "invalid_grant") throw new OAuthCredentialError("OAUTH_REAUTHORIZATION_REQUIRED");
      throw new OAuthCredentialError("OAUTH_REQUEST_FAILED");
    }
    return value;
  }

  #bundle(token: TokenResponse, previous?: OAuthCredentialBundle): OAuthCredentialBundle {
    const now = (this.#options.now ?? (() => new Date()))().getTime();
    return {
      accessToken: token.access_token,
      refreshToken: token.refresh_token ?? previous?.refreshToken ?? null,
      tokenType: token.token_type ?? "Bearer",
      expiresAt: new Date(now + token.expires_in * 1000).toISOString(),
      scope: token.scope ? token.scope.split(/\s+/).filter(Boolean) : (previous?.scope ?? []),
    };
  }

  async login(id: string, config: OAuth2PkceCredential, timeoutMs = 120_000): Promise<void> {
    const verifier = encodeBase64Url(randomBytes(32));
    const challenge = encodeBase64Url(createHash("sha256").update(verifier).digest());
    const state = encodeBase64Url(randomBytes(24));
    const redirect = new URL("http://127.0.0.1/callback");
    const receive = this.#options.receiveAuthorization ?? defaultReceiveAuthorization;
    const pending = receive(redirect, state, timeoutMs);
    await new Promise((resolve) => setImmediate(resolve));
    const authorization = new URL(config.authorizationEndpoint);
    authorization.search = new URLSearchParams({
      response_type: "code",
      client_id: (await this.#options.secrets.get(config.clientId)) ?? "",
      redirect_uri: redirect.toString(),
      scope: config.scopes.join(" "),
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
    }).toString();
    await (this.#options.openBrowser ?? defaultOpenBrowser)(authorization.toString());
    const code = await pending;
    const clientId = await this.#options.secrets.get(config.clientId);
    if (!clientId) throw new OAuthCredentialError("OAUTH_REQUEST_FAILED");
    const token = await this.#tokenRequest(
      config,
      new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirect.toString(),
        client_id: clientId,
        code_verifier: verifier,
      }),
    );
    await this.#save(
      id,
      this.#bundle(token, {
        accessToken: "",
        refreshToken: null,
        tokenType: "Bearer",
        expiresAt: "",
        scope: config.scopes,
      }),
    );
  }

  async accessToken(id: string, config: OAuth2PkceCredential): Promise<string> {
    const existing = this.#refreshes.get(id);
    if (existing) return existing;
    const operation = this.#accessToken(id, config).finally(() => this.#refreshes.delete(id));
    this.#refreshes.set(id, operation);
    return operation;
  }

  async #accessToken(id: string, config: OAuth2PkceCredential): Promise<string> {
    const bundle = await this.#read(id);
    if (!bundle) throw new OAuthCredentialError("OAUTH_REAUTHORIZATION_REQUIRED");
    const now = (this.#options.now ?? (() => new Date()))().getTime();
    if (Date.parse(bundle.expiresAt) - now > (this.#options.refreshLeewayMs ?? 60_000)) return bundle.accessToken;
    if (!bundle.refreshToken) throw new OAuthCredentialError("OAUTH_REAUTHORIZATION_REQUIRED");
    const clientId = await this.#options.secrets.get(config.clientId);
    if (!clientId) throw new OAuthCredentialError("OAUTH_REQUEST_FAILED");
    let token: TokenResponse;
    try {
      token = await this.#tokenRequest(
        config,
        new URLSearchParams({ grant_type: "refresh_token", refresh_token: bundle.refreshToken, client_id: clientId }),
      );
    } catch (error) {
      if (error instanceof OAuthCredentialError && error.code === "OAUTH_REAUTHORIZATION_REQUIRED") {
        await this.#save(id, { ...bundle, reauthorizationRequired: true });
      }
      throw error;
    }
    const updated = this.#bundle(token, bundle);
    await this.#save(id, updated);
    return updated.accessToken;
  }
}

export async function findOAuthCredential(projectRoot: string, id: string): Promise<OAuth2PkceCredential | null> {
  let project: { paths?: { sources?: string; consumers?: string }; pluginManifest?: string };
  try {
    project = JSON.parse(await readFile(resolve(projectRoot, "event-hub.json"), "utf8")) as typeof project;
  } catch {
    throw new Error("Could not read event-hub.json");
  }
  let found: OAuth2PkceCredential | null = null;
  const discovery = await discoverPlugins({
    projectRoot,
    sourcesPath: project.paths?.sources,
    consumersPath: project.paths?.consumers,
    manifestFilename: project.pluginManifest,
  });
  for (const plugin of discovery.plugins) {
    const manifest = plugin.manifest as unknown as { credentials?: Record<string, OAuth2PkceCredential> };
    const credential = manifest.credentials?.[id];
    if (!credential) continue;
    found ??= credential;
  }
  return found;
}
