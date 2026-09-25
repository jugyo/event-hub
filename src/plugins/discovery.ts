import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import ts from "typescript";

import type { EventStore, Json, PluginRegistrationInput } from "../storage/event-store.ts";
import type { NormalizedPluginManifest, PluginKind } from "./manifest.ts";

export type PluginDiagnosticCode =
  | "MANIFEST_MISSING"
  | "MANIFEST_INVALID"
  | "KIND_MISMATCH"
  | "DUPLICATE_ID"
  | "ENTRYPOINT_MISSING"
  | "CROSS_PLUGIN_IMPORT";

export interface PluginDiagnostic {
  code: PluginDiagnosticCode;
  path: string;
  kind: PluginKind;
  id?: string;
  message: string;
}

export interface PluginDiscoveryOptions {
  projectRoot: string;
  sourcesPath?: string;
  consumersPath?: string;
  manifestFilename?: string;
}

export interface PluginSyncOptions extends PluginDiscoveryOptions {
  store: EventStore;
  now?: string;
}

export interface PluginDiscoveryResult {
  plugins: PluginRegistrationInput[];
  diagnostics: PluginDiagnostic[];
}

interface Candidate {
  directory: string;
  expectedKind: PluginKind;
  manifest?: NormalizedPluginManifest;
  entrypoint?: string;
}

const ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,127})$/;
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const CODE_EXTENSION_PATTERN = /\.(?:[cm]?[jt]s)$/;
const DURATION_PATTERN = /^(\d+(?:\.\d+)?)(ms|s|m|h|d|w)$/;
const DURATION_UNIT_MS = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 60 * 60_000,
  d: 24 * 60 * 60_000,
  w: 7 * 24 * 60 * 60_000,
} as const;

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

function validMilliseconds(value: number, label: string): number {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 1) {
    throw new TypeError(`${label} must resolve to a positive whole number of milliseconds`);
  }
  return value;
}

function durationMs(value: unknown, label: string): number {
  if (typeof value !== "string") throw new TypeError(`${label} must be a duration string`);
  const match = DURATION_PATTERN.exec(value);
  if (!match) throw new TypeError(`${label} must be a positive duration such as "5m" or "1d"`);
  const unit = match[2] as keyof typeof DURATION_UNIT_MS;
  const duration = Number(match[1]) * DURATION_UNIT_MS[unit];
  return validMilliseconds(duration, label);
}

function positiveMilliseconds(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive finite number`);
  }
  return value;
}

function normalizeTrigger(kind: PluginKind, value: unknown): NormalizedPluginManifest["trigger"] {
  if (!isObject(value) || typeof value.type !== "string") {
    throw new TypeError(`The trigger for ${kind} is invalid`);
  }
  if (kind === "source") {
    if (value.type !== "poll") throw new TypeError("The trigger for source is invalid");
    if (value.every !== undefined && value.everyMs !== undefined) {
      throw new TypeError("trigger.every and trigger.everyMs cannot be specified together");
    }
    if (value.backfill !== undefined && value.backfillMs !== undefined) {
      throw new TypeError("trigger.backfill and trigger.backfillMs cannot be specified together");
    }
    const everyMs =
      value.every !== undefined
        ? durationMs(value.every, "trigger.every")
        : positiveMilliseconds(value.everyMs, "trigger.everyMs");
    const backfillMs =
      value.backfill !== undefined
        ? durationMs(value.backfill, "trigger.backfill")
        : value.backfillMs !== undefined
          ? positiveMilliseconds(value.backfillMs, "trigger.backfillMs")
          : undefined;
    return { type: "poll", everyMs, ...(backfillMs === undefined ? {} : { backfillMs }) };
  }
  if (value.type === "events") {
    if (
      Array.isArray(value.eventTypes) &&
      value.eventTypes.length > 0 &&
      value.eventTypes.every((eventType) => typeof eventType === "string" && eventType.length > 0)
    ) {
      return { type: "events", eventTypes: value.eventTypes };
    }
    throw new TypeError("The trigger for consumer is invalid");
  }
  if (
    value.type === "daily" &&
    typeof value.at === "string" &&
    /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value.at) &&
    typeof value.timezone === "string" &&
    isValidTimeZone(value.timezone)
  ) {
    return { type: "daily", at: value.at, timezone: value.timezone };
  }
  throw new TypeError("The trigger for consumer is invalid");
}

function parseManifest(value: unknown): NormalizedPluginManifest {
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
  const trigger = normalizeTrigger(value.kind, value.trigger);
  return { ...value, trigger } as NormalizedPluginManifest;
}

function diagnostic(
  code: PluginDiagnosticCode,
  path: string,
  kind: PluginKind,
  message: string,
  id?: string,
): PluginDiagnostic {
  return { code, path, kind, message, ...(id ? { id } : {}) };
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
        candidate.expectedKind,
        missing ? "Manifest not found" : "Could not parse the manifest as JSON",
      ),
    );
    return;
  }
  try {
    candidate.manifest = parseManifest(raw);
  } catch (error) {
    const id = isObject(raw) && typeof raw.id === "string" ? raw.id : undefined;
    diagnostics.push(
      diagnostic("MANIFEST_INVALID", manifestPath, candidate.expectedKind, (error as Error).message, id),
    );
    return;
  }
  if (candidate.manifest.kind !== candidate.expectedKind) {
    diagnostics.push(
      diagnostic(
        "KIND_MISMATCH",
        manifestPath,
        candidate.expectedKind,
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
        candidate.expectedKind,
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

export async function discoverPlugins(options: PluginDiscoveryOptions): Promise<PluginDiscoveryResult> {
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
        diagnostic(
          "DUPLICATE_ID",
          candidate.directory,
          candidate.expectedKind,
          `Duplicate plugin ID ${JSON.stringify(id)}`,
          id,
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
          candidate.expectedKind,
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

export async function discoverAndSyncPlugins(options: PluginSyncOptions): Promise<PluginDiscoveryResult> {
  const result = await discoverPlugins(options);
  options.store.syncPluginRegistrations(result.plugins, options.now ?? new Date().toISOString());
  return result;
}
