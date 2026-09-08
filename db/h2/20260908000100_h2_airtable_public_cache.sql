-- H2: shared Airtable public-feed cache + request coordinator.  NOT APPLIED YET.
--
-- PATH NOTE: supabase/migrations/ is platform-managed and cannot be written
-- directly; the file there is produced by the migration tool when this SQL is
-- applied. This file is the reviewable proposed SQL, kept verbatim so it can be
-- applied byte-for-byte later.
--
-- ONE table, NINE columns. Four cached feed rows per environment plus ONE
-- shared control row for the Airtable base. The Airtable request budget is
-- SHARED (never environment keyed). Visitors have no access: RLS is on with no
-- policies, direct privileges are revoked, and the four coordination functions
-- are SECURITY INVOKER, executable only by service_role.
--
-- Seeded with enabled = false: no refresh (preview or production) can reach
-- Airtable until the owner explicitly activates the coordinator after
-- verification.

create table if not exists public.airtable_public_cache (
  cache_key text primary key,
  schema_version integer not null default 1,
  payload jsonb,
  refresh_started_at timestamptz,
  fresh_until timestamptz,
  retry_after timestamptz,
  failure_count integer not null default 0,
  last_page_counts jsonb not null default '{}'::jsonb,
  control jsonb,

  -- Only the nine approved keys exist. Every CHECK is wrapped in coalesce(...,
  -- false) so a NULL sub-expression can never silently satisfy a constraint.

  constraint airtable_public_cache_key_shape check (
    coalesce(
      cache_key = 'control:base'
      or cache_key ~ '^(preview|production):(players|records|store|upcoming-games)$',
      false
    )
  ),

  constraint airtable_public_cache_schema_version check (
    coalesce(schema_version = 1, false)
  ),

  constraint airtable_public_cache_failure_count check (
    coalesce(failure_count >= 0, false)
  ),

  -- Row kinds: the control row carries coordination only, feed rows carry a
  -- public JSON array payload only.
  constraint airtable_public_cache_row_kind check (
    coalesce(
      case
        when cache_key = 'control:base' then
          control is not null
          and payload is null
          and fresh_until is null
          and refresh_started_at is null
          and retry_after is null
          and last_page_counts = '{}'::jsonb
        else
          control is null
          and (payload is null or jsonb_typeof(payload) = 'array')
          and jsonb_typeof(last_page_counts) = 'object'
      end,
      false
    )
  ),

  -- Control payload: required keys, correct JSON types, non-negative integral
  -- counters, and hard caps on the shared budget limits.
  constraint airtable_public_cache_control_shape check (
    coalesce(
      cache_key <> 'control:base'
      or (
        jsonb_typeof(control) = 'object'
        and jsonb_typeof(control -> 'enabled') = 'boolean'
        -- nullable coordination slots must be present, and be null or the right type
        and (control ? 'lease_token')
        and jsonb_typeof(control -> 'lease_token') in ('null', 'string')
        and (control ? 'lease_feed')
        and jsonb_typeof(control -> 'lease_feed') in ('null', 'string')
        and (control ? 'lease_started_at')
        and jsonb_typeof(control -> 'lease_started_at') in ('null', 'string')
        and (control ? 'lease_expires_at')
        and jsonb_typeof(control -> 'lease_expires_at') in ('null', 'string')
        and (control ? 'next_request_at')
        and jsonb_typeof(control -> 'next_request_at') in ('null', 'string')
        and (control ? 'cooldown_until')
        and jsonb_typeof(control -> 'cooldown_until') in ('null', 'string')
        -- counters and limits
        and jsonb_typeof(control -> 'last_page_sequence') = 'number'
        and (control ->> 'last_page_sequence')::numeric >= 0
        and (control ->> 'last_page_sequence')::numeric
            = trunc((control ->> 'last_page_sequence')::numeric)
        and jsonb_typeof(control -> 'day_used') = 'number'
        and (control ->> 'day_used')::numeric >= 0
        and (control ->> 'day_used')::numeric = trunc((control ->> 'day_used')::numeric)
        and jsonb_typeof(control -> 'month_used') = 'number'
        and (control ->> 'month_used')::numeric >= 0
        and (control ->> 'month_used')::numeric = trunc((control ->> 'month_used')::numeric)
        and jsonb_typeof(control -> 'day_limit') = 'number'
        and (control ->> 'day_limit')::numeric >= 0
        and (control ->> 'day_limit')::numeric <= 2100
        and (control ->> 'day_limit')::numeric = trunc((control ->> 'day_limit')::numeric)
        and jsonb_typeof(control -> 'month_limit') = 'number'
        and (control ->> 'month_limit')::numeric >= 0
        and (control ->> 'month_limit')::numeric <= 65000
        and (control ->> 'month_limit')::numeric = trunc((control ->> 'month_limit')::numeric)
        -- UTC budget window starts
        and jsonb_typeof(control -> 'day_start') = 'string'
        and jsonb_typeof(control -> 'month_start') = 'string'
      ),
      false
    )
  )
);

