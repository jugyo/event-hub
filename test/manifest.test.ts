import assert from "node:assert/strict";
import test from "node:test";

import type { PluginManifest } from "../src/plugins/manifest.ts";

const base = {
  id: "example",
  entry: "./index.ts",
  config: null,
  env: {},
} as const;

const validManifests = [
  { ...base, kind: "source", trigger: { type: "poll", every: "1m", backfill: "1d" } },
  { ...base, kind: "source", trigger: { type: "poll", everyMs: 60_000 } },
  {
    ...base,
    kind: "consumer",
    trigger: { type: "events", eventTypes: ["example.changed"] },
  },
  {
    ...base,
    kind: "consumer",
    trigger: { type: "daily", at: "09:00", timezone: "Asia/Tokyo" },
  },
] satisfies PluginManifest[];

// This unreachable block exists only for compile-time contract assertions.
// eslint-disable-next-line no-constant-condition
if (false) {
  // @ts-expect-error A source cannot declare an event subscription.
  const sourceWithEvents: PluginManifest = {
    ...base,
    kind: "source",
    trigger: { type: "events", eventTypes: ["example.changed"] },
  };
  // @ts-expect-error A consumer cannot declare polling.
  const consumerWithPolling: PluginManifest = {
    ...base,
    kind: "consumer",
    trigger: { type: "poll", everyMs: 60_000 },
  };
  void sourceWithEvents;
  void consumerWithPolling;

  const sourceWithConflictingIntervals: PluginManifest = {
    ...base,
    kind: "source",
    // @ts-expect-error A source cannot declare both polling interval forms.
    trigger: { type: "poll", every: "1m", everyMs: 60_000 },
  };
  const sourceWithConflictingBackfills: PluginManifest = {
    ...base,
    kind: "source",
    // @ts-expect-error A source cannot declare both backfill forms.
    trigger: { type: "poll", every: "1m", backfill: "1d", backfillMs: 86_400_000 },
  };
  void sourceWithConflictingIntervals;
  void sourceWithConflictingBackfills;
}

test("plugin manifest types constrain each kind to its valid triggers", () => {
  assert.equal(validManifests.length, 4);
});
