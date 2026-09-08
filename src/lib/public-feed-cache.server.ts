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
 * - Only complete successful payloads are published; partial results are
 *   discarded and never replace a valid cache entry.
 * - Cache rows contain only completed PUBLIC response objects. No credentials,
 *   no raw Airtable records, no upstream error bodies.
 * - Service credentials are read from process.env inside functions only and
 *   never logged.
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

const MAX_BUSY_RECHECKS = 6;
const BUSY_RECHECK_MS = 700;
const MAX_BUSY_RECHECK_MS = 1_500;
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
  /** Monotonic ms deadline for the whole refresh. */
  deadlineAt: number;
  controller: AbortController;
  sequence: number;
  pageCounts: Record<string, number>;
  seenOffsets: Set<string>;
  /** Serializes page dispatches inside one refresh. */
  queue: Promise<unknown>;
}

const refreshStore = new AsyncLocalStorage<RefreshContext>();

const monotonic = (): number => performance.now();

let sleepImpl = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

let modeOverride: string | undefined;

/** Test-only seams. Never used by production code paths. */
export const __testing = {
  setSleep(fn: (ms: number) => Promise<void>) {
    sleepImpl = fn;
  },
  resetSleep() {
    sleepImpl = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  },
  setMode(mode: string | undefined) {
    modeOverride = mode;
  },
  currentRefresh: () => refreshStore.getStore(),
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
async function rpc(fn: string, args: Json): Promise<Json> {
  const url = process.env["SUPABASE_URL"];
  const key = process.env["SUPABASE_SERVICE_ROLE_KEY"];
  if (!url || !key) throw new FeedUnavailableError("coordinator credentials unavailable");

  const headers: Record<string, string> = {
    "content-type": "application/json",
    apikey: key,
  };
  // Opaque sb_secret_* keys are not JWTs; only legacy keys use a bearer.
  if (isLegacyJwtKey(key)) headers["Authorization"] = `Bearer ${key}`;

  let response: Response;
  try {
    response = await fetch(`${url}/rest/v1/rpc/${fn}`, {
      method: "POST",
      headers,
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
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
 */
export async function getCachedPublicFeed<T>(
  feed: FeedName,
  load: () => Promise<T>,
): Promise<T> {
  const cacheKey = cacheKeyFor(feed);

  for (let attempt = 0; attempt <= MAX_BUSY_RECHECKS; attempt++) {
    const result = await rpc("h2_get_or_claim", {
      p_cache_key: cacheKey,
      p_schema_version: SCHEMA_VERSION,
    });
    const status = String(result["status"] ?? "");

    if (status === "fresh") return result["payload"] as T;

    if (status === "claimed") {
      const token = String(result["lease_token"] ?? "");
      if (!token) throw new FeedUnavailableError("coordinator returned no lease token");
      return runRefresh(cacheKey, feed, token, load);
    }

    if (status === "busy" && attempt < MAX_BUSY_RECHECKS) {
      const wait = Number(result["recheck_after_ms"] ?? BUSY_RECHECK_MS);
      await sleep(Math.min(Number.isFinite(wait) ? wait : BUSY_RECHECK_MS, MAX_BUSY_RECHECK_MS));
      continue;
    }

    // busy (exhausted rechecks), backoff, cooldown, budget_exhausted, disabled
    throw new FeedUnavailableError(`feed ${feed} unavailable (${status || "unknown"})`);
  }

  throw new FeedUnavailableError(`feed ${feed} unavailable (busy)`);
}

async function runRefresh<T>(
  cacheKey: string,
  feed: FeedName,
  leaseToken: string,
  load: () => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const ctx: RefreshContext = {
    cacheKey,
    feed,
    leaseToken,
    deadlineAt: monotonic() + REFRESH_DEADLINE_MS,
    controller,
    sequence: 0,
    pageCounts: {},
    seenOffsets: new Set<string>(),
    queue: Promise.resolve(),
  };

  const deadlineTimer = setTimeout(() => controller.abort(), REFRESH_DEADLINE_MS);
  if (typeof (deadlineTimer as unknown as { unref?: () => void }).unref === "function") {
    (deadlineTimer as unknown as { unref: () => void }).unref();
  }

  let payload: T;
  try {
    payload = await refreshStore.run(ctx, load);
  } catch (error) {
    clearTimeout(deadlineTimer);
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
  }
  clearTimeout(deadlineTimer);

  const finished = await rpc("h2_finish_refresh", {
    p_cache_key: cacheKey,
    p_lease_token: leaseToken,
    p_payload: payload as unknown as Json,
    p_page_counts: ctx.pageCounts,
  });
  if (String(finished["status"] ?? "") !== "published") {
    throw new FeedUnavailableError(`refresh result rejected for ${feed}`);
  }
  return payload;
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
    if (ctx.controller.signal.aborted) {
      throw new FeedUnavailableError("refresh aborted");
    }
    if (ctx.seenOffsets.has(offsetKey)) {
      throw new FeedUnavailableError("duplicate Airtable page authorization");
    }
    ctx.seenOffsets.add(offsetKey);
    if (monotonic() > ctx.deadlineAt) {
      throw new FeedUnavailableError("refresh deadline exceeded");
    }

    const sequence = ctx.sequence + 1;
    let usableUntil = 0;

    for (let attempt = 0; ; attempt++) {
      const startedAt = monotonic();
      const permit = await rpc("h2_take_page_permit", {
        p_cache_key: ctx.cacheKey,
        p_lease_token: ctx.leaseToken,
        p_sequence: sequence,
      });
      const status = String(permit["status"] ?? "");

      if (status === "granted") {
        const window = Number(permit["usable_for_ms"] ?? PERMIT_WINDOW_MS);
        // Conservative: count the window from BEFORE the RPC, so RPC latency is
        // subtracted rather than added. Guarantees >= 1s between dispatches.
        usableUntil =
          startedAt + Math.min(Number.isFinite(window) ? window : PERMIT_WINDOW_MS, PERMIT_WINDOW_MS);
        ctx.sequence = sequence;
        break;
      }

      if (status === "paced" && attempt < MAX_PACING_WAITS) {
        const wait = Number(permit["wait_ms"] ?? 1_000);
        const delay = Math.min(Number.isFinite(wait) ? wait : 1_000, MAX_PACING_WAIT_MS);
        if (monotonic() + delay > ctx.deadlineAt) {
          throw new FeedUnavailableError("refresh deadline exceeded while pacing");
        }
        await sleep(delay);
        continue;
      }

      ctx.controller.abort();
      throw new FeedUnavailableError(`Airtable page permit denied (${status || "unknown"})`);
    }

    if (monotonic() > usableUntil) {
      ctx.controller.abort();
      throw new FeedUnavailableError("Airtable page permit expired before dispatch");
    }

    ctx.pageCounts[tableId] = (ctx.pageCounts[tableId] ?? 0) + 1;

    const signal = AbortSignal.any([
      ctx.controller.signal,
      AbortSignal.timeout(AIRTABLE_REQUEST_TIMEOUT_MS),
    ]);

    try {
      return await dispatch(signal);
    } catch (error) {
      // Abort sibling reads for this refresh; the attempt is discarded.
      ctx.controller.abort();
      throw error;
    }
  });
}
