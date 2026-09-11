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
 * - Any feed reporting `failed` yields HTTP 503 so a scheduler-side HTTP check
 *   can tell a real failure from a valid skip (`fresh`/`busy`, still 200).
 */
import { createFileRoute } from "@tanstack/react-router";

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
} as const;

function json(body: Record<string, unknown>, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

async function warmProductionFeeds(): Promise<Response> {
  const { warmPublicFeed, environmentKey } = await import(
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

  const failed = players === "failed" || store === "failed";
  return json(
    { status: failed ? "degraded" : "ok", feeds: { players, store } },
    failed ? 503 : 200,
  );
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
