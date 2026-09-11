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
  `{"status":"ok","feeds":{"players":"published|skipped|failed","store":...}}`.
  Any feed reporting `failed` returns HTTP 503 with `"status":"degraded"`;
  valid skips (`fresh`, `busy`, cooldown/backoff/budget denials) return 200.
  An unknown coordinator answer is reported as `failed`, not `skipped`, and a
  stale/previous-payload fallback can never be reported as `published`.
- `warmPublicFeed()` in `src/lib/public-feed-cache.server.ts` — claims through
  `h2_get_or_claim_ahead` with the wider warming window (`WARM_MIN_FRESH_MS`,
  660000 ms) and reuses the existing refresh machinery and Airtable fetchers.
  660000 = one 600000 ms tick plus 60s jitter/runtime margin, so any entry that
  would expire before the next tick is refreshed now. The wider SQL bound
  applies to `production:players` / `production:store` only; preview and all
  other feeds keep the 120000 ms visitor window.
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
`status_code = 503` means at least one feed failed (or the coordinator was
unavailable); `401` means the token is wrong; `403` means the target is not the
production environment; `404` means the endpoint is not deployed yet;
`timed_out = true` / non-null `error_msg` means the request never completed.
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
