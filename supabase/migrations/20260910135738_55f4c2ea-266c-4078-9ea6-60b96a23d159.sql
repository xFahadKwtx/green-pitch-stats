-- H2 correction: per-feed refresh leases with globally shared Airtable limits.
--
-- Additive only. No column is dropped, no cache row or payload is deleted, the
-- enabled flag / budgets / cooldown / pacing are preserved untouched, and no
-- privilege is widened (service_role only).
--
-- Change: the single global lease on control:base becomes one INDEPENDENT lease
-- per feed cache key under control -> 'leases'. Every Airtable page permit still
-- takes the SAME control row lock and still consumes the SAME global day/month
-- budget, pacing window and 429 cooldown, so two feeds refreshing at once can
-- never dispatch outside the existing spacing rule.

-- 1) Migrate the control shape conservatively.
--    Any legacy lease that is still active keeps only its expires_at, with a NULL
--    token: the pre-migration owner can therefore neither publish nor take
--    permits, and that feed stays busy until the old window elapses.
alter table public.airtable_public_cache
  drop constraint if exists airtable_public_cache_control_shape;

update public.airtable_public_cache c0
set control = (
  (control - 'lease_token' - 'lease_feed' - 'lease_started_at' - 'lease_expires_at'
           - 'last_page_sequence')
  || jsonb_build_object('leases', (
       select jsonb_object_agg(
                k,
                jsonb_build_object(
                  'token', 'null'::jsonb,
                  'started_at', 'null'::jsonb,
                  'expires_at', case
                    when (c0.control ->> 'lease_feed') = k
                     and (c0.control ->> 'lease_expires_at') is not null
                     and (c0.control ->> 'lease_expires_at')::timestamptz > clock_timestamp()
                    then to_jsonb(c0.control ->> 'lease_expires_at')
                    else 'null'::jsonb
                  end,
                  'last_page_sequence', to_jsonb(0)
                )
              )
       from unnest(array[
         'preview:players', 'preview:records', 'preview:store', 'preview:upcoming-games',
         'production:players', 'production:records', 'production:store',
         'production:upcoming-games'
       ]) as k
     ))
)
where c0.cache_key = 'control:base';

-- 2) Strict control-shape validation (a CHECK cannot contain subqueries, so the
--    validation lives in an IMMUTABLE helper). Unknown or malformed lease keys
--    are rejected: exactly the eight allowed environment-scoped keys may exist.
create or replace function public.h2_control_shape_valid(c jsonb)
returns boolean
language sql
immutable
set search_path = public
as $$
  select c is not null
    and jsonb_typeof(c) = 'object'
    and jsonb_typeof(c -> 'enabled') = 'boolean'
    and (c ? 'next_request_at') and jsonb_typeof(c -> 'next_request_at') in ('null', 'string')
    and (c ? 'cooldown_until') and jsonb_typeof(c -> 'cooldown_until') in ('null', 'string')
    and jsonb_typeof(c -> 'day_used') = 'number'
    and (c ->> 'day_used')::numeric >= 0
    and (c ->> 'day_used')::numeric = trunc((c ->> 'day_used')::numeric)
    and jsonb_typeof(c -> 'month_used') = 'number'
    and (c ->> 'month_used')::numeric >= 0
    and (c ->> 'month_used')::numeric = trunc((c ->> 'month_used')::numeric)
    and jsonb_typeof(c -> 'day_limit') = 'number'
    and (c ->> 'day_limit')::numeric >= 0
    and (c ->> 'day_limit')::numeric <= 2100
    and (c ->> 'day_limit')::numeric = trunc((c ->> 'day_limit')::numeric)
    and jsonb_typeof(c -> 'month_limit') = 'number'
    and (c ->> 'month_limit')::numeric >= 0
    and (c ->> 'month_limit')::numeric <= 65000
    and (c ->> 'month_limit')::numeric = trunc((c ->> 'month_limit')::numeric)
    and jsonb_typeof(c -> 'day_start') = 'string'
    and jsonb_typeof(c -> 'month_start') = 'string'
    and jsonb_typeof(c -> 'leases') = 'object'
    and (
      select count(*) = 8
      from jsonb_object_keys(c -> 'leases') as k(key)
      where k.key ~ '^(preview|production):(players|records|store|upcoming-games)$'
    )
    and (select count(*) = 8 from jsonb_object_keys(c -> 'leases') as k2(key))
    and not exists (
      select 1
      from jsonb_each(c -> 'leases') as e(key, v)
      where jsonb_typeof(v) <> 'object'
         or not (v ? 'token') or jsonb_typeof(v -> 'token') not in ('null', 'string')
         or not (v ? 'started_at') or jsonb_typeof(v -> 'started_at') not in ('null', 'string')
         or not (v ? 'expires_at') or jsonb_typeof(v -> 'expires_at') not in ('null', 'string')
         or jsonb_typeof(v -> 'last_page_sequence') <> 'number'
         or (v ->> 'last_page_sequence')::numeric < 0
         or (v ->> 'last_page_sequence')::numeric <> trunc((v ->> 'last_page_sequence')::numeric)
    );
