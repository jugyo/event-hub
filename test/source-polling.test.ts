import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { EventStore, pollSource, type EventInput, type SourcePollInput } from "../src/index.ts";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = new Date("2026-09-10T12:00:00.000Z");

function event(id: string, occurredAt = NOW.toISOString()): EventInput {
  return {
    id,
    externalId: id,
    type: "fake.changed",
    schemaVersion: 1,
    occurredAt,
    observedAt: NOW.toISOString(),
    payload: { id },
  };
}

test("uses fixed 24-hour windows for initial and unchanged collection", async () => {
  const store = new EventStore({ path: ":memory:" });
  store.migrate();
  const inputs: SourcePollInput[] = [];
  const first = await pollSource({
    sourceId: "source.fake",
    store,
    config: { project: "example" },
    now: () => NOW,
    poll: (input) => {
      inputs.push(input);
      return {
        events: [event("first")],
        nextCursor: "cursor-1",
        hasMore: false,
      };
    },
  });
  const later = new Date(NOW.getTime() + HOUR);
  const unchanged = await pollSource({
    sourceId: "source.fake",
    store,
    config: { project: "example" },
    now: () => later,
    poll: (input) => {
      inputs.push(input);
      return { events: [], nextCursor: input.cursor, hasMore: false };
    },
  });

  assert.equal(first.insertedEvents, 1);
  assert.equal(unchanged.insertedEvents, 0);
  assert.deepEqual(inputs, [
    {
      cursor: null,
      from: "2026-09-09T12:00:00.000Z",
      to: NOW.toISOString(),
      config: { project: "example" },
    },
    {
      cursor: "cursor-1",
      from: NOW.toISOString(),
      to: later.toISOString(),
      config: { project: "example" },
    },
  ]);
  assert.equal(store.getSourcePollWindow("source.fake"), null);
  store.close();
});

