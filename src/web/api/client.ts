export interface Notice {
  code: string;
  message: string;
  occurredAt: string | null;
}

export interface PluginDto {
  id: string;
  kind: "source" | "consumer";
  loadState: "loaded" | "invalid" | "missing" | "disabled";
  lastRun: null | {
    startedAt: string;
    finishedAt: string | null;
    status: "running" | "completed" | "failed";
  };
  pendingWork: number;
  failure: Notice | null;
  diagnostics: Notice[];
}

export interface PluginDetailDto extends PluginDto {
  pendingWorkBreakdown: { pending: number; retry_wait: number };
}

export interface EventDto {
  id: string;
  sourceId: string;
  externalId: string;
  type: string;
  schemaVersion: number;
  occurredAt: string;
  observedAt: string;
  payload: unknown;
}

export interface EventPageDto {
  events: EventDto[];
  page: { nextCursor: string | null; limit: number };
}

export interface DashboardDto {
  project: { name: string; version: string; startedAt: string };
  summary: { sources: number; consumers: number; unhealthy: number; pendingWork: number };
  plugins: PluginDto[];
  updatedAt: string;
}

export class ApiError extends Error {
  readonly status: number;
  readonly retryAfterMs: number | null;

  constructor(status: number, retryAfterMs: number | null = null) {
    super("Status information could not be loaded");
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

export function parseRetryAfter(value: string | null, now = Date.now()): number | null {
  if (value === null) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const date = Date.parse(value);
  if (Number.isNaN(date) || date <= now) return null;
  return date - now;
}

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { signal });
  if (!response.ok) throw new ApiError(response.status, parseRetryAfter(response.headers.get("retry-after")));
  return (await response.json()) as T;
}

export function getDashboard(signal?: AbortSignal): Promise<DashboardDto> {
  return getJson<DashboardDto>("/api/v1/dashboard", signal);
}

export async function getPlugin(pluginId: string, signal?: AbortSignal): Promise<PluginDetailDto> {
  const { plugin } = await getJson<{ plugin: PluginDetailDto }>(
    `/api/v1/plugins/${encodeURIComponent(pluginId)}`,
    signal,
  );
  return plugin;
}

export function getEvents(sourceId: string, limit: number, signal?: AbortSignal): Promise<EventPageDto> {
  const query = new URLSearchParams({ sourceId, limit: String(limit) });
  return getJson<EventPageDto>(`/api/v1/events?${query}`, signal);
}
