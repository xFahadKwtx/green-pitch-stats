/**
 * Read-only mapping from Airtable's UPCOMING GAMES table to the website Match type.
 *
 * SAFETY: this module only ever issues GET requests and never mutates Airtable.
 */

import type { Match } from "@/data/types";
import { compareBookings, normalizeBooking } from "./upcoming-games";

import {
  AIRTABLE_TABLES,
  listAirtableRecords,
  str,
} from "./airtable.server";

/** Fetch visible upcoming games, sorted chronologically. */
export async function fetchUpcomingGamesFromAirtable(): Promise<Match[]> {
  const records = await listAirtableRecords(AIRTABLE_TABLES.upcomingGames);

  const matches: Match[] = records
    .filter((record) => record.fields["Show On Website"] === true)
    .map((record) => {
      return normalizeBooking({
        id: record.id,
        date: str(record.fields["Date"]),
        time: str(record.fields["time"]),
        location: str(record.fields["Location EN"]),
        locationAr: str(record.fields["Location AR"]),
      });
    })
    .filter((match): match is Match => match !== null)
    .sort(compareBookings);

  // Keep all validated dates: eligibility is evaluated AFTER H2, on every response.
  return matches;
}
