import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  RuntimeApi,
  SqliteStore,
  WorkflowRegistry,
  silentLogger,
  type InvocationRecord,
  type Logger,
  type TickResult,
} from "@jugyo/duex";
import { discoverAndSyncPlugins, discoverPlugins, type PluginDiagnostic } from "./plugins/discovery.ts";
import type { SecretProvider } from "./plugins/process/executor.ts";
import type { NormalizedPluginManifest } from "./plugins/manifest.ts";
import { enqueueConsumerDeliveries, syncPluginSchedules } from "./scheduling.ts";
import { EventStore, type Json, type PluginRegistration } from "./storage/event-store.ts";
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

/** Pending work split into the two states the Web UI reports separately. */
export interface PendingBreakdown {
  pending: number;
  retryWait: number;
}

export interface PluginStatus {
  id: string;
  kind: "source" | "consumer" | "invalid";
  state: "ready" | "failed" | "invalid";
  lastRunAt: string | null;
  lastRunStartedAt: string | null;
  lastRunFinishedAt: string | null;
  lastInvocationId: string | null;
  pending: number;
  pendingBreakdown: PendingBreakdown;
  failure: string | null;
  lastRunStatus: "running" | "completed" | "failed" | null;
  diagnostics: Array<{ code: string; message: string; occurredAt: string }>;
  displayKind: "source" | "consumer";
  loadState: "loaded" | "invalid" | "missing" | "disabled";
}

function pluginId(invocation: InvocationRecord): string | null {
  const input = invocation.input;
  return typeof input === "object" && input !== null && !Array.isArray(input) && typeof input.pluginId === "string"
    ? input.pluginId
    : null;
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

export async function openProjectRuntime(
  projectRoot: string,
  secrets: SecretProvider,
  logger: Logger = silentLogger,
): Promise<ProjectRuntime> {
  projectRoot = resolve(projectRoot);
  const config = await loadProjectConfig(projectRoot);
  const dataPath = resolve(projectRoot, config.paths?.data ?? ".event-hub");
  const eventStore = new EventStore({
    path: resolve(dataPath, "events.sqlite"),
  });
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
    for (const plugin of discovery.plugins)
      logger.info("plugin.discovered", {
        pluginId: plugin.id,
        kind: plugin.kind,
      });
    for (const item of discovery.diagnostics)
      logger.warn("plugin.invalid", {
        pluginId: item.id ?? null,
        code: item.code,
      });
    const plugins = eventStore.listPluginRegistrations({ activeOnly: true });
    const schedules = syncPluginSchedules({
      runtime,
      store: eventStore,
      secrets,
      plugins,
      logger,
    });
    logger.info("plugin.schedules_synced", {
      plugins: plugins.length,
      created: schedules.created.length,
      updated: schedules.updated.length,
      disabled: schedules.disabled.length,
    });
    return {
      projectRoot,
      eventStore,
      runtime,
      plugins,
      diagnostics: discovery.diagnostics,
      close() {
        runtime.close();
        eventStore.close();
      },
    };
  } catch (error) {
    runtime.close();
    eventStore.close();
    throw error;
  }
}

export async function tickProject(
  projectRoot: string,
  secrets: SecretProvider,
  maxRuns?: number,
  logger: Logger = silentLogger,
): Promise<TickResult> {
  const project = await openProjectRuntime(projectRoot, secrets, logger);
  try {
    await enqueueConsumerDeliveries({
      runtime: project.runtime,
      store: project.eventStore,
      plugins: project.plugins,
      logger,
    });
    return await project.runtime.tick({ maxRuns });
  } finally {
    project.close();
  }
}

