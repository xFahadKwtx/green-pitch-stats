/** M9. Run separately from other module-mocking suites. No live upstream access. */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createElement } from "react";
import { renderToReadableStream } from "react-dom/server";
import { QueryClientProvider, QueryObserver, environmentManager } from "@tanstack/react-query";
import { createMemoryHistory, createRootRouteWithContext, Outlet, RouterProvider } from "@tanstack/react-router";
import { attachRouterServerSsrUtils } from "@tanstack/router-core/ssr/server";
import { hydrate as hydrateRouter } from "@tanstack/router-core/ssr/client";
import { runInNewContext } from "node:vm";
import { gzipSync } from "node:zlib";
import type { Player } from "../src/data/types";
import { __testing, FEED_TTL_SECONDS } from "../src/lib/public-feed-cache.server";
import { PUBLIC_ERROR_MESSAGE } from "../src/lib/public-error";

const savedFetch = globalThis.fetch;
const savedNow = Date.now;
const savedWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const savedDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
const envKeys = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"];
const savedEnv = envKeys.map(key => process.env[key]);
process.env.SUPABASE_URL = "https://m9-coordinator.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_test_only";
const SECRET = "M9_PRIVATE_UPSTREAM_DETAIL";
let now = Date.parse("2026-09-09T12:00:00Z");
let players: Player[] = [];
let feedCalls = 0;
let rpcCalls: string[] = [];
let gate: Promise<void> | undefined;
let upstreamFails = false;
let lang: "en" | "ar" = "en";
const routers: any[] = [];
const unsubscribers: Array<() => void> = [];
const measurements: Record<string, unknown> = {};

function player(id = "p1"): Player {
  return { id, name: `Player ${id}`, nameAr: `اللاعب ${id}`, positions: ["CM"],
    positionGroup: "MID", playsKeeper: false, playsOutfield: true,
    points: 1.25, last5Results: ["W", "D", "L"], stats: {} };
}

// The real getPlayers handler, H2 and M1 run. Only server-function transport is replaced.
mock.module("@tanstack/react-start", () => ({
  createServerFn: () => ({ handler: (run: (...args: unknown[]) => unknown) => (...args: unknown[]) => {
    feedCalls++; return run(...args);
  } }),
}));
mock.module("../src/lib/i18n", () => ({ useI18n: () => ({ lang, t: (key: string) => key }) }));
// Omit document shell/assets only. Keep the actual generated route tree, route
// loaders, Query observers, page components and Router serialization/hydration.
const root = createRootRouteWithContext<any>()({
  component: () => createElement(QueryClientProvider, { client: root.useRouteContext().queryClient }, createElement(Outlet)),
});
mock.module("../src/routes/__root", () => ({ Route: root }));
const { getRouter } = await import("../src/router");
const { playersQueryOptions: options } = await import("../src/lib/players-query");
const { Route: directory } = await import("../src/routes/players.index");
const { Route: profile } = await import("../src/routes/players.$playerId");
const { Route: compare } = await import("../src/routes/compare");
const { Route: leaderboard } = await import("../src/routes/leaderboard");

beforeEach(() => {
  now = Date.parse("2026-09-09T12:00:00Z"); players = [player()]; feedCalls = 0;
  rpcCalls = []; gate = undefined; upstreamFails = false; lang = "en";
  Date.now = () => now;
  environmentManager.setIsServer(() => true);
  __testing.setMode("production");
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname !== "m9-coordinator.test") throw new Error("Unmocked network is forbidden");
    rpcCalls.push(url.pathname);
    if (url.pathname !== "/rest/v1/rpc/h2_get_or_claim") throw new Error("Unexpected H2 operation");
    if (gate) await gate;
    if (upstreamFails) throw new Error(SECRET);
    return Response.json({ status: "fresh", fresh_for_ms: 900_000, payload: players });
  }) as typeof fetch;
});

