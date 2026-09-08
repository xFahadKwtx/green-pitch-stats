-- H2: shared Airtable public-feed cache + request coordinator.
--
-- NOTE ON PATH: supabase/migrations/ is managed by the platform and cannot be
-- written directly; the migration file there is produced by the migration tool
-- when this SQL is applied. This file is the reviewable proposed SQL, kept
-- verbatim so it can be applied byte-for-byte later. NOT APPLIED YET.
--
-- One cache table, four cached feed rows per environment, one shared control
-- row for the Airtable base. The Airtable request budget is SHARED (never
-- environment keyed). Visitors have no access: RLS is on with no policies,
-- direct privileges are revoked, and the coordination functions are
-- SECURITY INVOKER executable only by service_role.

create table if not exists public.airtable_public_cache (
  cache_key text primary key,
  schema_version integer not null default 1 check (schema_version >= 0),
  payload jsonb,
  refresh_started_at timestamptz,
  fresh_until timestamptz,
  retry_after timestamptz,
  failure_count integer not null default 0 check (failure_count >= 0),
  last_page_counts jsonb not null default '{}'::jsonb,
  control jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint airtable_public_cache_key_shape check (
    cache_key = 'control:base'
    or cache_key ~ '^(preview|production):(players|records|store|upcoming-games)$'
  ),
  constraint airtable_public_cache_row_kind check (
    (cache_key = 'control:base' and control is not null and payload is null and fresh_until is null)
    or (cache_key <> 'control:base' and control is null)
  ),
  constraint airtable_public_cache_control_shape check (
    cache_key <> 'control:base'
    or (
      (control ? 'enabled')
      and (control ? 'day_limit') and (control ? 'month_limit')
      and (control ->> 'day_used')::numeric >= 0
      and (control ->> 'month_used')::numeric >= 0
      and (control ->> 'day_limit')::numeric >= 0
      and (control ->> 'month_limit')::numeric >= 0
      and (control ->> 'last_page_sequence')::numeric >= 0
    )
  )
);

comment on table public.airtable_public_cache is
  'H2: completed public feed payloads + shared Airtable refresh/budget coordination. No credentials or raw Airtable records.';

-- Privileges: trusted server credential only.
revoke all on public.airtable_public_cache from public;
revoke all on public.airtable_public_cache from anon;
revoke all on public.airtable_public_cache from authenticated;
grant all on public.airtable_public_cache to service_role;

alter table public.airtable_public_cache enable row level security;
-- Intentionally no policies: anon/authenticated get nothing.

create or replace function public.h2_touch_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists h2_airtable_public_cache_updated_at on public.airtable_public_cache;
create trigger h2_airtable_public_cache_updated_at
before update on public.airtable_public_cache
for each row execute function public.h2_touch_updated_at();

-- Seed: preview + production feed rows and the single shared control row.
insert into public.airtable_public_cache (cache_key)
values
  ('preview:players'), ('preview:records'), ('preview:store'), ('preview:upcoming-games'),
  ('production:players'), ('production:records'), ('production:store'), ('production:upcoming-games')
on conflict (cache_key) do nothing;

insert into public.airtable_public_cache (cache_key, control)
values (
  'control:base',
  jsonb_build_object(
    'enabled', true,
    'lease_token', null,
    'lease_feed', null,
    'lease_started_at', null,
    'lease_expires_at', null,
    'last_page_sequence', 0,
    'next_request_at', null,
    'cooldown_until', null,
    'day_start', date_trunc('day', now() at time zone 'utc') at time zone 'utc',
    'day_used', 0,
    'day_limit', 2100,
    'month_start', date_trunc('month', now() at time zone 'utc') at time zone 'utc',
    'month_used', 0,
    'month_limit', 65000
  )
)
on conflict (cache_key) do nothing;

-- ---------------------------------------------------------------------------
-- Internal helper: lock + normalise the control row (UTC budget windows).
-- ---------------------------------------------------------------------------
create or replace function public.h2_lock_control()
returns jsonb
language plpgsql
volatile
set search_path = public
as $$
declare
  c jsonb;
  now_utc timestamptz := now();
  day_start timestamptz;
  month_start timestamptz;
