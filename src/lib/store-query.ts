import { queryOptions } from "@tanstack/react-query";

import type { StoreCategorySection } from "@/data/types";

import { getStore } from "./store.functions";

export const storeQueryOptions = queryOptions<StoreCategorySection[]>({
  queryKey: ["store"],
  queryFn: () => getStore(),
  staleTime: 900_000,
});
