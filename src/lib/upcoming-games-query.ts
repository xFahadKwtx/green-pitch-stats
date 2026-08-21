import { queryOptions } from "@tanstack/react-query";

import type { Match } from "@/data/types";

import { getUpcomingGames } from "./upcoming-games.functions";

export const upcomingGamesQueryOptions = queryOptions<Match[]>({
  queryKey: ["upcoming-games"],
  queryFn: () => getUpcomingGames(),
  staleTime: 60_000,
});
