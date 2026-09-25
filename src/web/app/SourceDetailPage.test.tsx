import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
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
  window.history.pushState({}, "", "/");
});
afterAll(() => network.close());

const plugin = {
  id: "github",
  kind: "source",
  loadState: "loaded",
  lastRun: {
    startedAt: "2026-09-24T23:59:00.000Z",
    finishedAt: "2026-09-25T00:00:00.000Z",
    status: "failed",
  },
  pendingWork: 3,
  pendingWorkBreakdown: { pending: 2, retry_wait: 1 },
  failure: {
    code: "PLUGIN_EXECUTION_FAILED",
    message: "The plugin did not complete successfully",
    occurredAt: "2026-09-25T00:00:00.000Z",
  },
  diagnostics: [{ code: "SOURCE_BACKFILL_LIMITED", message: "Plugin configuration is invalid", occurredAt: null }],
} as const;

const events = {
  events: [
    {
      id: "evt-b",
      sourceId: "github",
      externalId: "2",
      type: "github.change",
      schemaVersion: 1,
      occurredAt: "2026-09-24T12:00:00.000Z",
      observedAt: "2026-09-24T12:00:01.000Z",
      payload: {},
    },
    {
      id: "evt-a",
      sourceId: "github",
      externalId: "1",
      type: "github.change",
      schemaVersion: 1,
      occurredAt: "2026-09-24T11:00:00.000Z",
      observedAt: "2026-09-24T11:00:01.000Z",
      payload: {},
    },
  ],
  page: { nextCursor: null, limit: 20 },
} as const;

const dashboard = {
  project: { name: "demo", version: "0.3.0", startedAt: "2026-09-25T00:00:00.000Z" },
  summary: { sources: 1, consumers: 0, unhealthy: 1, pendingWork: 3 },
  plugins: [plugin],
  updatedAt: "2026-09-25T00:01:00.000Z",
} as const;

function renderAt(path: string) {
  window.history.pushState({}, "", path);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <App />
    </QueryClientProvider>,
  );
}

function servePlugin() {
  network.use(http.get("*/api/v1/plugins/github", () => HttpResponse.json({ plugin })));
}

