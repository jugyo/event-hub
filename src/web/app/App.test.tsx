import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { delay, http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { App } from "./App.tsx";

const network = setupServer();

beforeAll(() => network.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  network.resetHandlers();
});
afterAll(() => network.close());

function renderApp() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <App />
    </QueryClientProvider>,
  );
}

const dashboard = {
  project: { name: "demo", version: "0.2.0", startedAt: "2026-09-25T00:00:00.000Z" },
  summary: { sources: 1, consumers: 0, unhealthy: 0, pendingWork: 2 },
  plugins: [
    {
      id: "github",
      kind: "source",
      loadState: "loaded",
      lastRun: null,
      pendingWork: 2,
      failure: null,
      diagnostics: [],
    },
  ],
  updatedAt: "2026-09-25T00:01:00.000Z",
} as const;

describe("dashboard", () => {
  it("shows summary, separate plugin tables, and empty state", async () => {
    network.use(http.get("*/api/v1/dashboard", () => HttpResponse.json(dashboard)));
    renderApp();
    expect(await screen.findByRole("heading", { name: "demo" })).toBeInTheDocument();
    expect(screen.getByRole("table", { name: "Sources の稼働状況" })).toBeInTheDocument();
    expect(screen.getByText("登録済みの Consumers はありません。")).toBeInTheDocument();
    expect(getComputedStyle(screen.getByRole("table", { name: "Sources の稼働状況" }).parentElement!).overflowX).toBe(
      "auto",
    );
  });

  it("wraps a long project name within a narrow header", async () => {
    const name = "event-hub-with-an-extremely-long-unbroken-project-name";
    network.use(
      http.get("*/api/v1/dashboard", () =>
        HttpResponse.json({ ...dashboard, project: { ...dashboard.project, name } }),
      ),
    );
    renderApp();
    const heading = await screen.findByRole("heading", { name });
    expect(getComputedStyle(heading).overflowWrap).toBe("anywhere");
  });

  it("distinguishes initial loading", () => {
    network.use(
      http.get("*/api/v1/dashboard", async () => {
        await delay("infinite");
        return HttpResponse.json(dashboard);
      }),
    );
    renderApp();
    expect(screen.getByRole("status", { name: "稼働状況を読み込み中" })).toBeInTheDocument();
  });

  it("polls while visible, pauses while hidden, and refetches immediately when visible again", async () => {
    vi.useFakeTimers();
    let requests = 0;
    let visibility: DocumentVisibilityState = "visible";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
    network.use(
      http.get("*/api/v1/dashboard", () => {
        requests += 1;
        return HttpResponse.json(dashboard);
      }),
    );
    renderApp();
    await act(async () => Promise.resolve());
    expect(requests).toBe(1);
    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    expect(requests).toBe(2);
    visibility = "hidden";
    await act(async () => document.dispatchEvent(new Event("visibilitychange", { bubbles: true })));
    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    expect(requests).toBe(2);
    visibility = "visible";
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange", { bubbles: true }));
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(requests).toBe(3);
  });

  it("keeps prior data during a background refresh and marks it stale after failure", async () => {
    let resolveFetch!: (response: Response) => void;
    network.use(http.get("*/api/v1/dashboard", () => new Promise<Response>((resolve) => (resolveFetch = resolve))));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(["dashboard"], dashboard);
    render(
      <QueryClientProvider client={client}>
        <App />
      </QueryClientProvider>,
    );
    expect(screen.getByRole("heading", { name: "demo" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("更新中");
    await waitFor(() => expect(resolveFetch).toBeTypeOf("function"));
    resolveFetch(HttpResponse.json({}, { status: 400 }));
    expect(await screen.findByText("更新に失敗しました。直近のデータを表示しています。")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "demo" })).toBeInTheDocument();
  });

  it("shows public failure and diagnostic codes with text labels", async () => {
    network.use(
      http.get("*/api/v1/dashboard", () =>
        HttpResponse.json({
          ...dashboard,
          summary: { ...dashboard.summary, unhealthy: 1 },
          plugins: [
            {
              ...dashboard.plugins[0],
              loadState: "invalid",
              failure: {
                code: "PLUGIN_EXECUTION_FAILED",
                message: "The plugin did not complete successfully",
                occurredAt: dashboard.updatedAt,
              },
              diagnostics: [
                {
                  code: "MANIFEST_INVALID",
                  message: "Plugin configuration is invalid",
                  occurredAt: dashboard.updatedAt,
                },
              ],
            },
          ],
        }),
      ),
    );
    renderApp();
    expect(await screen.findByText(/PLUGIN_EXECUTION_FAILED/u)).toBeInTheDocument();
    expect(screen.getByText(/MANIFEST_INVALID/u)).toBeInTheDocument();
    expect(screen.getByText("invalid")).toBeInTheDocument();
  });

  it("shows an error and supports keyboard retry", async () => {
    let requests = 0;
    network.use(
      http.get("*/api/v1/dashboard", () => {
        requests += 1;
        return HttpResponse.json({}, { status: 400 });
      }),
    );
    renderApp();
    expect(await screen.findByText("稼働状況を取得できませんでした。")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "再試行" }));
    expect(requests).toBe(2);
  });
});
