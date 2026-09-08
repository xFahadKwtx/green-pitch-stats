/**
 * Read-only mapping from Airtable's "Records" table to the app's RecordEntry type.
 *
 * SAFETY: this module only ever issues GET requests and never mutates Airtable.
 */
import type { RecordEntry } from "@/data/types";

import {
  AIRTABLE_TABLES,
  listAirtableRecords,
  str,
} from "./airtable.server";

/** Fetch website-visible records, resolving the linked Player to a name. */
export async function fetchRecordsFromAirtable(): Promise<RecordEntry[]> {
  const [recordRows, playerRows] = await Promise.all([
    listAirtableRecords(AIRTABLE_TABLES.records),
    listAirtableRecords(AIRTABLE_TABLES.playersDatabase, {
      fields: ["Official Name EN", "Official Name AR", "Show On Website"],
    }),
  ]);

  /** Airtable player record id -> { nameEn, nameAr } (website-visible players only) */
  const playerNames = new Map<string, { nameEn: string; nameAr: string }>();
  for (const row of playerRows) {
    if (row.fields["Show On Website"] !== true) continue;
    playerNames.set(row.id, {
      nameEn: str(row.fields["Official Name EN"]),
      nameAr: str(row.fields["Official Name AR"]),
    });
  }

  const records: RecordEntry[] = [];
  for (const record of recordRows) {
    if (record.fields["Show On Website"] !== true) continue;

    const nameEn = str(record.fields["Record Name EN"]);
    const nameAr = str(record.fields["Record Name AR"]);
    if (!nameEn && !nameAr) continue;

    // The Player link field holds Airtable record ids of Players DATABASE rows.
    const playerIds = Array.isArray(record.fields["Player"])
      ? (record.fields["Player"] as unknown[]).filter(
          (v): v is string => typeof v === "string",
        )
      : [];

    let holderNameEn: string | null = null;
    let holderNameAr: string | null = null;
    for (const pid of playerIds) {
      const names = playerNames.get(pid);
      if (!names) continue;
      holderNameEn = names.nameEn || holderNameEn;
      holderNameAr = names.nameAr || holderNameAr;
    }
    // A link with no resolvable name is treated as unclaimed.
    if (!holderNameEn && !holderNameAr) {
      holderNameEn = null;
      holderNameAr = null;
    }

    records.push({
      id: record.id,
      nameEn,
      nameAr,
      value: str(record.fields["Value"]),
      holderNameEn,
      holderNameAr,
    });
  }

  return records;
}
