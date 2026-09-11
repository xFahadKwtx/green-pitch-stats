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
let finishStatus: string;
let loadShouldFail: boolean;
let realFetch: typeof fetch;

function install() {
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const fn = url.split("/rpc/")[1] ?? "";
    const args = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    calls.push({ fn, args });

    let body: unknown;
    if (fn === "h2_verify_warm_token") {
      body = { authorized: args["p_token"] === VALID_TOKEN };
    } else if (fn === "h2_get_or_claim_ahead") {
      body =
        claimStatus === "claimed"
          ? {
              status: "claimed",
              lease_token: "00000000-0000-4000-8000-000000000001",
              refresh_deadline_ms: 45_000,
            }
          : { status: claimStatus };
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

const loader = async () => {
  if (loadShouldFail) throw new Error("upstream boom");
  return [{ id: "p001" }];
};

beforeEach(() => {
  calls = [];
  claimStatus = "claimed";
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

  test("the warming threshold bridges the ~10 minute schedule with margin", () => {
    const tick = 600_000;
    // Worst case a tick lands right after a refresh; the next tick is 10min
    // later, leaving TTL-600s of freshness. The threshold must exceed that.
    expect(WARM_MIN_FRESH_MS).toBeGreaterThan(900_000 - tick);
    // ...and stay well inside the TTL so warming cannot refresh continuously.
    expect(WARM_MIN_FRESH_MS).toBeLessThan(900_000 - tick + 120_000);
  });
});
