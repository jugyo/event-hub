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

export async function getDashboard(signal?: AbortSignal): Promise<DashboardDto> {
  const response = await fetch("/api/v1/dashboard", { signal });
  if (!response.ok) throw new ApiError(response.status, parseRetryAfter(response.headers.get("retry-after")));
  return (await response.json()) as DashboardDto;
}
