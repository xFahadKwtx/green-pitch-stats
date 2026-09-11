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
  SCHEDULE_MARGIN_MS,
  handleWarmFeedsRequest,
  nextScheduleBoundaryMs,
} from "../src/routes/api/public/warm-feeds";
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
/** Stands in for an upstream body that must never reach a log line. */
const SENSITIVE = "SECRET_TOKEN_https://user:pass@internal.test/db?key=leaked";

interface Call {
  fn: string;
  args: Record<string, unknown>;
}

/** A stored cache row as PostgREST would return it. */
interface StoredRow {
  payload: unknown[];
  refresh_started_at: string;
  fresh_until: string;
  /** Server clock reported by the lookup response for this row. */
  dateMs?: number;
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
/** Per-cache-key stored rows for severity assessment (falls back to storedRow). */
let storedRowsByKey: Record<string, StoredRow | null> | null;
let airtableCalls: number;
let airtableShouldFail: boolean;
/** Airtable HTTP failure status (non-429) for the diagnostics tests. */
let airtableStatus: number | null;
/** When set, the warming claim RPC rejects with this error name. */
let claimRejectName: string | null;
/** Per-cache-key claim status override for mixed-outcome tests. */
let claimStatusByKey: Record<string, string> | null;
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
      if (airtableStatus !== null) {
        return new Response(SENSITIVE, {
          status: airtableStatus,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ records: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    // Read-only stored-payload lookup used by the empty-overwrite protection
    // and by the endpoint's read-only severity assessment.
    if (url.includes("/rest/v1/airtable_public_cache")) {
      const cacheKey = decodeURIComponent(
        /cache_key=eq\.([^&]*)/.exec(url)?.[1] ?? "",
      );
      calls.push({ fn: "select_cache", args: { cacheKey } });
      const row = storedRowsByKey ? (storedRowsByKey[cacheKey] ?? null) : storedRow;
      return new Response(JSON.stringify(row ? [row] : []), {
        status: 200,
        headers: {
          "content-type": "application/json",
          // Server Date is required for the freshness derivation.
          date: new Date(row?.dateMs ?? Date.now()).toUTCString(),
        },
      });
    }

    const fn = url.split("/rpc/")[1] ?? "";
    const args = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    calls.push({ fn, args });

    if (fn === "h2_get_or_claim_ahead" && claimRejectName) {
      const error = new Error("coordinator transport failure");
      error.name = claimRejectName;
      throw error;
    }

    let body: unknown;
    if (fn === "h2_verify_warm_token") {
      body = { authorized: args["p_token"] === VALID_TOKEN };
    } else if (fn === "h2_get_or_claim_ahead" || fn === "h2_get_or_claim") {
      // Mirror the SQL freshness comparison when a remaining lifetime is set.
      const minFresh = Number(args["p_min_fresh_ms"] ?? 0);
      const perKey = claimStatusByKey?.[String(args["p_cache_key"] ?? "")];
      const effective =
        perKey ??
        (cacheRemainingMs === null
          ? claimStatus
          : cacheRemainingMs > minFresh
            ? "fresh"
            : "claimed");
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
  if (loadShouldFail) throw loaderError ?? new Error("upstream boom");
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
  storedRowsByKey = null;
  airtableCalls = 0;
  airtableShouldFail = false;
  airtableStatus = null;
  claimRejectName = null;
  claimStatusByKey = null;
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
    const body = (await res.json()) as {
      status: string;
      critical: boolean;
      feeds: Record<string, string>;
    };
    expect(body.status).toBe("ok");
    expect(body.critical).toBe(false);
    expect(body.feeds["players"]).toBe("skipped");
    expect(body.feeds["store"]).toBe("skipped");
    // No severity lookup is needed when nothing failed.
    expect(calls.some((c) => c.fn === "select_cache")).toBe(false);
  });

  test("published feeds return 200 ok", async () => {
    const res = await post();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      critical: boolean;
      feeds: Record<string, string>;
    };
    expect(body.status).toBe("ok");
    expect(body.critical).toBe(false);
    expect(body.feeds["players"]).toBe("published");
    expect(body.feeds["store"]).toBe("published");
  });

  test("a failed feed with no cache at all returns 503 critical", async () => {
    airtableShouldFail = true;
    const res = await post();
    expect(res.status).toBe(503);
    const body = (await res.json()) as {
      status: string;
      critical: boolean;
      feeds: Record<string, string>;
    };
    expect(body.status).toBe("degraded");
    expect(body.critical).toBe(true);
    expect(body.feeds["players"]).toBe("failed");
    // Severity is read-only: the lookup happens, nothing is refreshed again.
    expect(calls.some((c) => c.fn === "select_cache")).toBe(true);
    expect(calls.filter((c) => c.fn === "h2_get_or_claim_ahead").length).toBe(2);
  });
});