function restoreBrowserGlobals() {
  if (savedWindow) Object.defineProperty(globalThis, "window", savedWindow); else Reflect.deleteProperty(globalThis, "window");
  if (savedDocument) Object.defineProperty(globalThis, "document", savedDocument); else Reflect.deleteProperty(globalThis, "document");
}
afterEach(() => {
  for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
  for (const router of routers.splice(0)) {
    router.options.context.queryClient.clear(); router.serverSsr?.cleanup();
  }
  __testing.setMode(undefined); environmentManager.setIsServer(() => true);
  restoreBrowserGlobals(); Date.now = savedNow;
});
afterAll(() => {
  globalThis.fetch = savedFetch; Date.now = savedNow; restoreBrowserGlobals();
  envKeys.forEach((key, i) => { if (savedEnv[i] === undefined) delete process.env[key]; else process.env[key] = savedEnv[i]; });
  console.log("M9 local measurements: " + JSON.stringify(measurements));
});

function routerAt(path = "/players", baseline = false) {
  const router = getRouter(); routers.push(router);
  router.update({ history: createMemoryHistory({ initialEntries: [path] }), isServer: true });
  if (baseline) router.update({ dehydrate: undefined, hydrate: undefined } as never);
  return router;
}
const clientOf = (router: any) => router.options.context.queryClient;
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
function observe(router: any) {
  environmentManager.setIsServer(() => false);
  const observer = new QueryObserver(clientOf(router), options);
  unsubscribers.push(observer.subscribe(() => {}));
  return observer;
}
function pending() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function render(router: any) {
  const stream = await renderToReadableStream(createElement(RouterProvider, { router }));
  return new Response(stream).text();
}

/** Run the installed Start/Router SSR serializer, not a hand-written JSON replacement. */
async function serverEntry(path = "/players", baseline = false) {
  const router = routerAt(path, baseline);
  attachRouterServerSsrUtils({ router, manifest: undefined });
  await router.load();
  await router.serverSsr!.dehydrate();
  const html = await render(router);
  router.serverSsr!.setRenderFinished();
  const scripts = router.serverSsr!.takeBufferedHtml()!;
  const sandbox: any = { document: { currentScript: { remove() {} } } };
  sandbox.self = sandbox; sandbox.window = sandbox;
  for (const script of scripts.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)) {
    runInNewContext(script[1]!, sandbox);
  }
  return { router, html, scripts, bootstrap: sandbox.$_TSR };
}

/** Actual Router client hydration restores loader data AND invokes the new hook. */
async function browserEntry(server: Awaited<ReturnType<typeof serverEntry>>, path = "/players", baseline = false) {
  const router = routerAt(path, baseline);
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    $_TSR: server.bootstrap, addEventListener() {}, removeEventListener() {}, location: { origin: "http://localhost" },
  } });
  Object.defineProperty(globalThis, "document", { configurable: true, value: { querySelector: () => null } });
  router.update({ isServer: false });
  environmentManager.setIsServer(() => false);
  await hydrateRouter(router);
  return router;
}

