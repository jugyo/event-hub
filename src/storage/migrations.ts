export interface EventStoreMigration {
  version: number;
  name: string;
  sql: string;
}

export const EVENT_STORE_MIGRATIONS: EventStoreMigration[] = [
  {
    version: 1,
    name: "initial-event-store",
    sql: `
CREATE TABLE events (
  seq             INTEGER PRIMARY KEY AUTOINCREMENT,
  id              TEXT NOT NULL UNIQUE,
  source_id       TEXT NOT NULL,
  external_id     TEXT NOT NULL,
  type            TEXT NOT NULL,
  schema_version  INTEGER NOT NULL CHECK (schema_version > 0),
  occurred_at     TEXT NOT NULL,
  observed_at     TEXT NOT NULL,
  payload_json    TEXT NOT NULL,
  UNIQUE (source_id, external_id)
) STRICT;

CREATE INDEX idx_events_history
  ON events(occurred_at, seq);

CREATE INDEX idx_events_source_history
  ON events(source_id, occurred_at, seq);

CREATE INDEX idx_events_type_history
  ON events(type, occurred_at, seq);

CREATE TABLE source_checkpoints (
  source_id     TEXT PRIMARY KEY,
  cursor_json   TEXT,
  updated_at    TEXT NOT NULL
) STRICT;

CREATE TABLE consumer_subscriptions (
  consumer_id          TEXT PRIMARY KEY,
  matched_through_seq  INTEGER NOT NULL,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
) STRICT;

CREATE TABLE consumer_deliveries (
  consumer_id   TEXT NOT NULL REFERENCES consumer_subscriptions(consumer_id),
  event_id      TEXT NOT NULL REFERENCES events(id),
  status        TEXT NOT NULL CHECK (status IN ('pending', 'completed')),
  created_at    TEXT NOT NULL,
  completed_at  TEXT,
  PRIMARY KEY (consumer_id, event_id)
) STRICT;

CREATE INDEX idx_consumer_deliveries_pending
  ON consumer_deliveries(consumer_id, status, created_at, event_id);
`,
  },
  {
    version: 2,
    name: "plugin-registrations",
    sql: `
CREATE TABLE plugin_registrations (
  plugin_id       TEXT PRIMARY KEY,
  kind            TEXT NOT NULL CHECK (kind IN ('source', 'consumer')),
  directory       TEXT NOT NULL,
  entrypoint      TEXT NOT NULL,
  manifest_json   TEXT NOT NULL,
  active          INTEGER NOT NULL CHECK (active IN (0, 1)),
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
) STRICT;

CREATE INDEX idx_plugin_registrations_active
  ON plugin_registrations(active, kind, plugin_id);
`,
  },
  {
    version: 3,
    name: "source-poll-windows",
    sql: `
CREATE TABLE source_poll_windows (
  source_id   TEXT PRIMARY KEY,
  from_time   TEXT NOT NULL,
  to_time     TEXT NOT NULL,
  started_at  TEXT NOT NULL
) STRICT;
`,
  },
  {
    version: 4,
    name: "source-poll-window-missed-from",
    sql: `
ALTER TABLE source_poll_windows ADD COLUMN missed_from TEXT;
`,
  },
  {
    version: 5,
    name: "consumer-delivery-outcomes",
    sql: `
ALTER TABLE consumer_deliveries ADD COLUMN attempt INTEGER NOT NULL DEFAULT 0;
ALTER TABLE consumer_deliveries ADD COLUMN last_attempt_at TEXT;
ALTER TABLE consumer_deliveries ADD COLUMN next_attempt_at TEXT;
ALTER TABLE consumer_deliveries ADD COLUMN failed_at TEXT;
ALTER TABLE consumer_deliveries ADD COLUMN error_code TEXT;

CREATE TABLE consumer_deliveries_v5 (
  consumer_id      TEXT NOT NULL REFERENCES consumer_subscriptions(consumer_id),
  event_id         TEXT NOT NULL REFERENCES events(id),
  status           TEXT NOT NULL CHECK (status IN ('pending', 'retry_wait', 'completed', 'failed')),
  created_at       TEXT NOT NULL,
  completed_at     TEXT,
  attempt          INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  last_attempt_at  TEXT,
  next_attempt_at  TEXT,
  failed_at        TEXT,
  error_code       TEXT,
  PRIMARY KEY (consumer_id, event_id)
) STRICT;

INSERT INTO consumer_deliveries_v5
SELECT consumer_id, event_id, status, created_at, completed_at, attempt,
       last_attempt_at, next_attempt_at, failed_at, error_code
FROM consumer_deliveries;
DROP TABLE consumer_deliveries;
ALTER TABLE consumer_deliveries_v5 RENAME TO consumer_deliveries;

CREATE INDEX idx_consumer_deliveries_pending
  ON consumer_deliveries(consumer_id, status, next_attempt_at, event_id);
`,
  },
];

export const LATEST_EVENT_STORE_SCHEMA_VERSION =
  EVENT_STORE_MIGRATIONS[EVENT_STORE_MIGRATIONS.length - 1].version;
