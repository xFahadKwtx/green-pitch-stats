/**
 * H2 — Airtable request-volume protection and shared coordination.
 *
 * Every public feed response is served from a shared Postgres cache
 * (public.airtable_public_cache). Airtable is only contacted by the single
 * global refresh lease owner, and every individual Airtable pagination page
 * must first obtain a permit from the shared coordinator.
 *
 * SAFETY / INVARIANTS
 * - No code path may reach Airtable without an active refresh context and a
 *   fresh, unexpired page permit (fail closed, never bypass).
 * - Postgres unavailable => the feed fails closed; Airtable is NOT called.
 * - Only complete successful payloads are published; partial or malformed
 *   results are discarded and never replace a valid cache entry.
 * - Cache rows contain only completed PUBLIC response objects. No credentials,
 *   no raw Airtable records, no upstream error bodies.
 * - Service credentials are read from process.env inside functions only and are
 *   never logged.
 * - The SQL coordinator is the authority for freshness, budget, pacing and the
 *   45s refresh deadline. Local in-flight coalescing is a per-instance
 *   optimisation only and never substitutes for it.
 */
import { AsyncLocalStorage } from "node:async_hooks";

/** Bump when a public feed payload shape changes (invalidates cached rows). */
export const SCHEMA_VERSION = 1;

/** Hard TTL for every feed, measured from refresh START. */
export const FEED_TTL_SECONDS = 900;

/** Coordination timings (mirrored by the SQL coordinator). */
export const LEASE_SECONDS = 60;
export const REFRESH_DEADLINE_MS = 45_000;
export const AIRTABLE_REQUEST_TIMEOUT_MS = 5_000;
/** A granted permit is only usable within this window after the DB grant. */
export const PERMIT_WINDOW_MS = 1_000;
/** RPC ceiling; ambiguous RPCs are never retried. */
export const RPC_TIMEOUT_MS = 5_000;

/** Bounded busy rechecks: no unbounded per-visitor polling. */
const BUSY_RECHECK_DELAYS_MS = [1_000, 2_000, 4_000, 8_000] as const;
const MAX_PACING_WAITS = 8;
const MAX_PACING_WAIT_MS = 3_000;

export const CONTROL_CACHE_KEY = "control:base";

export type FeedName = "players" | "records" | "store" | "upcoming-games";

export type EnvironmentKey = "preview" | "production";

/** Sanitized, visitor-safe failure. Never carries upstream detail. */
export class FeedUnavailableError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super("This information is temporarily unavailable. Please try again shortly.");
    this.name = "FeedUnavailableError";
    this.reason = reason;
  }
}

