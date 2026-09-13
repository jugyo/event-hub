import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { RuntimeApi, SqliteStore, WorkflowRegistry, silentLogger, type InvocationRecord, type Logger, type TickResult } from "@jugyo/duex";
import { discoverAndSyncPlugins, type PluginDiagnostic } from "./plugins/discovery.ts";
import type { SecretProvider } from "./plugins/process/executor.ts";
import { syncPluginSchedules } from "./scheduling.ts";
import { EventStore, type PluginRegistration } from "./storage/event-store.ts";
import { CONFIG_FILENAME } from "./init.ts";

interface ProjectConfig {
  paths?: { sources?: string; consumers?: string; data?: string };
  pluginManifest?: string;
}

export interface ProjectRuntime {
  projectRoot: string;
  eventStore: EventStore;
  runtime: RuntimeApi;
  plugins: PluginRegistration[];
  diagnostics: PluginDiagnostic[];
  close(): void;
}

export interface PluginStatus {
  id: string;
  kind: "source" | "consumer" | "invalid";
  state: "ready" | "failed" | "invalid";
  lastRunAt: string | null;
  lastInvocationId: string | null;
  pending: number;
  failure: string | null;
}

function pluginId(invocation: InvocationRecord): string | null {
  const input = invocation.input;
  return typeof input === "object" && input !== null && !Array.isArray(input)
    && typeof input.pluginId === "string" ? input.pluginId : null;
}

function listAllInvocations(runtime: RuntimeApi): InvocationRecord[] {
  const invocations: InvocationRecord[] = [];
  const limit = 1_000;
  for (let offset = 0; ; offset += limit) {
    const page = runtime.listInvocations({ limit, offset, order: "desc" });
    invocations.push(...page);
    if (page.length < limit) return invocations;
  }
}

async function loadProjectConfig(projectRoot: string): Promise<ProjectConfig> {
  const path = resolve(projectRoot, CONFIG_FILENAME);
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`${CONFIG_FILENAME} was not found. Run init in the project root`);
    }
    throw new Error(`Could not read ${CONFIG_FILENAME}: ${(error as Error).message}`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${CONFIG_FILENAME} must contain a JSON object`);
  }
  return value as ProjectConfig;
}

export async function openProjectRuntime(projectRoot: string, secrets: SecretProvider, logger: Logger = silentLogger): Promise<ProjectRuntime> {
  projectRoot = resolve(projectRoot);
  const config = await loadProjectConfig(projectRoot);
  const dataPath = resolve(projectRoot, config.paths?.data ?? ".event-hub");
  const eventStore = new EventStore({ path: resolve(dataPath, "events.sqlite") });
  eventStore.migrate();
  const runtime = new RuntimeApi({
    store: new SqliteStore({ path: resolve(dataPath, "runtime.sqlite") }),
    registry: new WorkflowRegistry(),
    logger,
  });
  runtime.init();
  try {
    const discovery = await discoverAndSyncPlugins({
      projectRoot,
      store: eventStore,
      sourcesPath: config.paths?.sources,
      consumersPath: config.paths?.consumers,
      manifestFilename: config.pluginManifest,
    });
    for (const plugin of discovery.plugins) logger.info("plugin.discovered", { pluginId: plugin.id, kind: plugin.kind });
    for (const item of discovery.diagnostics) logger.warn("plugin.invalid", { pluginId: item.id ?? null, code: item.code });
    const plugins = eventStore.listPluginRegistrations({ activeOnly: true });
    const schedules = syncPluginSchedules({ runtime, store: eventStore, secrets, plugins, logger });
    logger.info("plugin.schedules_synced", {
      plugins: plugins.length, created: schedules.created.length, updated: schedules.updated.length, disabled: schedules.disabled.length,
    });
    return {
      projectRoot, eventStore, runtime, plugins, diagnostics: discovery.diagnostics,
      close() { runtime.close(); eventStore.close(); },
    };
  } catch (error) {
    runtime.close();
    eventStore.close();
    throw error;
  }
}

export async function tickProject(projectRoot: string, secrets: SecretProvider, maxRuns?: number, logger: Logger = silentLogger): Promise<TickResult> {
  const project = await openProjectRuntime(projectRoot, secrets, logger);
  try { return await project.runtime.tick({ maxRuns }); }
  finally { project.close(); }
}

export async function projectStatus(projectRoot: string, secrets: SecretProvider): Promise<PluginStatus[]> {
  const project = await openProjectRuntime(projectRoot, secrets);
  try {
    const invocations = listAllInvocations(project.runtime);
    const statuses: PluginStatus[] = project.plugins.map((plugin) => {
      const own = invocations.filter((invocation) => pluginId(invocation) === plugin.id);
      const last = own.find((invocation) => ["completed", "failed", "retry_wait", "cancelled"].includes(invocation.status));
      const failed = last?.status === "failed" || last?.status === "retry_wait" ? last : undefined;
      return {
        id: plugin.id,
        kind: plugin.kind,
        state: failed ? "failed" : "ready",
        lastRunAt: last ? new Date(last.updatedAt).toISOString() : null,
        lastInvocationId: last?.id ?? null,
        pending: own.filter(({ status }) => ["pending", "running", "sleeping", "retry_wait"].includes(status)).length,
        failure: failed?.error?.message ?? null,
      };
    });
    for (const diagnostic of project.diagnostics) {
      statuses.push({
        id: diagnostic.id ?? diagnostic.path,
        kind: "invalid",
        state: "invalid",
        lastRunAt: null,
        lastInvocationId: null,
        pending: 0,
        failure: `${diagnostic.code}: ${diagnostic.message}`,
      });
    }
    return statuses;
  } finally { project.close(); }
}

export async function updateInvocation(projectRoot: string, secrets: SecretProvider, action: "retry" | "cancel", id: string): Promise<InvocationRecord> {
  const project = await openProjectRuntime(projectRoot, secrets);
  try {
    return action === "retry" ? project.runtime.retryInvocation(id) : project.runtime.cancelInvocation(id);
  } finally { project.close(); }
}
