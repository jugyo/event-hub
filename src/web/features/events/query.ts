import { queryOptions } from "@tanstack/react-query";
import { getEvents } from "../../api/client.ts";
import { manual } from "../query.ts";

export const EVENT_LIMIT = 20;

export function eventsQuery(sourceId: string) {
  return queryOptions({
    queryKey: ["events", sourceId, EVENT_LIMIT],
    queryFn: ({ signal }) => getEvents(sourceId, EVENT_LIMIT, signal),
    ...manual,
  });
}
