import { expect, test } from "bun:test";
import { createElement, type Context } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { withPublicRequestBoundary, withPublicFeedBoundary } from "../src/lib/public-error.server";
import { redirect, notFound } from "@tanstack/react-router";
import { HTTPError, HTTPResponse } from "h3";
import { __testing, getCachedPublicFeed, type FeedName } from "../src/lib/public-feed-cache.server";
import { listAirtableRecords } from "../src/lib/airtable.server";
import { describeDiagnostic, logServerError } from "../src/lib/server-diagnostics.server";
import { PUBLIC_ERROR_MESSAGE } from "../src/lib/public-error";
import { reportLovableError } from "../src/lib/lovable-error-reporting";
import "../src/lib/i18n";

const SECRET = "PRIVATE_TOKEN_https://user:password@internal.test/postgres?key=secret";
const hostile = new Proxy({}, {
  get() { throw new Error(SECRET); },
  has() { throw new Error(SECRET); },
  getPrototypeOf() { throw new Error(SECRET); },
});

test("diagnostics omit strings, arbitrary objects, causes, circular values and hostile accessors", () => {
  const circular: Record<string, unknown> = { password: SECRET };
  circular.self = circular;
  const values = [SECRET, circular, hostile, new Error(SECRET, { cause: new Error(SECRET) }),
    { name: SECRET, status: SECRET, toJSON() { throw new Error(SECRET); } }];
  for (const value of values) {
    const line = describeDiagnostic(value);
    expect(line).not.toContain(SECRET);
    expect(line.length).toBeLessThan(300);
    expect(JSON.parse(line).event).toBe("server_error");
  }
});

test("public boundary survives hostile errors and a failing logging sink", async () => {
  const saved = console.error;
  console.error = () => { throw new Error(SECRET); };
  try {
    for (const error of [hostile, new Error(SECRET)]) {
      try {
        await withPublicFeedBoundary("players", async () => { throw error; });
        throw new Error("expected rejection");
      } catch (safe) {
        expect((safe as Error).message).toBe(PUBLIC_ERROR_MESSAGE);
        expect((safe as Error).stack).toBe("");
        expect((safe as Error).cause).toBeUndefined();
        expect(Object.keys(safe as object)).toEqual([]);
      }
    }
  } finally { console.error = saved; }
});

async function thrownByRequest(error: unknown): Promise<unknown> {
  try { return await withPublicRequestBoundary(async () => { throw error; }); }
  catch (caught) { return caught; }
}

test("unexpected status-bearing errors retain status without original private details", async () => {
  for (const statusCode of [400, 401, 403, 429, 500, 503]) {
    const original = Object.assign(new Error(SECRET, { cause: new Error(SECRET) }), {
      statusCode, data: { password: SECRET }, headers: { authorization: SECRET }, detail: SECRET,
    });
    const safe = await thrownByRequest(original) as Error & { statusCode: number };
    expect(safe).not.toBe(original);
    expect(safe.statusCode).toBe(statusCode);
    expect(safe.message).toBe(PUBLIC_ERROR_MESSAGE);
    expect(safe.stack).toBe("");
    expect(safe.cause).toBeUndefined();
    expect(Object.getOwnPropertyNames(safe).sort()).toEqual(["message", "name", "stack", "statusCode"]);
    expect(JSON.stringify(safe, Object.getOwnPropertyNames(safe))).not.toContain(SECRET);
  }
  for (const error of [hostile, new Error(SECRET)]) {
    const response = await thrownByRequest(error) as Response;
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain(SECRET);
  }
  expect((await thrownByRequest({ statusCode: SECRET }) as { statusCode: number }).statusCode).toBe(500);
});

