import { ApiError } from "../api/client.ts";

export function retryDelay(attempt: number, error?: Error): number {
  const exponential = Math.min(1_000 * 2 ** attempt, 4_000);
  return error instanceof ApiError && error.retryAfterMs !== null
    ? Math.max(exponential, error.retryAfterMs)
    : exponential;
}

export function retry(count: number, error: Error): boolean {
  return count < 3 && (!(error instanceof ApiError) || [500, 502, 503, 504].includes(error.status));
}

/** Server state that must stay current: poll in the foreground only and refetch as soon as it is visible again. */
export const polled = {
  refetchInterval: 5_000,
  refetchIntervalInBackground: false,
  refetchOnReconnect: "always",
  refetchOnWindowFocus: "always",
  retry,
  retryDelay,
} as const;

/** Server state the user browses: never fetched on a timer, so the user's position stays stable. */
export const manual = {
  refetchInterval: false,
  refetchOnReconnect: false,
  refetchOnWindowFocus: false,
  staleTime: Infinity,
  retry,
  retryDelay,
} as const;