describe("real SSR serialization -> Router hydration -> page rendering", () => {
  for (const path of ["/players", "/compare", "/leaderboard", "/players/p1"]) {
    test(`${path}: one SSR Players call, successful state restored before render, no browser duplicate`, async () => {
      const server = await serverEntry(path);
      expect(feedCalls).toBe(1);
      const originalState = clientOf(server.router).getQueryState(options.queryKey);
      now += 20_000;
      const browser = await browserEntry(server, path);
      const hydratedState = clientOf(browser).getQueryState(options.queryKey);
      expect(hydratedState.status).toBe("success");
      expect(hydratedState.data).toEqual(players);
      expect(hydratedState.dataUpdatedAt).toBe(originalState.dataUpdatedAt);
      expect(hydratedState.dataUpdatedAt).toBe(now - 20_000);
      await render(browser); observe(browser); await tick();
      expect(feedCalls).toBe(1); expect(rpcCalls.length).toBe(1);
      expect(__testing.inFlightSize()).toBe(0);
      if (path.includes("p1")) {
        expect(browser.state.matches.at(-1)!.loaderData.player).toEqual(players[0]);
        expect(await render(browser)).toContain("1.25");
      }
    });
  }

  test("before/after: cold directory SSR entry and client consumption", async () => {
    const results = [];
    for (const baseline of [true, false]) {
      restoreBrowserGlobals(); environmentManager.setIsServer(() => true);
      const before = feedCalls;
      const server = await serverEntry("/players", baseline);
      const ssrCalls = feedCalls - before;
      const browser = await browserEntry(server, "/players", baseline);
      await render(browser);
      const total = feedCalls - before;
      results.push({ baseline, ssr: ssrCalls, browser: total - ssrCalls, total });
    }
    expect(results.map(r => r.total)).toEqual([2, 1]);
    measurements.coldDirectory = results;
  });

  test("before/after: direct Profile refresh then Compare", async () => {
    const results = [];
    for (const baseline of [true, false]) {
      restoreBrowserGlobals(); environmentManager.setIsServer(() => true);
      const before = feedCalls;
      const server = await serverEntry("/players/p1", baseline);
      const browser = await browserEntry(server, "/players/p1", baseline);
      await render(browser);
      expect(feedCalls - before).toBe(1);
      expect(browser.state.matches.at(-1)!.loaderData.player.id).toBe("p1");
      await compare.options.loader!({ context: browser.options.context } as never);
      await clientOf(browser).ensureQueryData(options);
      results.push({ baseline, ssr: 1, browser: feedCalls - before - 1, total: feedCalls - before });
    }
    expect(results.map(r => r.total)).toEqual([2, 1]);
    measurements.directProfileThenCompare = results;
  });

  for (const [label, from, to, destination] of [
    ["Directory -> Profile", "/players", "/players/p1", profile],
    ["Profile -> Directory", "/players/p1", "/players", directory],
    ["Profile -> Compare", "/players/p1", "/compare", compare],
    ["Players -> Leaderboard", "/players", "/leaderboard", leaderboard],
  ] as const) {
    test(`${label} reuses fresh hydrated Players data`, async () => {
      const server = await serverEntry(from); const browser = await browserEntry(server, from);
      const before = feedCalls;
      const loaderData = await destination.options.loader!({ context: browser.options.context, params: { playerId: "p1" } } as never);
      if (to.includes("p1")) expect((loaderData as any).player).toEqual(players[0]);
      else observe(browser);
      await tick(); expect(feedCalls).toBe(before);
      expect(clientOf(browser).getQueryCache().getAll().map((q: any) => q.queryKey)).toEqual([["players"]]);
    });
  }

  test("normal already-fresh navigation: zero additional calls before and after", async () => {
    const counts = [];
    for (const baseline of [true, false]) {
      const router = routerAt("/players", baseline);
      clientOf(router).setQueryData(options.queryKey, players);
      const before = feedCalls;
      for (const route of [directory, profile, compare, leaderboard, directory]) {
        await route.options.loader!({ context: router.options.context, params: { playerId: "p1" } } as never);
      }
      observe(router); await tick(); counts.push(feedCalls - before);
    }
    expect(counts).toEqual([0, 0]); measurements.freshNavigationAdditionalCalls = { before: counts[0], after: counts[1] };
  });

  test("English/Arabic rerenders preserve the hydrated query and generate no request", async () => {
    const server = await serverEntry(); const browser = await browserEntry(server);
    for (const language of ["en", "ar", "en"] as const) {
      lang = language; const html = await render(browser);
      expect(html).toContain(language === "en" ? players[0]!.name : players[0]!.nameAr);
      expect(feedCalls).toBe(1);
    }
  });
});