test("native responses and framework redirects/notFound/handled HTTP outcomes retain identity and semantics", async () => {
  const headers = { "x-control": "preserved", "set-cookie": "session=fixture; HttpOnly", "retry-after": "120" };
  const redirected = redirect({ href: "/players", statusCode: 307, headers });
  const missing = notFound({ routeId: "__root__", headers, data: { publicReason: "missing" } });
  const values = [
    redirected, missing,
    ...[200, 401, 403, 404, 429, 500].map(status => new Response("intentional body", { status, headers })),
    new HTTPResponse("intentional h3 body", { status: 202, headers }),
    ...[404, 503].map(status => new HTTPError({ status, message: "Intentional HTTP outcome", headers,
      data: { publicReason: "controlled" }, body: { publicCode: "expected" } })),
  ];
  for (const value of values) {
    expect(await withPublicRequestBoundary(async () => value)).toBe(value);
    expect(await thrownByRequest(value)).toBe(value);
    // The same control flow must also survive a server-function boundary.
    let caught: unknown;
    try { await withPublicFeedBoundary("players", async () => { throw value; }); }
    catch (error) { caught = error; }
    expect(caught).toBe(value);
    if (value instanceof Response) {
      expect(value.bodyUsed).toBe(false);
      expect(value.headers.get("x-control")).toBe("preserved");
      expect(value.headers.get("set-cookie")).toBe(headers["set-cookie"]);
      expect(value.headers.get("retry-after")).toBe("120");
      if (value !== redirected) expect(await value.text()).toBe("intentional body");
    }
  }
  expect(redirected.headers.get("location")).toBe("/players");
  expect(redirected.options.statusCode).toBe(307);
  expect(missing.data).toEqual({ publicReason: "missing" });
  expect(missing.routeId).toBe("__root__");
});

test("unhandled h3 errors and name-spoofed errors are sanitized", async () => {
  const internal = new HTTPError({ status: 503, unhandled: true, message: SECRET,
    headers: { authorization: SECRET }, data: { secret: SECRET }, body: { secret: SECRET } });
  const safe = await thrownByRequest(internal) as Error & { statusCode: number };
  expect(safe).not.toBe(internal);
  expect(safe.message).toBe(PUBLIC_ERROR_MESSAGE);
  expect(safe.statusCode).toBe(503);
  expect(JSON.stringify(safe, Object.getOwnPropertyNames(safe))).not.toContain(SECRET);
  const spoofed = Object.assign(new Error(SECRET), { name: "HTTPError", statusCode: 500 });
  expect((await thrownByRequest(spoofed) as Error).message).toBe(PUBLIC_ERROR_MESSAGE);
});

test("browser reporting forwards only a fresh generic error and fixed context", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  const reports: unknown[] = [];
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    location: { pathname: SECRET },
    __lovableEvents: { captureException: (...args: unknown[]) => reports.push(args) },
    __lovableReportRuntimeError: (payload: unknown) => reports.push(payload),
  } });
  try {
    reportLovableError(hostile, { source: SECRET, route: SECRET, secret: SECRET });
    expect(reports.length).toBe(2);
    const [error, context] = reports[0] as [Error, object];
    expect(error.message).toBe(PUBLIC_ERROR_MESSAGE);
    expect(error.stack).toBe("");
    expect(context).toEqual({ source: "react_error_boundary" });
    expect(reports[1]).toEqual({ message: PUBLIC_ERROR_MESSAGE });
    expect(JSON.stringify(reports)).not.toContain(SECRET);
  } finally {
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else Reflect.deleteProperty(globalThis, "window");
  }
});

test("all seven actual route error components ignore technical errors in English and Arabic", async () => {
  const source = await Bun.file("src/lib/i18n.tsx").text();
  const messages = [...source.matchAll(/"error\.generic": "([^"]+)"/g)].map((m) => m[1]!);
  const context = (globalThis as typeof globalThis & { __maaI18nContext: Context<unknown> }).__maaI18nContext;
  const savedFetch = globalThis.fetch;
  globalThis.fetch = (() => { throw new Error("No network allowed in rendering tests"); }) as typeof fetch;
  try {
    for (const path of ["players.index", "players.$playerId", "compare", "leaderboard", "records", "store", "upcoming-games"]) {
      const { Route } = await import(`../src/routes/${path}.tsx`);
      for (const [index, lang] of ["en", "ar"].entries()) {
        const html = renderToStaticMarkup(createElement(context.Provider, {
          value: { lang, dir: lang === "ar" ? "rtl" : "ltr", t: () => messages[index] },
        }, createElement(Route.options.errorComponent, { error: new Error(SECRET), reset() {} })));
        expect(html).toContain(messages[index]!);
        expect(html).not.toContain(SECRET);
        expect(html).toContain('role="alert"');
      }
    }
  } finally { globalThis.fetch = savedFetch; }
});

