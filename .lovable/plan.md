# Diagnosis: Players Stats page showing no players

Nothing was changed: no code edits, no data changes, no migration, no deploy.

## What I verified (read-only)

- The shared feed cache is switched on and healthy: today's request budget is 12 of 2100 used, no cooldown, no recorded failures.
- The players entry for the preview environment currently holds 96 players and was refreshed at 06:30 UTC (valid until 06:45 UTC).
- The records and upcoming-games entries have never been filled at all (empty), and all production-environment entries are empty too.
- Opening the players page against the running app right now renders "96 PLAYERS" with the full list and no errors; the latest build is clean.

So the data path and the Airtable mapping are working. The page is not permanently broken — it fails during specific windows.

## Most likely root cause

The feed cache is "fail closed with no fallback", and everything shares one lock:

1. Each cached feed lives for 15 minutes. When it expires, the next visitor must re-fetch the whole players dataset (8 Airtable pages, paced 2 seconds apart) inside a 45-second window.
2. All four feeds (players, records, store, upcoming games) compete for a single global refresh lock. While one feed refreshes, requests for another feed get "busy".
3. A visitor who is told "busy" retries only 4 times (about 15 seconds) and then gives up with a generic failure instead of showing the last known good data. The previously cached players list is never served once its 15-minute window ends, even though it is still in the database.

That produces exactly the reported behaviour: for stretches of time the page has no player data (empty list / unavailable notice), then it works again after a successful refresh — which matches the 06:30 refresh appearing minutes before the report.

Secondary contributor: the page's empty state and its failure state look similar, so a failed load reads as "zero players" rather than "temporarily unavailable". Also, an empty result is currently publishable, so a single unlucky refresh could cache an empty list for 15 minutes.

## Recommended minimal fix (not applied)

1. Serve stale data instead of failing: when the coordinator answers busy, paced, backing off, or out of refresh time, return the last stored payload if one exists (stale-while-revalidate). Only fail when there is no payload at all. This alone removes the visible outage.
2. Give each feed its own refresh lock (keep the shared request budget and pacing global) so records/store/upcoming refreshes stop blocking players.
3. Refuse to publish an empty players payload over a non-empty one, so a bad run cannot pin an empty list for 15 minutes.
4. Optional polish: refresh slightly before expiry rather than on expiry, and make the page distinguish "no results" from "temporarily unavailable".

Item 1 is the smallest change that fixes the reported symptom; items 2-3 prevent recurrence.

## Technical notes

- `src/lib/public-feed-cache.server.ts`, `servePublicFeed`: statuses `busy` (rechecks exhausted), `backoff`, `cooldown`, `budget_exhausted`, and `no refresh time remaining` all throw `FeedUnavailableError` without consulting the stored payload.
- `h2_get_or_claim` returns the payload only on `fresh`; a stale-serving fix needs the payload (or an explicit stale payload field) returned on the non-fresh branches too.
- Single lock lives in `control:base` (`lease_token` / `lease_feed`); per-feed leases would move that state onto each feed row while `day_used` / `month_used` / `next_request_at` stay shared.
- Environment key comes from build mode (`development` -> `preview`, `production` -> `production`); today's 12 requests all correspond to preview rows, confirming the preview build is reading the preview keys.
