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
  WARM_MIN_FRESH_MS,
  __testing,
  verifyWarmToken,
  warmPublicFeed,
} from "../src/lib/public-feed-cache.server";

process.env["SUPABASE_URL"] = "http://coordinator.test";
process.env["SUPABASE_SERVICE_ROLE_KEY"] = "sb_secret_dummy_test_value";

const VALID_TOKEN = "a".repeat(64);

interface Call {
  fn: string;
  args: Record<string, unknown>;
}

let calls: Call[] = [];
let claimStatus: string;
/** Remaining freshness of the cached entry, as the coordinator would see it. */
let cacheRemainingMs: number | null;
let airtableCalls: number;
let airtableShouldFail: boolean;
let finishStatus: string;
let loadShouldFail: boolean;
let realFetch: typeof fetch;

function install() {
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (!url.startsWith("http://coordinator.test")) {
      airtableCalls += 1;
      if (airtableShouldFail) throw new Error("upstream unreachable");
      return new Response(JSON.stringify({ records: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    const fn = url.split("/rpc/")[1] ?? "";
    const args = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    calls.push({ fn, args });

    let body: unknown;
    if (fn === "h2_verify_warm_token") {
      body = { authorized: args["p_token"] === VALID_TOKEN };
    } else if (fn === "h2_get_or_claim_ahead") {
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
          : { status: effective };
    } else if (fn === "h2_take_page_permit") {
      body = { status: "granted", usable_for_ms: 1_000, refresh_deadline_ms: 40_000 };
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

const TICK_MS = 600_000;

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
  return [{ id: "p001" }];
};

beforeEach(() => {
  calls = [];
  claimStatus = "claimed";
  cacheRemainingMs = null;
  airtableCalls = 0;
  airtableShouldFail = false;
  finishStatus = "published";
  loadShouldFail = false;
  __testing.setMode("production");
  install();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  __testing.setMode(undefined);
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
    claimStatus = "claimed";
  cacheRemainingMs = null;
  airtableCalls = 0;
  airtableShouldFail = false;
    airtableShouldFail = true;
    const res = await post();
    expect(res.status).toBe(503);
    const body = (await res.json()) as { status: string; feeds: Record<string, string> };
    expect(body.status).toBe("degraded");
    expect(body.feeds["players"]).toBe("failed");
  });
});