describe("source detail", () => {
  it("shows load state, the last run, the pending breakdown, failures, diagnostics, and recent events", async () => {
    servePlugin();
    network.use(http.get("*/api/v1/events", () => HttpResponse.json(events)));
    renderAt("/sources/github");

    expect(await screen.findByRole("heading", { name: "github", level: 1 })).toBeInTheDocument();
    expect(await screen.findByText("loaded")).toBeInTheDocument();
    expect(screen.getByText("failed")).toBeInTheDocument();
    expect(screen.getByText("UTC: 2026-09-24T23:59:00.000Z")).toBeInTheDocument();
    expect(screen.getByText("UTC: 2026-09-25T00:00:00.000Z")).toBeInTheDocument();
    expect(screen.getByText(/pending 2 \/ retry_wait 1/u)).toBeInTheDocument();
    expect(screen.getByText(/PLUGIN_EXECUTION_FAILED/u)).toBeInTheDocument();
    expect(screen.getByText(/SOURCE_BACKFILL_LIMITED/u)).toBeInTheDocument();

    const table = await screen.findByRole("table", { name: "Recent events" });
    expect(
      within(table)
        .getAllByRole("row")
        .slice(1)
        .map((row) => row.cells[2].textContent),
    ).toEqual(["evt-b", "evt-a"]);
    expect(within(table).getAllByText("github.change", { selector: "td" })).toHaveLength(2);
  });

  it("requests only the selected source", async () => {
    servePlugin();
    const requested: string[] = [];
    network.use(
      http.get("*/api/v1/events", ({ request }) => {
        requested.push(new URL(request.url).search);
        return HttpResponse.json({ events: [], page: { nextCursor: null, limit: 20 } });
      }),
    );
    renderAt("/sources/github");
    expect(await screen.findByText("No events are stored for this source.")).toBeInTheDocument();
    expect(requested).toEqual(["?sourceId=github&limit=20"]);
  });

  it("navigates from the dashboard and supports the browser back button", async () => {
    network.use(
      http.get("*/api/v1/dashboard", () => HttpResponse.json(dashboard)),
      http.get("*/api/v1/events", () => HttpResponse.json(events)),
    );
    servePlugin();
    renderAt("/");

    await userEvent.click(await screen.findByRole("link", { name: "github" }));
    expect(await screen.findByRole("heading", { name: "github", level: 1 })).toBeInTheDocument();
    expect(window.location.pathname).toBe("/sources/github");

    act(() => window.history.back());
    expect(await screen.findByRole("heading", { name: "demo", level: 1 })).toBeInTheDocument();
    expect(window.location.pathname).toBe("/");
  });

  it("polls plugin details every five seconds, pauses while hidden, and never polls event history", async () => {
    vi.useFakeTimers();
    let plugins = 0;
    let eventRequests = 0;
    let visibility: DocumentVisibilityState = "visible";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
    network.use(
      http.get("*/api/v1/plugins/github", () => {
        plugins += 1;
        return HttpResponse.json({ plugin });
      }),
      http.get("*/api/v1/events", () => {
        eventRequests += 1;
        return HttpResponse.json(events);
      }),
    );
    renderAt("/sources/github");
    await act(async () => Promise.resolve());
    expect(plugins).toBe(1);
    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    expect(plugins).toBe(2);
    visibility = "hidden";
    await act(async () => document.dispatchEvent(new Event("visibilitychange", { bubbles: true })));
    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    expect(plugins).toBe(2);
    visibility = "visible";
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange", { bubbles: true }));
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(plugins).toBe(3);
    expect(eventRequests).toBe(1);
  });

  it("distinguishes initial loading of each region", () => {
    network.use(
      http.get("*/api/v1/plugins/github", async () => {
        await delay("infinite");
        return HttpResponse.json({ plugin });
      }),
      http.get("*/api/v1/events", async () => {
        await delay("infinite");
        return HttpResponse.json(events);
      }),
    );
    renderAt("/sources/github");
    expect(screen.getByRole("status", { name: "Loading source status" })).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Loading events" })).toBeInTheDocument();
  });

  it("shows fixed public messages with keyboard retry in each region", async () => {
    let plugins = 0;
    let eventRequests = 0;
    network.use(
      http.get("*/api/v1/plugins/github", () => {
        plugins += 1;
        return HttpResponse.json({}, { status: 404 });
      }),
      http.get("*/api/v1/events", () => {
        eventRequests += 1;
        return HttpResponse.json({}, { status: 400 });
      }),
    );
    renderAt("/sources/github");
    expect(await screen.findByText("Source status could not be loaded.")).toBeInTheDocument();
    expect(await screen.findByText("Events could not be loaded.")).toBeInTheDocument();
    await userEvent.tab();
    for (const button of screen.getAllByRole("button", { name: "Retry" })) {
      button.focus();
      await userEvent.keyboard("{Enter}");
    }
    await waitFor(() => expect(plugins).toBe(2));
    await waitFor(() => expect(eventRequests).toBe(2));
  });

  it("keeps the last successful data when a refresh fails", async () => {
    network.use(http.get("*/api/v1/events", () => HttpResponse.json(events)));
    let resolveFetch!: (response: Response) => void;
    network.use(
      http.get("*/api/v1/plugins/github", () => new Promise<Response>((resolve) => (resolveFetch = resolve))),
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(["plugin", "github"], plugin);
    window.history.pushState({}, "", "/sources/github");
    render(
      <QueryClientProvider client={client}>
        <App />
      </QueryClientProvider>,
    );
    expect(screen.getByText(/pending 2 \/ retry_wait 1/u)).toBeInTheDocument();
    await waitFor(() => expect(resolveFetch).toBeTypeOf("function"));
    resolveFetch(HttpResponse.json({}, { status: 400 }));
    expect(await screen.findByText("The update failed. Showing the most recent data.")).toBeInTheDocument();
    expect(screen.getByText(/pending 2 \/ retry_wait 1/u)).toBeInTheDocument();
  });
});