describe("unchanged client freshness and coalescing", () => {
  for (const age of [0, 59_999, 60_000, 60_001, 120_000]) {
    test(`hydration age ${age}ms preserves timestamps and normal mount refetch`, async () => {
      const server = routerAt(); await clientOf(server).ensureQueryData(options);
      const stamp = now; const dehydrated = await server.options.dehydrate!();
      now += age;
      const browser = routerAt(); await browser.options.hydrate!(dehydrated);
      expect(clientOf(browser).getQueryState(options.queryKey).dataUpdatedAt).toBe(stamp);
      expect(feedCalls).toBe(1);
      const observer = observe(browser); await tick();
      expect(feedCalls).toBe(age >= 60_000 ? 2 : 1);
      expect(observer.getCurrentResult().data).toEqual(players);
    });
  }
  test("stale Profile loader still returns cached data without adding an observer/refetch", async () => {
    const server = routerAt(); await clientOf(server).ensureQueryData(options);
    const state = await server.options.dehydrate!(); now += 61_000;
    const browser = routerAt(); await browser.options.hydrate!(state);
    const result = await profile.options.loader!({ context: browser.options.context, params: { playerId: "p1" } } as never);
    expect((result as any).player).toEqual(players[0]); expect(feedCalls).toBe(1);
    expect(clientOf(browser).getQueryCache().find({ queryKey: options.queryKey }).getObserversCount()).toBe(0);
  });
  for (const trigger of ["focus", "reconnect"] as const) {
    test(`${trigger} eligibility remains disabled while fresh and enabled when stale`, async () => {
      const server = routerAt(); await clientOf(server).ensureQueryData(options);
      const browser = routerAt(); await browser.options.hydrate!(await server.options.dehydrate!());
      const observer = observe(browser);
      const check = () => trigger === "focus" ? observer.shouldFetchOnWindowFocus() : observer.shouldFetchOnReconnect();
      expect(check()).toBe(false); now += 60_001; expect(check()).toBe(true);
      const query = clientOf(browser).getQueryCache().find({ queryKey: options.queryKey });
      if (trigger === "focus") query.onFocus(); else query.onOnline();
      await tick(); expect(feedCalls).toBe(2);
    });
  }
  test("preload/loader/observer overlap still shares one pending Players request", async () => {
    const router = routerAt(); const pendingFetch = pending(); gate = pendingFetch.promise;
    const preload = clientOf(router).ensureQueryData(options);
    directory.options.loader!({ context: router.options.context } as never);
    compare.options.loader!({ context: router.options.context } as never);
    const observer = observe(router);
    const fetching = observer.fetchOptimistic(options);
    const dehydrating = router.options.dehydrate!();
    await tick();
    expect(feedCalls).toBe(1); expect(rpcCalls.length).toBe(1);
    pendingFetch.resolve(); await Promise.all([preload, fetching, dehydrating]);
    expect(feedCalls).toBe(1); expect(__testing.inFlightSize()).toBe(0);
  });
  test("hydration does not replace newer browser data", async () => {
    const server = routerAt(); await clientOf(server).ensureQueryData(options);
    const state = await server.options.dehydrate!(); now += 1000;
    const browser = routerAt(); const newer = [player("newer")]; clientOf(browser).setQueryData(options.queryKey, newer);
    await browser.options.hydrate!(state);
    expect(clientOf(browser).getQueryData(options.queryKey)).toEqual(newer);
    expect(clientOf(browser).getQueryState(options.queryKey).dataUpdatedAt).toBe(now);
  });
  test("query and router defaults are not changed", () => {
    const router = routerAt();
    expect(options.queryKey).toEqual(["players"]); expect(options.staleTime).toBe(60_000);
    expect(clientOf(router).getDefaultOptions()).toEqual({});
    for (const key of ["gcTime", "refetchOnMount", "refetchOnWindowFocus", "refetchOnReconnect", "retry", "initialData", "placeholderData"]) {
      expect(key in options).toBe(false);
    }
    expect(router.options.defaultPreload).toBe("intent"); expect(router.options.defaultPreloadDelay).toBe(50);
    expect(router.options.defaultPreloadStaleTime).toBe(0); expect(router.options.defaultStaleReloadMode).toBe("background");
    environmentManager.setIsServer(() => false);
    clientOf(router).setQueryData(options.queryKey, players);
    expect(clientOf(router).getQueryCache().find({ queryKey: options.queryKey }).gcTime).toBe(300_000);
    expect(FEED_TTL_SECONDS).toBe(900);
  });
});

