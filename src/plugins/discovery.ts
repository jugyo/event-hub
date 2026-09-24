import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import ts from "typescript";

import type { EventStore, Json, PluginRegistrationInput } from "../storage/event-store.ts";
import type { OAuth2PkceCredential, PluginKind, PluginManifest } from "./manifest.ts";

export type PluginDiagnosticCode =
  | "MANIFEST_MISSING"
  | "MANIFEST_INVALID"
  | "KIND_MISMATCH"
  | "DUPLICATE_ID"
  | "CREDENTIAL_CONFLICT"
  | "ENTRYPOINT_MISSING"
  | "CROSS_PLUGIN_IMPORT";

export interface PluginDiagnostic {
  code: PluginDiagnosticCode;
  path: string;
  id?: string;
  message: string;
}

export interface PluginDiscoveryOptions {
  projectRoot: string;
  store: EventStore;
  now?: string;
  sourcesPath?: string;
  consumersPath?: string;
  manifestFilename?: string;
}

export interface PluginDiscoveryResult {
  plugins: PluginRegistrationInput[];
  diagnostics: PluginDiagnostic[];
}

interface Candidate {
  directory: string;
  expectedKind: PluginKind;
  manifest?: PluginManifest;
  entrypoint?: string;
}

const ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,127})$/;
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const CODE_EXTENSION_PATTERN = /\.(?:[cm]?[jt]s)$/;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJson(value: unknown): value is Json {
  if (value === null || ["boolean", "number", "string"].includes(typeof value)) return true;
  if (Array.isArray(value)) return value.every(isJson);
  return isObject(value) && Object.values(value).every(isJson);
}

function isValidTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value }).format(0);
    return true;
  } catch (error) {
    if (error instanceof RangeError) return false;
    throw error;
  }
}

function validateTrigger(kind: PluginKind, value: unknown): boolean {
  if (!isObject(value) || typeof value.type !== "string") return false;
  if (kind === "source") {
    return (
      value.type === "poll" &&
      Number.isFinite(value.everyMs) &&
      Number(value.everyMs) > 0 &&
      (value.backfillMs === undefined || (Number.isFinite(value.backfillMs) && Number(value.backfillMs) > 0))
    );
  }
  if (value.type === "events") {
    return (
      Array.isArray(value.eventTypes) &&
      value.eventTypes.length > 0 &&
      value.eventTypes.every((eventType) => typeof eventType === "string" && eventType.length > 0)
    );
  }
  return (
    value.type === "daily" &&
    typeof value.at === "string" &&
    /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value.at) &&
    typeof value.timezone === "string" &&
    isValidTimeZone(value.timezone)
  );
}

function isHttpsUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function validateCredentials(value: unknown): value is Record<string, OAuth2PkceCredential> {
  return (
    value === undefined ||
    (isObject(value) &&
      Object.entries(value).every(
        ([id, credential]) =>
          ID_PATTERN.test(id) &&
          isObject(credential) &&
          credential.type === "oauth2-pkce" &&
          isHttpsUrl(credential.authorizationEndpoint) &&
          isHttpsUrl(credential.tokenEndpoint) &&
          typeof credential.clientId === "string" &&
          ENV_NAME_PATTERN.test(credential.clientId) &&
          Array.isArray(credential.scopes) &&
          credential.scopes.length > 0 &&
          credential.scopes.every((scope) => typeof scope === "string" && scope.length > 0) &&
          typeof credential.env === "string" &&
          ENV_NAME_PATTERN.test(credential.env),
      ))
  );
}

function credentialIdentity(credential: OAuth2PkceCredential): string {
  return JSON.stringify({
    type: credential.type,
    authorizationEndpoint: credential.authorizationEndpoint,
    tokenEndpoint: credential.tokenEndpoint,
    clientId: credential.clientId,
    scopes: credential.scopes,
  });
}