export async function projectStatus(projectRoot: string, secrets: SecretProvider): Promise<PluginStatus[]> {
  const project = await openProjectRuntime(projectRoot, secrets);
  try {
    const invocations = listAllInvocations(project.runtime);
    const statuses: PluginStatus[] = project.plugins.map((plugin) => {
      const own = invocations.filter((invocation) => pluginId(invocation) === plugin.id);
      const last = own.find((invocation) =>
        ["running", "completed", "failed", "retry_wait", "cancelled"].includes(invocation.status),
      );
      const failed = last?.status === "failed" || last?.status === "retry_wait" ? last : undefined;
      const manifest = plugin.manifest as unknown as NormalizedPluginManifest;
      // An event consumer runs one invocation per delivery attempt, so its backlog and failures live in
      // delivery state; a later successful delivery must not hide an earlier failed one.
      const events = manifest.kind === "consumer" && manifest.trigger.type === "events";
      const failedDelivery = events ? project.eventStore.getLatestFailedDelivery(plugin.id) : null;
      const deliveries = events ? project.eventStore.listPendingDeliveries(plugin.id) : [];
      const breakdown = pendingWork(plugin.kind, events, own, {
        pending: deliveries.filter(({ status }) => status === "pending").length,
        retryWait: deliveries.filter(({ status }) => status === "retry_wait").length,
      });
      return {
        id: plugin.id,
        kind: plugin.kind,
        state: (events ? failedDelivery : failed) ? "failed" : "ready",
        lastRunAt: last ? new Date(last.updatedAt).toISOString() : null,
        lastRunStartedAt: last ? new Date(last.createdAt).toISOString() : null,
        lastRunFinishedAt: last && last.status !== "running" ? new Date(last.updatedAt).toISOString() : null,
        lastInvocationId: last?.id ?? null,
        pending: totalPending(breakdown),
        pendingBreakdown: breakdown,
        failure: events
          ? failedDelivery && `event ${failedDelivery.event.id} ${failedDelivery.status}: ${failedDelivery.errorCode}`
          : (failed?.error?.message ?? null),
        lastRunStatus:
          last?.status === "completed" ? "completed" : last ? (last.status === "running" ? "running" : "failed") : null,
        diagnostics: [],
        displayKind: plugin.kind,
        loadState: "loaded",
      };
    });
    for (const diagnostic of project.diagnostics) {
      statuses.push({
        id: diagnostic.id ?? diagnostic.path,
        kind: "invalid",
        state: "invalid",
        lastRunAt: null,
        lastRunStartedAt: null,
        lastRunFinishedAt: null,
        lastInvocationId: null,
        pending: 0,
        pendingBreakdown: { pending: 0, retryWait: 0 },
        failure: `${diagnostic.code}: ${diagnostic.message}`,
        lastRunStatus: null,
        diagnostics: [
          { code: diagnostic.code, message: "Plugin configuration is invalid", occurredAt: new Date().toISOString() },
        ],
        displayKind: diagnostic.kind,
        loadState: "invalid",
      });
    }
    return statuses;
  } finally {
    project.close();
  }
}

type ReadonlyInvocation = {
  status: string;
  input: unknown;
  updatedAt: number;
  createdAt: number;
};

type ReadonlyRegistration = {
  id: string;
  kind: "source" | "consumer";
  directory: string;
  manifest: NormalizedPluginManifest;
  active: boolean;
};

function readonlyInvocations(path: string): ReadonlyInvocation[] {
  if (!existsSync(path)) return [];
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const rows = database
      .prepare("SELECT status, input_json, created_at, updated_at FROM invocations ORDER BY created_at DESC, id DESC")
      .all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      status: String(row.status),
      input: JSON.parse(String(row.input_json)) as unknown,
      updatedAt: Number(row.updated_at),
      createdAt: Number(row.created_at),
    }));
  } finally {
    database.close();
  }
}

function readonlyDeliveryState(path: string, consumerId: string): PendingBreakdown & { failed: boolean } {
  if (!existsSync(path)) return { pending: 0, retryWait: 0, failed: false };
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const counts = database
      .prepare(
        `SELECT status, COUNT(*) AS count FROM consumer_deliveries
         WHERE consumer_id = ? AND status IN ('pending', 'retry_wait') GROUP BY status`,
      )
      .all(consumerId) as Array<Record<string, unknown>>;
    const count = (status: string): number => Number(counts.find((row) => String(row.status) === status)?.count ?? 0);
    const failed = database
      .prepare("SELECT 1 FROM consumer_deliveries WHERE consumer_id = ? AND status IN ('failed', 'retry_wait') LIMIT 1")
      .get(consumerId);
    return { pending: count("pending"), retryWait: count("retry_wait"), failed: failed !== undefined };
  } finally {
    database.close();
  }
}

