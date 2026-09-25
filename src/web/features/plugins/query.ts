import { queryOptions } from "@tanstack/react-query";
import { getDashboard, getPlugin } from "../../api/client.ts";
import { polled } from "../query.ts";

export const dashboardQuery = queryOptions({
  queryKey: ["dashboard"],
  queryFn: ({ signal }) => getDashboard(signal),
  ...polled,
});

export function pluginQuery(pluginId: string) {
  return queryOptions({
    queryKey: ["plugin", pluginId],
    queryFn: ({ signal }) => getPlugin(pluginId, signal),
    ...polled,
  });
}
