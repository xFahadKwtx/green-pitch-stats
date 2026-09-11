/**
 * Internal scheduled warming endpoint for the Players and Store feeds.
 *
 * - POST only; every other method is rejected.
 * - Fail-closed authorization: the caller must present `x-warm-token` matching
 *   the vault-stored secret, verified server-side through the coordinator.
 *   No credential is embedded here and no upstream data is logged or returned.
 * - Production only. There are NO request-provided environment, feed or URL
 *   overrides.
 * - The work is fully awaited so the scheduler's HTTP call reflects the real
 *   outcome, and it reuses the existing Airtable fetchers plus the existing
 *   lease/permit/budget/pacing/cooldown/deadline/TTL machinery unchanged.
 * - HTTP severity: a `failed` feed only yields 503 when it could actually go
 *   cold. If every failed feed demonstrably stays fresh strictly beyond the NEXT
 *   real 12-minute schedule boundary plus a 60s margin, the response is 200 with
 *   `status: "degraded"`, `critical: false`; otherwise 503 with `critical: true`.
 *   Valid skips (`fresh`/`busy`) stay 200. Per-feed outcome strings are retained.
 */
import { createFileRoute } from "@tanstack/react-router";

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
} as const;

/** Real cron schedule: minutes 0,12,24,36,48 of every UTC hour. */
export const SCHEDULE_MINUTES = [0, 12, 24, 36, 48] as const;
/** Safety margin added on top of the next boundary. */
export const SCHEDULE_MARGIN_MS = 60_000;

/**
 * The next actual UTC wall-clock schedule boundary strictly AFTER `atMs`.
 * Derived from real minutes/hours, never from "12 minutes after now".
 */
export function nextScheduleBoundaryMs(atMs: number): number {
  const at = new Date(atMs);
  const base = Date.UTC(
    at.getUTCFullYear(),
    at.getUTCMonth(),
    at.getUTCDate(),
    at.getUTCHours(),
  );
  for (const minute of SCHEDULE_MINUTES) {
    const candidate = base + minute * 60_000;
    if (candidate > atMs) return candidate;
  }
  // Past the last boundary of this hour: the first boundary of the next hour.
  return base + 3_600_000;
}

function json(body: Record<string, unknown>, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

async function warmProductionFeeds(): Promise<Response> {
  const { warmPublicFeed, environmentKey, assessCachedCoverage } = await import(
    "@/lib/public-feed-cache.server"
  );

  let env: string;
  try {
    env = environmentKey();
  } catch {
    return json({ status: "unavailable" }, 503);
  }
  if (env !== "production") return json({ status: "not_production" }, 403);

  // Sequential: the shared global coordinator serializes Airtable dispatch anyway.
  const players = await warmPublicFeed("players", async () => {
    const { fetchPlayersFromAirtable } = await import("@/lib/airtable-players.server");
    return fetchPlayersFromAirtable();
  });
  const store = await warmPublicFeed("store", async () => {
    const { fetchStoreFromAirtable } = await import("@/lib/store.server");
    return fetchStoreFromAirtable();
  });

  const feeds = { players, store } as const;
  const failedFeeds = (["players", "store"] as const).filter((f) => feeds[f] === "failed");
  if (failedFeeds.length === 0) {
    return json({ status: "ok", feeds, critical: false }, 200);
  }

  // Severity assessment only: read-only, no payload is served, nothing is
  // mutated and no refresh or retry is started here.
  let critical = false;
  let assessedAtMs = 0;
  const expiries: number[] = [];
  for (const feed of failedFeeds) {
    let coverage: { expiresAtMs: number; assessedAtMs: number } | null = null;
    try {
      coverage = await assessCachedCoverage(feed, "production");
    } catch {
      coverage = null;
    }
    // Missing, expired, malformed, unknown or unreadable cache => critical.
    if (!coverage) {
      critical = true;
      break;
    }
    expiries.push(coverage.expiresAtMs);
    // The LATEST assessment time wins, so a slow second lookup can only move
    // the boundary forward — an earlier read is never trusted past it.
    assessedAtMs = Math.max(assessedAtMs, coverage.assessedAtMs);
  }

  if (!critical) {
    const requiredUntil = nextScheduleBoundaryMs(assessedAtMs) + SCHEDULE_MARGIN_MS;
    // STRICTLY beyond: equality is insufficient coverage.
    critical = !expiries.every((expiresAtMs) => expiresAtMs > requiredUntil);
  }

  return json({ status: "degraded", feeds, critical }, critical ? 503 : 200);
}

/** Exported for focused tests; the route handler below is the only caller. */
export async function handleWarmFeedsRequest(request: Request): Promise<Response> {
  const token = request.headers.get("x-warm-token");
  if (!token) return json({ status: "denied" }, 401);

  let authorized = false;
  try {
    const { verifyWarmToken } = await import("@/lib/public-feed-cache.server");
    authorized = await verifyWarmToken(token);
  } catch {
    // Coordinator unavailable: fail closed, reveal nothing.
    return json({ status: "unavailable" }, 503);
  }
  if (!authorized) return json({ status: "denied" }, 401);

  try {
    return await warmProductionFeeds();
  } catch {
    return json({ status: "unavailable" }, 503);
  }
}

export const Route = createFileRoute("/api/public/warm-feeds")({
  server: {
    handlers: {
      POST: async ({ request }) => handleWarmFeedsRequest(request),
      GET: async () => json({ status: "method_not_allowed" }, 405),
    },
  },
});
