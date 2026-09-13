import { nextDailySlot, type RuntimeApi, type ScheduleRecord } from "@jugyo/duex";
import type { PluginRegistration } from "./storage/event-store.ts";
import type { PluginManifest } from "./plugins/manifest.ts";
import { createPluginWorkflows, DAILY_CONSUMER_WORKFLOW, SOURCE_POLL_WORKFLOW, type PluginWorkflowOptions } from "./workflows.ts";

export { DAILY_CONSUMER_WORKFLOW, SOURCE_POLL_WORKFLOW } from "./workflows.ts";

export interface SyncPluginSchedulesOptions extends PluginWorkflowOptions {
  runtime: RuntimeApi;
  plugins: PluginRegistration[];
  sourceWorkflow?: string;
  dailyConsumerWorkflow?: string;
}

export interface SyncPluginSchedulesResult {
  created: string[];
  updated: string[];
  disabled: string[];
}

function scheduleId(kind: "source" | "consumer", pluginId: string): string {
  return `plugin:${kind}:${pluginId}`;
}

function sameInput(schedule: ScheduleRecord, pluginId: string): boolean {
  return JSON.stringify(schedule.input) === JSON.stringify({ pluginId });
}

/** Synchronizes active polling/daily plugins without creating a second scheduler. */
export function syncPluginSchedules(options: SyncPluginSchedulesOptions): SyncPluginSchedulesResult {
  const sourceWorkflow = options.sourceWorkflow ?? SOURCE_POLL_WORKFLOW;
  const consumerWorkflow = options.dailyConsumerWorkflow ?? DAILY_CONSUMER_WORKFLOW;
  const managedPrefixes = ["plugin:source:", "plugin:consumer:"];
  const expected = new Set<string>();
  const result: SyncPluginSchedulesResult = { created: [], updated: [], disabled: [] };
  const now = options.runtime.health().now;
  for (const workflow of createPluginWorkflows(options)) {
    if (!options.runtime.registry.has(workflow.name)) options.runtime.registry.register(workflow);
  }

  for (const plugin of options.plugins.filter(({ active }) => active)) {
    const manifest = plugin.manifest as unknown as PluginManifest;
    if (manifest.kind === "consumer" && manifest.trigger.type !== "daily") continue;
    const id = scheduleId(manifest.kind, plugin.id);
    expected.add(id);
    const existing = options.runtime.store.getSchedule(id);
    const input = { pluginId: plugin.id };

    if (manifest.kind === "source") {
      const everyMs = manifest.trigger.everyMs;
      if (!existing) {
        options.runtime.createSchedule({ id, workflow: sourceWorkflow, input, every: everyMs, catchUp: "latest" });
        result.created.push(id);
      } else if (existing.scheduleType !== "interval" || existing.everyMs !== everyMs
        || existing.workflowName !== sourceWorkflow || !sameInput(existing, plugin.id) || !existing.enabled) {
        options.runtime.store.updateSchedule(id, {
          workflowName: sourceWorkflow, input, everyMs, scheduleType: "interval", dailyAt: null, timezone: null,
          nextRunAt: existing.everyMs === everyMs && existing.scheduleType === "interval" ? existing.nextRunAt : now + everyMs,
          catchUp: "latest", enabled: true, updatedAt: now,
        });
        result.updated.push(id);
      }
      continue;
    }

    if (manifest.trigger.type !== "daily") continue;
    const { at, timezone } = manifest.trigger;
    if (!existing) {
      options.runtime.createDailySchedule({ id, workflow: consumerWorkflow, input, dailyAt: at, timezone, catchUp: "latest" });
      result.created.push(id);
    } else if (existing.scheduleType !== "daily" || existing.dailyAt !== at || existing.timezone !== timezone
      || existing.workflowName !== consumerWorkflow || !sameInput(existing, plugin.id) || !existing.enabled) {
      const sameCalendar = existing.scheduleType === "daily" && existing.dailyAt === at && existing.timezone === timezone;
      options.runtime.store.updateSchedule(id, {
        workflowName: consumerWorkflow, input, scheduleType: "daily", dailyAt: at, timezone,
        nextRunAt: sameCalendar ? existing.nextRunAt : nextDailySlot(now, at, timezone),
        catchUp: "latest", enabled: true, updatedAt: now,
      });
      result.updated.push(id);
    }
  }

  for (const schedule of options.runtime.listSchedules()) {
    const managed = managedPrefixes.some((prefix) => schedule.id.startsWith(prefix));
    if (managed && schedule.enabled && !expected.has(schedule.id)) {
      options.runtime.setScheduleEnabled(schedule.id, false);
      result.disabled.push(schedule.id);
    }
  }
  return result;
}