begin
  select control into c
  from public.airtable_public_cache
  where cache_key = 'control:base'
  for update;

  if c is null then
    raise exception 'H2 control row missing';
  end if;

  day_start := date_trunc('day', now_utc at time zone 'utc') at time zone 'utc';
  month_start := date_trunc('month', now_utc at time zone 'utc') at time zone 'utc';

  -- Budget windows reset on UTC calendar boundaries. Cooldown and lease state
  -- are deliberately preserved across resets.
  if (c ->> 'day_start') is null or (c ->> 'day_start')::timestamptz < day_start then
    c := jsonb_set(jsonb_set(c, '{day_start}', to_jsonb(day_start)), '{day_used}', to_jsonb(0));
  end if;
  if (c ->> 'month_start') is null or (c ->> 'month_start')::timestamptz < month_start then
    c := jsonb_set(jsonb_set(c, '{month_start}', to_jsonb(month_start)), '{month_used}', to_jsonb(0));
  end if;

  return c;
end;
$$;

create or replace function public.h2_save_control(p_control jsonb)
returns void
language sql
volatile
set search_path = public
as $$
  update public.airtable_public_cache
  set control = p_control
  where cache_key = 'control:base';
$$;

-- ---------------------------------------------------------------------------
-- h2_get_or_claim: fresh payload, or atomically claim the single global lease.
-- ---------------------------------------------------------------------------
create or replace function public.h2_get_or_claim(p_cache_key text, p_schema_version integer)
returns jsonb
language plpgsql
volatile
set search_path = public
as $$
declare
  c jsonb;
  row_rec public.airtable_public_cache;
  now_utc timestamptz := now();
  token uuid;
begin
  if p_cache_key = 'control:base'
     or p_cache_key !~ '^(preview|production):(players|records|store|upcoming-games)$' then
    raise exception 'invalid cache key';
  end if;

  c := public.h2_lock_control();

  select * into row_rec
  from public.airtable_public_cache
  where cache_key = p_cache_key
  for update;

  if row_rec.cache_key is null then
    raise exception 'unknown cache key';
  end if;

  -- Fresh cache wins over every other condition (budget, cooldown, backoff).
  if row_rec.payload is not null
     and row_rec.fresh_until is not null
     and row_rec.fresh_until > now_utc
     and row_rec.schema_version = p_schema_version then
    perform public.h2_save_control(c);
    return jsonb_build_object('status', 'fresh', 'payload', row_rec.payload,
                              'fresh_until', row_rec.fresh_until);
  end if;

  if coalesce((c ->> 'enabled')::boolean, false) is not true then
    perform public.h2_save_control(c);
    return jsonb_build_object('status', 'disabled');
  end if;

  -- Another refresh holds the global lease.
  if (c ->> 'lease_expires_at') is not null
     and (c ->> 'lease_expires_at')::timestamptz > now_utc then
    perform public.h2_save_control(c);
    return jsonb_build_object('status', 'busy', 'recheck_after_ms', 700);
  end if;

  if row_rec.retry_after is not null and row_rec.retry_after > now_utc then
    perform public.h2_save_control(c);
    return jsonb_build_object('status', 'backoff', 'retry_after', row_rec.retry_after);
  end if;

  if (c ->> 'cooldown_until') is not null
     and (c ->> 'cooldown_until')::timestamptz > now_utc then
    perform public.h2_save_control(c);
    return jsonb_build_object('status', 'cooldown',
                              'retry_after', (c ->> 'cooldown_until')::timestamptz);
  end if;

  if (c ->> 'day_used')::numeric >= (c ->> 'day_limit')::numeric
     or (c ->> 'month_used')::numeric >= (c ->> 'month_limit')::numeric then
    perform public.h2_save_control(c);
    return jsonb_build_object('status', 'budget_exhausted');
  end if;

  token := gen_random_uuid();
  c := jsonb_set(c, '{lease_token}', to_jsonb(token::text));
  c := jsonb_set(c, '{lease_feed}', to_jsonb(p_cache_key));
  c := jsonb_set(c, '{lease_started_at}', to_jsonb(now_utc));
  c := jsonb_set(c, '{lease_expires_at}', to_jsonb(now_utc + interval '60 seconds'));
  c := jsonb_set(c, '{last_page_sequence}', to_jsonb(0));
  perform public.h2_save_control(c);

  update public.airtable_public_cache
  set refresh_started_at = now_utc
  where cache_key = p_cache_key;

  return jsonb_build_object('status', 'claimed', 'lease_token', token::text,
                            'refresh_deadline_ms', 45000, 'lease_seconds', 60);
end;
$$;

