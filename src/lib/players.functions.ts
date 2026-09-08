import { createServerFn } from "@tanstack/react-start";

import type { Player } from "@/data/types";

/** Public read-only feed of players and their monthly stats, sourced from Airtable. */
export const getPlayers = createServerFn({ method: "GET" }).handler(
  async (): Promise<Player[]> => {
    const { getCachedPublicFeed } = await import("./public-feed-cache.server");
    return getCachedPublicFeed<Player[]>("players", async () => {
      const { fetchPlayersFromAirtable } = await import("./airtable-players.server");
      return fetchPlayersFromAirtable();
    });
  },
);
