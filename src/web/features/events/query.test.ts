import { describe, expect, it } from "vitest";
import { EVENT_LIMIT, eventsQuery } from "./query.ts";

describe("event history query", () => {
  it("never fetches on a timer, on focus, or on reconnect", () => {
    const query = eventsQuery("github");
    expect(query.refetchInterval).toBe(false);
    expect(query.refetchOnWindowFocus).toBe(false);
    expect(query.refetchOnReconnect).toBe(false);
    expect(query.staleTime).toBe(Infinity);
  });

  it("requests the default page of the newest events for one source", () => {
    expect(EVENT_LIMIT).toBe(20);
    expect(eventsQuery("github").queryKey).toEqual(["events", "github", 20]);
  });
});