comment on table public.airtable_public_cache is
  'H2: completed public feed payloads + shared Airtable refresh/budget coordination. No credentials, no raw Airtable records, no upstream error bodies.';

-- Privileges: trusted server credential only.
revoke all on public.airtable_public_cache from public;
revoke all on public.airtable_public_cache from anon;
revoke all on public.airtable_public_cache from authenticated;
grant all on public.airtable_public_cache to service_role;

alter table public.airtable_public_cache enable row level security;
-- Intentionally no policies: anon/authenticated get nothing.

-- Seed: 8 feed rows + 1 shared control row = 9 rows. enabled = FALSE.
insert into public.airtable_public_cache (cache_key)
values
  ('preview:players'), ('preview:records'), ('preview:store'), ('preview:upcoming-games'),
  ('production:players'), ('production:records'), ('production:store'), ('production:upcoming-games')
on conflict (cache_key) do nothing;

insert into public.airtable_public_cache (cache_key, control)
values (
  'control:base',
  jsonb_build_object(
    'enabled', false,
    'lease_token', null,
    'lease_feed', null,
    'lease_started_at', null,
    'lease_expires_at', null,
    'last_page_sequence', 0,
    'next_request_at', null,
    'cooldown_until', null,
    'day_start', to_jsonb(date_trunc('day', clock_timestamp() at time zone 'UTC') at time zone 'UTC'),
    'day_used', 0,
    'day_limit', 2100,
    'month_start', to_jsonb(date_trunc('month', clock_timestamp() at time zone 'UTC') at time zone 'UTC'),
    'month_used', 0,
    'month_limit', 65000
  )
)
on conflict (cache_key) do nothing;

-- ---------------------------------------------------------------------------
-- h2_get_or_claim(cache_key, schema_version)
--   1) READ-ONLY fresh lookup: no lock, no write on the control row.
--   2) On a miss: take the single global control lock, read the DB clock AFTER
--      the locks, re-check freshness, then claim the one global lease.
--   The prior payload's refresh_started_at is left untouched while claiming;
--   the refresh start lives in control.lease_started_at and is published by
--   h2_finish_refresh.
-- ---------------------------------------------------------------------------
create or replace function public.h2_get_or_claim(p_cache_key text, p_schema_version integer)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = public
as $$
declare
  c jsonb;
  row_rec public.airtable_public_cache;
  ts timestamptz;
  token uuid;
  v_day_start timestamptz;
  v_month_start timestamptz;
  v_dirty boolean := false;