test("installed console wrapper sanitizes every argument, keeps bounded trusted metadata and capture lifecycle", async () => {
  const saved = console.error;
  const output: unknown[][] = [];
  console.error = (...args) => { output.push(args); };
  try {
    const { consumeLastCapturedError } = await import("../src/lib/error-capture");
    const original = new Error(SECRET);
    console.error(SECRET, { password: SECRET }, hostile, original, SECRET);
    expect(output.length).toBe(1);
    expect(output[0]!.length).toBe(4);
    expect(JSON.stringify(output)).not.toContain(SECRET);
    expect(JSON.stringify(output).length).toBeLessThan(1500);
    expect(consumeLastCapturedError()).toBe(original);
    expect(consumeLastCapturedError()).toBeUndefined();
    logServerError("airtable", "response", original, 429);
    const record = JSON.parse(output[1]![0] as string);
    expect(record.source).toBe("airtable");
    expect(record.status).toBe(429);
    expect(record.category).toBe("rate-limited");
    expect(record.ref).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.stringify(output)).not.toContain(SECRET);
  } finally { console.error = saved; }
});

test("actual request middleware preserves control flow, next results, order and CSRF semantics", async () => {
  const { startInstance } = await import("../src/start");
  const { requestMiddleware } = await startInstance.getOptions();
  expect(requestMiddleware!.length).toBe(2);
  const [errors, csrf] = requestMiddleware!.map(m => m.options.server!);
  for (const value of [redirect({ href: "/records" }), notFound(), new Response("deliberate", { status: 404 })]) {
    let caught: unknown;
    try { await errors!({ next: () => { throw value; } } as never); }
    catch (error) { caught = error; }
    expect(caught).toBe(value);
  }
  for (const handlerType of ["serverFn", "router"] as const) {
    for (const origin of ["same-origin", "cross-site"] as const) {
      let calls = 0;
      let inner: unknown;
      const success = new Response("intended result", { status: 202, headers: { "x-next": "kept" } });
      const result = await errors!({ next: async () => {
        inner = await csrf!({ handlerType,
          request: new Request("https://site.test/action", { headers: { "sec-fetch-site": origin } }),
          next: () => { calls++; return success; },
        } as never);
        return inner;
      } } as never);
      expect(result).toBe(inner);
      if (handlerType === "serverFn" && origin === "cross-site") {
        expect(calls).toBe(0);
        expect((result as Response).status).toBe(403);
        expect(await (result as Response).text()).toBe("Forbidden");
      } else {
        expect(calls).toBe(1);
        expect(result).toBe(success);
        expect(success.headers.get("x-next")).toBe("kept");
      }
    }
  }
});

// This file runs in its own process, separately from m1-errors.test.ts, which
// mocks the coordinator module. Here the actual CURRENT-HEAD H2 code runs.
const FEEDS: FeedName[] = ["players", "records", "store", "upcoming-games"];
type Scenario = {
  status: string;
  stored?: unknown;
  loadValue?: unknown[];
  lookup?: "http" | "json" | "network";
  upstream?: number | "network";
  expired?: boolean;
};

