import type { Json } from "../storage/event-store.ts";

export type PluginKind = "source" | "consumer";
export type DurationString = `${number}${"ms" | "s" | "m" | "h" | "d" | "w"}`;

interface PluginManifestBase {
  id: string;
  entry: string;
  config: Json;
  env: Record<string, string>;
}

type PollInterval = { every: DurationString; everyMs?: never } | { every?: never; everyMs: number };

type PollBackfill = { backfill?: DurationString; backfillMs?: never } | { backfill?: never; backfillMs?: number };

export interface SourcePluginManifest extends PluginManifestBase {
  kind: "source";
  trigger: { type: "poll" } & PollInterval & PollBackfill;
}

export interface NormalizedSourcePluginManifest extends PluginManifestBase {
  kind: "source";
  trigger: { type: "poll"; everyMs: number; backfillMs?: number };
}

export interface ConsumerPluginManifest extends PluginManifestBase {
  kind: "consumer";
  trigger: { type: "events"; eventTypes: string[] } | { type: "daily"; at: string; timezone: string };
}

export type PluginManifest = SourcePluginManifest | ConsumerPluginManifest;
export type NormalizedPluginManifest = NormalizedSourcePluginManifest | ConsumerPluginManifest;
