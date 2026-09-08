/**
 * H2 focused tests — shared Airtable cache + request coordinator.
 *
 * Runs on the built-in Bun test runtime (no dependencies installed).
 *   bun test tests/h2-cache.test.ts
 *
 * All Airtable and PostgREST traffic is mocked. No real Airtable call is made
 * and no secret value is used or logged (the coordinator credentials below are
 * obvious dummies).
 *
 * The PRODUCTION client implementation is under test (getCachedPublicFeed,
 * runAirtablePage, listAirtableRecords, fetchRecordsFromAirtable). The fake
 * coordinator stands in for the SQL functions and mirrors their contract;
 * behaviours that depend on real Postgres semantics (row locking under true
 * concurrency, FOR UPDATE serialization, gen_random_uuid, UTC date_trunc
 * resets, CHECK constraints, RLS/GRANT enforcement) still require a real
 * PostgreSQL run and are listed in the report.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  FeedUnavailableError,
  __testing,
  getCachedPublicFeed,
  FEED_TTL_SECONDS,
} from "../src/lib/public-feed-cache.server";
import { AIRTABLE_TABLES, listAirtableRecords } from "../src/lib/airtable.server";
import { fetchRecordsFromAirtable } from "../src/lib/records.server";

process.env["SUPABASE_URL"] = "http://coordinator.test";
process.env["SUPABASE_SERVICE_ROLE_KEY"] = "sb_secret_dummy_test_value";
process.env["LOVABLE_API_KEY"] = "dummy-lovable-key";
process.env["AIRTABLE_API_KEY"] = "dummy-airtable-key";

const DAY_LIMIT = 2100;
const MONTH_LIMIT = 65000;
const LEASE_MS = 60_000;
const DEADLINE_MS = 45_000;
const PACING_MS = 2_000;

interface FeedRow {
  schemaVersion: number;
  payload: unknown;
  refreshStartedAt: number | null;
  freshUntil: number | null;
  retryAfter: number | null;
  failureCount: number;
  lastPageCounts: Record<string, number>;
}

interface Control {
  enabled: boolean;
  leaseToken: string | null;
  leaseFeed: string | null;
  leaseStartedAt: number | null;
  leaseExpiresAt: number | null;
  lastPageSequence: number;
  nextRequestAt: number | null;
  cooldownUntil: number | null;
  dayUsed: number;
  dayLimit: number;
  monthUsed: number;
  monthLimit: number;
}

interface AirtableTableState {
  records: Array<{ id: string; fields: Record<string, unknown> }>;
  /** Optional per-page behaviour override. */
  behaviour?: "ok" | "429" | "500" | "timeout" | "fail-after-first";
  retryAfter?: string;
}

class FakeWorld {
  now = Date.parse("2026-09-08T12:00:00.000Z");
  rows = new Map<string, FeedRow>();
  /** Mirrors the seed: the coordinator ships DISABLED until activated. */
  control: Control = {
    enabled: false,
    leaseToken: null,
    leaseFeed: null,
    leaseStartedAt: null,
    leaseExpiresAt: null,
    lastPageSequence: 0,
    nextRequestAt: null,
    cooldownUntil: null,
    dayUsed: 0,
    dayLimit: DAY_LIMIT,
    monthUsed: 0,
    monthLimit: MONTH_LIMIT,
  };
  tables = new Map<string, AirtableTableState>();
  airtableRequests: Array<{ table: string; at: number }> = [];
  rpcCalls: string[] = [];
  postgresDown = false;
  /** Extra real latency injected into permit RPCs (window-expiry testing). */
  slowPermitMs = 0;
  /** Fake-clock time consumed INSIDE an RPC round trip, per rpc name. */
  rpcAdvanceMs: Record<string, number> = {};

  tokenSeq = 0;

  constructor() {
    for (const env of ["preview", "production"]) {
      for (const feed of ["players", "records", "store", "upcoming-games"]) {
        this.rows.set(`${env}:${feed}`, {
          schemaVersion: 1,
          payload: null,
          refreshStartedAt: null,
          freshUntil: null,
          retryAfter: null,
          failureCount: 0,
          lastPageCounts: {},
        });
      }
    }
  }

  advance(ms: number) {
    this.now += ms;
  }

  seedTable(tableId: string, count: number, state: Partial<AirtableTableState> = {}) {
    const records = Array.from({ length: count }, (_, i) => ({
      id: `rec${tableId}${String(i).padStart(6, "0")}`,
      fields: {} as Record<string, unknown>,
    }));
    this.tables.set(tableId, { records, behaviour: "ok", ...state });
  }