-- ---------------------------------------------------------------------------
-- h2_take_page_permit: authorize exactly one Airtable pagination request.
-- Counters increment BEFORE the request is authorized; never refunded.
-- ---------------------------------------------------------------------------
create or replace function public.h2_take_page_permit(
  p_cache_key text,
  p_lease_token uuid,
  p_sequence integer
)
returns jsonb
language plpgsql
volatile
set search_path = public
as $$
declare
  c jsonb;
  row_rec public.airtable_public_cache;
  now_utc timestamptz := now();
  wait_ms integer;
begin
  if p_sequence is null or p_sequence < 1 then
    raise exception 'invalid page sequence';
  end if;

  c := public.h2_lock_control();

  select * into row_rec
  from public.airtable_public_cache
  where cache_key = p_cache_key
  for update;

  if row_rec.cache_key is null then
    raise exception 'unknown cache key';
  end if;

  -- Lease must be current, unexpired, and owned by this feed.
  if (c ->> 'lease_token') is null
     or (c ->> 'lease_token')::uuid <> p_lease_token
     or (c ->> 'lease_feed') <> p_cache_key
     or (c ->> 'lease_expires_at')::timestamptz <= now_utc then
    perform public.h2_save_control(c);
    return jsonb_build_object('status', 'expired');
  end if;

  -- Total refresh deadline, measured from refresh START.
  if row_rec.refresh_started_at is null
     or now_utc > row_rec.refresh_started_at + interval '45 seconds' then
    perform public.h2_save_control(c);
    return jsonb_build_object('status', 'deadline_exceeded');
  end if;

  -- Strictly sequential permits: no duplicate authorizations.
  if p_sequence <> coalesce((c ->> 'last_page_sequence')::integer, 0) + 1 then
    perform public.h2_save_control(c);
    return jsonb_build_object('status', 'sequence_conflict');
  end if;

  if (c ->> 'cooldown_until') is not null
     and (c ->> 'cooldown_until')::timestamptz > now_utc then
    perform public.h2_save_control(c);
    return jsonb_build_object('status', 'cooldown');
  end if;

  if (c ->> 'day_used')::numeric >= (c ->> 'day_limit')::numeric
     or (c ->> 'month_used')::numeric >= (c ->> 'month_limit')::numeric then
    perform public.h2_save_control(c);
    return jsonb_build_object('status', 'budget_exhausted');
  end if;

  -- Global pacing: grants are spaced 2 seconds apart and each grant is only
  -- usable for 1 second, which guarantees >= 1 second between dispatches.
  if (c ->> 'next_request_at') is not null
     and (c ->> 'next_request_at')::timestamptz > now_utc then
    wait_ms := greatest(
      0,
      ceil(extract(epoch from ((c ->> 'next_request_at')::timestamptz - now_utc)) * 1000)::integer
    );
    perform public.h2_save_control(c);
    return jsonb_build_object('status', 'paced', 'wait_ms', wait_ms);
  end if;

  c := jsonb_set(c, '{day_used}', to_jsonb(((c ->> 'day_used')::numeric) + 1));
  c := jsonb_set(c, '{month_used}', to_jsonb(((c ->> 'month_used')::numeric) + 1));
  c := jsonb_set(c, '{last_page_sequence}', to_jsonb(p_sequence));
  c := jsonb_set(c, '{next_request_at}', to_jsonb(now_utc + interval '2 seconds'));
  perform public.h2_save_control(c);

  return jsonb_build_object(
    'status', 'granted',
    'usable_for_ms', 1000,
    'sequence', p_sequence,
    'day_used', (c ->> 'day_used')::numeric,
    'month_used', (c ->> 'month_used')::numeric
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- h2_finish_refresh: publish a COMPLETE payload from the current lease owner.
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
set search_path = public
as $$
declare
  c jsonb;
  row_rec public.airtable_public_cache;
  now_utc timestamptz := now();
  started timestamptz;
begin
  if p_payload is null then
    return jsonb_build_object('status', 'rejected', 'reason', 'empty_payload');
  end if;

  c := public.h2_lock_control();

  select * into row_rec
  from public.airtable_public_cache
  where cache_key = p_cache_key
  for update;

  if row_rec.cache_key is null then
    raise exception 'unknown cache key';
  end if;

  if (c ->> 'lease_token') is null
     or (c ->> 'lease_token')::uuid <> p_lease_token
     or (c ->> 'lease_feed') <> p_cache_key
     or (c ->> 'lease_expires_at')::timestamptz <= now_utc then
    perform public.h2_save_control(c);
    return jsonb_build_object('status', 'stale_lease');
  end if;

  started := coalesce(row_rec.refresh_started_at, now_utc);

  update public.airtable_public_cache
  set payload = p_payload,
      schema_version = 1,
      fresh_until = started + interval '900 seconds',
      retry_after = null,
      failure_count = 0,
      last_page_counts = coalesce(p_page_counts, '{}'::jsonb)
  where cache_key = p_cache_key;

  c := jsonb_set(c, '{lease_token}', 'null'::jsonb);
  c := jsonb_set(c, '{lease_feed}', 'null'::jsonb);
  c := jsonb_set(c, '{lease_started_at}', 'null'::jsonb);
  c := jsonb_set(c, '{lease_expires_at}', 'null'::jsonb);
  c := jsonb_set(c, '{last_page_sequence}', to_jsonb(0));
  perform public.h2_save_control(c);

  return jsonb_build_object('status', 'published',
                            'fresh_until', started + interval '900 seconds');
end;
$$;

-- ---------------------------------------------------------------------------
-- h2_fail_refresh: bounded feed backoff, shared 429 cooldown, lease release.
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
set search_path = public
as $$
declare
  c jsonb;
  row_rec public.airtable_public_cache;
  now_utc timestamptz := now();
  next_failures integer;
  backoff_seconds numeric;
  cooldown_seconds numeric;
  released boolean := false;
begin
  c := public.h2_lock_control();

  select * into row_rec
  from public.airtable_public_cache
  where cache_key = p_cache_key
  for update;

  if row_rec.cache_key is null then
    raise exception 'unknown cache key';
  end if;

  next_failures := coalesce(row_rec.failure_count, 0) + 1;
  -- 10s, 20s, 40s, ... capped at ~5 minutes.
  backoff_seconds := least(300, 10 * power(2, least(next_failures - 1, 10)));

  update public.airtable_public_cache
  set failure_count = next_failures,
      retry_after = now_utc + make_interval(secs => backoff_seconds)
  where cache_key = p_cache_key;

  if p_kind = 'rate_limited' then
    cooldown_seconds := least(greatest(30, coalesce(p_retry_after_seconds, 0)), 3600);
    c := jsonb_set(c, '{cooldown_until}',
                   to_jsonb(now_utc + make_interval(secs => cooldown_seconds)));
  end if;

  if (c ->> 'lease_token') is not null
     and (c ->> 'lease_token')::uuid = p_lease_token
     and (c ->> 'lease_feed') = p_cache_key then
    c := jsonb_set(c, '{lease_token}', 'null'::jsonb);
    c := jsonb_set(c, '{lease_feed}', 'null'::jsonb);
    c := jsonb_set(c, '{lease_started_at}', 'null'::jsonb);
    c := jsonb_set(c, '{lease_expires_at}', 'null'::jsonb);
    c := jsonb_set(c, '{last_page_sequence}', to_jsonb(0));
    released := true;
  end if;

  perform public.h2_save_control(c);

  return jsonb_build_object('status', 'recorded', 'released', released,
                            'retry_after', now_utc + make_interval(secs => backoff_seconds));
end;
$$;

-- Function privileges: visitors may not invoke the coordinator.
revoke all on function public.h2_lock_control() from public, anon, authenticated;
revoke all on function public.h2_save_control(jsonb) from public, anon, authenticated;
revoke all on function public.h2_get_or_claim(text, integer) from public, anon, authenticated;
revoke all on function public.h2_take_page_permit(text, uuid, integer) from public, anon, authenticated;
revoke all on function public.h2_finish_refresh(text, uuid, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.h2_fail_refresh(text, uuid, text, numeric) from public, anon, authenticated;
revoke all on function public.h2_touch_updated_at() from public, anon, authenticated;

grant execute on function public.h2_get_or_claim(text, integer) to service_role;
grant execute on function public.h2_take_page_permit(text, uuid, integer) to service_role;
grant execute on function public.h2_finish_refresh(text, uuid, jsonb, jsonb) to service_role;
grant execute on function public.h2_fail_refresh(text, uuid, text, numeric) to service_role;
grant execute on function public.h2_lock_control() to service_role;
grant execute on function public.h2_save_control(jsonb) to service_role;
