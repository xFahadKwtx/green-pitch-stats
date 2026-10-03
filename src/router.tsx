import { QueryClient, dehydrate, hydrate, type Query } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import type { Match, Player } from "./data/types";
import { routeTree } from "./routeTree.gen";

/** Public feeds whose already-started, successful query may cross SSR -> browser. */
function findQuery(queryClient: QueryClient, key: "players" | "upcoming-games") {
  return queryClient.getQueryCache().find({ queryKey: [key], exact: true });
}

/** Settle only an existing request; never start a fetch from the hydration hook. */
async function settle(query: Query | undefined) {
  try {
    await query?.promise;
  } catch {
    // Leave failures on their existing M1/route error path, out of hydration.
  }
}

/** Successful data only. Never transfer errors, metadata or promises. */
function safeState<K extends string, T>(queryClient: QueryClient, target: Query | undefined, key: K) {
  const state = dehydrate(queryClient, {
    shouldDehydrateMutation: () => false,
    shouldDehydrateQuery: (query) => query === target && query.state.status === "success",
  });
  return {
    mutations: [] as [],
    queries: state.queries.map((query) => ({
      queryKey: [key] as [K],
      queryHash: query.queryHash,
      dehydratedAt: query.dehydratedAt,
      state: { ...query.state, data: query.state.data as T, error: null, fetchFailureReason: null },
    })),
  };
}

export const getRouter = () => {
  const queryClient = new QueryClient();

  const router = createRouter({
    routeTree,
    context: { queryClient },
    scrollRestoration: true,
    defaultPreload: "intent",
    defaultPreloadDelay: 50,
    defaultPreloadStaleTime: 0,
    defaultStaleReloadMode: "background",
    dehydrate: async () => {
      const playersQuery = findQuery(queryClient, "players");
      const gamesQuery = findQuery(queryClient, "upcoming-games");
      // Some route loaders start these queries without awaiting them.
      await Promise.all([settle(playersQuery), settle(gamesQuery)]);
      return {
        playersQuery: safeState<"players", Player[]>(queryClient, playersQuery, "players"),
        upcomingGamesQuery: safeState<"upcoming-games", Match[]>(queryClient, gamesQuery, "upcoming-games"),
      };
    },
    hydrate: (dehydrated) => {
      // Query's hydrate preserves dataUpdatedAt; freshness does not restart here.
      hydrate(queryClient, dehydrated?.playersQuery);
      hydrate(queryClient, dehydrated?.upcomingGamesQuery);
    },
  });

  return router;
};