  setTable(tableId: string, state: AirtableTableState) {
    this.tables.set(tableId, state);
  }

  /** ---- fake SQL coordinator (mirrors the migration's contract) ---- */
  rpc(fn: string, args: Record<string, unknown>): unknown {
    this.rpcCalls.push(fn);
    if (this.postgresDown) throw new Error("coordinator down");
    // Time consumed while the RPC is in flight (DB clock advances).
    this.advance(this.rpcAdvanceMs[fn] ?? 0);

    if (fn === "h2_get_or_claim") return this.getOrClaim(args);
    if (fn === "h2_take_page_permit") return this.takePermit(args);
    if (fn === "h2_finish_refresh") return this.finish(args);
    if (fn === "h2_fail_refresh") return this.fail(args);
    throw new Error(`unknown rpc ${fn}`);
  }

  private row(key: string): FeedRow {
    const row = this.rows.get(key);
    if (!row) throw new Error("unknown cache key");
    return row;
  }

  private freshResponse(row: FeedRow) {
    return {
      status: "fresh",
      payload: row.payload,
      fresh_until: row.freshUntil,
      fresh_for_ms: row.freshUntil! - this.now,
    };
  }

  private ownerInvalid(key: string, token: unknown): boolean {
    const c = this.control;
    return (
      token === null ||
      token === undefined ||
      c.leaseToken === null ||
      c.leaseToken !== token ||
      c.leaseFeed !== key ||
      (c.leaseExpiresAt ?? 0) <= this.now
    );
  }

  private getOrClaim(args: Record<string, unknown>) {
    const key = String(args["p_cache_key"]);
    if (Number(args["p_schema_version"]) !== 1) {
      throw new Error("unsupported schema version");
    }
    const row = this.row(key);
    if (
      row.payload !== null &&
      row.freshUntil !== null &&
      row.freshUntil > this.now &&
      row.schemaVersion === 1
    ) {
      return this.freshResponse(row);
    }
    if (!this.control.enabled) return { status: "disabled" };
    if (this.control.leaseExpiresAt !== null && this.control.leaseExpiresAt > this.now) {
      return { status: "busy", recheck_after_ms: 1000 };
    }
    if (row.retryAfter !== null && row.retryAfter > this.now) {
      return { status: "backoff", retry_after: row.retryAfter };
    }
    if (this.control.cooldownUntil !== null && this.control.cooldownUntil > this.now) {
      return { status: "cooldown", retry_after: this.control.cooldownUntil };
    }
    if (
      this.control.dayUsed >= this.control.dayLimit ||
      this.control.monthUsed >= this.control.monthLimit
    ) {
      return { status: "budget_exhausted" };
    }
    const token = `token-${++this.tokenSeq}`;
    this.control.leaseToken = token;
    this.control.leaseFeed = key;
    this.control.leaseStartedAt = this.now;
    this.control.leaseExpiresAt = this.now + LEASE_MS;
    this.control.lastPageSequence = 0;
    // The prior payload's refresh_started_at is intentionally untouched.
    return {
      status: "claimed",
      lease_token: token,
      refresh_deadline_ms: DEADLINE_MS,
      lease_expires_at: this.control.leaseExpiresAt,
    };
  }

  private takePermit(args: Record<string, unknown>) {
    const key = args["p_cache_key"];
    const token = args["p_lease_token"];
    const sequence = Number(args["p_sequence"]);
    const c = this.control;

    if (typeof key !== "string" || token === null || token === undefined) {
      return { status: "invalid" };
    }
    if (!Number.isInteger(sequence) || sequence < 1) return { status: "invalid" };
    if (this.ownerInvalid(key, token)) return { status: "expired" };
    if (!c.enabled) return { status: "disabled" };
    if (c.leaseStartedAt === null || this.now >= c.leaseStartedAt + DEADLINE_MS) {
      return { status: "deadline_exceeded" };
    }
    if (sequence !== c.lastPageSequence + 1) return { status: "sequence_conflict" };
    if (c.cooldownUntil !== null && c.cooldownUntil > this.now) return { status: "cooldown" };
    if (c.dayUsed >= c.dayLimit || c.monthUsed >= c.monthLimit) {
      return { status: "budget_exhausted" };
    }
    if (c.nextRequestAt !== null && c.nextRequestAt > this.now) {
      return { status: "paced", wait_ms: c.nextRequestAt - this.now };
    }
    c.dayUsed += 1;
    c.monthUsed += 1;
    c.lastPageSequence = sequence;
    c.nextRequestAt = this.now + PACING_MS;
    return {
      status: "granted",
      usable_for_ms: 1000,
      sequence,
      refresh_deadline_ms: c.leaseStartedAt + DEADLINE_MS - this.now,
    };
  }

