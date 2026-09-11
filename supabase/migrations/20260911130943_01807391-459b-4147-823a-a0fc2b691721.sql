create or replace function public.h2_get_or_claim_ahead(p_cache_key text, p_schema_version integer, p_min_fresh_ms integer)
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
  v_max_window integer;
begin
  if p_cache_key is null
     or p_cache_key = 'control:base'
     or p_cache_key !~ '^(preview|production):(players|records|store|upcoming-games)$' then
    raise exception 'invalid cache key';
  end if;
  if p_schema_version is null or p_schema_version is distinct from 1 then
    raise exception 'unsupported schema version';
  end if;
  -- Wider bound ONLY for production players/store scheduled warming: one ~10min
  -- tick plus jitter/runtime margin. Preview and every other feed keep 120000.
  v_max_window := case when p_cache_key ~ '^production:(players|store)$' then 660000 else 120000 end;
  if p_min_fresh_ms is null or p_min_fresh_ms < 0 or p_min_fresh_ms > v_max_window then
    raise exception 'invalid refresh-ahead window';
  end if;

  select * into row_rec from public.airtable_public_cache where cache_key = p_cache_key;
  if row_rec.cache_key is null then
    raise exception 'unknown cache key';
  end if;
  ts := clock_timestamp();
  if row_rec.payload is not null
     and row_rec.fresh_until is not null
     and row_rec.fresh_until > ts + make_interval(secs => greatest(coalesce(p_min_fresh_ms, 0), 0) / 1000.0)
     and row_rec.schema_version = 1 then
    return jsonb_build_object(
      'status', 'fresh',
      'payload', row_rec.payload,
      'fresh_until', row_rec.fresh_until,
      'fresh_for_ms', floor(extract(epoch from (row_rec.fresh_until - ts)) * 1000)::bigint
    );
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

  ts := clock_timestamp();

  if row_rec.payload is not null
     and row_rec.fresh_until is not null
     and row_rec.fresh_until > ts + make_interval(secs => greatest(coalesce(p_min_fresh_ms, 0), 0) / 1000.0)
     and row_rec.schema_version = 1 then
    return jsonb_build_object(
      'status', 'fresh',
      'payload', row_rec.payload,
      'fresh_until', row_rec.fresh_until,
      'fresh_for_ms', floor(extract(epoch from (row_rec.fresh_until - ts)) * 1000)::bigint
    );
  end if;

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
