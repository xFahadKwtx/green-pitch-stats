# Diagnosis: slow "Upcoming Games" on the live site (read-only, nothing changed)

## Measured (2026-09-29 ~20:55 UTC)
- Page first-byte times on the live site (after your test): `/` 200 in 0.77s, `/upcoming-games` 200 in 0.94s, `/players` 200 in 0.62s. The site itself is not hanging now.
- Live server logs: **not available** — the log service timed out when I tried to connect. So there is no log proof of the cause.
- Saved-data state (read-only SELECT on the live cache table, at 20:55:55 UTC):

| Feed (live) | refresh started | fresh until | failures |
|---|---|---|---|
| players | 20:48:00 | 21:03:00 | 0 |
| store | 20:48:05 | 21:03:05 | 0 |
| upcoming-games | **20:53:25** | 21:08:25 | 0 |
| records | 20:04:30 | **20:19:30 (expired)** | 0 |

- No failures, no retry lock, no stuck lease on the live feeds. Players and store were refreshed together at 20:48 (the scheduled warmer).

## Strongest inference (strong, but no logs confirm it)
1. The scheduled warmer only keeps **players and store** fresh. Upcoming Games and Records are not warmed.
2. The Upcoming Games data was refreshed at **20:53:25 — the same minute you clicked**. That means the saved copy had expired, and your click made the server fetch it again from Airtable *while you waited*, with the paced/limited Airtable requests (up to 5s per request, busy re-checks 1s/2s/4s). That explains "several seconds".
3. The Upcoming Games page starts the data load without waiting for it, then waits for the data while drawing. The router keeps the old (home) screen visible, with no loading indicator, until the data comes back. That matches "URL changed but home content stayed".
4. Not supported by what I could see: no deadlock, no repeated failures, no error loop (failure_count 0 everywhere, the card loaded correctly).

Records is in the same state now (expired since 20:19) — the next visitor to Records will likely get the same delay.

## Missing evidence
- Live server logs for 20:53 (log service unreachable) — they would give the exact server time for the Upcoming Games request.
- A timed browser capture of the data request during a cold click.

## Minimal fix proposed (NOT applied — needs your approval)
1. Add `upcoming-games` and `records` to the scheduled warmer's live list (same 780s threshold, same */12 schedule, no TTL change). This removes the waiting-for-Airtable on first click. One small list change in the cache code plus test/doc updates.
2. Optional, frontend only: add a short loading state (`pendingComponent`) on the data pages so a slow load shows "loading" instead of the previous page.

Cost to know: warming two more feeds adds about 2 Airtable reads every 12 minutes — well under limits.

## Technical details
- Warmer list: `WARM_MIN_FRESH_MS` / production feeds in `src/lib/public-feed-cache.server.ts`, route `src/routes/api/public/warm-feeds.ts`.
- Loaders use `void context.queryClient.ensureQueryData(...)` with `useSuspenseQuery` in the component and no `pendingComponent` (`src/routes/upcoming-games.tsx`, `records.tsx`, etc.).
- Validation after the fix: read the cache table after a warmer run and confirm `refresh_started_at` for upcoming-games/records moves on the schedule, not on visitor clicks.
