import type { Json } from "../storage/event-store.ts";

export type PluginKind = "source" | "consumer";

interface PluginManifestBase {
  id: string;
  entry: string;
  config: Json;
  env: Record<string, string>;
  credentials?: Record<string, OAuth2PkceCredential>;
}

export interface OAuth2PkceCredential {
  type: "oauth2-pkce";
  authorizationEndpoint: string;
  tokenEndpoint: string;
  clientId: string;
  scopes: string[];
  env: string;
}

export interface SourcePluginManifest extends PluginManifestBase {
  kind: "source";
  trigger: { type: "poll"; everyMs: number; backfillMs?: number };
}

export interface ConsumerPluginManifest extends PluginManifestBase {
  kind: "consumer";
  trigger: { type: "events"; eventTypes: string[] } | { type: "daily"; at: string; timezone: string };
}

export type PluginManifest = SourcePluginManifest | ConsumerPluginManifest;
