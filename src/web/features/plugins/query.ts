import { queryOptions } from "@tanstack/react-query";
import { ApiError, getDashboard } from "../../api/client.ts";

export function retryDelay(attempt: number, error?: Error): number {
  const exponential = Math.min(1_000 * 2 ** attempt, 4_000);
  return error instanceof ApiError && error.retryAfterMs !== null
    ? Math.max(exponential, error.retryAfterMs)
    : exponential;
}

export const dashboardQuery = queryOptions({
  queryKey: ["dashboard"],
  queryFn: ({ signal }) => getDashboard(signal),
  refetchInterval: 5_000,
  refetchIntervalInBackground: false,
  refetchOnReconnect: "always",
  refetchOnWindowFocus: "always",
  retry: (count, error) => count < 3 && (!(error instanceof ApiError) || [500, 502, 503, 504].includes(error.status)),
  retryDelay,
});
