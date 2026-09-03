import { queryOptions } from "@tanstack/react-query";

import type { RecordEntry } from "@/data/types";

import { getRecords } from "./records.functions";

export const recordsQueryOptions = queryOptions<RecordEntry[]>({
  queryKey: ["records"],
  queryFn: () => getRecords(),
  staleTime: 60_000,
});