/** Thrown by the Airtable layer when Airtable answers 429. */
export class AirtableRateLimitError extends Error {
  readonly retryAfterSeconds: number | null;
  constructor(retryAfterSeconds: number | null) {
    super("Airtable rate limited the request");
    this.name = "AirtableRateLimitError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

type Json = Record<string, unknown>;

interface RefreshContext {
  cacheKey: string;
  feed: FeedName;
  leaseToken: string;
  /** Monotonic ms deadline for the whole refresh (DB clock is the authority). */
  deadlineAt: number;
  controller: AbortController;
  sequence: number;
  pageCounts: Record<string, number>;
  seenOffsets: Set<string>;
  /** Serializes page dispatches inside one refresh. */
  queue: Promise<unknown>;
  /** Set once any page task fails: no sibling may dispatch afterwards. */
  failed: boolean;
}

const refreshStore = new AsyncLocalStorage<RefreshContext>();

let monotonicImpl = (): number => performance.now();
const monotonic = (): number => monotonicImpl();

let sleepImpl = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

let modeOverride: string | undefined;

/** Per-instance in-flight coalescing: env + feed + schema version. */
const inFlight = new Map<string, Promise<unknown>>();

/** Test-only seams. Never used by production code paths. */
export const __testing = {
  setSleep(fn: (ms: number) => Promise<void>) {
    sleepImpl = fn;
  },
  resetSleep() {
    sleepImpl = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  },
  setMonotonic(fn: () => number) {
    monotonicImpl = fn;
  },
  resetMonotonic() {
    monotonicImpl = () => performance.now();
  },
  setMode(mode: string | undefined) {
    modeOverride = mode;
  },
  currentRefresh: () => refreshStore.getStore(),
  inFlightSize: () => inFlight.size,
};

const sleep = (ms: number) => sleepImpl(Math.max(0, ms));

/**
 * Fixed environment key from the build mode. Preview builds run in
 * development mode, production builds in production mode. Anything else fails
 * closed — request headers are never used to derive the key.
 */
export function environmentKey(): EnvironmentKey {
  const mode =
    modeOverride ??
    (typeof import.meta !== "undefined"
      ? (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.[
          "MODE"
        ]
      : undefined);
  if (mode === "production") return "production";
  if (mode === "development") return "preview";
  throw new FeedUnavailableError("unknown build mode");
}

export function cacheKeyFor(feed: FeedName, env: EnvironmentKey = environmentKey()): string {
  return `${env}:${feed}`;
}

function isLegacyJwtKey(key: string): boolean {
  return key.split(".").length === 3;
}

/** Single PostgREST RPC call with a hard timeout. Never retried. */
async function rpc(fn: string, args: Json, extraSignal?: AbortSignal): Promise<Json> {
  const url = process.env["SUPABASE_URL"];
  const key = process.env["SUPABASE_SERVICE_ROLE_KEY"];
  if (!url || !key) throw new FeedUnavailableError("coordinator credentials unavailable");

  const headers: Record<string, string> = {
    "content-type": "application/json",
    apikey: key,
  };
  // Opaque sb_secret_* keys are not JWTs; only legacy keys use a bearer.
  if (isLegacyJwtKey(key)) headers["Authorization"] = `Bearer ${key}`;

  // The 5s RPC ceiling always applies; callers may add the remaining refresh
  // deadline so a completion call cannot outlive its own lease window.
  const signal = extraSignal
    ? AbortSignal.any([extraSignal, AbortSignal.timeout(RPC_TIMEOUT_MS)])
    : AbortSignal.timeout(RPC_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(`${url}/rest/v1/rpc/${fn}`, {
      method: "POST",
      headers,
      body: JSON.stringify(args),
      signal,
    });
  } catch {
    throw new FeedUnavailableError(`coordinator unreachable (${fn})`);
  }


  if (!response.ok) {
    // Upstream error bodies are intentionally discarded.
    throw new FeedUnavailableError(`coordinator rejected ${fn} (${response.status})`);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new FeedUnavailableError(`coordinator returned an unreadable result (${fn})`);
  }
  if (body && typeof body === "object" && !Array.isArray(body)) return body as Json;
  throw new FeedUnavailableError(`coordinator returned an unexpected result (${fn})`);
}

/**
 * Serve a public feed from the shared cache, refreshing through the global
 * lease when the cached entry is missing or expired.
 *
 * Concurrent callers on the SAME instance share one attempt; Postgres remains
 * the cross-instance authority.
 */
export async function getCachedPublicFeed<T>(
  feed: FeedName,
  load: () => Promise<T>,
): Promise<T> {
  const cacheKey = cacheKeyFor(feed);
  const localKey = `${cacheKey}:${SCHEMA_VERSION}`;

  const existing = inFlight.get(localKey);
  if (existing) return existing as Promise<T>;

  const attempt = servePublicFeed<T>(cacheKey, feed, load).finally(() => {
    inFlight.delete(localKey);
  });
  inFlight.set(localKey, attempt);
  return attempt;
}

async function servePublicFeed<T>(
  cacheKey: string,
  feed: FeedName,
  load: () => Promise<T>,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    // Capture local monotonic time BEFORE the RPC so RPC latency is subtracted
    // from — never added to — the freshness and deadline windows.
    const beforeRpc = monotonic();
    const result = await rpc("h2_get_or_claim", {
      p_cache_key: cacheKey,
      p_schema_version: SCHEMA_VERSION,
    });
    const status = String(result["status"] ?? "");

    if (status === "fresh") {
      const freshForMs = Number(result["fresh_for_ms"] ?? 0);
      // Only usable if the entry is still fresh right now, conservatively
      // measured from before the RPC was issued.
      if (Number.isFinite(freshForMs) && monotonic() <= beforeRpc + freshForMs) {
        return result["payload"] as T;
      }
      if (attempt < BUSY_RECHECK_DELAYS_MS.length) continue;
      throw new FeedUnavailableError(`feed ${feed} unavailable (stale fresh window)`);
    }

    if (status === "claimed") {
      const token = String(result["lease_token"] ?? "");
      if (!token) throw new FeedUnavailableError("coordinator returned no lease token");
      const remaining = Number(result["refresh_deadline_ms"] ?? 0);
      const budget = Math.min(
        Number.isFinite(remaining) ? remaining : 0,
        REFRESH_DEADLINE_MS,
      );
      if (budget <= 0) {
        throw new FeedUnavailableError(`no refresh time remaining for ${feed}`);
      }
      return runRefresh(cacheKey, feed, token, beforeRpc + budget, budget, load);
    }

    if (status === "busy" && attempt < BUSY_RECHECK_DELAYS_MS.length) {
      await sleep(BUSY_RECHECK_DELAYS_MS[attempt]!);
      continue;
    }

    // busy (rechecks exhausted), backoff, cooldown, budget_exhausted, disabled
    throw new FeedUnavailableError(`feed ${feed} unavailable (${status || "unknown"})`);
  }
}

async function runRefresh<T>(
  cacheKey: string,
  feed: FeedName,
  leaseToken: string,
  deadlineAt: number,
  budgetMs: number,
  load: () => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const ctx: RefreshContext = {
    cacheKey,
    feed,
    leaseToken,
    deadlineAt,
    controller,
    sequence: 0,
    pageCounts: {},
    seenOffsets: new Set<string>(),
    queue: Promise.resolve(),
    failed: false,
  };

  const deadlineTimer = setTimeout(() => controller.abort(), budgetMs);
  if (typeof (deadlineTimer as unknown as { unref?: () => void }).unref === "function") {
    (deadlineTimer as unknown as { unref: () => void }).unref();
  }

  const abandon = async (error: unknown): Promise<never> => {
    ctx.failed = true;
    controller.abort();
    const rateLimited = error instanceof AirtableRateLimitError;
    try {
      await rpc("h2_fail_refresh", {
        p_cache_key: cacheKey,
        p_lease_token: leaseToken,
        p_kind: rateLimited ? "rate_limited" : "failure",
        p_retry_after_seconds: rateLimited ? error.retryAfterSeconds : null,
      });
    } catch {
      // Coordinator write failed; the lease expires on its own.
    }
    throw error instanceof FeedUnavailableError
      ? error
      : new FeedUnavailableError(`refresh failed for ${feed}`);
  };

  try {
    let payload: T;
    try {
      payload = await refreshStore.run(ctx, load);
    } catch (error) {
      return await abandon(error);
    }

    // The finish attempt is part of the refresh: the deadline timer stays armed
    // until it concludes, and a failed completion runs the same cleanup.
    try {
      const finished = await rpc("h2_finish_refresh", {
        p_cache_key: cacheKey,
        p_lease_token: leaseToken,
        p_payload: payload as unknown as Json,
        p_page_counts: ctx.pageCounts,
      });
      if (String(finished["status"] ?? "") !== "published") {
        return await abandon(
          new FeedUnavailableError(`refresh result rejected for ${feed}`),
        );
      }
    } catch (error) {
      return await abandon(error);
    }

    return payload;
  } finally {
    clearTimeout(deadlineTimer);
  }
}

function enqueue<T>(ctx: RefreshContext, task: () => Promise<T>): Promise<T> {
  const run = ctx.queue.then(task, task);
  // Keep the chain alive without leaking rejections.
  ctx.queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * Authorizes and dispatches exactly ONE Airtable pagination page.
 * Throws (fail closed) when there is no refresh context or no valid permit.
 */
export async function runAirtablePage<T>(
  tableId: string,
  offsetKey: string,
  dispatch: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const ctx = refreshStore.getStore();
  if (!ctx) {
    throw new FeedUnavailableError("Airtable access requires an authorized refresh lease");
  }

  return enqueue(ctx, async () => {
    try {
      return await authorizeAndDispatch(ctx, tableId, offsetKey, dispatch);
    } catch (error) {
      // ANY page-task failure (duplicate offset, denied permit, expired window,
      // transport error) aborts the whole refresh context before any sibling
      // task can dispatch.
      ctx.failed = true;
      ctx.controller.abort();
      throw error;
    }
  });
}

async function authorizeAndDispatch<T>(
  ctx: RefreshContext,
  tableId: string,
  offsetKey: string,
  dispatch: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (ctx.failed) throw new FeedUnavailableError("refresh already failed");
  if (ctx.controller.signal.aborted) throw new FeedUnavailableError("refresh aborted");
  if (ctx.seenOffsets.has(offsetKey)) {
    throw new FeedUnavailableError("duplicate Airtable page authorization");
  }
  ctx.seenOffsets.add(offsetKey);
  if (monotonic() >= ctx.deadlineAt) {
    throw new FeedUnavailableError("refresh deadline exceeded");
  }

  const sequence = ctx.sequence + 1;
  let usableUntil = 0;

  for (let attempt = 0; ; attempt++) {
    const beforeRpc = monotonic();
    const permit = await rpc("h2_take_page_permit", {
      p_cache_key: ctx.cacheKey,
      p_lease_token: ctx.leaseToken,
      p_sequence: sequence,
    });
    const status = String(permit["status"] ?? "");

    if (status === "granted") {
      const window = Number(permit["usable_for_ms"] ?? PERMIT_WINDOW_MS);
      // Conservative: the window is counted from BEFORE the RPC, so the entire
      // RPC round trip is subtracted. Guarantees >= 1s between dispatches.
      usableUntil =
        beforeRpc +
        Math.min(Number.isFinite(window) ? window : PERMIT_WINDOW_MS, PERMIT_WINDOW_MS);
      const remaining = Number(permit["refresh_deadline_ms"] ?? NaN);
      if (Number.isFinite(remaining)) {
        // The DB clock is the authority for the total deadline.
        ctx.deadlineAt = Math.min(ctx.deadlineAt, beforeRpc + remaining);
      }
      ctx.sequence = sequence;
      break;
    }

    if (status === "paced" && attempt < MAX_PACING_WAITS) {
      const wait = Number(permit["wait_ms"] ?? 1_000);
      const delay = Math.min(Number.isFinite(wait) ? wait : 1_000, MAX_PACING_WAIT_MS);
      if (monotonic() + delay >= ctx.deadlineAt) {
        throw new FeedUnavailableError("refresh deadline exceeded while pacing");
      }
      await sleep(delay);
      continue;
    }

    throw new FeedUnavailableError(`Airtable page permit denied (${status || "unknown"})`);
  }

  // Re-check abort and both deadlines immediately before dispatch. An expired
  // permit is never reused.
  if (ctx.failed || ctx.controller.signal.aborted) {
    throw new FeedUnavailableError("refresh aborted before dispatch");
  }
  if (monotonic() >= ctx.deadlineAt) {
    throw new FeedUnavailableError("refresh deadline exceeded before dispatch");
  }
  if (monotonic() >= usableUntil) {
    throw new FeedUnavailableError("Airtable page permit expired before dispatch");
  }

  ctx.pageCounts[tableId] = (ctx.pageCounts[tableId] ?? 0) + 1;

  const signal = AbortSignal.any([
    ctx.controller.signal,
    AbortSignal.timeout(AIRTABLE_REQUEST_TIMEOUT_MS),
  ]);

  return dispatch(signal);
}