/** A row whose freshness ends at `expiryMs`, read at server clock `dateMs`. */
function rowExpiringAt(expiryMs: number, dateMs: number): StoredRow {
  return {
    payload: [{ id: "old" }],
    refresh_started_at: new Date(expiryMs - 900_000).toISOString(),
    fresh_until: new Date(expiryMs).toISOString(),
    dateMs,
  };
}

/** Runs the endpoint with a fixed local wall clock. */
async function postAt(localNowMs: number): Promise<Response> {
  const savedNow = Date.now;
  Date.now = () => localNowMs;
  try {
    return await post();
  } finally {
    Date.now = savedNow;
  }
}

async function severity(res: Response): Promise<{
  status: number;
  body: { status: string; critical: boolean; feeds: Record<string, string> };
}> {
  return { status: res.status, body: (await res.json()) as never };
}

describe("scheduled warmer HTTP severity", () => {
  const NOW = Date.parse("2026-09-11T14:00:00.000Z");

  test("next actual UTC 12-minute boundary, including hour rollover", () => {
    const at = (iso: string) => Date.parse(iso);
    expect(nextScheduleBoundaryMs(at("2026-09-11T14:00:00.000Z"))).toBe(
      at("2026-09-11T14:12:00.000Z"),
    );
    expect(nextScheduleBoundaryMs(at("2026-09-11T14:11:59.999Z"))).toBe(
      at("2026-09-11T14:12:00.000Z"),
    );
    expect(nextScheduleBoundaryMs(at("2026-09-11T14:12:00.000Z"))).toBe(
      at("2026-09-11T14:24:00.000Z"),
    );
    expect(nextScheduleBoundaryMs(at("2026-09-11T14:49:30.000Z"))).toBe(
      at("2026-09-11T15:00:00.000Z"),
    );
    expect(nextScheduleBoundaryMs(at("2026-09-11T23:55:00.000Z"))).toBe(
      at("2026-09-12T00:00:00.000Z"),
    );
    expect(SCHEDULE_MARGIN_MS).toBe(60_000);
  });

  test("a failed feed whose cache outlives the next boundary + margin is 200 degraded, not critical", async () => {
    airtableShouldFail = true;
    // Fresh until 14:20 > next boundary 14:12 + 60s.
    storedRow = rowExpiringAt(Date.parse("2026-09-11T14:20:00.000Z"), NOW);
    const { status, body } = await severity(await postAt(NOW));
    expect(status).toBe(200);
    expect(body.status).toBe("degraded");
    expect(body.critical).toBe(false);
    expect(body.feeds["players"]).toBe("failed");
    expect(body.feeds["store"]).toBe("failed");
  });

  test("the historical 14:00 failure expiring 14:05 still returns 503", async () => {
    airtableShouldFail = true;
    storedRow = rowExpiringAt(Date.parse("2026-09-11T14:05:00.000Z"), NOW);
    const { status, body } = await severity(await postAt(NOW));
    expect(status).toBe(503);
    expect(body.critical).toBe(true);
  });

  test("coverage exactly equal to boundary + margin is insufficient (strict)", async () => {
    airtableShouldFail = true;
    // The assessment moment is NOW + 1s (server Date precision), so the next
    // boundary is 14:12 and the requirement is exactly 14:13:00.000.
    storedRow = rowExpiringAt(Date.parse("2026-09-11T14:13:00.000Z"), NOW);
    expect((await severity(await postAt(NOW))).status).toBe(503);
    storedRow = rowExpiringAt(Date.parse("2026-09-11T14:13:00.001Z"), NOW);
    expect((await severity(await postAt(NOW))).status).toBe(200);
  });

  test("hour rollover is respected around 14:49", async () => {
    const late = Date.parse("2026-09-11T14:49:30.000Z");
    airtableShouldFail = true;
    storedRow = rowExpiringAt(Date.parse("2026-09-11T15:00:30.000Z"), late);
    expect((await severity(await postAt(late))).status).toBe(503);
    storedRow = rowExpiringAt(Date.parse("2026-09-11T15:01:30.000Z"), late);
    expect((await severity(await postAt(late))).status).toBe(200);
  });

  test("expired, missing, malformed and unreadable caches are all critical 503", async () => {
    airtableShouldFail = true;
    const rows: Array<StoredRow | null> = [
      null,
      { ...rowExpiringAt(Date.parse("2026-09-11T13:50:00.000Z"), NOW) },
      { payload: [], refresh_started_at: new Date(NOW).toISOString(), fresh_until: "x", dateMs: NOW },
      { payload: [{ id: "old" }], refresh_started_at: "not-a-date", fresh_until: "not-a-date", dateMs: NOW },
    ];
    for (const row of rows) {
      storedRow = row;
      const { status, body } = await severity(await postAt(NOW));
      expect(status).toBe(503);
      expect(body.critical).toBe(true);
    }
  });

  test("a slow second lookup that crosses a boundary is never ignored", async () => {
    airtableShouldFail = true;
    // Players read just before 14:12, Store read after it. Judged against the
    // LATEST assessment, the required coverage moves to 14:24 + 60s, so the
    // 14:20 players cache is no longer sufficient.
    storedRowsByKey = {
      "production:players": rowExpiringAt(
        Date.parse("2026-09-11T14:20:00.000Z"),
        Date.parse("2026-09-11T14:11:50.000Z"),
      ),
      "production:store": rowExpiringAt(
        Date.parse("2026-09-11T14:22:00.000Z"),
        Date.parse("2026-09-11T14:12:05.000Z"),
      ),
    };
    const { status, body } = await severity(
      await postAt(Date.parse("2026-09-11T14:11:50.000Z")),
    );
    expect(status).toBe(503);
    expect(body.critical).toBe(true);
  });

  test("a local clock behind the server clock cannot extend coverage", async () => {
    airtableShouldFail = true;
    // Server says 14:12:30 while the local clock claims 14:00. The later
    // (server) reading wins, so 14:20 no longer bridges 14:24 + 60s.
    storedRow = rowExpiringAt(
      Date.parse("2026-09-11T14:20:00.000Z"),
      Date.parse("2026-09-11T14:12:30.000Z"),
    );
    expect((await severity(await postAt(NOW))).status).toBe(503);
  });

  test("mixed outcomes: one failed feed with sufficient cache beside a skip is 200", async () => {
    airtableShouldFail = true;
    claimStatusByKey = { "production:store": "fresh" };
    storedRow = rowExpiringAt(Date.parse("2026-09-11T14:20:00.000Z"), NOW);
    const { status, body } = await severity(await postAt(NOW));
    expect(status).toBe(200);
    expect(body.status).toBe("degraded");
    expect(body.critical).toBe(false);
    expect(body.feeds["players"]).toBe("failed");
    expect(body.feeds["store"]).toBe("skipped");
  });

  test("mixed outcomes: one critical feed makes the whole response 503", async () => {
    airtableShouldFail = true;
    storedRowsByKey = {
      "production:players": rowExpiringAt(Date.parse("2026-09-11T14:30:00.000Z"), NOW),
      "production:store": null,
    };
    const { status, body } = await severity(await postAt(NOW));
    expect(status).toBe(503);
    expect(body.critical).toBe(true);
    expect(body.feeds["players"]).toBe("failed");
    expect(body.feeds["store"]).toBe("failed");
  });

  test("severity assessment never publishes, mutates or serves the cached payload", async () => {
    airtableShouldFail = true;
    storedRow = rowExpiringAt(Date.parse("2026-09-11T14:20:00.000Z"), NOW);
    const snapshot = JSON.stringify(storedRow);
    const res = await postAt(NOW);
    const text = await res.text();
    expect(calls.some((c) => c.fn === "h2_finish_refresh")).toBe(false);
    expect(JSON.stringify(storedRow)).toBe(snapshot);
    expect(text).not.toContain("old");
  });
});