function parseManifest(value: unknown): PluginManifest {
  if (!isObject(value)) throw new TypeError("The manifest must be a JSON object");
  if (typeof value.id !== "string" || !ID_PATTERN.test(value.id)) {
    throw new TypeError("id must be a stable ID of at most 128 characters starting with a lowercase letter or digit");
  }
  if (value.kind !== "source" && value.kind !== "consumer") {
    throw new TypeError("kind must be source or consumer");
  }
  if (typeof value.entry !== "string" || value.entry.length === 0 || isAbsolute(value.entry)) {
    throw new TypeError("entry must be a relative path within the plugin");
  }
  const normalizedEntry = resolve("/plugin", value.entry);
  if (normalizedEntry === "/plugin" || !normalizedEntry.startsWith("/plugin/")) {
    throw new TypeError("entry cannot reference a path outside the plugin");
  }
  if (!isJson(value.config)) throw new TypeError("config must be a JSON value");
  if (
    !isObject(value.env) ||
    !Object.entries(value.env).every(
      ([target, source]) =>
        ENV_NAME_PATTERN.test(target) && typeof source === "string" && ENV_NAME_PATTERN.test(source),
    )
  ) {
    throw new TypeError("env must map plugin environment variable names to host secret references");
  }
  if (!validateCredentials(value.credentials)) {
    throw new TypeError("credentials must contain valid OAuth 2.0 PKCE declarations");
  }
  const environment = value.env as Record<string, string>;
  const credentialEnvironments = Object.values(value.credentials ?? {}).map(({ env }) => env);
  if (new Set(credentialEnvironments).size !== credentialEnvironments.length) {
    throw new TypeError("credentials must use distinct plugin environment variables");
  }
  if (
    isObject(value.credentials) &&
    Object.values(value.credentials).some(
      (credential) =>
        isObject(credential) && typeof credential.env === "string" && Object.hasOwn(environment, credential.env),
    )
  ) {
    throw new TypeError("credential environment variables cannot also appear in env");
  }
  if (!validateTrigger(value.kind, value.trigger)) {
    throw new TypeError(`The trigger for ${value.kind} is invalid`);
  }
  return value as unknown as PluginManifest;
}

function diagnostic(code: PluginDiagnosticCode, path: string, message: string, id?: string): PluginDiagnostic {
  return { code, path, message, ...(id ? { id } : {}) };
}

async function pluginDirectories(root: string, expectedKind: PluginKind): Promise<Candidate[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({ directory: resolve(root, entry.name), expectedKind }));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function loadCandidate(
  candidate: Candidate,
  manifestFilename: string,
  diagnostics: PluginDiagnostic[],
): Promise<void> {
  const manifestPath = resolve(candidate.directory, manifestFilename);
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
    diagnostics.push(
      diagnostic(
        missing ? "MANIFEST_MISSING" : "MANIFEST_INVALID",
        manifestPath,
        missing ? "Manifest not found" : "Could not parse the manifest as JSON",
      ),
    );
    return;
  }
  try {
    candidate.manifest = parseManifest(raw);
  } catch (error) {
    const id = isObject(raw) && typeof raw.id === "string" ? raw.id : undefined;
    diagnostics.push(diagnostic("MANIFEST_INVALID", manifestPath, (error as Error).message, id));
    return;
  }
  if (candidate.manifest.kind !== candidate.expectedKind) {
    diagnostics.push(
      diagnostic(
        "KIND_MISMATCH",
        manifestPath,
        `A ${candidate.manifest.kind} manifest cannot be placed in a ${candidate.expectedKind} directory`,
        candidate.manifest.id,
      ),
    );
    candidate.manifest = undefined;
    return;
  }
  const entrypoint = resolve(candidate.directory, candidate.manifest.entry);
  try {
    const [directoryPath, entryPath, entryStat] = await Promise.all([
      realpath(candidate.directory),
      realpath(entrypoint),
      stat(entrypoint),
    ]);
    if (!entryPath.startsWith(`${directoryPath}${sep}`) || !entryStat.isFile()) throw new Error("outside");
    candidate.entrypoint = entryPath;
  } catch {
    diagnostics.push(
      diagnostic(
        "ENTRYPOINT_MISSING",
        entrypoint,
        "The entry point does not exist or points outside the plugin directory",
        candidate.manifest.id,
      ),
    );
    candidate.manifest = undefined;
  }
}

async function codeFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await codeFiles(path)));
    else if (entry.isFile() && CODE_EXTENSION_PATTERN.test(entry.name)) files.push(path);
  }
  return files;
}

function containsPath(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function moduleSpecifiers(file: string, source: string): string[] {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, false);
  const specifiers: string[] = [];
  function visit(node: ts.Node): void {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression &&
      ts.isStringLiteralLike(node.moduleReference.expression)
    ) {
      specifiers.push(node.moduleReference.expression.text);
    } else if (
      ts.isCallExpression(node) &&
      node.arguments.length >= 1 &&
      ts.isStringLiteralLike(node.arguments[0]) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (node.arguments.length === 1 && ts.isIdentifier(node.expression) && node.expression.text === "require"))
    ) {
      specifiers.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return specifiers;
}

