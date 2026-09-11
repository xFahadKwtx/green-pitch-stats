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
  BUSY_RECHECK_ATTEMPTS,
} from "../src/lib/public-feed-cache.server";

import { AIRTABLE_TABLES, listAirtableRecords } from "../src/lib/airtable.server";
import { fetchRecordsFromAirtable } from "../src/lib/records.server";
import { fetchPlayersFromAirtable } from "../src/lib/airtable-players.server";
import { fetchStoreFromAirtable } from "../src/lib/store.server";
import { fetchUpcomingGamesFromAirtable } from "../src/lib/upcoming-games.server";


process.env["SUPABASE_URL"] = "http://coordinator.test";
process.env["SUPABASE_SERVICE_ROLE_KEY"] = "sb_secret_dummy_test_value";
process.env["LOVABLE_API_KEY"] = "dummy-lovable-key";
process.env["AIRTABLE_API_KEY"] = "dummy-airtable-key";

const DAY_LIMIT = 2100;
const MONTH_LIMIT = 65000;
const LEASE_MS = 60_000;
const DEADLINE_MS = 45_000;
const PACING_MS = 500;

function utcDayStart(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function utcMonthStart(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

interface FeedRow {
  schemaVersion: number;
  payload: unknown;
  refreshStartedAt: number | null;
  freshUntil: number | null;
  retryAfter: number | null;
  failureCount: number;
  lastPageCounts: Record<string, number>;
}

interface Lease {
  token: string | null;
  startedAt: number | null;
  expiresAt: number | null;
  lastPageSequence: number;
}

/** Exactly the eight allowed environment-scoped lease keys. */
const LEASE_KEYS = [
  "preview:players",
  "preview:records",
  "preview:store",
  "preview:upcoming-games",
  "production:players",
  "production:records",
  "production:store",
  "production:upcoming-games",
] as const;

const KEY_PATTERN = /^(preview|production):(players|records|store|upcoming-games)$/;

function emptyLeases(): Record<string, Lease> {
  const out: Record<string, Lease> = {};
  for (const key of LEASE_KEYS) {
    out[key] = { token: null, startedAt: null, expiresAt: null, lastPageSequence: 0 };
  }
  return out;
}

interface Control {
  enabled: boolean;
  /** Independent per-feed refresh leases. */
  leases: Record<string, Lease>;
  nextRequestAt: number | null;
  cooldownUntil: number | null;
  dayUsed: number;
  dayLimit: number;
  monthUsed: number;
  monthLimit: number;
  dayStart: number;
  monthStart: number;
}

interface AirtableTableState {
  records: Array<{ id: string; fields: Record<string, unknown> }>;
  /** Optional per-page behaviour override. */
  behaviour?:
    | "ok"
    | "429"
    | "500"
    | "network-error"
    | "timeout"
    | "fail-after-first"
    | "no-records-array"
    | "malformed-record"
    | "bad-offset";

  retryAfter?: string;
}

class FakeWorld {
  now = Date.parse("2026-09-08T12:00:00.000Z");
  rows = new Map<string, FeedRow>();
  /** Mirrors the seed: the coordinator ships DISABLED until activated. */
  control: Control = {
    enabled: false,
    leases: emptyLeases(),
    nextRequestAt: null,
    cooldownUntil: null,
    dayUsed: 0,
    dayLimit: DAY_LIMIT,
    monthUsed: 0,
    monthLimit: MONTH_LIMIT,
    dayStart: utcDayStart(Date.parse("2026-09-08T12:00:00.000Z")),
    monthStart: utcMonthStart(Date.parse("2026-09-08T12:00:00.000Z")),
  };
  tables = new Map<string, AirtableTableState>();
  airtableRequests: Array<{ table: string; at: number }> = [];
  rpcCalls: string[] = [];
  postgresDown = false;
  /** Extra real latency injected into permit RPCs (window-expiry testing). */
  slowPermitMs = 0;
  /** Read-only stored-payload SELECTs issued by the freshness fallback. */
  selectCalls = 0;
  selectFails = false;
  selectAdvanceMs = 0;
  selectBodyAdvanceMs = 0;
  storedTimestamps: { refresh_started_at: unknown; fresh_until: unknown } | null = null;
  omitServerDate = false;

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

  /** This feed's own lease slot. Unknown/malformed keys have no slot at all. */
  lease(key: string): Lease {
    const lease = this.control.leases[key];
    if (!lease) throw new Error("missing lease slot");
    return lease;
  }

  /** Feed keys whose own lease is currently held. */
  activeLeaseFeeds(): string[] {
    return Object.entries(this.control.leases)
      .filter(([, l]) => l.token !== null && (l.expiresAt ?? 0) > this.now)
      .map(([key]) => key);
  }

  private ownerInvalid(key: string, token: unknown): boolean {
    if (token === null || token === undefined) return true;
    if (!KEY_PATTERN.test(key)) return true;
    const lease = this.control.leases[key];
    return (
      !lease ||
      lease.token === null ||
      lease.token !== token ||
      (lease.expiresAt ?? 0) <= this.now
    );
  }

  /** UTC calendar-window normalization; lease and cooldown are preserved. */
  private normalizeWindows() {
    const c = this.control;
    const day = utcDayStart(this.now);
    const month = utcMonthStart(this.now);
    if (c.dayStart < day) {
      c.dayStart = day;
      c.dayUsed = 0;
    }
    if (c.monthStart < month) {
      c.monthStart = month;
      c.monthUsed = 0;
    }
  }

  private getOrClaim(args: Record<string, unknown>) {
    const key = String(args["p_cache_key"]);
    if (Number(args["p_schema_version"]) !== 1) {
      throw new Error("unsupported schema version");
    }
    // Unknown/malformed keys fail closed (the SQL raises on them).
    if (!KEY_PATTERN.test(key)) throw new Error("invalid cache key");
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
    this.normalizeWindows();
    // Busy only when THIS feed's own lease is held; other feeds never block it.
    const lease = this.lease(key);
    if (lease.expiresAt !== null && lease.expiresAt > this.now) {
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
    lease.token = token;
    lease.startedAt = this.now;
    lease.expiresAt = this.now + LEASE_MS;
    lease.lastPageSequence = 0;
    // The prior payload's refresh_started_at is intentionally untouched.
    return {
      status: "claimed",
      lease_token: token,
      refresh_deadline_ms: DEADLINE_MS,
      lease_expires_at: lease.expiresAt,
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
    if (!KEY_PATTERN.test(key)) return { status: "invalid" };
    if (!Number.isInteger(sequence) || sequence < 1) return { status: "invalid" };
    if (this.ownerInvalid(key, token)) return { status: "expired" };
    if (!c.enabled) return { status: "disabled" };
    const lease = this.lease(key);
    if (lease.startedAt === null || this.now >= lease.startedAt + DEADLINE_MS) {
      return { status: "deadline_exceeded" };
    }
    // Strictly sequential WITHIN this feed's refresh.
    if (sequence !== lease.lastPageSequence + 1) return { status: "sequence_conflict" };
    // Every grant must charge the CURRENT UTC day/month window.
    this.normalizeWindows();
    if (c.cooldownUntil !== null && c.cooldownUntil > this.now) return { status: "cooldown" };
    if (c.dayUsed >= c.dayLimit || c.monthUsed >= c.monthLimit) {
      return { status: "budget_exhausted" };
    }
    // Global dispatch spacing, shared by every feed.
    if (c.nextRequestAt !== null && c.nextRequestAt > this.now) {
      return { status: "paced", wait_ms: c.nextRequestAt - this.now };
    }
    c.dayUsed += 1;
    c.monthUsed += 1;
    lease.lastPageSequence = sequence;
    c.nextRequestAt = this.now + PACING_MS;
    return {
      status: "granted",
      usable_for_ms: 1000,
      sequence,
      refresh_deadline_ms: lease.startedAt + DEADLINE_MS - this.now,
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
    if (!KEY_PATTERN.test(key)) return { status: "rejected", reason: "invalid_arguments" };
    const row = this.row(key);
    const c = this.control;
    if (this.ownerInvalid(key, token)) return { status: "stale_lease" };
    if (!c.enabled) return { status: "rejected", reason: "disabled" };
    const lease = this.lease(key);
    if (lease.startedAt === null || this.now >= lease.startedAt + DEADLINE_MS) {
      return { status: "rejected", reason: "deadline_exceeded" };
    }
    const sum = (values as number[]).reduce((a, b) => a + b, 0);
    if (sum !== lease.lastPageSequence) {
      return { status: "rejected", reason: "page_count_mismatch" };
    }
    const started = lease.startedAt;
    row.payload = payload;
    row.refreshStartedAt = started;
    row.freshUntil = started + FEED_TTL_SECONDS * 1000;
    row.retryAfter = null;
    row.failureCount = 0;
    row.lastPageCounts = counts as Record<string, number>;
    this.releaseLease(key);
    return { status: "published", fresh_until: row.freshUntil };
  }

  private fail(args: Record<string, unknown>) {
    const key = args["p_cache_key"];
    const token = args["p_lease_token"];
    if (typeof key !== "string" || token === null || token === undefined) {
      return { status: "ignored", reason: "invalid_arguments" };
    }
    if (!KEY_PATTERN.test(key)) return { status: "ignored", reason: "invalid_arguments" };
    const row = this.row(key);
    // A stale or expired owner may not alter ANY state, of any feed.
    if (this.ownerInvalid(key, token)) return { status: "ignored", reason: "stale_lease" };

    row.failureCount += 1;
    const backoff = Math.min(300, 10 * 2 ** Math.min(row.failureCount - 1, 10));
    row.retryAfter = Math.max(row.retryAfter ?? this.now, this.now + backoff * 1000);
    if (args["p_kind"] === "rate_limited") {
      const supplied = Number(args["p_retry_after_seconds"]);
      const seconds =
        Number.isFinite(supplied) && supplied > 0 ? Math.max(30, supplied) : 30;
      const until = this.now + seconds * 1000;
      // Never shorten an existing cooldown.
      this.control.cooldownUntil = Math.max(this.control.cooldownUntil ?? 0, until);
    }
    this.releaseLease(key);
    return { status: "recorded", released: true };
  }


  /** Releases ONLY this feed's lease. */
  private releaseLease(key: string) {
    const lease = this.lease(key);
    lease.token = null;
    lease.startedAt = null;
    lease.expiresAt = null;
    lease.lastPageSequence = 0;
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
    if (state.behaviour === "network-error") {
      // Socket-style transport rejection: fetch rejects, no HTTP response at all.
      throw new TypeError("fetch failed: upstream detail ECONNRESET");
    }
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
    // Malformed 200 responses: each must fail the whole refresh.
    if (state.behaviour === "no-records-array") {
      return new Response(JSON.stringify({ records: "nope" }), { status: 200 });
    }
    if (state.behaviour === "malformed-record") {
      return new Response(JSON.stringify({ records: [{ id: 42 }] }), { status: 200 });
    }
    if (state.behaviour === "bad-offset") {
      return new Response(JSON.stringify({ records: [], offset: "" }), { status: 200 });
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
const realDateNow = Date.now;

function installFetch() {
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const raw =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    const url = new URL(raw);

    if (url.host === "coordinator.test" && url.pathname.endsWith("/airtable_public_cache")) {
      // Read-only lookup includes authoritative row timestamps and server time.
      const headers = new Headers(init?.headers);
      expect(headers.get("apikey")).toBeTruthy();
      expect(String(init?.method ?? "GET").toUpperCase()).toBe("GET");
      expect(url.searchParams.get("select")).toBe("payload,refresh_started_at,fresh_until");
      world.selectCalls += 1;
      if (world.selectFails) return new Response("{}", { status: 500 });
      const key = (url.searchParams.get("cache_key") ?? "").replace(/^eq\./, "");
      const row = world.rows.get(key);
      const body =
        row && row.schemaVersion === 1 ? [{ payload: row.payload ?? null,
          ...(world.storedTimestamps ?? {
            refresh_started_at: row.refreshStartedAt === null ? null : new Date(row.refreshStartedAt).toISOString(),
            fresh_until: row.freshUntil === null ? null : new Date(row.freshUntil).toISOString(),
          }),
        }] : [];
      const serverDate = new Date(world.now).toUTCString();
      world.advance(world.selectAdvanceMs);
      const response = new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json", ...(world.omitServerDate ? {} : { date: serverDate }) },
      });
      const json = response.json.bind(response);
      response.json = async () => { world.advance(world.selectBodyAdvanceMs); return json(); };
      return response;
    }

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
  Date.now = () => world.now;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  Date.now = realDateNow;
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

describe("strict 900-second freshness correction", () => {
  const feeds = ["players", "records", "store", "upcoming-games"] as const;
  const statuses = ["busy", "backoff", "cooldown", "budget_exhausted", "disabled", "unknown",
    "stale-window", "no-time"] as const;

  function seedCache(feed: typeof feeds[number], age: number) {
    const row = world.rows.get(`production:${feed}`)!;
    Object.assign(row, {
      payload: [{ id: "previously-public-id", nameEn: "Later hidden", nameAr: "مخفي الآن",
        balance: 900, price: 100, holderNameEn: "Later hidden", game: "old listing" }],
      refreshStartedAt: world.now - age,
      freshUntil: world.now - age + 900_000,
    });
    return row;
  }

  function forceClaimStatus(status: typeof statuses[number]) {
    const original = world.rpc.bind(world);
    world.rpc = (fn, args) => {
      if (fn !== "h2_get_or_claim") return original(fn, args);
      world.rpcCalls.push(fn);
      if (status === "stale-window") return { status: "fresh", fresh_for_ms: 0 };
      if (status === "no-time") return { status: "claimed", lease_token: "lease", refresh_deadline_ms: 0 };
      return { status };
    };
  }

  const mustNotLoad = async () => { throw new Error("loader must not run"); };

  for (const feed of feeds) {
    test(`${feed}: fresh during outage at 899.999s, unavailable at 900s and subsequent backoff`, async () => {
      const row = seedCache(feed, 899_999);
      world.seedTable(AIRTABLE_TABLES.records, 1, { behaviour: "500" });
      const loader = listAll(AIRTABLE_TABLES.records);
      expect(await getCachedPublicFeed(feed, loader)).toEqual(row.payload);
      expect(world.airtableRequests).toEqual([]);
      world.advance(1);
      await expect(getCachedPublicFeed(feed, loader)).rejects.toThrow(FeedUnavailableError);
      expect(world.airtableRequests.length).toBe(1);
      const calls = [...world.rpcCalls];
      await expect(getCachedPublicFeed(feed, loader)).rejects.toThrow(FeedUnavailableError);
      expect(world.airtableRequests.length).toBe(1);
      expect(world.rpcCalls).toEqual([...calls, "h2_get_or_claim"]);
      expect(world.activeLeaseFeeds()).toEqual([]);
    });

    for (const status of statuses) {
      test(`${feed}: ${status} rejects an expired non-empty stored response without upstream work`, async () => {
        seedCache(feed, 30 * 24 * 60 * 60_000);
        forceClaimStatus(status);
        const controlBefore = structuredClone(world.control);
        await expect(getCachedPublicFeed(feed, mustNotLoad)).rejects.toThrow(FeedUnavailableError);
        expect(world.selectCalls).toBe(1);
        expect(world.airtableRequests).toEqual([]);
        expect(world.rpcCalls).toEqual(Array(status === "busy" || status === "stale-window" ? BUSY_RECHECK_ATTEMPTS + 1 : 1).fill("h2_get_or_claim"));
        expect(world.control).toEqual(controlBefore);
      });

      test(`${feed}: ${status} can serve a still-fresh concurrently published response`, async () => {
        const row = seedCache(feed, 60_000);
        forceClaimStatus(status);
        const controlBefore = structuredClone(world.control);
        expect(await getCachedPublicFeed(feed, mustNotLoad)).toEqual(row.payload);
        expect(world.selectCalls).toBe(1);
        expect(world.airtableRequests).toEqual([]);
        expect(world.control).toEqual(controlBefore);
      });
    }

    test(`${feed}: stored fallback rejects exactly at 900 seconds`, async () => {
      seedCache(feed, 900_000);
      forceClaimStatus("cooldown");
      await expect(getCachedPublicFeed(feed, mustNotLoad)).rejects.toThrow(FeedUnavailableError);
      expect(world.airtableRequests).toEqual([]);
    });
  }

  for (const stage of ["selectAdvanceMs", "selectBodyAdvanceMs"] as const) {
    test(`stored fallback cannot expire during ${stage} and still be returned`, async () => {
      seedCache("players", 898_000);
      forceClaimStatus("cooldown");
      world[stage] = 2_000;
      await expect(getCachedPublicFeed("players", mustNotLoad)).rejects.toThrow(FeedUnavailableError);
      expect(world.airtableRequests).toEqual([]);
    });
  }

  test("stored fallback never trusts fresh_until beyond 900s from refresh START", async () => {
    const row = seedCache("players", 900_000);
    row.freshUntil = world.now + 900_000;
    forceClaimStatus("cooldown");
    await expect(getCachedPublicFeed("players", mustNotLoad)).rejects.toThrow(FeedUnavailableError);
  });

  test("stored fallback obeys an earlier fresh_until", async () => {
    const row = seedCache("players", 60_000);
    row.freshUntil = world.now;
    forceClaimStatus("cooldown");
    await expect(getCachedPublicFeed("players", mustNotLoad)).rejects.toThrow(FeedUnavailableError);
  });

  for (const timestamps of [
    { refresh_started_at: null, fresh_until: null },
    { refresh_started_at: "invalid", fresh_until: "invalid" },
    { refresh_started_at: 123, fresh_until: 456 },
    { refresh_started_at: "2026-09-08T13:00:00Z", fresh_until: "2026-09-08T13:15:00Z" },
    { refresh_started_at: "2026-09-08T12:00:00Z", fresh_until: "2026-09-08T11:00:00Z" },
  ]) {
    test(`stored fallback rejects missing or inconsistent timestamps: ${JSON.stringify(timestamps)}`, async () => {
      seedCache("players", 60_000);
      world.storedTimestamps = timestamps;
      forceClaimStatus("cooldown");
      await expect(getCachedPublicFeed("players", mustNotLoad)).rejects.toThrow(FeedUnavailableError);
    });
  }

  test("a slow application wall clock cannot revive an expired stored payload", async () => {
    seedCache("players", 900_000);
    Date.now = () => world.now - 300_000;
    forceClaimStatus("cooldown");
    await expect(getCachedPublicFeed("players", mustNotLoad)).rejects.toThrow(FeedUnavailableError);
  });

  test("missing server Date fails closed for stored fallback", async () => {
    seedCache("players", 60_000);
    world.omitServerDate = true;
    forceClaimStatus("cooldown");
    await expect(getCachedPublicFeed("players", mustNotLoad)).rejects.toThrow(FeedUnavailableError);
  });

  for (const cleanup of ["fresh", "expires", "fails"] as const) {
    test(`Players empty-refresh protection: previous payload ${cleanup} during cleanup`, async () => {
      // Simulate a stored response becoming fresh after the claim, before lookup.
      const row = seedCache("players", 900_000);
      const previous = structuredClone(row.payload);
      world.rpcAdvanceMs.h2_fail_refresh = cleanup === "expires" ? 2_000 : 0;
      const original = world.rpc.bind(world);
      if (cleanup === "fails") world.rpc = (fn, args) => {
        if (fn === "h2_fail_refresh") { world.rpcCalls.push(fn); throw new Error("DB unavailable"); }
        return original(fn, args);
      };
      const run = getCachedPublicFeed("players", async () => {
        row.refreshStartedAt = world.now - (cleanup === "expires" ? 898_000 : 60_000);
        row.freshUntil = row.refreshStartedAt + 900_000;
        return [];
      });
      if (cleanup === "expires") await expect(run).rejects.toThrow(FeedUnavailableError);
      else expect(await run).toEqual(previous);
      expect(row.payload).toEqual(previous);
      expect(world.rpcCalls).toEqual(["h2_get_or_claim", "h2_fail_refresh"]);
      expect(world.selectCalls).toBe(1);
      expect(world.airtableRequests).toEqual([]);
      if (cleanup !== "fails") expect(world.activeLeaseFeeds()).toEqual([]);
    });
  }
});

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

  test("19. expired data with budget exhausted is rejected", async () => {
    seedFullBase();
    const first = await getCachedPublicFeed("records", listAll(AIRTABLE_TABLES.records));
    world.advance(FEED_TTL_SECONDS * 1000 + 1);
    world.postgresDown = false;
    world.control.dayUsed = DAY_LIMIT; // budget exhausted after expiry
    await expect(getCachedPublicFeed("records", listAll(AIRTABLE_TABLES.records))).rejects.toThrow(FeedUnavailableError);
    expect(world.rows.get("production:records")!.payload).toEqual(first);
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

  test("10. pacing: grants are spaced 500ms apart and dispatch waits for the window", async () => {
    seedFullBase();
    world.seedTable(AIRTABLE_TABLES.records, 250);
    await getCachedPublicFeed("records", listAll(AIRTABLE_TABLES.records));
    const times = world.airtableRequests.map((r) => r.at);
    for (let i = 1; i < times.length; i++) {
      expect(times[i]! - times[i - 1]!).toBeGreaterThanOrEqual(PACING_MS);
    }
  });

  test("pacing waits are bounded by the refresh deadline, not an attempt count", async () => {
    seedFullBase();
    // Long shared spacing backlog (other feeds queued ahead): the 3s wait cap
    // means far more than eight pacing waits, all still inside the 45s deadline.
    world.control.nextRequestAt = world.now + 27_000;
    const data = await getCachedPublicFeed("records", listAll(AIRTABLE_TABLES.records));
    expect(Array.isArray(data)).toBe(true);
    expect(world.airtableRequests.length).toBeGreaterThan(0);
    expect(world.rows.get("production:records")!.payload).not.toBeNull();
  });

  test("pacing still fails closed when the backlog outlasts the refresh deadline", async () => {
    seedFullBase();
    world.control.nextRequestAt = world.now + 120_000;
    await expect(
      getCachedPublicFeed("records", listAll(AIRTABLE_TABLES.records)),
    ).rejects.toThrow(FeedUnavailableError);
    expect(world.airtableRequests.length).toBe(0);
  });


  test("expired permit window is never reused (RPC elapsed time counts)", async () => {
    seedFullBase();
    // 1.2s is consumed INSIDE the permit round-trip, so the 1s usable window
    // has already elapsed when the grant arrives: fail closed, no dispatch.
    world.rpcAdvanceMs["h2_take_page_permit"] = 1_200;
    await expect(
      getCachedPublicFeed("records", listAll(AIRTABLE_TABLES.records)),
    ).rejects.toThrow(FeedUnavailableError);
    expect(world.airtableRequests.length).toBe(0);
    expect(world.rows.get("production:records")!.payload).toBeNull();
  });


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
    expect(world.activeLeaseFeeds()).toEqual([]);
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
    expect(world.activeLeaseFeeds()).toEqual([]);

    // Repeated failures grow the backoff, capped at 300s.
    for (let i = 0; i < 8; i++) {
      world.advance(600_000);
      await expect(
        getCachedPublicFeed("records", listAll(AIRTABLE_TABLES.records)),
      ).rejects.toThrow();
    }
    expect(row.retryAfter! - world.now).toBeLessThanOrEqual(300_000);
  });

  test("13b. Airtable network rejection is counted, sanitized, and stops queued pages", async () => {
    seedFullBase();
    // Multi-page table: only the first page may be dispatched before the failure.
    world.setTable(AIRTABLE_TABLES.records, {
      records: Array.from({ length: 250 }, (_, i) => ({ id: `rec${i}`, fields: {} })),
      behaviour: "network-error",
    });
    const dayUsedBefore = world.control.dayUsed;

    let surfaced: unknown;
    try {
      await getCachedPublicFeed("records", listAll(AIRTABLE_TABLES.records));
      throw new Error("expected failure");
    } catch (error) {
      surfaced = error;
    }

    // One sanitized error surfaces, distinct from an HTTP status leak.
    expect(surfaced).toBeInstanceOf(FeedUnavailableError);
    const message = (surfaced as Error).message;
    expect(message).not.toContain("upstream detail");
    expect(message).not.toContain("ECONNRESET");

    // The attempted page is counted exactly once and no queued page dispatched.
    expect(world.airtableRequests.length).toBe(1);
    expect(world.control.dayUsed).toBe(dayUsedBefore + 1);

    // No partial publish; lease released with the 10s first-failure backoff.
    const row = world.rows.get("production:records")!;
    expect(row.payload).toBeNull();
    expect(row.failureCount).toBe(1);
    expect(row.retryAfter).toBe(world.now + 10_000);
    expect(world.activeLeaseFeeds()).toEqual([]);
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

describe("review regressions", () => {
  test("22. exact TTL boundary: fresh at 899.999s, stale at exactly 900s", async () => {
    seedFullBase();
    await getCachedPublicFeed("records", listAll(AIRTABLE_TABLES.records));
    const before = world.airtableRequests.length;

    world.advance(FEED_TTL_SECONDS * 1000 - 1);
    await getCachedPublicFeed("records", async () => {
      throw new Error("must still be fresh");
    });
    expect(world.airtableRequests.length).toBe(before);

    world.advance(1); // exactly 900s from refresh START
    await getCachedPublicFeed("records", listAll(AIRTABLE_TABLES.records));
    expect(world.airtableRequests.length).toBeGreaterThan(before);
  });

  test("23. exact 45s refresh deadline: a page at the boundary is refused", async () => {
    seedFullBase();
    world.seedTable(AIRTABLE_TABLES.records, 250);
    await expect(
      getCachedPublicFeed("records", async () => {
        // Burn exactly the whole refresh budget before the first page.
        world.advance(DEADLINE_MS);
        return listAirtableRecords(AIRTABLE_TABLES.records);
      }),
    ).rejects.toThrow(FeedUnavailableError);
    expect(world.airtableRequests.length).toBe(0);
    expect(world.rows.get("production:records")!.payload).toBeNull();
  });

  test("24. TTL is measured from refresh START, including RPC elapsed time", async () => {
    seedFullBase();
    world.rpcAdvanceMs["h2_finish_refresh"] = 5_000;
    await getCachedPublicFeed("records", listAll(AIRTABLE_TABLES.records));
    const row = world.rows.get("production:records")!;
    // fresh_until derives from the lease start, not from publish time.
    expect(row.freshUntil! - row.refreshStartedAt!).toBe(FEED_TTL_SECONDS * 1000);
  });

  test("25. a stale/expired owner mutates no coordinator state", async () => {
    seedFullBase();
    const claim = world.rpc("h2_get_or_claim", {
      p_cache_key: "production:records",
      p_schema_version: 1,
    }) as Record<string, unknown>;
    world.advance(LEASE_MS + 1); // lease expired
    const row = world.rows.get("production:records")!;
    const snapshot = { ...row };
    const cooldown = world.control.cooldownUntil;

    const failed = world.rpc("h2_fail_refresh", {
      p_cache_key: "production:records",
      p_lease_token: claim["lease_token"],
      p_kind: "rate_limited",
      p_retry_after_seconds: 3600,
    }) as Record<string, unknown>;
    expect(failed["status"]).toBe("ignored");
    expect(row.failureCount).toBe(snapshot.failureCount);
    expect(row.retryAfter).toBe(snapshot.retryAfter);
    expect(world.control.cooldownUntil).toBe(cooldown);
  });

  test("26. NULL lease tokens are rejected by every owner operation", async () => {
    const permit = world.rpc("h2_take_page_permit", {
      p_cache_key: "production:records",
      p_lease_token: null,
      p_sequence: 1,
    }) as Record<string, unknown>;
    expect(permit["status"]).toBe("invalid");

    const finish = world.rpc("h2_finish_refresh", {
      p_cache_key: "production:records",
      p_lease_token: null,
      p_payload: [],
      p_page_counts: {},
    }) as Record<string, unknown>;
    expect(finish["status"]).toBe("rejected");

    const fail = world.rpc("h2_fail_refresh", {
      p_cache_key: null,
      p_lease_token: null,
      p_kind: "failure",
      p_retry_after_seconds: null,
    }) as Record<string, unknown>;
    expect(fail["status"]).toBe("ignored");
    expect(world.rows.get("production:records")!.payload).toBeNull();
  });

  test("27. the seeded (disabled) coordinator never contacts Airtable", async () => {
    seedFullBase();
    world.control.enabled = false;
    await expect(
      getCachedPublicFeed("records", listAll(AIRTABLE_TABLES.records)),
    ).rejects.toThrow(FeedUnavailableError);
    expect(world.airtableRequests.length).toBe(0);
  });

  test("28. disabling mid-lease stops further pages and blocks publishing", async () => {
    seedFullBase();
    world.seedTable(AIRTABLE_TABLES.records, 250);
    await expect(
      getCachedPublicFeed("records", async () => {
        world.control.enabled = false;
        return listAirtableRecords(AIRTABLE_TABLES.records);
      }),
    ).rejects.toThrow(FeedUnavailableError);
    expect(world.rows.get("production:records")!.payload).toBeNull();
  });

  test("29. a malformed 200 page fails the whole refresh (never an empty page)", async () => {
    for (const behaviour of ["no-records-array", "malformed-record", "bad-offset"] as const) {
      world = new FakeWorld();
      world.control.enabled = true;
      seedFullBase();
      world.setTable(AIRTABLE_TABLES.records, { records: [], behaviour });
      await expect(
        getCachedPublicFeed("records", listAll(AIRTABLE_TABLES.records)),
      ).rejects.toThrow(FeedUnavailableError);
      expect(world.rows.get("production:records")!.payload).toBeNull();
    }
  });

  test("30. no queued page dispatches after one page fails", async () => {
    seedFullBase();
    world.seedTable(AIRTABLE_TABLES.records, 250, { behaviour: "fail-after-first" });
    await expect(
      getCachedPublicFeed("records", listAll(AIRTABLE_TABLES.records)),
    ).rejects.toThrow(FeedUnavailableError);
    // Exactly the failing page plus its predecessor; nothing queued after it ran.
    expect(world.airtableRequests.length).toBe(2);
  });

  test("31. duplicate offsets abort the refresh before any sibling dispatch", async () => {
    seedFullBase();
    await expect(
      getCachedPublicFeed("records", async () => {
        const { runAirtablePage } = await import("../src/lib/public-feed-cache.server");
        await runAirtablePage(AIRTABLE_TABLES.records, "dup", async () => ({ ok: true }));
        await runAirtablePage(AIRTABLE_TABLES.records, "dup", async () => ({ ok: true }));
        return [];
      }),
    ).rejects.toThrow(FeedUnavailableError);
    expect(world.rows.get("production:records")!.payload).toBeNull();
  });

  test("32. independent instances share the coordinator, local coalescing does not", async () => {
    seedFullBase();
    // One instance: 6 concurrent callers collapse to a single claim.
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        getCachedPublicFeed("records", listAll(AIRTABLE_TABLES.records)),
      ),
    );
    expect(results.every((r) => Array.isArray(r))).toBe(true);
    expect(world.rpcCalls.filter((f) => f === "h2_get_or_claim").length).toBe(1);

    // Another instance (raw coordinator call) is served from the shared cache.
    const other = world.rpc("h2_get_or_claim", {
      p_cache_key: "production:records",
      p_schema_version: 1,
    }) as Record<string, unknown>;
    expect(other["status"]).toBe("fresh");
    expect(Number(other["fresh_for_ms"])).toBeGreaterThan(0);
  });

  test("33. the four business loaders keep their output shapes and page costs", async () => {
    seedFullBase();
    const players = (await getCachedPublicFeed("players", () =>
      fetchPlayersFromAirtable(),
    )) as unknown[];
    expect(Array.isArray(players)).toBe(true);
    expect(
      world.airtableRequests.filter((r) => r.table === AIRTABLE_TABLES.playersDatabase).length,
    ).toBe(2);

    const upcoming = (await getCachedPublicFeed("upcoming-games", () =>
      fetchUpcomingGamesFromAirtable(),
    )) as unknown[];
    expect(Array.isArray(upcoming)).toBe(true);
    expect(
      world.airtableRequests.filter((r) => r.table === AIRTABLE_TABLES.upcomingGames).length,
    ).toBe(1);

    const store = (await getCachedPublicFeed("store", () =>
      fetchStoreFromAirtable(),
    )) as unknown[];
    expect(Array.isArray(store)).toBe(true);
    expect(
      world.airtableRequests.filter((r) => r.table === AIRTABLE_TABLES.store).length,
    ).toBe(1);

    const records = (await getCachedPublicFeed("records", () =>
      fetchRecordsFromAirtable(),
    )) as unknown[];
    expect(Array.isArray(records)).toBe(true);
    expect(
      world.airtableRequests.filter((r) => r.table === AIRTABLE_TABLES.records).length,
    ).toBe(1);
  });

  test("34. no test reached a real network host", () => {
    expect(globalThis.fetch).not.toBe(realFetch);
  });
});

describe("final review corrections", () => {
  test("35. a refresh crossing UTC midnight charges pages to the new day", async () => {
    seedFullBase();
    world.seedTable(AIRTABLE_TABLES.records, 250);
    world.control.dayUsed = DAY_LIMIT - 1;
    world.control.monthUsed = 10;
    // Move to one second before midnight UTC, then let the refresh cross it.
    world.now = Date.parse("2026-09-08T23:59:59.000Z");
    world.control.dayStart = utcDayStart(world.now);
    world.control.monthStart = utcMonthStart(world.now);

    await getCachedPublicFeed("records", async () => {
      world.advance(2_000); // now past midnight, still inside the same lease
      return listAirtableRecords(AIRTABLE_TABLES.records);
    });

    // The day window reset inside the permit call, so pages are charged to the
    // current day and none were lost or charged to the old window.
    expect(world.control.dayStart).toBe(utcDayStart(world.now));
    expect(world.control.dayUsed).toBe(3);
    expect(world.control.monthUsed).toBe(13);
    expect(world.rows.get("production:records")!.payload).not.toBeNull();
  });

  test("36. a refresh crossing a UTC month boundary resets the month window", async () => {
    seedFullBase();
    world.control.monthUsed = MONTH_LIMIT - 1;
    world.now = Date.parse("2026-09-30T23:59:59.000Z");
    world.control.dayStart = utcDayStart(world.now);
    world.control.monthStart = utcMonthStart(world.now);

    await getCachedPublicFeed("records", async () => {
      world.advance(2_000); // into October
      return listAirtableRecords(AIRTABLE_TABLES.records);
    });

    expect(world.control.monthStart).toBe(utcMonthStart(world.now));
    expect(world.control.monthUsed).toBe(1);
    expect(world.rows.get("production:records")!.payload).not.toBeNull();
  });

  test("37. a Retry-After longer than 7 days is honoured in full", async () => {
    seedFullBase();
    const tenDays = 864_000;
    world.seedTable(AIRTABLE_TABLES.records, 10, {
      behaviour: "429",
      retryAfter: String(tenDays),
    });
    await expect(
      getCachedPublicFeed("records", listAll(AIRTABLE_TABLES.records)),
    ).rejects.toThrow(FeedUnavailableError);
    expect(world.control.cooldownUntil).toBe(world.now + tenDays * 1000);
  });

  test("38. a fresh window exhausted during the RPC is not served", async () => {
    seedFullBase();
    await getCachedPublicFeed("records", listAll(AIRTABLE_TABLES.records));
    const served = world.airtableRequests.length;

    world.advance(FEED_TTL_SECONDS * 1000 - 1_000); // 1s of freshness left
    world.rpcAdvanceMs["h2_get_or_claim"] = 1_000; // fully consumed in flight
    await getCachedPublicFeed("records", listAll(AIRTABLE_TABLES.records));
    // The stale-by-a-hair payload was rejected and a real refresh happened.
    expect(world.airtableRequests.length).toBeGreaterThan(served);
  });

  test("39. a rejected completion calls h2_fail_refresh exactly once", async () => {
    seedFullBase();
    await expect(
      getCachedPublicFeed("records", async () => {
        await listAirtableRecords(AIRTABLE_TABLES.records);
        // Not an array: the coordinator refuses to publish it.
        return { bad: true } as unknown as unknown[];
      }),
    ).rejects.toThrow(FeedUnavailableError);
    expect(world.rpcCalls.filter((f) => f === "h2_fail_refresh").length).toBe(1);
    expect(world.rows.get("production:records")!.payload).toBeNull();
    expect(world.activeLeaseFeeds()).toEqual([]);
  });

  test("40. exceeding the deadline before completion never publishes", async () => {
    seedFullBase();
    await expect(
      getCachedPublicFeed("records", async () => {
        const rows = await listAirtableRecords(AIRTABLE_TABLES.records);
        world.advance(DEADLINE_MS); // deadline gone before the finish call
        return rows;
      }),
    ).rejects.toThrow(FeedUnavailableError);
    expect(world.rpcCalls.filter((f) => f === "h2_finish_refresh").length).toBe(0);
    expect(world.rpcCalls.filter((f) => f === "h2_fail_refresh").length).toBe(1);
    expect(world.rows.get("production:records")!.payload).toBeNull();
  });
});

describe("hard-expiry fallback and Players empty-overwrite protection", () => {
  const playersLoader = () => fetchPlayersFromAirtable();
  const KEY = "production:players";

  /** Website-visible player rows (the mapper skips anything else). */
  function seedVisiblePlayers(count: number) {
    world.setTable(AIRTABLE_TABLES.playersDatabase, {
      behaviour: "ok",
      records: Array.from({ length: count }, (_, i) => ({
        id: `recVisiblePlayer${String(i).padStart(6, "0")}`,
        fields: {
          "Show On Website": true,
          "Official Name EN": `Player ${i}`,
          "Official Name AR": `لاعب ${i}`,
          Position: ["MID"],
          "Player ID": `p${i}`,
        } as Record<string, unknown>,
      })),
    });
  }

  /** One successful players refresh, then the freshness window expires. */
  async function warmThenExpire() {
    seedFullBase();
    seedVisiblePlayers(3);
    const first = (await getCachedPublicFeed("players", playersLoader)) as unknown[];
    expect(first.length).toBe(3);
    world.advance(FEED_TTL_SECONDS * 1000 + 1_000);
    return first;
  }


  test("41. busy coordinator rejects expired players after bounded rechecks", async () => {
    const first = await warmThenExpire();
    const before = world.airtableRequests.length;
    // Another instance owns the PLAYERS lease for longer than the rechecks.
    Object.assign(world.lease(KEY), {
      token: "other-token",
      startedAt: world.now,
      expiresAt: world.now + 10 * LEASE_MS,
      lastPageSequence: 0,
    });

    await expect(getCachedPublicFeed("players", playersLoader)).rejects.toThrow(FeedUnavailableError);
    expect(world.rows.get(KEY)!.payload).toEqual(first);
    expect(world.airtableRequests.length).toBe(before);
    expect(world.selectCalls).toBeGreaterThan(0);
  });

  test("42. cooldown, backoff and exhausted budget all reject expired players", async () => {
    const first = await warmThenExpire();
    const before = world.airtableRequests.length;

    world.control.cooldownUntil = world.now + 60 * 60_000;
    await expect(getCachedPublicFeed("players", playersLoader)).rejects.toThrow(FeedUnavailableError);

    world.control.cooldownUntil = null;
    world.rows.get(KEY)!.retryAfter = world.now + 60_000;
    await expect(getCachedPublicFeed("players", playersLoader)).rejects.toThrow(FeedUnavailableError);

    world.rows.get(KEY)!.retryAfter = null;
    world.control.dayUsed = DAY_LIMIT;
    await expect(getCachedPublicFeed("players", playersLoader)).rejects.toThrow(FeedUnavailableError);

    expect(world.airtableRequests.length).toBe(before);
  });

  test("43. disabled coordinator rejects expired players", async () => {
    const first = await warmThenExpire();
    world.control.enabled = false;
    await expect(getCachedPublicFeed("players", playersLoader)).rejects.toThrow(FeedUnavailableError);
  });

  test("44. records feed rejects expired payload during cooldown", async () => {
    seedFullBase();
    const recordsLoader = () => listAll(AIRTABLE_TABLES.records)();
    const first = (await getCachedPublicFeed("records", recordsLoader)) as unknown[];
    expect(first.length).toBeGreaterThan(0);
    world.advance(FEED_TTL_SECONDS * 1000 + 1_000);
    const before = world.airtableRequests.length;

    world.control.cooldownUntil = world.now + 60 * 60_000;
    await expect(getCachedPublicFeed("records", recordsLoader)).rejects.toThrow(FeedUnavailableError);
    expect(world.airtableRequests.length).toBe(before);
    expect(world.selectCalls).toBeGreaterThan(0);
  });

  test("44b. records feed with no cached payload still fails closed", async () => {
    seedFullBase();
    world.control.cooldownUntil = world.now + 60_000;
    await expect(
      getCachedPublicFeed("records", listAll(AIRTABLE_TABLES.records)),
    ).rejects.toThrow(FeedUnavailableError);
    expect(world.airtableRequests.length).toBe(0);
  });

  test("44c. upcoming-games feed rejects expired payload during cooldown", async () => {
    seedFullBase();
    const ugLoader = () => listAll(AIRTABLE_TABLES.upcomingGames)();
    const first = (await getCachedPublicFeed("upcoming-games", ugLoader)) as unknown[];
    expect(first.length).toBeGreaterThan(0);
    world.advance(FEED_TTL_SECONDS * 1000 + 1_000);
    const before = world.airtableRequests.length;

    world.control.cooldownUntil = world.now + 60 * 60_000;
    await expect(getCachedPublicFeed("upcoming-games", ugLoader)).rejects.toThrow(FeedUnavailableError);
    expect(world.airtableRequests.length).toBe(before);
    expect(world.selectCalls).toBeGreaterThan(0);
  });

  test("44d. upcoming-games feed with no cached payload still fails closed", async () => {
    seedFullBase();
    world.control.cooldownUntil = world.now + 60_000;
    await expect(
      getCachedPublicFeed("upcoming-games", listAll(AIRTABLE_TABLES.upcomingGames)),
    ).rejects.toThrow(FeedUnavailableError);
    expect(world.airtableRequests.length).toBe(0);
  });

  test("45. no cached players payload still fails closed", async () => {
    seedFullBase();
    world.control.cooldownUntil = world.now + 60_000;
    await expect(getCachedPublicFeed("players", playersLoader)).rejects.toThrow(
      FeedUnavailableError,
    );
    expect(world.airtableRequests.length).toBe(0);
  });

  test("46. an unreadable stale lookup fails closed and leaks nothing", async () => {
    await warmThenExpire();
    world.control.cooldownUntil = world.now + 60_000;
    world.selectFails = true;
    await expect(getCachedPublicFeed("players", playersLoader)).rejects.toThrow(
      FeedUnavailableError,
    );
  });

  test("47. an empty refresh neither overwrites nor returns an expired players payload", async () => {
    const first = await warmThenExpire();
    const finishesBefore = world.rpcCalls.filter((f) => f === "h2_finish_refresh").length;
    // Every player row disappears from Airtable: the mapper yields [].
    world.seedTable(AIRTABLE_TABLES.playersDatabase, 0);

    const failuresBefore = world.rpcCalls.filter((f) => f === "h2_fail_refresh").length;
    await expect(getCachedPublicFeed("players", playersLoader)).rejects.toThrow(FeedUnavailableError);
    expect(world.rpcCalls.filter((f) => f === "h2_fail_refresh").length).toBe(failuresBefore + 1);
    // The stored payload is untouched and no empty publish happened.
    expect(world.rows.get(KEY)!.payload).toEqual(first);
    expect((world.rows.get(KEY)!.payload as unknown[]).length).toBeGreaterThan(0);
    expect(world.rpcCalls.filter((f) => f === "h2_finish_refresh").length).toBe(
      finishesBefore,
    );
    // The lease is released rather than left dangling.
    expect(world.activeLeaseFeeds()).toEqual([]);
  });

  test("48. an empty players payload is accepted when nothing is cached yet", async () => {
    seedFullBase();
    world.seedTable(AIRTABLE_TABLES.playersDatabase, 0);
    const served = (await getCachedPublicFeed("players", playersLoader)) as unknown[];
    expect(served).toEqual([]);
    expect(world.rows.get(KEY)!.payload).toEqual([]);
    expect(world.rows.get(KEY)!.freshUntil).toBeGreaterThan(world.now);
  });

  test("49. a non-empty refresh still publishes normally", async () => {
    const first = await warmThenExpire();
    const served = (await getCachedPublicFeed("players", playersLoader)) as unknown[];
    expect(served.length).toBe(first.length);
    expect(world.rows.get(KEY)!.freshUntil).toBeGreaterThan(world.now);
  });

  test("50. the store feed rejects its expired payload", async () => {
    seedFullBase();
    const storeLoader = () => listAll(AIRTABLE_TABLES.store)();
    const first = (await getCachedPublicFeed("store", storeLoader)) as unknown[];
    expect(first.length).toBeGreaterThan(0);
    world.advance(FEED_TTL_SECONDS * 1000 + 1_000);
    const before = world.airtableRequests.length;

    world.control.cooldownUntil = world.now + 60 * 60_000;
    await expect(getCachedPublicFeed("store", storeLoader)).rejects.toThrow(FeedUnavailableError);
    expect(world.airtableRequests.length).toBe(before);
  });

  test("51. the store feed with no cached payload still fails closed", async () => {
    seedFullBase();
    world.control.cooldownUntil = world.now + 60_000;
    await expect(
      getCachedPublicFeed("store", listAll(AIRTABLE_TABLES.store)),
    ).rejects.toThrow(FeedUnavailableError);
    expect(world.airtableRequests.length).toBe(0);
  });
});

describe("per-feed refresh leases with globally shared Airtable limits", () => {
  const KEY_PLAYERS = "production:players";
  const KEY_STORE = "production:store";
  const KEY_RECORDS = "production:records";
  const KEY_GAMES = "production:upcoming-games";

  /** Another instance holds this feed's own lease. */
  function holdLease(key: string, token = "held-token", ms = 10 * LEASE_MS) {
    Object.assign(world.lease(key), {
      token,
      startedAt: world.now,
      expiresAt: world.now + ms,
      lastPageSequence: 0,
    });
  }

  const claim = (key: string) =>
    world.rpc("h2_get_or_claim", { p_cache_key: key, p_schema_version: 1 }) as Record<
      string,
      unknown
    >;

  test("52. an active players lease does not block a store refresh", async () => {
    seedFullBase();
    holdLease(KEY_PLAYERS);
    const store = (await getCachedPublicFeed("store", listAll(AIRTABLE_TABLES.store))) as unknown[];
    expect(Array.isArray(store)).toBe(true);
    expect(world.airtableRequests.length).toBeGreaterThan(0);
    expect(world.rows.get(KEY_STORE)!.payload).not.toBeNull();
    // The players lease is untouched by the store refresh.
    expect(world.lease(KEY_PLAYERS).token).toBe("held-token");
    expect(world.activeLeaseFeeds()).toEqual([KEY_PLAYERS]);
  });

  test("53. an active store lease does not block records or upcoming games", async () => {
    seedFullBase();
    holdLease(KEY_STORE);
    await getCachedPublicFeed("records", listAll(AIRTABLE_TABLES.records));
    await getCachedPublicFeed("upcoming-games", listAll(AIRTABLE_TABLES.upcomingGames));
    expect(world.rows.get(KEY_RECORDS)!.payload).not.toBeNull();
    expect(world.rows.get(KEY_GAMES)!.payload).not.toBeNull();
    expect(world.lease(KEY_STORE).token).toBe("held-token");
  });

  test("54. the same feed cannot hold two active leases", async () => {
    seedFullBase();
    const first = claim(KEY_STORE);
    expect(first["status"]).toBe("claimed");
    expect(claim(KEY_STORE)["status"]).toBe("busy");
    // A different feed claims its own lease at the same moment.
    const other = claim(KEY_PLAYERS);
    expect(other["status"]).toBe("claimed");
    expect(other["lease_token"]).not.toBe(first["lease_token"]);
    expect(world.activeLeaseFeeds().sort()).toEqual([KEY_PLAYERS, KEY_STORE].sort());
  });

  test("55. malformed or unknown feed keys are rejected everywhere", () => {
    for (const bad of ["control:base", "staging:store", "production:secrets", "", "production:"]) {
      expect(() => claim(bad)).toThrow();
      expect(
        (world.rpc("h2_take_page_permit", {
          p_cache_key: bad,
          p_lease_token: "t",
          p_sequence: 1,
        }) as Record<string, unknown>)["status"],
      ).toBe("invalid");
      expect(
        (world.rpc("h2_finish_refresh", {
          p_cache_key: bad,
          p_lease_token: "t",
          p_payload: [],
          p_page_counts: {},
        }) as Record<string, unknown>)["status"],
      ).toBe("rejected");
      expect(
        (world.rpc("h2_fail_refresh", {
          p_cache_key: bad,
          p_lease_token: "t",
          p_kind: "failure",
          p_retry_after_seconds: null,
        }) as Record<string, unknown>)["status"],
      ).toBe("ignored");
    }
    expect(world.activeLeaseFeeds()).toEqual([]);
  });

  test("56. a valid token for the wrong feed can neither permit, finish nor fail", () => {
    seedFullBase();
    const store = claim(KEY_STORE);
    const token = store["lease_token"];
    expect(
      (world.rpc("h2_take_page_permit", {
        p_cache_key: KEY_PLAYERS,
        p_lease_token: token,
        p_sequence: 1,
      }) as Record<string, unknown>)["status"],
    ).toBe("expired");
    expect(
      (world.rpc("h2_finish_refresh", {
        p_cache_key: KEY_PLAYERS,
        p_lease_token: token,
        p_payload: [{ id: "hacked" }],
        p_page_counts: {},
      }) as Record<string, unknown>)["status"],
    ).toBe("stale_lease");
    expect(
      (world.rpc("h2_fail_refresh", {
        p_cache_key: KEY_PLAYERS,
        p_lease_token: token,
        p_kind: "rate_limited",
        p_retry_after_seconds: 3600,
      }) as Record<string, unknown>)["status"],
    ).toBe("ignored");
    // Nothing leaked into the players feed, and the store lease still stands.
    expect(world.rows.get(KEY_PLAYERS)!.payload).toBeNull();
    expect(world.rows.get(KEY_PLAYERS)!.failureCount).toBe(0);
    expect(world.control.cooldownUntil).toBeNull();
    expect(world.lease(KEY_STORE).token).toBe(token);

    // A wrong token on the right feed is equally powerless.
    expect(
      (world.rpc("h2_take_page_permit", {
        p_cache_key: KEY_STORE,
        p_lease_token: "not-the-token",
        p_sequence: 1,
      }) as Record<string, unknown>)["status"],
    ).toBe("expired");
  });

  test("57. an expired lease cannot permit, finish or fail as the owner", () => {
    seedFullBase();
    const store = claim(KEY_STORE);
    world.advance(LEASE_MS + 1);
    const token = store["lease_token"];
    expect(
      (world.rpc("h2_take_page_permit", {
        p_cache_key: KEY_STORE,
        p_lease_token: token,
        p_sequence: 1,
      }) as Record<string, unknown>)["status"],
    ).toBe("expired");
    expect(
      (world.rpc("h2_finish_refresh", {
        p_cache_key: KEY_STORE,
        p_lease_token: token,
        p_payload: [{ id: "late" }],
        p_page_counts: {},
      }) as Record<string, unknown>)["status"],
    ).toBe("stale_lease");
    expect(
      (world.rpc("h2_fail_refresh", {
        p_cache_key: KEY_STORE,
        p_lease_token: token,
        p_kind: "failure",
        p_retry_after_seconds: null,
      }) as Record<string, unknown>)["status"],
    ).toBe("ignored");
    expect(world.rows.get(KEY_STORE)!.payload).toBeNull();
    expect(world.rows.get(KEY_STORE)!.failureCount).toBe(0);
  });

  test("58. page sequences are strict and independent per feed", () => {
    seedFullBase();
    const store = claim(KEY_STORE);
    const players = claim(KEY_PLAYERS);
    const permit = (key: string, token: unknown, sequence: number) =>
      (world.rpc("h2_take_page_permit", {
        p_cache_key: key,
        p_lease_token: token,
        p_sequence: sequence,
      }) as Record<string, unknown>)["status"];

    expect(permit(KEY_STORE, store["lease_token"], 1)).toBe("granted");
    // Skipping or repeating a sequence inside a feed is refused.
    expect(permit(KEY_STORE, store["lease_token"], 1)).toBe("sequence_conflict");
    expect(permit(KEY_STORE, store["lease_token"], 3)).toBe("sequence_conflict");
    // The other feed starts its own sequence at 1, unaffected by store's.
    world.advance(PACING_MS);
    expect(permit(KEY_PLAYERS, players["lease_token"], 1)).toBe("granted");
    expect(world.lease(KEY_STORE).lastPageSequence).toBe(1);
    expect(world.lease(KEY_PLAYERS).lastPageSequence).toBe(1);
    // Both pages were charged to the shared budget.
    expect(world.control.dayUsed).toBe(2);
    expect(world.control.monthUsed).toBe(2);
  });

  test("59. two feeds refreshing at once still obey the global dispatch spacing", async () => {
    seedFullBase();
    const many = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `r${i}`, fields: {} }));
    world.setTable(AIRTABLE_TABLES.records, { behaviour: "ok", records: many(250) });
    world.setTable(AIRTABLE_TABLES.store, { behaviour: "ok", records: many(250) });

    await Promise.all([
      getCachedPublicFeed("records", listAll(AIRTABLE_TABLES.records)),
      getCachedPublicFeed("store", listAll(AIRTABLE_TABLES.store)),
    ]);

    const times = world.airtableRequests.map((r) => r.at).sort((a, b) => a - b);
    expect(times.length).toBe(6);
    for (let i = 1; i < times.length; i++) {
      expect(times[i]! - times[i - 1]!).toBeGreaterThanOrEqual(PACING_MS);
    }
    // Every page of both feeds was charged to the shared budget exactly once.
    expect(world.control.dayUsed).toBe(6);
    expect(world.control.monthUsed).toBe(6);
  });

  test("60. exhausted shared budgets block every feed independently of leases", async () => {
    seedFullBase();
    world.control.dayUsed = DAY_LIMIT;
    for (const feed of ["players", "store", "records", "upcoming-games"] as const) {
      await expect(
        getCachedPublicFeed(feed, listAll(AIRTABLE_TABLES.records)),
      ).rejects.toThrow(FeedUnavailableError);
    }
    expect(world.airtableRequests.length).toBe(0);

    world.control.dayUsed = 0;
    world.control.monthUsed = MONTH_LIMIT;
    await expect(
      getCachedPublicFeed("store", listAll(AIRTABLE_TABLES.store)),
    ).rejects.toThrow(FeedUnavailableError);
    expect(world.airtableRequests.length).toBe(0);
  });

  test("61. a 429 on one feed blocks all feeds through the shared cooldown", async () => {
    seedFullBase();
    world.setTable(AIRTABLE_TABLES.records, { behaviour: "429", records: [], retryAfter: "120" });
    await expect(
      getCachedPublicFeed("records", listAll(AIRTABLE_TABLES.records)),
    ).rejects.toThrow(FeedUnavailableError);
    // Shared Retry-After cooldown on the control row, not on the feed row.
    expect(world.control.cooldownUntil).toBe(world.now + 120_000);
    const before = world.airtableRequests.length;

    for (const feed of ["players", "store", "upcoming-games"] as const) {
      await expect(
        getCachedPublicFeed(feed, listAll(AIRTABLE_TABLES.store)),
      ).rejects.toThrow(FeedUnavailableError);
    }
    expect(world.airtableRequests.length).toBe(before);
    expect(world.activeLeaseFeeds()).toEqual([]);
  });

  test("62. one feed's failure leaves another feed's lease and refresh intact", async () => {
    seedFullBase();
    const players = claim(KEY_PLAYERS);
    world.setTable(AIRTABLE_TABLES.store, { behaviour: "500", records: [] });
    await expect(
      getCachedPublicFeed("store", listAll(AIRTABLE_TABLES.store)),
    ).rejects.toThrow(FeedUnavailableError);

    // Store took its per-feed backoff; players kept its lease untouched.
    expect(world.rows.get(KEY_STORE)!.failureCount).toBe(1);
    expect(world.rows.get(KEY_STORE)!.retryAfter).toBe(world.now + 10_000);
    expect(world.rows.get(KEY_PLAYERS)!.failureCount).toBe(0);
    expect(world.rows.get(KEY_PLAYERS)!.retryAfter).toBeNull();
    expect(world.lease(KEY_PLAYERS).token).toBe(players["lease_token"]);
    // No global cooldown from a plain 5xx.
    expect(world.control.cooldownUntil).toBeNull();
  });

  test("63. every feed still rejects a payload older than 900 seconds", async () => {
    seedFullBase();
    for (const feed of ["players", "store", "records", "upcoming-games"] as const) {
      const row = world.rows.get(`production:${feed}`)!;
      row.payload = [{ id: "old" }];
      row.refreshStartedAt = world.now - (FEED_TTL_SECONDS * 1000 + 1);
      row.freshUntil = row.refreshStartedAt + FEED_TTL_SECONDS * 1000;
      // Its own lease is held elsewhere, so no refresh can complete now.
      holdLease(`production:${feed}`);
      await expect(
        getCachedPublicFeed(feed, listAll(AIRTABLE_TABLES.records)),
      ).rejects.toThrow(FeedUnavailableError);
      expect(row.payload).toEqual([{ id: "old" }]);
    }
    expect(world.airtableRequests.length).toBe(0);
  });

  test("64. an unavailable coordinator never reaches Airtable for any feed", async () => {
    seedFullBase();
    world.postgresDown = true;
    for (const feed of ["players", "store", "records", "upcoming-games"] as const) {
      await expect(
        getCachedPublicFeed(feed, listAll(AIRTABLE_TABLES.records)),
      ).rejects.toThrow(FeedUnavailableError);
    }
    expect(world.airtableRequests.length).toBe(0);
  });

  test("65. original incident: expired store cache while players refreshes", async () => {
    seedFullBase();
    // Warm both feeds, then let the store window expire.
    const storeLoader = listAll(AIRTABLE_TABLES.store);
    const firstStore = (await getCachedPublicFeed("store", storeLoader)) as unknown[];
    expect(firstStore.length).toBeGreaterThan(0);
    world.advance(FEED_TTL_SECONDS * 1000 + 1_000);

    // Players is mid-refresh and holds ITS OWN lease (the incident condition).
    const players = claim(KEY_PLAYERS);
    expect(players["status"]).toBe("claimed");
    const before = world.airtableRequests.length;

    // Store claims its own lease, refreshes through the shared permit gate and
    // publishes a NEW payload. The expired payload is never served.
    const refreshed = (await getCachedPublicFeed("store", storeLoader)) as unknown[];
    expect(refreshed.length).toBeGreaterThan(0);
    expect(world.airtableRequests.length).toBeGreaterThan(before);
    const row = world.rows.get(KEY_STORE)!;
    expect(row.refreshStartedAt).toBeGreaterThan(world.now - FEED_TTL_SECONDS * 1000);
    expect(row.freshUntil).toBeGreaterThan(world.now);
    // Players' lease is still its own, untouched.
    expect(world.lease(KEY_PLAYERS).token).toBe(players["lease_token"]);
  });

  test("66. a cold store cache whose refresh fails keeps the unavailable state", async () => {
    seedFullBase();
    world.setTable(AIRTABLE_TABLES.store, { behaviour: "500", records: [] });
    await expect(
      getCachedPublicFeed("store", listAll(AIRTABLE_TABLES.store)),
    ).rejects.toThrow(FeedUnavailableError);
    expect(world.rows.get(KEY_STORE)!.payload).toBeNull();
    expect(world.activeLeaseFeeds()).toEqual([]);
  });
});
