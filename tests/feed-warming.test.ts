/**
 * Focused tests for scheduled active warming of the Players/Store feeds.
 *
 *   bun test tests/feed-warming.test.ts
 *
 * All coordinator (PostgREST) traffic is mocked and no Airtable call is made:
 * the loader passed to warmPublicFeed stands in for the real fetchers. No real
 * secret value is used and nothing is logged.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { handleWarmFeedsRequest } from "../src/routes/api/public/warm-feeds";
import {
  REFRESH_AHEAD_WINDOW_MS,
  WARM_MIN_FRESH_MS,
  __testing,
  getCachedPublicFeed,
  runAirtablePage,
  verifyWarmToken,
  warmPublicFeed,
} from "../src/lib/public-feed-cache.server";

process.env["SUPABASE_URL"] = "http://coordinator.test";
process.env["SUPABASE_SERVICE_ROLE_KEY"] = "sb_secret_dummy_test_value";

const VALID_TOKEN = "a".repeat(64);
const TICK_MS = 600_000;

interface Call {
  fn: string;
  args: Record<string, unknown>;
}

/** A stored cache row as PostgREST would return it. */
interface StoredRow {
  payload: unknown[];
  refresh_started_at: string;
  fresh_until: string;
}

let calls: Call[] = [];
let claimStatus: string;
/** Remaining freshness of the cached entry, as the coordinator would see it. */
let cacheRemainingMs: number | null;
let finishStatus: string;
let permitStatuses: string[];
let loadShouldFail: boolean;
let loaderPayload: unknown[];
let storedRow: StoredRow | null;
let storedRowSnapshot: string | null;
let airtableCalls: number;
let airtableShouldFail: boolean;
let realFetch: typeof fetch;

function freshStoredRow(remainingMs: number): StoredRow {
  const now = Date.now();
  return {
    payload: [{ id: "old" }],
    refresh_started_at: new Date(now - (900_000 - remainingMs)).toISOString(),
    fresh_until: new Date(now + remainingMs).toISOString(),
  };
}

function expiredStoredRow(): StoredRow {
  const now = Date.now();
  return {
    payload: [{ id: "old" }],
    refresh_started_at: new Date(now - 1_000_000).toISOString(),
    fresh_until: new Date(now - 100_000).toISOString(),
  };
}

