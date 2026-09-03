import { createServerFn } from "@tanstack/react-start";

import type { StoreCategorySection } from "@/data/types";

/** Public read-only store feed (categories + products), sourced from Airtable. */
export const getStore = createServerFn({ method: "GET" }).handler(
  async (): Promise<StoreCategorySection[]> => {
    const { fetchStoreFromAirtable } = await import("./store.server");
    return fetchStoreFromAirtable();
  },
);
