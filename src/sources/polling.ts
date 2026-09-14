import type { Logger } from "@jugyo/duex";
import type { EventInput, EventStore, Json, SourcePollWindow } from "../storage/event-store.ts";

export const DEFAULT_SOURCE_BACKFILL_MS = 24 * 60 * 60 * 1000;

export interface SourcePollInput {
  cursor: Json | null;
  from: string;
  to: string;
  config: Json;
}

export interface SourcePollPage {
  events: EventInput[];
  nextCursor: Json | null;
  hasMore: boolean;
}

export interface SourceBackfillLimitedDiagnostic {
  code: "SOURCE_BACKFILL_LIMITED";
  sourceId: string;
  missedFrom: string;
  resumedFrom: string;
  message: string;
}

export interface PollSourceOptions {
  sourceId: string;
  store: EventStore;
  config: Json;
  poll(input: SourcePollInput): Promise<SourcePollPage> | SourcePollPage;
  backfillMs?: number;
  now?: () => Date;
  logger?: Logger;
}

export interface PollSourceResult {
  window: SourcePollWindow;
  pages: number;
  insertedEvents: number;
  diagnostic: SourceBackfillLimitedDiagnostic | null;
}

function timestamp(value: Date, label: string): string {
  if (Number.isNaN(value.getTime())) throw new TypeError(`${label} must be a valid date and time`);
  return value.toISOString();
}

function backfill(value: number | undefined): number {
  const duration = value ?? DEFAULT_SOURCE_BACKFILL_MS;
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new RangeError("backfillMs must be a positive finite number");
  }
  return duration;
}

export async function pollSource(options: PollSourceOptions): Promise<PollSourceResult> {
  const now = options.now?.() ?? new Date();
  const to = timestamp(now, "now");
  const checkpoint = options.store.getSourceCheckpoint(options.sourceId);
  const cutoff = new Date(now.getTime() - backfill(options.backfillMs)).toISOString();
  const missedFrom = checkpoint?.updatedAt;
  const from = missedFrom && missedFrom > cutoff ? missedFrom : cutoff;
  const existingWindow = options.store.getSourcePollWindow(options.sourceId);
  const limitedFrom = missedFrom && missedFrom < cutoff ? missedFrom : null;
  const window = existingWindow ?? options.store.openSourcePollWindow(options.sourceId, from, to, to, limitedFrom);
  const diagnostic = window.missedFrom
    ? {
        code: "SOURCE_BACKFILL_LIMITED" as const,
        sourceId: options.sourceId,
        missedFrom: window.missedFrom,
        resumedFrom: window.from,
        message: `Source ${JSON.stringify(options.sourceId)} resumes at ${window.from} because the uncollected period exceeds the backfill limit`,
      }
    : null;
  options.logger?.debug("source.window", {
    from: window.from,
    to: window.to,
    backfillLimited: diagnostic !== null,
  });

  let cursor = checkpoint?.cursor ?? null;
  let pages = 0;
  let insertedEvents = 0;
  do {
    options.logger?.debug("source.page_started", { page: pages + 1 });
    const page = await options.poll({
      cursor,
      from: window.from,
      to: window.to,
      config: options.config,
    });
    pages += 1;
    insertedEvents += options.store.appendSourceBatch({
      sourceId: options.sourceId,
      expectedCursor: cursor,
      nextCursor: page.nextCursor,
      updatedAt: window.to,
      events: page.events,
      complete: !page.hasMore,
    }).length;
    cursor = page.nextCursor;
    options.logger?.debug("source.page_completed", {
      page: pages,
      events: page.events.length,
      insertedEvents,
      hasMore: page.hasMore,
      cursorUpdated: page.nextCursor !== null,
    });
    if (!page.hasMore) break;
  } while (true);

  options.logger?.info("source.events_saved", {
    events: insertedEvents,
    pages,
  });
  return { window, pages, insertedEvents, diagnostic };
}
