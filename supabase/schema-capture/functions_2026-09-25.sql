-- TravelOS - database functions and procedures
-- Generated 2026-09-25 from the live database (project cyrgzvnjvevwbjqxgfxd).
-- Schemas: public, private. Extension-owned functions excluded.
--
-- A capture of live state, not a migration. See rls_policies_2026-09-25.sql
-- for why these files exist. Supersede with `supabase db dump` once Docker runs.
--
-- The load-bearing ones, for orientation:
--   private.is_trip_member(uuid)      the RLS membership gate
--   private.trip_edit_role(uuid)      the write gate; requires kind='account',
--                                     which is why guests cannot edit
--   private.current_platform_user_id() bridges auth.uid() to the usr_ axis
--   private.mfa_satisfied()           true when the user has no verified factor
--   public.itinerary_add_items / _update_item / _delete_items /
--          _restore_version / _undo_change
--                                     the versioned write path the web app uses
--   public.replan_apply_atomic        the atomic-write pattern
--   public.fx_convert(char,char,bigint)

CREATE OR REPLACE FUNCTION private.can_edit_trip(p_trip_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select coalesce(private.trip_edit_role(p_trip_id) in ('owner', 'organizer', 'member'), false)
$function$
;

CREATE OR REPLACE FUNCTION private.current_platform_user_id()
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select ai.user_id
  from public.auth_identities ai
  where ai.provider_subject = auth.uid()::text
  limit 1
$function$
;

CREATE OR REPLACE FUNCTION private.guard_expense_roster()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
  -- The mirror itself, or a cascade (trip / user deleted), may write.
  if current_setting('travelos.roster_sync', true) = 'on' or pg_trigger_depth() > 1 then
    return coalesce(new, old);
  end if;
  raise exception 'Expense groups follow the trip''s members. Add or remove people on the trip itself.'
    using errcode = 'P0001';
end $function$
;

CREATE OR REPLACE FUNCTION private.is_trip_member(p_trip_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select exists (
    select 1 from public.trip_members tm
    where tm.trip_id = p_trip_id
      and tm.user_id = private.current_platform_user_id()
      and tm.removed_at is null
  )
$function$
;

CREATE OR REPLACE FUNCTION private.itinerary_ensure_baseline(p_trip_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_num int; v_snap jsonb; v_new uuid;
begin
  if exists (select 1 from public.itinerary_versions where trip_id = p_trip_id and is_active) then
    return null;
  end if;
  select coalesce(max(version_number), 0) + 1 into v_num from public.itinerary_versions where trip_id = p_trip_id;
  select coalesce(jsonb_agg(to_jsonb(i) order by i.date nulls last, i.start_time nulls last, i.title), '[]'::jsonb)
    into v_snap from public.itinerary_items i where i.trip_id = p_trip_id;
  insert into public.itinerary_versions (trip_id, user_id, version_number, parent_version_id, is_active, status, creation_method, version_name, change_summary, itinerary_snapshot, post_activation_status)
  values (p_trip_id, auth.uid(), v_num, null, true, 'ready', 'USER_EDIT', 'Starting point', array['Itinerary before the first change'], v_snap, 'SKIPPED')
  returning id into v_new;
  return v_new;
end $function$
;

CREATE OR REPLACE FUNCTION private.itinerary_snapshot_version(p_trip_id uuid, p_method text, p_name text, p_summary text[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_prev uuid; v_num int; v_new uuid; v_snap jsonb;
begin
  select id into v_prev from public.itinerary_versions where trip_id = p_trip_id and is_active order by version_number desc limit 1;
  select coalesce(max(version_number), 0) + 1 into v_num from public.itinerary_versions where trip_id = p_trip_id;
  select coalesce(jsonb_agg(to_jsonb(i) order by i.date nulls last, i.start_time nulls last, i.title), '[]'::jsonb) into v_snap from public.itinerary_items i where i.trip_id = p_trip_id;
  update public.itinerary_versions set is_active = false, updated_at = now() where trip_id = p_trip_id and is_active;
  insert into public.itinerary_versions (trip_id, user_id, version_number, parent_version_id, is_active, status, creation_method, version_name, change_summary, itinerary_snapshot, post_activation_status)
  values (p_trip_id, auth.uid(), v_num, v_prev, true, 'ready', p_method, p_name, p_summary, v_snap, 'SKIPPED') returning id into v_new;
  update public.trips set version = version + 1 where id = p_trip_id;
  return jsonb_build_object('new_version_id', v_new, 'previous_version_id', v_prev, 'version_number', v_num);
end $function$
;

CREATE OR REPLACE FUNCTION private.mfa_satisfied()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
  select coalesce(auth.jwt()->>'aal', 'aal1') = 'aal2'
      or not exists (select 1 from auth.mfa_factors f
                     where f.user_id = auth.uid() and f.status = 'verified');
$function$
;

CREATE OR REPLACE FUNCTION private.security_sentinel_run()
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_last   timestamptz;
  v_now    timestamptz := now();
  v_alerts int := 0;
  v_errors jsonb := '[]'::jsonb;
  v_items  text[];
  r        record;
begin
  select v::timestamptz into v_last from private.sentinel_meta where k = 'last_run_at';
  v_last := coalesce(v_last, v_now - interval '5 minutes');

  begin
    select array_agg(c.relname order by c.relname) into v_items
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind in ('r','p') and not c.relrowsecurity;
    v_alerts := v_alerts + private.sentinel_diff('rls_disabled', v_items, 'critical',
      'Row-level security is OFF on a public table (data may be readable by anyone with the public key).');
  exception when others then v_errors := v_errors || to_jsonb('rls_disabled: ' || sqlerrm); end;

  begin
    select array_agg(format('%s.%s [%s] roles=%s', tablename, policyname, cmd, roles::text) order by 1) into v_items
      from pg_policies
     where schemaname in ('public','storage')
       and (roles && array['anon','public']::name[])
       and (coalesce(qual,'') = 'true' or coalesce(with_check,'') = 'true');
    v_alerts := v_alerts + private.sentinel_diff('open_policies', v_items, 'critical',
      'A policy now lets anonymous users read or write a table without restriction.', false, false);
  exception when others then v_errors := v_errors || to_jsonb('open_policies: ' || sqlerrm); end;

  begin
    select array_agg(format('%s.%s.%s#%s', schemaname, tablename, policyname,
             left(md5(cmd || roles::text || coalesce(qual,'') || coalesce(with_check,'')), 10)) order by 1)
      into v_items from pg_policies where schemaname in ('public','storage');
    v_alerts := v_alerts + private.sentinel_diff('policy_changes', v_items, 'warning',
      'Row-level security policies changed. Confirm this was a deliberate migration.');
  exception when others then v_errors := v_errors || to_jsonb('policy_changes: ' || sqlerrm); end;

  begin
    select array_agg(format('%s.%s(%s)', n.nspname, p.proname, pg_get_function_identity_arguments(p.oid)) order by 1)
      into v_items
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where p.prosecdef and n.nspname in ('public','private');
    v_alerts := v_alerts + private.sentinel_diff('security_definer_functions', v_items, 'warning',
      'SECURITY DEFINER functions changed. These bypass row-level security; review any new one.');
  exception when others then v_errors := v_errors || to_jsonb('security_definer_functions: ' || sqlerrm); end;

  begin
    select array_agg(format('%s(%s)', p.proname, pg_get_function_identity_arguments(p.oid)) order by 1) into v_items
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'EXECUTE');
    v_alerts := v_alerts + private.sentinel_diff('anon_executable_functions', v_items, 'warning',
      'A new database function is callable by anonymous users.', false, false);
  exception when others then v_errors := v_errors || to_jsonb('anon_executable_functions: ' || sqlerrm); end;

  begin
    select array_agg(format('%s|%s|%s', jobname, schedule, left(md5(command), 10)) order by 1) into v_items from cron.job;
    v_alerts := v_alerts + private.sentinel_diff('cron_jobs', v_items, 'warning',
      'Scheduled database jobs changed.');
  exception when others then v_errors := v_errors || to_jsonb('cron_jobs: ' || sqlerrm); end;

  begin
    select array_agg(format('%s public=%s', id, public) order by 1) into v_items from storage.buckets;
    v_alerts := v_alerts + private.sentinel_diff('storage_buckets', v_items, 'warning',
      'Storage buckets changed (a bucket was added, removed, or made public/private).');
  exception when others then v_errors := v_errors || to_jsonb('storage_buckets: ' || sqlerrm); end;

  begin
    select array_agg(format('%s super=%s login=%s bypassrls=%s createrole=%s',
             rolname, rolsuper, rolcanlogin, rolbypassrls, rolcreaterole) order by 1)
      into v_items from pg_roles where rolname not like 'pg\_%';
    v_alerts := v_alerts + private.sentinel_diff('db_roles', v_items, 'critical',
      'Database roles or their privileges changed.');
  exception when others then v_errors := v_errors || to_jsonb('db_roles: ' || sqlerrm); end;

  begin
    select array_agg(extname || ' ' || extversion order by 1) into v_items from pg_extension;
    v_alerts := v_alerts + private.sentinel_diff('extensions', v_items, 'warning',
      'Database extensions changed.');
  exception when others then v_errors := v_errors || to_jsonb('extensions: ' || sqlerrm); end;

  begin
    select array_agg(coalesce(name, id::text) order by 1) into v_items from vault.secrets;
    v_alerts := v_alerts + private.sentinel_diff('vault_secrets', v_items, 'warning',
      'Secrets stored in Vault were added or removed.');
  exception when others then v_errors := v_errors || to_jsonb('vault_secrets: ' || sqlerrm); end;

  begin
    select array_agg(format('%s <%s>', id, coalesce(email, phone, 'no email')) order by 1) into v_items from auth.users;
    v_alerts := v_alerts + private.sentinel_diff('auth_users', v_items, 'warning',
      'Accounts were created or deleted.');
  exception when others then v_errors := v_errors || to_jsonb('auth_users: ' || sqlerrm); end;

  begin
    select array_agg(distinct format('%s via %s', u.email,
             case when family(s.ip) = 4 then host(set_masklen(s.ip, 24)) || '/24' else host(set_masklen(s.ip, 48)) || '/48' end))
      into v_items
      from auth.sessions s join auth.users u on u.id = s.user_id where s.ip is not null;
    v_alerts := v_alerts + private.sentinel_diff('signin_networks', v_items, 'warning',
      'An account signed in from a network it has not used before.', true, false);
  exception when others then v_errors := v_errors || to_jsonb('signin_networks: ' || sqlerrm); end;

  begin
    if (select count(*) from auth.sessions where created_at > v_last) > 20 then
      perform private.sentinel_alert('warning', 'session_burst',
        'More than 20 sign-in sessions were created in five minutes.',
        jsonb_build_object('since', v_last,
          'sessions', (select count(*) from auth.sessions where created_at > v_last)));
      v_alerts := v_alerts + 1;
    end if;
  exception when others then v_errors := v_errors || to_jsonb('session_burst: ' || sqlerrm); end;

  begin
    for r in
      select s.relid, s.relname, s.n_tup_del, s.n_live_tup, t.n_tup_del as prev_del, t.n_live as prev_live
        from pg_stat_user_tables s
        left join private.sentinel_table_stats t on t.relid = s.relid
       where s.schemaname = 'public'
         and s.relname not in ('rate_limit_buckets','alert_dedup_log','alert_rate_counters','dedup_cache',
                               'api_cache_entries','provider_cache','idempotency_keys','idempotency_records',
                               'typing_indicators','presence','operation_locks','replan_cache','api_cost_daily')
    loop
      if r.prev_del is not null and r.n_tup_del - r.prev_del > greatest(200, r.prev_live / 2) then
        perform private.sentinel_alert('critical', 'mass_delete',
          format('%s rows were deleted from %s in five minutes.', r.n_tup_del - r.prev_del, r.relname),
          jsonb_build_object('table', r.relname, 'deleted', r.n_tup_del - r.prev_del,
                             'live_before', r.prev_live, 'live_now', r.n_live_tup));
        v_alerts := v_alerts + 1;
      end if;
      insert into private.sentinel_table_stats (relid, relname, n_tup_del, n_live, sampled_at)
      values (r.relid, r.relname, r.n_tup_del, r.n_live_tup, v_now)
      on conflict (relid) do update
        set n_tup_del = excluded.n_tup_del, n_live = excluded.n_live, sampled_at = excluded.sampled_at;
    end loop;
  exception when others then v_errors := v_errors || to_jsonb('mass_delete: ' || sqlerrm); end;

  begin
    select array_agg(format('%s/%s (%s)', bucket_id, name, coalesce(metadata->>'mimetype','?')) order by 1) into v_items
      from storage.objects
     where created_at > v_last
       and bucket_id <> 'console-static'
       and ( name ~* '\.(html?|xhtml|js|mjs|svg|exe|dll|scr|bat|cmd|ps1|sh|vbs|jar|apk|msi|php|hta|iso|dmg)$'
          or coalesce(metadata->>'mimetype','') ~* '(html|javascript|x-msdownload|x-sh|x-executable|svg|java-archive)' );
    if cardinality(v_items) > 0 then
      perform private.sentinel_alert('warning', 'risky_upload',
        'A file type that can carry malware or scripts was uploaded to storage.',
        jsonb_build_object('objects', to_jsonb(v_items[1:25])));
      v_alerts := v_alerts + 1;
    end if;
  exception when others then v_errors := v_errors || to_jsonb('risky_upload: ' || sqlerrm); end;

  insert into private.sentinel_meta (k, v) values ('last_run_at', v_now::text)
  on conflict (k) do update set v = excluded.v;

  insert into public.api_service_health (service, status, consecutive_failures, last_success_at, last_failure_at, updated_at)
  values ('security-sentinel',
          case when jsonb_array_length(v_errors) = 0 then 'healthy' else 'degraded' end,
          case when jsonb_array_length(v_errors) = 0 then 0 else 1 end,
          v_now,
          case when jsonb_array_length(v_errors) = 0 then null else v_now end,
          v_now)
  on conflict (service) do update set
    status = excluded.status, consecutive_failures = excluded.consecutive_failures,
    last_success_at = excluded.last_success_at, last_failure_at = excluded.last_failure_at,
    updated_at = excluded.updated_at;

  return jsonb_build_object('alerts', v_alerts, 'errors', v_errors, 'ran_at', v_now);
end $function$
;

CREATE OR REPLACE FUNCTION private.sentinel_alert(p_severity text, p_check text, p_message text, p_details jsonb)
 RETURNS void
 LANGUAGE sql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
  insert into public.api_alerts (id, severity, kind, service, message, details)
  values (
    'alt_sec_' || substr(md5(random()::text || clock_timestamp()::text), 1, 20),
    p_severity, 'security_' || p_check, 'security-sentinel', p_message,
    p_details || jsonb_build_object('check', p_check, 'detected_at', now())
  );
$function$
;

CREATE OR REPLACE FUNCTION private.sentinel_diff(p_key text, p_items text[], p_severity text, p_message text, p_cumulative boolean DEFAULT false, p_alert_removed boolean DEFAULT true)
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_base text[];
  v_added text[];
  v_removed text[];
begin
  p_items := coalesce(p_items, '{}');
  select items into v_base from private.sentinel_state where check_key = p_key;

  if not found then
    insert into private.sentinel_state (check_key, items) values (p_key, p_items);
    return 0;
  end if;

  select coalesce(array_agg(x order by x), '{}') into v_added
    from unnest(p_items) x where not (x = any (v_base));
  select coalesce(array_agg(x order by x), '{}') into v_removed
    from unnest(v_base) x where not (x = any (p_items));

  if p_cumulative then
    update private.sentinel_state
       set items = (select array_agg(distinct y) from unnest(v_base || p_items) y), updated_at = now()
     where check_key = p_key;
    v_removed := '{}';
  else
    update private.sentinel_state set items = p_items, updated_at = now() where check_key = p_key;
  end if;

  if cardinality(v_added) > 0 or (p_alert_removed and cardinality(v_removed) > 0) then
    perform private.sentinel_alert(p_severity, p_key, p_message,
      jsonb_build_object('added', to_jsonb(v_added[1:25]), 'removed', to_jsonb(v_removed[1:25]),
                         'added_count', cardinality(v_added), 'removed_count', cardinality(v_removed)));
    return 1;
  end if;
  return 0;
end $function$
;

CREATE OR REPLACE FUNCTION private.sync_trip_expense_group(p_trip uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_group text;
  v_name  text;
  v_owner uuid;
  v_ids   uuid[];
begin
  select coalesce(nullif(t.title, ''), nullif(t.name, ''), 'Trip'), t.user_id
    into v_name, v_owner
    from public.trips t where t.id = p_trip;
  if not found then return; end if;

  perform set_config('travelos.roster_sync', 'on', true);

  insert into public.trip_groups (id, trip_id, name, created_by)
  values ('tg_' || p_trip::text, p_trip, v_name, v_owner)
  on conflict (trip_id) do update set name = excluded.name, updated_at = now()
  returning id into v_group;

  select coalesce(array_agg(distinct au.id), '{}')
    into v_ids
    from public.trip_members tm
    join public.auth_identities ai on ai.user_id = tm.user_id
    join auth.users au on au.id::text = ai.provider_subject
   where tm.trip_id = p_trip and tm.kind = 'account' and tm.removed_at is null;

  insert into public.group_members (group_id, user_id, email, display_name, role, status, joined_at)
  select distinct on (au.id)
         v_group, au.id, coalesce(au.email, au.id::text),
         coalesce(nullif(au.raw_user_meta_data->>'full_name', ''), nullif(au.raw_user_meta_data->>'name', ''), tm.display_name),
         case tm.role::text when 'owner' then 'organizer' when 'organizer' then 'organizer'
                            when 'member' then 'participant' else 'viewer' end,
         'active', tm.joined_at
    from public.trip_members tm
    join public.auth_identities ai on ai.user_id = tm.user_id
    join auth.users au on au.id::text = ai.provider_subject
   where tm.trip_id = p_trip and tm.kind = 'account' and tm.removed_at is null
   order by au.id, case tm.role::text when 'owner' then 0 when 'organizer' then 1 when 'member' then 2 else 3 end
  on conflict (group_id, email) do update
     set user_id = excluded.user_id, display_name = excluded.display_name,
         role = excluded.role, status = 'active', invite_token = null, invite_expires_at = null;

  delete from public.group_members gm
   where gm.group_id = v_group and (gm.user_id is null or not (gm.user_id = any (v_ids)));

  perform set_config('travelos.roster_sync', '', true);
end $function$
;

CREATE OR REPLACE FUNCTION private.trip_edit_role(p_trip_id uuid)
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select tm.role::text from public.trip_members tm
   where tm.trip_id = p_trip_id and tm.user_id = private.current_platform_user_id() and tm.removed_at is null and tm.kind = 'account'
   order by case tm.role::text when 'owner' then 0 when 'organizer' then 1 when 'member' then 2 else 3 end limit 1
$function$
;

CREATE OR REPLACE FUNCTION private.trip_members_sync_expense_group()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.sync_trip_expense_group(coalesce(new.trip_id, old.trip_id));
  return null;
end $function$
;

CREATE OR REPLACE FUNCTION public.check_alert_cleanup_health()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'cron', 'net', 'pg_temp'
AS $function$
declare
  v_now             timestamptz := now();
  v_stale_dedup     integer;
  v_stale_counters  integer;
  v_stale_batches   integer;
  v_last_run        timestamptz;
  v_failed_runs     integer;
  v_recent_non_200  integer := 0;
  v_recent_seen     integer := 0;
  v_status          text;
  v_severity        text;
  v_problems        text[] := '{}';
  v_summary         jsonb;
begin
  -- 1. The outcome checks. cleanup_expired removes dedup rows once expired,
  --    rate counters older than 2 days, and cancels pending batches more than
  --    1 day past due. Anything well beyond those cutoffs means it is not
  --    running, whatever the logs say.
  select count(*) into v_stale_dedup
  from public.alert_dedup_log
  where expires_at < v_now - interval '26 hours';

  select count(*) into v_stale_counters
  from public.alert_rate_counters
  where window_start < v_now - interval '4 days';

  select count(*) into v_stale_batches
  from public.alert_batches
  where status = 'pending' and scheduled_for < v_now - interval '2 days';

  -- 2. Is the scheduler running at all?
  select max(d.start_time) into v_last_run
  from cron.job_run_details d
  join cron.job j on j.jobid = d.jobid
  where j.jobname = 'alert-cleanup-expired';

  select count(*) into v_failed_runs
  from cron.job_run_details d
  join cron.job j on j.jobid = d.jobid
  where j.jobname = 'alert-cleanup-expired'
    and d.start_time > v_now - interval '26 hours'
    and d.status is distinct from 'succeeded';

  -- 3. Opportunistic: if pg_net still holds the response, read its status.
  select count(*), count(*) filter (where r.status_code is distinct from 200)
    into v_recent_seen, v_recent_non_200
  from net._http_response r
  where r.created > v_now - interval '26 hours'
    and public.try_jsonb(r.content) -> 'data' ? 'cleaned';

  -- ── verdict ───────────────────────────────────────────────────────────────
  if v_stale_dedup > 0 or v_stale_counters > 0 or v_stale_batches > 0 then
    v_status := 'down';
    v_problems := v_problems || format(
      'rows that should have been cleaned are still present (dedup=%s, counters=%s, pending batches=%s)',
      v_stale_dedup, v_stale_counters, v_stale_batches);
  end if;

  -- A job that has never run is not yet evidence of anything; the outcome
  -- checks above are what would catch it, and they are clean.
  if v_last_run is not null and v_last_run < v_now - interval '26 hours' then
    v_status := 'down';
    v_problems := v_problems || format('cleanup has not run since %s', v_last_run);
  end if;

  if v_status is null then
    if v_failed_runs > 0 then
      v_status := 'degraded';
      v_problems := v_problems || format('%s cron run(s) failed in the last 26 hours', v_failed_runs);
    end if;
    if v_recent_non_200 > 0 then
      v_status := 'degraded';
      v_problems := v_problems || format('%s non-200 response(s) from cleanup_expired', v_recent_non_200);
    end if;
  end if;

  v_status := coalesce(v_status, 'healthy');
  v_severity := case v_status when 'down' then 'critical' when 'degraded' then 'warning' end;

  v_summary := jsonb_build_object(
    'status',                v_status,
    'checked_at',            v_now,
    'stale_dedup_rows',      v_stale_dedup,
    'stale_rate_counters',   v_stale_counters,
    'stale_pending_batches', v_stale_batches,
    'last_cron_run',         v_last_run,
    'failed_runs_26h',       v_failed_runs,
    'responses_seen_26h',    v_recent_seen,
    'non_200_26h',           v_recent_non_200,
    'awaiting_first_run',    (v_last_run is null),
    'problems',              to_jsonb(v_problems)
  );

  insert into public.api_service_health (service, status, consecutive_failures, last_success_at, last_failure_at, updated_at)
  values (
    'alert-cleanup-expired',
    v_status,
    case when v_status = 'healthy' then 0 else 1 end,
    case when v_status = 'healthy' then v_now else null end,
    case when v_status = 'healthy' then null else v_now end,
    v_now
  )
  on conflict (service) do update set
    status               = excluded.status,
    consecutive_failures = case when excluded.status = 'healthy'
                                then 0
                                else api_service_health.consecutive_failures + 1 end,
    last_success_at      = case when excluded.status = 'healthy' then v_now
                                else api_service_health.last_success_at end,
    last_failure_at      = case when excluded.status = 'healthy' then api_service_health.last_failure_at
                                else v_now end,
    updated_at           = v_now;

  -- One open alert at a time, same as the flush monitor.
  if v_status = 'healthy' then
    update public.api_alerts
       set resolved_at = v_now
     where kind = 'alert_cleanup_unhealthy'
       and resolved_at is null;
  else
    if not exists (
      select 1 from public.api_alerts
      where kind = 'alert_cleanup_unhealthy' and resolved_at is null
    ) then
      insert into public.api_alerts (id, severity, kind, service, message, details)
      values (
        'alrt_' || replace(gen_random_uuid()::text, '-', ''),
        v_severity,
        'alert_cleanup_unhealthy',
        'alert-cleanup-expired',
        'Scheduled alert cleanup is ' || v_status || ': ' || array_to_string(v_problems, '; '),
        v_summary
      );
    end if;
  end if;

  return v_summary;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.check_alert_flush_health()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'cron', 'net', 'pg_temp'
AS $function$
declare
  v_now               timestamptz := now();
  v_overdue           integer;
  v_oldest_overdue    timestamptz;
  v_last_run          timestamptz;
  v_cron_failures     integer;
  v_bad_http          integer := 0;
  v_reported_failures integer := 0;
  v_backlog_runs      integer := 0;
  v_status            text;
  v_severity          text;
  v_problems          text[] := '{}';
  v_summary           jsonb;
begin
  -- 1. The outcome check. Anything still pending well past its due time means
  --    the user is not getting alerts, regardless of what the logs claim.
  select count(*), min(scheduled_for)
    into v_overdue, v_oldest_overdue
  from public.alert_batches
  where status = 'pending'
    and scheduled_for < v_now - interval '5 minutes';

  -- 2. Is the scheduler even running?
  select max(d.start_time) into v_last_run
  from cron.job_run_details d
  join cron.job j on j.jobid = d.jobid
  where j.jobname = 'alert-flush-due';

  select count(*) into v_cron_failures
  from cron.job_run_details d
  join cron.job j on j.jobid = d.jobid
  where j.jobname = 'alert-flush-due'
    and d.start_time > v_now - interval '15 minutes'
    and d.status is distinct from 'succeeded';

  -- 3. What did the sweep itself report? A cron run "succeeds" as soon as it
  --    queues the HTTP call, so the job status alone proves nothing about
  --    delivery — the response body is where the truth is.
  select
    coalesce(count(*) filter (where r.status_code is distinct from 200), 0),
    coalesce(sum((public.try_jsonb(r.content) -> 'data' ->> 'failed')::integer), 0),
    coalesce(count(*) filter (where (public.try_jsonb(r.content) -> 'data' ->> 'more') = 'true'), 0)
  into v_bad_http, v_reported_failures, v_backlog_runs
  from net._http_response r
  where r.created > v_now - interval '15 minutes'
    and public.try_jsonb(r.content) -> 'data' ? 'scanned';

  -- ── verdict ───────────────────────────────────────────────────────────────
  if v_last_run is null or v_last_run < v_now - interval '5 minutes' then
    v_status := 'down';
    v_problems := v_problems || format('scheduler has not run since %s',
                                       coalesce(v_last_run::text, 'never'));
  end if;

  if v_overdue > 0 then
    v_status := 'down';
    v_problems := v_problems || format('%s batch(es) overdue, oldest scheduled for %s',
                                       v_overdue, v_oldest_overdue);
  end if;

  if v_status is null then
    if v_cron_failures > 0 then
      v_status := 'degraded';
      v_problems := v_problems || format('%s cron run(s) failed in the last 15 minutes', v_cron_failures);
    end if;
    if v_bad_http > 0 then
      v_status := 'degraded';
      v_problems := v_problems || format('%s non-200 response(s) from flush_due', v_bad_http);
    end if;
    if v_reported_failures > 0 then
      v_status := 'degraded';
      v_problems := v_problems || format('flush_due reported %s failed batch(es)', v_reported_failures);
    end if;
    if v_backlog_runs >= 3 then
      v_status := 'degraded';
      v_problems := v_problems || format('%s run(s) hit the per-run cap; backlog is growing', v_backlog_runs);
    end if;
  end if;

  v_status := coalesce(v_status, 'healthy');
  v_severity := case v_status when 'down' then 'critical' when 'degraded' then 'warning' end;

  v_summary := jsonb_build_object(
    'status',             v_status,
    'checked_at',         v_now,
    'overdue_batches',    v_overdue,
    'oldest_overdue',     v_oldest_overdue,
    'last_cron_run',      v_last_run,
    'cron_failures_15m',  v_cron_failures,
    'non_200_15m',        v_bad_http,
    'reported_failures_15m', v_reported_failures,
    'capped_runs_15m',    v_backlog_runs,
    'problems',           to_jsonb(v_problems)
  );

  -- ── record health ─────────────────────────────────────────────────────────
  insert into public.api_service_health (service, status, consecutive_failures, last_success_at, last_failure_at, updated_at)
  values (
    'alert-flush-due',
    v_status,
    case when v_status = 'healthy' then 0 else 1 end,
    case when v_status = 'healthy' then v_now else null end,
    case when v_status = 'healthy' then null else v_now end,
    v_now
  )
  on conflict (service) do update set
    status               = excluded.status,
    consecutive_failures = case when excluded.status = 'healthy'
                                then 0
                                else api_service_health.consecutive_failures + 1 end,
    last_success_at      = case when excluded.status = 'healthy' then v_now
                                else api_service_health.last_success_at end,
    last_failure_at      = case when excluded.status = 'healthy' then api_service_health.last_failure_at
                                else v_now end,
    updated_at           = v_now;

  -- ── raise or clear the alert ──────────────────────────────────────────────
  -- One open alert at a time. Re-firing every five minutes would bury the
  -- dashboard in duplicates of a problem someone is already looking at.
  if v_status = 'healthy' then
    update public.api_alerts
       set resolved_at = v_now
     where kind = 'alert_flush_unhealthy'
       and resolved_at is null;
  else
    if not exists (
      select 1 from public.api_alerts
      where kind = 'alert_flush_unhealthy' and resolved_at is null
    ) then
      insert into public.api_alerts (id, severity, kind, service, message, details)
      values (
        'alrt_' || replace(gen_random_uuid()::text, '-', ''),
        v_severity,
        'alert_flush_unhealthy',
        'alert-flush-due',
        'Scheduled alert delivery is ' || v_status || ': ' || array_to_string(v_problems, '; '),
        v_summary
      );
    end if;
  end if;

  return v_summary;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.fx_convert(p_from character, p_to character, p_amount_minor bigint)
 RETURNS TABLE(converted_minor bigint, rate numeric, as_of date, source text, stale boolean)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  with f as (select * from public.fx_latest where quote = upper(p_from)),
       t as (select * from public.fx_latest where quote = upper(p_to))
  select
    round(
      (p_amount_minor::numeric / power(10, f.minor_units))
      * (t.usd_rate / f.usd_rate)
      * power(10, t.minor_units)
    )::bigint                                   as converted_minor,
    round(t.usd_rate / f.usd_rate, 10)          as rate,
    least(f.as_of, t.as_of)                     as as_of,
    case when f.source = t.source then f.source
         else f.source || '+' || t.source end   as source,
    least(f.as_of, t.as_of) < current_date - 3  as stale
  from f, t;
$function$
;

CREATE OR REPLACE FUNCTION public.generate_prefixed_id(prefix text)
 RETURNS text
 LANGUAGE sql
 SET search_path TO 'pg_catalog', 'extensions'
AS $function$
  SELECT prefix || encode(gen_random_bytes(16), 'hex');
$function$
;

CREATE OR REPLACE FUNCTION public.handle_new_user()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  INSERT INTO public.profiles (id, email, name, avatar_url)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.raw_user_meta_data->>'name', ''),
    NEW.raw_user_meta_data->>'avatar_url'
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.itinerary_add_items(p_trip_id uuid, p_items jsonb, p_version_name text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_role text; v_tz text; e jsonb; v_ids uuid[] := '{}'; v_id uuid; v_date date; v_start timestamptz; v_end timestamptz; v_dur int; v_ver jsonb;
begin
  if auth.uid() is null then return jsonb_build_object('ok', false, 'code', 'UNAUTHORIZED'); end if;
  if not private.mfa_satisfied() then return jsonb_build_object('ok', false, 'code', 'MFA_REQUIRED'); end if;
  v_role := private.trip_edit_role(p_trip_id);
  if v_role is null or v_role not in ('owner', 'organizer', 'member') then return jsonb_build_object('ok', false, 'code', 'FORBIDDEN'); end if;
  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) = 0 or jsonb_array_length(p_items) > 150 then
    return jsonb_build_object('ok', false, 'code', 'BAD_ITEMS', 'message', 'Send 1 to 150 items.'); end if;
  select coalesce(nullif(primary_tz, ''), 'UTC') into v_tz from public.trips where id = p_trip_id for update;
  perform private.itinerary_ensure_baseline(p_trip_id);
  for e in select * from jsonb_array_elements(p_items) loop
    if coalesce(trim(e->>'title'), '') = '' or length(e->>'title') > 300 or coalesce(e->>'date', '') !~ '^\d{4}-\d{2}-\d{2}$'
       or (e ? 'time' and e->>'time' is not null and e->>'time' !~ '^\d{1,2}:\d{2}$')
       or (e ? 'end_time' and e->>'end_time' is not null and e->>'end_time' !~ '^\d{1,2}:\d{2}$') then
      raise exception using errcode = '22023', message = 'BAD_ITEM: ' || left(coalesce(e->>'title', '(no title)'), 80);
    end if;
    v_date := (e->>'date')::date;
    v_dur := case when (e->>'duration_min') ~ '^\d{1,4}$' and (e->>'duration_min')::int between 1 and 1440 then (e->>'duration_min')::int end;
    v_start := case when e->>'time' is not null then ((v_date + (e->>'time')::time)::timestamp at time zone v_tz) end;
    v_end := case when v_start is not null and e->>'end_time' is not null then ((v_date + (e->>'end_time')::time)::timestamp at time zone v_tz)
                  when v_start is not null and v_dur is not null then v_start + make_interval(mins => v_dur) end;
    if v_end is not null and v_end <= v_start then v_end := null; end if;
    insert into public.itinerary_items (trip_id, title, type, category, date, start_time, end_time, timezone, duration_min, location, notes, must_do, suggested)
    values (p_trip_id, left(trim(e->>'title'), 300), nullif(left(e->>'type', 40), ''), nullif(left(e->>'category', 40), ''), v_date, v_start, v_end, v_tz, v_dur,
            nullif(left(e->>'location', 300), ''), nullif(left(e->>'notes', 2000), ''), coalesce((e->>'must_do')::boolean, false), false)
    returning id into v_id;
    v_ids := v_ids || v_id;
  end loop;
  v_ver := private.itinerary_snapshot_version(p_trip_id, 'AI_GENERATED', coalesce(nullif(left(p_version_name, 120), ''), 'Added ' || cardinality(v_ids) || ' items'), array['Added ' || cardinality(v_ids) || ' items']);
  return jsonb_build_object('ok', true, 'inserted', cardinality(v_ids), 'item_ids', to_jsonb(v_ids)) || v_ver;
end $function$
;

CREATE OR REPLACE FUNCTION public.itinerary_delete_items(p_item_ids uuid[], p_version_name text DEFAULT 'Removed items'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_ids   uuid[];
  v_trips uuid[];
  v_trip  uuid;
  v_role  text;
  v_found int;
  v_del   int;
  v_ver   jsonb;
begin
  if auth.uid() is null then
    return jsonb_build_object('ok', false, 'code', 'UNAUTHORIZED');
  end if;
  if not private.mfa_satisfied() then
    return jsonb_build_object('ok', false, 'code', 'MFA_REQUIRED');
  end if;
  select coalesce(array_agg(distinct x), '{}') into v_ids from unnest(p_item_ids) x where x is not null;
  if cardinality(v_ids) = 0 or cardinality(v_ids) > 150 then
    return jsonb_build_object('ok', false, 'code', 'BAD_ITEMS', 'message', 'Send 1 to 150 item ids.');
  end if;

  select coalesce(array_agg(distinct trip_id), '{}') into v_trips
    from public.itinerary_items where id = any (v_ids);
  if cardinality(v_trips) = 0 then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  end if;
  if cardinality(v_trips) > 1 then
    return jsonb_build_object('ok', false, 'code', 'BAD_ITEMS', 'message', 'All items must be on the same trip.');
  end if;
  v_trip := v_trips[1];
  v_role := private.trip_edit_role(v_trip);
  if v_role is null then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  end if;
  if v_role not in ('owner', 'organizer', 'member') then
    return jsonb_build_object('ok', false, 'code', 'FORBIDDEN');
  end if;

  perform 1 from public.trips where id = v_trip for update;

  select count(*) into v_found from public.itinerary_items where id = any (v_ids) and trip_id = v_trip;
  if v_found <> cardinality(v_ids) then
    return jsonb_build_object('ok', false, 'code', 'BAD_ITEMS',
      'message', 'Some of these items no longer exist or are on another trip.');
  end if;

  perform private.itinerary_ensure_baseline(v_trip);

  delete from public.itinerary_items where id = any (v_ids) and trip_id = v_trip;
  get diagnostics v_del = row_count;

  v_ver := private.itinerary_snapshot_version(
    v_trip, 'USER_EDIT',
    coalesce(nullif(left(p_version_name, 120), ''), 'Removed items'),
    array['Removed ' || v_del || case when v_del = 1 then ' item' else ' items' end]);

  return jsonb_build_object('ok', true, 'deleted', v_del) || v_ver;
end $function$
;

CREATE OR REPLACE FUNCTION public.itinerary_restore_version(p_version_id uuid, p_expect_active uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_trip uuid; v_num int; v_snap jsonb; v_role text; v_active uuid; v_keep uuid[]; v_del int; v_up int := 0; e jsonb; r public.itinerary_items; v_ver jsonb;
begin
  if auth.uid() is null then return jsonb_build_object('ok', false, 'code', 'UNAUTHORIZED'); end if;
  if not private.mfa_satisfied() then return jsonb_build_object('ok', false, 'code', 'MFA_REQUIRED'); end if;
  select trip_id, version_number, itinerary_snapshot into v_trip, v_num, v_snap from public.itinerary_versions where id = p_version_id;
  if v_trip is null then return jsonb_build_object('ok', false, 'code', 'NOT_FOUND'); end if;
  v_role := private.trip_edit_role(v_trip);
  if v_role is null or v_role not in ('owner', 'organizer', 'member') then return jsonb_build_object('ok', false, 'code', 'NOT_FOUND'); end if;
  perform 1 from public.trips where id = v_trip for update;
  select id into v_active from public.itinerary_versions where trip_id = v_trip and is_active order by version_number desc limit 1;
  if p_expect_active is not null and v_active is distinct from p_expect_active then
    return jsonb_build_object('ok', false, 'code', 'STALE', 'message', 'The itinerary has changed since then, so this can''t be undone automatically.'); end if;
  if jsonb_typeof(v_snap) is distinct from 'array' or exists (select 1 from jsonb_array_elements(v_snap) x where jsonb_typeof(x) <> 'object' or not (x ? 'id') or not (x ? 'title') or x ? 'activities') then
    return jsonb_build_object('ok', false, 'code', 'LEGACY_SNAPSHOT', 'message', 'This older version was saved in a format that can''t be restored.'); end if;
  select coalesce(array_agg((x->>'id')::uuid), '{}') into v_keep from jsonb_array_elements(v_snap) x;
  delete from public.itinerary_items where trip_id = v_trip and not (id = any (v_keep));
  get diagnostics v_del = row_count;
  for e in select * from jsonb_array_elements(v_snap) loop
    r := jsonb_populate_record(null::public.itinerary_items, e);
    insert into public.itinerary_items (id, trip_id, title, type, category, status, date, start_time, end_time, timezone, duration_min, location, notes, country_code, transport_mode, party_size, place_id, lat, lng, windows, fixed, fixed_start, outdoor, must_do, starred, suggested, droppable, critical, hold_minutes, energy_cost, member_ids, cancellation, created_at, updated_at)
    values (r.id, v_trip, r.title, r.type, r.category, r.status, r.date, r.start_time, r.end_time, r.timezone, r.duration_min, r.location, r.notes, r.country_code, r.transport_mode, r.party_size, r.place_id, r.lat, r.lng, r.windows,
            coalesce(r.fixed, false), r.fixed_start, coalesce(r.outdoor, false), coalesce(r.must_do, false), coalesce(r.starred, false), coalesce(r.suggested, false), coalesce(r.droppable, true), coalesce(r.critical, false),
            r.hold_minutes, r.energy_cost, r.member_ids, r.cancellation, coalesce(r.created_at, now()), now())
    on conflict (id) do update set title = excluded.title, type = excluded.type, category = excluded.category, status = excluded.status, date = excluded.date, start_time = excluded.start_time, end_time = excluded.end_time,
      timezone = excluded.timezone, duration_min = excluded.duration_min, location = excluded.location, notes = excluded.notes, country_code = excluded.country_code, transport_mode = excluded.transport_mode,
      party_size = excluded.party_size, place_id = excluded.place_id, lat = excluded.lat, lng = excluded.lng, windows = excluded.windows, fixed = excluded.fixed, fixed_start = excluded.fixed_start,
      outdoor = excluded.outdoor, must_do = excluded.must_do, starred = excluded.starred, suggested = excluded.suggested, droppable = excluded.droppable, critical = excluded.critical,
      hold_minutes = excluded.hold_minutes, energy_cost = excluded.energy_cost, member_ids = excluded.member_ids, cancellation = excluded.cancellation, updated_at = now()
    where public.itinerary_items.trip_id = v_trip;
    v_up := v_up + 1;
  end loop;
  v_ver := private.itinerary_snapshot_version(v_trip, 'RESTORED_VERSION', 'Restored version ' || v_num, array['Restored version ' || v_num]);
  return jsonb_build_object('ok', true, 'restored_from', p_version_id, 'removed', v_del, 'restored', v_up) || v_ver;
end $function$
;

CREATE OR REPLACE FUNCTION public.itinerary_undo_change(p_version_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_parent uuid; v_trip uuid; v_role text;
begin
  if auth.uid() is null then return jsonb_build_object('ok', false, 'code', 'UNAUTHORIZED'); end if;
  select parent_version_id, trip_id into v_parent, v_trip from public.itinerary_versions where id = p_version_id;
  v_role := case when v_trip is not null then private.trip_edit_role(v_trip) end;
  if v_trip is null or v_role is null then return jsonb_build_object('ok', false, 'code', 'NOT_FOUND'); end if;
  if v_parent is null then return jsonb_build_object('ok', false, 'code', 'NO_PREVIOUS_VERSION', 'message', 'There is no earlier version to go back to.'); end if;
  return public.itinerary_restore_version(v_parent, p_version_id);
end $function$
;

CREATE OR REPLACE FUNCTION public.itinerary_update_item(p_item_id uuid, p_patch jsonb, p_version_name text DEFAULT 'Edited item'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_trip  uuid;
  v_role  text;
  v_tz    text;
  v_old   public.itinerary_items;
  v_bad   text;
  v_title text;
  v_date  date;
  v_time  time;
  v_dur   int;
  v_start timestamptz;
  v_end   timestamptz;
  v_otz   text;
  v_timing boolean;
  v_must  boolean;
  v_ver   jsonb;
begin
  if auth.uid() is null then
    return jsonb_build_object('ok', false, 'code', 'UNAUTHORIZED');
  end if;
  if not private.mfa_satisfied() then
    return jsonb_build_object('ok', false, 'code', 'MFA_REQUIRED');
  end if;
  select trip_id into v_trip from public.itinerary_items where id = p_item_id;
  if v_trip is null then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  end if;
  v_role := private.trip_edit_role(v_trip);
  if v_role is null then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  end if;
  if v_role not in ('owner', 'organizer', 'member') then
    return jsonb_build_object('ok', false, 'code', 'FORBIDDEN');
  end if;
  if jsonb_typeof(p_patch) is distinct from 'object' or p_patch = '{}'::jsonb then
    return jsonb_build_object('ok', false, 'code', 'BAD_ITEMS', 'message', 'Send at least one field to change.');
  end if;
  select string_agg(k, ', ') into v_bad from jsonb_object_keys(p_patch) k
   where k not in ('title', 'date', 'time', 'end_time', 'duration_min', 'location',
                   'category', 'type', 'notes', 'must_do');
  if v_bad is not null then
    return jsonb_build_object('ok', false, 'code', 'BAD_ITEMS', 'message', 'These fields can''t be edited: ' || v_bad);
  end if;

  select coalesce(nullif(primary_tz, ''), 'UTC') into v_tz from public.trips where id = v_trip for update;
  select * into v_old from public.itinerary_items where id = p_item_id and trip_id = v_trip for update;
  if v_old.id is null then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  end if;

  perform private.itinerary_ensure_baseline(v_trip);

  if (p_patch ? 'title' and (coalesce(trim(p_patch->>'title'), '') = '' or length(p_patch->>'title') > 300))
     or (p_patch ? 'date' and coalesce(p_patch->>'date', '') !~ '^\d{4}-\d{2}-\d{2}$')
     or (p_patch ? 'time' and p_patch->>'time' is not null and p_patch->>'time' !~ '^\d{1,2}:\d{2}$')
     or (p_patch ? 'end_time' and p_patch->>'end_time' is not null and p_patch->>'end_time' !~ '^\d{1,2}:\d{2}$')
     or (p_patch ? 'must_do' and jsonb_typeof(p_patch->'must_do') not in ('boolean', 'null')
         and coalesce(p_patch->>'must_do', '') !~* '^(true|false)$') then
    raise exception using errcode = '22023',
      message = 'BAD_ITEM: ' || left(coalesce(p_patch->>'title', v_old.title, '(no title)'), 80);
  end if;

  v_title := case when p_patch ? 'title' then left(trim(p_patch->>'title'), 300) else v_old.title end;
  v_must  := case when p_patch ? 'must_do' then coalesce((p_patch->>'must_do')::boolean, false) else v_old.must_do end;

  v_timing := p_patch ?| array['date', 'time', 'end_time', 'duration_min'];
  v_date  := v_old.date;
  v_start := v_old.start_time;
  v_end   := v_old.end_time;
  v_dur   := v_old.duration_min;
  v_otz   := coalesce(nullif(v_old.timezone, ''), v_tz);

  if v_timing then
    if p_patch ? 'date' then v_date := (p_patch->>'date')::date; end if;
    if p_patch ? 'duration_min' then
      v_dur := case when (p_patch->>'duration_min') ~ '^\d{1,4}$' and (p_patch->>'duration_min')::int between 1 and 1440
                    then (p_patch->>'duration_min')::int end;
    end if;
    v_time := case
                when p_patch ? 'time' then (p_patch->>'time')::time
                when v_old.start_time is not null then (v_old.start_time at time zone v_otz)::time
              end;
    if v_time is not null and v_date is null then
      raise exception using errcode = '22023', message = 'BAD_ITEM: ' || left(coalesce(v_title, '(no title)'), 80);
    end if;
    v_start := case when v_time is not null then ((v_date + v_time)::timestamp at time zone v_tz) end;
    v_end := case
               when v_start is null then null
               when p_patch->>'end_time' is not null
                 then ((v_date + (p_patch->>'end_time')::time)::timestamp at time zone v_tz)
               when (p_patch ? 'end_time' or p_patch ? 'duration_min')
                 then case when v_dur is not null then v_start + make_interval(mins => v_dur) end
               when v_old.start_time is not null and v_old.end_time is not null
                 then v_start + (v_old.end_time - v_old.start_time)
               when v_dur is not null
                 then v_start + make_interval(mins => v_dur)
             end;
    if v_end is not null and v_end <= v_start then v_end := null; end if;
  end if;

  update public.itinerary_items set
    title        = v_title,
    date         = v_date,
    start_time   = v_start,
    end_time     = v_end,
    duration_min = v_dur,
    timezone     = case when v_timing then v_tz else timezone end,
    location     = case when p_patch ? 'location' then nullif(left(p_patch->>'location', 300), '') else location end,
    category     = case when p_patch ? 'category' then nullif(left(p_patch->>'category', 40), '') else category end,
    type         = case when p_patch ? 'type'     then nullif(left(p_patch->>'type', 40), '')     else type end,
    notes        = case when p_patch ? 'notes'    then nullif(left(p_patch->>'notes', 2000), '')  else notes end,
    must_do      = v_must,
    updated_at   = now()
  where id = p_item_id and trip_id = v_trip;

  v_ver := private.itinerary_snapshot_version(
    v_trip, 'USER_EDIT',
    coalesce(nullif(left(p_version_name, 120), ''), 'Edited item'),
    array['Edited ' || left(coalesce(v_title, 'item'), 80)]);

  return jsonb_build_object('ok', true, 'item_id', p_item_id) || v_ver;
end $function$
;

CREATE OR REPLACE FUNCTION public.normalize_trip_tz()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_catalog'
AS $function$
declare
  v text := lower(btrim(coalesce(new.primary_tz, '')));
  v_alias text;
begin
  if v = '' then
    new.primary_tz := 'UTC';
    return new;
  end if;

  v_alias := case regexp_replace(v, '[\s_\-/]+', ' ', 'g')
    when 'us eastern' then 'America/New_York'   when 'eastern' then 'America/New_York'
    when 'est' then 'America/New_York'          when 'edt' then 'America/New_York'   when 'et' then 'America/New_York'
    when 'us central' then 'America/Chicago'    when 'central' then 'America/Chicago'
    when 'cst' then 'America/Chicago'           when 'cdt' then 'America/Chicago'    when 'ct' then 'America/Chicago'
    when 'us mountain' then 'America/Denver'    when 'mountain' then 'America/Denver'
    when 'mst' then 'America/Denver'            when 'mdt' then 'America/Denver'     when 'mt' then 'America/Denver'
    when 'us arizona' then 'America/Phoenix'    when 'arizona' then 'America/Phoenix'
    when 'us pacific' then 'America/Los_Angeles' when 'pacific' then 'America/Los_Angeles'
    when 'pst' then 'America/Los_Angeles'       when 'pdt' then 'America/Los_Angeles' when 'pt' then 'America/Los_Angeles'
    when 'us alaska' then 'America/Anchorage'   when 'alaska' then 'America/Anchorage'
    when 'us hawaii' then 'Pacific/Honolulu'    when 'hawaii' then 'Pacific/Honolulu' when 'hst' then 'Pacific/Honolulu'
    when 'gmt' then 'UTC'                       when 'utc' then 'UTC'                when 'z' then 'UTC'
    else null end;
  if v_alias is not null then
    new.primary_tz := v_alias;
    return new;
  end if;

  -- Accept any real zone name, fixing only its capitalization.
  select name into v_alias from pg_catalog.pg_timezone_names where lower(name) = v limit 1;
  if v_alias is not null then
    new.primary_tz := v_alias;
    return new;
  end if;

  raise exception 'Unknown time zone "%". Use a name like America/New_York or Europe/Lisbon.', new.primary_tz
    using errcode = '22023';
end $function$
;

CREATE OR REPLACE FUNCTION public.rate_limit_hit(p_bucket_key text, p_bucket_type text, p_limit integer, p_window_seconds integer)
 RETURNS TABLE(is_allowed boolean, hits integer, window_started_at timestamp with time zone, retry_after_seconds integer)
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_window_start timestamptz;
  v_window_end   timestamptz;
  v_now          timestamptz := now();
  v_count        integer;
begin
  if p_bucket_key is null or length(p_bucket_key) = 0 then
    raise exception 'p_bucket_key is required';
  end if;
  if p_window_seconds is null or p_window_seconds <= 0 then
    raise exception 'p_window_seconds must be positive';
  end if;
  if p_limit is null or p_limit < 0 then
    raise exception 'p_limit must be non-negative';
  end if;

  v_window_start := to_timestamp(
    floor(extract(epoch from v_now) / p_window_seconds) * p_window_seconds
  );
  v_window_end := v_window_start + make_interval(secs => p_window_seconds);

  -- Atomic: the count is incremented inside the same statement that inserts,
  -- so there is no read-then-write gap for a concurrent request to slip into.
  insert into public.rate_limit_buckets as b
    (id, bucket_key, bucket_type, window_start, window_end, request_count, created_at, updated_at)
  values
    (gen_random_uuid()::text, p_bucket_key, p_bucket_type, v_window_start, v_window_end, 1, v_now, v_now)
  on conflict (bucket_key, bucket_type, window_start) do update
    set request_count = b.request_count + 1,
        updated_at    = v_now
  returning b.request_count into v_count;

  return query select
    (v_count <= p_limit),
    v_count,
    v_window_start,
    greatest(0, ceil(extract(epoch from (v_window_end - v_now)))::integer);
end;
$function$
;

CREATE OR REPLACE FUNCTION public.replan_apply_atomic(p_trip_id uuid, p_base_version integer, p_ops jsonb, p_applied_id text, p_alternative_id text, p_applied_by text, p_undo_expires_at timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_current_version integer;
  v_tz              text;
  v_op              jsonb;
  v_kind            text;
  v_item_id_text    text;
  v_item_id         uuid;
  v_start           timestamptz;
  v_end             timestamptz;
  v_results         jsonb := '[]'::jsonb;
  v_ok_ops          jsonb := '[]'::jsonb;
  v_status          text;
  v_detail          text;
  v_bad             integer := 0;
  v_applied         integer := 0;
  v_removed         integer := 0;
  v_new_version     integer;
  v_uuid_re constant text :=
    '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
begin
  if p_trip_id is null or p_base_version is null then
    return jsonb_build_object(
      'applied', false, 'code', 'BAD_REQUEST',
      'detail', 'p_trip_id and p_base_version are required',
      'opResults', '[]'::jsonb);
  end if;

  if jsonb_typeof(p_ops) is distinct from 'array' then
    return jsonb_build_object(
      'applied', false, 'code', 'OPS_NOT_ARRAY',
      'detail', 'p_ops must be a JSON array',
      'opResults', '[]'::jsonb);
  end if;

  -- Serialise concurrent applies for this trip.
  select version, primary_tz
    into v_current_version, v_tz
    from public.trips
   where id = p_trip_id
   for update;

  if not found then
    return jsonb_build_object(
      'applied', false, 'code', 'TRIP_NOT_FOUND', 'opResults', '[]'::jsonb);
  end if;

  if v_current_version is distinct from p_base_version then
    return jsonb_build_object(
      'applied', false, 'code', 'VERSION_CONFLICT',
      'baseVersion', p_base_version,
      'currentVersion', v_current_version,
      'opResults', '[]'::jsonb);
  end if;

  -- ── PASS 1 — validate every op before writing anything ──────────────────
  for v_op in select value from jsonb_array_elements(p_ops)
  loop
    v_kind         := v_op->>'kind';
    v_item_id_text := v_op->>'itemId';
    v_status       := 'ok';
    v_detail       := null;

    if v_item_id_text is null or v_item_id_text !~ v_uuid_re then
      v_status := 'error';
      v_detail := 'op carried no usable itemId';
    elsif v_kind in ('move', 'add', 'update') then
      if (v_op->'after'->>'start') is null or (v_op->'after'->>'end') is null then
        v_status := 'error';
        v_detail := 'op carried no start/end, so there was nothing to write';
      end if;
    elsif v_kind = 'remove' then
      null;
    else
      v_status := 'error';
      v_detail := format('unsupported op kind "%s" — not applied', coalesce(v_kind, 'null'));
    end if;

    if v_status = 'ok' then
      v_item_id := v_item_id_text::uuid;
      perform 1 from public.itinerary_items
        where id = v_item_id and trip_id = p_trip_id;
      if not found then
        v_status := 'not_found';
        v_detail := 'no itinerary item with this id belongs to this trip';
      end if;
    end if;

    if v_status <> 'ok' then
      v_bad := v_bad + 1;
    end if;

    v_results := v_results || jsonb_build_array(jsonb_build_object(
      'itemId', v_item_id_text,
      'kind',   coalesce(v_kind, 'null'),
      'status', v_status,
      'detail', v_detail));
  end loop;

  if v_bad > 0 then
    return jsonb_build_object(
      'applied', false, 'code', 'OPS_INVALID',
      'baseVersion', p_base_version,
      'currentVersion', v_current_version,
      'appliedCount', 0,
      'failedCount', v_bad,
      'totalOps', jsonb_array_length(p_ops),
      'opResults', v_results);
  end if;

  -- ── PASS 2 — every op is applicable, so write them all ──────────────────
  for v_op in select value from jsonb_array_elements(p_ops)
  loop
    v_kind    := v_op->>'kind';
    v_item_id := (v_op->>'itemId')::uuid;

    if v_kind = 'remove' then
      delete from public.itinerary_items
       where id = v_item_id and trip_id = p_trip_id;
      v_removed := v_removed + 1;
    else
      v_start := (v_op->'after'->>'start')::timestamptz;
      v_end   := (v_op->'after'->>'end')::timestamptz;
      update public.itinerary_items
         set start_time = v_start,
             end_time   = v_end,
             date       = (v_start at time zone coalesce(v_tz, 'UTC'))::date,
             updated_at = now()
       where id = v_item_id and trip_id = p_trip_id;
    end if;

    v_applied := v_applied + 1;
    v_ok_ops  := v_ok_ops || jsonb_build_array(v_op);
  end loop;

  update public.trips
     set version = p_base_version + 1
   where id = p_trip_id
  returning version into v_new_version;

  if p_applied_id is not null then
    insert into public.replan_applied
      (id, trip_id, alternative_id, ops, base_version, applied_by, undo_expires_at)
    values
      (p_applied_id, p_trip_id, p_alternative_id, v_ok_ops, p_base_version,
       p_applied_by, p_undo_expires_at);
  end if;

  return jsonb_build_object(
    'applied', true,
    'code', null,
    'baseVersion', p_base_version,
    'newVersion', v_new_version,
    'appliedCount', v_applied,
    'removedCount', v_removed,
    'failedCount', 0,
    'totalOps', jsonb_array_length(p_ops),
    'opResults', v_results,
    'undoLogged', p_applied_id is not null);
end;
$function$
;

CREATE OR REPLACE FUNCTION public.touch_loyalty_aggregator_connections()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
  new.updated_at = now();
  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.try_jsonb(p text)
 RETURNS jsonb
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'pg_temp'
AS $function$
begin
  return p::jsonb;
exception when others then
  return null;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.update_alert_preferences_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$function$
;

CREATE OR REPLACE FUNCTION public.update_document_imports_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$function$
;

CREATE OR REPLACE FUNCTION public.update_email_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$function$
;

CREATE OR REPLACE FUNCTION public.update_monitoring_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$function$
;

CREATE OR REPLACE FUNCTION public.update_offline_packs_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$function$
;

CREATE OR REPLACE FUNCTION public.update_readiness_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$function$
;

CREATE OR REPLACE FUNCTION public.update_reservations_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$function$
;

CREATE OR REPLACE FUNCTION public.update_travel_alerts_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$function$
;

CREATE OR REPLACE FUNCTION public.update_trip_assemblies_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$function$
;

CREATE OR REPLACE FUNCTION public.update_trip_impacts_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$function$
;

CREATE OR REPLACE FUNCTION public.update_updated_at_column()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$function$
;

CREATE OR REPLACE FUNCTION public.update_vault_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$function$
;

CREATE OR REPLACE FUNCTION public.verify_cron_key(p_key text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'vault', 'extensions', 'pg_temp'
AS $function$
declare
  v_expected text;
  v_diff     integer;
  v_len      integer;
begin
  if p_key is null or length(p_key) = 0 then
    return false;
  end if;

  select decrypted_secret into v_expected
  from vault.decrypted_secrets
  where name = 'alert_flush_cron_key'
  limit 1;

  if v_expected is null then
    raise warning '[verify_cron_key] alert_flush_cron_key is not present in the vault';
    return false;
  end if;

  -- Length-independent comparison. Returning early on the first differing byte
  -- would leak the length and a little of the content through timing.
  v_len  := greatest(length(v_expected), length(p_key));
  v_diff := length(v_expected) # length(p_key);
  for i in 1..v_len loop
    v_diff := v_diff | (
      coalesce(ascii(substr(v_expected, i, 1)), 0) # coalesce(ascii(substr(p_key, i, 1)), 0)
    );
  end loop;

  return v_diff = 0;
end;
$function$
;

