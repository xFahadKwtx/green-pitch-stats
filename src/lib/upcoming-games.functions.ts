import { createServerFn } from "@tanstack/react-start";

import type { Match } from "@/data/types";

/** Public read-only feed of upcoming games, sourced from Airtable. */
export const getUpcomingGames = createServerFn({ method: "GET" }).handler(
  async (): Promise<Match[]> => {
    const { withPublicFeedBoundary } = await import("./public-error.server");
    return withPublicFeedBoundary("upcoming-games", async () => {
      const { getCachedPublicFeed } = await import("./public-feed-cache.server");
      return getCachedPublicFeed<Match[]>("upcoming-games", async () => {
        const { fetchUpcomingGamesFromAirtable } = await import(
          "./upcoming-games.server"
        );
        return fetchUpcomingGamesFromAirtable();
      });
    });
  },
);