async function exerciseCache(feed: FeedName, scenario: Scenario, wrapped: boolean) {
  const savedFetch = globalThis.fetch;
  const savedDateNow = Date.now;
  const savedConsole = console.error;
  const envNames = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "LOVABLE_API_KEY", "AIRTABLE_API_KEY"];
  const savedEnv = envNames.map(key => process.env[key]);
  process.env.SUPABASE_URL = "https://coordinator.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_test_only";
  process.env.LOVABLE_API_KEY = "dummy-lovable-key";
  process.env.AIRTABLE_API_KEY = "dummy-airtable-key";
  const calls: Array<{ operation: string; args?: unknown }> = [];
  const events: string[] = [];
  const logs: unknown[] = [];
  let now = Date.parse("2026-09-09T12:00:00Z");
  const started = now - (scenario.expired ? 900_000 : 60_000);
  Date.now = () => now;
  let innerValue: unknown;
  let loadCalls = 0;
  __testing.setMode("production");
  __testing.setMonotonic(() => now);
  __testing.setSleep(async ms => { now += ms; });
  console.error = value => {
    logs.push(value);
    if ((value as { stage?: string })?.stage === "public-feed") events.push("public-error");
  };
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname === "coordinator.test") {
      if (url.pathname === "/rest/v1/airtable_public_cache") {
        calls.push({ operation: "select", args: url.search });
        if (scenario.lookup === "network") throw new Error(SECRET);
        if (scenario.lookup === "http") return new Response(SECRET, { status: 503 });
        if (scenario.lookup === "json") return new Response("not JSON: " + SECRET);
        return Response.json([{ payload: scenario.stored ?? null,
          refresh_started_at: new Date(started).toISOString(),
          fresh_until: new Date(started + 900_000).toISOString(),
        }], { headers: { date: new Date(now).toUTCString() } });
      }
      const fn = url.pathname.split("/").at(-1)!;
      const args = JSON.parse(String(init?.body));
      calls.push({ operation: fn, args });
      if (fn === "h2_get_or_claim") {
        if (scenario.status === "rpc-failure") return new Response(SECRET, { status: 503 });
        if (scenario.status === "fresh") return Response.json({ status: "fresh", fresh_for_ms: 10000, payload: scenario.stored });
        if (scenario.status === "stale-window") return Response.json({ status: "fresh", fresh_for_ms: 0 });
        if (scenario.status === "claimed" || scenario.status === "no-time") return Response.json({
          status: "claimed", lease_token: "fixture-token", refresh_deadline_ms: scenario.status === "no-time" ? 0 : 45000,
        });
        return Response.json({ status: scenario.status });
      }
      if (fn === "h2_take_page_permit") return Response.json({ status: "granted", usable_for_ms: 1000, refresh_deadline_ms: 45000 });
      if (fn === "h2_finish_refresh") return Response.json({ status: "published" });
      if (fn === "h2_fail_refresh") {
        events.push("cleanup");
        return Response.json({ status: "recorded", released: true });
      }
    }
    if (url.hostname === "connector-gateway.lovable.dev") {
      calls.push({ operation: "airtable" });
      if (scenario.upstream === "network") throw new TypeError(SECRET);
      return new Response(SECRET, { status: scenario.upstream as number, headers: { "retry-after": "120" } });
    }
    throw new Error("Unmocked host blocked");
  }) as typeof fetch;
  try {
    const run = async () => {
      innerValue = await getCachedPublicFeed(feed, async () => {
        loadCalls++;
        if (scenario.upstream) return listAirtableRecords("tblFixture");
        return scenario.loadValue ?? [{ id: "refreshed", nested: { value: 7 } }];
      });
      return innerValue;
    };
    let value: unknown;
    let error: unknown;
    try { value = await (wrapped ? withPublicFeedBoundary(feed, run) : run()); }
    catch (caught) { error = caught; }
    if (!error) expect(value).toBe(innerValue);
    expect(__testing.inFlightSize()).toBe(0);
    return { value, error, calls, loadCalls, events, logs };
  } finally {
    globalThis.fetch = savedFetch;
    Date.now = savedDateNow;
    console.error = savedConsole;
    __testing.resetSleep();
    __testing.resetMonotonic();
    __testing.setMode(undefined);
    envNames.forEach((key, i) => {
      if (savedEnv[i] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[i];
    });
  }
}

for (const feed of FEEDS) {
  test(`current H2 ${feed}: fresh, refreshed and still-fresh fallback preserve M1 payloads and calls`, async () => {
    const stored = [{ id: `${feed}-cached`, nameEn: "Visible", nameAr: "ظاهر", nested: { value: 12 } }];
    for (const status of ["fresh", "claimed", "busy", "backoff", "cooldown", "budget_exhausted", "disabled", "stale-window", "no-time", "unknown-status"]) {
      const scenario = { status, stored };
      const before = await exerciseCache(feed, scenario, false);
      const after = await exerciseCache(feed, scenario, true);
      expect(before.error).toBeUndefined();
      expect(after.error).toBeUndefined();
      expect(after.value).toEqual(before.value);
      expect(after.calls).toEqual(before.calls);
      expect(after.loadCalls).toBe(before.loadCalls);
      expect(after.logs).toEqual([]);
      if (status !== "claimed") {
        expect(after.value).toEqual(stored);
        expect(after.loadCalls).toBe(0);
        expect(after.calls.some(c => c.operation === "airtable" || c.operation === "h2_take_page_permit")).toBe(false);
      }
    }
  });

  test(`hard expiry ${feed}: every expired fallback rejects before M1 sanitization`, async () => {
    for (const status of ["busy", "backoff", "cooldown", "budget_exhausted", "disabled", "stale-window", "no-time", "unknown-status"]) {
      const scenario = { status, stored: [{ id: SECRET, nameEn: "Hidden", nameAr: "مخفي", balance: 100 }], expired: true };
      const before = await exerciseCache(feed, scenario, false);
      const after = await exerciseCache(feed, scenario, true);
      expect(before.error).toBeInstanceOf(Error);
      expect(after.value).toBeUndefined();
      expect((after.error as Error).message).toBe(PUBLIC_ERROR_MESSAGE);
      expect((after.error as Error).stack).toBe("");
      expect(after.calls).toEqual(before.calls);
      expect(after.loadCalls).toBe(0);
      expect(after.calls.some(c => c.operation === "airtable" || c.operation === "h2_take_page_permit")).toBe(false);
      expect(JSON.stringify(after.logs)).not.toContain(SECRET);
    }
  });

  test(`current H2 ${feed}: absent, empty, invalid and unreadable fallback still fails with sanitized error`, async () => {
    const scenarios: Scenario[] = [
      { status: "cooldown", stored: null }, { status: "cooldown", stored: [] },
      { status: "cooldown", stored: { private: SECRET } },
      ...(["http", "json", "network"] as const).map(lookup => ({ status: "cooldown", lookup })),
      { status: "rpc-failure" },
    ];
    for (const scenario of scenarios) {
      const before = await exerciseCache(feed, scenario, false);
      const after = await exerciseCache(feed, scenario, true);
      expect(before.error).toBeInstanceOf(Error);
      expect((after.error as Error).message).toBe(PUBLIC_ERROR_MESSAGE);
      expect((after.error as Error).stack).toBe("");
      expect((after.error as Error).cause).toBeUndefined();
      expect(Object.getOwnPropertyNames(after.error).sort()).toEqual(["message", "name", "stack"]);
      expect(after.calls).toEqual(before.calls);
      expect(after.loadCalls).toBe(0);
      expect(JSON.stringify(after.logs)).not.toContain(SECRET);
    }
  });
}