describe("pending, failed and unrelated SSR state", () => {
  test("pending Players query settles before serialization without another fetch", async () => {
    const router = routerAt(); const pendingFetch = pending(); gate = pendingFetch.promise;
    const loading = clientOf(router).ensureQueryData(options);
    let settled = false;
    const dehydration = router.options.dehydrate!().then(state => { settled = true; return state; });
    await tick(); expect(settled).toBe(false); expect(feedCalls).toBe(1);
    now += 700; pendingFetch.resolve(); await loading;
    const state = await dehydration;
    expect(state.playersQuery.queries.length).toBe(1);
    expect(state.playersQuery.queries[0]!.state.status).toBe("success");
    expect(state.playersQuery.queries[0]!.state.dataUpdatedAt).toBe(now);
    expect("promise" in state.playersQuery.queries[0]!).toBe(false);
  });
  test("no Players query means no fetch and empty hydration state", async () => {
    const router = routerAt("/contact"); const state = await router.options.dehydrate!();
    expect(state).toEqual({ playersQuery: { mutations: [], queries: [] } });
    expect(feedCalls).toBe(0); expect(rpcCalls).toEqual([]);
    expect(clientOf(router).getQueryCache().getAll()).toEqual([]);
  });
  test("pending Players failure stays on the M1 path and never becomes hydrated data", async () => {
    const router = routerAt(); upstreamFails = true; const pendingFetch = pending(); gate = pendingFetch.promise;
    const savedError = console.error; const logged: unknown[] = []; console.error = (...args) => logged.push(args);
    try {
      const loading = clientOf(router).ensureQueryData(options).catch((error: Error) => error);
      const dehydration = router.options.dehydrate!();
      pendingFetch.resolve(); const error = await loading; const state = await dehydration;
      expect(error.message).toBe(PUBLIC_ERROR_MESSAGE); expect(error.stack).toBe("");
      expect(state.playersQuery.queries).toEqual([]); expect(JSON.stringify(state)).not.toContain(SECRET);
      expect(clientOf(router).getQueryState(options.queryKey).status).toBe("error");
      expect(logged.length).toBeGreaterThan(0); expect(feedCalls).toBe(1); expect(__testing.inFlightSize()).toBe(0);
      const browser = routerAt(); await browser.options.hydrate!(state);
      expect(clientOf(browser).getQueryData(options.queryKey)).toBeUndefined();
    } finally { console.error = savedError; }
  });
  test("a pre-existing failed query with old data is excluded", async () => {
    const router = routerAt(); const client = clientOf(router); client.setQueryData(options.queryKey, players);
    client.getQueryCache().find({ queryKey: options.queryKey }).setState({ status: "error", error: new Error(SECRET), fetchFailureReason: new Error(SECRET) });
    const state = await router.options.dehydrate!();
    expect(state.playersQuery.queries).toEqual([]); expect(JSON.stringify(state)).not.toContain(SECRET); expect(feedCalls).toBe(0);
  });
  test("only exact successful Players is serialized; unrelated queries, metadata and mutations are excluded", async () => {
    const router = routerAt(); const client = clientOf(router);
    client.setQueryData(options.queryKey, players);
    for (const key of [["records"], ["store"], ["upcoming-games"], ["players", "p1"], ["Players"], ["private"]]) client.setQueryData(key, SECRET);
    client.getQueryCache().find({ queryKey: options.queryKey, exact: true }).setOptions({ ...options, meta: { secret: SECRET } });
    const mutation = client.getMutationCache().build(client, { mutationKey: [SECRET] });
    mutation.state.isPaused = true; mutation.state.error = new Error(SECRET);
    const unrelated = pending(); const work = client.fetchQuery({ queryKey: ["unrelated-pending"], queryFn: async () => { await unrelated.promise; return "unrelated"; } });
    const state = await router.options.dehydrate!();
    expect(state.playersQuery.mutations).toEqual([]);
    expect(state.playersQuery.queries.map(q => q.queryKey)).toEqual([["players"]]);
    expect(JSON.stringify(state)).not.toContain(SECRET);
    expect("meta" in state.playersQuery.queries[0]!).toBe(false);
    expect("promise" in state.playersQuery.queries[0]!).toBe(false);
    expect(state.playersQuery.queries[0]!.state.error).toBeNull();
    expect(state.playersQuery.queries[0]!.state.fetchFailureReason).toBeNull();
    unrelated.resolve(); await work.catch(() => {});
    const browser = routerAt(); await browser.options.hydrate!(state);
    expect(clientOf(browser).getQueryCache().getAll().map((q: any) => q.queryKey)).toEqual([["players"]]);
  });
  test("empty successful Players data is hydrated normally", async () => {
    players = []; const server = routerAt(); await clientOf(server).ensureQueryData(options);
    const browser = routerAt(); await browser.options.hydrate!(await server.options.dehydrate!());
    expect(clientOf(browser).getQueryData(options.queryKey)).toEqual([]);
    observe(browser); await tick(); expect(feedCalls).toBe(1);
  });
  test("separate SSR requests and browser routers have isolated QueryClients", async () => {
    const first = routerAt(); const second = routerAt(); const browser = routerAt();
    expect(clientOf(first)).not.toBe(clientOf(second)); expect(clientOf(first)).not.toBe(clientOf(browser));
    clientOf(first).setQueryData(options.queryKey, [player("first")]);
    expect(clientOf(second).getQueryData(options.queryKey)).toBeUndefined();
    clientOf(second).setQueryData(options.queryKey, [player("second")]);
    const state = await first.options.dehydrate!(); await browser.options.hydrate!(state);
    expect(clientOf(browser).getQueryData(options.queryKey)[0].id).toBe("first");
    expect(clientOf(second).getQueryData(options.queryKey)[0].id).toBe("second");
    expect(feedCalls).toBe(0);
  });
  test("successful public text safely round-trips through Start's serializer", async () => {
    players[0]!.name = '</script><script>throw "unsafe"</script>';
    const server = await serverEntry();
    expect(server.scripts).not.toContain(players[0]!.name);
    const browser = await browserEntry(server);
    expect(clientOf(browser).getQueryData(options.queryKey)[0].name).toBe(players[0]!.name);
    expect(feedCalls).toBe(1);
  });
});

