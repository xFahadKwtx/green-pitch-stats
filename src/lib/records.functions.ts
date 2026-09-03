import { createServerFn } from "@tanstack/react-start";

import type { RecordEntry } from "@/data/types";

/** Public read-only feed of breakable records, sourced from Airtable. */
export const getRecords = createServerFn({ method: "GET" }).handler(
  async (): Promise<RecordEntry[]> => {
    const { fetchRecordsFromAirtable } = await import("./records.server");
    return fetchRecordsFromAirtable();
  },
);