async function crossPluginImport(candidate: Candidate, allDirectories: string[]): Promise<string | null> {
  for (const file of await codeFiles(candidate.directory)) {
    const source = await readFile(file, "utf8");
    for (const specifier of moduleSpecifiers(file, source)) {
      if (!specifier.startsWith(".") && !isAbsolute(specifier)) continue;
      const target = resolve(file, "..", specifier);
      const other = allDirectories.find(
        (directory) => directory !== candidate.directory && containsPath(directory, target),
      );
      if (other) return `${file}: ${specifier}`;
    }
  }
  return null;
}

export async function discoverPlugins(
  options: Omit<PluginDiscoveryOptions, "store" | "now">,
): Promise<PluginDiscoveryResult> {
  const projectRoot = resolve(options.projectRoot);
  const candidates = [
    ...(await pluginDirectories(resolve(projectRoot, options.sourcesPath ?? "sources"), "source")),
    ...(await pluginDirectories(resolve(projectRoot, options.consumersPath ?? "consumers"), "consumer")),
  ];
  const diagnostics: PluginDiagnostic[] = [];
  await Promise.all(
    candidates.map((candidate) => loadCandidate(candidate, options.manifestFilename ?? "plugin.json", diagnostics)),
  );

  const byId = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    if (!candidate.manifest) continue;
    const sameId = byId.get(candidate.manifest.id) ?? [];
    sameId.push(candidate);
    byId.set(candidate.manifest.id, sameId);
  }
  for (const [id, duplicates] of byId) {
    if (duplicates.length < 2) continue;
    for (const candidate of duplicates) {
      diagnostics.push(
        diagnostic("DUPLICATE_ID", candidate.directory, `Duplicate plugin ID ${JSON.stringify(id)}`, id),
      );
      candidate.manifest = undefined;
    }
  }

  const credentialDeclarations = new Map<string, { candidate: Candidate; identity: string }[]>();
  for (const candidate of candidates) {
    if (!candidate.manifest) continue;
    for (const [id, credential] of Object.entries(candidate.manifest.credentials ?? {})) {
      const declarations = credentialDeclarations.get(id) ?? [];
      declarations.push({ candidate, identity: credentialIdentity(credential) });
      credentialDeclarations.set(id, declarations);
    }
  }
  for (const [id, declarations] of credentialDeclarations) {
    if (new Set(declarations.map(({ identity }) => identity)).size < 2) continue;
    for (const { candidate } of declarations) {
      if (!candidate.manifest) continue;
      diagnostics.push(
        diagnostic(
          "CREDENTIAL_CONFLICT",
          candidate.directory,
          `OAuth credential ${JSON.stringify(id)} conflicts with another plugin declaration`,
          candidate.manifest.id,
        ),
      );
      candidate.manifest = undefined;
    }
  }

  const directories = candidates.map(({ directory }) => directory);
  for (const candidate of candidates) {
    if (!candidate.manifest) continue;
    const imported = await crossPluginImport(candidate, directories);
    if (imported) {
      diagnostics.push(
        diagnostic(
          "CROSS_PLUGIN_IMPORT",
          candidate.directory,
          `A static import references another plugin implementation (${imported})`,
          candidate.manifest.id,
        ),
      );
      candidate.manifest = undefined;
    }
  }

  const plugins = candidates.flatMap((candidate): PluginRegistrationInput[] =>
    candidate.manifest && candidate.entrypoint
      ? [
          {
            id: candidate.manifest.id,
            kind: candidate.manifest.kind,
            directory: candidate.directory,
            entrypoint: candidate.entrypoint,
            manifest: candidate.manifest as unknown as Json,
          },
        ]
      : [],
  );
  plugins.sort((left, right) => left.id.localeCompare(right.id));
  diagnostics.sort((left, right) => left.path.localeCompare(right.path) || left.code.localeCompare(right.code));
  return { plugins, diagnostics };
}

export async function discoverAndSyncPlugins(options: PluginDiscoveryOptions): Promise<PluginDiscoveryResult> {
  const result = await discoverPlugins(options);
  options.store.syncPluginRegistrations(result.plugins, options.now ?? new Date().toISOString());
  return result;
}