describe("local SSR timing and payload measurements", () => {
  test("wait adds only the remaining existing request delay; settled state does not refetch", async () => {
    const router = routerAt(); const pendingFetch = pending(); gate = pendingFetch.promise;
    const loading = clientOf(router).ensureQueryData(options);
    const start = performance.now(); const dehydration = router.options.dehydrate!();
    await new Promise(resolve => setTimeout(resolve, 25)); pendingFetch.resolve();
    await Promise.all([loading, dehydration]); const pendingMs = performance.now() - start;
    const settledStart = performance.now(); await router.options.dehydrate!();
    measurements.dehydrationTimingMs = { simulatedRequestDelay: 25, pending: pendingMs, alreadySettled: performance.now() - settledStart };
    expect(feedCalls).toBe(1); expect(rpcCalls.length).toBe(1);
  });
  for (const count of [1, 122]) {
    test(`serialized SSR script size: ${count} synthetic players`, async () => {
      players = Array.from({ length: count }, (_, i) => player(`p${i + 1}`));
      const sizes = [];
      for (const baseline of [true, false]) {
        restoreBrowserGlobals(); environmentManager.setIsServer(() => true);
        const result = await serverEntry("/players", baseline);
        sizes.push({ baseline, rawBytes: Buffer.byteLength(result.scripts), gzipBytes: gzipSync(result.scripts).length });
      }
      expect(sizes[1]!.rawBytes).toBeGreaterThan(sizes[0]!.rawBytes);
      measurements[`ssrScriptBytes_${count}_syntheticPlayers`] = sizes;
    });
  }
});
