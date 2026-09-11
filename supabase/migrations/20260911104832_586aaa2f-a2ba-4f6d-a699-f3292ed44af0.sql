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

  -- Owner validation BEFORE any mutation.
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
  -- Global dispatch spacing: 500ms (max ~2 serialized requests/second).
  c := jsonb_set(c, '{next_request_at}', to_jsonb(ts + interval '500 milliseconds'));
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