test("current H2 Players empty-refresh protection remains intact without changing other feeds", async () => {
  for (const feed of FEEDS) {
    for (const stored of [null, [], [{ id: "previous-non-empty" }]]) {
      const scenario = { status: "claimed", loadValue: [], stored };
      const before = await exerciseCache(feed, scenario, false);
      const after = await exerciseCache(feed, scenario, true);
      expect(after.error).toBeUndefined();
      expect(after.value).toEqual(before.value);
      expect(after.calls).toEqual(before.calls);
      const protectsPrevious = feed === "players" && stored !== null && stored.length > 0;
      expect(after.value).toEqual(protectsPrevious ? stored : []);
      expect(after.calls.some(c => c.operation === "h2_finish_refresh")).toBe(!protectsPrevious);
      expect(after.events.includes("cleanup")).toBe(protectsPrevious);
      expect(after.logs).toEqual([]);
    }
  }
});

test("expired Players empty-refresh protection fails after exactly one cleanup and is sanitized by M1", async () => {
  const scenario = { status: "claimed", loadValue: [], stored: [{ id: SECRET }], expired: true };
  const before = await exerciseCache("players", scenario, false);
  const after = await exerciseCache("players", scenario, true);
  expect(before.error).toBeInstanceOf(Error);
  expect(after.value).toBeUndefined();
  expect((after.error as Error).message).toBe(PUBLIC_ERROR_MESSAGE);
  expect((after.error as Error).stack).toBe("");
  expect(after.calls).toEqual(before.calls);
  expect(after.calls.map(c => c.operation)).toEqual(["h2_get_or_claim", "select", "h2_fail_refresh"]);
  expect(after.calls.at(-1)!.args).toMatchObject({ p_kind: "failure", p_retry_after_seconds: null });
  expect(after.events).toEqual(["cleanup", "public-error"]);
  expect(JSON.stringify(after.logs)).not.toContain(SECRET);
});

test("actual Airtable 429 reaches H2 rate-limit cleanup before public sanitization; other failures also preserve calls", async () => {
  for (const upstream of [400, 401, 403, 429, 500, 503, "network"] as const) {
    const scenario = { status: "claimed", upstream, stored: [{ id: "previous" }] };
    const before = await exerciseCache("records", scenario, false);
    const after = await exerciseCache("records", scenario, true);
    expect(after.calls).toEqual(before.calls);
    const cleanup = after.calls.filter(c => c.operation === "h2_fail_refresh");
    expect(cleanup.length).toBe(1);
    expect(cleanup[0]!.args).toMatchObject({ p_kind: upstream === 429 ? "rate_limited" : "failure",
      p_retry_after_seconds: upstream === 429 ? 120 : null });
    expect(after.events).toEqual(["cleanup", "public-error"]);
    expect(after.calls.map(c => c.operation)).toEqual(["h2_get_or_claim", "h2_take_page_permit", "airtable", "h2_fail_refresh"]);
    expect(after.value).toBeUndefined();
    expect((after.error as Error).message).toBe(PUBLIC_ERROR_MESSAGE);
    expect((after.error as Error).stack).toBe("");
    expect(JSON.stringify(after.logs)).not.toContain(SECRET);
  }
});