function readonlyRegistrations(path: string): ReadonlyRegistration[] {
  if (!existsSync(path)) return [];
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const rows = database.prepare("SELECT * FROM plugin_registrations ORDER BY kind, plugin_id").all() as Array<
      Record<string, unknown>
    >;
    return rows.map((row) => ({
      id: String(row.plugin_id),
      kind: String(row.kind) as "source" | "consumer",
      directory: String(row.directory),
      manifest: JSON.parse(String(row.manifest_json)) as NormalizedPluginManifest,
      active: Number(row.active) === 1,
    }));
  } finally {
    database.close();
  }
}

function invocationPluginId(invocation: ReadonlyInvocation): string | null {
  const input = invocation.input;
  return typeof input === "object" &&
    input !== null &&
    !Array.isArray(input) &&
    "pluginId" in input &&
    typeof input.pluginId === "string"
    ? input.pluginId
    : null;
}

function pendingWork(
  kind: "source" | "consumer",
  eventConsumer: boolean,
  invocations: ReadonlyInvocation[],
  deliveries: PendingBreakdown,
): PendingBreakdown {
  if (eventConsumer) return deliveries;
  const states = kind === "consumer" ? ["pending"] : ["pending", "running", "sleeping"];
  return {
    pending: invocations.filter(({ status }) => states.includes(status)).length,
    retryWait: invocations.filter(({ status }) => status === "retry_wait").length,
  };
}

function totalPending(breakdown: PendingBreakdown): number {
  return breakdown.pending + breakdown.retryWait;
}

/** Reads dashboard state without migrations, registration sync, schedule sync, or any other persistent write. */
export async function readProjectStatus(projectRoot: string): Promise<PluginStatus[]> {
  projectRoot = resolve(projectRoot);
  const config = await loadProjectConfig(projectRoot);
  const dataPath = resolve(projectRoot, config.paths?.data ?? ".event-hub");
  const discovery = await discoverPlugins({
    projectRoot,
    sourcesPath: config.paths?.sources,
    consumersPath: config.paths?.consumers,
    manifestFilename: config.pluginManifest,
  });
  const invocations = readonlyInvocations(resolve(dataPath, "runtime.sqlite"));
  const registrations = readonlyRegistrations(resolve(dataPath, "events.sqlite"));
  const represented = new Set<string>();
  const statuses: PluginStatus[] = discovery.plugins.map((plugin) => {
    represented.add(plugin.id);
    const own = invocations.filter((invocation) => invocationPluginId(invocation) === plugin.id);
    const last = own.find(({ status }) =>
      ["running", "completed", "failed", "retry_wait", "cancelled"].includes(status),
    );
    const manifest = plugin.manifest as unknown as NormalizedPluginManifest;
    const events = manifest.kind === "consumer" && manifest.trigger.type === "events";
    const deliveries = events
      ? readonlyDeliveryState(resolve(dataPath, "events.sqlite"), plugin.id)
      : { pending: 0, retryWait: 0, failed: false };
    const failed = deliveries.failed || last?.status === "failed" || last?.status === "retry_wait";
    const breakdown = pendingWork(plugin.kind, events, own, deliveries);
    return {
      id: plugin.id,
      kind: plugin.kind,
      displayKind: plugin.kind,
      loadState: "loaded",
      state: failed ? "failed" : "ready",
      lastRunAt: last ? new Date(last.updatedAt).toISOString() : null,
      lastRunStartedAt: last ? new Date(last.createdAt).toISOString() : null,
      lastRunFinishedAt: last && last.status !== "running" ? new Date(last.updatedAt).toISOString() : null,
      lastInvocationId: null,
      pending: totalPending(breakdown),
      pendingBreakdown: breakdown,
      failure: failed ? "Plugin execution failed" : null,
      lastRunStatus:
        last?.status === "completed" ? "completed" : last ? (last.status === "running" ? "running" : "failed") : null,
      diagnostics: [],
    };
  });
  const invalidCounts = { source: 0, consumer: 0 };
  for (const diagnostic of discovery.diagnostics) {
    const prior = registrations.find((registration) => diagnostic.path.startsWith(`${registration.directory}${sep}`));
    if (prior) represented.add(prior.id);
    invalidCounts[diagnostic.kind] += 1;
    statuses.push({
      id: prior?.id ?? `invalid-${diagnostic.kind}-${invalidCounts[diagnostic.kind]}`,
      kind: "invalid",
      displayKind: diagnostic.kind,
      loadState: "invalid",
      state: "invalid",
      lastRunAt: null,
      lastRunStartedAt: null,
      lastRunFinishedAt: null,
      lastInvocationId: null,
      pending: 0,
      pendingBreakdown: { pending: 0, retryWait: 0 },
      failure: null,
      lastRunStatus: null,
      diagnostics: [
        { code: diagnostic.code, message: "Plugin configuration is invalid", occurredAt: new Date().toISOString() },
      ],
    });
  }
  for (const registration of registrations) {
    if (represented.has(registration.id)) continue;
    const own = invocations.filter((invocation) => invocationPluginId(invocation) === registration.id);
    const last = own.find(({ status }) =>
      ["running", "completed", "failed", "retry_wait", "cancelled"].includes(status),
    );
    const eventConsumer = registration.kind === "consumer" && registration.manifest.trigger.type === "events";
    const deliveries = eventConsumer
      ? readonlyDeliveryState(resolve(dataPath, "events.sqlite"), registration.id)
      : { pending: 0, retryWait: 0, failed: false };
    const breakdown = pendingWork(registration.kind, eventConsumer, own, deliveries);
    statuses.push({
      id: registration.id,
      kind: registration.kind,
      displayKind: registration.kind,
      loadState: registration.active ? "missing" : "disabled",
      state: "failed",
      lastRunAt: last ? new Date(last.updatedAt).toISOString() : null,
      lastRunStartedAt: last ? new Date(last.createdAt).toISOString() : null,
      lastRunFinishedAt: last && last.status !== "running" ? new Date(last.updatedAt).toISOString() : null,
      lastInvocationId: null,
      pending: totalPending(breakdown),
      pendingBreakdown: breakdown,
      failure: null,
      lastRunStatus:
        last?.status === "completed" ? "completed" : last ? (last.status === "running" ? "running" : "failed") : null,
      diagnostics: [],
    });
  }
  return statuses;
}