$$;

revoke all on function public.h2_control_shape_valid(jsonb) from public;
revoke all on function public.h2_control_shape_valid(jsonb) from anon;
revoke all on function public.h2_control_shape_valid(jsonb) from authenticated;
grant execute on function public.h2_control_shape_valid(jsonb) to service_role;

alter table public.airtable_public_cache
  add constraint airtable_public_cache_control_shape check (
    cache_key <> 'control:base'
    or public.h2_control_shape_valid(control)
  );

-- 3) Coordinator functions, now lease-per-feed. All limits stay global.
create or replace function public.h2_get_or_claim(p_cache_key text, p_schema_version integer)
returns jsonb
language plpgsql
set search_path = public
as $function$
declare
  c jsonb;
  lease jsonb;
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

  -- UTC calendar budget resets. Cooldown and all leases are preserved.
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

  lease := c -> 'leases' -> p_cache_key;
  if lease is null or jsonb_typeof(lease) <> 'object' then
    raise exception 'missing lease slot';
  end if;

  -- Busy only when THIS feed already has an unexpired lease. Another feed's
  -- refresh never blocks this one.
  if (lease ->> 'expires_at') is not null
     and (lease ->> 'expires_at')::timestamptz > ts then
    if v_dirty then
      update public.airtable_public_cache set control = c where cache_key = 'control:base';
    end if;
    return jsonb_build_object(
      'status', 'busy',
      'recheck_after_ms', 1000,
      'lease_expires_at', (lease ->> 'expires_at')::timestamptz
    );
  end if;

  if row_rec.retry_after is not null and row_rec.retry_after > ts then
    if v_dirty then
      update public.airtable_public_cache set control = c where cache_key = 'control:base';
    end if;
    return jsonb_build_object('status', 'backoff', 'retry_after', row_rec.retry_after);
  end if;

  -- Shared 429 cooldown: one feed's rate limit blocks every feed.
  if (c ->> 'cooldown_until') is not null
     and (c ->> 'cooldown_until')::timestamptz > ts then
    if v_dirty then
      update public.airtable_public_cache set control = c where cache_key = 'control:base';
    end if;
    return jsonb_build_object('status', 'cooldown',
                              'retry_after', (c ->> 'cooldown_until')::timestamptz);
  end if;

  -- Shared global budgets.
  if (c ->> 'day_used')::numeric >= (c ->> 'day_limit')::numeric
     or (c ->> 'month_used')::numeric >= (c ->> 'month_limit')::numeric then
    if v_dirty then
      update public.airtable_public_cache set control = c where cache_key = 'control:base';
    end if;
    return jsonb_build_object('status', 'budget_exhausted');
  end if;

  token := gen_random_uuid();
  c := jsonb_set(
    c,
    array['leases', p_cache_key],
    jsonb_build_object(
      'token', to_jsonb(token::text),
      'started_at', to_jsonb(ts),
      'expires_at', to_jsonb(ts + interval '60 seconds'),
      'last_page_sequence', to_jsonb(0)
    )
  );
  update public.airtable_public_cache set control = c where cache_key = 'control:base';

  return jsonb_build_object(
    'status', 'claimed',
    'lease_token', token::text,
    'refresh_deadline_ms', floor(extract(epoch from ((ts + interval '45 seconds') - clock_timestamp())) * 1000)::bigint,
    'lease_expires_at', ts + interval '60 seconds'
  );
end;
$function$;

