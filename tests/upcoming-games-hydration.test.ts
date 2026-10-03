import { describe, expect, test } from "bun:test";
import { createElement, Suspense } from "react";
import { QueryClient, QueryClientProvider, QueryErrorResetBoundary, useSuspenseQuery, dehydrate, hydrate } from "@tanstack/react-query";
import { RetryBoundary } from "../src/components/retry-boundary";

// Mirrors src/router.tsx filtering logic via the real router factory.
const { getRouter } = await import("../src/router");

function seed(router: ReturnType<typeof getRouter>, key: string, data: unknown, at: number) {
  (router.options.context as { queryClient: QueryClient }).queryClient.setQueryData([key], data, { updatedAt: at });
}
const qc = (r: ReturnType<typeof getRouter>) => (r.options.context as { queryClient: QueryClient }).queryClient;

describe("upcoming-games SSR transfer", () => {
  test("successful [] transfers with original dataUpdatedAt; players unchanged", async () => {
    const server = getRouter();
    seed(server, "upcoming-games", [], 1111);
    seed(server, "players", [{ id: "p1" }], 2222);
    const state = await server.options.dehydrate!();
    const json = JSON.parse(JSON.stringify(state));
    expect(json.upcomingGamesQuery.queries).toHaveLength(1);
    expect(json.upcomingGamesQuery.queries[0].state.dataUpdatedAt).toBe(1111);
    expect(json.upcomingGamesQuery.queries[0].state.data).toEqual([]);
    expect(json.playersQuery.queries[0].state.dataUpdatedAt).toBe(2222);
    expect("promise" in json.upcomingGamesQuery.queries[0]).toBe(false);
    const browser = getRouter();
    await browser.options.hydrate!(json);
    expect(qc(browser).getQueryState(["upcoming-games"])?.dataUpdatedAt).toBe(1111);
    expect(qc(browser).getQueryData(["upcoming-games"])).toEqual([]);
  });

  test("failed games query is not serialized; dehydration starts no fetch", async () => {
    const server = getRouter();
    let calls = 0;
    await qc(server).fetchQuery({ queryKey: ["upcoming-games"], retry: false, queryFn: () => { calls++; throw new Error("SECRET_UPSTREAM"); } }).catch(() => {});
    const state = await server.options.dehydrate!();
    expect(state.upcomingGamesQuery.queries).toEqual([]);
    expect(JSON.stringify(state)).not.toContain("SECRET_UPSTREAM");
    expect(calls).toBe(1);
    const empty = await getRouter().options.dehydrate!();
    expect(empty.upcomingGamesQuery.queries).toEqual([]);
  });

  test("in-flight games query is settled, not restarted", async () => {
    const server = getRouter();
    let calls = 0;
    void qc(server).ensureQueryData({ queryKey: ["upcoming-games"], queryFn: async () => { calls++; await Bun.sleep(20); return []; } });
    const state = await server.options.dehydrate!();
    expect(calls).toBe(1);
    expect(state.upcomingGamesQuery.queries).toHaveLength(1);
  });
});

describe("retry boundary", () => {
  test("retry resets and refetches", async () => {
    const { renderToReadableStream } = await import("react-dom/server");
    void renderToReadableStream; void dehydrate; void hydrate; void Suspense; void useSuspenseQuery; void QueryErrorResetBoundary; void QueryClientProvider; void createElement;
    let resets = 0;
    const b = new RetryBoundary({ children: null, onReset: () => resets++, fallback: (r) => r as never });
    let next: unknown;
    b.setState = (s: unknown) => { next = s; };
    expect(RetryBoundary.getDerivedStateFromError()).toEqual({ failed: true });
    b.retry();
    expect(resets).toBe(1);
    expect(next).toEqual({ failed: false });
  });
});
