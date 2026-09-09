import { QueryClient, dehydrate, hydrate } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import type { Player } from "./data/types";
import { routeTree } from "./routeTree.gen";

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
      const playersQuery = queryClient.getQueryCache().find({ queryKey: ["players"], exact: true });
      // Some route loaders start this query without awaiting it. Settle only
      // that existing request; never start a fetch from the hydration hook.
      try {
        await playersQuery?.promise;
      } catch {
        // Leave failures on their existing M1/route error path, out of hydration.
      }
      const state = dehydrate(queryClient, {
        shouldDehydrateMutation: () => false,
        shouldDehydrateQuery: (query) => query === playersQuery && query.state.status === "success",
      });
      return {
        playersQuery: {
          mutations: [],
          // Narrow Query's generic unknown/error/metadata types to this one
          // successful public feed. Never transfer errors, metadata or promises.
          queries: state.queries.map((query) => ({
            queryKey: query.queryKey as ["players"],
            queryHash: query.queryHash,
            dehydratedAt: query.dehydratedAt,
            state: { ...query.state, data: query.state.data as Player[], error: null, fetchFailureReason: null },
          })),
        },
      };
    },
    hydrate: (dehydrated) => {
      // Query's hydrate preserves dataUpdatedAt; freshness does not restart here.
      hydrate(queryClient, dehydrated?.playersQuery);
    },
  });

  return router;
};
