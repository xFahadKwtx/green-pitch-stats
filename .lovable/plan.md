# Per-feed refresh leases, with all Airtable protections still global

Nothing is implemented yet. The 900-second hard expiry stays exactly as it is, and expired data is never served.

## The confirmed problem

Store's saved copy had expired, but the single global refresh slot was held by the Players refresh, so Store was told "busy", ran out of its short waiting window, and showed the unavailable state. Verified in live shared state: the lease was held by `preview:players` while `preview:store` had already passed its freshness time.

## What changes

Each of the four feeds — Players, Store, Records, Upcoming Games — gets its own refresh slot, so one feed's refresh can never block another's. Every actual request to Airtable still passes through the same shared, global gate it does today: one request at a time, minimum spacing between requests, shared daily and monthly ceilings, shared rate-limit cooldown, same timeouts and deadlines.

Nothing about freshness changes: a feed older than 900 seconds is never displayed. If a feed cannot refresh in time, it keeps today's controlled unavailable state.

## Answers to the seven questions

**1. Production files that need to change**

- `src/lib/public-feed-cache.server.ts` — the only production source file.
- One new database migration file (added, no existing migration edited).
- `tests/h2-cache.test.ts` — tests only.

No route, page, mapping, pricing, ordering, or UI file changes. Airtable stays read-only.

**2. Database changes required**

Yes, one additive migration:

- The shared control row gains a `leases` object holding one independent lease per feed key, and the shared `last_page_sequence` moves inside each feed's lease entry.
- The control-shape constraint is extended to validate `leases` and its per-feed fields, and to keep validating every existing shared field unchanged.
- All four coordination functions are replaced with per-feed-lease versions: `h2_get_or_claim`, `h2_take_page_permit`, `h2_finish_refresh`, `h2_fail_refresh`.

Unchanged: the nine-column table, the nine seeded rows, existing cached payloads, `enabled`, the 2100/day and 65000/month ceilings, revoked public/anon/authenticated access, and service-role-only execution. No column is dropped and no data is deleted.

**3. Lease-key design**

One lease entry per feed cache key, stored under `leases` on the shared control row:

```text
control:base.leases = {
  "<env>:players":        { token, started_at, expires_at, last_page_sequence },
  "<env>:store":          { token, started_at, expires_at, last_page_sequence },
  "<env>:records":        { token, started_at, expires_at, last_page_sequence },
  "<env>:upcoming-games": { token, started_at, expires_at, last_page_sequence }
}
```

Keys stay environment-scoped exactly as today (`preview:` / `production:`), so preview and production remain separate. A feed is "busy" only when its own lease is unexpired. Lease validation stays strict: correct token, correct feed, unexpired, and 60-second expiry with a 45-second total refresh deadline, all measured on the database clock.

**4. How global permits and budgets stay protected**

Every page permit still takes the same single row lock on the shared control row before doing anything, so all permit decisions remain fully serialized across feeds. Kept global and shared: daily budget, monthly budget, minimum spacing between dispatches, rate-limit cooldown, Retry-After handling, per-request timeout, failure backoff, and fail-closed behaviour when the coordinator or database is unreachable. Only the lease and its page sequence become per-feed; the page sequence is validated strictly in order within each feed's own refresh.

**5. Concurrency behaviour with Players and Store refreshing together**

Both claim their own lease and proceed in parallel. Their Airtable page requests are interleaved, not simultaneous: each page waits for the shared permit, so the global rate stays at one page per spacing interval and every page is charged to the shared budgets. A rate-limit response from Airtable stops all feeds together, as today. Each refresh has its own 45-second deadline and its own failure backoff; a Store failure never releases or affects the Players lease, and neither can publish under the other's lease.

**6. Required H2 regression tests**

- Store claims and completes its own refresh while Players holds an active Players lease.
- Concurrent Players and Store refreshes never dispatch two Airtable pages inside one spacing interval.
- Both refreshes' pages count against the shared daily and monthly ceilings; an exhausted budget stops both.
- A rate-limit cooldown triggered by one feed blocks the other.
- Wrong-feed and wrong-token leases are rejected for permits, completion, and failure recording.
- A stale or expired lease changes no coordinator state.
- One feed's failure and backoff leave the other feed's lease and refresh intact.
- Per-feed page sequences stay strictly sequential and independent.
- Expired data past 900 seconds is still never served, for all four feeds.
- Coordinator or database unavailable still fails closed with no Airtable request.

**7. Hard-expiry confirmation**

The 900-second hard expiry is unchanged. No expired payload is served for any feed, the freshness check and its clock-skew protection are untouched, and a feed that cannot refresh keeps the existing controlled unavailable state.

## Not included

No stale fallback, no expiry extension, no request-limit increase, no coordinator activation change, no Airtable writes, no deployment, and no publishing.
