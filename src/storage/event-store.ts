import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  EVENT_STORE_MIGRATIONS,
  LATEST_EVENT_STORE_SCHEMA_VERSION,
} from "./migrations.ts";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export interface EventInput {
  id: string;
  externalId: string;
  type: string;
  schemaVersion: number;
  occurredAt: string;
  observedAt: string;
  payload: Json;
}

export interface EventRecord extends EventInput {
  seq: number;
  sourceId: string;
}

export interface SourceCheckpoint {
  sourceId: string;
  cursor: Json | null;
  updatedAt: string;
}

export interface SourcePollWindow {
  sourceId: string;
  from: string;
  to: string;
  startedAt: string;
  missedFrom: string | null;
}

export interface SourceBatch {
  sourceId: string;
  expectedCursor: Json | null;
  nextCursor: Json | null;
  updatedAt: string;
  events: EventInput[];
  complete?: boolean;
}

export interface HistoryQuery {
  from: string;
  to: string;
  eventTypes?: string[];
  sourceIds?: string[];
  limit?: number;
  after?: string;
}

export interface HistoryPage {
  events: EventRecord[];
  nextCursor: string | null;
}

export interface ConsumerDelivery {
  consumerId: string;
  event: EventRecord;
  status: "pending" | "retry_wait" | "completed" | "failed";
  createdAt: string;
  completedAt: string | null;
  attempt: number;
  lastAttemptAt: string | null;
  nextAttemptAt: string | null;
  failedAt: string | null;
  errorCode: string | null;
}

export class SourceCursorConflictError extends Error {
  constructor(sourceId: string) {
    super(`The collection position for source ${JSON.stringify(sourceId)} has changed`);
    this.name = "SourceCursorConflictError";
  }
}

type Row = Record<string, unknown>;

function stringify(value: Json | null): string {
  return JSON.stringify(value);
}

function parseJson(value: unknown): Json {
  return JSON.parse(String(value)) as Json;
}

function normalizeTimestamp(value: string, label: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) || Number.isNaN(Date.parse(value))) {
    throw new TypeError(`${label} must be a UTC ISO 8601 string`);
  }
  return new Date(value).toISOString();
}

function toEvent(row: Row): EventRecord {
  return {
    seq: Number(row.seq),
    id: String(row.id),
    sourceId: String(row.source_id),
    externalId: String(row.external_id),
    type: String(row.type),
    schemaVersion: Number(row.schema_version),
    occurredAt: String(row.occurred_at),
    observedAt: String(row.observed_at),
    payload: parseJson(row.payload_json),
  };
}

function placeholders(values: readonly unknown[]): string {
  return values.map(() => "?").join(", ");
}

export interface EventStoreOptions {
  path: string;
  busyTimeoutMs?: number;
}

export interface PluginRegistrationInput {
  id: string;
  kind: "source" | "consumer";
  directory: string;
  entrypoint: string;
  manifest: Json;
}

export interface PluginRegistration extends PluginRegistrationInput {
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export class EventStore {
  readonly path: string;
  #db: DatabaseSync;

  constructor(options: EventStoreOptions) {
    this.path = options.path === ":memory:" ? ":memory:" : resolve(options.path);
    if (this.path !== ":memory:") mkdirSync(dirname(this.path), { recursive: true });
    this.#db = new DatabaseSync(this.path);
    if (this.path !== ":memory:") this.#db.exec("PRAGMA journal_mode = WAL");
    this.#db.exec("PRAGMA foreign_keys = ON");
    this.#db.exec("PRAGMA synchronous = FULL");
    this.#db.exec(`PRAGMA busy_timeout = ${options.busyTimeoutMs ?? 5000}`);
  }

  migrate(): void {
    const current = this.schemaVersion();
    if (current > LATEST_EVENT_STORE_SCHEMA_VERSION) {
      throw new Error(`event store schema version ${current} is newer than supported version ${LATEST_EVENT_STORE_SCHEMA_VERSION}`);
    }
    for (const migration of EVENT_STORE_MIGRATIONS) {
      if (migration.version <= current) continue;
      this.transaction(() => {
        this.#db.exec(migration.sql);
        this.#db.exec(`PRAGMA user_version = ${migration.version}`);
      });
    }
  }

  schemaVersion(): number {
    const row = this.#db.prepare("PRAGMA user_version").get() as Row;
    return Number(row.user_version ?? 0);
  }

  close(): void {
    this.#db.close();
  }

  syncPluginRegistrations(plugins: PluginRegistrationInput[], now: string): void {
    now = normalizeTimestamp(now, "now");
    this.transaction(() => {
      this.#db.prepare("UPDATE plugin_registrations SET active = 0, updated_at = ? WHERE active = 1").run(now);
      const upsert = this.#db.prepare(
        `INSERT INTO plugin_registrations
           (plugin_id, kind, directory, entrypoint, manifest_json, active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?)
         ON CONFLICT(plugin_id) DO UPDATE SET
           kind = excluded.kind,
           directory = excluded.directory,
           entrypoint = excluded.entrypoint,
           manifest_json = excluded.manifest_json,
           active = 1,
           updated_at = excluded.updated_at`,
      );
      for (const plugin of plugins) {
        upsert.run(
          plugin.id,
          plugin.kind,
          resolve(plugin.directory),
          resolve(plugin.entrypoint),
          stringify(plugin.manifest),
          now,
          now,
        );
      }
    });
  }

