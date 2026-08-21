/**
 * Read-only mapping from Airtable's UPCOMING GAMES table to the website Match type.
 *
 * SAFETY: this module only ever issues GET requests and never mutates Airtable.
 */

import type { Match } from "@/data/types";

import {
  AIRTABLE_TABLES,
  listAirtableRecords,
  str,
} from "./airtable.server";

/** Fetch visible upcoming games, sorted chronologically. */
export async function fetchUpcomingGamesFromAirtable(): Promise<Match[]> {
  const records = await listAirtableRecords(AIRTABLE_TABLES.upcomingGames);

  const matches: Match[] = records
    .filter((record) => Boolean(record.fields["Show On Website"]))
    .map((record) => {
      const dateValue = record.fields["Date"];
      const date =
        typeof dateValue === "string"
          ? dateValue.slice(0, 10)
          : str(dateValue);

      return {
        id: record.id,
        date,
        time: str(record.fields["time"]),
        location: str(record.fields["Location EN"]),
        locationAr: str(record.fields["Location AR"]),
      };
    })
    .filter((match) => match.date !== "")
    .sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time));

  return matches;
}
