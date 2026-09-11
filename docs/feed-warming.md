# Scheduled warming for the Players and Store feeds

Keeps the production Players and Store cache entries warm so that, in normal
operation, visitors are served already-fresh data instead of paying the cold
rebuild cost. This is best-effort, not a guarantee: if warming is denied
(budget, cooldown, backoff, disabled) or fails (Airtable outage, rate limit),
the next visitor after expiry still pays the synchronous rebuild — or sees the
generic unavailable state, because expired data is never served. Nothing about the safety model changes: hard TTL
900s, per-feed leases, global budgets (2100/day, 65000/month), 500ms serialized
dispatch spacing, 429 cooldown, per-feed backoff, 45s refresh deadline. Expired
data is never served.

## Pieces

- `src/routes/api/public/warm-feeds.ts` — POST-only internal endpoint. Requires
  the `x-warm-token` header, verified through `public.h2_verify_warm_token`.
  Production only, no request-provided overrides, sanitized JSON response:
  `{"status":"ok","feeds":{"players":"published|skipped|failed","store":...},
  "critical":false}`.
  Valid skips (`fresh`, `busy`, cooldown/backoff/budget denials) return 200.
  An unknown coordinator answer is reported as `failed`, not `skipped`, and a
  stale/previous-payload fallback can never be reported as `published`.
- HTTP severity for `failed` feeds. After the awaited attempts, the endpoint
  performs a read-only lookup of the still-valid cached entry of every failed
  feed (no payload is served, nothing is mutated, no refresh is started). It
  then computes the next ACTUAL UTC schedule boundary (minutes 00/12/24/36/48)
  after the assessment moment, plus a 60s margin. If every failed feed remains
  fresh strictly beyond that point, the answer is HTTP 200 with
  `"status":"degraded"`, `"critical":false`. If any failed feed has no valid,
  fresh, well-formed, readable cache, or its coverage does not strictly exceed
  that point, the answer is HTTP 503 with `"critical":true`. The assessment uses
  the conservative server clock from the lookup response and the LATEST
  assessment time across feeds, so a slow second lookup that crosses a boundary
  can only raise the requirement. Auth and coordinator failures still fail
  closed (401/503). A 503 therefore means "a cache can actually go cold";
  a 200 with `critical:false` still means a real refresh failed, so warming
  never promises that a visitor pays nothing under repeated failures.
- Sanitized failure diagnostics. Each failed warming attempt emits exactly one
  bounded line, e.g.
  `{"event":"scheduled_warm_failure","feed":"players","phase":"refresh",
  "category":"upstream-http","status":500,"timeout":false,
  "at":"2026-09-11T14:00:00.101Z","ref":"<uuid>"}`.
  `category` is allowlisted (`timeout`, `network`, `upstream-http`,
  `invalid-response`, `rate-limited`, `unavailable`, `unknown`) and the original
  error is observed BEFORE it is converted or replaced by the previous-payload
  fallback. No message, stack, URL, token, header, SQL argument, payload or
  upstream body is ever logged, and a failing log sink cannot change a response.
- `warmPublicFeed()` in `src/lib/public-feed-cache.server.ts` — claims through
  `h2_get_or_claim_ahead` with the wider warming window (`WARM_MIN_FRESH_MS`,
  660000 ms) and reuses the existing refresh machinery and Airtable fetchers.
  660000 ms is the unchanged warming threshold: an entry with less than that
  much freshness left is refreshed now. It is not a guarantee that a skipped
  entry survives until the next scheduled run; the endpoint's severity
  assessment, not this constant, decides whether a failure is critical. The
  wider SQL bound applies to `production:players` / `production:store` only;
  preview and all other feeds keep the 120000 ms visitor window.
- Token: generated in and read only from the encrypted vault
  (`vault.secrets`, name `h2_warm_token`). It is never in code or logs.

## Activation (only after the endpoint is deployed to production)

Run once, after confirming `POST https://almustatil.lovable.app/api/public/warm-feeds`
is live (a `401` with no token proves the route exists; `404` means not yet
deployed — do not schedule before that).

```sql
select cron.unschedule('h2-warm-public-feeds')
where exists (select 1 from cron.job where jobname = 'h2-warm-public-feeds');

select cron.schedule(
  'h2-warm-public-feeds',
  '*/10 * * * *',
  $$
  select net.http_post(
    url := 'https://almustatil.lovable.app/api/public/warm-feeds',
    headers := jsonb_build_object(
      'content-type', 'application/json',
      'x-warm-token', (select decrypted_secret from vault.decrypted_secrets where name = 'h2_warm_token')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
  $$
);
```

The token is read from the vault at run time, so it is not stored in the job
definition. Re-running the block is idempotent (no duplicate jobs).

## Verify

A `cron.job_run_details` success only means the HTTP request was **enqueued**
by pg_net. Always check the actual HTTP response as well.

```sql
select jobid, jobname, schedule, active from cron.job where jobname = 'h2-warm-public-feeds';

select status, return_message, start_time from cron.job_run_details
where jobid = (select jobid from cron.job where jobname = 'h2-warm-public-feeds')
order by start_time desc limit 5;

-- The real outcome: HTTP status, body and transport errors.
select id, status_code, content, timed_out, error_msg, created
from net._http_response
order by created desc limit 10;
```

Expected: `status_code = 200` with `feeds` values of `published` or `skipped`.
`status_code = 200` with `"status":"degraded"`, `"critical":false` means a feed
failed but its cached data still covers the next scheduled run plus margin —
check the `scheduled_warm_failure` lines for the category. `status_code = 503`
means a failed feed could actually go cold (or the coordinator was unavailable);
`401` means the token is wrong; `403` means the target is not the production
environment; `404` means the endpoint is not deployed yet;
`timed_out = true` / non-null `error_msg` means the request never completed.
A cron job marked succeeded only means the HTTP call was enqueued, so always
read `net._http_response` for the real status, content, `timed_out` and
`error_msg`.
Also confirm freshness moved:

```sql
select cache_key, fresh_until, refresh_started_at, failure_count, retry_after
from public.airtable_public_cache
where cache_key in ('production:players', 'production:store');
```

## Disable / rollback

```sql
-- pause
update cron.job set active = false where jobname = 'h2-warm-public-feeds';
-- remove
select cron.unschedule('h2-warm-public-feeds');
```

Removing the job restores the previous behaviour exactly (passive refresh-ahead
inside the final 120s for visitors). No code rollback is required.
