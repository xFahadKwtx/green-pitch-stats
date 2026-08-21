import { createServerFn } from "@tanstack/react-start";

import type { Match } from "@/data/types";

/** Public read-only feed of upcoming games, sourced from Airtable. */
export const getUpcomingGames = createServerFn({ method: "GET" }).handler(
  async (): Promise<Match[]> => {
    const { fetchUpcomingGamesFromAirtable } = await import(
      "./upcoming-games.server"
    );
    return fetchUpcomingGamesFromAirtable();
  },
);