create or replace function public.h2_take_page_permit(p_cache_key text, p_lease_token uuid, p_sequence integer)
returns jsonb
language plpgsql
set search_path = public
as $function$
declare
  c jsonb;
  lease jsonb;
  ts timestamptz;
  started timestamptz;
  wait_ms bigint;
  v_day_start timestamptz;
  v_month_start timestamptz;
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

  -- Every permit serializes on the SAME control row: global pacing, budgets and
  -- cooldown remain strictly one-at-a-time across all feeds.
  select control into c
  from public.airtable_public_cache
  where cache_key = 'control:base'
  for update;
  if c is null then
    raise exception 'H2 control row missing';
  end if;

  ts := clock_timestamp();
  lease := c -> 'leases' -> p_cache_key;

  -- Owner validation BEFORE any mutation. A wrong feed key or token can never
  -- authorize a page or touch another feed's lease.
  if lease is null
     or jsonb_typeof(lease) <> 'object'
     or (lease ->> 'token') is null
     or (lease ->> 'token') is distinct from p_lease_token::text
     or (lease ->> 'expires_at') is null
     or (lease ->> 'expires_at')::timestamptz <= ts then
    return jsonb_build_object('status', 'expired');
  end if;

  if coalesce((c ->> 'enabled')::boolean, false) is not true then
    return jsonb_build_object('status', 'disabled');
  end if;

  -- Hard 45s total refresh deadline, from this feed's own refresh start.
  started := (lease ->> 'started_at')::timestamptz;
  if started is null or ts >= started + interval '45 seconds' then
    return jsonb_build_object('status', 'deadline_exceeded');
  end if;

  -- Strictly sequential permits WITHIN this feed's refresh.
  if p_sequence <> coalesce((lease ->> 'last_page_sequence')::integer, 0) + 1 then
    return jsonb_build_object('status', 'sequence_conflict');
  end if;

  -- UTC window normalization on the POST-LOCK clock. Leases and cooldown kept.
  v_day_start := date_trunc('day', ts at time zone 'UTC') at time zone 'UTC';
  v_month_start := date_trunc('month', ts at time zone 'UTC') at time zone 'UTC';
  if (c ->> 'day_start') is null or (c ->> 'day_start')::timestamptz < v_day_start then
    c := jsonb_set(jsonb_set(c, '{day_start}', to_jsonb(v_day_start)), '{day_used}', to_jsonb(0));
  end if;
  if (c ->> 'month_start') is null or (c ->> 'month_start')::timestamptz < v_month_start then
    c := jsonb_set(jsonb_set(c, '{month_start}', to_jsonb(v_month_start)), '{month_used}', to_jsonb(0));
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
  c := jsonb_set(c, '{next_request_at}', to_jsonb(ts + interval '2 seconds'));
  c := jsonb_set(
    c,
    array['leases', p_cache_key, 'last_page_sequence'],
    to_jsonb(p_sequence)
  );
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
$function$;