begin
  if p_cache_key is null
     or p_cache_key = 'control:base'
     or p_cache_key !~ '^(preview|production):(players|records|store|upcoming-games)$' then
    raise exception 'invalid cache key';
  end if;
  -- Only schema version 1 is supported by this coordinator.
  if p_schema_version is null or p_schema_version is distinct from 1 then
    raise exception 'unsupported schema version';
  end if;

  -- (1) Read-only fresh path.
  select * into row_rec from public.airtable_public_cache where cache_key = p_cache_key;
  if row_rec.cache_key is null then
    raise exception 'unknown cache key';
  end if;
  ts := clock_timestamp();
  if row_rec.payload is not null
     and row_rec.fresh_until is not null
     and row_rec.fresh_until > ts
     and row_rec.schema_version = 1 then
    return jsonb_build_object(
      'status', 'fresh',
      'payload', row_rec.payload,
      'fresh_until', row_rec.fresh_until,
      'fresh_for_ms', floor(extract(epoch from (row_rec.fresh_until - ts)) * 1000)::bigint
    );
  end if;

  -- (2) Miss: global control lock first, then the feed row, then the clock.
  select control into c
  from public.airtable_public_cache
  where cache_key = 'control:base'
  for update;
  if c is null then
    raise exception 'H2 control row missing';
  end if;

  select * into row_rec
  from public.airtable_public_cache
  where cache_key = p_cache_key
  for update;

  ts := clock_timestamp();

  -- Re-check freshness under the lock (another instance may have published).
  if row_rec.payload is not null
     and row_rec.fresh_until is not null
     and row_rec.fresh_until > ts
     and row_rec.schema_version = 1 then
    return jsonb_build_object(
      'status', 'fresh',
      'payload', row_rec.payload,
      'fresh_until', row_rec.fresh_until,
      'fresh_for_ms', floor(extract(epoch from (row_rec.fresh_until - ts)) * 1000)::bigint
    );
  end if;

  -- UTC calendar budget resets. Cooldown and lease state are preserved.
  v_day_start := date_trunc('day', ts at time zone 'UTC') at time zone 'UTC';
  v_month_start := date_trunc('month', ts at time zone 'UTC') at time zone 'UTC';
  if (c ->> 'day_start') is null or (c ->> 'day_start')::timestamptz < v_day_start then
    c := jsonb_set(jsonb_set(c, '{day_start}', to_jsonb(v_day_start)), '{day_used}', to_jsonb(0));
    v_dirty := true;
  end if;
  if (c ->> 'month_start') is null or (c ->> 'month_start')::timestamptz < v_month_start then
    c := jsonb_set(jsonb_set(c, '{month_start}', to_jsonb(v_month_start)), '{month_used}', to_jsonb(0));
    v_dirty := true;
  end if;

  if coalesce((c ->> 'enabled')::boolean, false) is not true then
    if v_dirty then
      update public.airtable_public_cache set control = c where cache_key = 'control:base';
    end if;
    return jsonb_build_object('status', 'disabled');
  end if;

  -- Another refresh holds the single global lease.
  if (c ->> 'lease_expires_at') is not null
     and (c ->> 'lease_expires_at')::timestamptz > ts then
    if v_dirty then
      update public.airtable_public_cache set control = c where cache_key = 'control:base';
    end if;
    return jsonb_build_object(
      'status', 'busy',
      'recheck_after_ms', 1000,
      'lease_expires_at', (c ->> 'lease_expires_at')::timestamptz
    );
  end if;

  if row_rec.retry_after is not null and row_rec.retry_after > ts then
    if v_dirty then
      update public.airtable_public_cache set control = c where cache_key = 'control:base';
    end if;
    return jsonb_build_object('status', 'backoff', 'retry_after', row_rec.retry_after);
  end if;

  if (c ->> 'cooldown_until') is not null
     and (c ->> 'cooldown_until')::timestamptz > ts then
    if v_dirty then
      update public.airtable_public_cache set control = c where cache_key = 'control:base';
    end if;
    return jsonb_build_object('status', 'cooldown',
                              'retry_after', (c ->> 'cooldown_until')::timestamptz);
  end if;

  if (c ->> 'day_used')::numeric >= (c ->> 'day_limit')::numeric
     or (c ->> 'month_used')::numeric >= (c ->> 'month_limit')::numeric then
    if v_dirty then
      update public.airtable_public_cache set control = c where cache_key = 'control:base';
    end if;
    return jsonb_build_object('status', 'budget_exhausted');
  end if;

  token := gen_random_uuid();
  c := jsonb_set(c, '{lease_token}', to_jsonb(token::text));
  c := jsonb_set(c, '{lease_feed}', to_jsonb(p_cache_key));
  c := jsonb_set(c, '{lease_started_at}', to_jsonb(ts));
  c := jsonb_set(c, '{lease_expires_at}', to_jsonb(ts + interval '60 seconds'));
  c := jsonb_set(c, '{last_page_sequence}', to_jsonb(0));
  update public.airtable_public_cache set control = c where cache_key = 'control:base';

  return jsonb_build_object(
    'status', 'claimed',
    'lease_token', token::text,
    -- Remaining budget for the WHOLE refresh, measured on the DB clock.
    'refresh_deadline_ms', floor(extract(epoch from ((ts + interval '45 seconds') - clock_timestamp())) * 1000)::bigint,
    'lease_expires_at', ts + interval '60 seconds'
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- h2_take_page_permit(cache_key, lease_token, sequence)
--   Authorizes exactly ONE Airtable pagination request. Counters increment
--   before authorization and are never refunded. Grants are spaced 2s apart
--   and each grant is usable for 1s only, guaranteeing >= 1s between valid
--   dispatch windows, including across owner handoff.
-- ---------------------------------------------------------------------------
create or replace function public.h2_take_page_permit(
  p_cache_key text,
  p_lease_token uuid,
  p_sequence integer
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = public
as $$
declare
  c jsonb;
  ts timestamptz;
  started timestamptz;
  wait_ms bigint;
begin
  if p_cache_key is null or p_lease_token is null then
    return jsonb_build_object('status', 'invalid');
  end if;
  if p_cache_key !~ '^(preview|production):(players|records|store|upcoming-games)$' then
    return jsonb_build_object('status', 'invalid');
  end if;
  if p_sequence is null or p_sequence < 1 then
    return jsonb_build_object('status', 'invalid');
  end if;

  select control into c
  from public.airtable_public_cache
  where cache_key = 'control:base'
  for update;
  if c is null then
    raise exception 'H2 control row missing';
  end if;

  ts := clock_timestamp();

  -- Owner validation BEFORE any mutation.
  if (c ->> 'lease_token') is null
     or (c ->> 'lease_token') is distinct from p_lease_token::text
     or (c ->> 'lease_feed') is distinct from p_cache_key
     or (c ->> 'lease_expires_at') is null
     or (c ->> 'lease_expires_at')::timestamptz <= ts then
    return jsonb_build_object('status', 'expired');
  end if;

  if coalesce((c ->> 'enabled')::boolean, false) is not true then
    return jsonb_build_object('status', 'disabled');
  end if;

  -- Hard 45s total refresh deadline, measured from the DB refresh start.
  started := (c ->> 'lease_started_at')::timestamptz;
  if started is null or ts >= started + interval '45 seconds' then
    return jsonb_build_object('status', 'deadline_exceeded');
  end if;

  -- Strictly sequential permits: no duplicate or skipped authorizations.
  if p_sequence <> coalesce((c ->> 'last_page_sequence')::integer, 0) + 1 then
    return jsonb_build_object('status', 'sequence_conflict');
  end if;

  if (c ->> 'cooldown_until') is not null
     and (c ->> 'cooldown_until')::timestamptz > ts then
    return jsonb_build_object('status', 'cooldown');
  end if;

  if (c ->> 'day_used')::numeric >= (c ->> 'day_limit')::numeric
     or (c ->> 'month_used')::numeric >= (c ->> 'month_limit')::numeric then
    return jsonb_build_object('status', 'budget_exhausted');
  end if;

  if (c ->> 'next_request_at') is not null
     and (c ->> 'next_request_at')::timestamptz > ts then
    wait_ms := greatest(
      0,
      ceil(extract(epoch from ((c ->> 'next_request_at')::timestamptz - ts)) * 1000)::bigint
    );
    return jsonb_build_object('status', 'paced', 'wait_ms', wait_ms);
  end if;

  c := jsonb_set(c, '{day_used}', to_jsonb(((c ->> 'day_used')::numeric) + 1));
  c := jsonb_set(c, '{month_used}', to_jsonb(((c ->> 'month_used')::numeric) + 1));
  c := jsonb_set(c, '{last_page_sequence}', to_jsonb(p_sequence));
  c := jsonb_set(c, '{next_request_at}', to_jsonb(ts + interval '2 seconds'));
  update public.airtable_public_cache set control = c where cache_key = 'control:base';

  return jsonb_build_object(
    'status', 'granted',
    'usable_for_ms', 1000,
    'sequence', p_sequence,
    'refresh_deadline_ms', floor(extract(epoch from ((started + interval '45 seconds') - clock_timestamp())) * 1000)::bigint,
    'day_used', (c ->> 'day_used')::numeric,
    'month_used', (c ->> 'month_used')::numeric
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- h2_finish_refresh(cache_key, lease_token, payload, page_counts)
--   Publishes a COMPLETE payload from the current, unexpired owner only.
--   TTL is exactly 900s measured from the DB refresh START.
-- ---------------------------------------------------------------------------
create or replace function public.h2_finish_refresh(
  p_cache_key text,
  p_lease_token uuid,
  p_payload jsonb,
  p_page_counts jsonb
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = public
as $$
declare
  c jsonb;
  row_rec public.airtable_public_cache;
  ts timestamptz;
  started timestamptz;
  counted numeric;
begin
  if p_cache_key is null or p_lease_token is null then
    return jsonb_build_object('status', 'rejected', 'reason', 'invalid_arguments');
  end if;
  if p_cache_key !~ '^(preview|production):(players|records|store|upcoming-games)$' then
    return jsonb_build_object('status', 'rejected', 'reason', 'invalid_arguments');
  end if;
  -- Public feed payloads are always JSON arrays; malformed/partial results are
  -- never cached.
  if p_payload is null or jsonb_typeof(p_payload) <> 'array' then
    return jsonb_build_object('status', 'rejected', 'reason', 'invalid_payload');
  end if;
  if p_page_counts is null or jsonb_typeof(p_page_counts) <> 'object' then
    return jsonb_build_object('status', 'rejected', 'reason', 'invalid_page_counts');
  end if;
  if exists (
    select 1 from jsonb_each(p_page_counts) as e(k, v)
    where jsonb_typeof(v) <> 'number'
       or (v #>> '{}')::numeric <= 0
       or (v #>> '{}')::numeric <> trunc((v #>> '{}')::numeric)
  ) then
    return jsonb_build_object('status', 'rejected', 'reason', 'invalid_page_counts');
  end if;

  select control into c
  from public.airtable_public_cache
  where cache_key = 'control:base'
  for update;
  if c is null then
    raise exception 'H2 control row missing';
  end if;

  select * into row_rec
  from public.airtable_public_cache
  where cache_key = p_cache_key
  for update;
  if row_rec.cache_key is null then
    raise exception 'unknown cache key';
  end if;

  ts := clock_timestamp();

  if (c ->> 'lease_token') is null
     or (c ->> 'lease_token') is distinct from p_lease_token::text
     or (c ->> 'lease_feed') is distinct from p_cache_key
     or (c ->> 'lease_expires_at') is null
     or (c ->> 'lease_expires_at')::timestamptz <= ts then
    return jsonb_build_object('status', 'stale_lease');
  end if;

  if coalesce((c ->> 'enabled')::boolean, false) is not true then
    return jsonb_build_object('status', 'rejected', 'reason', 'disabled');
  end if;

  started := (c ->> 'lease_started_at')::timestamptz;
  if started is null or ts >= started + interval '45 seconds' then
    return jsonb_build_object('status', 'rejected', 'reason', 'deadline_exceeded');
  end if;

  -- The published pages must match exactly the authorized permits.
  select coalesce(sum((v #>> '{}')::numeric), 0) into counted
  from jsonb_each(p_page_counts) as e(k, v);
  if counted is distinct from coalesce((c ->> 'last_page_sequence')::numeric, 0) then
    return jsonb_build_object('status', 'rejected', 'reason', 'page_count_mismatch');
  end if;

  update public.airtable_public_cache
  set payload = p_payload,
      schema_version = 1,
      refresh_started_at = started,
      fresh_until = started + interval '900 seconds',
      retry_after = null,
      failure_count = 0,
      last_page_counts = p_page_counts
  where cache_key = p_cache_key;

  c := jsonb_set(c, '{lease_token}', 'null'::jsonb);
  c := jsonb_set(c, '{lease_feed}', 'null'::jsonb);
  c := jsonb_set(c, '{lease_started_at}', 'null'::jsonb);
  c := jsonb_set(c, '{lease_expires_at}', 'null'::jsonb);
  c := jsonb_set(c, '{last_page_sequence}', to_jsonb(0));
  update public.airtable_public_cache set control = c where cache_key = 'control:base';

  return jsonb_build_object(
    'status', 'published',
    'fresh_until', started + interval '900 seconds',
    'fresh_for_ms', floor(extract(epoch from ((started + interval '900 seconds') - ts)) * 1000)::bigint
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- h2_fail_refresh(cache_key, lease_token, kind, retry_after_seconds)
--   Only the CURRENT, unexpired owner may record a failure. A stale or expired
--   owner changes nothing: no backoff, no cooldown, no lease release.
-- ---------------------------------------------------------------------------
create or replace function public.h2_fail_refresh(
  p_cache_key text,
  p_lease_token uuid,
  p_kind text,
  p_retry_after_seconds numeric
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = public
as $$
declare
  c jsonb;
  row_rec public.airtable_public_cache;
  ts timestamptz;
  next_failures integer;
  backoff_seconds numeric;
  cooldown_seconds numeric;
  cooldown_until timestamptz;
  existing_cooldown timestamptz;
begin
  if p_cache_key is null or p_lease_token is null then
    return jsonb_build_object('status', 'ignored', 'reason', 'invalid_arguments');
  end if;
  if p_cache_key !~ '^(preview|production):(players|records|store|upcoming-games)$' then
    return jsonb_build_object('status', 'ignored', 'reason', 'invalid_arguments');
  end if;

  select control into c
  from public.airtable_public_cache
  where cache_key = 'control:base'
  for update;
  if c is null then
    raise exception 'H2 control row missing';
  end if;

  select * into row_rec
  from public.airtable_public_cache
  where cache_key = p_cache_key
  for update;
  if row_rec.cache_key is null then
    raise exception 'unknown cache key';
  end if;

  ts := clock_timestamp();

  -- Stale/expired owner: no state may be altered.
  if (c ->> 'lease_token') is null
     or (c ->> 'lease_token') is distinct from p_lease_token::text
     or (c ->> 'lease_feed') is distinct from p_cache_key
     or (c ->> 'lease_expires_at') is null
     or (c ->> 'lease_expires_at')::timestamptz <= ts then
    return jsonb_build_object('status', 'ignored', 'reason', 'stale_lease');
  end if;

  next_failures := coalesce(row_rec.failure_count, 0) + 1;
  -- 10s, 20s, 40s, ... capped at 300s.
  backoff_seconds := least(300, 10 * power(2, least(next_failures - 1, 10)));

  update public.airtable_public_cache
  set failure_count = next_failures,
      retry_after = greatest(
        coalesce(row_rec.retry_after, ts),
        ts + make_interval(secs => backoff_seconds)
      )
  where cache_key = p_cache_key;

  if p_kind = 'rate_limited' then
    -- Honour a valid Retry-After even when it exceeds one hour. Only unsafe
    -- values (null, NaN, non-finite, non-positive, absurd) fall back to the
    -- 30s floor; 7 days is a parse-sanity bound, not a cap on real values.
    if p_retry_after_seconds is not null
       and p_retry_after_seconds = p_retry_after_seconds       -- excludes NaN
       and p_retry_after_seconds > 0
       and p_retry_after_seconds <= 604800 then
      cooldown_seconds := greatest(30, p_retry_after_seconds);
    else
      cooldown_seconds := 30;
    end if;
    cooldown_until := ts + make_interval(secs => cooldown_seconds);
    existing_cooldown := (c ->> 'cooldown_until')::timestamptz;
    -- Never shorten an existing cooldown.
    if existing_cooldown is not null and existing_cooldown > cooldown_until then
      cooldown_until := existing_cooldown;
    end if;
    c := jsonb_set(c, '{cooldown_until}', to_jsonb(cooldown_until));
  end if;

  c := jsonb_set(c, '{lease_token}', 'null'::jsonb);
  c := jsonb_set(c, '{lease_feed}', 'null'::jsonb);
  c := jsonb_set(c, '{lease_started_at}', 'null'::jsonb);
  c := jsonb_set(c, '{lease_expires_at}', 'null'::jsonb);
  c := jsonb_set(c, '{last_page_sequence}', to_jsonb(0));
  update public.airtable_public_cache set control = c where cache_key = 'control:base';

  return jsonb_build_object('status', 'recorded', 'released', true);
end;
$$;

-- Function privileges: visitors may not invoke the coordinator.
revoke all on function public.h2_get_or_claim(text, integer) from public, anon, authenticated;
revoke all on function public.h2_take_page_permit(text, uuid, integer) from public, anon, authenticated;
revoke all on function public.h2_finish_refresh(text, uuid, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.h2_fail_refresh(text, uuid, text, numeric) from public, anon, authenticated;

grant execute on function public.h2_get_or_claim(text, integer) to service_role;
grant execute on function public.h2_take_page_permit(text, uuid, integer) to service_role;
grant execute on function public.h2_finish_refresh(text, uuid, jsonb, jsonb) to service_role;
grant execute on function public.h2_fail_refresh(text, uuid, text, numeric) to service_role;

-- ACTIVATION (run only after verification, as a separate explicit step):
--   update public.airtable_public_cache
--   set control = jsonb_set(control, '{enabled}', 'true'::jsonb)
--   where cache_key = 'control:base';
