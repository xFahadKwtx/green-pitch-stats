import { queryOptions } from "@tanstack/react-query";

import type { Player } from "@/data/types";

import { getPlayers } from "./players.functions";

export const playersQueryOptions = queryOptions<Player[]>({
  queryKey: ["players"],
  queryFn: () => getPlayers(),
  staleTime: 900_000,
});