function install() {
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);

    // Anything that is not the coordinator stands in for Airtable.
    if (!url.startsWith("http://coordinator.test")) {
      airtableCalls += 1;
      if (airtableShouldFail) throw new Error("upstream unreachable");
      return new Response(JSON.stringify({ records: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    // Read-only stored-payload lookup used by the empty-overwrite protection.
    if (url.includes("/rest/v1/airtable_public_cache")) {
      calls.push({ fn: "select_cache", args: {} });
      return new Response(JSON.stringify(storedRow ? [storedRow] : []), {
        status: 200,
        headers: {
          "content-type": "application/json",
          // Server Date is required for the freshness derivation.
          date: new Date().toUTCString(),
        },
      });
    }

    const fn = url.split("/rpc/")[1] ?? "";
    const args = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    calls.push({ fn, args });

    let body: unknown;
    if (fn === "h2_verify_warm_token") {
      body = { authorized: args["p_token"] === VALID_TOKEN };
    } else if (fn === "h2_get_or_claim_ahead" || fn === "h2_get_or_claim") {
      // Mirror the SQL freshness comparison when a remaining lifetime is set.
      const minFresh = Number(args["p_min_fresh_ms"] ?? 0);
      const effective =
        cacheRemainingMs === null
          ? claimStatus
          : cacheRemainingMs > minFresh
            ? "fresh"
            : "claimed";
      body =
        effective === "claimed"
          ? {
              status: "claimed",
              lease_token: "00000000-0000-4000-8000-000000000001",
              refresh_deadline_ms: 45_000,
            }
          : effective === "fresh"
            ? {
                status: "fresh",
                payload: [{ id: "cached" }],
                fresh_for_ms: cacheRemainingMs ?? 900_000,
              }
            : { status: effective };
    } else if (fn === "h2_take_page_permit") {
      const status = permitStatuses.length > 1 ? permitStatuses.shift()! : permitStatuses[0]!;
      body =
        status === "granted"
          ? { status: "granted", usable_for_ms: 1_000, refresh_deadline_ms: 40_000 }
          : status === "paced"
            ? { status: "paced", wait_ms: 500 }
            : { status };
    } else if (fn === "h2_finish_refresh") {
      body = { status: finishStatus };
    } else if (fn === "h2_fail_refresh") {
      body = { status: "recorded" };
    } else {
      body = {};
    }
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

async function post(): Promise<Response> {
  return handleWarmFeedsRequest(
    new Request("http://localhost/api/public/warm-feeds", {
      method: "POST",
      headers: { "x-warm-token": VALID_TOKEN },
    }),
  );
}

const loader = async () => {
  if (loadShouldFail) throw new Error("upstream boom");
  return loaderPayload;
};

/** A loader that legitimately dispatches one paginated Airtable page. */
const pagedLoader = async () =>
  runAirtablePage("tblTest", "page-1", async () => {
    await fetch("https://api.airtable.test/v0/base/tblTest");
    return loaderPayload;
  });

beforeEach(() => {
  calls = [];
  claimStatus = "claimed";
  cacheRemainingMs = null;
  finishStatus = "published";
  permitStatuses = ["granted"];
  loadShouldFail = false;
  loaderPayload = [{ id: "p001" }];
  storedRow = null;
  storedRowSnapshot = null;
  airtableCalls = 0;
  airtableShouldFail = false;
  __testing.setMode("production");
  install();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  __testing.setMode(undefined);
  __testing.resetRefreshAhead();
});

describe("warming authorization", () => {
  test("a matching token is authorized and a wrong one is denied", async () => {
    expect(await verifyWarmToken(VALID_TOKEN)).toBe(true);
    expect(await verifyWarmToken("b".repeat(64))).toBe(false);
    // The secret itself is never sent back to the caller.
    expect(calls.every((c) => c.fn === "h2_verify_warm_token")).toBe(true);
  });
});

describe("warmPublicFeed", () => {
  test("claimed + accepted publication reports published", async () => {
    expect(await warmPublicFeed("players", loader)).toBe("published");
    const claim = calls.find((c) => c.fn === "h2_get_or_claim_ahead")!;
    expect(claim.args["p_cache_key"]).toBe("production:players");
    expect(claim.args["p_min_fresh_ms"]).toBe(WARM_MIN_FRESH_MS);
    expect(calls.some((c) => c.fn === "h2_finish_refresh")).toBe(true);
  });

  test("a still-fresh payload outside the warming window is skipped", async () => {
    claimStatus = "fresh";
    expect(await warmPublicFeed("store", loader)).toBe("skipped");
    // No refresh, no Airtable permit, no publication.
    expect(calls.some((c) => c.fn === "h2_take_page_permit")).toBe(false);
    expect(calls.some((c) => c.fn === "h2_finish_refresh")).toBe(false);
  });

  test("Store is refreshed before expiry, one tick ahead", async () => {
    cacheRemainingMs = TICK_MS;
    expect(await warmPublicFeed("store", loader)).toBe("published");
    const claim = calls.find((c) => c.fn === "h2_get_or_claim_ahead")!;
    expect(claim.args["p_cache_key"]).toBe("production:store");
    expect(claim.args["p_min_fresh_ms"]).toBe(WARM_MIN_FRESH_MS);
  });

  test("an overlapping refresh (busy lease) is skipped, never duplicated", async () => {
    claimStatus = "busy";
    expect(await warmPublicFeed("players", loader)).toBe("skipped");
    expect(calls.filter((c) => c.fn === "h2_get_or_claim_ahead").length).toBe(1);
    expect(calls.some((c) => c.fn === "h2_finish_refresh")).toBe(false);
  });

  test("concurrent warming of one feed makes a single claim", async () => {
    const [a, b] = await Promise.all([
      warmPublicFeed("players", loader),
      warmPublicFeed("players", loader),
    ]);
    expect([a, b].filter((r) => r === "published").length).toBe(1);
    expect([a, b].filter((r) => r === "skipped").length).toBe(1);
    expect(calls.filter((c) => c.fn === "h2_get_or_claim_ahead").length).toBe(1);
  });

  test("cooldown, backoff and budget denials are skipped without refreshing", async () => {
    for (const status of ["cooldown", "backoff", "budget_exhausted", "disabled"]) {
      calls = [];
      claimStatus = status;
      expect(await warmPublicFeed("players", loader)).toBe("skipped");
      expect(calls.some((c) => c.fn === "h2_take_page_permit")).toBe(false);
    }
  });

  test("every warmed Airtable page still goes through a permit", async () => {
    expect(await warmPublicFeed("players", pagedLoader)).toBe("published");
    expect(calls.filter((c) => c.fn === "h2_take_page_permit").length).toBe(1);
    expect(airtableCalls).toBe(1);
  });

  test("permit pacing is honoured before the next dispatch", async () => {
    const waits: number[] = [];
    __testing.setSleep(async (ms) => {
      waits.push(ms);
    });
    permitStatuses = ["paced", "granted"];
    expect(await warmPublicFeed("players", pagedLoader)).toBe("published");
    __testing.resetSleep();
    expect(waits).toEqual([500]);
    expect(calls.filter((c) => c.fn === "h2_take_page_permit").length).toBe(2);
    expect(airtableCalls).toBe(1);
  });

  test("permit-level budget and cooldown denials fail the warm without dispatching", async () => {
    for (const status of ["budget_exhausted", "cooldown", "stale_lease"]) {
      calls = [];
      airtableCalls = 0;
      permitStatuses = [status];
      expect(await warmPublicFeed("players", pagedLoader)).toBe("failed");
      expect(airtableCalls).toBe(0);
      expect(calls.some((c) => c.fn === "h2_finish_refresh")).toBe(false);
      expect(calls.some((c) => c.fn === "h2_fail_refresh")).toBe(true);
    }
  });

  test("an upstream failure reports failed and never masquerades as published", async () => {
    loadShouldFail = true;
    expect(await warmPublicFeed("players", loader)).toBe("failed");
    expect(calls.some((c) => c.fn === "h2_finish_refresh")).toBe(false);
    expect(calls.some((c) => c.fn === "h2_fail_refresh")).toBe(true);
  });

  test("a rejected publication reports failed", async () => {
    finishStatus = "stale_lease";
    expect(await warmPublicFeed("players", loader)).toBe("failed");
    expect(calls.some((c) => c.fn === "h2_fail_refresh")).toBe(true);
  });

  test("the previous-payload fallback can never be reported as published", async () => {
    // The fallback is only reachable on an EMPTY players refresh, so the loader
    // must return []. A still-fresh previous payload would be handed to a
    // visitor, but warming must report failed and leave the cache untouched.
    loaderPayload = [];
    for (const row of [freshStoredRow(300_000), expiredStoredRow()]) {
      calls = [];
      storedRow = row;
      storedRowSnapshot = JSON.stringify(row);
      expect(await warmPublicFeed("players", loader)).toBe("failed");
      // The protection actually ran, and cleanup was recorded.
      expect(calls.some((c) => c.fn === "select_cache")).toBe(true);
      expect(calls.some((c) => c.fn === "h2_fail_refresh")).toBe(true);
      // The empty payload was never published, so the valid row and its
      // freshness are unmodified.
      expect(calls.some((c) => c.fn === "h2_finish_refresh")).toBe(false);
      expect(JSON.stringify(storedRow)).toBe(storedRowSnapshot);
    }
  });

  test("only players and store are warmed", async () => {
    expect(await warmPublicFeed("records", loader)).toBe("skipped");
    expect(await warmPublicFeed("upcoming-games", loader)).toBe("skipped");
    expect(calls.length).toBe(0);
  });

  test("non-production environments are never warmed", async () => {
    __testing.setMode("development");
    expect(await warmPublicFeed("players", loader)).toBe("skipped");
    __testing.setMode("something-else");
    expect(await warmPublicFeed("players", loader)).toBe("skipped");
    expect(calls.length).toBe(0);
  });

  test("threshold bridges the next ~10min tick: 420000/600000/660000 refresh now", async () => {
    // Behavioural: a cache whose remaining freshness would run out before the
    // next tick (600000 ms later) must be refreshed by THIS tick.
    for (const remaining of [420_000, 600_000, 660_000]) {
      calls = [];
      cacheRemainingMs = remaining;
      expect(await warmPublicFeed("players", loader)).toBe("published");
    }
  });

  test("just outside the window is skipped but survives the next tick with margin", async () => {
    cacheRemainingMs = 660_001;
    expect(await warmPublicFeed("players", loader)).toBe("skipped");
    // One tick later it is still fresh (60001 ms of margin left, never expired)
    // and is refreshed then.
    const afterNextTick = 660_001 - TICK_MS;
    expect(afterNextTick).toBeGreaterThan(0);
    cacheRemainingMs = afterNextTick;
    expect(await warmPublicFeed("players", loader)).toBe("published");
  });

  test("a cache refreshed between ticks is skipped once, then warmed, never expiring", async () => {
    // Freshly refreshed by a visitor right after a tick.
    cacheRemainingMs = 900_000;
    expect(await warmPublicFeed("players", loader)).toBe("skipped");
    let remaining = 900_000;
    // Walk several ticks; the cache must never reach zero remaining freshness.
    for (let i = 0; i < 6; i++) {
      remaining -= TICK_MS;
      expect(remaining).toBeGreaterThan(0);
      cacheRemainingMs = remaining;
      const outcome = await warmPublicFeed("players", loader);
      if (outcome === "published") remaining = 900_000;
      else expect(outcome).toBe("skipped");
    }
  });

  test("an unknown coordinator answer is failed, recognized denials stay skipped", async () => {
    claimStatus = "something_new";
    expect(await warmPublicFeed("players", loader)).toBe("failed");
    claimStatus = "";
    expect(await warmPublicFeed("players", loader)).toBe("failed");
    for (const status of ["fresh", "busy", "backoff", "cooldown", "budget_exhausted", "disabled"]) {
      claimStatus = status;
      expect(await warmPublicFeed("players", loader)).toBe("skipped");
    }
  });
});

describe("visitor behaviour while warming runs", () => {
  test("a fresh stored payload is served while a warm refresh holds the lease", async () => {
    // The visitor's own claim is denied (cooldown) and the stored entry is
    // still fresh: it is served without any refresh of its own.
    claimStatus = "cooldown";
    storedRow = freshStoredRow(300_000);
    const data = await getCachedPublicFeed<unknown[]>("players", loader);
    expect(data).toEqual([{ id: "old" }]);
    expect(calls.some((c) => c.fn === "h2_finish_refresh")).toBe(false);
  });

  test("an expired stored payload is never served", async () => {
    claimStatus = "cooldown";
    storedRow = expiredStoredRow();
    await expect(getCachedPublicFeed("players", loader)).rejects.toThrow();
  });

  test("the passive 120s refresh-ahead window is unchanged for visitors", async () => {
    // Fresh, inside the visitor refresh-ahead window.
    claimStatus = "fresh";
    cacheRemainingMs = REFRESH_AHEAD_WINDOW_MS - 1_000;
    const data = await getCachedPublicFeed<unknown[]>("players", loader);
    expect(data).toEqual([{ id: "cached" }]);
    await __testing.settleRefreshAhead();
    const ahead = calls.filter((c) => c.fn === "h2_get_or_claim_ahead");
    expect(ahead.length).toBe(1);
    expect(ahead[0]!.args["p_min_fresh_ms"]).toBe(REFRESH_AHEAD_WINDOW_MS);
    expect(REFRESH_AHEAD_WINDOW_MS).toBe(120_000);
  });
});

describe("warming endpoint authorization and status codes", () => {
  test("a missing or invalid token is denied and no work is started", async () => {
    for (const headers of [{}, { "x-warm-token": "b".repeat(64) }]) {
      calls = [];
      airtableCalls = 0;
      const res = await handleWarmFeedsRequest(
        new Request("http://localhost/api/public/warm-feeds", { method: "POST", headers }),
      );
      expect(res.status).toBe(401);
      expect(calls.some((c) => c.fn === "h2_get_or_claim_ahead")).toBe(false);
      expect(airtableCalls).toBe(0);
    }
  });

  test("a non-production environment is denied even with a valid token", async () => {
    __testing.setMode("development");
    const res = await post();
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ status: "not_production" });
    expect(calls.some((c) => c.fn === "h2_get_or_claim_ahead")).toBe(false);
    expect(airtableCalls).toBe(0);
  });

  test("valid skips return 200", async () => {
    claimStatus = "fresh";
    const res = await post();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; feeds: Record<string, string> };
    expect(body.status).toBe("ok");
    expect(body.feeds["players"]).toBe("skipped");
    expect(body.feeds["store"]).toBe("skipped");
  });

  test("a failed feed returns 503 instead of a top-level ok 200", async () => {
    airtableShouldFail = true;
    const res = await post();
    expect(res.status).toBe(503);
    const body = (await res.json()) as { status: string; feeds: Record<string, string> };
    expect(body.status).toBe("degraded");
    expect(body.feeds["players"]).toBe("failed");
  });
});