create or replace function public.h2_finish_refresh(p_cache_key text, p_lease_token uuid, p_payload jsonb, p_page_counts jsonb)
returns jsonb
language plpgsql
set search_path = public
as $function$
declare
  c jsonb;
  lease jsonb;
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
  lease := c -> 'leases' -> p_cache_key;

  if lease is null
     or jsonb_typeof(lease) <> 'object'
     or (lease ->> 'token') is null
     or (lease ->> 'token') is distinct from p_lease_token::text
     or (lease ->> 'expires_at') is null
     or (lease ->> 'expires_at')::timestamptz <= ts then
    return jsonb_build_object('status', 'stale_lease');
  end if;

  if coalesce((c ->> 'enabled')::boolean, false) is not true then
    return jsonb_build_object('status', 'rejected', 'reason', 'disabled');
  end if;

  started := (lease ->> 'started_at')::timestamptz;
  if started is null or ts >= started + interval '45 seconds' then
    return jsonb_build_object('status', 'rejected', 'reason', 'deadline_exceeded');
  end if;

  -- Published pages must match exactly this feed's authorized permits.
  select coalesce(sum((v #>> '{}')::numeric), 0) into counted
  from jsonb_each(p_page_counts) as e(k, v);
  if counted is distinct from coalesce((lease ->> 'last_page_sequence')::numeric, 0) then
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

  -- Release ONLY this feed's lease.
  c := jsonb_set(
    c,
    array['leases', p_cache_key],
    jsonb_build_object(
      'token', 'null'::jsonb,
      'started_at', 'null'::jsonb,
      'expires_at', 'null'::jsonb,
      'last_page_sequence', to_jsonb(0)
    )
  );
  update public.airtable_public_cache set control = c where cache_key = 'control:base';

  return jsonb_build_object(
    'status', 'published',
    'fresh_until', started + interval '900 seconds',
    'fresh_for_ms', floor(extract(epoch from ((started + interval '900 seconds') - ts)) * 1000)::bigint
  );
end;
$function$;

create or replace function public.h2_fail_refresh(p_cache_key text, p_lease_token uuid, p_kind text, p_retry_after_seconds numeric)
returns jsonb
language plpgsql
set search_path = public
as $function$
declare
  c jsonb;
  lease jsonb;
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
  lease := c -> 'leases' -> p_cache_key;

  -- Stale/expired owner: no state may be altered, in particular no other feed's.
  if lease is null
     or jsonb_typeof(lease) <> 'object'
     or (lease ->> 'token') is null
     or (lease ->> 'token') is distinct from p_lease_token::text
     or (lease ->> 'expires_at') is null
     or (lease ->> 'expires_at')::timestamptz <= ts then
    return jsonb_build_object('status', 'ignored', 'reason', 'stale_lease');
  end if;

  -- Per-feed failure backoff on the feed's own row.
  next_failures := coalesce(row_rec.failure_count, 0) + 1;
  backoff_seconds := least(300, 10 * power(2, least(next_failures - 1, 10)));

  update public.airtable_public_cache
  set failure_count = next_failures,
      retry_after = greatest(
        coalesce(row_rec.retry_after, ts),
        ts + make_interval(secs => backoff_seconds)
      )
  where cache_key = p_cache_key;

  -- 429 cooldown stays GLOBAL and shared by every feed.
  if p_kind = 'rate_limited' then
    if p_retry_after_seconds is not null
       and lower(p_retry_after_seconds::text) not in ('nan', 'infinity', '-infinity')
       and p_retry_after_seconds > 0 then
      cooldown_seconds := greatest(30, p_retry_after_seconds);
    else
      cooldown_seconds := 30;
    end if;

    begin
      cooldown_until := ts + make_interval(secs => cooldown_seconds);
    exception
      when others then
        cooldown_until := 'infinity'::timestamptz;
    end;

    existing_cooldown := (c ->> 'cooldown_until')::timestamptz;
    if existing_cooldown is not null and existing_cooldown > cooldown_until then
      cooldown_until := existing_cooldown;
    end if;
    c := jsonb_set(c, '{cooldown_until}', to_jsonb(cooldown_until));
  end if;

  -- Release ONLY this feed's lease.
  c := jsonb_set(
    c,
    array['leases', p_cache_key],
    jsonb_build_object(
      'token', 'null'::jsonb,
      'started_at', 'null'::jsonb,
      'expires_at', 'null'::jsonb,
      'last_page_sequence', to_jsonb(0)
    )
  );
  update public.airtable_public_cache set control = c where cache_key = 'control:base';

  return jsonb_build_object('status', 'recorded', 'released', true);
end;
$function$;

revoke all on function public.h2_get_or_claim(text, integer) from public;
revoke all on function public.h2_get_or_claim(text, integer) from anon;
revoke all on function public.h2_get_or_claim(text, integer) from authenticated;
grant execute on function public.h2_get_or_claim(text, integer) to service_role;

revoke all on function public.h2_take_page_permit(text, uuid, integer) from public;
revoke all on function public.h2_take_page_permit(text, uuid, integer) from anon;
revoke all on function public.h2_take_page_permit(text, uuid, integer) from authenticated;
grant execute on function public.h2_take_page_permit(text, uuid, integer) to service_role;

revoke all on function public.h2_finish_refresh(text, uuid, jsonb, jsonb) from public;
revoke all on function public.h2_finish_refresh(text, uuid, jsonb, jsonb) from anon;
revoke all on function public.h2_finish_refresh(text, uuid, jsonb, jsonb) from authenticated;
grant execute on function public.h2_finish_refresh(text, uuid, jsonb, jsonb) to service_role;

revoke all on function public.h2_fail_refresh(text, uuid, text, numeric) from public;
revoke all on function public.h2_fail_refresh(text, uuid, text, numeric) from anon;
revoke all on function public.h2_fail_refresh(text, uuid, text, numeric) from authenticated;
grant execute on function public.h2_fail_refresh(text, uuid, text, numeric) to service_role;