  private finish(args: Record<string, unknown>) {
    const key = args["p_cache_key"];
    const token = args["p_lease_token"];
    const payload = args["p_payload"];
    const counts = args["p_page_counts"];
    if (typeof key !== "string" || token === null || token === undefined) {
      return { status: "rejected", reason: "invalid_arguments" };
    }
    if (!Array.isArray(payload)) {
      return { status: "rejected", reason: "invalid_payload" };
    }
    if (!counts || typeof counts !== "object" || Array.isArray(counts)) {
      return { status: "rejected", reason: "invalid_page_counts" };
    }
    const values = Object.values(counts as Record<string, unknown>);
    if (values.some((v) => !Number.isInteger(v) || (v as number) <= 0)) {
      return { status: "rejected", reason: "invalid_page_counts" };
    }
    const row = this.row(key);
    const c = this.control;
    if (this.ownerInvalid(key, token)) return { status: "stale_lease" };
    if (!c.enabled) return { status: "rejected", reason: "disabled" };
    if (c.leaseStartedAt === null || this.now >= c.leaseStartedAt + DEADLINE_MS) {
      return { status: "rejected", reason: "deadline_exceeded" };
    }
    const sum = (values as number[]).reduce((a, b) => a + b, 0);
    if (sum !== c.lastPageSequence) {
      return { status: "rejected", reason: "page_count_mismatch" };
    }
    const started = c.leaseStartedAt;
    row.payload = payload;
    row.refreshStartedAt = started;
    row.freshUntil = started + FEED_TTL_SECONDS * 1000;
    row.retryAfter = null;
    row.failureCount = 0;
    row.lastPageCounts = counts as Record<string, number>;
    this.releaseLease();
    return { status: "published", fresh_until: row.freshUntil };
  }

  private fail(args: Record<string, unknown>) {
    const key = args["p_cache_key"];
    const token = args["p_lease_token"];
    if (typeof key !== "string" || token === null || token === undefined) {
      return { status: "ignored", reason: "invalid_arguments" };
    }
    const row = this.row(key);
    // A stale or expired owner may not alter ANY state.
    if (this.ownerInvalid(key, token)) return { status: "ignored", reason: "stale_lease" };

    row.failureCount += 1;
    const backoff = Math.min(300, 10 * 2 ** Math.min(row.failureCount - 1, 10));
    row.retryAfter = Math.max(row.retryAfter ?? this.now, this.now + backoff * 1000);
    if (args["p_kind"] === "rate_limited") {
      const supplied = Number(args["p_retry_after_seconds"]);
      const seconds =
        Number.isFinite(supplied) && supplied > 0 && supplied <= 604800
          ? Math.max(30, supplied)
          : 30;
      const until = this.now + seconds * 1000;
      // Never shorten an existing cooldown.
      this.control.cooldownUntil = Math.max(this.control.cooldownUntil ?? 0, until);
    }
    this.releaseLease();
    return { status: "recorded", released: true };
  }


  private releaseLease() {
    this.control.leaseToken = null;
    this.control.leaseFeed = null;
    this.control.leaseStartedAt = null;
    this.control.leaseExpiresAt = null;
    this.control.lastPageSequence = 0;
  }

