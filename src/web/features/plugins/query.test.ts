import { describe, expect, it } from "vitest";
import { ApiError, parseRetryAfter } from "../../api/client.ts";
import { dashboardQuery, retryDelay } from "./query.ts";

describe("dashboard query", () => {
  it("uses capped exponential retry delays", () => {
    expect([0, 1, 2, 3].map((attempt) => retryDelay(attempt))).toEqual([1000, 2000, 4000, 4000]);
  });

  it("prefers a longer Retry-After delay for delta-seconds and HTTP dates", () => {
    expect(retryDelay(0, new ApiError(503, parseRetryAfter("30")))).toBe(30_000);
    expect(parseRetryAfter("Thu, 25 Sep 2026 01:01:00 GMT", Date.parse("2026-09-25T01:00:30.000Z"))).toBe(30_000);
    expect(retryDelay(2, new ApiError(503, parseRetryAfter("1")))).toBe(4_000);
    expect(parseRetryAfter("invalid")).toBeNull();
  });

  it("polls every five seconds only in the foreground and refetches on visibility or reconnect", () => {
    expect(dashboardQuery.refetchInterval).toBe(5_000);
    expect(dashboardQuery.refetchIntervalInBackground).toBe(false);
    expect(dashboardQuery.refetchOnWindowFocus).toBe("always");
    expect(dashboardQuery.refetchOnReconnect).toBe("always");
  });
});