  listPluginRegistrations(options: { activeOnly?: boolean } = {}): PluginRegistration[] {
    const where = options.activeOnly ? " WHERE active = 1" : "";
    const rows = this.#db.prepare(
      `SELECT * FROM plugin_registrations${where} ORDER BY kind, plugin_id`,
    ).all() as Row[];
    return rows.map((row) => ({
      id: String(row.plugin_id),
      kind: String(row.kind) as "source" | "consumer",
      directory: String(row.directory),
      entrypoint: String(row.entrypoint),
      manifest: parseJson(row.manifest_json),
      active: Number(row.active) === 1,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    }));
  }

  getSourceCheckpoint(sourceId: string): SourceCheckpoint | null {
    const row = this.#db.prepare("SELECT * FROM source_checkpoints WHERE source_id = ?").get(sourceId) as Row | undefined;
    return row
      ? { sourceId, cursor: row.cursor_json === null ? null : parseJson(row.cursor_json), updatedAt: String(row.updated_at) }
      : null;
  }

  getSourcePollWindow(sourceId: string): SourcePollWindow | null {
    const row = this.#db.prepare("SELECT * FROM source_poll_windows WHERE source_id = ?").get(sourceId) as Row | undefined;
    return row
      ? {
          sourceId,
          from: String(row.from_time),
          to: String(row.to_time),
          startedAt: String(row.started_at),
          missedFrom: row.missed_from === null ? null : String(row.missed_from),
        }
      : null;
  }

  openSourcePollWindow(
    sourceId: string,
    from: string,
    to: string,
    startedAt: string,
    missedFrom: string | null = null,
  ): SourcePollWindow {
    from = normalizeTimestamp(from, "from");
    to = normalizeTimestamp(to, "to");
    startedAt = normalizeTimestamp(startedAt, "startedAt");
    if (missedFrom !== null) missedFrom = normalizeTimestamp(missedFrom, "missedFrom");
    if (from > to) throw new RangeError("A source collection window must satisfy from <= to");
    return this.transaction(() => {
      this.#db.prepare(
        `INSERT INTO source_poll_windows (source_id, from_time, to_time, started_at, missed_from)
         VALUES (?, ?, ?, ?, ?) ON CONFLICT(source_id) DO NOTHING`,
      ).run(sourceId, from, to, startedAt, missedFrom);
      return this.getSourcePollWindow(sourceId)!;
    });
  }

  appendSourceBatch(batch: SourceBatch): EventRecord[] {
    const updatedAt = normalizeTimestamp(batch.updatedAt, "updatedAt");
    const events = batch.events.map((event) => {
      const occurredAt = normalizeTimestamp(event.occurredAt, "occurredAt");
      const observedAt = normalizeTimestamp(event.observedAt, "observedAt");
      if (!Number.isInteger(event.schemaVersion) || event.schemaVersion <= 0) {
        throw new TypeError("schemaVersion must be a positive integer");
      }
      return { ...event, occurredAt, observedAt };
    });

    return this.transaction(() => {
      const checkpoint = this.getSourceCheckpoint(batch.sourceId);
      const actualCursor = checkpoint?.cursor ?? null;
      if (stringify(actualCursor) !== stringify(batch.expectedCursor)) {
        throw new SourceCursorConflictError(batch.sourceId);
      }

      const inserted: EventRecord[] = [];
      const statement = this.#db.prepare(
        `INSERT INTO events (id, source_id, external_id, type, schema_version, occurred_at, observed_at, payload_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(source_id, external_id) DO NOTHING`,
      );
      for (const event of events) {
        const result = statement.run(
          event.id,
          batch.sourceId,
          event.externalId,
          event.type,
          event.schemaVersion,
          event.occurredAt,
          event.observedAt,
          stringify(event.payload),
        );
        if (result.changes === 1) {
          const row = this.#db.prepare("SELECT * FROM events WHERE id = ?").get(event.id) as Row;
          inserted.push(toEvent(row));
        }
      }
      this.#db.prepare(
        `INSERT INTO source_checkpoints (source_id, cursor_json, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(source_id) DO UPDATE SET cursor_json = excluded.cursor_json, updated_at = excluded.updated_at`,
      ).run(batch.sourceId, stringify(batch.nextCursor), updatedAt);
      if (batch.complete) {
        this.#db.prepare("DELETE FROM source_poll_windows WHERE source_id = ?").run(batch.sourceId);
      }
      return inserted;
    });
  }

  queryHistory(query: HistoryQuery): HistoryPage {
    const from = normalizeTimestamp(query.from, "from");
    const to = normalizeTimestamp(query.to, "to");
    const limit = query.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
      throw new RangeError("limit must be an integer between 1 and 1000");
    }
    const conditions = ["occurred_at >= ?", "occurred_at < ?"];
    const values: (string | number)[] = [from, to];
    if (query.eventTypes?.length) {
      conditions.push(`type IN (${placeholders(query.eventTypes)})`);
      values.push(...query.eventTypes);
    }
    if (query.sourceIds?.length) {
      conditions.push(`source_id IN (${placeholders(query.sourceIds)})`);
      values.push(...query.sourceIds);
    }
    if (query.after) {
      const decoded = JSON.parse(Buffer.from(query.after, "base64url").toString("utf8")) as { occurredAt: string; seq: number };
      const occurredAt = normalizeTimestamp(decoded.occurredAt, "after.occurredAt");
      if (!Number.isInteger(decoded.seq) || decoded.seq < 1) throw new TypeError("The after cursor is invalid");
      conditions.push("(occurred_at > ? OR (occurred_at = ? AND seq > ?))");
      values.push(occurredAt, occurredAt, decoded.seq);
    }
    const rows = this.#db.prepare(
      `SELECT * FROM events WHERE ${conditions.join(" AND ")} ORDER BY occurred_at, seq LIMIT ?`,
    ).all(...values, limit + 1) as Row[];
    const hasMore = rows.length > limit;
    const events = rows.slice(0, limit).map(toEvent);
    const last = events.at(-1);
    return {
      events,
      nextCursor: hasMore && last
        ? Buffer.from(JSON.stringify({ occurredAt: last.occurredAt, seq: last.seq })).toString("base64url")
        : null,
    };
  }

  registerConsumer(consumerId: string, now: string): void {
    now = normalizeTimestamp(now, "now");
    this.#db.prepare(
      `INSERT INTO consumer_subscriptions (consumer_id, matched_through_seq, created_at, updated_at)
       VALUES (?, (SELECT COALESCE(MAX(seq), 0) FROM events), ?, ?)
       ON CONFLICT(consumer_id) DO NOTHING`,
    ).run(consumerId, now, now);
  }

  matchConsumerEvents(consumerId: string, eventTypes: string[], limit: number, now: string): ConsumerDelivery[] {
    now = normalizeTimestamp(now, "now");
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError("limit must be a positive integer");
    return this.transaction(() => {
      const subscription = this.#db.prepare(
        "SELECT matched_through_seq FROM consumer_subscriptions WHERE consumer_id = ?",
      ).get(consumerId) as Row | undefined;
      if (!subscription) throw new Error(`Consumer ${JSON.stringify(consumerId)} is not registered`);
      const rows = this.#db.prepare(
        "SELECT * FROM events WHERE seq > ? ORDER BY seq LIMIT ?",
      ).all(Number(subscription.matched_through_seq), limit) as Row[];
      const accepted = new Set(eventTypes);
      const insert = this.#db.prepare(
        `INSERT INTO consumer_deliveries (consumer_id, event_id, status, created_at)
         VALUES (?, ?, 'pending', ?) ON CONFLICT(consumer_id, event_id) DO NOTHING`,
      );
      for (const row of rows) {
        if (accepted.has(String(row.type))) insert.run(consumerId, String(row.id), now);
      }
      const last = rows.at(-1);
      if (last) {
        this.#db.prepare(
          "UPDATE consumer_subscriptions SET matched_through_seq = ?, updated_at = ? WHERE consumer_id = ?",
        ).run(Number(last.seq), now, consumerId);
      }
      return this.listReadyDeliveries(consumerId, now);
    });
  }

  listReadyDeliveries(consumerId: string, now: string, limit = 100): ConsumerDelivery[] {
    now = normalizeTimestamp(now, "now");
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError("limit must be a positive integer");
    const rows = this.#db.prepare(
      `SELECT d.consumer_id, d.status, d.created_at, d.completed_at, d.attempt,
              d.last_attempt_at, d.next_attempt_at, d.failed_at, d.error_code, e.*
       FROM consumer_deliveries d JOIN events e ON e.id = d.event_id
       WHERE d.consumer_id = ?
         AND (d.status = 'pending' OR (d.status = 'retry_wait' AND d.next_attempt_at <= ?))
       ORDER BY e.seq LIMIT ?`,
    ).all(consumerId, now, limit) as Row[];
    return rows.map((row) => this.deliveryFromRow(row));
  }

  listPendingDeliveries(consumerId: string): ConsumerDelivery[] {
    const rows = this.#db.prepare(
      `SELECT d.consumer_id, d.status, d.created_at, d.completed_at, d.attempt,
              d.last_attempt_at, d.next_attempt_at, d.failed_at, d.error_code, e.*
       FROM consumer_deliveries d JOIN events e ON e.id = d.event_id
       WHERE d.consumer_id = ? AND d.status IN ('pending', 'retry_wait') ORDER BY e.seq`,
    ).all(consumerId) as Row[];
    return rows.map((row) => this.deliveryFromRow(row));
  }

  private deliveryFromRow(row: Row): ConsumerDelivery {
    return {
      consumerId: String(row.consumer_id),
      event: toEvent(row),
      status: String(row.status) as ConsumerDelivery["status"],
      createdAt: String(row.created_at),
      completedAt: row.completed_at === null ? null : String(row.completed_at),
      attempt: Number(row.attempt),
      lastAttemptAt: row.last_attempt_at === null ? null : String(row.last_attempt_at),
      nextAttemptAt: row.next_attempt_at === null ? null : String(row.next_attempt_at),
      failedAt: row.failed_at === null ? null : String(row.failed_at),
      errorCode: row.error_code === null ? null : String(row.error_code),
    };
  }

  getDelivery(consumerId: string, eventId: string): ConsumerDelivery | null {
    const row = this.#db.prepare(
      `SELECT d.consumer_id, d.status, d.created_at, d.completed_at, d.attempt,
              d.last_attempt_at, d.next_attempt_at, d.failed_at, d.error_code, e.*
       FROM consumer_deliveries d JOIN events e ON e.id = d.event_id
       WHERE d.consumer_id = ? AND d.event_id = ?`,
    ).get(consumerId, eventId) as Row | undefined;
    return row ? this.deliveryFromRow(row) : null;
  }

  beginDeliveryAttempt(consumerId: string, eventId: string, attemptedAt: string): ConsumerDelivery {
    attemptedAt = normalizeTimestamp(attemptedAt, "attemptedAt");
    const result = this.#db.prepare(
      `UPDATE consumer_deliveries
       SET status = 'pending', attempt = attempt + 1, last_attempt_at = ?, next_attempt_at = NULL,
           failed_at = NULL, error_code = NULL
       WHERE consumer_id = ? AND event_id = ? AND status IN ('pending', 'retry_wait')
         AND (next_attempt_at IS NULL OR next_attempt_at <= ?)`,
    ).run(attemptedAt, consumerId, eventId, attemptedAt);
    if (result.changes === 0) throw new Error("The delivery is not runnable");
    return this.getDelivery(consumerId, eventId)!;
  }

  retryDelivery(consumerId: string, eventId: string, nextAttemptAt: string, errorCode: string): void {
    nextAttemptAt = normalizeTimestamp(nextAttemptAt, "nextAttemptAt");
    const result = this.#db.prepare(
      `UPDATE consumer_deliveries SET status = 'retry_wait', next_attempt_at = ?, error_code = ?
       WHERE consumer_id = ? AND event_id = ? AND status = 'pending'`,
    ).run(nextAttemptAt, errorCode, consumerId, eventId);
    if (result.changes === 0) throw new Error("The delivery cannot be scheduled for retry");
  }

  failDelivery(consumerId: string, eventId: string, failedAt: string, errorCode: string): void {
    failedAt = normalizeTimestamp(failedAt, "failedAt");
    const result = this.#db.prepare(
      `UPDATE consumer_deliveries SET status = 'failed', failed_at = ?, next_attempt_at = NULL, error_code = ?
       WHERE consumer_id = ? AND event_id = ? AND status = 'pending'`,
    ).run(failedAt, errorCode, consumerId, eventId);
    if (result.changes === 0) throw new Error("The delivery cannot be marked as terminally failed");
  }

  completeDelivery(consumerId: string, eventId: string, completedAt: string): void {
    completedAt = normalizeTimestamp(completedAt, "completedAt");
    const result = this.#db.prepare(
      `UPDATE consumer_deliveries SET status = 'completed', completed_at = ?, next_attempt_at = NULL, error_code = NULL
       WHERE consumer_id = ? AND event_id = ? AND status = 'pending'`,
    ).run(completedAt, consumerId, eventId);
    if (result.changes === 0) throw new Error("The delivery does not exist");
  }

  private transaction<T>(operation: () => T): T {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.#db.exec("COMMIT");
      return result;
    } catch (error) {
      try { this.#db.exec("ROLLBACK"); } catch { /* SQLite may already have rolled back. */ }
      throw error;
    }
  }
}