test("resumes from the stored cursor and collection window after a paginated failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "event-hub source polling "));
  const path = join(directory, "events.sqlite");
  try {
    let store = new EventStore({ path });
    store.migrate();
    const firstInputs: SourcePollInput[] = [];
    await assert.rejects(
      pollSource({
        sourceId: "source.fake",
        store,
        config: null,
        now: () => NOW,
        poll: (input) => {
          firstInputs.push(input);
          if (input.cursor === null)
            return {
              events: [event("page-1")],
              nextCursor: "page-2",
              hasMore: true,
            };
          throw new Error("fake provider unavailable");
        },
      }),
      /fake provider unavailable/,
    );
    assert.equal(store.getSourceCheckpoint("source.fake")?.cursor, "page-2");
    assert.ok(store.getSourcePollWindow("source.fake"));
    store.close();

    store = new EventStore({ path });
    store.migrate();
    const resumedAt = new Date(NOW.getTime() + 6 * HOUR);
    const resumedInputs: SourcePollInput[] = [];
    const result = await pollSource({
      sourceId: "source.fake",
      store,
      config: null,
      now: () => resumedAt,
      poll: (input) => {
        resumedInputs.push(input);
        return {
          events: [event("page-2")],
          nextCursor: "done",
          hasMore: false,
        };
      },
    });

    assert.equal(result.pages, 1);
    assert.deepEqual(resumedInputs, [
      {
        cursor: "page-2",
        from: "2026-09-09T12:00:00.000Z",
        to: NOW.toISOString(),
        config: null,
      },
    ]);
    assert.deepEqual(
      store
        .queryHistory({
          from: "2026-09-09T00:00:00.000Z",
          to: "2026-09-11T00:00:00.000Z",
        })
        .events.map(({ id }) => id),
      ["page-1", "page-2"],
    );
    assert.equal(store.getSourcePollWindow("source.fake"), null);
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("limits three days of downtime to 24 hours and allows configured collection from before the stop", async () => {
  const oldTime = new Date(NOW.getTime() - 3 * DAY).toISOString();
  const weekAgo = new Date(NOW.getTime() - 7 * DAY).toISOString();
  const store = new EventStore({ path: ":memory:" });
  store.migrate();
  store.appendSourceBatch({
    sourceId: "source.default",
    expectedCursor: null,
    nextCursor: "old-default",
    updatedAt: oldTime,
    events: [event("week-old-default", weekAgo)],
  });
  store.appendSourceBatch({
    sourceId: "source.configured",
    expectedCursor: null,
    nextCursor: "old-configured",
    updatedAt: oldTime,
    events: [event("week-old-configured", weekAgo)],
  });
  let defaultInput: SourcePollInput | undefined;
  const limited = await pollSource({
    sourceId: "source.default",
    store,
    config: null,
    now: () => NOW,
    poll: (input) => {
      defaultInput = input;
      return { events: [], nextCursor: input.cursor, hasMore: false };
    },
  });
  let configuredInput: SourcePollInput | undefined;
  const configured = await pollSource({
    sourceId: "source.configured",
    store,
    config: null,
    backfillMs: 4 * DAY,
    now: () => NOW,
    poll: (input) => {
      configuredInput = input;
      return { events: [], nextCursor: input.cursor, hasMore: false };
    },
  });

  assert.equal(defaultInput?.from, new Date(NOW.getTime() - DAY).toISOString());
  assert.equal(limited.diagnostic?.code, "SOURCE_BACKFILL_LIMITED");
  assert.equal(limited.diagnostic?.missedFrom, oldTime);
  assert.equal(configuredInput?.from, oldTime);
  assert.equal(configured.diagnostic, null);
  assert.deepEqual(
    store
      .queryHistory({
        from: new Date(NOW.getTime() - 8 * DAY).toISOString(),
        to: NOW.toISOString(),
      })
      .events.map(({ id }) => id),
    ["week-old-default", "week-old-configured"],
  );
  store.close();
});

test("retains the omitted-range diagnostic after a failure within a limited backfill", async () => {
  const oldTime = new Date(NOW.getTime() - 3 * DAY).toISOString();
  const store = new EventStore({ path: ":memory:" });
  store.migrate();
  store.appendSourceBatch({
    sourceId: "source.limited",
    expectedCursor: null,
    nextCursor: "old",
    updatedAt: oldTime,
    events: [],
  });

  await assert.rejects(
    pollSource({
      sourceId: "source.limited",
      store,
      config: null,
      now: () => NOW,
      poll: (input) => {
        if (input.cursor === "old") {
          return {
            events: [event("page-1")],
            nextCursor: "page-2",
            hasMore: true,
          };
        }
        throw new Error("fake provider unavailable");
      },
    }),
    /fake provider unavailable/,
  );

  const window = store.getSourcePollWindow("source.limited");
  assert.equal(window?.missedFrom, oldTime);
  const resumed = await pollSource({
    sourceId: "source.limited",
    store,
    config: null,
    now: () => new Date(NOW.getTime() + HOUR),
    poll: () => ({
      events: [event("page-2")],
      nextCursor: "done",
      hasMore: false,
    }),
  });

  assert.deepEqual(resumed.diagnostic, {
    code: "SOURCE_BACKFILL_LIMITED",
    sourceId: "source.limited",
    missedFrom: oldTime,
    resumedFrom: new Date(NOW.getTime() - DAY).toISOString(),
    message:
      'Source "source.limited" resumes at 2026-09-09T12:00:00.000Z because the uncollected period exceeds the backfill limit',
  });
  assert.equal(store.getSourcePollWindow("source.limited"), null);
  store.close();
});

test("does not duplicate recollected events or advance the cursor after a storage failure", async () => {
  const store = new EventStore({ path: ":memory:" });
  store.migrate();
  await pollSource({
    sourceId: "source.fake",
    store,
    config: null,
    now: () => NOW,
    poll: () => ({
      events: [event("same")],
      nextCursor: "first",
      hasMore: false,
    }),
  });
  const later = new Date(NOW.getTime() + HOUR);
  const duplicate = await pollSource({
    sourceId: "source.fake",
    store,
    config: null,
    now: () => later,
    poll: () => ({
      events: [event("same")],
      nextCursor: "second",
      hasMore: false,
    }),
  });
  assert.equal(duplicate.insertedEvents, 0);
  assert.equal(store.getSourceCheckpoint("source.fake")?.cursor, "second");

  await assert.rejects(
    pollSource({
      sourceId: "source.fake",
      store,
      config: null,
      now: () => new Date(later.getTime() + HOUR),
      poll: () => ({
        events: [{ ...event("same"), externalId: "different-external-id" }],
        nextCursor: "must-not-save",
        hasMore: false,
      }),
    }),
    /UNIQUE constraint failed/,
  );
  assert.equal(store.getSourceCheckpoint("source.fake")?.cursor, "second");
  assert.ok(store.getSourcePollWindow("source.fake"));
  store.close();
});
