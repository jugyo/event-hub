import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { getDashboard } from "./client.ts";

const network = setupServer();

beforeAll(() => network.listen({ onUnhandledRequest: "error" }));
afterEach(() => network.resetHandlers());
afterAll(() => network.close());

describe("dashboard API client", () => {
  it("keeps Retry-After from an unsuccessful response", async () => {
    network.use(
      http.get("*/api/v1/dashboard", () => HttpResponse.json({}, { status: 503, headers: { "retry-after": "30" } })),
    );

    await expect(getDashboard()).rejects.toMatchObject({ status: 503, retryAfterMs: 30_000 });
  });
});