export interface ProjectEvent {
  id: string;
  sourceId: string;
  externalId: string;
  type: string;
  schemaVersion: number;
  occurredAt: string;
  observedAt: string;
  payload: Json;
}

export interface ProjectEventQuery {
  sourceId: string;
  limit: number;
}

/**
 * Reads stored event history for one source without migrations or any other persistent write, so a Web UI
 * GET never creates or upgrades the event store. The column list is the public projection: nothing outside it
 * reaches a response. Retention is unlimited here; the 24-hour source backfill default does not apply.
 */
export async function readProjectEvents(projectRoot: string, query: ProjectEventQuery): Promise<ProjectEvent[]> {
  projectRoot = resolve(projectRoot);
  const config = await loadProjectConfig(projectRoot);
  const path = resolve(projectRoot, config.paths?.data ?? ".event-hub", "events.sqlite");
  if (!existsSync(path)) return [];
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const rows = database
      .prepare(
        `SELECT id, source_id, external_id, type, schema_version, occurred_at, observed_at, payload_json
         FROM events WHERE source_id = ? ORDER BY occurred_at DESC, id DESC LIMIT ?`,
      )
      .all(query.sourceId, query.limit) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      sourceId: String(row.source_id),
      externalId: String(row.external_id),
      type: String(row.type),
      schemaVersion: Number(row.schema_version),
      occurredAt: String(row.occurred_at),
      observedAt: String(row.observed_at),
      payload: JSON.parse(String(row.payload_json)) as Json,
    }));
  } finally {
    database.close();
  }
}

export async function updateInvocation(
  projectRoot: string,
  secrets: SecretProvider,
  action: "retry" | "cancel",
  id: string,
): Promise<InvocationRecord> {
  const project = await openProjectRuntime(projectRoot, secrets);
  try {
    return action === "retry" ? project.runtime.retryInvocation(id) : project.runtime.cancelInvocation(id);
  } finally {
    project.close();
  }
}
