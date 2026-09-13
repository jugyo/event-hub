import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  EventStore,
  SourceCursorConflictError,
  type EventInput,
} from "../src/index.ts";

const T0 = "2026-09-08T23:59:59.000Z";
const T1 = "2026-09-09T00:00:00.000Z";
const T2 = "2026-09-09T01:00:00.000Z";
const T3 = "2026-09-09T02:00:00.000Z";

function event(id: string, occurredAt: string, type = "example.changed"): EventInput {
  return {
    id,
    externalId: `external-${id}`,
    type,
    schemaVersion: 1,
    occurredAt,
    observedAt: T3,
    payload: { id },
  };
}

test("events and source cursors survive restart without storing duplicates", async () => {
  const directory = await mkdtemp(join(tmpdir(), "event-hub events "));
  const path = join(directory, "events.sqlite");
  try {
    const first = new EventStore({ path });
    first.migrate();
    first.appendSourceBatch({
      sourceId: "source-a",
      expectedCursor: null,
      nextCursor: { page: 1 },
      updatedAt: T3,
      events: [event("event-1", T1)],
    });
    first.close();

    const reopened = new EventStore({ path });
    reopened.migrate();
    assert.deepEqual(reopened.getSourceCheckpoint("source-a")?.cursor, { page: 1 });
    const inserted = reopened.appendSourceBatch({
      sourceId: "source-a",
      expectedCursor: { page: 1 },
      nextCursor: { page: 2 },
      updatedAt: T3,
      events: [event("another-id", T1)],
    });
    // Reproduce an externalId within the same source.
    const duplicate = event("another-id", T1);
    duplicate.externalId = "external-event-1";
    const duplicateResult = reopened.appendSourceBatch({
      sourceId: "source-a",
      expectedCursor: { page: 2 },
      nextCursor: { page: 3 },
      updatedAt: T3,
      events: [duplicate],
    });
    assert.equal(inserted.length, 1);
    assert.equal(duplicateResult.length, 0);
    assert.equal(reopened.queryHistory({ from: T0, to: T3 }).events.length, 2);
    reopened.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a failed event write does not advance the cursor and the full range can be retried", () => {
  const store = new EventStore({ path: ":memory:" });
  store.migrate();
  const conflicting = event("same-id", T2);
  conflicting.externalId = "external-2";

  assert.throws(
    () => store.appendSourceBatch({
      sourceId: "source-a",
      expectedCursor: null,
      nextCursor: "next",
      updatedAt: T3,
      events: [event("same-id", T1), conflicting],
    }),
    /UNIQUE constraint failed/,
  );
  assert.equal(store.getSourceCheckpoint("source-a"), null);
  assert.equal(store.queryHistory({ from: T0, to: T3 }).events.length, 0);

  store.appendSourceBatch({
    sourceId: "source-a",
    expectedCursor: null,
    nextCursor: "next",
    updatedAt: T3,
    events: [event("same-id", T1), event("event-2", T2)],
  });
  assert.equal(store.queryHistory({ from: T0, to: T3 }).events.length, 2);
  assert.throws(
    () => store.appendSourceBatch({
      sourceId: "source-a",
      expectedCursor: null,
      nextCursor: "stale-writer",
      updatedAt: T3,
      events: [],
    }),
    SourceCursorConflictError,
  );
  store.close();
});

test("history queries provide half-open windows, filters, and stable pagination", () => {
  const store = new EventStore({ path: ":memory:" });
  store.migrate();
  store.appendSourceBatch({
    sourceId: "source-a",
    expectedCursor: null,
    nextCursor: null,
    updatedAt: T3,
    events: [event("before", T0), event("first", T1), event("second", T1, "other.changed"), event("at-end", T3)],
  });
  store.appendSourceBatch({
    sourceId: "source-b",
    expectedCursor: null,
    nextCursor: null,
    updatedAt: T3,
    events: [event("third", T2)],
  });

  const firstPage = store.queryHistory({ from: T1, to: T3, limit: 2 });
  assert.deepEqual(firstPage.events.map(({ id }) => id), ["first", "second"]);
  assert.ok(firstPage.nextCursor);
  const secondPage = store.queryHistory({ from: T1, to: T3, limit: 2, after: firstPage.nextCursor! });
  assert.deepEqual(secondPage.events.map(({ id }) => id), ["third"]);
  assert.equal(secondPage.nextCursor, null);
  assert.deepEqual(
    store.queryHistory({ from: T1, to: T3, eventTypes: ["example.changed"], sourceIds: ["source-a"] }).events.map(({ id }) => id),
    ["first"],
  );
  store.close();
});

test("mixed second and millisecond precision preserves ordering and query boundaries", () => {
  const store = new EventStore({ path: ":memory:" });
  store.migrate();
  store.appendSourceBatch({
    sourceId: "source-a",
    expectedCursor: null,
    nextCursor: null,
    updatedAt: "2026-09-09T01:00:00Z",
    events: [
      event("exact", "2026-09-09T00:00:00Z"),
      event("later", "2026-09-09T00:00:00.500Z"),
    ],
  });

  const firstPage = store.queryHistory({
    from: "2026-09-09T00:00:00Z",
    to: "2026-09-09T00:00:01Z",
    limit: 1,
  });
  assert.deepEqual(firstPage.events.map(({ id }) => id), ["exact"]);
  assert.equal(firstPage.events[0]?.occurredAt, "2026-09-09T00:00:00.000Z");
  assert.ok(firstPage.nextCursor);
  const secondPage = store.queryHistory({
    from: "2026-09-09T00:00:00Z",
    to: "2026-09-09T00:00:01Z",
    after: firstPage.nextCursor!,
  });
  assert.deepEqual(secondPage.events.map(({ id }) => id), ["later"]);
  assert.equal(secondPage.events[0]?.occurredAt, "2026-09-09T00:00:00.500Z");
  store.close();
});

test("two consumers independently complete events received after registration", async () => {
  const directory = await mkdtemp(join(tmpdir(), "event-hub consumers "));
  const path = join(directory, "events.sqlite");
  try {
    let store = new EventStore({ path });
    store.migrate();
    store.appendSourceBatch({
      sourceId: "source-a",
      expectedCursor: null,
      nextCursor: 1,
      updatedAt: T1,
      events: [event("historical", T1)],
    });
    store.registerConsumer("consumer-a", T1);
    store.registerConsumer("consumer-b", T1);
    store.appendSourceBatch({
      sourceId: "source-a",
      expectedCursor: 1,
      nextCursor: 2,
      updatedAt: T3,
      events: [event("new-event", T2)],
    });

    assert.deepEqual(store.matchConsumerEvents("consumer-a", ["example.changed"], 100, T3).map(({ event }) => event.id), ["new-event"]);
    assert.deepEqual(store.matchConsumerEvents("consumer-b", ["example.changed"], 100, T3).map(({ event }) => event.id), ["new-event"]);
    store.completeDelivery("consumer-a", "new-event", T3);
    assert.equal(store.listPendingDeliveries("consumer-a").length, 0);
    assert.equal(store.listPendingDeliveries("consumer-b").length, 1);
    store.beginDeliveryAttempt("consumer-b", "new-event", T3);
    store.retryDelivery("consumer-b", "new-event", T3, "PLUGIN_STEP_FAILED");
    store.close();

    store = new EventStore({ path });
    store.migrate();
    assert.equal(store.listPendingDeliveries("consumer-a").length, 0);
    assert.equal(store.listPendingDeliveries("consumer-b").length, 1);
    assert.equal(store.getDelivery("consumer-b", "new-event")?.status, "retry_wait");
    assert.equal(store.getDelivery("consumer-b", "new-event")?.attempt, 1);
    assert.equal(store.getDelivery("consumer-b", "new-event")?.errorCode, "PLUGIN_STEP_FAILED");
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rerunning migrations does not change stored data", () => {
  const store = new EventStore({ path: ":memory:" });
  store.migrate();
  store.appendSourceBatch({
    sourceId: "source-a",
    expectedCursor: null,
    nextCursor: "saved",
    updatedAt: T3,
    events: [event("saved", T1)],
  });
  const version = store.schemaVersion();
  store.migrate();
  assert.equal(store.schemaVersion(), version);
  assert.equal(store.queryHistory({ from: T0, to: T3 }).events[0]?.id, "saved");
  assert.equal(store.getSourceCheckpoint("source-a")?.cursor, "saved");
  store.close();
});