describe("sanitized scheduled failure diagnostics", () => {
  const logs: unknown[] = [];
  let savedError: typeof console.error;

  function captureLogs() {
    logs.length = 0;
    savedError = console.error;
    console.error = (value: unknown) => {
      logs.push(value);
    };
  }

  function warmFailureLines(): Array<Record<string, unknown>> {
    return logs
      .filter(
        (l): l is Record<string, unknown> =>
          !!l && typeof l === "object" && (l as { event?: string }).event === "scheduled_warm_failure",
      )
      .map((l) => ({ ...l }));
  }

  afterEach(() => {
    console.error = savedError;
  });

  test("an upstream warm failure logs exactly one bounded sanitized line per feed", async () => {
    airtableShouldFail = true;
    captureLogs();
    expect(await warmPublicFeed("players", loader)).toBe("published");
    const clean = warmFailureLines();
    expect(clean.length).toBe(0);

    logs.length = 0;
    loadShouldFail = true;
    expect(await warmPublicFeed("players", loader)).toBe("failed");
    const lines = warmFailureLines();
    expect(lines.length).toBe(1);
    expect(lines[0]!["feed"]).toBe("players");
    expect(lines[0]!["phase"]).toBe("refresh");
    expect(typeof lines[0]!["at"]).toBe("string");
    expect(Object.keys(lines[0]!).sort()).toEqual([
      "at",
      "category",
      "event",
      "feed",
      "phase",
      "ref",
      "status",
      "timeout",
    ]);
  });

  test("the empty-Players fallback still logs the original failure once", async () => {
    loaderPayload = [];
    storedRow = freshStoredRow(300_000);
    captureLogs();
    expect(await warmPublicFeed("players", loader)).toBe("failed");
    const lines = warmFailureLines();
    expect(lines.length).toBe(1);
    expect(lines[0]!["feed"]).toBe("players");
  });

  test("a claim RPC timeout is classified as timeout, a network rejection as network", async () => {
    for (const [name, category] of [
      ["TimeoutError", "timeout"],
      ["TypeError", "network"],
    ] as const) {
      claimRejectName = name;
      captureLogs();
      expect(await warmPublicFeed("store", loader)).toBe("failed");
      const lines = warmFailureLines();
      expect(lines.length).toBe(1);
      expect(lines[0]!["phase"]).toBe("claim");
      expect(lines[0]!["category"]).toBe(category);
      expect(lines[0]!["timeout"]).toBe(category === "timeout");
      console.error = savedError;
    }
  });

  test("an Airtable 5xx carries its numeric status without any upstream text", async () => {
    const saved = [process.env["LOVABLE_API_KEY"], process.env["AIRTABLE_API_KEY"]];
    process.env["LOVABLE_API_KEY"] = "dummy-lovable";
    process.env["AIRTABLE_API_KEY"] = "dummy-airtable";
    airtableStatus = 500;
    captureLogs();
    try {
      const outcome = await warmPublicFeed("players", async () => {
        const { listAirtableRecords } = await import("../src/lib/airtable.server");
        return listAirtableRecords("tblTest");
      });
      expect(outcome).toBe("failed");
      const lines = warmFailureLines();
      expect(lines.length).toBe(1);
      expect(lines[0]!["status"]).toBe(500);
      expect(lines[0]!["category"]).toBe("upstream-http");
      expect(JSON.stringify(logs)).not.toContain(SENSITIVE);
      expect(JSON.stringify(logs)).not.toContain("internal.test");
    } finally {
      console.error = savedError;
      if (saved[0] === undefined) delete process.env["LOVABLE_API_KEY"];
      else process.env["LOVABLE_API_KEY"] = saved[0];
      if (saved[1] === undefined) delete process.env["AIRTABLE_API_KEY"];
      else process.env["AIRTABLE_API_KEY"] = saved[1];
    }
  });

  test("no sensitive detail is logged even when the error carries secrets", async () => {
    loadShouldFail = true;
    loaderError = Object.assign(new Error(SENSITIVE), {
      cause: new Error(SENSITIVE),
      headers: { authorization: SENSITIVE },
      params: { p_lease_token: SENSITIVE },
      payload: [{ secret: SENSITIVE }],
    });
    captureLogs();
    expect(await warmPublicFeed("players", loader)).toBe("failed");
    expect(JSON.stringify(warmFailureLines())).not.toContain(SENSITIVE);
    expect(JSON.stringify(warmFailureLines())).not.toContain("internal.test");
    expect(warmFailureLines().length).toBe(1);
  });

  test("a failing logging sink never changes the warm outcome", async () => {
    loadShouldFail = true;
    savedError = console.error;
    console.error = () => {
      throw new Error(SENSITIVE);
    };
    try {
      expect(await warmPublicFeed("players", loader)).toBe("failed");
    } finally {
      console.error = savedError;
    }
  });
});
