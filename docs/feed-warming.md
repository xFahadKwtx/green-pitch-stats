# Scheduled warming for the Players and Store feeds

Keeps the production Players and Store cache entries warm so a visitor never
pays the cold rebuild cost. Nothing about the safety model changes: hard TTL
900s, per-feed leases, global budgets (2100/day, 65000/month), 500ms serialized
dispatch spacing, 429 cooldown, per-feed backoff, 45s refresh deadline. Expired
data is never served.

## Pieces

- `src/routes/api/public/warm-feeds.ts` — POST-only internal endpoint. Requires
  the `x-warm-token` header, verified through `public.h2_verify_warm_token`.
  Production only, no request-provided overrides, sanitized JSON response:
  `{"status":"ok","feeds":{"players":"published|skipped|failed","store":...}}`.
- `warmPublicFeed()` in `src/lib/public-feed-cache.server.ts` — claims through
  `h2_get_or_claim_ahead` with the wider warming window (`WARM_MIN_FRESH_MS`,
  360000 ms) and reuses the existing refresh machinery and Airtable fetchers.
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

```sql
select jobid, jobname, schedule, active from cron.job where jobname = 'h2-warm-public-feeds';
select status, return_message, start_time from cron.job_run_details
where jobid = (select jobid from cron.job where jobname = 'h2-warm-public-feeds')
order by start_time desc limit 5;
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