  /** ---- fake Airtable gateway ---- */
  async airtable(url: URL, signal: AbortSignal | undefined): Promise<Response> {
    const parts = url.pathname.split("/");
    const tableId = parts[parts.length - 1] ?? "";
    const state = this.tables.get(tableId);
    if (!state) throw new Error(`unmocked Airtable table ${tableId}`);

    const requestIndex = this.airtableRequests.filter((r) => r.table === tableId).length;
    this.airtableRequests.push({ table: tableId, at: this.now });

    if (state.behaviour === "429") {
      return new Response("{}", {
        status: 429,
        headers: state.retryAfter ? { "retry-after": state.retryAfter } : {},
      });
    }
    if (state.behaviour === "500") return new Response("upstream detail", { status: 500 });
    if (state.behaviour === "timeout") {
      // Simulate a body/response that never resolves until aborted.
      return new Promise<Response>((_, reject) => {
        const onAbort = () => reject(new DOMException("aborted", "AbortError"));
        if (signal?.aborted) onAbort();
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    }
    if (state.behaviour === "fail-after-first" && requestIndex > 0) {
      return new Response("upstream detail", { status: 500 });
    }

    const offsetParam = url.searchParams.get("offset");
    const start = offsetParam ? Number(offsetParam) : 0;
    const page = state.records.slice(start, start + 100);
    const nextStart = start + page.length;
    const body: Record<string, unknown> = { records: page };
    if (nextStart < state.records.length) body["offset"] = String(nextStart);
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
}

let world: FakeWorld;
const realFetch = globalThis.fetch;

function installFetch() {
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const raw =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    const url = new URL(raw);

    if (url.host === "coordinator.test") {
      const fn = url.pathname.split("/").pop() ?? "";
      const args = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      // Never send Authorization for opaque sb_secret_* keys.
      const headers = new Headers(init?.headers);
      expect(headers.get("apikey")).toBeTruthy();
      expect(headers.get("authorization")).toBeNull();
      if (fn === "h2_take_page_permit" && world.slowPermitMs > 0) {
        await new Promise((r) => setTimeout(r, world.slowPermitMs));
      }
      try {
        const result = world.rpc(fn, args);

        return new Response(JSON.stringify(result), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      } catch {
        return new Response("{}", { status: 500 });
      }
    }

    if (url.host === "connector-gateway.lovable.dev") {
      return world.airtable(url, init?.signal ?? undefined);
    }

    throw new Error(`unexpected network call to ${url.host}`);
  }) as typeof fetch;
}

beforeEach(() => {
  world = new FakeWorld();
  // Activation is an explicit step; the seed ships disabled.
  world.control.enabled = true;
  installFetch();
  __testing.setMode("production");
  // Virtual clock: sleeps advance the fake DB clock instantly, and the client's
  // monotonic seam reads the same fake clock.
  __testing.setSleep(async (ms: number) => {
    world.advance(ms);
  });
  __testing.setMonotonic(() => world.now);
});

afterEach(() => {
  globalThis.fetch = realFetch;
  __testing.resetSleep();
  __testing.resetMonotonic();
  __testing.setMode(undefined);
});


function seedFullBase() {
  world.seedTable(AIRTABLE_TABLES.playersDatabase, 122);
  world.seedTable(AIRTABLE_TABLES.statsJune, 57);
  world.seedTable(AIRTABLE_TABLES.statsJuly, 82);
  world.seedTable(AIRTABLE_TABLES.statsAugust, 122);
  world.seedTable(AIRTABLE_TABLES.statsSeptember, 122);
  world.seedTable(AIRTABLE_TABLES.records, 3);
  world.seedTable(AIRTABLE_TABLES.store, 25);
  world.seedTable(AIRTABLE_TABLES.storeCategories, 5);
  world.seedTable(AIRTABLE_TABLES.upcomingGames, 7);
}

/** Loader helper that walks the real pagination code. */
const listAll = (...tableIds: string[]) =>
  async () => {
    const out: unknown[] = [];
    for (const id of tableIds) out.push(await listAirtableRecords(id));
    return out;
  };

describe("cache serving", () => {
  test("1. fresh cache hit performs zero Airtable requests", async () => {
    seedFullBase();
    await getCachedPublicFeed("records", listAll(AIRTABLE_TABLES.records));
    const afterFirst = world.airtableRequests.length;
    expect(afterFirst).toBeGreaterThan(0);

    const second = await getCachedPublicFeed("records", async () => {
      throw new Error("loader must not run on a fresh hit");
    });
    expect(second).toBeTruthy();
    expect(world.airtableRequests.length).toBe(afterFirst);
  });

  test("7. TTL boundary: fresh at 899s, refreshes after 900s from refresh START", async () => {
    seedFullBase();
    await getCachedPublicFeed("upcoming-games", listAll(AIRTABLE_TABLES.upcomingGames));
    const baseline = world.airtableRequests.length;

    world.advance(899_000);
    await getCachedPublicFeed("upcoming-games", async () => {
      throw new Error("must still be fresh");
    });
    expect(world.airtableRequests.length).toBe(baseline);

    world.advance(2_000); // now past 900s from refresh start
    await getCachedPublicFeed("upcoming-games", listAll(AIRTABLE_TABLES.upcomingGames));
    expect(world.airtableRequests.length).toBe(baseline + 1);
  });

  test("19. expired data is never served", async () => {
    seedFullBase();
    await getCachedPublicFeed("store", listAll(AIRTABLE_TABLES.store));
    world.advance(FEED_TTL_SECONDS * 1000 + 1);
    world.postgresDown = false;
    world.control.dayUsed = DAY_LIMIT; // budget exhausted after expiry
    await expect(
      getCachedPublicFeed("store", listAll(AIRTABLE_TABLES.store)),
    ).rejects.toThrow(FeedUnavailableError);
  });

  test("18. fresh cached data still served during an Airtable outage", async () => {
    seedFullBase();
    const payload = await getCachedPublicFeed("records", listAll(AIRTABLE_TABLES.records));
    world.setTable(AIRTABLE_TABLES.records, { records: [], behaviour: "500" });
    const again = await getCachedPublicFeed("records", listAll(AIRTABLE_TABLES.records));
    expect(again).toEqual(payload);
  });
});

describe("refresh coordination", () => {
  test("2. cache miss produces exactly one refresh owner", async () => {
    seedFullBase();
    let refreshes = 0;
    await getCachedPublicFeed("records", async () => {
      refreshes++;
      return listAirtableRecords(AIRTABLE_TABLES.records);
    });
    expect(refreshes).toBe(1);
  });

  test("3. many simultaneous callers trigger only one refresh", async () => {
    seedFullBase();
    let refreshes = 0;
    const loader = async () => {
      refreshes++;
      return listAirtableRecords(AIRTABLE_TABLES.records);
    };
    const results = await Promise.allSettled(
      Array.from({ length: 12 }, () => getCachedPublicFeed("records", loader)),
    );
    expect(refreshes).toBe(1);
    // Same-instance callers coalesce onto the single in-flight attempt.
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    expect(world.rpcCalls.filter((f) => f === "h2_get_or_claim").length).toBe(1);
    expect(world.airtableRequests.filter((r) => r.table === AIRTABLE_TABLES.records).length)
      .toBe(1);
    // The map is cleaned up afterwards.
    expect(__testing.inFlightSize()).toBe(0);
  });


  test("4. cross-instance: a second instance sees busy, then the published cache", async () => {
    seedFullBase();
    // Instance A claims the lease and is mid-refresh.
    const claim = world.rpc("h2_get_or_claim", {
      p_cache_key: "production:records",
      p_schema_version: 1,
    }) as Record<string, unknown>;
    expect(claim["status"]).toBe("claimed");

    // Instance B must not refresh; bounded rechecks then fail closed.
    await expect(
      getCachedPublicFeed("records", async () => {
        throw new Error("instance B must not refresh");
      }),
    ).rejects.toThrow(FeedUnavailableError);

    // A publishes; B now gets the fresh payload with no Airtable traffic.
    const published = world.rpc("h2_finish_refresh", {
      p_cache_key: "production:records",
      p_lease_token: claim["lease_token"],
      p_payload: [{ id: "recA" }],
      p_page_counts: {},
    }) as Record<string, unknown>;
    expect(published["status"]).toBe("published");

    const payload = await getCachedPublicFeed("records", async () => {
      throw new Error("should be fresh");
    });
    expect(payload).toEqual([{ id: "recA" }]);
    expect(world.airtableRequests.length).toBe(0);
  });

  test("15. crashed lease expires and a new owner gets a different token", async () => {
    seedFullBase();
    const first = world.rpc("h2_get_or_claim", {
      p_cache_key: "production:records",
      p_schema_version: 1,
    }) as Record<string, unknown>;
    world.advance(LEASE_MS + 1); // owner crashed; lease expired
    const second = world.rpc("h2_get_or_claim", {
      p_cache_key: "production:records",
      p_schema_version: 1,
    }) as Record<string, unknown>;
    expect(second["status"]).toBe("claimed");
    expect(second["lease_token"]).not.toBe(first["lease_token"]);
  });

  test("16. an old lease token can neither publish nor take permits", async () => {
    seedFullBase();
    const stale = world.rpc("h2_get_or_claim", {
      p_cache_key: "production:records",
      p_schema_version: 1,
    }) as Record<string, unknown>;
    world.advance(LEASE_MS + 1);
    world.rpc("h2_get_or_claim", { p_cache_key: "production:records", p_schema_version: 1 });

    expect(
      (world.rpc("h2_take_page_permit", {
        p_cache_key: "production:records",
        p_lease_token: stale["lease_token"],
        p_sequence: 1,
      }) as Record<string, unknown>)["status"],
    ).toBe("expired");

    expect(
      (world.rpc("h2_finish_refresh", {
        p_cache_key: "production:records",
        p_lease_token: stale["lease_token"],
        p_payload: [{ id: "hacked" }],
        p_page_counts: {},
      }) as Record<string, unknown>)["status"],
    ).toBe("stale_lease");
    expect(world.rows.get("production:records")!.payload).toBeNull();
  });
});

describe("pagination and permits", () => {
  test("5. current pagination costs: players 8, records 3, store 2, upcoming 1", async () => {
    seedFullBase();
    const { fetchPlayersFromAirtable } = await import("../src/lib/airtable-players.server");
    await getCachedPublicFeed("players", () => fetchPlayersFromAirtable());
    expect(world.airtableRequests.length).toBe(8);

    world.airtableRequests = [];
    await getCachedPublicFeed("records", () => fetchRecordsFromAirtable());
    expect(world.airtableRequests.length).toBe(3);

    world.airtableRequests = [];
    const { fetchStoreFromAirtable } = await import("../src/lib/store.server");
    await getCachedPublicFeed("store", () => fetchStoreFromAirtable());
    expect(world.airtableRequests.length).toBe(2);

    world.airtableRequests = [];
    const { fetchUpcomingGamesFromAirtable } = await import(
      "../src/lib/upcoming-games.server"
    );
    await getCachedPublicFeed("upcoming-games", () => fetchUpcomingGamesFromAirtable());
    expect(world.airtableRequests.length).toBe(1);
  });

  test("6. pagination growth consumes one permit per extra page", async () => {
    seedFullBase();
    world.seedTable(AIRTABLE_TABLES.records, 250); // 3 pages instead of 1
    await getCachedPublicFeed("records", listAll(AIRTABLE_TABLES.records));
    expect(world.airtableRequests.filter((r) => r.table === AIRTABLE_TABLES.records).length)
      .toBe(3);
    expect(world.control.dayUsed).toBe(3);
  });

  test("every page increments the shared budget before dispatch", async () => {
    seedFullBase();
    await getCachedPublicFeed("store", listAll(AIRTABLE_TABLES.store, AIRTABLE_TABLES.storeCategories));
    expect(world.control.dayUsed).toBe(world.airtableRequests.length);
    expect(world.control.monthUsed).toBe(world.airtableRequests.length);
  });

  test("permits are strictly sequential and duplicate offsets are rejected", async () => {
    seedFullBase();
    // Same offset key twice inside one refresh must fail closed.
    await expect(
      getCachedPublicFeed("records", async () => {
        await listAirtableRecords(AIRTABLE_TABLES.records);
        // Reading the same table again reuses the ":first" offset key.
        return listAirtableRecords(AIRTABLE_TABLES.records);
      }),
    ).rejects.toThrow(FeedUnavailableError);
  });

  test("no bypass: Airtable cannot be reached without a refresh context", async () => {
    seedFullBase();
    await expect(listAirtableRecords(AIRTABLE_TABLES.records)).rejects.toThrow(
      FeedUnavailableError,
    );
    expect(world.airtableRequests.length).toBe(0);
  });

  test("10. pacing: grants are spaced 2s apart and dispatch waits for the window", async () => {
    seedFullBase();
    world.seedTable(AIRTABLE_TABLES.records, 250);
    await getCachedPublicFeed("records", listAll(AIRTABLE_TABLES.records));
    const times = world.airtableRequests.map((r) => r.at);
    for (let i = 1; i < times.length; i++) {
      expect(times[i]! - times[i - 1]!).toBeGreaterThanOrEqual(PACING_MS);
    }
  });

  test("expired permit window is never reused", async () => {
    seedFullBase();
    // A slow coordinator round-trip means the 1s usable window has already
    // elapsed by the time the grant reaches this instance: fail closed.
    world.slowPermitMs = 1_200;
    await expect(
      getCachedPublicFeed("records", listAll(AIRTABLE_TABLES.records)),
    ).rejects.toThrow(FeedUnavailableError);
    expect(world.airtableRequests.length).toBe(0);
    expect(world.rows.get("production:records")!.payload).toBeNull();
  }, 15_000);

});

describe("budgets", () => {
  test("8. daily budget stops refreshes", async () => {
    seedFullBase();
    world.control.dayUsed = DAY_LIMIT;
    await expect(
      getCachedPublicFeed("records", listAll(AIRTABLE_TABLES.records)),
    ).rejects.toThrow(FeedUnavailableError);
    expect(world.airtableRequests.length).toBe(0);
  });

  test("9. monthly budget stops refreshes", async () => {
    seedFullBase();
    world.control.monthUsed = MONTH_LIMIT;
    await expect(
      getCachedPublicFeed("store", listAll(AIRTABLE_TABLES.store)),
    ).rejects.toThrow(FeedUnavailableError);
    expect(world.airtableRequests.length).toBe(0);
  });

  test("budget is shared, not environment keyed", async () => {
    seedFullBase();
    await getCachedPublicFeed("upcoming-games", listAll(AIRTABLE_TABLES.upcomingGames));
    const afterProduction = world.control.dayUsed;
    __testing.setMode("development"); // preview build
    await getCachedPublicFeed("upcoming-games", listAll(AIRTABLE_TABLES.upcomingGames));
    expect(world.control.dayUsed).toBe(afterProduction + 1);
    // Payloads remain in separate rows.
    expect(world.rows.get("preview:upcoming-games")!.payload).not.toBeNull();
    expect(world.rows.get("production:upcoming-games")!.payload).not.toBeNull();
  });

  test("budget exhaustion still serves a fresh cache", async () => {
    seedFullBase();
    const payload = await getCachedPublicFeed("records", listAll(AIRTABLE_TABLES.records));
    world.control.dayUsed = DAY_LIMIT;
    const again = await getCachedPublicFeed("records", listAll(AIRTABLE_TABLES.records));
    expect(again).toEqual(payload);
  });
});

describe("failure handling", () => {
  test("11. Airtable 429 sets a shared cooldown of at least 30s (longer Retry-After wins)", async () => {
    seedFullBase();
    world.setTable(AIRTABLE_TABLES.records, {
      records: [],
      behaviour: "429",
      retryAfter: "90",
    });
    await expect(
      getCachedPublicFeed("records", listAll(AIRTABLE_TABLES.records)),
    ).rejects.toThrow();
    expect(world.control.cooldownUntil).toBe(world.now + 90_000);
    // The cooldown is shared: another feed is blocked too.
    await expect(
      getCachedPublicFeed("store", listAll(AIRTABLE_TABLES.store)),
    ).rejects.toThrow(FeedUnavailableError);
  });

  test("11b. 429 without Retry-After uses the 30s floor", async () => {
    seedFullBase();
    world.setTable(AIRTABLE_TABLES.records, { records: [], behaviour: "429" });
    await expect(
      getCachedPublicFeed("records", listAll(AIRTABLE_TABLES.records)),
    ).rejects.toThrow();
    expect(world.control.cooldownUntil).toBe(world.now + 30_000);
  });

  test("12. Airtable timeout aborts the page and fails the refresh", async () => {
    seedFullBase();
    world.setTable(AIRTABLE_TABLES.records, { records: [], behaviour: "timeout" });
    const started = Date.now();
    await expect(
      getCachedPublicFeed("records", listAll(AIRTABLE_TABLES.records)),
    ).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(8_000);
    expect(world.rows.get("production:records")!.payload).toBeNull();
    expect(world.control.leaseToken).toBeNull();
  }, 15_000);

  test("13. 5xx failure records bounded backoff and releases the lease", async () => {
    seedFullBase();
    world.setTable(AIRTABLE_TABLES.records, { records: [], behaviour: "500" });
    await expect(
      getCachedPublicFeed("records", listAll(AIRTABLE_TABLES.records)),
    ).rejects.toThrow(FeedUnavailableError);
    const row = world.rows.get("production:records")!;
    expect(row.failureCount).toBe(1);
    expect(row.retryAfter).toBe(world.now + 10_000);
    expect(world.control.leaseToken).toBeNull();

    // Repeated failures grow the backoff, capped at 300s.
    for (let i = 0; i < 8; i++) {
      world.advance(600_000);
      await expect(
        getCachedPublicFeed("records", listAll(AIRTABLE_TABLES.records)),
      ).rejects.toThrow();
    }
    expect(row.retryAfter! - world.now).toBeLessThanOrEqual(300_000);
  });

  test("14. partial pagination is discarded and never published", async () => {
    seedFullBase();
    world.setTable(AIRTABLE_TABLES.records, {
      records: Array.from({ length: 250 }, (_, i) => ({ id: `rec${i}`, fields: {} })),
      behaviour: "fail-after-first",
    });
    await expect(
      getCachedPublicFeed("records", listAll(AIRTABLE_TABLES.records)),
    ).rejects.toThrow(FeedUnavailableError);
    expect(world.rows.get("production:records")!.payload).toBeNull();
  });

  test("17. Postgres failure fails closed without calling Airtable", async () => {
    seedFullBase();
    world.postgresDown = true;
    await expect(
      getCachedPublicFeed("records", listAll(AIRTABLE_TABLES.records)),
    ).rejects.toThrow(FeedUnavailableError);
    expect(world.airtableRequests.length).toBe(0);
  });

  test("unknown build mode fails closed", async () => {
    seedFullBase();
    __testing.setMode("staging");
    await expect(
      getCachedPublicFeed("records", listAll(AIRTABLE_TABLES.records)),
    ).rejects.toThrow(FeedUnavailableError);
    expect(world.airtableRequests.length).toBe(0);
    expect(world.rpcCalls.length).toBe(0);
  });

  test("errors exposed to callers are sanitized", async () => {
    seedFullBase();
    world.setTable(AIRTABLE_TABLES.records, { records: [], behaviour: "500" });
    try {
      await getCachedPublicFeed("records", listAll(AIRTABLE_TABLES.records));
      throw new Error("expected failure");
    } catch (error) {
      expect((error as Error).message).not.toContain("upstream detail");
    }
  });
});

describe("H1 + response shapes", () => {
  const H1_TABLES = () => {
    world.setTable(AIRTABLE_TABLES.records, {
      records: [
        {
          id: "rec1",
          fields: {
            "Show On Website": true,
            "Record Name EN": "Most goals in a match",
            "Record Name AR": "أكثر الأهداف في مباراة",
            Value: "6",
            Player: ["recVisible"],
          },
        },
        {
          id: "rec2",
          fields: {
            "Show On Website": true,
            "Record Name EN": "Fastest hat-trick",
            "Record Name AR": "أسرع ثلاثية",
            Value: "4 min",
            Player: ["recHidden"],
          },
        },
        {
          id: "rec3",
          fields: {
            "Show On Website": true,
            "Record Name EN": "Longest clean sheet",
            "Record Name AR": "أطول شباك نظيفة",
            Value: "5 games",
          },
        },
      ],
      behaviour: "ok",
    });
    world.setTable(AIRTABLE_TABLES.playersDatabase, {
      records: [
        {
          id: "recVisible",
          fields: {
            "Show On Website": true,
            "Official Name EN": "Fahad Alshabaan",
            "Official Name AR": "فهد الشعبان",
          },
        },
        {
          id: "recHidden",
          fields: {
            "Show On Website": false,
            "Official Name EN": "Hidden Player",
            "Official Name AR": "لاعب مخفي",
          },
        },
      ],
      behaviour: "ok",
    });
  };

  test("20. H1 preserved: visible holder named (EN+AR), hidden holder unclaimed", async () => {
    H1_TABLES();
    const records = (await getCachedPublicFeed("records", () =>
      fetchRecordsFromAirtable(),
    )) as Array<Record<string, unknown>>;

    const visible = records.find((r) => r["id"] === "rec1")!;
    expect(visible["holderNameEn"]).toBe("Fahad Alshabaan");
    expect(visible["holderNameAr"]).toBe("فهد الشعبان");

    const hidden = records.find((r) => r["id"] === "rec2")!;
    expect(hidden["holderNameEn"]).toBeNull();
    expect(hidden["holderNameAr"]).toBeNull();
    expect(JSON.stringify(hidden)).not.toContain("Hidden Player");
    expect(JSON.stringify(hidden)).not.toContain("لاعب مخفي");

    const unlinked = records.find((r) => r["id"] === "rec3")!;
    expect(unlinked["holderNameEn"]).toBeNull();
    expect(unlinked["holderNameAr"]).toBeNull();
  });

  test("21. cached payload keeps the existing response structure", async () => {
    H1_TABLES();
    const first = await getCachedPublicFeed("records", () => fetchRecordsFromAirtable());
    const cached = await getCachedPublicFeed("records", async () => {
      throw new Error("fresh expected");
    });
    expect(cached).toEqual(first);
    expect(Object.keys((first as Array<Record<string, unknown>>)[0]!).sort()).toEqual(
      ["holderNameAr", "holderNameEn", "id", "nameAr", "nameEn", "value"],
    );
  });
});
