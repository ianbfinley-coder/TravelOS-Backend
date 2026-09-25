


SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


CREATE EXTENSION IF NOT EXISTS "pg_cron" WITH SCHEMA "pg_catalog";






CREATE EXTENSION IF NOT EXISTS "pg_net" WITH SCHEMA "extensions";






CREATE SCHEMA IF NOT EXISTS "private";


ALTER SCHEMA "private" OWNER TO "postgres";


COMMENT ON SCHEMA "public" IS 'standard public schema';



CREATE EXTENSION IF NOT EXISTS "citext" WITH SCHEMA "public";






CREATE EXTENSION IF NOT EXISTS "pg_stat_statements" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "supabase_vault" WITH SCHEMA "vault";






CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA "extensions";






CREATE TYPE "public"."member_kind" AS ENUM (
    'account',
    'guest'
);


ALTER TYPE "public"."member_kind" OWNER TO "postgres";


CREATE TYPE "public"."member_role" AS ENUM (
    'owner',
    'organizer',
    'member',
    'viewer'
);


ALTER TYPE "public"."member_role" OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "private"."can_edit_trip"("p_trip_id" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select coalesce(private.trip_edit_role(p_trip_id) in ('owner', 'organizer', 'member'), false)
$$;


ALTER FUNCTION "private"."can_edit_trip"("p_trip_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "private"."current_platform_user_id"() RETURNS "text"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select ai.user_id
  from public.auth_identities ai
  where ai.provider_subject = auth.uid()::text
  limit 1
$$;


ALTER FUNCTION "private"."current_platform_user_id"() OWNER TO "postgres";


COMMENT ON FUNCTION "private"."current_platform_user_id"() IS 'Resolves the calling Supabase user to platform_users.id via auth_identities.provider_subject. Matches on provider_subject alone: the provider column varies by sign-in method (email/google/apple/email_link) and must not be filtered on. Lives in `private` so PostgREST does not expose it as an RPC.';



CREATE OR REPLACE FUNCTION "private"."guard_expense_roster"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
begin
  -- The mirror itself, or a cascade (trip / user deleted), may write.
  if current_setting('travelos.roster_sync', true) = 'on' or pg_trigger_depth() > 1 then
    return coalesce(new, old);
  end if;
  raise exception 'Expense groups follow the trip''s members. Add or remove people on the trip itself.'
    using errcode = 'P0001';
end $$;


ALTER FUNCTION "private"."guard_expense_roster"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "private"."is_trip_member"("p_trip_id" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select exists (
    select 1 from public.trip_members tm
    where tm.trip_id = p_trip_id
      and tm.user_id = private.current_platform_user_id()
      and tm.removed_at is null
  )
$$;


ALTER FUNCTION "private"."is_trip_member"("p_trip_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "private"."itinerary_ensure_baseline"("p_trip_id" "uuid") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
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
end $$;


ALTER FUNCTION "private"."itinerary_ensure_baseline"("p_trip_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "private"."itinerary_snapshot_version"("p_trip_id" "uuid", "p_method" "text", "p_name" "text", "p_summary" "text"[]) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
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
end $$;


ALTER FUNCTION "private"."itinerary_snapshot_version"("p_trip_id" "uuid", "p_method" "text", "p_name" "text", "p_summary" "text"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "private"."mfa_satisfied"() RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'public'
    AS $$
  select coalesce(auth.jwt()->>'aal', 'aal1') = 'aal2'
      or not exists (select 1 from auth.mfa_factors f
                     where f.user_id = auth.uid() and f.status = 'verified');
$$;


ALTER FUNCTION "private"."mfa_satisfied"() OWNER TO "postgres";


COMMENT ON FUNCTION "private"."mfa_satisfied"() IS 'True when the caller has no verified MFA factor, or the JWT is aal2. Used by the require_mfa_when_enrolled RESTRICTIVE policies (2026-09-24).';



CREATE OR REPLACE FUNCTION "private"."security_sentinel_run"() RETURNS "jsonb"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'pg_catalog', 'public'
    AS $_$
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
end $_$;


ALTER FUNCTION "private"."security_sentinel_run"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "private"."sentinel_alert"("p_severity" "text", "p_check" "text", "p_message" "text", "p_details" "jsonb") RETURNS "void"
    LANGUAGE "sql"
    SET "search_path" TO 'pg_catalog', 'public'
    AS $$
  insert into public.api_alerts (id, severity, kind, service, message, details)
  values (
    'alt_sec_' || substr(md5(random()::text || clock_timestamp()::text), 1, 20),
    p_severity, 'security_' || p_check, 'security-sentinel', p_message,
    p_details || jsonb_build_object('check', p_check, 'detected_at', now())
  );
$$;


ALTER FUNCTION "private"."sentinel_alert"("p_severity" "text", "p_check" "text", "p_message" "text", "p_details" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "private"."sentinel_diff"("p_key" "text", "p_items" "text"[], "p_severity" "text", "p_message" "text", "p_cumulative" boolean DEFAULT false, "p_alert_removed" boolean DEFAULT true) RETURNS integer
    LANGUAGE "plpgsql"
    SET "search_path" TO 'pg_catalog', 'public'
    AS $$
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
end $$;


ALTER FUNCTION "private"."sentinel_diff"("p_key" "text", "p_items" "text"[], "p_severity" "text", "p_message" "text", "p_cumulative" boolean, "p_alert_removed" boolean) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "private"."sync_trip_expense_group"("p_trip" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
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
end $$;


ALTER FUNCTION "private"."sync_trip_expense_group"("p_trip" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "private"."trip_edit_role"("p_trip_id" "uuid") RETURNS "text"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select tm.role::text from public.trip_members tm
   where tm.trip_id = p_trip_id and tm.user_id = private.current_platform_user_id() and tm.removed_at is null and tm.kind = 'account'
   order by case tm.role::text when 'owner' then 0 when 'organizer' then 1 when 'member' then 2 else 3 end limit 1
$$;


ALTER FUNCTION "private"."trip_edit_role"("p_trip_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "private"."trip_members_sync_expense_group"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
begin
  perform private.sync_trip_expense_group(coalesce(new.trip_id, old.trip_id));
  return null;
end $$;


ALTER FUNCTION "private"."trip_members_sync_expense_group"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."check_alert_cleanup_health"() RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'cron', 'net', 'pg_temp'
    AS $$
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
$$;


ALTER FUNCTION "public"."check_alert_cleanup_health"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."check_alert_flush_health"() RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'cron', 'net', 'pg_temp'
    AS $$
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
$$;


ALTER FUNCTION "public"."check_alert_flush_health"() OWNER TO "postgres";


COMMENT ON FUNCTION "public"."check_alert_flush_health"() IS 'Pure-SQL health check for the scheduled alert flush. Primary signal is overdue pending batches (an outcome), not log plumbing. Writes api_service_health and raises at most one open api_alerts row of kind alert_flush_unhealthy. Deliberately calls no edge function, because the edge function is one of the things that can be down.';



CREATE OR REPLACE FUNCTION "public"."fx_convert"("p_from" character, "p_to" character, "p_amount_minor" bigint) RETURNS TABLE("converted_minor" bigint, "rate" numeric, "as_of" "date", "source" "text", "stale" boolean)
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'public'
    AS $$
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
$$;


ALTER FUNCTION "public"."fx_convert"("p_from" character, "p_to" character, "p_amount_minor" bigint) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."generate_prefixed_id"("prefix" "text") RETURNS "text"
    LANGUAGE "sql"
    SET "search_path" TO 'pg_catalog', 'extensions'
    AS $$
  SELECT prefix || encode(gen_random_bytes(16), 'hex');
$$;


ALTER FUNCTION "public"."generate_prefixed_id"("prefix" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."handle_new_user"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
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
$$;


ALTER FUNCTION "public"."handle_new_user"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."itinerary_add_items"("p_trip_id" "uuid", "p_items" "jsonb", "p_version_name" "text" DEFAULT NULL::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $_$
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
end $_$;


ALTER FUNCTION "public"."itinerary_add_items"("p_trip_id" "uuid", "p_items" "jsonb", "p_version_name" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."itinerary_delete_items"("p_item_ids" "uuid"[], "p_version_name" "text" DEFAULT 'Removed items'::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
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
end $$;


ALTER FUNCTION "public"."itinerary_delete_items"("p_item_ids" "uuid"[], "p_version_name" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."itinerary_restore_version"("p_version_id" "uuid", "p_expect_active" "uuid" DEFAULT NULL::"uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
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
end $$;


ALTER FUNCTION "public"."itinerary_restore_version"("p_version_id" "uuid", "p_expect_active" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."itinerary_undo_change"("p_version_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare v_parent uuid; v_trip uuid; v_role text;
begin
  if auth.uid() is null then return jsonb_build_object('ok', false, 'code', 'UNAUTHORIZED'); end if;
  select parent_version_id, trip_id into v_parent, v_trip from public.itinerary_versions where id = p_version_id;
  v_role := case when v_trip is not null then private.trip_edit_role(v_trip) end;
  if v_trip is null or v_role is null then return jsonb_build_object('ok', false, 'code', 'NOT_FOUND'); end if;
  if v_parent is null then return jsonb_build_object('ok', false, 'code', 'NO_PREVIOUS_VERSION', 'message', 'There is no earlier version to go back to.'); end if;
  return public.itinerary_restore_version(v_parent, p_version_id);
end $$;


ALTER FUNCTION "public"."itinerary_undo_change"("p_version_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."itinerary_update_item"("p_item_id" "uuid", "p_patch" "jsonb", "p_version_name" "text" DEFAULT 'Edited item'::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $_$
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
end $_$;


ALTER FUNCTION "public"."itinerary_update_item"("p_item_id" "uuid", "p_patch" "jsonb", "p_version_name" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."normalize_trip_tz"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public', 'pg_catalog'
    AS $$
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
end $$;


ALTER FUNCTION "public"."normalize_trip_tz"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."rate_limit_hit"("p_bucket_key" "text", "p_bucket_type" "text", "p_limit" integer, "p_window_seconds" integer) RETURNS TABLE("is_allowed" boolean, "hits" integer, "window_started_at" timestamp with time zone, "retry_after_seconds" integer)
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
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
$$;


ALTER FUNCTION "public"."rate_limit_hit"("p_bucket_key" "text", "p_bucket_type" "text", "p_limit" integer, "p_window_seconds" integer) OWNER TO "postgres";


COMMENT ON FUNCTION "public"."rate_limit_hit"("p_bucket_key" "text", "p_bucket_type" "text", "p_limit" integer, "p_window_seconds" integer) IS 'Atomically records one request against a fixed window bucket and reports whether it is within p_limit. p_bucket_type MUST be one of global | strict | user_quota — rate_limit_buckets_bucket_type_check rejects anything else, and the caller that this function replaced passed the literal ''api'', which would have failed even after its column-name bug was fixed. Callers must treat a NULL or error result as a limiter failure and log it: failing open silently is the defect this replaced.';



CREATE OR REPLACE FUNCTION "public"."replan_apply_atomic"("p_trip_id" "uuid", "p_base_version" integer, "p_ops" "jsonb", "p_applied_id" "text", "p_alternative_id" "text", "p_applied_by" "text", "p_undo_expires_at" timestamp with time zone) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $_$
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
$_$;


ALTER FUNCTION "public"."replan_apply_atomic"("p_trip_id" "uuid", "p_base_version" integer, "p_ops" "jsonb", "p_applied_id" "text", "p_alternative_id" "text", "p_applied_by" "text", "p_undo_expires_at" timestamp with time zone) OWNER TO "postgres";


COMMENT ON FUNCTION "public"."replan_apply_atomic"("p_trip_id" "uuid", "p_base_version" integer, "p_ops" "jsonb", "p_applied_id" "text", "p_alternative_id" "text", "p_applied_by" "text", "p_undo_expires_at" timestamp with time zone) IS 'Q2.32 — applies a whole replan op list in one transaction: row-locks the trip, checks baseVersion, validates every op, then writes, bumps trips.version and logs to replan_applied. All-or-nothing. service_role only.';



CREATE OR REPLACE FUNCTION "public"."touch_loyalty_aggregator_connections"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
begin
  new.updated_at = now();
  return new;
end;
$$;


ALTER FUNCTION "public"."touch_loyalty_aggregator_connections"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."try_jsonb"("p" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" IMMUTABLE
    SET "search_path" TO 'pg_temp'
    AS $$
begin
  return p::jsonb;
exception when others then
  return null;
end;
$$;


ALTER FUNCTION "public"."try_jsonb"("p" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_alert_preferences_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;


ALTER FUNCTION "public"."update_alert_preferences_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_document_imports_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;


ALTER FUNCTION "public"."update_document_imports_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_email_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;


ALTER FUNCTION "public"."update_email_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_monitoring_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;


ALTER FUNCTION "public"."update_monitoring_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_offline_packs_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;


ALTER FUNCTION "public"."update_offline_packs_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_readiness_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;


ALTER FUNCTION "public"."update_readiness_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_reservations_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;


ALTER FUNCTION "public"."update_reservations_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_travel_alerts_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;


ALTER FUNCTION "public"."update_travel_alerts_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_trip_assemblies_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;


ALTER FUNCTION "public"."update_trip_assemblies_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_trip_impacts_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;


ALTER FUNCTION "public"."update_trip_impacts_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_updated_at_column"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;


ALTER FUNCTION "public"."update_updated_at_column"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_vault_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;


ALTER FUNCTION "public"."update_vault_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."verify_cron_key"("p_key" "text") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'vault', 'extensions', 'pg_temp'
    AS $$
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
$$;


ALTER FUNCTION "public"."verify_cron_key"("p_key" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."verify_cron_key"("p_key" "text") IS 'Returns true when the supplied key matches the alert_flush_cron_key vault secret. Returns a boolean only — the secret itself is never returned, so a caller that can execute this cannot read it.';


SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "private"."archived_generated_itineraries" (
    "id" "uuid",
    "trip_id" "uuid",
    "user_id" "uuid",
    "planning_session_id" "uuid",
    "version" integer,
    "is_active" boolean,
    "status" "text",
    "preferences_snapshot" "jsonb",
    "itinerary" "jsonb",
    "trip_summary" "jsonb",
    "regeneration_reason" "text",
    "error_message" "text",
    "created_at" timestamp with time zone,
    "updated_at" timestamp with time zone,
    "validation_status" "text",
    "validation_report" "jsonb",
    "validated_at" timestamp with time zone,
    "geo_status" "text",
    "geo_report" "jsonb",
    "geo_optimized_at" timestamp with time zone,
    "pace_status" "text",
    "pace_report" "jsonb",
    "pace_analyzed_at" timestamp with time zone,
    "version_id" "uuid",
    "archived_at" timestamp with time zone
);


ALTER TABLE "private"."archived_generated_itineraries" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "private"."sentinel_meta" (
    "k" "text" NOT NULL,
    "v" "text" NOT NULL
);


ALTER TABLE "private"."sentinel_meta" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "private"."sentinel_state" (
    "check_key" "text" NOT NULL,
    "items" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "private"."sentinel_state" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "private"."sentinel_table_stats" (
    "relid" "oid" NOT NULL,
    "relname" "text" NOT NULL,
    "n_tup_del" bigint NOT NULL,
    "n_live" bigint NOT NULL,
    "sampled_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "private"."sentinel_table_stats" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."account_deletion_requests" (
    "id" "text" NOT NULL,
    "user_id" "text" NOT NULL,
    "requested_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "grace_ends_at" timestamp with time zone NOT NULL,
    "cancelled_at" timestamp with time zone,
    "completed_at" timestamp with time zone,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    CONSTRAINT "account_deletion_requests_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'cancelled'::"text", 'completed'::"text"])))
);


ALTER TABLE "public"."account_deletion_requests" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."activity_events" (
    "id" "text" NOT NULL,
    "trip_id" "uuid" NOT NULL,
    "at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "actor_member_id" "text" NOT NULL,
    "verb" "text" NOT NULL,
    "target_type" "text" NOT NULL,
    "target_id" "text" NOT NULL,
    "target_title" "text" NOT NULL,
    "summary" "text" NOT NULL,
    "group_key" "text",
    "visible_to" "text" DEFAULT 'all'::"text" NOT NULL,
    CONSTRAINT "activity_events_verb_check" CHECK (("verb" = ANY (ARRAY['added'::"text", 'moved'::"text", 'edited'::"text", 'removed'::"text", 'commented'::"text", 'voted'::"text", 'decided'::"text", 'booked'::"text", 'paid'::"text", 'joined'::"text", 'left'::"text", 'restored'::"text", 'proposed'::"text", 'approved'::"text", 'rejected'::"text"]))),
    CONSTRAINT "activity_events_visible_to_check" CHECK (("visible_to" = ANY (ARRAY['all'::"text", 'members_only'::"text"])))
);


ALTER TABLE "public"."activity_events" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."activity_read_markers" (
    "trip_id" "uuid" NOT NULL,
    "member_id" "text" NOT NULL,
    "last_read_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."activity_read_markers" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."agent_metrics" (
    "id" bigint NOT NULL,
    "agent_name" character varying(255) NOT NULL,
    "execution_timestamp" timestamp with time zone NOT NULL,
    "metrics" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."agent_metrics" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."agent_metrics_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."agent_metrics_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."agent_metrics_id_seq" OWNED BY "public"."agent_metrics"."id";



CREATE TABLE IF NOT EXISTS "public"."agreement_completions" (
    "trip_id" "uuid" NOT NULL,
    "member_id" "text" NOT NULL,
    "completed_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "question_count" integer DEFAULT 0 NOT NULL
);


ALTER TABLE "public"."agreement_completions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."agreement_questionnaires" (
    "trip_id" "uuid" NOT NULL,
    "question_ids" "text"[] DEFAULT ARRAY['pace.wake_time'::"text", 'pace.bedtime'::"text", 'pace.activities_per_day'::"text", 'pace.walking_km'::"text", 'pace.downtime'::"text", 'must_dos.must_dos'::"text", 'must_dos.rather_skip'::"text", 'must_dos.interests'::"text", 'together.togetherness'::"text", 'together.skip_ok'::"text", 'rooms.room_sharing'::"text", 'rooms.light_sleeper'::"text", 'money.shared_meals'::"text", 'money.drinks'::"text", 'money.deposit'::"text", 'decisions.decision_style'::"text", 'dropout.dropout_rule'::"text", 'food.dietary'::"text", 'food.adventurousness'::"text", 'comms.social_media'::"text", 'comms.chat_intensity'::"text", 'access.accessibility'::"text"] NOT NULL,
    "custom_questions" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "deadline" "date",
    "status" "text" DEFAULT 'draft'::"text" NOT NULL,
    "version" integer DEFAULT 1 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "agreement_questionnaires_status_check" CHECK (("status" = ANY (ARRAY['draft'::"text", 'open'::"text", 'closed'::"text"])))
);


ALTER TABLE "public"."agreement_questionnaires" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."agreement_responses" (
    "trip_id" "uuid" NOT NULL,
    "member_id" "text" NOT NULL,
    "question_id" "text" NOT NULL,
    "value_enc" "text" NOT NULL,
    "visibility" "text" NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "agreement_responses_visibility_check" CHECK (("visibility" = ANY (ARRAY['shared'::"text", 'aggregate'::"text", 'private'::"text"])))
);


ALTER TABLE "public"."agreement_responses" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."airline_loyalty_cache" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "program" "text" NOT NULL,
    "data" "jsonb" NOT NULL,
    "expires_at" timestamp with time zone NOT NULL,
    "stale" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "airline_loyalty_cache_program_check" CHECK (("program" = ANY (ARRAY['united'::"text", 'delta'::"text"])))
);


ALTER TABLE "public"."airline_loyalty_cache" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."alert_batches" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "trip_id" "uuid",
    "theme" "text" DEFAULT 'mixed'::"text" NOT NULL,
    "summary" "text" NOT NULL,
    "alert_ids" "uuid"[] DEFAULT '{}'::"uuid"[] NOT NULL,
    "alert_count" integer DEFAULT 0 NOT NULL,
    "max_priority" "text" DEFAULT 'LOW'::"text" NOT NULL,
    "delivery_channels" "text"[] DEFAULT ARRAY['inapp'::"text", 'dashboard'::"text"] NOT NULL,
    "scheduled_for" timestamp with time zone DEFAULT "now"() NOT NULL,
    "delivered_at" timestamp with time zone,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "retry_count" integer DEFAULT 0 NOT NULL,
    "last_error" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "alert_batches_max_priority_check" CHECK (("max_priority" = ANY (ARRAY['CRITICAL'::"text", 'HIGH'::"text", 'MEDIUM'::"text", 'LOW'::"text", 'INFO'::"text"]))),
    CONSTRAINT "alert_batches_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'processing'::"text", 'delivered'::"text", 'failed'::"text", 'cancelled'::"text"]))),
    CONSTRAINT "alert_batches_theme_check" CHECK (("theme" = ANY (ARRAY['health'::"text", 'friction'::"text", 'bookings'::"text", 'disruptions'::"text", 'reminders'::"text", 'suggestions'::"text", 'mixed'::"text"])))
);


ALTER TABLE "public"."alert_batches" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."alert_dedup_log" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "fingerprint" "text" NOT NULL,
    "alert_id" "uuid",
    "priority" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "expires_at" timestamp with time zone DEFAULT ("now"() + '00:05:00'::interval) NOT NULL
);


ALTER TABLE "public"."alert_dedup_log" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."alert_delivery_log" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "alert_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "channel" "text" NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "scheduled_at" timestamp with time zone,
    "sent_at" timestamp with time zone,
    "failure_reason" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "alert_delivery_log_channel_check" CHECK (("channel" = ANY (ARRAY['push'::"text", 'email'::"text", 'sms'::"text", 'inapp'::"text", 'dashboard'::"text"]))),
    CONSTRAINT "alert_delivery_log_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'sent'::"text", 'failed'::"text", 'skipped_dnd'::"text", 'skipped_prefs'::"text"])))
);


ALTER TABLE "public"."alert_delivery_log" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."alert_preferences" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "trip_id" "uuid",
    "sensitivity" "text" DEFAULT 'BALANCED'::"text" NOT NULL,
    "minimum_priority" "text" DEFAULT 'LOW'::"text" NOT NULL,
    "minimum_urgency" "text" DEFAULT 'NOT_URGENT'::"text",
    "informational_alerts_enabled" boolean DEFAULT true NOT NULL,
    "critical_alerts_enabled" boolean DEFAULT true NOT NULL,
    "enabled_alert_types" "text"[],
    "quiet_period_enabled" boolean DEFAULT false NOT NULL,
    "quiet_period_start" time without time zone,
    "quiet_period_end" time without time zone,
    "quiet_period_timezone" "text" DEFAULT 'UTC'::"text",
    "push_enabled" boolean DEFAULT false NOT NULL,
    "sms_enabled" boolean DEFAULT false NOT NULL,
    "email_enabled" boolean DEFAULT false NOT NULL,
    "in_app_enabled" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "alert_preferences_minimum_priority_check" CHECK (("minimum_priority" = ANY (ARRAY['INFO'::"text", 'LOW'::"text", 'HIGH'::"text", 'CRITICAL'::"text"]))),
    CONSTRAINT "alert_preferences_minimum_urgency_check" CHECK (("minimum_urgency" = ANY (ARRAY['NOT_URGENT'::"text", 'SOON'::"text", 'TIME_SENSITIVE'::"text", 'IMMEDIATE'::"text", 'UNKNOWN'::"text"]))),
    CONSTRAINT "alert_preferences_sensitivity_check" CHECK (("sensitivity" = ANY (ARRAY['MINIMAL'::"text", 'BALANCED'::"text", 'DETAILED'::"text"])))
);


ALTER TABLE "public"."alert_preferences" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."alert_preferences_v2" (
    "id" bigint NOT NULL,
    "user_id" "text" NOT NULL,
    "trip_id" "uuid",
    "kind" "text" NOT NULL,
    "push_enabled" boolean DEFAULT true NOT NULL,
    "email_enabled" boolean DEFAULT false NOT NULL,
    "in_app_enabled" boolean DEFAULT true NOT NULL,
    "filter_params" "jsonb",
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."alert_preferences_v2" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."alert_preferences_v2_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."alert_preferences_v2_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."alert_preferences_v2_id_seq" OWNED BY "public"."alert_preferences_v2"."id";



CREATE TABLE IF NOT EXISTS "public"."alert_queue_stats" (
    "user_id" "uuid" NOT NULL,
    "total_queued" integer DEFAULT 0 NOT NULL,
    "total_delivered" integer DEFAULT 0 NOT NULL,
    "total_deduplicated" integer DEFAULT 0 NOT NULL,
    "total_rate_limited" integer DEFAULT 0 NOT NULL,
    "total_failed" integer DEFAULT 0 NOT NULL,
    "last_flush_at" timestamp with time zone,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."alert_queue_stats" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."alert_rate_counters" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "window_start" timestamp with time zone NOT NULL,
    "window_type" "text" NOT NULL,
    "alert_count" integer DEFAULT 0 NOT NULL,
    "critical_count" integer DEFAULT 0 NOT NULL,
    "last_alert_at" timestamp with time zone,
    CONSTRAINT "alert_rate_counters_window_type_check" CHECK (("window_type" = ANY (ARRAY['hourly'::"text", 'daily'::"text"])))
);


ALTER TABLE "public"."alert_rate_counters" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."alignment_reports" (
    "trip_id" "uuid" NOT NULL,
    "report" "jsonb" NOT NULL,
    "respondent_count" integer DEFAULT 0 NOT NULL,
    "computed_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."alignment_reports" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."api_alerts" (
    "id" "text" NOT NULL,
    "severity" "text" NOT NULL,
    "kind" "text" NOT NULL,
    "service" "text",
    "message" "text" NOT NULL,
    "details" "jsonb",
    "acknowledged_at" timestamp with time zone,
    "resolved_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "notified_at" timestamp with time zone,
    CONSTRAINT "api_alerts_severity_check" CHECK (("severity" = ANY (ARRAY['critical'::"text", 'warning'::"text", 'info'::"text"])))
);


ALTER TABLE "public"."api_alerts" OWNER TO "postgres";


COMMENT ON COLUMN "public"."api_alerts"."notified_at" IS 'Set only after the alert has actually been accepted by the mail provider. Null means it has not been sent.';



CREATE TABLE IF NOT EXISTS "public"."api_cache_entries" (
    "cache_key" "text" NOT NULL,
    "service" "text" NOT NULL,
    "endpoint" "text" NOT NULL,
    "params_hash" "text" NOT NULL,
    "response_data" "jsonb" NOT NULL,
    "hit_count" integer DEFAULT 0 NOT NULL,
    "miss_count" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "expires_at" timestamp with time zone NOT NULL,
    "last_hit_at" timestamp with time zone
);


ALTER TABLE "public"."api_cache_entries" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."api_cost_daily" (
    "id" "text" NOT NULL,
    "service" "text" NOT NULL,
    "date" "date" NOT NULL,
    "total_calls" integer DEFAULT 0 NOT NULL,
    "cache_hits" integer DEFAULT 0 NOT NULL,
    "total_cost_usd" numeric(10,4) DEFAULT 0 NOT NULL,
    "error_count" integer DEFAULT 0 NOT NULL,
    "avg_duration_ms" integer
);


ALTER TABLE "public"."api_cost_daily" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."api_cost_log" (
    "id" "text" NOT NULL,
    "service" "text" NOT NULL,
    "endpoint" "text" NOT NULL,
    "user_id" "text",
    "ip_address" "text",
    "cost_usd" numeric(10,6) DEFAULT 0 NOT NULL,
    "response_status" integer,
    "cache_hit" boolean DEFAULT false NOT NULL,
    "error_kind" "text",
    "duration_ms" integer,
    "called_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."api_cost_log" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."api_service_health" (
    "service" "text" NOT NULL,
    "consecutive_failures" integer DEFAULT 0 NOT NULL,
    "last_failure_at" timestamp with time zone,
    "last_success_at" timestamp with time zone,
    "status" "text" DEFAULT 'unknown'::"text" NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "api_service_health_status_check" CHECK (("status" = ANY (ARRAY['healthy'::"text", 'degraded'::"text", 'down'::"text", 'unknown'::"text"])))
);


ALTER TABLE "public"."api_service_health" OWNER TO "postgres";


COMMENT ON TABLE "public"."api_service_health" IS 'One row per monitored service, written only by something that actually performed a check. Rows with status=unknown and null timestamps have no monitor; see Q2.21 in TRAVELOS_BUILD_QUEUE.md.';



COMMENT ON COLUMN "public"."api_service_health"."status" IS 'healthy | degraded | down | unknown. "unknown" means no check has ever run for this service — it is NOT a synonym for healthy, and a row that has never been written by a monitor must stay unknown.';



CREATE TABLE IF NOT EXISTS "public"."audit_log" (
    "id" "text" NOT NULL,
    "trip_id" "uuid",
    "actor_member_id" "text",
    "actor_user_id" "text",
    "action" "text" NOT NULL,
    "entity_type" "text" NOT NULL,
    "entity_id" "text" NOT NULL,
    "before" "jsonb",
    "after" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."audit_log" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."auth_identities" (
    "id" "text" NOT NULL,
    "user_id" "text" NOT NULL,
    "provider" "text" NOT NULL,
    "provider_subject" "text" NOT NULL
);


ALTER TABLE "public"."auth_identities" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."availability_snapshots" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "reservation_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "platform_id" "text",
    "snapshot_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "status" "text" NOT NULL,
    "rooms_remaining" integer,
    "availability_pct" numeric(5,2),
    "notes" "text",
    "raw_response" "jsonb",
    CONSTRAINT "availability_snapshots_status_check" CHECK (("status" = ANY (ARRAY['AVAILABLE'::"text", 'LIMITED'::"text", 'UNAVAILABLE'::"text", 'UNKNOWN'::"text"])))
);


ALTER TABLE "public"."availability_snapshots" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."ballots_v2" (
    "poll_id" "text" NOT NULL,
    "member_id" "text" NOT NULL,
    "payload" "jsonb" NOT NULL,
    "abstain" boolean DEFAULT false NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."ballots_v2" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."bargain_norms" (
    "id" "text" DEFAULT ("gen_random_uuid"())::"text" NOT NULL,
    "country_code" character(2) NOT NULL,
    "context" "text" NOT NULL,
    "norm" "text" NOT NULL,
    "tip" "text" NOT NULL,
    "source" "text" NOT NULL,
    "verified_at" "date" NOT NULL,
    CONSTRAINT "bargain_norms_context_check" CHECK (("context" = ANY (ARRAY['market'::"text", 'taxi_no_meter'::"text", 'street_vendor'::"text", 'hotel_walkin'::"text", 'souvenir_shop'::"text", 'tour_operator'::"text", 'restaurant'::"text"]))),
    CONSTRAINT "bargain_norms_norm_check" CHECK (("norm" = ANY (ARRAY['customary'::"text", 'sometimes'::"text", 'not_done'::"text"])))
);


ALTER TABLE "public"."bargain_norms" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."better_deals" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "reservation_id" "text" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "platform" "text" NOT NULL,
    "savings" numeric(10,2) DEFAULT 0 NOT NULL,
    "savings_pct" numeric(5,2) DEFAULT 0 NOT NULL,
    "total_price" numeric(10,2) NOT NULL,
    "currency" "text" DEFAULT 'USD'::"text" NOT NULL,
    "free_cancellation" boolean DEFAULT false NOT NULL,
    "url" "text",
    "detected_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "expires_at" timestamp with time zone DEFAULT ("now"() + '24:00:00'::interval) NOT NULL,
    "dismissed" boolean DEFAULT false NOT NULL
);


ALTER TABLE "public"."better_deals" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."booking_conflicts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "reservation_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "conflict_type" "text" NOT NULL,
    "local_data" "jsonb",
    "external_data" "jsonb",
    "resolution" "text",
    "resolved_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "booking_conflicts_conflict_type_check" CHECK (("conflict_type" = ANY (ARRAY['STATUS_MISMATCH'::"text", 'PRICE_MISMATCH'::"text", 'CONFIRMATION_MISMATCH'::"text", 'AVAILABILITY_RISK'::"text", 'OVERBOOKING_RISK'::"text", 'CANCELLATION_RISK'::"text"]))),
    CONSTRAINT "booking_conflicts_resolution_check" CHECK (("resolution" = ANY (ARRAY['ACCEPT_EXTERNAL'::"text", 'KEEP_LOCAL'::"text", 'MANUAL_REVIEW'::"text", 'PENDING'::"text"])))
);


ALTER TABLE "public"."booking_conflicts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."booking_connections" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "platform_id" "text" NOT NULL,
    "status" "text" DEFAULT 'CONNECTED'::"text" NOT NULL,
    "display_name" "text",
    "access_token" "text",
    "refresh_token" "text",
    "token_expires_at" timestamp with time zone,
    "scope" "text",
    "connected_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "last_synced_at" timestamp with time zone,
    "error_message" "text",
    CONSTRAINT "booking_connections_status_check" CHECK (("status" = ANY (ARRAY['CONNECTED'::"text", 'DISCONNECTED'::"text", 'ERROR'::"text"])))
);


ALTER TABLE "public"."booking_connections" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."booking_platforms" (
    "id" "text" NOT NULL,
    "name" "text" NOT NULL,
    "auth_method" "text" NOT NULL,
    "api_base_url" "text",
    "webhook_support" boolean DEFAULT false NOT NULL,
    "rate_limit_per_hour" integer DEFAULT 500,
    "rate_limit_per_day" integer DEFAULT 5000,
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "display_name" "text" NOT NULL,
    "authorization_url" "text",
    "token_url" "text",
    "scopes" "text",
    "logo_url" "text",
    CONSTRAINT "booking_platforms_auth_method_check" CHECK (("auth_method" = ANY (ARRAY['oauth2'::"text", 'api_key'::"text", 'web_scrape'::"text", 'partner_api'::"text", 'OAuth2'::"text", 'API Key'::"text", 'Polling'::"text"])))
);


ALTER TABLE "public"."booking_platforms" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."booking_reservations" (
    "id" "text" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "trip_id" "uuid",
    "provider" "text" NOT NULL,
    "provider_id" "text" NOT NULL,
    "type" "text" DEFAULT 'hotel'::"text" NOT NULL,
    "name" "text" NOT NULL,
    "location" "text",
    "check_in" timestamp with time zone NOT NULL,
    "check_out" timestamp with time zone NOT NULL,
    "status" "text" DEFAULT 'confirmed'::"text" NOT NULL,
    "total_price" numeric(10,2) DEFAULT 0 NOT NULL,
    "currency" "text" DEFAULT 'USD'::"text" NOT NULL,
    "guests" integer DEFAULT 1 NOT NULL,
    "confirmation_number" "text",
    "notes" "text",
    "raw_data" "jsonb",
    "last_updated" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "booking_reservations_status_check" CHECK (("status" = ANY (ARRAY['confirmed'::"text", 'pending'::"text", 'cancelled'::"text"]))),
    CONSTRAINT "booking_reservations_type_check" CHECK (("type" = ANY (ARRAY['hotel'::"text", 'flight'::"text", 'rental-car'::"text", 'experience'::"text"])))
);


ALTER TABLE "public"."booking_reservations" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."budget_aggregates" (
    "trip_id" "uuid" NOT NULL,
    "respondent_count" integer DEFAULT 0 NOT NULL,
    "band" "jsonb",
    "computed_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."budget_aggregates" OWNER TO "postgres";


COMMENT ON TABLE "public"."budget_aggregates" IS 'Per-trip budget band. Readable only by trip members; amounts are additionally privacy-gated by budget-preferences /band, which is the only supported read path for clients.';



CREATE TABLE IF NOT EXISTS "public"."budget_analyses" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "trip_id" "uuid" NOT NULL,
    "itinerary_id" "uuid",
    "user_id" "uuid" NOT NULL,
    "status" "text" DEFAULT 'analyzing'::"text" NOT NULL,
    "total_budget" numeric,
    "currency" "text" DEFAULT 'USD'::"text",
    "confirmed_cost" numeric,
    "estimated_cost" numeric,
    "total_projected_cost" numeric,
    "cost_per_traveler" numeric,
    "average_daily_cost" numeric,
    "remaining_budget" numeric,
    "cost_by_category" "jsonb",
    "daily_analysis" "jsonb",
    "cost_drivers" "jsonb",
    "budget_status" "text",
    "savings_opportunities" "jsonb",
    "budget_scenarios" "jsonb",
    "hidden_costs" "jsonb",
    "user_summary" "jsonb",
    "preferences_snapshot" "jsonb",
    "analyzed_at" timestamp with time zone DEFAULT "now"(),
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."budget_analyses" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."budget_notification_queue" (
    "trip_id" "uuid" NOT NULL,
    "queued_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "scheduled_for" timestamp with time zone NOT NULL,
    "sent_at" timestamp with time zone
);


ALTER TABLE "public"."budget_notification_queue" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."budget_preferences" (
    "trip_id" "uuid" NOT NULL,
    "member_id" "text" NOT NULL,
    "ciphertext" "text" NOT NULL,
    "key_id" "text" DEFAULT 'v1'::"text" NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."budget_preferences" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."cache_stats" (
    "id" bigint NOT NULL,
    "cache_key" character varying(500),
    "cache_hits" integer DEFAULT 0,
    "cache_misses" integer DEFAULT 0,
    "ttl_seconds" integer,
    "last_hit_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."cache_stats" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."cache_stats_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."cache_stats_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."cache_stats_id_seq" OWNED BY "public"."cache_stats"."id";



CREATE TABLE IF NOT EXISTS "public"."calendar_connections" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "provider" "text" NOT NULL,
    "provider_calendar_id" "text",
    "provider_email" "text",
    "access_token" "text",
    "refresh_token" "text",
    "token_expires_at" timestamp with time zone,
    "sync_direction" "text" DEFAULT 'push-only'::"text" NOT NULL,
    "conflict_resolution" "text" DEFAULT 'manual'::"text" NOT NULL,
    "last_sync_at" timestamp with time zone,
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "calendar_connections_conflict_resolution_check" CHECK (("conflict_resolution" = ANY (ARRAY['local-wins'::"text", 'remote-wins'::"text", 'manual'::"text"]))),
    CONSTRAINT "calendar_connections_provider_check" CHECK (("provider" = ANY (ARRAY['google'::"text", 'outlook'::"text", 'apple'::"text"]))),
    CONSTRAINT "calendar_connections_sync_direction_check" CHECK (("sync_direction" = ANY (ARRAY['push-only'::"text", 'pull-only'::"text", 'bi-directional'::"text"])))
);


ALTER TABLE "public"."calendar_connections" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."calendar_event_mappings" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "trip_id" "uuid" NOT NULL,
    "trip_event_id" "text" NOT NULL,
    "trip_event_type" "text" NOT NULL,
    "provider" "text" NOT NULL,
    "calendar_id" "text" NOT NULL,
    "calendar_event_id" "text" NOT NULL,
    "last_synced_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "sync_hash" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."calendar_event_mappings" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."calendar_invitations" (
    "id" "text" NOT NULL,
    "trip_id" "uuid" NOT NULL,
    "recipient_email" "text" NOT NULL,
    "access_level" "text" DEFAULT 'view'::"text" NOT NULL,
    "invite_token" "text" NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "sent_by" "uuid" NOT NULL,
    "sent_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "expires_at" timestamp with time zone DEFAULT ("now"() + '7 days'::interval) NOT NULL,
    "accepted_at" timestamp with time zone,
    CONSTRAINT "calendar_invitations_access_level_check" CHECK (("access_level" = ANY (ARRAY['view'::"text", 'comment'::"text", 'edit'::"text"]))),
    CONSTRAINT "calendar_invitations_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'accepted'::"text", 'declined'::"text"])))
);


ALTER TABLE "public"."calendar_invitations" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."calendar_share_viewers" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "share_id" "uuid" NOT NULL,
    "email" "text" NOT NULL,
    "role" "text" DEFAULT 'viewer'::"text" NOT NULL,
    "invited_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "accepted_at" timestamp with time zone,
    CONSTRAINT "calendar_share_viewers_role_check" CHECK (("role" = ANY (ARRAY['viewer'::"text", 'editor'::"text", 'collaborator'::"text"])))
);


ALTER TABLE "public"."calendar_share_viewers" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."calendar_sync_errors" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "connection_id" "uuid",
    "operation" "text" NOT NULL,
    "provider" "text" NOT NULL,
    "error_code" "text",
    "error_message" "text",
    "retry_count" integer DEFAULT 0 NOT NULL,
    "next_retry_at" timestamp with time zone,
    "is_resolved" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "calendar_sync_errors_operation_check" CHECK (("operation" = ANY (ARRAY['export'::"text", 'import'::"text", 'sync'::"text", 'delete'::"text"])))
);


ALTER TABLE "public"."calendar_sync_errors" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."calendar_sync_log" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "trip_id" "uuid" NOT NULL,
    "provider" "text" NOT NULL,
    "provider_event_id" "text" NOT NULL,
    "reservation_id" "uuid",
    "itinerary_item_id" "uuid",
    "synced_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "status" "text" DEFAULT 'synced'::"text" NOT NULL,
    "error_message" "text",
    CONSTRAINT "calendar_sync_log_status_check" CHECK (("status" = ANY (ARRAY['synced'::"text", 'failed'::"text", 'deleted'::"text"])))
);


ALTER TABLE "public"."calendar_sync_log" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."canary_test_log" (
    "id" "text" NOT NULL,
    "test_name" "text" NOT NULL,
    "canary_kind" "text" NOT NULL,
    "found_in" "text",
    "passed" boolean NOT NULL,
    "run_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."canary_test_log" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."change_proposals" (
    "id" "text" NOT NULL,
    "trip_id" "uuid" NOT NULL,
    "proposer_member_id" "text" NOT NULL,
    "ops" "jsonb" NOT NULL,
    "preview" "jsonb" NOT NULL,
    "note" "text",
    "approval_mode" "text" NOT NULL,
    "poll_id" "text",
    "status" "text" DEFAULT 'open'::"text" NOT NULL,
    "base_version" integer NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "decided_at" timestamp with time zone,
    "decided_by" "text",
    CONSTRAINT "change_proposals_approval_mode_check" CHECK (("approval_mode" = ANY (ARRAY['organizer'::"text", 'poll'::"text"]))),
    CONSTRAINT "change_proposals_status_check" CHECK (("status" = ANY (ARRAY['open'::"text", 'approved'::"text", 'rejected'::"text", 'withdrawn'::"text", 'stale'::"text"])))
);


ALTER TABLE "public"."change_proposals" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."checkins" (
    "id" "text" NOT NULL,
    "trip_id" "uuid",
    "user_id" "text" NOT NULL,
    "due_at" timestamp with time zone NOT NULL,
    "grace_minutes" integer DEFAULT 10 NOT NULL,
    "context" "text",
    "escalation_contact_ids" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "share_location" boolean DEFAULT false NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "first_prompt_sent_at" timestamp with time zone,
    "second_prompt_sent_at" timestamp with time zone,
    "escalated_at" timestamp with time zone,
    "responded_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "checkins_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'ok'::"text", 'help'::"text", 'escalated'::"text", 'cancelled'::"text", 'extended'::"text"])))
);


ALTER TABLE "public"."checkins" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."circuit_breaker_state" (
    "provider" "text" NOT NULL,
    "consecutive_failures" integer DEFAULT 0 NOT NULL,
    "state" "text" DEFAULT 'closed'::"text" NOT NULL,
    "opened_at" timestamp with time zone,
    "last_failure_at" timestamp with time zone,
    "last_success_at" timestamp with time zone
);


ALTER TABLE "public"."circuit_breaker_state" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."claim_expenses" (
    "id" "text" NOT NULL,
    "claim_id" "text" NOT NULL,
    "description" "text" NOT NULL,
    "amount_minor" bigint NOT NULL,
    "currency" character(3) NOT NULL,
    "receipt_url" "text",
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."claim_expenses" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."comment_reactions" (
    "comment_id" "text" NOT NULL,
    "member_id" "text" NOT NULL,
    "emoji" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."comment_reactions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."comments" (
    "id" "text" NOT NULL,
    "trip_id" "uuid" NOT NULL,
    "target_type" "text" NOT NULL,
    "target_id" "text" NOT NULL,
    "thread_id" "text" NOT NULL,
    "author_member_id" "text" NOT NULL,
    "body" "text" NOT NULL,
    "mentions" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "resolved_at" timestamp with time zone,
    "resolved_by" "text",
    "edited_at" timestamp with time zone,
    "deleted_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "comments_body_check" CHECK (("char_length"("body") <= 2000))
);


ALTER TABLE "public"."comments" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."concurrency_audit_log" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "operation_id" "text",
    "attempt_id" "text",
    "owner_id" "text",
    "event_type" "text" NOT NULL,
    "previous_state" "text",
    "requested_state" "text",
    "resulting_state" "text",
    "reason" "text",
    "metadata" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."concurrency_audit_log" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."copilot_drafts" (
    "id" "text" NOT NULL,
    "thread_id" "text" NOT NULL,
    "trip_id" "uuid" NOT NULL,
    "user_id" "text" NOT NULL,
    "ops" "jsonb" NOT NULL,
    "preview" "jsonb" NOT NULL,
    "summary" "text" NOT NULL,
    "unmet" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "sources" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "copilot_drafts_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'applied'::"text", 'rejected'::"text"])))
);


ALTER TABLE "public"."copilot_drafts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."copilot_messages" (
    "id" "text" NOT NULL,
    "thread_id" "text" NOT NULL,
    "role" "text" NOT NULL,
    "content" "text" NOT NULL,
    "tool_calls" "jsonb",
    "tool_results" "jsonb",
    "draft_id" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "copilot_messages_role_check" CHECK (("role" = ANY (ARRAY['user'::"text", 'assistant'::"text", 'tool'::"text"])))
);


ALTER TABLE "public"."copilot_messages" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."copilot_proposals" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "trip_id" "uuid" NOT NULL,
    "itinerary_version_id" "text",
    "user_request" "text" NOT NULL,
    "interpreted_goal" "text" NOT NULL,
    "status" "text" DEFAULT 'DRAFT'::"text" NOT NULL,
    "affected_days" integer[],
    "affected_activities" "jsonb" DEFAULT '[]'::"jsonb",
    "proposed_changes" "jsonb" DEFAULT '[]'::"jsonb",
    "preserved_constraints" "jsonb" DEFAULT '[]'::"jsonb",
    "expected_effects" "jsonb" DEFAULT '{}'::"jsonb",
    "warnings" "jsonb" DEFAULT '[]'::"jsonb",
    "options" "jsonb" DEFAULT '[]'::"jsonb",
    "confidence" "text" DEFAULT 'MEDIUM'::"text",
    "conversation_context" "jsonb" DEFAULT '[]'::"jsonb",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "source_itinerary_id" "text",
    "result_itinerary_id" "text",
    "approved_at" timestamp with time zone,
    "executed_at" timestamp with time zone,
    "execution_error" "text",
    "change_summary" "jsonb",
    "health_before" integer,
    "health_after" integer,
    "friction_before" integer,
    "friction_after" integer,
    "alert_id" "uuid",
    "monitoring_event_id" "uuid",
    "impact_ids" "uuid"[],
    "base_itinerary_version_id" "uuid",
    "what_will_change" "text",
    "what_will_stay" "text",
    "why_recommended" "text",
    "affected_items" "jsonb" DEFAULT '[]'::"jsonb",
    "stale_checked_at" timestamp with time zone,
    "result_itinerary_version_id" "uuid",
    "result_version_change_summary" "text",
    "failure_reason" "text",
    "proposal_operation_id" "text",
    CONSTRAINT "copilot_proposals_status_check" CHECK (("status" = ANY (ARRAY['DRAFT'::"text", 'READY_FOR_REVIEW'::"text", 'APPROVED'::"text", 'EXECUTING'::"text", 'EXECUTED'::"text", 'FAILED'::"text", 'CANCELLED'::"text", 'STALE'::"text", 'COMPLETE'::"text"])))
);


ALTER TABLE "public"."copilot_proposals" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."copilot_settings" (
    "user_id" "text" NOT NULL,
    "use_memory" boolean DEFAULT true NOT NULL,
    "daily_message_count" integer DEFAULT 0 NOT NULL,
    "daily_count_date" "date",
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."copilot_settings" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."copilot_threads" (
    "id" "text" NOT NULL,
    "trip_id" "uuid" NOT NULL,
    "user_id" "text" NOT NULL,
    "title" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "last_message_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "deleted_at" timestamp with time zone
);


ALTER TABLE "public"."copilot_threads" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."copilot_trip_summaries" (
    "trip_id" "uuid" NOT NULL,
    "user_id" "text" NOT NULL,
    "destination" "text" NOT NULL,
    "dates" "text" NOT NULL,
    "loved" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "disliked" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "pace" "text" DEFAULT 'balanced'::"text" NOT NULL,
    "notes" "text",
    "generated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."copilot_trip_summaries" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."cost_alerts" (
    "id" bigint NOT NULL,
    "threshold_type" character varying(100),
    "alert_message" "text",
    "daily_spend" numeric(10,2),
    "threshold_amount" numeric(10,2),
    "actions_triggered" "text"[],
    "alert_timestamp" timestamp with time zone,
    "resolved_at" timestamp with time zone,
    "acknowledged_by_user_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."cost_alerts" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."cost_alerts_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."cost_alerts_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."cost_alerts_id_seq" OWNED BY "public"."cost_alerts"."id";



CREATE TABLE IF NOT EXISTS "public"."cost_index" (
    "city_code" "text" NOT NULL,
    "item" "text" NOT NULL,
    "tier" "text" NOT NULL,
    "p25_minor" bigint NOT NULL,
    "p50_minor" bigint NOT NULL,
    "p75_minor" bigint NOT NULL,
    "currency" character(3) NOT NULL,
    "source" "text" NOT NULL,
    "observed_on" "date" NOT NULL,
    CONSTRAINT "cost_index_item_check" CHECK (("item" = ANY (ARRAY['breakfast'::"text", 'lunch'::"text", 'dinner'::"text", 'coffee'::"text", 'beer'::"text", 'local_transit_ride'::"text", 'taxi_10km'::"text", 'museum_entry'::"text", 'guided_tour_half_day'::"text", 'groceries_day'::"text", 'sim_or_esim_week'::"text", 'lodging_night'::"text"]))),
    CONSTRAINT "cost_index_tier_check" CHECK (("tier" = ANY (ARRAY['budget'::"text", 'mid'::"text", 'comfort'::"text"])))
);


ALTER TABLE "public"."cost_index" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."currencies" (
    "iso_code" character(3) NOT NULL,
    "name" "text" NOT NULL,
    "symbol" "text",
    "minor_units" smallint DEFAULT 2 NOT NULL,
    "active" boolean DEFAULT true NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "currencies_iso_code_check" CHECK (("iso_code" ~ '^[A-Z]{3}$'::"text")),
    CONSTRAINT "currencies_minor_units_check" CHECK ((("minor_units" >= 0) AND ("minor_units" <= 4)))
);


ALTER TABLE "public"."currencies" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."daily_friction_scores" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "trip_id" "uuid" NOT NULL,
    "itinerary_id" "uuid",
    "version_id" "uuid",
    "user_id" "uuid" NOT NULL,
    "scores" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "average_friction" numeric(5,2),
    "highest_friction_day" integer,
    "highest_friction_score" integer,
    "lowest_friction_day" integer,
    "lowest_friction_score" integer,
    "high_friction_days" integer[] DEFAULT '{}'::integer[],
    "status" "text" DEFAULT 'ready'::"text" NOT NULL,
    "calculated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "daily_friction_scores_status_check" CHECK (("status" = ANY (ARRAY['analyzing'::"text", 'ready'::"text", 'failed'::"text"])))
);


ALTER TABLE "public"."daily_friction_scores" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."daily_spend" (
    "id" bigint NOT NULL,
    "date" "date" NOT NULL,
    "amount" numeric(10,2) DEFAULT 0,
    "by_service" "jsonb",
    "forecast_amount" numeric(10,2),
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."daily_spend" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."daily_spend_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."daily_spend_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."daily_spend_id_seq" OWNED BY "public"."daily_spend"."id";



CREATE TABLE IF NOT EXISTS "public"."data_export_requests" (
    "id" "text" NOT NULL,
    "user_id" "text" NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "download_url" "text",
    "download_token" "text",
    "expires_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "completed_at" timestamp with time zone,
    CONSTRAINT "data_export_requests_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'processing'::"text", 'ready'::"text", 'expired'::"text", 'failed'::"text"])))
);


ALTER TABLE "public"."data_export_requests" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."day_energy_snapshots" (
    "user_id" "text" NOT NULL,
    "trip_id" "uuid" NOT NULL,
    "date" "date" NOT NULL,
    "energy_budget" real NOT NULL,
    "energy_spent" real NOT NULL
);


ALTER TABLE "public"."day_energy_snapshots" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."day_snapshots" (
    "id" "text" NOT NULL,
    "trip_id" "uuid" NOT NULL,
    "date" "date" NOT NULL,
    "snapshot" "jsonb" NOT NULL,
    "trigger" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "day_snapshots_trigger_check" CHECK (("trigger" = ANY (ARRAY['daily_job'::"text", 'bulk_apply'::"text", 'manual'::"text"])))
);


ALTER TABLE "public"."day_snapshots" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."dedup_cache" (
    "id" bigint NOT NULL,
    "request_hash" character varying(64),
    "request_params" "jsonb",
    "cached_response" "jsonb",
    "requests_deduped" integer DEFAULT 1,
    "estimated_savings" numeric(10,4),
    "cache_expires_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."dedup_cache" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."dedup_cache_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."dedup_cache_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."dedup_cache_id_seq" OWNED BY "public"."dedup_cache"."id";



CREATE TABLE IF NOT EXISTS "public"."delivery_attempts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "batch_id" "uuid",
    "user_id" "uuid" NOT NULL,
    "channel" "text" NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "provider" "text",
    "provider_message_id" "text",
    "attempted_at" timestamp with time zone,
    "failure_reason" "text",
    "retry_count" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "delivery_attempts_channel_check" CHECK (("channel" = ANY (ARRAY['push'::"text", 'email'::"text", 'sms'::"text", 'inapp'::"text", 'dashboard'::"text"]))),
    CONSTRAINT "delivery_attempts_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'sent'::"text", 'failed'::"text", 'skipped'::"text", 'rate_limited'::"text"])))
);


ALTER TABLE "public"."delivery_attempts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."dep_edges" (
    "id" "text" NOT NULL,
    "trip_id" "uuid" NOT NULL,
    "from_node_id" "text" NOT NULL,
    "to_node_id" "text" NOT NULL,
    "kind" "text" NOT NULL,
    "min_gap_minutes" integer DEFAULT 0 NOT NULL,
    "auto" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "dep_edges_kind_check" CHECK (("kind" = ANY (ARRAY['connection'::"text", 'requires_arrival'::"text", 'transfer'::"text", 'sequence'::"text"])))
);


ALTER TABLE "public"."dep_edges" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."dep_nodes" (
    "id" "text" NOT NULL,
    "trip_id" "uuid" NOT NULL,
    "ref_type" "text" NOT NULL,
    "ref_id" "text" NOT NULL,
    "member_ids" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "starts_at" timestamp with time zone NOT NULL,
    "ends_at" timestamp with time zone NOT NULL,
    "tz" "text" DEFAULT 'UTC'::"text" NOT NULL,
    "fixed" boolean DEFAULT false NOT NULL,
    "flexible" boolean DEFAULT false NOT NULL,
    "critical" boolean DEFAULT false NOT NULL,
    "hold_minutes" integer DEFAULT 0 NOT NULL,
    "lat" double precision,
    "lng" double precision,
    "non_refundable_minor" bigint,
    "non_refundable_currency" character(3),
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "dep_nodes_ref_type_check" CHECK (("ref_type" = ANY (ARRAY['reservation'::"text", 'itinerary_item'::"text"])))
);


ALTER TABLE "public"."dep_nodes" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."dietary_phrase_cards" (
    "id" "text" NOT NULL,
    "dietary_need" "text" NOT NULL,
    "country_code" character(2) NOT NULL,
    "phrase_local" "text" NOT NULL,
    "language_name" "text" NOT NULL,
    "reviewed_at" "date" NOT NULL
);


ALTER TABLE "public"."dietary_phrase_cards" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."disaster_alerts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "trip_id" "uuid",
    "disaster_type" "text" NOT NULL,
    "location" "text" NOT NULL,
    "severity" "text" DEFAULT 'low'::"text" NOT NULL,
    "description" "text" NOT NULL,
    "affected_area" "text",
    "evacuation_order" boolean DEFAULT false NOT NULL,
    "recommendation" "text",
    "source" "text" DEFAULT 'USGS'::"text" NOT NULL,
    "event_time" timestamp with time zone,
    "detected_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "disaster_alerts_disaster_type_check" CHECK (("disaster_type" = ANY (ARRAY['earthquake'::"text", 'tsunami'::"text", 'flood'::"text", 'hurricane'::"text", 'tornado'::"text", 'wildfire'::"text", 'landslide'::"text", 'volcanic'::"text"]))),
    CONSTRAINT "disaster_alerts_severity_check" CHECK (("severity" = ANY (ARRAY['low'::"text", 'moderate'::"text", 'high'::"text", 'extreme'::"text"])))
);


ALTER TABLE "public"."disaster_alerts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."dismissed_alerts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid",
    "trip_id" "uuid",
    "alert_id" "text" NOT NULL,
    "alert_type" "text" NOT NULL,
    "dismissed_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."dismissed_alerts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."disruption_cases" (
    "id" "text" NOT NULL,
    "trip_id" "uuid" NOT NULL,
    "root_cause" "jsonb" NOT NULL,
    "predicted" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "impacts" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "money_at_risk_minor" bigint DEFAULT 0 NOT NULL,
    "money_at_risk_currency" character(3) DEFAULT 'USD'::"bpchar" NOT NULL,
    "time_to_act" timestamp with time zone,
    "severity" "text" DEFAULT 'info'::"text" NOT NULL,
    "status" "text" DEFAULT 'open'::"text" NOT NULL,
    "history" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "disruption_cases_severity_check" CHECK (("severity" = ANY (ARRAY['info'::"text", 'warning'::"text", 'critical'::"text"]))),
    CONSTRAINT "disruption_cases_status_check" CHECK (("status" = ANY (ARRAY['open'::"text", 'monitoring'::"text", 'resolved'::"text", 'dismissed'::"text"])))
);


ALTER TABLE "public"."disruption_cases" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."disruption_claims" (
    "id" "text" NOT NULL,
    "trip_id" "uuid" NOT NULL,
    "disruption_id" "text" NOT NULL,
    "member_id" "text" NOT NULL,
    "flight_ident" "text",
    "scheduled_time" timestamp with time zone,
    "actual_time" timestamp with time zone,
    "airline_reason" "text",
    "regime" "text",
    "status" "text" DEFAULT 'draft'::"text" NOT NULL,
    "amount_claimed_minor" bigint,
    "amount_claimed_currency" character(3),
    "amount_received_minor" bigint,
    "amount_received_currency" character(3),
    "submitted_at" timestamp with time zone,
    "follow_up_at" timestamp with time zone,
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "disruption_claims_status_check" CHECK (("status" = ANY (ARRAY['draft'::"text", 'submitted'::"text", 'awaiting'::"text", 'paid'::"text", 'rejected'::"text"])))
);


ALTER TABLE "public"."disruption_claims" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."disruption_reports" (
    "id" "text" NOT NULL,
    "trip_id" "uuid" NOT NULL,
    "reporter_id" "text" NOT NULL,
    "ref_type" "text" NOT NULL,
    "ref_id" "text" NOT NULL,
    "kind" "text" NOT NULL,
    "note" "text",
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."disruption_reports" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."document_imports" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "trip_id" "uuid" NOT NULL,
    "source_type" "text" NOT NULL,
    "filename" "text",
    "mime_type" "text",
    "file_size_bytes" integer,
    "storage_path" "text",
    "processing_status" "text" DEFAULT 'UPLOADED'::"text" NOT NULL,
    "travel_relevance" "text",
    "extraction_confidence" "text",
    "extraction_notes" "text",
    "reservations_found" integer DEFAULT 0,
    "extracted_data" "jsonb",
    "extracted_reservation_ids" "uuid"[],
    "quality_warning" "text",
    "error_message" "text",
    "uploaded_at" timestamp with time zone DEFAULT "now"(),
    "processed_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "document_imports_extraction_confidence_check" CHECK (("extraction_confidence" = ANY (ARRAY['HIGH'::"text", 'MEDIUM'::"text", 'LOW'::"text", 'UNKNOWN'::"text"]))),
    CONSTRAINT "document_imports_processing_status_check" CHECK (("processing_status" = ANY (ARRAY['UPLOADED'::"text", 'PROCESSING'::"text", 'READY_FOR_REVIEW'::"text", 'IMPORTED'::"text", 'NO_RESERVATION_FOUND'::"text", 'FAILED'::"text", 'UNSUPPORTED'::"text"]))),
    CONSTRAINT "document_imports_source_type_check" CHECK (("source_type" = ANY (ARRAY['PDF'::"text", 'SCREENSHOT'::"text", 'IMAGE'::"text", 'CAMERA'::"text", 'OTHER'::"text"]))),
    CONSTRAINT "document_imports_travel_relevance_check" CHECK (("travel_relevance" = ANY (ARRAY['TRAVEL_RELEVANT'::"text", 'POSSIBLY_TRAVEL_RELEVANT'::"text", 'NOT_TRAVEL_RELEVANT'::"text", 'UNKNOWN'::"text"])))
);


ALTER TABLE "public"."document_imports" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."email_attachments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "import_message_id" "uuid" NOT NULL,
    "filename" "text",
    "mime_type" "text",
    "size_bytes" integer,
    "source" "text",
    "processing_status" "text" DEFAULT 'NOT_PROCESSED'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "email_attachments_processing_status_check" CHECK (("processing_status" = ANY (ARRAY['NOT_PROCESSED'::"text", 'PROCESSING'::"text", 'PROCESSED'::"text", 'FAILED'::"text", 'UNSUPPORTED'::"text"])))
);


ALTER TABLE "public"."email_attachments" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."email_connections" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "provider" "text" NOT NULL,
    "account_identifier" "text",
    "connection_status" "text" DEFAULT 'DISCONNECTED'::"text" NOT NULL,
    "permission_scope" "text"[],
    "import_preferences" "jsonb" DEFAULT '{"events": true, "hotels": true, "trains": true, "flights": true, "transfers": true, "rental_cars": true, "restaurants": true, "tours_activities": true}'::"jsonb",
    "connected_at" timestamp with time zone,
    "last_sync_at" timestamp with time zone,
    "last_successful_sync_at" timestamp with time zone,
    "last_error" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "email_connections_connection_status_check" CHECK (("connection_status" = ANY (ARRAY['CONNECTED'::"text", 'DISCONNECTED'::"text", 'CONNECTION_ERROR'::"text", 'PAUSED'::"text", 'PENDING'::"text"]))),
    CONSTRAINT "email_connections_provider_check" CHECK (("provider" = ANY (ARRAY['GMAIL'::"text", 'OUTLOOK'::"text", 'ICLOUD'::"text", 'OTHER'::"text"])))
);


ALTER TABLE "public"."email_connections" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."email_message_imports" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "email_connection_id" "uuid",
    "provider_message_id" "text",
    "sender" "text",
    "subject" "text",
    "received_at" timestamp with time zone,
    "body_available" boolean DEFAULT false,
    "attachment_available" boolean DEFAULT false,
    "detected_travel_relevance" "text" DEFAULT 'UNKNOWN'::"text",
    "detected_reservation_types" "text"[],
    "extraction_status" "text" DEFAULT 'NEW'::"text" NOT NULL,
    "matched_trip_id" "uuid",
    "trip_match_confidence" "text",
    "confidence" "text" DEFAULT 'UNKNOWN'::"text",
    "imported_reservation_ids" "uuid"[],
    "extraction_result" "jsonb",
    "error_message" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "email_message_imports_confidence_check" CHECK (("confidence" = ANY (ARRAY['HIGH'::"text", 'MEDIUM'::"text", 'LOW'::"text", 'UNKNOWN'::"text"]))),
    CONSTRAINT "email_message_imports_detected_travel_relevance_check" CHECK (("detected_travel_relevance" = ANY (ARRAY['TRAVEL_RELEVANT'::"text", 'POSSIBLY_TRAVEL_RELEVANT'::"text", 'NOT_TRAVEL_RELEVANT'::"text", 'UNKNOWN'::"text"]))),
    CONSTRAINT "email_message_imports_extraction_status_check" CHECK (("extraction_status" = ANY (ARRAY['NEW'::"text", 'ANALYZING'::"text", 'READY_FOR_REVIEW'::"text", 'IMPORTED'::"text", 'DUPLICATE'::"text", 'IGNORED'::"text", 'NEEDS_REVIEW'::"text", 'ERROR'::"text"]))),
    CONSTRAINT "email_message_imports_trip_match_confidence_check" CHECK (("trip_match_confidence" = ANY (ARRAY['HIGH'::"text", 'MEDIUM'::"text", 'LOW'::"text", 'UNKNOWN'::"text"])))
);


ALTER TABLE "public"."email_message_imports" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."email_import_history" WITH ("security_invoker"='on') AS
 SELECT "email_message_imports"."user_id",
    "date_trunc"('day'::"text", "email_message_imports"."created_at") AS "import_date",
    "count"(*) AS "messages_reviewed",
    "count"(*) FILTER (WHERE ("email_message_imports"."detected_travel_relevance" = 'TRAVEL_RELEVANT'::"text")) AS "travel_relevant_count",
    "count"(*) FILTER (WHERE ("email_message_imports"."extraction_status" = 'READY_FOR_REVIEW'::"text")) AS "ready_for_review_count",
    "count"(*) FILTER (WHERE ("email_message_imports"."extraction_status" = 'IMPORTED'::"text")) AS "imported_count",
    "count"(*) FILTER (WHERE ("email_message_imports"."extraction_status" = 'DUPLICATE'::"text")) AS "duplicate_count",
    "count"(*) FILTER (WHERE ("email_message_imports"."extraction_status" = 'ERROR'::"text")) AS "error_count",
    "array_agg"(DISTINCT "unnested_id"."unnested_id") FILTER (WHERE ("unnested_id"."unnested_id" IS NOT NULL)) AS "all_reservation_ids"
   FROM "public"."email_message_imports",
    LATERAL "unnest"(COALESCE("email_message_imports"."imported_reservation_ids", ARRAY[]::"uuid"[])) "unnested_id"("unnested_id")
  GROUP BY "email_message_imports"."user_id", ("date_trunc"('day'::"text", "email_message_imports"."created_at"))
  ORDER BY ("date_trunc"('day'::"text", "email_message_imports"."created_at")) DESC;


ALTER VIEW "public"."email_import_history" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."embassies" (
    "id" "text" NOT NULL,
    "nationality" character(2) NOT NULL,
    "country" character(2) NOT NULL,
    "name" "text" NOT NULL,
    "address" "text" NOT NULL,
    "phone" "text",
    "official_url" "text" NOT NULL,
    "reviewed_at" "date" NOT NULL
);


ALTER TABLE "public"."embassies" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."emergency_info" (
    "user_id" "text" NOT NULL,
    "encrypted_data" "bytea" NOT NULL,
    "key_id" "text" NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."emergency_info" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."emergency_numbers" (
    "country_code" character(2) NOT NULL,
    "police" "text",
    "ambulance" "text",
    "fire" "text",
    "general" "text",
    "source_url" "text" NOT NULL,
    "reviewed_at" "date" NOT NULL
);


ALTER TABLE "public"."emergency_numbers" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."entry_requirement_changes" (
    "id" "text" NOT NULL,
    "nationality" character(2) NOT NULL,
    "destination" character(2) NOT NULL,
    "source" "text" NOT NULL,
    "old_hash" "text" NOT NULL,
    "new_hash" "text" NOT NULL,
    "diff_summary" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "detected_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."entry_requirement_changes" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."entry_requirements" (
    "id" "text" NOT NULL,
    "nationality" character(2) NOT NULL,
    "destination" character(2) NOT NULL,
    "source" "text" NOT NULL,
    "summary" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "passport_validity_rule" "jsonb",
    "authorization_info" "jsonb",
    "visa_note" "text",
    "official_url" "text" NOT NULL,
    "content_hash" "text" NOT NULL,
    "fetched_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at_source" "text",
    CONSTRAINT "entry_requirements_source_check" CHECK (("source" = ANY (ARRAY['GOVUK'::"text", 'USDOS'::"text", 'FALLBACK'::"text"])))
);


ALTER TABLE "public"."entry_requirements" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."eta_links" (
    "id" "text" NOT NULL,
    "trip_id" "uuid" NOT NULL,
    "item_id" "text" NOT NULL,
    "created_by" "text" NOT NULL,
    "token" "text" NOT NULL,
    "expires_at" timestamp with time zone NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."eta_links" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."expense_line_items" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "expense_id" "text",
    "description" "text" NOT NULL,
    "amount" numeric(12,2) NOT NULL,
    "split_among" "uuid"[] DEFAULT '{}'::"uuid"[] NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "expense_line_items_amount_check" CHECK (("amount" > (0)::numeric))
);


ALTER TABLE "public"."expense_line_items" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."expense_splits" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "expense_id" "text",
    "user_id" "uuid",
    "amount" numeric(12,2) NOT NULL,
    "percentage" numeric(6,3),
    "settled" boolean DEFAULT false,
    "settled_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."expense_splits" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."expenses" (
    "id" "text" NOT NULL,
    "group_id" "text" NOT NULL,
    "trip_id" "uuid" NOT NULL,
    "description" "text" NOT NULL,
    "amount" numeric(12,2) NOT NULL,
    "currency" "text" DEFAULT 'USD'::"text" NOT NULL,
    "category" "text" DEFAULT 'other'::"text" NOT NULL,
    "paid_by" "uuid",
    "paid_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "split_method" "text" DEFAULT 'equal'::"text" NOT NULL,
    "receipt_url" "text",
    "notes" "text",
    "deleted_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "expenses_amount_check" CHECK (("amount" > (0)::numeric)),
    CONSTRAINT "expenses_category_check" CHECK (("category" = ANY (ARRAY['accommodation'::"text", 'food'::"text", 'transport'::"text", 'activity'::"text", 'other'::"text"]))),
    CONSTRAINT "expenses_split_method_check" CHECK (("split_method" = ANY (ARRAY['equal'::"text", 'proportional'::"text", 'itemized'::"text", 'custom'::"text"])))
);


ALTER TABLE "public"."expenses" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."export_jobs" (
    "id" "text" NOT NULL,
    "trip_id" "uuid",
    "user_id" "text" NOT NULL,
    "kind" "text" NOT NULL,
    "options" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "result_url" "text",
    "result_token" "text",
    "error_message" "text",
    "bytes" integer,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "completed_at" timestamp with time zone,
    "expires_at" timestamp with time zone,
    CONSTRAINT "export_jobs_kind_check" CHECK (("kind" = ANY (ARRAY['backup'::"text", 'expenses'::"text", 'itinerary'::"text", 'calendar'::"text"]))),
    CONSTRAINT "export_jobs_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'processing'::"text", 'ready'::"text", 'failed'::"text", 'expired'::"text"])))
);


ALTER TABLE "public"."export_jobs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."feature_flags" (
    "flag" "text" NOT NULL,
    "enabled" boolean DEFAULT false NOT NULL,
    "rollout_pct" integer DEFAULT 0 NOT NULL,
    "description" "text",
    "series" "text",
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "feature_flags_rollout_pct_check" CHECK ((("rollout_pct" >= 0) AND ("rollout_pct" <= 100)))
);


ALTER TABLE "public"."feature_flags" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."flight_disruptions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "trip_id" "uuid",
    "flight_number" "text" NOT NULL,
    "airline" "text",
    "disruption_type" "text" NOT NULL,
    "estimated_delay_minutes" integer,
    "new_departure_time" timestamp with time zone,
    "new_arrival_time" timestamp with time zone,
    "reason" "text",
    "severity" "text" DEFAULT 'low'::"text" NOT NULL,
    "resolved" boolean DEFAULT false NOT NULL,
    "detected_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "flight_disruptions_disruption_type_check" CHECK (("disruption_type" = ANY (ARRAY['cancellation'::"text", 'diversion'::"text", 'delay'::"text", 'on_time'::"text"]))),
    CONSTRAINT "flight_disruptions_severity_check" CHECK (("severity" = ANY (ARRAY['low'::"text", 'medium'::"text", 'high'::"text", 'critical'::"text"])))
);


ALTER TABLE "public"."flight_disruptions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."flight_signals" (
    "flight_ident" "text" NOT NULL,
    "trip_id" "uuid" NOT NULL,
    "data" "jsonb" NOT NULL,
    "polled_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."flight_signals" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."fx_rates" (
    "as_of" "date" NOT NULL,
    "quote" character(3) NOT NULL,
    "usd_rate" numeric(24,12) NOT NULL,
    "source" "text" NOT NULL,
    "fetched_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "fx_rates_source_check" CHECK (("source" = ANY (ARRAY['frankfurter'::"text", 'exchangerate-api'::"text"]))),
    CONSTRAINT "fx_rates_usd_rate_check" CHECK (("usd_rate" > (0)::numeric))
);


ALTER TABLE "public"."fx_rates" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."fx_latest" WITH ("security_invoker"='true') AS
 SELECT DISTINCT ON ("r"."quote") "r"."quote",
    "r"."usd_rate",
    "r"."as_of",
    "r"."source",
    "r"."fetched_at",
    "c"."minor_units"
   FROM ("public"."fx_rates" "r"
     JOIN "public"."currencies" "c" ON (("c"."iso_code" = "r"."quote")))
  ORDER BY "r"."quote", "r"."as_of" DESC, ("r"."source" = 'frankfurter'::"text") DESC;


ALTER VIEW "public"."fx_latest" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."group_members" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "group_id" "text",
    "user_id" "uuid",
    "email" "text" NOT NULL,
    "display_name" "text",
    "role" "text" DEFAULT 'participant'::"text" NOT NULL,
    "status" "text" DEFAULT 'invited'::"text" NOT NULL,
    "invite_token" "text",
    "invite_expires_at" timestamp with time zone,
    "joined_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "group_members_role_check" CHECK (("role" = ANY (ARRAY['organizer'::"text", 'planner'::"text", 'participant'::"text", 'viewer'::"text"]))),
    CONSTRAINT "group_members_status_check" CHECK (("status" = ANY (ARRAY['active'::"text", 'invited'::"text", 'declined'::"text"])))
);


ALTER TABLE "public"."group_members" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."group_messages" (
    "id" "text" NOT NULL,
    "group_id" "text" NOT NULL,
    "user_id" "uuid",
    "display_name" "text" DEFAULT 'Unknown'::"text" NOT NULL,
    "content" "text" NOT NULL,
    "type" "text" DEFAULT 'message'::"text" NOT NULL,
    "edited_at" timestamp with time zone,
    "pinned" boolean DEFAULT false,
    "pinned_by" "uuid",
    "pinned_at" timestamp with time zone,
    "deleted_at" timestamp with time zone,
    "version" integer DEFAULT 1,
    "created_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "group_messages_type_check" CHECK (("type" = ANY (ARRAY['message'::"text", 'announcement'::"text", 'system'::"text"])))
);


ALTER TABLE "public"."group_messages" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."happiness_scores" (
    "id" "text" DEFAULT ("gen_random_uuid"())::"text" NOT NULL,
    "trip_id" "uuid" NOT NULL,
    "user_id" "text" NOT NULL,
    "overall_score" integer NOT NULL,
    "factors" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "predictors" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "trend" "text" DEFAULT 'stable'::"text" NOT NULL,
    "computed_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "happiness_scores_overall_score_check" CHECK ((("overall_score" >= 0) AND ("overall_score" <= 100)))
);


ALTER TABLE "public"."happiness_scores" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."happy_moments" (
    "id" "text" DEFAULT ("gen_random_uuid"())::"text" NOT NULL,
    "trip_id" "uuid" NOT NULL,
    "user_id" "text" NOT NULL,
    "description" "text" NOT NULL,
    "category" "text" DEFAULT 'moment'::"text" NOT NULL,
    "rating" integer DEFAULT 5 NOT NULL,
    "location" "text",
    "participants" "text"[],
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "happy_moments_rating_check" CHECK ((("rating" >= 1) AND ("rating" <= 5)))
);


ALTER TABLE "public"."happy_moments" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."health_assessments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "trip_id" "uuid",
    "destination" "text" NOT NULL,
    "overall_risk_level" "text" DEFAULT 'low'::"text" NOT NULL,
    "medical_facility_quality" "text" DEFAULT 'adequate'::"text" NOT NULL,
    "threats" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "recommendations" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "assessed_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "health_assessments_medical_facility_quality_check" CHECK (("medical_facility_quality" = ANY (ARRAY['excellent'::"text", 'good'::"text", 'adequate'::"text", 'poor'::"text"]))),
    CONSTRAINT "health_assessments_overall_risk_level_check" CHECK (("overall_risk_level" = ANY (ARRAY['low'::"text", 'moderate'::"text", 'high'::"text", 'extreme'::"text"])))
);


ALTER TABLE "public"."health_assessments" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."hotel_loyalty_cache" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "program" "text" NOT NULL,
    "data" "jsonb" NOT NULL,
    "fetched_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "expires_at" timestamp with time zone NOT NULL
);


ALTER TABLE "public"."hotel_loyalty_cache" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."hotel_loyalty_tokens" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "program" "text" NOT NULL,
    "access_token" "text" NOT NULL,
    "refresh_token" "text",
    "expires_at" bigint NOT NULL,
    "token_type" "text" DEFAULT 'Bearer'::"text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "encrypted_access_token" "text",
    "encrypted_refresh_token" "text",
    "refresh_token_expires_at" bigint,
    "last_refreshed_at" bigint,
    "is_active" boolean DEFAULT true,
    "connection_status" "text" DEFAULT 'connected'::"text"
);


ALTER TABLE "public"."hotel_loyalty_tokens" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."hotel_oauth_sessions" (
    "key" "text" NOT NULL,
    "code_verifier" "text" NOT NULL,
    "state" "text" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "expires_at" bigint NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."hotel_oauth_sessions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."hotel_token_audit_log" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "program" "text" NOT NULL,
    "action" "text" NOT NULL,
    "status" "text" NOT NULL,
    "error_message" "text",
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."hotel_token_audit_log" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."idempotency_keys" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "idempotency_key" "text" NOT NULL,
    "operation_id" "text" NOT NULL,
    "result_id" "text",
    "result_type" "text",
    "status" "text" DEFAULT 'PENDING'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "completed_at" timestamp with time zone,
    "expires_at" timestamp with time zone
);


ALTER TABLE "public"."idempotency_keys" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."idempotency_records" (
    "idempotency_record_id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "idempotency_key" "text" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "trip_id" "uuid",
    "operation_id" "uuid",
    "operation_type" "text",
    "request_fingerprint" "text",
    "request_hash" "text",
    "status" "text" DEFAULT 'IN_PROGRESS'::"text" NOT NULL,
    "response_reference" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "completed_at" timestamp with time zone,
    "expires_at" timestamp with time zone,
    CONSTRAINT "chk_idempotency_status" CHECK (("status" = ANY (ARRAY['IN_PROGRESS'::"text", 'SUCCEEDED'::"text", 'FAILED'::"text", 'CANCELLED'::"text", 'STALE'::"text"])))
);


ALTER TABLE "public"."idempotency_records" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."important_information" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "trip_id" "uuid",
    "reservation_id" "uuid",
    "information_type" "text" DEFAULT 'CUSTOM'::"text" NOT NULL,
    "title" "text" NOT NULL,
    "contact_name" "text",
    "organization" "text",
    "phone" "text",
    "email" "text",
    "address" "text",
    "website" "text",
    "information_text" "text",
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "important_information_information_type_check" CHECK (("information_type" = ANY (ARRAY['EMERGENCY_CONTACT'::"text", 'TRAVEL_CONTACT'::"text", 'LOCATION_INFO'::"text", 'INSURANCE_INFO'::"text", 'AIRLINE_CONTACT'::"text", 'HOTEL_CONTACT'::"text", 'RENTAL_CAR_CONTACT'::"text", 'TOUR_CONTACT'::"text", 'CUSTOM'::"text"])))
);


ALTER TABLE "public"."important_information" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."inapp_notifications" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "batch_id" "uuid",
    "trip_id" "uuid",
    "title" "text" NOT NULL,
    "body" "text" NOT NULL,
    "theme" "text" DEFAULT 'mixed'::"text" NOT NULL,
    "max_priority" "text" DEFAULT 'LOW'::"text" NOT NULL,
    "action_url" "text",
    "action_items" "jsonb" DEFAULT '[]'::"jsonb",
    "read" boolean DEFAULT false NOT NULL,
    "read_at" timestamp with time zone,
    "dismissed" boolean DEFAULT false NOT NULL,
    "dismissed_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."inapp_notifications" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."item_ratings" (
    "id" "text" NOT NULL,
    "user_id" "text" NOT NULL,
    "trip_id" "uuid" NOT NULL,
    "item_id" "text" NOT NULL,
    "rating" smallint NOT NULL,
    "tags" "text"[] DEFAULT '{}'::"text"[],
    "context" "jsonb" NOT NULL,
    "predicted" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "item_ratings_rating_check" CHECK ((("rating" >= 1) AND ("rating" <= 5)))
);


ALTER TABLE "public"."item_ratings" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."itinerary_items" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "trip_id" "uuid" NOT NULL,
    "title" "text",
    "type" "text",
    "category" "text",
    "status" "text",
    "date" "date",
    "start_time" timestamp with time zone,
    "end_time" timestamp with time zone,
    "timezone" "text",
    "duration_min" integer,
    "location" "text",
    "notes" "text",
    "country_code" "text",
    "transport_mode" "text",
    "party_size" integer,
    "place_id" "text",
    "lat" double precision,
    "lng" double precision,
    "windows" "jsonb",
    "fixed" boolean DEFAULT false NOT NULL,
    "fixed_start" timestamp with time zone,
    "outdoor" boolean DEFAULT false NOT NULL,
    "must_do" boolean DEFAULT false NOT NULL,
    "starred" boolean DEFAULT false NOT NULL,
    "suggested" boolean DEFAULT false NOT NULL,
    "droppable" boolean DEFAULT true NOT NULL,
    "critical" boolean DEFAULT false NOT NULL,
    "hold_minutes" integer,
    "energy_cost" numeric,
    "member_ids" "jsonb",
    "cancellation" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."itinerary_items" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."itinerary_versions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "trip_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "version_number" integer NOT NULL,
    "parent_version_id" "uuid",
    "source_itinerary_id" "uuid",
    "is_active" boolean DEFAULT false NOT NULL,
    "status" "text" DEFAULT 'ready'::"text" NOT NULL,
    "creation_method" "text" NOT NULL,
    "version_name" "text" NOT NULL,
    "user_request" "text",
    "change_summary" "text"[],
    "budget_snapshot" "jsonb",
    "pace_snapshot" "jsonb",
    "geo_snapshot" "jsonb",
    "itinerary_snapshot" "jsonb",
    "trip_summary_snapshot" "jsonb",
    "validation_status" "text",
    "user_note" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "health_snapshot" "jsonb",
    "alert_id" "uuid",
    "monitoring_event_id" "uuid",
    "proposal_id" "uuid",
    "impact_id" "uuid",
    "validation_result" "jsonb",
    "change_request" "text",
    "health_recalculated_at" timestamp with time zone,
    "readiness_recalculated_at" timestamp with time zone,
    "post_activation_status" "text" DEFAULT 'PENDING'::"text" NOT NULL,
    "metadata" "jsonb",
    CONSTRAINT "itinerary_versions_creation_method_check" CHECK (("creation_method" = ANY (ARRAY['AI_GENERATED'::"text", 'USER_EDIT'::"text", 'CONVERSATIONAL_CHANGE'::"text", 'BUDGET_OPTIMIZATION'::"text", 'GEOGRAPHIC_OPTIMIZATION'::"text", 'PACE_OPTIMIZATION'::"text", 'RESTORED_VERSION'::"text", 'REGENERATED'::"text", 'ALERT_FIX'::"text", 'RESTORE'::"text"]))),
    CONSTRAINT "itinerary_versions_post_activation_status_check" CHECK (("post_activation_status" = ANY (ARRAY['PENDING'::"text", 'RUNNING'::"text", 'COMPLETE'::"text", 'FAILED'::"text", 'SKIPPED'::"text", 'PARTIAL'::"text"]))),
    CONSTRAINT "itinerary_versions_status_check" CHECK (("status" = ANY (ARRAY['validating'::"text", 'ready'::"text", 'ready_with_notes'::"text", 'needs_review'::"text", 'invalid'::"text", 'failed'::"text"])))
);


ALTER TABLE "public"."itinerary_versions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."location_points" (
    "share_id" "text" NOT NULL,
    "at" timestamp with time zone NOT NULL,
    "lat" double precision NOT NULL,
    "lng" double precision NOT NULL,
    "accuracy_m" real,
    "battery_pct" smallint
);


ALTER TABLE "public"."location_points" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."location_shares" (
    "id" "text" NOT NULL,
    "trip_id" "uuid",
    "user_id" "text" NOT NULL,
    "audience" "jsonb" DEFAULT '{"memberIds": [], "contactIds": []}'::"jsonb" NOT NULL,
    "mode" "text" NOT NULL,
    "ends_at" timestamp with time zone,
    "destination" "jsonb",
    "link_token" "text",
    "link_token_hash" "text",
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "location_shares_mode_check" CHECK (("mode" = ANY (ARRAY['duration'::"text", 'until_arrival'::"text", 'until_time'::"text"]))),
    CONSTRAINT "location_shares_status_check" CHECK (("status" = ANY (ARRAY['active'::"text", 'ended'::"text", 'expired'::"text"])))
);


ALTER TABLE "public"."location_shares" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."loop_executions" (
    "id" bigint NOT NULL,
    "loop_name" character varying(255),
    "execution_start" timestamp with time zone,
    "execution_end" timestamp with time zone,
    "duration_ms" integer,
    "status" character varying(50),
    "error_message" "text",
    "result_summary" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."loop_executions" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."loop_executions_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."loop_executions_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."loop_executions_id_seq" OWNED BY "public"."loop_executions"."id";



CREATE TABLE IF NOT EXISTS "public"."loyalty_aggregator_connections" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "aggregator" "text" DEFAULT 'awardwallet'::"text" NOT NULL,
    "external_user_id" bigint,
    "external_email" "text",
    "access_level" smallint,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "last_synced_at" timestamp with time zone,
    "last_error" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "loyalty_aggregator_connections_access_level_check" CHECK ((("access_level" >= 0) AND ("access_level" <= 3))),
    CONSTRAINT "loyalty_aggregator_connections_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'connected'::"text", 'revoked'::"text", 'error'::"text"])))
);


ALTER TABLE "public"."loyalty_aggregator_connections" OWNER TO "postgres";


COMMENT ON TABLE "public"."loyalty_aggregator_connections" IS 'Maps a TravelOS user to their AwardWallet connectedUser id. Never stores loyalty-program passwords.';



CREATE TABLE IF NOT EXISTS "public"."member_preferences" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "group_id" "text",
    "user_id" "uuid",
    "pace" "text" DEFAULT 'moderate'::"text",
    "budget" "text" DEFAULT 'moderate'::"text",
    "interests" "text"[] DEFAULT '{}'::"text"[],
    "dietary" "text"[] DEFAULT '{}'::"text"[],
    "mobility" "text" DEFAULT 'none'::"text",
    "timezone" "text" DEFAULT 'UTC'::"text",
    "updated_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "member_preferences_budget_check" CHECK (("budget" = ANY (ARRAY['budget'::"text", 'moderate'::"text", 'luxury'::"text"]))),
    CONSTRAINT "member_preferences_mobility_check" CHECK (("mobility" = ANY (ARRAY['none'::"text", 'limited'::"text", 'wheelchair'::"text"]))),
    CONSTRAINT "member_preferences_pace_check" CHECK (("pace" = ANY (ARRAY['slow'::"text", 'moderate'::"text", 'fast'::"text"])))
);


ALTER TABLE "public"."member_preferences" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."message_attachments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "message_id" "text",
    "filename" "text" NOT NULL,
    "url" "text" NOT NULL,
    "mime_type" "text",
    "size_bytes" integer,
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."message_attachments" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."message_reactions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "message_id" "text",
    "user_id" "uuid",
    "emoji" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."message_reactions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."monitored_entities" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "trip_id" "uuid" NOT NULL,
    "reservation_id" "uuid",
    "itinerary_version_id" "text",
    "entity_type" "text" NOT NULL,
    "entity_reference" "text",
    "monitoring_status" "text" DEFAULT 'NOT_SUPPORTED'::"text" NOT NULL,
    "provider_id" "uuid",
    "monitoring_capabilities" "jsonb" DEFAULT '[]'::"jsonb",
    "last_checked_at" timestamp with time zone,
    "last_successful_check_at" timestamp with time zone,
    "last_change_detected_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "monitored_entities_entity_type_check" CHECK (("entity_type" = ANY (ARRAY['FLIGHT'::"text", 'HOTEL'::"text", 'RENTAL_CAR'::"text", 'TRAIN'::"text", 'BUS'::"text", 'TRANSFER'::"text", 'TOUR'::"text", 'ACTIVITY'::"text", 'EVENT'::"text", 'DESTINATION_REQUIREMENT'::"text", 'DOCUMENT'::"text", 'WEATHER'::"text", 'OTHER'::"text"]))),
    CONSTRAINT "monitored_entities_monitoring_status_check" CHECK (("monitoring_status" = ANY (ARRAY['ACTIVE'::"text", 'LIMITED'::"text", 'UNAVAILABLE'::"text", 'NOT_SUPPORTED'::"text", 'PAUSED'::"text"])))
);


ALTER TABLE "public"."monitored_entities" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."monitoring_events" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "trip_id" "uuid" NOT NULL,
    "monitored_entity_id" "uuid",
    "reservation_id" "uuid",
    "itinerary_version_id" "text",
    "event_type" "text" NOT NULL,
    "event_source" "text" NOT NULL,
    "detected_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "effective_at" timestamp with time zone,
    "previous_value" "jsonb",
    "new_value" "jsonb",
    "severity" "text" DEFAULT 'MEDIUM'::"text" NOT NULL,
    "confidence" "text" DEFAULT 'UNKNOWN'::"text" NOT NULL,
    "source_reference" "text",
    "source_timestamp" timestamp with time zone,
    "status" "text" DEFAULT 'NEW'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "fingerprint" "text",
    "changed_fields" "text"[],
    "change_category" "text",
    "change_magnitude" "jsonb",
    "detection_method" "text",
    "is_duplicate" boolean DEFAULT false,
    "duplicate_of_event_id" "uuid",
    "last_seen_at" timestamp with time zone,
    "source_conflict" "jsonb",
    "pipeline_run_id" "text",
    "impact_analysis_status" "text" DEFAULT 'PENDING'::"text",
    "impact_analysis_started_at" timestamp with time zone,
    "impact_analysis_completed_at" timestamp with time zone,
    "impact_analysis_error" "text",
    "impacts_created" integer DEFAULT 0,
    "failure_type" "text",
    "failure_message" "text",
    "recovery_log_id" "uuid",
    "event_fingerprint" "text",
    CONSTRAINT "monitoring_events_change_category_check" CHECK (("change_category" = ANY (ARRAY['MEANINGFUL'::"text", 'INFORMATIONAL'::"text", 'NON_CHANGE'::"text"]))),
    CONSTRAINT "monitoring_events_confidence_check" CHECK (("confidence" = ANY (ARRAY['HIGH'::"text", 'MEDIUM'::"text", 'LOW'::"text", 'UNKNOWN'::"text"]))),
    CONSTRAINT "monitoring_events_event_type_check" CHECK (("event_type" = ANY (ARRAY['SCHEDULE_CHANGE'::"text", 'DELAY'::"text", 'CANCELLATION'::"text", 'LOCATION_CHANGE'::"text", 'AIRPORT_CHANGE'::"text", 'TERMINAL_CHANGE'::"text", 'GATE_CHANGE'::"text", 'RESERVATION_CHANGE'::"text", 'CHECK_IN_CHANGE'::"text", 'CHECK_OUT_CHANGE'::"text", 'REQUIREMENT_CHANGE'::"text", 'WEATHER_ALERT'::"text", 'TRANSPORTATION_DISRUPTION'::"text", 'OTHER'::"text"]))),
    CONSTRAINT "monitoring_events_impact_analysis_status_check" CHECK (("impact_analysis_status" = ANY (ARRAY['PENDING'::"text", 'PROCESSING'::"text", 'COMPLETE'::"text", 'FAILED'::"text", 'SKIPPED'::"text", 'NOT_APPLICABLE'::"text"]))),
    CONSTRAINT "monitoring_events_severity_check" CHECK (("severity" = ANY (ARRAY['INFO'::"text", 'LOW'::"text", 'MEDIUM'::"text", 'HIGH'::"text", 'CRITICAL'::"text"]))),
    CONSTRAINT "monitoring_events_status_check" CHECK (("status" = ANY (ARRAY['NEW'::"text", 'PROCESSED'::"text", 'DUPLICATE'::"text", 'IGNORED'::"text", 'FAILED'::"text", 'RESOLVED'::"text"])))
);


ALTER TABLE "public"."monitoring_events" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."monitoring_providers" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "provider_name" "text" NOT NULL,
    "provider_type" "text" NOT NULL,
    "status" "text" DEFAULT 'NOT_CONFIGURED'::"text" NOT NULL,
    "capabilities" "jsonb" DEFAULT '[]'::"jsonb",
    "description" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "monitoring_providers_provider_type_check" CHECK (("provider_type" = ANY (ARRAY['AIRLINE'::"text", 'FLIGHT_DATA'::"text", 'HOTEL'::"text", 'RAIL'::"text", 'BUS'::"text", 'ACTIVITY'::"text", 'WEATHER'::"text", 'GOVERNMENT'::"text", 'USER'::"text", 'OTHER'::"text"]))),
    CONSTRAINT "monitoring_providers_status_check" CHECK (("status" = ANY (ARRAY['ACTIVE'::"text", 'LIMITED'::"text", 'UNAVAILABLE'::"text", 'DISABLED'::"text", 'NOT_CONFIGURED'::"text"])))
);


ALTER TABLE "public"."monitoring_providers" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."monitoring_snapshots" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "monitored_entity_id" "uuid" NOT NULL,
    "provider_id" "uuid",
    "captured_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "normalized_state" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "source_timestamp" timestamp with time zone,
    "source_reference" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "is_stale" boolean DEFAULT false,
    "superseded_by_snapshot_id" "uuid",
    "check_result" "text",
    "check_notes" "text",
    "monitoring_event_id" "uuid",
    "pipeline_status" "text" DEFAULT 'PENDING'::"text",
    "pipeline_started_at" timestamp with time zone,
    "pipeline_completed_at" timestamp with time zone,
    "pipeline_error" "text",
    "events_created" integer DEFAULT 0,
    "events_deduplicated" integer DEFAULT 0,
    "failure_type" "text",
    "failure_message" "text",
    "recovery_log_id" "uuid",
    CONSTRAINT "monitoring_snapshots_check_result_check" CHECK (("check_result" = ANY (ARRAY['CHANGE_DETECTED'::"text", 'NO_CHANGE'::"text", 'CHECK_FAILED'::"text", 'STALE'::"text", 'FIRST_SNAPSHOT'::"text"]))),
    CONSTRAINT "monitoring_snapshots_pipeline_status_check" CHECK (("pipeline_status" = ANY (ARRAY['PENDING'::"text", 'PROCESSING'::"text", 'COMPLETE'::"text", 'FAILED'::"text", 'SKIPPED'::"text"])))
);


ALTER TABLE "public"."monitoring_snapshots" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."notification_eligibility" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "trip_id" "uuid" NOT NULL,
    "alert_id" "uuid" NOT NULL,
    "monitoring_event_id" "uuid",
    "eligible" boolean DEFAULT false NOT NULL,
    "eligibility_reason" "text",
    "channel_preferences" "jsonb" DEFAULT '{}'::"jsonb",
    "suppressed" boolean DEFAULT false NOT NULL,
    "suppression_reason" "text",
    "evaluated_at" timestamp with time zone DEFAULT "now"(),
    "created_at" timestamp with time zone DEFAULT "now"(),
    "priority" "text",
    "urgency" "text",
    "preferred_channel" "text" DEFAULT 'IN_APP'::"text",
    "eligible_at" timestamp with time zone,
    "defer_until" timestamp with time zone,
    "quiet_period_applied" boolean DEFAULT false,
    "duplicate_suppressed" boolean DEFAULT false,
    "confidence_gate_applied" boolean DEFAULT false,
    "preferences_snapshot" "jsonb",
    "channel" "text"
);


ALTER TABLE "public"."notification_eligibility" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."oauth_states" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "provider" "text" NOT NULL,
    "state" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "expires_at" timestamp with time zone DEFAULT ("now"() + '00:10:00'::interval) NOT NULL
);


ALTER TABLE "public"."oauth_states" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."offline_manifests" (
    "trip_id" "uuid" NOT NULL,
    "version" integer DEFAULT 1 NOT NULL,
    "built_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "sections" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "total_bytes" integer DEFAULT 0 NOT NULL
);


ALTER TABLE "public"."offline_manifests" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."offline_trip_packs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "trip_id" "uuid" NOT NULL,
    "pack_status" "text" DEFAULT 'NOT_CREATED'::"text" NOT NULL,
    "itinerary_version_id" "text",
    "data_version" integer DEFAULT 1,
    "storage_status" "text" DEFAULT 'PENDING'::"text",
    "selected_document_ids" "uuid"[],
    "selected_information_ids" "uuid"[],
    "pack_data" "jsonb",
    "pack_size_bytes" integer,
    "generated_at" timestamp with time zone,
    "last_updated_at" timestamp with time zone,
    "error_message" "text",
    "settings" "jsonb" DEFAULT '{"include_notes": true, "auto_mark_stale": true, "include_addresses": true, "include_documents": true, "include_emergency_contacts": true, "include_reservation_details": true}'::"jsonb",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "offline_trip_packs_pack_status_check" CHECK (("pack_status" = ANY (ARRAY['NOT_CREATED'::"text", 'PREPARING'::"text", 'READY'::"text", 'OUTDATED'::"text", 'ERROR'::"text"])))
);


ALTER TABLE "public"."offline_trip_packs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."onboarding_completions" (
    "user_id" "uuid" NOT NULL,
    "completed_at" timestamp with time zone NOT NULL,
    "skipped" boolean DEFAULT false NOT NULL
);


ALTER TABLE "public"."onboarding_completions" OWNER TO "postgres";


COMMENT ON TABLE "public"."onboarding_completions" IS 'Auth-uuid axis. user_id is auth.uid(), FK to auth.users(id). Settled 2026-09-20 alongside traveler_profiles and profile_signals. To reach this from a platform usr_<hex> id, bridge through auth_identities.provider_subject — matching on provider_subject ALONE, never on the provider column, which varies by sign-in method.';



COMMENT ON COLUMN "public"."onboarding_completions"."user_id" IS 'auth.uid(), not a platform usr_<hex> id. Was TEXT until 2026-09-20, which would have accepted either and silently split one person across two rows.';



CREATE TABLE IF NOT EXISTS "public"."operation_attempts" (
    "attempt_id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "operation_id" "uuid" NOT NULL,
    "attempt_number" integer NOT NULL,
    "retry_count" integer GENERATED ALWAYS AS (GREATEST(("attempt_number" - 1), 0)) STORED NOT NULL,
    "started_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "completed_at" timestamp with time zone,
    "status" "text" DEFAULT 'IN_PROGRESS'::"text" NOT NULL,
    "failure_classification" "text",
    "error_code" "text",
    "error_reference" "text",
    "retry_scheduled_at" timestamp with time zone,
    "retry_delay_ms" integer,
    "next_attempt_at" timestamp with time zone,
    "execution_owner_id" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "calculated_backoff_ms" integer,
    "capped_delay_ms" integer,
    "jitter_multiplier" numeric(5,4),
    "retry_reason" "text",
    CONSTRAINT "chk_attempt_status" CHECK (("status" = ANY (ARRAY['IN_PROGRESS'::"text", 'SUCCESS'::"text", 'FAILED'::"text", 'CANCELLED'::"text", 'UNKNOWN'::"text"])))
);


ALTER TABLE "public"."operation_attempts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."operation_locks" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "operation_id" "text" NOT NULL,
    "attempt_id" "uuid" NOT NULL,
    "lock_owner" "text" NOT NULL,
    "acquired_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "expires_at" timestamp with time zone NOT NULL,
    "last_renewed_at" timestamp with time zone,
    "trip_id" "uuid",
    "operation_type" "text",
    "attempt_number" integer DEFAULT 1 NOT NULL,
    "current_state" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."operation_locks" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."outbox_items" (
    "id" "text" NOT NULL,
    "user_id" "text" NOT NULL,
    "idempotency_key" "text" NOT NULL,
    "operation" "text" NOT NULL,
    "payload" "jsonb" NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "attempts" integer DEFAULT 0 NOT NULL,
    "last_error" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "processed_at" timestamp with time zone,
    CONSTRAINT "outbox_items_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'processing'::"text", 'done'::"text", 'failed'::"text"])))
);


ALTER TABLE "public"."outbox_items" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."pace_analyses" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "trip_id" "uuid" NOT NULL,
    "itinerary_id" "uuid",
    "user_id" "uuid" NOT NULL,
    "status" "text" DEFAULT 'analyzing'::"text" NOT NULL,
    "overall_pace" "text",
    "trip_energy_score" integer,
    "relaxed_days" integer DEFAULT 0,
    "balanced_days" integer DEFAULT 0,
    "busy_days" integer DEFAULT 0,
    "overloaded_days" integer DEFAULT 0,
    "highest_walking_day" integer,
    "highest_intensity_day" integer,
    "total_free_time_minutes" integer,
    "pace_warnings" "jsonb",
    "consecutive_busy_sequences" "jsonb",
    "daily_pace_analysis" "jsonb",
    "activity_intensity_map" "jsonb",
    "pace_opportunities" "jsonb",
    "user_summary" "jsonb",
    "preferences_snapshot" "jsonb",
    "analyzed_at" timestamp with time zone DEFAULT "now"(),
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."pace_analyses" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."packing_items" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "trip_id" "uuid" NOT NULL,
    "title" "text" NOT NULL,
    "category" "text",
    "quantity" integer,
    "packed" boolean DEFAULT false NOT NULL,
    "assigned_to" "text",
    "created_by" "uuid" DEFAULT "auth"."uid"(),
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "sort_order" integer DEFAULT 0 NOT NULL,
    CONSTRAINT "packing_items_assigned_to_check" CHECK ((("assigned_to" IS NULL) OR ("char_length"("assigned_to") <= 64))),
    CONSTRAINT "packing_items_category_check" CHECK ((("category" IS NULL) OR ("char_length"("category") <= 40))),
    CONSTRAINT "packing_items_quantity_check" CHECK ((("quantity" IS NULL) OR (("quantity" >= 1) AND ("quantity" <= 999)))),
    CONSTRAINT "packing_items_title_check" CHECK ((("char_length"("btrim"("title")) >= 1) AND ("char_length"("btrim"("title")) <= 200)))
);


ALTER TABLE "public"."packing_items" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."performance_metrics" (
    "id" bigint NOT NULL,
    "endpoint" character varying(255),
    "response_time_p50" integer,
    "response_time_p95" integer,
    "response_time_p99" integer,
    "error_rate_percent" numeric(5,2),
    "cache_hit_rate_percent" numeric(5,2),
    "measurement_date" "date",
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."performance_metrics" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."performance_metrics_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."performance_metrics_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."performance_metrics_id_seq" OWNED BY "public"."performance_metrics"."id";



CREATE TABLE IF NOT EXISTS "public"."personal_calibration" (
    "user_id" "text" NOT NULL,
    "category" "text" NOT NULL,
    "ratio" numeric(5,3) DEFAULT 1.0 NOT NULL,
    "trip_count" integer DEFAULT 0 NOT NULL,
    "computed_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."personal_calibration" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."phrase_cards" (
    "id" "text" DEFAULT ("gen_random_uuid"())::"text" NOT NULL,
    "country_code" character(2) NOT NULL,
    "context" "text" NOT NULL,
    "phrase_en" "text" NOT NULL,
    "phrase_local" "text" NOT NULL,
    "pronunciation" "text",
    "notes" "text"
);


ALTER TABLE "public"."phrase_cards" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."pipeline_recovery_log" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid",
    "trip_id" "uuid",
    "operation" "text" NOT NULL,
    "related_object_type" "text",
    "related_object_id" "uuid",
    "failure_type" "text" NOT NULL,
    "failure_message" "text",
    "failure_detail" "jsonb",
    "recovery_status" "text" DEFAULT 'PENDING'::"text",
    "retry_count" integer DEFAULT 0,
    "max_retries" integer DEFAULT 3,
    "last_retry_at" timestamp with time zone,
    "recovered_at" timestamp with time zone,
    "last_successful_state" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "operation_id" "text",
    "stage" "text",
    "failure_type_classification" "text",
    "failure_message_internal" "text",
    "max_retry_count" integer DEFAULT 3,
    "next_retry_at" timestamp with time zone,
    "retry_policy" "jsonb",
    "failure_classification" "text" DEFAULT 'UNKNOWN'::"text",
    "attempt_number" integer DEFAULT 1,
    "started_at" timestamp with time zone,
    "completed_at" timestamp with time zone,
    "retry_scheduled_at" timestamp with time zone,
    "retry_delay_ms" integer,
    "jitter_percentage" numeric,
    "next_attempt_at" timestamp with time zone,
    "outcome" "text",
    "cancelled_reason" "text",
    "requested_at" timestamp with time zone,
    "attempt_started_at" timestamp with time zone,
    "attempt_completed_at" timestamp with time zone,
    "failed_at" timestamp with time zone,
    "retry_started_at" timestamp with time zone,
    "terminal_at" timestamp with time zone,
    "terminal_state_reason" "text",
    "clock_skew_detected" boolean DEFAULT false,
    "clock_skew_raw_timestamps" "jsonb",
    "duplicate_retry_blocked" boolean DEFAULT false,
    "operation_type" "text",
    "stale_check_passed" boolean,
    "stale_check_details" "jsonb",
    "late_failure_received" boolean DEFAULT false,
    "late_failure_details" "jsonb",
    "transition_log" "jsonb" DEFAULT '[]'::"jsonb",
    "attempt_id" "uuid",
    "lock_acquired_at" timestamp with time zone,
    "lock_released_at" timestamp with time zone,
    "lock_owner" "text",
    "concurrency_conflict_count" integer DEFAULT 0,
    "concurrency_conflict_log" "jsonb" DEFAULT '[]'::"jsonb",
    "calculated_backoff_ms" integer,
    "capped_delay_ms" integer,
    "jitter_multiplier" numeric(5,4),
    "retry_reason" "text",
    CONSTRAINT "pipeline_recovery_log_recovery_status_check" CHECK ((("recovery_status" IS NULL) OR ("recovery_status" = ANY (ARRAY['OPERATION_REQUESTED'::"text", 'ATTEMPTING'::"text", 'FAILED'::"text", 'SUCCESS'::"text", 'PENDING'::"text", 'PROCESSING'::"text", 'RETRY_PENDING'::"text", 'RETRYING'::"text", 'RECOVERED'::"text", 'PERMANENT_FAILURE'::"text", 'SOURCE_UNAVAILABLE'::"text", 'CANCELLED_STALE'::"text", 'CANCELLED'::"text", 'NOT_SUPPORTED'::"text", 'INVALID'::"text", 'DATA_CONFLICT'::"text", 'AUTHORIZATION_REQUIRED'::"text", 'EXECUTION_FAILED'::"text", 'RECALCULATION_FAILED'::"text", 'UNKNOWN'::"text", 'FAILED_PERMANENTLY'::"text", 'NOT_REQUIRED'::"text"]))))
);


ALTER TABLE "public"."pipeline_recovery_log" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."place_reports" (
    "id" "text" NOT NULL,
    "place_id" "text" NOT NULL,
    "reporter_id" "text" NOT NULL,
    "trip_id" "uuid",
    "kind" "text" NOT NULL,
    "note" "text",
    "photo_url" "text",
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "override_data" "jsonb",
    "expires_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "place_reports_kind_check" CHECK (("kind" = ANY (ARRAY['wrong_hours'::"text", 'closed_permanently'::"text", 'wrong_location'::"text", 'wrong_phone_website'::"text", 'other'::"text"]))),
    CONSTRAINT "place_reports_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'approved'::"text", 'rejected'::"text"])))
);


ALTER TABLE "public"."place_reports" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."plan_changes" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "trip_id" "uuid" NOT NULL,
    "itinerary_id" "uuid",
    "previous_itinerary_id" "uuid",
    "user_id" "uuid" NOT NULL,
    "user_request" "text" NOT NULL,
    "conversation_history" "jsonb" DEFAULT '[]'::"jsonb",
    "interpretation" "jsonb",
    "proposed_changes" "jsonb",
    "applied_changes" "jsonb",
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "requires_clarification" boolean DEFAULT false,
    "clarification_question" "text",
    "response_message" "text",
    "change_summary" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."plan_changes" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."planning_sessions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "trip_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "user_input" "text" NOT NULL,
    "extracted_preferences" "jsonb",
    "status" "text" DEFAULT 'pending'::"text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."planning_sessions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."platform_connections" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "platform_id" "text" NOT NULL,
    "connection_status" "text" DEFAULT 'DISCONNECTED'::"text" NOT NULL,
    "encrypted_credentials" "jsonb",
    "external_user_id" "text",
    "display_name" "text",
    "connected_at" timestamp with time zone,
    "last_synced_at" timestamp with time zone,
    "last_error" "text",
    "sync_enabled" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "platform_connections_connection_status_check" CHECK (("connection_status" = ANY (ARRAY['CONNECTED'::"text", 'DISCONNECTED'::"text", 'ERROR'::"text", 'EXPIRED'::"text", 'PENDING'::"text"])))
);


ALTER TABLE "public"."platform_connections" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."platform_users" (
    "id" "text" NOT NULL,
    "email" "public"."citext",
    "display_name" "text" NOT NULL,
    "home_currency" character(3) DEFAULT 'USD'::"bpchar" NOT NULL,
    "home_tz" "text" DEFAULT 'UTC'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "deleted_at" timestamp with time zone
);


ALTER TABLE "public"."platform_users" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."playbook_step_completions" (
    "trip_id" "uuid" NOT NULL,
    "disruption_id" "text" NOT NULL,
    "step_id" "text" NOT NULL,
    "member_id" "text" NOT NULL,
    "done" boolean DEFAULT false NOT NULL,
    "done_at" timestamp with time zone
);


ALTER TABLE "public"."playbook_step_completions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."playbooks" (
    "key" "text" NOT NULL,
    "version" integer DEFAULT 1 NOT NULL,
    "title" "text" NOT NULL,
    "applies_when" "jsonb" NOT NULL,
    "steps" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "rights" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "reviewed_at" "date" NOT NULL
);


ALTER TABLE "public"."playbooks" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."poll_options" (
    "id" "text" NOT NULL,
    "poll_id" "text",
    "text" "text" NOT NULL,
    "display_order" integer DEFAULT 0,
    "vote_count" integer DEFAULT 0,
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."poll_options" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."poll_options_v2" (
    "id" "text" NOT NULL,
    "poll_id" "text" NOT NULL,
    "label" "text" NOT NULL,
    "linked_ref" "jsonb",
    "cost_per_person_minor" bigint,
    "cost_currency" character(3),
    "opt_in" boolean DEFAULT false NOT NULL,
    "sort" integer DEFAULT 0 NOT NULL
);


ALTER TABLE "public"."poll_options_v2" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."poll_votes" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "poll_id" "text",
    "user_id" "uuid",
    "option_id" "text",
    "rank" integer DEFAULT 1,
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."poll_votes" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."polls" (
    "id" "text" NOT NULL,
    "group_id" "text" NOT NULL,
    "trip_id" "uuid" NOT NULL,
    "question" "text" NOT NULL,
    "description" "text",
    "strategy" "text" DEFAULT 'majority'::"text" NOT NULL,
    "voting_threshold" numeric(5,2) DEFAULT 50 NOT NULL,
    "created_by" "uuid",
    "status" "text" DEFAULT 'open'::"text" NOT NULL,
    "closed_at" timestamp with time zone,
    "result_winner" "text",
    "result_consensus" boolean,
    "result_distribution" "jsonb",
    "result_threshold_met" boolean,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "polls_status_check" CHECK (("status" = ANY (ARRAY['open'::"text", 'closed'::"text"]))),
    CONSTRAINT "polls_strategy_check" CHECK (("strategy" = ANY (ARRAY['majority'::"text", 'consensus'::"text", 'ranked-choice'::"text"]))),
    CONSTRAINT "polls_voting_threshold_check" CHECK ((("voting_threshold" >= (0)::numeric) AND ("voting_threshold" <= (100)::numeric)))
);


ALTER TABLE "public"."polls" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."polls_v2" (
    "id" "text" NOT NULL,
    "trip_id" "uuid" NOT NULL,
    "question" "text" NOT NULL,
    "description" "text",
    "strategy" "text" NOT NULL,
    "quorum_pct" integer DEFAULT 60 NOT NULL,
    "pass_threshold_pct" integer,
    "secret" boolean DEFAULT false NOT NULL,
    "eligible_member_ids" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "closes_at" timestamp with time zone,
    "closed_at" timestamp with time zone,
    "allow_split" boolean DEFAULT false NOT NULL,
    "linked_ref" "jsonb",
    "status" "text" DEFAULT 'open'::"text" NOT NULL,
    "result" "jsonb",
    "tie_break_seed" "text",
    "created_by" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "version" integer DEFAULT 1 NOT NULL,
    "extended_once" boolean DEFAULT false NOT NULL,
    CONSTRAINT "polls_v2_status_check" CHECK (("status" = ANY (ARRAY['open'::"text", 'closed'::"text", 'cancelled'::"text"]))),
    CONSTRAINT "polls_v2_strategy_check" CHECK (("strategy" = ANY (ARRAY['majority'::"text", 'approval'::"text", 'score'::"text", 'ranked_irv'::"text", 'borda'::"text", 'consensus'::"text"])))
);


ALTER TABLE "public"."polls_v2" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."pre_trip_readiness" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "trip_id" "uuid" NOT NULL,
    "overall_status" "text" DEFAULT 'UNKNOWN'::"text" NOT NULL,
    "category_statuses" "jsonb" DEFAULT '{}'::"jsonb",
    "open_item_count" integer DEFAULT 0,
    "critical_item_count" integer DEFAULT 0,
    "high_item_count" integer DEFAULT 0,
    "upcoming_deadline_count" integer DEFAULT 0,
    "confidence" "text" DEFAULT 'LOW'::"text" NOT NULL,
    "summary_message" "text",
    "days_until_trip" integer,
    "trip_phase" "text" DEFAULT 'PRE_TRIP'::"text",
    "calculated_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "source" "text",
    "previous_readiness_score" numeric,
    "itinerary_version_id" "uuid",
    CONSTRAINT "pre_trip_readiness_confidence_check" CHECK (("confidence" = ANY (ARRAY['HIGH'::"text", 'MEDIUM'::"text", 'LOW'::"text"]))),
    CONSTRAINT "pre_trip_readiness_overall_status_check" CHECK (("overall_status" = ANY (ARRAY['READY'::"text", 'MOSTLY_READY'::"text", 'NEEDS_ATTENTION'::"text", 'UNKNOWN'::"text"]))),
    CONSTRAINT "pre_trip_readiness_trip_phase_check" CHECK (("trip_phase" = ANY (ARRAY['PRE_TRIP'::"text", 'IN_PROGRESS'::"text", 'POST_TRIP'::"text", 'UNKNOWN'::"text"])))
);


ALTER TABLE "public"."pre_trip_readiness" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."pre_trip_tasks" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "trip_id" "uuid" NOT NULL,
    "title" "text" NOT NULL,
    "description" "text",
    "category" "text" DEFAULT 'OTHER'::"text",
    "source" "text" DEFAULT 'USER_CREATED'::"text" NOT NULL,
    "due_date" "date",
    "priority" "text" DEFAULT 'MEDIUM'::"text" NOT NULL,
    "status" "text" DEFAULT 'OPEN'::"text" NOT NULL,
    "completed_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "pre_trip_tasks_category_check" CHECK (("category" = ANY (ARRAY['RESERVATIONS'::"text", 'TRANSPORTATION'::"text", 'ACCOMMODATION'::"text", 'DOCUMENTS'::"text", 'TIMING'::"text", 'MONEY'::"text", 'PREPARATION'::"text", 'COMMUNICATION'::"text", 'SAFETY_CONTINGENCY'::"text", 'OTHER'::"text"]))),
    CONSTRAINT "pre_trip_tasks_priority_check" CHECK (("priority" = ANY (ARRAY['CRITICAL'::"text", 'HIGH'::"text", 'MEDIUM'::"text", 'LOW'::"text"]))),
    CONSTRAINT "pre_trip_tasks_source_check" CHECK (("source" = ANY (ARRAY['USER_CREATED'::"text", 'TRAVELOS_DETECTED'::"text", 'RESERVATION_INTELLIGENCE'::"text"]))),
    CONSTRAINT "pre_trip_tasks_status_check" CHECK (("status" = ANY (ARRAY['OPEN'::"text", 'COMPLETED'::"text", 'DISMISSED'::"text"])))
);


ALTER TABLE "public"."pre_trip_tasks" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."prediction_models" (
    "user_id" "text" NOT NULL,
    "rating_count" integer DEFAULT 0 NOT NULL,
    "bias" real DEFAULT 0 NOT NULL,
    "beta_aff" real DEFAULT 0.4 NOT NULL,
    "beta_q" real DEFAULT 0.3 NOT NULL,
    "beta_w" real DEFAULT '-0.2'::numeric NOT NULL,
    "beta_f" real DEFAULT '-0.3'::numeric NOT NULL,
    "beta_g" real DEFAULT 0.2 NOT NULL,
    "beta_t" real DEFAULT 0.15 NOT NULL,
    "residual_std" real DEFAULT 0.8 NOT NULL,
    "calibrated" boolean DEFAULT false NOT NULL,
    "within_1_star_pct" real,
    "interval_coverage_pct" real,
    "last_calibrated_at" timestamp with time zone,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."prediction_models" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."prep_items" (
    "id" "text" NOT NULL,
    "trip_id" "uuid" NOT NULL,
    "member_id" "text" NOT NULL,
    "destination_code" character(2) NOT NULL,
    "kind" "text" NOT NULL,
    "title" "text" NOT NULL,
    "detail" "text" NOT NULL,
    "due_date" "date",
    "source_url" "text",
    "status" "text" DEFAULT 'todo'::"text" NOT NULL,
    "severity" "text" DEFAULT 'info'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "prep_items_kind_check" CHECK (("kind" = ANY (ARRAY['passport_validity'::"text", 'authorization'::"text", 'visa_check'::"text", 'health_consult'::"text", 'medications'::"text", 'dietary_card'::"text", 'insurance_coverage'::"text", 'insurance_activity'::"text", 'altitude'::"text", 'jetlag'::"text", 'emergency_numbers'::"text", 'custom'::"text"]))),
    CONSTRAINT "prep_items_severity_check" CHECK (("severity" = ANY (ARRAY['info'::"text", 'important'::"text", 'blocking'::"text"]))),
    CONSTRAINT "prep_items_status_check" CHECK (("status" = ANY (ARRAY['todo'::"text", 'done'::"text", 'not_applicable'::"text"])))
);


ALTER TABLE "public"."prep_items" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."presence" (
    "trip_id" "uuid" NOT NULL,
    "member_id" "text" NOT NULL,
    "view" "text" NOT NULL,
    "editing_item_id" "text",
    "last_seen_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."presence" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."price_snapshots" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "reservation_id" "text" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "provider" "text" NOT NULL,
    "price" numeric(10,2) NOT NULL,
    "currency" "text" DEFAULT 'USD'::"text" NOT NULL,
    "room_rate" numeric(10,2),
    "taxes" numeric(10,2),
    "fees" numeric(10,2),
    "recorded_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."price_snapshots" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."privacy_controls" (
    "user_id" "text" NOT NULL,
    "profile_learning_paused" boolean DEFAULT false NOT NULL,
    "use_profile_in_groups" boolean DEFAULT true NOT NULL,
    "copilot_memory_enabled" boolean DEFAULT true NOT NULL,
    "serendipity_enabled" boolean DEFAULT true NOT NULL,
    "personalized_ranking" boolean DEFAULT true NOT NULL,
    "marketing_emails" boolean DEFAULT false NOT NULL,
    "diagnostics_sharing" boolean DEFAULT false NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."privacy_controls" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."profile_signals" (
    "id" "text" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "trip_id" "uuid",
    "context" "text" NOT NULL,
    "kind" "text" NOT NULL,
    "entity_ref" "jsonb",
    "features" "jsonb" NOT NULL,
    "strength" real NOT NULL,
    "occurred_at" timestamp with time zone NOT NULL,
    "excluded" boolean DEFAULT false NOT NULL,
    CONSTRAINT "profile_signals_context_check" CHECK (("context" = ANY (ARRAY['all'::"text", 'solo'::"text", 'couple'::"text", 'friends'::"text", 'family'::"text", 'business'::"text"]))),
    CONSTRAINT "profile_signals_kind_check" CHECK (("kind" = ANY (ARRAY['onboarding_answer'::"text", 'rated'::"text", 'kept'::"text", 'removed'::"text", 'rec_accepted'::"text", 'rec_dismissed'::"text", 'thumbs'::"text", 'spent'::"text", 'search'::"text", 'past_trip_rating'::"text"])))
);


ALTER TABLE "public"."profile_signals" OWNER TO "postgres";


COMMENT ON TABLE "public"."profile_signals" IS 'Individual preference signals feeding traveler_profiles. IDENTITY AXIS: Supabase auth uuid — user_id is auth.uid(), FK to auth.users(id). This is NOT the platform "usr_" axis used by platform_users and trip_members; never write a usr_ id here (settled Q2.28, 2026-09-20).';



COMMENT ON COLUMN "public"."profile_signals"."user_id" IS 'auth.users(id) / auth.uid(). To reach these rows from a platform "usr_" id, go through auth_identities: match auth_identities.provider_subject (the auth uuid as text) — on provider_subject ALONE, never filtering on provider.';



CREATE TABLE IF NOT EXISTS "public"."profiles" (
    "id" "uuid" NOT NULL,
    "email" "text",
    "name" "text",
    "avatar_url" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "phone" "text",
    "phone_verified" boolean DEFAULT false NOT NULL,
    "email_verified" boolean DEFAULT false NOT NULL,
    "expo_push_token" "text"
);


ALTER TABLE "public"."profiles" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."provider_cache" (
    "key" "text" NOT NULL,
    "provider" "text" NOT NULL,
    "payload" "jsonb" NOT NULL,
    "fetched_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "expires_at" timestamp with time zone NOT NULL
);


ALTER TABLE "public"."provider_cache" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."provider_circuit" (
    "provider" "text" NOT NULL,
    "state" "text" DEFAULT 'closed'::"text" NOT NULL,
    "consecutive_failures" integer DEFAULT 0 NOT NULL,
    "opened_at" timestamp with time zone,
    "last_success_at" timestamp with time zone,
    "last_error" "text",
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "provider_circuit_state_check" CHECK (("state" = ANY (ARRAY['closed'::"text", 'open'::"text", 'half-open'::"text"])))
);


ALTER TABLE "public"."provider_circuit" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."provider_quota" (
    "provider" "text" NOT NULL,
    "date" "date" DEFAULT CURRENT_DATE NOT NULL,
    "request_count" integer DEFAULT 0 NOT NULL
);


ALTER TABLE "public"."provider_quota" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."rate_limit_buckets" (
    "id" "text" NOT NULL,
    "bucket_key" "text" NOT NULL,
    "bucket_type" "text" NOT NULL,
    "service" "text",
    "request_count" integer DEFAULT 0 NOT NULL,
    "window_start" timestamp with time zone DEFAULT "now"() NOT NULL,
    "window_end" timestamp with time zone NOT NULL,
    "tier" "text" DEFAULT 'free'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "rate_limit_buckets_bucket_type_check" CHECK (("bucket_type" = ANY (ARRAY['global'::"text", 'strict'::"text", 'user_quota'::"text"]))),
    CONSTRAINT "rate_limit_buckets_tier_check" CHECK (("tier" = ANY (ARRAY['free'::"text", 'premium'::"text", 'enterprise'::"text"])))
);


ALTER TABLE "public"."rate_limit_buckets" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."rating_prompt_state" (
    "user_id" "text" NOT NULL,
    "consecutive_skips" integer DEFAULT 0 NOT NULL,
    "paused_until" timestamp with time zone,
    "last_prompt_at" timestamp with time zone,
    "prompts_today" integer DEFAULT 0 NOT NULL,
    "prompts_today_date" "date"
);


ALTER TABLE "public"."rating_prompt_state" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."readiness_items" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "trip_id" "uuid" NOT NULL,
    "category" "text" NOT NULL,
    "title" "text" NOT NULL,
    "description" "text",
    "severity" "text" DEFAULT 'MEDIUM'::"text" NOT NULL,
    "priority" integer DEFAULT 50,
    "source" "text" DEFAULT 'TRAVELOS_DETECTED'::"text" NOT NULL,
    "source_reference" "text",
    "affected_date" "date",
    "status" "text" DEFAULT 'OPEN'::"text" NOT NULL,
    "confidence" "text" DEFAULT 'MEDIUM'::"text" NOT NULL,
    "recommendation" "text",
    "user_explanation" "text",
    "dismissed_at" timestamp with time zone,
    "resolved_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "readiness_items_category_check" CHECK (("category" = ANY (ARRAY['RESERVATIONS'::"text", 'TRANSPORTATION'::"text", 'ACCOMMODATION'::"text", 'DOCUMENTS'::"text", 'TIMING'::"text", 'MONEY'::"text", 'PREPARATION'::"text", 'COMMUNICATION'::"text", 'SAFETY_CONTINGENCY'::"text", 'OTHER'::"text"]))),
    CONSTRAINT "readiness_items_confidence_check" CHECK (("confidence" = ANY (ARRAY['HIGH'::"text", 'MEDIUM'::"text", 'LOW'::"text"]))),
    CONSTRAINT "readiness_items_severity_check" CHECK (("severity" = ANY (ARRAY['CRITICAL'::"text", 'HIGH'::"text", 'MEDIUM'::"text", 'LOW'::"text", 'INFO'::"text"]))),
    CONSTRAINT "readiness_items_source_check" CHECK (("source" = ANY (ARRAY['TRAVELOS_DETECTED'::"text", 'USER_CREATED'::"text", 'RESERVATION_INTELLIGENCE'::"text", 'TRIP_HEALTH'::"text", 'ITINERARY_VALIDATION'::"text"]))),
    CONSTRAINT "readiness_items_status_check" CHECK (("status" = ANY (ARRAY['OPEN'::"text", 'COMPLETED'::"text", 'EXPLAINED'::"text", 'DISMISSED'::"text", 'RESOLVED'::"text"])))
);


ALTER TABLE "public"."readiness_items" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."recommendation_engagement" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid",
    "recommendation_id" "text" NOT NULL,
    "engagement_type" "text" NOT NULL,
    "location" "text",
    "category" "text",
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."recommendation_engagement" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."recommendation_trending" (
    "recommendation_id" "text" NOT NULL,
    "location" "text",
    "category" "text",
    "total_views" integer DEFAULT 0,
    "total_saves" integer DEFAULT 0,
    "total_shares" integer DEFAULT 0,
    "trending_score" numeric(5,1) DEFAULT 0,
    "trending_category" "text" DEFAULT 'new'::"text",
    "trending_rank" integer,
    "is_new" boolean DEFAULT true,
    "last_calculated" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."recommendation_trending" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."recommendations" (
    "id" "text" NOT NULL,
    "trip_id" "uuid",
    "user_id" "uuid",
    "category" "text" NOT NULL,
    "location" "text" NOT NULL,
    "name" "text" NOT NULL,
    "description" "text",
    "rating" numeric(3,1) DEFAULT 0,
    "review_count" integer DEFAULT 0,
    "price" "text" DEFAULT '$$'::"text",
    "image_url" "text",
    "booking_url" "text",
    "latitude" numeric(10,6),
    "longitude" numeric(10,6),
    "tags" "text"[] DEFAULT '{}'::"text"[],
    "tagline" "text",
    "source" "text" NOT NULL,
    "score_preferences" numeric(5,1) DEFAULT 0,
    "score_proximity" numeric(5,1) DEFAULT 0,
    "score_timing" numeric(5,1) DEFAULT 0,
    "score_quality" numeric(5,1) DEFAULT 0,
    "score_budget" numeric(5,1) DEFAULT 0,
    "score_context" numeric(5,1) DEFAULT 0,
    "overall_score" numeric(5,1) DEFAULT 0,
    "place_id" "text",
    "open_now" boolean,
    "phone" "text",
    "fetched_at" timestamp with time zone DEFAULT "now"(),
    "expires_at" timestamp with time zone DEFAULT ("now"() + '06:00:00'::interval),
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."recommendations" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."release_checklist" (
    "item" "text" NOT NULL,
    "category" "text" NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "notes" "text",
    "checked_at" timestamp with time zone,
    "checked_by" "text",
    CONSTRAINT "release_checklist_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'pass'::"text", 'fail'::"text", 'na'::"text"])))
);


ALTER TABLE "public"."release_checklist" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."replan_applied" (
    "id" "text" NOT NULL,
    "trip_id" "uuid" NOT NULL,
    "alternative_id" "text" NOT NULL,
    "ops" "jsonb" NOT NULL,
    "base_version" integer NOT NULL,
    "applied_by" "text" NOT NULL,
    "undo_expires_at" timestamp with time zone NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."replan_applied" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."replan_cache" (
    "id" "text" NOT NULL,
    "trip_id" "uuid" NOT NULL,
    "dates" "text"[] NOT NULL,
    "trigger_kind" "text" NOT NULL,
    "case_id" "text",
    "alternatives" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "baseline" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "seed" "text" NOT NULL,
    "plan_version" integer DEFAULT 0 NOT NULL,
    "weather_hash" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "expires_at" timestamp with time zone NOT NULL
);


ALTER TABLE "public"."replan_cache" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."reservation_poll_schedule" (
    "reservation_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "platform_id" "text",
    "last_polled_at" timestamp with time zone,
    "next_poll_at" timestamp with time zone,
    "poll_interval_ms" integer DEFAULT 86400000 NOT NULL,
    "consecutive_failures" integer DEFAULT 0 NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."reservation_poll_schedule" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."reservation_price_history" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "reservation_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "platform_id" "text",
    "price_amount" numeric(12,2) NOT NULL,
    "currency" "text" DEFAULT 'USD'::"text" NOT NULL,
    "recorded_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "source" "text" DEFAULT 'poll'::"text" NOT NULL,
    "price_delta" numeric(12,2),
    "price_delta_pct" numeric(6,2),
    "availability_status" "text",
    "rooms_remaining" integer,
    "cancellation_policy_type" "text",
    "raw_response" "jsonb",
    CONSTRAINT "reservation_price_history_availability_status_check" CHECK (("availability_status" = ANY (ARRAY['AVAILABLE'::"text", 'LIMITED'::"text", 'UNAVAILABLE'::"text", 'UNKNOWN'::"text"]))),
    CONSTRAINT "reservation_price_history_source_check" CHECK (("source" = ANY (ARRAY['poll'::"text", 'webhook'::"text", 'manual'::"text", 'initial'::"text"])))
);


ALTER TABLE "public"."reservation_price_history" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."reservations" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "trip_id" "uuid" NOT NULL,
    "reservation_type" "text" NOT NULL,
    "provider_name" "text",
    "confirmation_number" "text",
    "reservation_status" "text" DEFAULT 'UNKNOWN'::"text" NOT NULL,
    "traveler_names" "text"[],
    "start_date" "date",
    "start_time" time without time zone,
    "end_date" "date",
    "end_time" time without time zone,
    "timezone" "text",
    "location_name" "text",
    "address" "text",
    "city" "text",
    "state_or_region" "text",
    "country" "text",
    "latitude" double precision,
    "longitude" double precision,
    "details" "jsonb" DEFAULT '{}'::"jsonb",
    "notes" "text",
    "source_type" "text" DEFAULT 'MANUAL'::"text" NOT NULL,
    "source_reference" "text",
    "confidence" "text" DEFAULT 'MEDIUM'::"text" NOT NULL,
    "data_completeness" "text" DEFAULT 'INCOMPLETE'::"text" NOT NULL,
    "needs_review" boolean DEFAULT false NOT NULL,
    "review_reason" "text",
    "possible_duplicate_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "platform_id" "text",
    "platform_reservation_id" "text",
    "current_price_amount" numeric(12,2),
    "current_price_currency" "text" DEFAULT 'USD'::"text",
    "original_price_amount" numeric(12,2),
    "price_last_checked_at" timestamp with time zone,
    "availability_status" "text" DEFAULT 'UNKNOWN'::"text",
    "cancellation_policy_type" "text",
    "cancellation_deadline" timestamp with time zone,
    "free_cancellation_until" timestamp with time zone,
    "last_synced_at" timestamp with time zone,
    "sync_source" "text" DEFAULT 'manual'::"text",
    CONSTRAINT "reservations_confidence_check" CHECK (("confidence" = ANY (ARRAY['HIGH'::"text", 'MEDIUM'::"text", 'LOW'::"text"]))),
    CONSTRAINT "reservations_data_completeness_check" CHECK (("data_completeness" = ANY (ARRAY['COMPLETE'::"text", 'MOSTLY_COMPLETE'::"text", 'INCOMPLETE'::"text"]))),
    CONSTRAINT "reservations_reservation_status_check" CHECK (("reservation_status" = ANY (ARRAY['CONFIRMED'::"text", 'PENDING'::"text", 'CANCELLED'::"text", 'COMPLETED'::"text", 'UNKNOWN'::"text"]))),
    CONSTRAINT "reservations_reservation_type_check" CHECK (("reservation_type" = ANY (ARRAY['FLIGHT'::"text", 'HOTEL'::"text", 'RENTAL_CAR'::"text", 'TRAIN'::"text", 'BUS'::"text", 'RESTAURANT'::"text", 'TOUR'::"text", 'ACTIVITY'::"text", 'EVENT'::"text", 'CRUISE'::"text", 'TRANSFER'::"text", 'OTHER'::"text"]))),
    CONSTRAINT "reservations_source_type_check" CHECK (("source_type" = ANY (ARRAY['MANUAL'::"text", 'EMAIL'::"text", 'PDF'::"text", 'SCREENSHOT'::"text", 'QR_CODE'::"text", 'IMPORT'::"text", 'OTHER'::"text"])))
);


ALTER TABLE "public"."reservations" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."rollcall_responses" (
    "rollcall_id" "text" NOT NULL,
    "member_id" "text" NOT NULL,
    "response" "text",
    "responded_at" timestamp with time zone,
    "reminder_count" integer DEFAULT 0 NOT NULL,
    CONSTRAINT "rollcall_responses_response_check" CHECK (("response" = ANY (ARRAY['safe'::"text", 'help'::"text", 'not_affected'::"text"])))
);


ALTER TABLE "public"."rollcall_responses" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."rollcalls" (
    "id" "text" NOT NULL,
    "trip_id" "uuid" NOT NULL,
    "triggered_by" "text" NOT NULL,
    "trigger_kind" "text" NOT NULL,
    "alert_ref" "jsonb",
    "status" "text" DEFAULT 'open'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "closed_at" timestamp with time zone,
    CONSTRAINT "rollcalls_status_check" CHECK (("status" = ANY (ARRAY['open'::"text", 'closed'::"text"]))),
    CONSTRAINT "rollcalls_trigger_kind_check" CHECK (("trigger_kind" = ANY (ARRAY['manual'::"text", 'alert'::"text"])))
);


ALTER TABLE "public"."rollcalls" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."safety_advisories" (
    "country_code" character(2) NOT NULL,
    "source" "text" NOT NULL,
    "level" integer,
    "headline" "text" NOT NULL,
    "regions_json" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "common_issues" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "advisory_url" "text" NOT NULL,
    "fetched_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at_source" "text",
    CONSTRAINT "safety_advisories_source_check" CHECK (("source" = ANY (ARRAY['US'::"text", 'UK'::"text"])))
);


ALTER TABLE "public"."safety_advisories" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."safety_assessments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "trip_id" "uuid",
    "destination" "text" NOT NULL,
    "risk_level" "text" DEFAULT 'low'::"text" NOT NULL,
    "threats" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "recommendations" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "advisory_level" "text",
    "assessed_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "safety_assessments_risk_level_check" CHECK (("risk_level" = ANY (ARRAY['low'::"text", 'moderate'::"text", 'high'::"text", 'extreme'::"text"])))
);


ALTER TABLE "public"."safety_assessments" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."safety_notes" (
    "id" "text" NOT NULL,
    "trip_id" "uuid" NOT NULL,
    "item_id" "text",
    "level" "text" NOT NULL,
    "text" "text" NOT NULL,
    "source" "text" NOT NULL,
    "actions" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "rule_id" "text",
    "computed_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "expires_at" timestamp with time zone,
    CONSTRAINT "safety_notes_level_check" CHECK (("level" = ANY (ARRAY['info'::"text", 'caution'::"text", 'warning'::"text"])))
);


ALTER TABLE "public"."safety_notes" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."safety_preferences" (
    "user_id" "text" NOT NULL,
    "tip_level" "text" DEFAULT 'standard'::"text" NOT NULL,
    "opt_in_topics" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    CONSTRAINT "safety_preferences_tip_level_check" CHECK (("tip_level" = ANY (ARRAY['minimal'::"text", 'standard'::"text", 'detailed'::"text"])))
);


ALTER TABLE "public"."safety_preferences" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."safety_reports" (
    "id" "text" NOT NULL,
    "trip_id" "uuid" NOT NULL,
    "reporter_id" "text" NOT NULL,
    "lat" double precision NOT NULL,
    "lng" double precision NOT NULL,
    "topic" "text" NOT NULL,
    "text" "text" NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "expires_at" timestamp with time zone NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "safety_reports_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'approved'::"text", 'rejected'::"text"]))),
    CONSTRAINT "safety_reports_text_check" CHECK (("char_length"("text") <= 500)),
    CONSTRAINT "safety_reports_topic_check" CHECK (("topic" = ANY (ARRAY['pickpocketing'::"text", 'protest'::"text", 'road_closure'::"text", 'scam'::"text", 'other'::"text"])))
);


ALTER TABLE "public"."safety_reports" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."safety_rules" (
    "id" "text" NOT NULL,
    "condition_type" "text" NOT NULL,
    "condition_params" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "note_level" "text" NOT NULL,
    "note_template" "text" NOT NULL,
    "actions" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "tip_level_min" "text" DEFAULT 'standard'::"text" NOT NULL,
    "opt_in_topic" "text",
    "enabled" boolean DEFAULT true NOT NULL,
    "version" integer DEFAULT 1 NOT NULL,
    CONSTRAINT "safety_rules_note_level_check" CHECK (("note_level" = ANY (ARRAY['info'::"text", 'caution'::"text", 'warning'::"text"]))),
    CONSTRAINT "safety_rules_tip_level_min_check" CHECK (("tip_level_min" = ANY (ARRAY['minimal'::"text", 'standard'::"text", 'detailed'::"text"])))
);


ALTER TABLE "public"."safety_rules" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."satisfaction_ledger" (
    "trip_id" "uuid" NOT NULL,
    "member_id" "text" NOT NULL,
    "poll_id" "text" NOT NULL,
    "satisfaction" real NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "satisfaction_ledger_satisfaction_check" CHECK ((("satisfaction" >= (0)::double precision) AND ("satisfaction" <= (1)::double precision)))
);


ALTER TABLE "public"."satisfaction_ledger" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."saved_recommendations" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid",
    "recommendation_id" "text" NOT NULL,
    "trip_id" "uuid",
    "name" "text" NOT NULL,
    "category" "text" NOT NULL,
    "location" "text" NOT NULL,
    "rating" numeric(3,1),
    "price" "text",
    "image_url" "text",
    "booking_url" "text",
    "overall_score" numeric(5,1),
    "tagline" "text",
    "tags" "text"[] DEFAULT '{}'::"text"[],
    "saved_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."saved_recommendations" OWNER TO "postgres";


COMMENT ON COLUMN "public"."saved_recommendations"."rating" IS 'Provider rating. NULL means no provider supplied one — it does not mean zero.';



COMMENT ON COLUMN "public"."saved_recommendations"."price" IS 'Provider price band. NULL means unrated — it does not mean mid-range.';



COMMENT ON COLUMN "public"."saved_recommendations"."overall_score" IS 'Computed score. NULL means it could not be computed — it does not mean zero.';



CREATE TABLE IF NOT EXISTS "public"."search_analytics" (
    "id" bigint NOT NULL,
    "user_id" "uuid",
    "search_query" character varying(500),
    "search_type" character varying(100),
    "search_count" integer DEFAULT 1,
    "last_searched_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."search_analytics" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."search_analytics_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."search_analytics_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."search_analytics_id_seq" OWNED BY "public"."search_analytics"."id";



CREATE TABLE IF NOT EXISTS "public"."secure_documents" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "trip_id" "uuid",
    "reservation_id" "uuid",
    "document_type" "text" DEFAULT 'OTHER'::"text" NOT NULL,
    "document_name" "text" NOT NULL,
    "issuer" "text",
    "issue_date" "date",
    "expiration_date" "date",
    "reference_number" "text",
    "storage_path" "text",
    "file_type" "text",
    "file_size_bytes" integer,
    "source" "text" DEFAULT 'MANUAL'::"text" NOT NULL,
    "extraction_confidence" "text" DEFAULT 'UNKNOWN'::"text",
    "status" "text" DEFAULT 'CURRENT'::"text" NOT NULL,
    "scope" "text" DEFAULT 'TRIP'::"text" NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "replaced_by_id" "uuid",
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "secure_documents_document_type_check" CHECK (("document_type" = ANY (ARRAY['PASSPORT'::"text", 'GOVERNMENT_ID'::"text", 'DRIVER_LICENSE'::"text", 'VISA_ENTRY_DOCUMENT'::"text", 'TRAVEL_INSURANCE'::"text", 'FLIGHT_DOCUMENT'::"text", 'BOARDING_PASS'::"text", 'HOTEL_DOCUMENT'::"text", 'RENTAL_CAR_DOCUMENT'::"text", 'TRAIN_DOCUMENT'::"text", 'BUS_DOCUMENT'::"text", 'TOUR_ACTIVITY_DOCUMENT'::"text", 'CRUISE_DOCUMENT'::"text", 'TRAVEL_AUTHORIZATION'::"text", 'OTHER'::"text"]))),
    CONSTRAINT "secure_documents_extraction_confidence_check" CHECK (("extraction_confidence" = ANY (ARRAY['HIGH'::"text", 'MEDIUM'::"text", 'LOW'::"text", 'UNKNOWN'::"text"]))),
    CONSTRAINT "secure_documents_scope_check" CHECK (("scope" = ANY (ARRAY['TRIP'::"text", 'TRAVELER'::"text"]))),
    CONSTRAINT "secure_documents_source_check" CHECK (("source" = ANY (ARRAY['MANUAL'::"text", 'UPLOAD'::"text", 'CAMERA'::"text", 'IMPORT'::"text", 'OTHER'::"text"]))),
    CONSTRAINT "secure_documents_status_check" CHECK (("status" = ANY (ARRAY['CURRENT'::"text", 'EXPIRING_SOON'::"text", 'EXPIRED'::"text", 'UNKNOWN'::"text", 'NEEDS_REVIEW'::"text"])))
);


ALTER TABLE "public"."secure_documents" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."serendipity_dismissed" (
    "user_id" "text" NOT NULL,
    "candidate_key" "text" NOT NULL,
    "dismissed_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."serendipity_dismissed" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."serendipity_preferences" (
    "user_id" "text" NOT NULL,
    "enabled" boolean DEFAULT true NOT NULL,
    "appetite" real DEFAULT 1.0 NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "serendipity_preferences_appetite_check" CHECK ((("appetite" >= (0.5)::double precision) AND ("appetite" <= (1.5)::double precision)))
);


ALTER TABLE "public"."serendipity_preferences" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."serendipity_suggestions" (
    "id" "text" NOT NULL,
    "user_id" "text" NOT NULL,
    "trip_id" "uuid" NOT NULL,
    "window_start" "text" NOT NULL,
    "window_end" "text" NOT NULL,
    "candidate_ref" "jsonb" NOT NULL,
    "scores" "jsonb" NOT NULL,
    "explanation" "text" NOT NULL,
    "action" "text",
    "dismiss_reason" "text",
    "shown_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "acted_at" timestamp with time zone,
    CONSTRAINT "serendipity_suggestions_action_check" CHECK (("action" = ANY (ARRAY['added'::"text", 'dismissed'::"text", 'ignored'::"text", 'asked_group'::"text"])))
);


ALTER TABLE "public"."serendipity_suggestions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."settlement_calculations" (
    "id" "text" DEFAULT ("gen_random_uuid"())::"text" NOT NULL,
    "trip_id" "uuid" NOT NULL,
    "group_id" "text" NOT NULL,
    "calculation_metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."settlement_calculations" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."settlement_disputes" (
    "id" "text" DEFAULT ("gen_random_uuid"())::"text" NOT NULL,
    "settlement_id" "text" NOT NULL,
    "disputed_by" "text" NOT NULL,
    "reason" "text" NOT NULL,
    "notes" "text",
    "evidence_url" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "resolved_at" timestamp with time zone,
    "resolution_notes" "text",
    "resolved_by" "text",
    "resolution" "text"
);


ALTER TABLE "public"."settlement_disputes" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."settlement_history" (
    "id" "text" DEFAULT ("gen_random_uuid"())::"text" NOT NULL,
    "settlement_id" "text" NOT NULL,
    "status_from" "text",
    "status_to" "text" NOT NULL,
    "changed_by" "text" NOT NULL,
    "change_reason" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."settlement_history" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."settlement_proofs" (
    "id" "text" DEFAULT ("gen_random_uuid"())::"text" NOT NULL,
    "settlement_id" "text" NOT NULL,
    "proof_url" "text" NOT NULL,
    "storage_path" "text",
    "file_name" "text",
    "file_size" integer,
    "mime_type" "text",
    "uploaded_by" "text" NOT NULL,
    "uploaded_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."settlement_proofs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."settlements" (
    "id" "text" NOT NULL,
    "group_id" "text" NOT NULL,
    "trip_id" "uuid" NOT NULL,
    "from_user" "uuid",
    "to_user" "uuid",
    "amount" numeric(12,2) NOT NULL,
    "currency" "text" DEFAULT 'USD'::"text" NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "settled_at" timestamp with time zone,
    "proof_url" "text",
    "dispute_reason" "text",
    "notes" "text",
    "calculation_run_id" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "settlements_amount_check" CHECK (("amount" > (0)::numeric)),
    CONSTRAINT "settlements_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'settled'::"text", 'disputed'::"text"])))
);


ALTER TABLE "public"."settlements" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."share_links" (
    "id" "text" NOT NULL,
    "trip_id" "uuid" NOT NULL,
    "created_by_member_id" "text" NOT NULL,
    "scope" "text" NOT NULL,
    "scope_ref" "text",
    "token_hash" "text" NOT NULL,
    "visibility" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "expires_at" timestamp with time zone,
    "revoked_at" timestamp with time zone,
    "view_count" integer DEFAULT 0 NOT NULL,
    "last_viewed_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "share_links_scope_check" CHECK (("scope" = ANY (ARRAY['trip'::"text", 'day'::"text", 'item'::"text", 'eta'::"text"])))
);


ALTER TABLE "public"."share_links" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."shareable_calendars" (
    "id" "text" NOT NULL,
    "trip_id" "uuid" NOT NULL,
    "share_token" "text" NOT NULL,
    "expires_at" timestamp with time zone DEFAULT ("now"() + '30 days'::interval) NOT NULL,
    "access_level" "text" DEFAULT 'view'::"text" NOT NULL,
    "created_by" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "view_count" integer DEFAULT 0 NOT NULL,
    CONSTRAINT "shareable_calendars_access_level_check" CHECK (("access_level" = ANY (ARRAY['view'::"text", 'comment'::"text", 'edit'::"text"])))
);


ALTER TABLE "public"."shareable_calendars" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."slo_metrics" (
    "id" "text" NOT NULL,
    "metric" "text" NOT NULL,
    "value" double precision NOT NULL,
    "threshold" double precision NOT NULL,
    "status" "text" NOT NULL,
    "measured_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "slo_metrics_status_check" CHECK (("status" = ANY (ARRAY['ok'::"text", 'warning'::"text", 'breach'::"text"])))
);


ALTER TABLE "public"."slo_metrics" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."support_conversations" (
    "id" "text" NOT NULL,
    "user_id" "text" NOT NULL,
    "trip_id" "uuid",
    "screen" "text" NOT NULL,
    "case_id" "text",
    "context" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "adapter" "text" DEFAULT 'mock'::"text" NOT NULL,
    "external_id" "text",
    "trip_access_granted_until" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."support_conversations" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."taxonomy_versions" (
    "version" integer NOT NULL,
    "features" "text"[] NOT NULL,
    "deployed_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."taxonomy_versions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."tips_preferences" (
    "user_id" "text" NOT NULL,
    "level" "text" DEFAULT 'essential'::"text" NOT NULL,
    "dismissed" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "tips_preferences_level_check" CHECK (("level" = ANY (ARRAY['off'::"text", 'essential'::"text", 'all'::"text"])))
);


ALTER TABLE "public"."tips_preferences" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."traffic_updates" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "trip_id" "uuid",
    "from_location" "text" NOT NULL,
    "to_location" "text" NOT NULL,
    "distance_km" numeric(8,1),
    "normal_duration_minutes" integer,
    "estimated_duration_minutes" integer,
    "delay_minutes" integer,
    "congestion_level" "text" DEFAULT 'free'::"text" NOT NULL,
    "severity" "text" DEFAULT 'low'::"text" NOT NULL,
    "recommendation" "text",
    "checked_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "traffic_updates_congestion_level_check" CHECK (("congestion_level" = ANY (ARRAY['free'::"text", 'light'::"text", 'moderate'::"text", 'heavy'::"text", 'severe'::"text"]))),
    CONSTRAINT "traffic_updates_severity_check" CHECK (("severity" = ANY (ARRAY['low'::"text", 'medium'::"text", 'high'::"text", 'critical'::"text"])))
);


ALTER TABLE "public"."traffic_updates" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."travel_alerts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "trip_id" "uuid" NOT NULL,
    "monitoring_event_id" "uuid",
    "primary_impact_id" "uuid",
    "itinerary_version_id" "text",
    "alert_group_id" "uuid",
    "alert_type" "text" NOT NULL,
    "priority" "text" DEFAULT 'INFO'::"text" NOT NULL,
    "urgency" "text" DEFAULT 'UNKNOWN'::"text" NOT NULL,
    "confidence" "text" DEFAULT 'UNKNOWN'::"text" NOT NULL,
    "title" "text" NOT NULL,
    "summary" "text" NOT NULL,
    "explanation" "text",
    "affected_entities" "jsonb" DEFAULT '[]'::"jsonb",
    "recommended_next_step_type" "text" DEFAULT 'NO_ACTION'::"text",
    "time_to_impact" "text",
    "minutes_to_impact" integer,
    "first_detected_at" timestamp with time zone DEFAULT "now"(),
    "last_updated_at" timestamp with time zone DEFAULT "now"(),
    "expires_at" timestamp with time zone,
    "status" "text" DEFAULT 'ACTIVE'::"text" NOT NULL,
    "fingerprint" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "read_at" timestamp with time zone,
    "acknowledged_at" timestamp with time zone,
    "unread" boolean DEFAULT true NOT NULL,
    "impact_ids" "uuid"[],
    "copilot_context_available" boolean DEFAULT true NOT NULL,
    "copilot_proposal_id" "uuid",
    "impact_score" integer,
    "urgency_score" integer,
    "score_breakdown" "jsonb",
    "escalation_applied" boolean DEFAULT false,
    "escalation_reason" "text",
    "confidence_ceiling_applied" boolean DEFAULT false,
    "score_calculated_at" timestamp with time zone,
    "failure_type" "text",
    "failure_message" "text",
    "recovery_log_id" "uuid",
    "alert_fingerprint" "text",
    "alert_category" "text" DEFAULT 'disruption'::"text",
    "action_items" "jsonb" DEFAULT '[]'::"jsonb",
    "context_data" "jsonb" DEFAULT '{}'::"jsonb",
    "scheduled_for" timestamp with time zone,
    "delivered_at" timestamp with time zone,
    "dismissed_at" timestamp with time zone,
    "snooze_until" timestamp with time zone,
    "requires_acknowledgement" boolean DEFAULT false NOT NULL,
    "snooze_allowed" boolean DEFAULT true NOT NULL,
    "delivery_channels" "text"[] DEFAULT ARRAY['inapp'::"text", 'dashboard'::"text"],
    "max_delay_minutes" integer DEFAULT 30,
    "bypass_dnd" boolean DEFAULT false NOT NULL,
    CONSTRAINT "travel_alerts_alert_category_check" CHECK (("alert_category" = ANY (ARRAY['health'::"text", 'friction'::"text", 'readiness'::"text", 'booking'::"text", 'disruption'::"text", 'expiration'::"text", 'reminder'::"text", 'suggestion'::"text"]))),
    CONSTRAINT "travel_alerts_alert_type_check" CHECK (("alert_type" = ANY (ARRAY['INFORMATIONAL'::"text", 'SCHEDULE_CHANGE'::"text", 'DELAY'::"text", 'CANCELLATION'::"text", 'LOCATION_CHANGE'::"text", 'AIRPORT_CHANGE'::"text", 'TERMINAL_CHANGE'::"text", 'GATE_CHANGE'::"text", 'RESERVATION_CHANGE'::"text", 'CHECK_IN_CHANGE'::"text", 'CHECK_OUT_CHANGE'::"text", 'REQUIREMENT_CHANGE'::"text", 'WEATHER_ALERT'::"text", 'TRANSPORTATION_DISRUPTION'::"text", 'TRIP_IMPACT'::"text", 'OTHER'::"text"]))),
    CONSTRAINT "travel_alerts_confidence_check" CHECK (("confidence" = ANY (ARRAY['HIGH'::"text", 'MEDIUM'::"text", 'LOW'::"text", 'UNKNOWN'::"text"]))),
    CONSTRAINT "travel_alerts_priority_check" CHECK (("priority" = ANY (ARRAY['INFO'::"text", 'LOW'::"text", 'MEDIUM'::"text", 'HIGH'::"text", 'CRITICAL'::"text"]))),
    CONSTRAINT "travel_alerts_recommended_next_step_type_check" CHECK (("recommended_next_step_type" = ANY (ARRAY['NO_ACTION_IDENTIFIED'::"text", 'REVIEW'::"text", 'VERIFY'::"text", 'POSSIBLE_ITINERARY_CHANGE'::"text", 'POSSIBLE_RESERVATION_FOLLOW_UP'::"text", 'POSSIBLE_TRAVEL_ADJUSTMENT'::"text", 'CHECK_DOCUMENT'::"text", 'REVIEW_REQUIREMENT'::"text", 'NO_ACTION'::"text", 'UNKNOWN'::"text"]))),
    CONSTRAINT "travel_alerts_status_check" CHECK (("status" = ANY (ARRAY['ACTIVE'::"text", 'RESOLVED'::"text", 'SUPERSEDED'::"text", 'DISMISSED'::"text", 'EXPIRED'::"text", 'UNKNOWN'::"text"]))),
    CONSTRAINT "travel_alerts_time_to_impact_check" CHECK (("time_to_impact" = ANY (ARRAY['UNKNOWN'::"text", 'MORE_THAN_24_HOURS'::"text", '12_TO_24_HOURS'::"text", '6_TO_12_HOURS'::"text", '2_TO_6_HOURS'::"text", 'LESS_THAN_2_HOURS'::"text", 'CURRENT'::"text", 'PAST'::"text"]))),
    CONSTRAINT "travel_alerts_urgency_check" CHECK (("urgency" = ANY (ARRAY['NOT_URGENT'::"text", 'SOON'::"text", 'TIME_SENSITIVE'::"text", 'IMMEDIATE'::"text", 'UNKNOWN'::"text"])))
);


ALTER TABLE "public"."travel_alerts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."travel_operations" (
    "operation_id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "trip_id" "uuid",
    "operation_type" "text" NOT NULL,
    "parent_operation_id" "uuid",
    "current_state" "text" DEFAULT 'OPERATION_REQUESTED'::"text" NOT NULL,
    "attempt_number" integer DEFAULT 0 NOT NULL,
    "retry_count" integer GENERATED ALWAYS AS (GREATEST(("attempt_number" - 1), 0)) STORED NOT NULL,
    "max_attempts" integer DEFAULT 3 NOT NULL,
    "idempotency_key" "text",
    "request_fingerprint" "text",
    "request_hash" "text",
    "expected_version_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "requested_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "last_attempt_started_at" timestamp with time zone,
    "last_attempt_completed_at" timestamp with time zone,
    "last_failure_at" timestamp with time zone,
    "terminal_at" timestamp with time zone,
    "terminal_reason" "text",
    "recovery_status" "text",
    "lock_status" "text" DEFAULT 'UNLOCKED'::"text",
    "lock_owner_id" "text",
    "lock_acquired_at" timestamp with time zone,
    "lock_expires_at" timestamp with time zone,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "chk_retry_count" CHECK (("retry_count" = GREATEST(("attempt_number" - 1), 0))),
    CONSTRAINT "chk_travel_operations_state" CHECK (("current_state" = ANY (ARRAY['OPERATION_REQUESTED'::"text", 'ATTEMPTING'::"text", 'FAILED'::"text", 'PENDING'::"text", 'PROCESSING'::"text", 'RETRY_PENDING'::"text", 'RETRYING'::"text", 'RECOVERED'::"text", 'SUCCESS'::"text", 'PERMANENT_FAILURE'::"text", 'SOURCE_UNAVAILABLE'::"text", 'CANCELLED_STALE'::"text", 'CANCELLED'::"text", 'NOT_SUPPORTED'::"text", 'INVALID'::"text", 'DATA_CONFLICT'::"text", 'AUTHORIZATION_REQUIRED'::"text", 'EXECUTION_FAILED'::"text", 'RECALCULATION_FAILED'::"text", 'UNKNOWN'::"text"]))),
    CONSTRAINT "chk_travel_operations_type" CHECK (("operation_type" = ANY (ARRAY['MONITORING'::"text", 'CHANGE_DETECTION'::"text", 'TRIP_IMPACT'::"text", 'TRAVEL_ALERT'::"text", 'ALERT_SCORING'::"text", 'NOTIFICATION_ELIGIBILITY'::"text", 'COPILOT_CONTEXT'::"text", 'ITINERARY_CHANGE'::"text", 'HEALTH_RECALCULATION'::"text", 'FRICTION_RECALCULATION'::"text", 'ISSUES_RECALCULATION'::"text", 'READINESS_RECALCULATION'::"text"])))
);


ALTER TABLE "public"."travel_operations" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."traveler_profiles" (
    "user_id" "uuid" NOT NULL,
    "version" integer DEFAULT 1 NOT NULL,
    "contexts" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "overrides" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "learning_paused" boolean DEFAULT false NOT NULL,
    "excluded_trip_ids" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "group_use_enabled" boolean DEFAULT true NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."traveler_profiles" OWNER TO "postgres";


COMMENT ON TABLE "public"."traveler_profiles" IS 'Per-traveller learned preference profile. IDENTITY AXIS: Supabase auth uuid — user_id is auth.uid(), FK to auth.users(id). This is NOT the platform "usr_" axis used by platform_users and trip_members; never write a usr_ id here (settled Q2.28, 2026-09-20).';



COMMENT ON COLUMN "public"."traveler_profiles"."user_id" IS 'auth.users(id) / auth.uid(). To reach this row from a platform "usr_" id, go through auth_identities: match auth_identities.provider_subject (the auth uuid as text) — on provider_subject ALONE, never filtering on provider.';



CREATE TABLE IF NOT EXISTS "public"."trip_assemblies" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "trip_id" "uuid" NOT NULL,
    "trip_start" "date",
    "trip_end" "date",
    "duration_days" integer,
    "destination_count" integer DEFAULT 0,
    "flight_count" integer DEFAULT 0,
    "hotel_count" integer DEFAULT 0,
    "rental_car_count" integer DEFAULT 0,
    "restaurant_count" integer DEFAULT 0,
    "activity_count" integer DEFAULT 0,
    "other_reservation_count" integer DEFAULT 0,
    "open_window_count" integer DEFAULT 0,
    "conflict_count" integer DEFAULT 0,
    "gap_count" integer DEFAULT 0,
    "destinations" "jsonb" DEFAULT '[]'::"jsonb",
    "travel_segments" "jsonb" DEFAULT '[]'::"jsonb",
    "accommodation_periods" "jsonb" DEFAULT '[]'::"jsonb",
    "reservation_anchors" "jsonb" DEFAULT '[]'::"jsonb",
    "open_windows" "jsonb" DEFAULT '[]'::"jsonb",
    "conflicts" "jsonb" DEFAULT '[]'::"jsonb",
    "possible_gaps" "jsonb" DEFAULT '[]'::"jsonb",
    "reservation_density" "jsonb" DEFAULT '{}'::"jsonb",
    "next_actions" "jsonb" DEFAULT '[]'::"jsonb",
    "assembly_status" "text" DEFAULT 'UNKNOWN'::"text" NOT NULL,
    "confidence" "text" DEFAULT 'LOW'::"text" NOT NULL,
    "assembly_notes" "text",
    "reservation_ids" "uuid"[],
    "calculated_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "trip_assemblies_assembly_status_check" CHECK (("assembly_status" = ANY (ARRAY['COMPLETE'::"text", 'MOSTLY_COMPLETE'::"text", 'NEEDS_REVIEW'::"text", 'UNKNOWN'::"text"]))),
    CONSTRAINT "trip_assemblies_confidence_check" CHECK (("confidence" = ANY (ARRAY['HIGH'::"text", 'MEDIUM'::"text", 'LOW'::"text"])))
);


ALTER TABLE "public"."trip_assemblies" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."trip_change_log" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "trip_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "change_type" "text" NOT NULL,
    "summary" "text" NOT NULL,
    "item_id" "text",
    "before_state" "jsonb",
    "after_state" "jsonb",
    "affected_items" "text"[],
    "conflicts_detected" "jsonb" DEFAULT '[]'::"jsonb",
    "conflict_resolutions" "jsonb" DEFAULT '[]'::"jsonb",
    "actions_taken" "text"[],
    "health_before" numeric,
    "health_after" numeric,
    "friction_before" numeric,
    "friction_after" numeric,
    "cost_delta" numeric DEFAULT 0,
    "reversible" boolean DEFAULT true,
    "undo_expires_at" timestamp with time zone,
    "undone_at" timestamp with time zone,
    "undone_by_change_id" "uuid",
    "redone_at" timestamp with time zone,
    "redone_by_change_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "trip_change_log_change_type_check" CHECK (("change_type" = ANY (ARRAY['TIME_UPDATE'::"text", 'RESERVATION_CHANGE'::"text", 'ITEM_ADDITION'::"text", 'ITEM_REMOVAL'::"text", 'ITEM_MODIFICATION'::"text", 'UNDO'::"text", 'REDO'::"text"])))
);


ALTER TABLE "public"."trip_change_log" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."trip_change_previews" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "trip_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "item_id" "text" NOT NULL,
    "change_type" "text" NOT NULL,
    "proposed_change" "jsonb" NOT NULL,
    "conflicts" "jsonb" DEFAULT '[]'::"jsonb",
    "impact" "jsonb" DEFAULT '{}'::"jsonb",
    "status" "text" DEFAULT 'PENDING'::"text" NOT NULL,
    "expires_at" timestamp with time zone DEFAULT ("now"() + '00:30:00'::interval),
    "created_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "trip_change_previews_status_check" CHECK (("status" = ANY (ARRAY['PENDING'::"text", 'CONFIRMED'::"text", 'CANCELLED'::"text", 'EXPIRED'::"text"])))
);


ALTER TABLE "public"."trip_change_previews" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."trip_forecasts" (
    "trip_id" "uuid" NOT NULL,
    "scope" "text" NOT NULL,
    "member_id" "text" DEFAULT ''::"text" NOT NULL,
    "forecast" "jsonb" NOT NULL,
    "generated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "trip_forecasts_scope_check" CHECK (("scope" = ANY (ARRAY['group'::"text", 'me'::"text"])))
);


ALTER TABLE "public"."trip_forecasts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."trip_groups" (
    "id" "text" NOT NULL,
    "trip_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "description" "text",
    "image_url" "text",
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."trip_groups" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."trip_health_analyses" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "trip_id" "uuid" NOT NULL,
    "itinerary_id" "uuid",
    "version_id" "uuid",
    "user_id" "uuid" NOT NULL,
    "health_score" integer DEFAULT 0 NOT NULL,
    "health_status" "text" DEFAULT 'watch'::"text" NOT NULL,
    "schedule_score" integer DEFAULT 0,
    "geography_score" integer DEFAULT 0,
    "pace_score" integer DEFAULT 0,
    "budget_score" integer DEFAULT 0,
    "completeness_score" integer DEFAULT 0,
    "daily_friction" "jsonb" DEFAULT '[]'::"jsonb",
    "issues" "jsonb" DEFAULT '[]'::"jsonb",
    "readiness_planning" "text" DEFAULT 'unknown'::"text",
    "readiness_reservations" "text" DEFAULT 'unknown'::"text",
    "readiness_transportation" "text" DEFAULT 'unknown'::"text",
    "readiness_budget" "text" DEFAULT 'unknown'::"text",
    "readiness_overall" "text" DEFAULT 'unknown'::"text",
    "unknown_items_count" integer DEFAULT 0,
    "overall_assessment" "text",
    "top_issue_title" "text",
    "top_issue_severity" "text",
    "previous_health_score" integer,
    "health_score_change" integer,
    "health_trend_message" "text",
    "data_completeness" "text" DEFAULT 'partial'::"text",
    "dismissed_issue_ids" "text"[] DEFAULT '{}'::"text"[],
    "status" "text" DEFAULT 'ready'::"text" NOT NULL,
    "analyzed_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "source" "text",
    "alert_id" "uuid",
    CONSTRAINT "trip_health_analyses_data_completeness_check" CHECK (("data_completeness" = ANY (ARRAY['full'::"text", 'partial'::"text", 'insufficient'::"text"]))),
    CONSTRAINT "trip_health_analyses_health_score_check" CHECK ((("health_score" >= 0) AND ("health_score" <= 100))),
    CONSTRAINT "trip_health_analyses_health_status_check" CHECK (("health_status" = ANY (ARRAY['excellent'::"text", 'good'::"text", 'watch'::"text", 'needs_attention'::"text"]))),
    CONSTRAINT "trip_health_analyses_status_check" CHECK (("status" = ANY (ARRAY['analyzing'::"text", 'ready'::"text", 'failed'::"text"])))
);


ALTER TABLE "public"."trip_health_analyses" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."trip_impacts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "trip_id" "uuid" NOT NULL,
    "monitoring_event_id" "uuid",
    "monitored_entity_id" "uuid",
    "reservation_id" "uuid",
    "itinerary_version_id" "text",
    "impact_type" "text" NOT NULL,
    "impact_level" "text" DEFAULT 'UNKNOWN'::"text" NOT NULL,
    "affected_entity_type" "text",
    "affected_entity_id" "text",
    "affected_day" integer,
    "affected_date" "date",
    "relationship_type" "text",
    "time_relationship" "jsonb",
    "explanation" "text" NOT NULL,
    "evidence" "jsonb" DEFAULT '[]'::"jsonb",
    "confidence" "text" DEFAULT 'UNKNOWN'::"text" NOT NULL,
    "status" "text" DEFAULT 'ACTIVE'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "pipeline_run_id" "text",
    "analysis_triggered_by" "text" DEFAULT 'MANUAL'::"text",
    "alert_generation_status" "text" DEFAULT 'PENDING'::"text",
    "alert_generation_started_at" timestamp with time zone,
    "alert_generation_completed_at" timestamp with time zone,
    "alert_generation_error" "text",
    "generated_alert_id" "uuid",
    "failure_type" "text",
    "failure_message" "text",
    "recovery_log_id" "uuid",
    CONSTRAINT "trip_impacts_affected_entity_type_check" CHECK (("affected_entity_type" = ANY (ARRAY['RESERVATION'::"text", 'ITINERARY_ACTIVITY'::"text", 'DOCUMENT'::"text", 'REQUIREMENT'::"text", 'TRANSPORTATION'::"text", 'ACCOMMODATION'::"text", 'TOUR'::"text", 'ACTIVITY'::"text", 'OTHER'::"text"]))),
    CONSTRAINT "trip_impacts_alert_generation_status_check" CHECK (("alert_generation_status" = ANY (ARRAY['PENDING'::"text", 'PROCESSING'::"text", 'COMPLETE'::"text", 'FAILED'::"text", 'SKIPPED'::"text", 'NOT_APPLICABLE'::"text"]))),
    CONSTRAINT "trip_impacts_analysis_triggered_by_check" CHECK (("analysis_triggered_by" = ANY (ARRAY['MANUAL'::"text", 'PIPELINE'::"text", 'BATCH'::"text", 'RETRY'::"text"]))),
    CONSTRAINT "trip_impacts_confidence_check" CHECK (("confidence" = ANY (ARRAY['HIGH'::"text", 'MEDIUM'::"text", 'LOW'::"text", 'UNKNOWN'::"text"]))),
    CONSTRAINT "trip_impacts_impact_level_check" CHECK (("impact_level" = ANY (ARRAY['NONE'::"text", 'POSSIBLE'::"text", 'LOW'::"text", 'MODERATE'::"text", 'HIGH'::"text", 'CRITICAL'::"text", 'UNKNOWN'::"text"]))),
    CONSTRAINT "trip_impacts_impact_type_check" CHECK (("impact_type" = ANY (ARRAY['TEMPORAL'::"text", 'GEOGRAPHIC'::"text", 'RESERVATION'::"text", 'TRANSPORTATION'::"text", 'ACCOMMODATION'::"text", 'ITINERARY'::"text", 'DOCUMENT'::"text", 'REQUIREMENT'::"text", 'SEQUENCE'::"text", 'CONNECTION'::"text", 'OTHER'::"text"]))),
    CONSTRAINT "trip_impacts_status_check" CHECK (("status" = ANY (ARRAY['ACTIVE'::"text", 'RESOLVED'::"text", 'SUPERSEDED'::"text", 'UNKNOWN'::"text", 'DISMISSED'::"text"])))
);


ALTER TABLE "public"."trip_impacts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."trip_issues" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "trip_id" "uuid" NOT NULL,
    "itinerary_id" "uuid",
    "version_id" "uuid",
    "user_id" "uuid" NOT NULL,
    "issue_key" "text" NOT NULL,
    "severity" "text" NOT NULL,
    "category" "text" NOT NULL,
    "issue_type" "text" NOT NULL,
    "title" "text" NOT NULL,
    "short_description" "text" NOT NULL,
    "detailed_explanation" "text",
    "impact" "text",
    "recommended_action" "text",
    "affected_days" integer[] DEFAULT '{}'::integer[],
    "source_system" "text",
    "confidence" "text" DEFAULT 'MEDIUM'::"text" NOT NULL,
    "fixable_by" "text" DEFAULT 'NO_AUTOMATIC_ACTION'::"text",
    "change_plan_prompt" "text",
    "status" "text" DEFAULT 'OPEN'::"text" NOT NULL,
    "priority_rank" integer,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "trip_issues_category_check" CHECK (("category" = ANY (ARRAY['SCHEDULE'::"text", 'GEOGRAPHY'::"text", 'PACE'::"text", 'WALKING'::"text", 'BUDGET'::"text", 'RESERVATIONS'::"text", 'TRANSPORTATION'::"text", 'COMPLETENESS'::"text", 'OTHER'::"text"]))),
    CONSTRAINT "trip_issues_confidence_check" CHECK (("confidence" = ANY (ARRAY['HIGH'::"text", 'MEDIUM'::"text", 'LOW'::"text"]))),
    CONSTRAINT "trip_issues_fixable_by_check" CHECK (("fixable_by" = ANY (ARRAY['CAN_OPTIMIZE'::"text", 'CAN_ADJUST'::"text", 'USER_DECISION_REQUIRED'::"text", 'INFORMATION_NEEDED'::"text", 'NO_AUTOMATIC_ACTION'::"text"]))),
    CONSTRAINT "trip_issues_issue_type_check" CHECK (("issue_type" = ANY (ARRAY['PROBLEM'::"text", 'RISK'::"text", 'OPPORTUNITY'::"text"]))),
    CONSTRAINT "trip_issues_severity_check" CHECK (("severity" = ANY (ARRAY['CRITICAL'::"text", 'HIGH'::"text", 'MEDIUM'::"text", 'LOW'::"text", 'INFO'::"text"]))),
    CONSTRAINT "trip_issues_status_check" CHECK (("status" = ANY (ARRAY['OPEN'::"text", 'ACKNOWLEDGED'::"text", 'RESOLVED'::"text", 'DISMISSED'::"text"])))
);


ALTER TABLE "public"."trip_issues" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."trip_members" (
    "id" "text" NOT NULL,
    "trip_id" "uuid" NOT NULL,
    "user_id" "text",
    "kind" "public"."member_kind" NOT NULL,
    "role" "public"."member_role" NOT NULL,
    "display_name" "text" NOT NULL,
    "guest_token_hash" "text",
    "guest_expires_at" timestamp with time zone,
    "joined_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "removed_at" timestamp with time zone,
    CONSTRAINT "ck_member_kind" CHECK (((("kind" = 'account'::"public"."member_kind") AND ("user_id" IS NOT NULL)) OR (("kind" = 'guest'::"public"."member_kind") AND ("guest_token_hash" IS NOT NULL))))
);


ALTER TABLE "public"."trip_members" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."trip_planning_preferences" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "trip_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "destination" "text",
    "start_date" "date",
    "end_date" "date",
    "traveler_count" integer,
    "traveler_ages" integer[],
    "budget" numeric,
    "currency" "text" DEFAULT 'USD'::"text",
    "travel_style" "text",
    "pace" "text",
    "walking_tolerance" "text",
    "interests" "text"[],
    "food_preferences" "text"[],
    "transportation_preferences" "text"[],
    "hotel_preferences" "text"[],
    "must_do" "text"[],
    "avoid" "text"[],
    "additional_constraints" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."trip_planning_preferences" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."trips" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "destination" "text",
    "start_date" "date",
    "end_date" "date",
    "status" "text" DEFAULT 'planning'::"text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "title" "text",
    "primary_tz" "text" DEFAULT 'UTC'::"text" NOT NULL,
    "base_currency" character(3) DEFAULT 'USD'::"bpchar" NOT NULL,
    "version" integer DEFAULT 1 NOT NULL,
    "archived_at" timestamp with time zone
);


ALTER TABLE "public"."trips" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."typing_indicators" (
    "group_id" "text" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "display_name" "text",
    "updated_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."typing_indicators" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."user_actions" (
    "id" bigint NOT NULL,
    "user_id" "uuid",
    "feature" character varying(100),
    "action" character varying(100),
    "count" integer DEFAULT 1,
    "date" "date" DEFAULT CURRENT_DATE,
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."user_actions" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."user_actions_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."user_actions_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."user_actions_id_seq" OWNED BY "public"."user_actions"."id";



CREATE TABLE IF NOT EXISTS "public"."user_alert_preferences" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "timezone" "text" DEFAULT 'UTC'::"text" NOT NULL,
    "dnd_start" "text" DEFAULT '22:00'::"text" NOT NULL,
    "dnd_end" "text" DEFAULT '07:00'::"text" NOT NULL,
    "push_enabled" boolean DEFAULT true NOT NULL,
    "email_enabled" boolean DEFAULT true NOT NULL,
    "sms_enabled" boolean DEFAULT false NOT NULL,
    "email_digest_mode" "text" DEFAULT 'immediate'::"text" NOT NULL,
    "sms_critical_only" boolean DEFAULT true NOT NULL,
    "category_preferences" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "priority_channel_overrides" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "user_alert_preferences_email_digest_mode_check" CHECK (("email_digest_mode" = ANY (ARRAY['immediate'::"text", 'daily'::"text", 'weekly'::"text", 'off'::"text"])))
);


ALTER TABLE "public"."user_alert_preferences" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."user_behavior_profiles" (
    "id" bigint NOT NULL,
    "user_id" "uuid",
    "user_type" character varying(100),
    "high_priority_features" "text"[],
    "low_priority_features" "text"[],
    "feature_usage" "jsonb",
    "confidence" numeric(3,2),
    "analysis_date" "date",
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."user_behavior_profiles" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."user_behavior_profiles_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."user_behavior_profiles_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."user_behavior_profiles_id_seq" OWNED BY "public"."user_behavior_profiles"."id";



CREATE TABLE IF NOT EXISTS "public"."user_devices" (
    "id" "text" NOT NULL,
    "user_id" "text" NOT NULL,
    "label" "text",
    "last_seen_at" timestamp with time zone,
    "revoked_at" timestamp with time zone
);


ALTER TABLE "public"."user_devices" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."user_limits" (
    "id" bigint NOT NULL,
    "user_id" "uuid",
    "daily_api_calls" integer DEFAULT 1000,
    "monthly_spend_limit" numeric(10,2),
    "is_premium" boolean DEFAULT false,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."user_limits" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."user_limits_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."user_limits_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."user_limits_id_seq" OWNED BY "public"."user_limits"."id";



CREATE TABLE IF NOT EXISTS "public"."user_push_tokens" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "expo_push_token" "text" NOT NULL,
    "device_id" "text",
    "platform" "text",
    "is_active" boolean DEFAULT true NOT NULL,
    "last_used_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "user_push_tokens_platform_check" CHECK (("platform" = ANY (ARRAY['ios'::"text", 'android'::"text", 'web'::"text"])))
);


ALTER TABLE "public"."user_push_tokens" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."user_recommendation_profiles" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid",
    "interests" "text"[] DEFAULT '{}'::"text"[],
    "budget_level" "text" DEFAULT 'moderate'::"text",
    "preferred_categories" "text"[] DEFAULT '{}'::"text"[],
    "home_location" "text",
    "updated_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."user_recommendation_profiles" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."weather_forecasts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "trip_id" "uuid",
    "location" "text" NOT NULL,
    "forecast_date" "date" NOT NULL,
    "temperature" numeric(5,1),
    "feels_like" numeric(5,1),
    "condition" "text",
    "humidity" integer,
    "wind_speed" numeric(6,1),
    "precipitation" numeric(6,1),
    "uv_index" numeric(4,1),
    "risks" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "data_source" "text" DEFAULT 'openweathermap'::"text" NOT NULL,
    "fetched_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."weather_forecasts" OWNER TO "postgres";


ALTER TABLE ONLY "public"."agent_metrics" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."agent_metrics_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."alert_preferences_v2" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."alert_preferences_v2_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."cache_stats" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."cache_stats_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."cost_alerts" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."cost_alerts_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."daily_spend" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."daily_spend_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."dedup_cache" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."dedup_cache_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."loop_executions" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."loop_executions_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."performance_metrics" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."performance_metrics_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."search_analytics" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."search_analytics_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."user_actions" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."user_actions_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."user_behavior_profiles" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."user_behavior_profiles_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."user_limits" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."user_limits_id_seq"'::"regclass");



ALTER TABLE ONLY "private"."sentinel_meta"
    ADD CONSTRAINT "sentinel_meta_pkey" PRIMARY KEY ("k");



ALTER TABLE ONLY "private"."sentinel_state"
    ADD CONSTRAINT "sentinel_state_pkey" PRIMARY KEY ("check_key");



ALTER TABLE ONLY "private"."sentinel_table_stats"
    ADD CONSTRAINT "sentinel_table_stats_pkey" PRIMARY KEY ("relid");



ALTER TABLE ONLY "public"."account_deletion_requests"
    ADD CONSTRAINT "account_deletion_requests_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."account_deletion_requests"
    ADD CONSTRAINT "account_deletion_requests_user_id_key" UNIQUE ("user_id");



ALTER TABLE ONLY "public"."activity_events"
    ADD CONSTRAINT "activity_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."activity_read_markers"
    ADD CONSTRAINT "activity_read_markers_pkey" PRIMARY KEY ("trip_id", "member_id");



ALTER TABLE ONLY "public"."agent_metrics"
    ADD CONSTRAINT "agent_metrics_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."agreement_completions"
    ADD CONSTRAINT "agreement_completions_pkey" PRIMARY KEY ("trip_id", "member_id");



ALTER TABLE ONLY "public"."agreement_questionnaires"
    ADD CONSTRAINT "agreement_questionnaires_pkey" PRIMARY KEY ("trip_id");



ALTER TABLE ONLY "public"."agreement_responses"
    ADD CONSTRAINT "agreement_responses_pkey" PRIMARY KEY ("trip_id", "member_id", "question_id");



ALTER TABLE ONLY "public"."airline_loyalty_cache"
    ADD CONSTRAINT "airline_loyalty_cache_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."airline_loyalty_cache"
    ADD CONSTRAINT "airline_loyalty_cache_user_id_program_key" UNIQUE ("user_id", "program");



ALTER TABLE ONLY "public"."alert_batches"
    ADD CONSTRAINT "alert_batches_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."alert_dedup_log"
    ADD CONSTRAINT "alert_dedup_log_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."alert_delivery_log"
    ADD CONSTRAINT "alert_delivery_log_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."alert_preferences"
    ADD CONSTRAINT "alert_preferences_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."alert_preferences"
    ADD CONSTRAINT "alert_preferences_user_trip_key" UNIQUE NULLS NOT DISTINCT ("user_id", "trip_id");



ALTER TABLE ONLY "public"."alert_preferences_v2"
    ADD CONSTRAINT "alert_preferences_v2_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."alert_queue_stats"
    ADD CONSTRAINT "alert_queue_stats_pkey" PRIMARY KEY ("user_id");



ALTER TABLE ONLY "public"."alert_rate_counters"
    ADD CONSTRAINT "alert_rate_counters_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."alert_rate_counters"
    ADD CONSTRAINT "alert_rate_counters_user_id_window_type_window_start_key" UNIQUE ("user_id", "window_type", "window_start");



ALTER TABLE ONLY "public"."alignment_reports"
    ADD CONSTRAINT "alignment_reports_pkey" PRIMARY KEY ("trip_id");



ALTER TABLE ONLY "public"."api_alerts"
    ADD CONSTRAINT "api_alerts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."api_cache_entries"
    ADD CONSTRAINT "api_cache_entries_pkey" PRIMARY KEY ("cache_key");



ALTER TABLE ONLY "public"."api_cost_daily"
    ADD CONSTRAINT "api_cost_daily_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."api_cost_daily"
    ADD CONSTRAINT "api_cost_daily_service_date_key" UNIQUE ("service", "date");



ALTER TABLE ONLY "public"."api_cost_log"
    ADD CONSTRAINT "api_cost_log_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."api_service_health"
    ADD CONSTRAINT "api_service_health_pkey" PRIMARY KEY ("service");



ALTER TABLE ONLY "public"."audit_log"
    ADD CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."auth_identities"
    ADD CONSTRAINT "auth_identities_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."auth_identities"
    ADD CONSTRAINT "auth_identities_provider_provider_subject_key" UNIQUE ("provider", "provider_subject");



ALTER TABLE ONLY "public"."availability_snapshots"
    ADD CONSTRAINT "availability_snapshots_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."ballots_v2"
    ADD CONSTRAINT "ballots_v2_pkey" PRIMARY KEY ("poll_id", "member_id");



ALTER TABLE ONLY "public"."bargain_norms"
    ADD CONSTRAINT "bargain_norms_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."better_deals"
    ADD CONSTRAINT "better_deals_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."booking_conflicts"
    ADD CONSTRAINT "booking_conflicts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."booking_connections"
    ADD CONSTRAINT "booking_connections_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."booking_connections"
    ADD CONSTRAINT "booking_connections_user_id_platform_id_key" UNIQUE ("user_id", "platform_id");



ALTER TABLE ONLY "public"."booking_platforms"
    ADD CONSTRAINT "booking_platforms_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."booking_reservations"
    ADD CONSTRAINT "booking_reservations_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."booking_reservations"
    ADD CONSTRAINT "booking_reservations_user_id_provider_provider_id_key" UNIQUE ("user_id", "provider", "provider_id");



ALTER TABLE ONLY "public"."budget_aggregates"
    ADD CONSTRAINT "budget_aggregates_pkey" PRIMARY KEY ("trip_id");



ALTER TABLE ONLY "public"."budget_analyses"
    ADD CONSTRAINT "budget_analyses_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."budget_notification_queue"
    ADD CONSTRAINT "budget_notification_queue_pkey" PRIMARY KEY ("trip_id");



ALTER TABLE ONLY "public"."budget_preferences"
    ADD CONSTRAINT "budget_preferences_pkey" PRIMARY KEY ("trip_id", "member_id");



ALTER TABLE ONLY "public"."cache_stats"
    ADD CONSTRAINT "cache_stats_cache_key_key" UNIQUE ("cache_key");



ALTER TABLE ONLY "public"."cache_stats"
    ADD CONSTRAINT "cache_stats_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."calendar_connections"
    ADD CONSTRAINT "calendar_connections_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."calendar_connections"
    ADD CONSTRAINT "calendar_connections_user_id_provider_key" UNIQUE ("user_id", "provider");



ALTER TABLE ONLY "public"."calendar_event_mappings"
    ADD CONSTRAINT "calendar_event_mappings_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."calendar_event_mappings"
    ADD CONSTRAINT "calendar_event_mappings_user_id_trip_event_id_provider_key" UNIQUE ("user_id", "trip_event_id", "provider");



ALTER TABLE ONLY "public"."calendar_invitations"
    ADD CONSTRAINT "calendar_invitations_invite_token_key" UNIQUE ("invite_token");



ALTER TABLE ONLY "public"."calendar_invitations"
    ADD CONSTRAINT "calendar_invitations_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."calendar_share_viewers"
    ADD CONSTRAINT "calendar_share_viewers_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."calendar_share_viewers"
    ADD CONSTRAINT "calendar_share_viewers_share_id_email_key" UNIQUE ("share_id", "email");



ALTER TABLE ONLY "public"."calendar_sync_errors"
    ADD CONSTRAINT "calendar_sync_errors_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."calendar_sync_log"
    ADD CONSTRAINT "calendar_sync_log_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."canary_test_log"
    ADD CONSTRAINT "canary_test_log_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."change_proposals"
    ADD CONSTRAINT "change_proposals_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."checkins"
    ADD CONSTRAINT "checkins_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."circuit_breaker_state"
    ADD CONSTRAINT "circuit_breaker_state_pkey" PRIMARY KEY ("provider");



ALTER TABLE ONLY "public"."claim_expenses"
    ADD CONSTRAINT "claim_expenses_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."comment_reactions"
    ADD CONSTRAINT "comment_reactions_pkey" PRIMARY KEY ("comment_id", "member_id", "emoji");



ALTER TABLE ONLY "public"."comments"
    ADD CONSTRAINT "comments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."concurrency_audit_log"
    ADD CONSTRAINT "concurrency_audit_log_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."copilot_drafts"
    ADD CONSTRAINT "copilot_drafts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."copilot_messages"
    ADD CONSTRAINT "copilot_messages_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."copilot_proposals"
    ADD CONSTRAINT "copilot_proposals_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."copilot_settings"
    ADD CONSTRAINT "copilot_settings_pkey" PRIMARY KEY ("user_id");



ALTER TABLE ONLY "public"."copilot_threads"
    ADD CONSTRAINT "copilot_threads_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."copilot_trip_summaries"
    ADD CONSTRAINT "copilot_trip_summaries_pkey" PRIMARY KEY ("trip_id", "user_id");



ALTER TABLE ONLY "public"."cost_alerts"
    ADD CONSTRAINT "cost_alerts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."cost_index"
    ADD CONSTRAINT "cost_index_pkey" PRIMARY KEY ("city_code", "item", "tier");



ALTER TABLE ONLY "public"."currencies"
    ADD CONSTRAINT "currencies_pkey" PRIMARY KEY ("iso_code");



ALTER TABLE ONLY "public"."daily_friction_scores"
    ADD CONSTRAINT "daily_friction_scores_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."daily_spend"
    ADD CONSTRAINT "daily_spend_date_key" UNIQUE ("date");



ALTER TABLE ONLY "public"."daily_spend"
    ADD CONSTRAINT "daily_spend_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."data_export_requests"
    ADD CONSTRAINT "data_export_requests_download_token_key" UNIQUE ("download_token");



ALTER TABLE ONLY "public"."data_export_requests"
    ADD CONSTRAINT "data_export_requests_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."day_energy_snapshots"
    ADD CONSTRAINT "day_energy_snapshots_pkey" PRIMARY KEY ("user_id", "trip_id", "date");



ALTER TABLE ONLY "public"."day_snapshots"
    ADD CONSTRAINT "day_snapshots_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."dedup_cache"
    ADD CONSTRAINT "dedup_cache_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."dedup_cache"
    ADD CONSTRAINT "dedup_cache_request_hash_key" UNIQUE ("request_hash");



ALTER TABLE ONLY "public"."delivery_attempts"
    ADD CONSTRAINT "delivery_attempts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."dep_edges"
    ADD CONSTRAINT "dep_edges_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."dep_nodes"
    ADD CONSTRAINT "dep_nodes_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."dietary_phrase_cards"
    ADD CONSTRAINT "dietary_phrase_cards_dietary_need_country_code_key" UNIQUE ("dietary_need", "country_code");



ALTER TABLE ONLY "public"."dietary_phrase_cards"
    ADD CONSTRAINT "dietary_phrase_cards_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."disaster_alerts"
    ADD CONSTRAINT "disaster_alerts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."dismissed_alerts"
    ADD CONSTRAINT "dismissed_alerts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."disruption_cases"
    ADD CONSTRAINT "disruption_cases_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."disruption_claims"
    ADD CONSTRAINT "disruption_claims_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."disruption_reports"
    ADD CONSTRAINT "disruption_reports_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."document_imports"
    ADD CONSTRAINT "document_imports_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."email_attachments"
    ADD CONSTRAINT "email_attachments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."email_connections"
    ADD CONSTRAINT "email_connections_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."email_message_imports"
    ADD CONSTRAINT "email_message_imports_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."embassies"
    ADD CONSTRAINT "embassies_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."emergency_info"
    ADD CONSTRAINT "emergency_info_pkey" PRIMARY KEY ("user_id");



ALTER TABLE ONLY "public"."emergency_numbers"
    ADD CONSTRAINT "emergency_numbers_pkey" PRIMARY KEY ("country_code");



ALTER TABLE ONLY "public"."entry_requirement_changes"
    ADD CONSTRAINT "entry_requirement_changes_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."entry_requirements"
    ADD CONSTRAINT "entry_requirements_nationality_destination_source_key" UNIQUE ("nationality", "destination", "source");



ALTER TABLE ONLY "public"."entry_requirements"
    ADD CONSTRAINT "entry_requirements_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."eta_links"
    ADD CONSTRAINT "eta_links_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."eta_links"
    ADD CONSTRAINT "eta_links_token_key" UNIQUE ("token");



ALTER TABLE ONLY "public"."expense_line_items"
    ADD CONSTRAINT "expense_line_items_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."expense_splits"
    ADD CONSTRAINT "expense_splits_expense_id_user_id_key" UNIQUE ("expense_id", "user_id");



ALTER TABLE ONLY "public"."expense_splits"
    ADD CONSTRAINT "expense_splits_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."expenses"
    ADD CONSTRAINT "expenses_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."export_jobs"
    ADD CONSTRAINT "export_jobs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."export_jobs"
    ADD CONSTRAINT "export_jobs_result_token_key" UNIQUE ("result_token");



ALTER TABLE ONLY "public"."feature_flags"
    ADD CONSTRAINT "feature_flags_pkey" PRIMARY KEY ("flag");



ALTER TABLE ONLY "public"."flight_disruptions"
    ADD CONSTRAINT "flight_disruptions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."flight_signals"
    ADD CONSTRAINT "flight_signals_pkey" PRIMARY KEY ("flight_ident", "trip_id");



ALTER TABLE ONLY "public"."fx_rates"
    ADD CONSTRAINT "fx_rates_pkey" PRIMARY KEY ("as_of", "quote", "source");



ALTER TABLE ONLY "public"."group_members"
    ADD CONSTRAINT "group_members_group_id_email_key" UNIQUE ("group_id", "email");



ALTER TABLE ONLY "public"."group_members"
    ADD CONSTRAINT "group_members_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."group_messages"
    ADD CONSTRAINT "group_messages_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."happiness_scores"
    ADD CONSTRAINT "happiness_scores_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."happiness_scores"
    ADD CONSTRAINT "happiness_scores_trip_id_user_id_key" UNIQUE ("trip_id", "user_id");



ALTER TABLE ONLY "public"."happy_moments"
    ADD CONSTRAINT "happy_moments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."health_assessments"
    ADD CONSTRAINT "health_assessments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."health_assessments"
    ADD CONSTRAINT "health_assessments_user_id_trip_id_destination_key" UNIQUE ("user_id", "trip_id", "destination");



ALTER TABLE ONLY "public"."hotel_loyalty_cache"
    ADD CONSTRAINT "hotel_loyalty_cache_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."hotel_loyalty_cache"
    ADD CONSTRAINT "hotel_loyalty_cache_user_id_program_key" UNIQUE ("user_id", "program");



ALTER TABLE ONLY "public"."hotel_loyalty_tokens"
    ADD CONSTRAINT "hotel_loyalty_tokens_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."hotel_loyalty_tokens"
    ADD CONSTRAINT "hotel_loyalty_tokens_user_id_program_key" UNIQUE ("user_id", "program");



ALTER TABLE ONLY "public"."hotel_oauth_sessions"
    ADD CONSTRAINT "hotel_oauth_sessions_pkey" PRIMARY KEY ("key");



ALTER TABLE ONLY "public"."hotel_token_audit_log"
    ADD CONSTRAINT "hotel_token_audit_log_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."idempotency_keys"
    ADD CONSTRAINT "idempotency_keys_idempotency_key_key" UNIQUE ("idempotency_key");



ALTER TABLE ONLY "public"."idempotency_keys"
    ADD CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."idempotency_records"
    ADD CONSTRAINT "idempotency_records_pkey" PRIMARY KEY ("idempotency_record_id");



ALTER TABLE ONLY "public"."important_information"
    ADD CONSTRAINT "important_information_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."inapp_notifications"
    ADD CONSTRAINT "inapp_notifications_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."item_ratings"
    ADD CONSTRAINT "item_ratings_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."item_ratings"
    ADD CONSTRAINT "item_ratings_user_id_item_id_key" UNIQUE ("user_id", "item_id");



ALTER TABLE ONLY "public"."itinerary_items"
    ADD CONSTRAINT "itinerary_items_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."itinerary_versions"
    ADD CONSTRAINT "itinerary_versions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."location_points"
    ADD CONSTRAINT "location_points_pkey" PRIMARY KEY ("share_id", "at");



ALTER TABLE ONLY "public"."location_shares"
    ADD CONSTRAINT "location_shares_link_token_key" UNIQUE ("link_token");



ALTER TABLE ONLY "public"."location_shares"
    ADD CONSTRAINT "location_shares_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."loop_executions"
    ADD CONSTRAINT "loop_executions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."loyalty_aggregator_connections"
    ADD CONSTRAINT "loyalty_aggregator_connections_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."loyalty_aggregator_connections"
    ADD CONSTRAINT "loyalty_aggregator_connections_user_id_aggregator_key" UNIQUE ("user_id", "aggregator");



ALTER TABLE ONLY "public"."member_preferences"
    ADD CONSTRAINT "member_preferences_group_id_user_id_key" UNIQUE ("group_id", "user_id");



ALTER TABLE ONLY "public"."member_preferences"
    ADD CONSTRAINT "member_preferences_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."message_attachments"
    ADD CONSTRAINT "message_attachments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."message_reactions"
    ADD CONSTRAINT "message_reactions_message_id_user_id_emoji_key" UNIQUE ("message_id", "user_id", "emoji");



ALTER TABLE ONLY "public"."message_reactions"
    ADD CONSTRAINT "message_reactions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."monitored_entities"
    ADD CONSTRAINT "monitored_entities_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."monitoring_events"
    ADD CONSTRAINT "monitoring_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."monitoring_providers"
    ADD CONSTRAINT "monitoring_providers_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."monitoring_snapshots"
    ADD CONSTRAINT "monitoring_snapshots_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."notification_eligibility"
    ADD CONSTRAINT "notification_eligibility_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."oauth_states"
    ADD CONSTRAINT "oauth_states_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."oauth_states"
    ADD CONSTRAINT "oauth_states_state_key" UNIQUE ("state");



ALTER TABLE ONLY "public"."offline_manifests"
    ADD CONSTRAINT "offline_manifests_pkey" PRIMARY KEY ("trip_id");



ALTER TABLE ONLY "public"."offline_trip_packs"
    ADD CONSTRAINT "offline_trip_packs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."offline_trip_packs"
    ADD CONSTRAINT "offline_trip_packs_trip_id_key" UNIQUE ("trip_id");



ALTER TABLE ONLY "public"."onboarding_completions"
    ADD CONSTRAINT "onboarding_completions_pkey" PRIMARY KEY ("user_id");



ALTER TABLE ONLY "public"."operation_attempts"
    ADD CONSTRAINT "operation_attempts_pkey" PRIMARY KEY ("attempt_id");



ALTER TABLE ONLY "public"."operation_locks"
    ADD CONSTRAINT "operation_locks_operation_id_key" UNIQUE ("operation_id");



ALTER TABLE ONLY "public"."operation_locks"
    ADD CONSTRAINT "operation_locks_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."outbox_items"
    ADD CONSTRAINT "outbox_items_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."pace_analyses"
    ADD CONSTRAINT "pace_analyses_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."packing_items"
    ADD CONSTRAINT "packing_items_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."performance_metrics"
    ADD CONSTRAINT "performance_metrics_endpoint_measurement_date_key" UNIQUE ("endpoint", "measurement_date");



ALTER TABLE ONLY "public"."performance_metrics"
    ADD CONSTRAINT "performance_metrics_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."personal_calibration"
    ADD CONSTRAINT "personal_calibration_pkey" PRIMARY KEY ("user_id", "category");



ALTER TABLE ONLY "public"."phrase_cards"
    ADD CONSTRAINT "phrase_cards_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."pipeline_recovery_log"
    ADD CONSTRAINT "pipeline_recovery_log_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."place_reports"
    ADD CONSTRAINT "place_reports_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."plan_changes"
    ADD CONSTRAINT "plan_changes_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."planning_sessions"
    ADD CONSTRAINT "planning_sessions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."platform_connections"
    ADD CONSTRAINT "platform_connections_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."platform_connections"
    ADD CONSTRAINT "platform_connections_user_id_platform_id_key" UNIQUE ("user_id", "platform_id");



ALTER TABLE ONLY "public"."platform_users"
    ADD CONSTRAINT "platform_users_email_key" UNIQUE ("email");



ALTER TABLE ONLY "public"."platform_users"
    ADD CONSTRAINT "platform_users_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."playbook_step_completions"
    ADD CONSTRAINT "playbook_step_completions_pkey" PRIMARY KEY ("trip_id", "disruption_id", "step_id", "member_id");



ALTER TABLE ONLY "public"."playbooks"
    ADD CONSTRAINT "playbooks_pkey" PRIMARY KEY ("key");



ALTER TABLE ONLY "public"."poll_options"
    ADD CONSTRAINT "poll_options_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."poll_options_v2"
    ADD CONSTRAINT "poll_options_v2_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."poll_votes"
    ADD CONSTRAINT "poll_votes_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."poll_votes"
    ADD CONSTRAINT "poll_votes_poll_id_user_id_option_id_key" UNIQUE ("poll_id", "user_id", "option_id");



ALTER TABLE ONLY "public"."polls"
    ADD CONSTRAINT "polls_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."polls_v2"
    ADD CONSTRAINT "polls_v2_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."pre_trip_readiness"
    ADD CONSTRAINT "pre_trip_readiness_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."pre_trip_readiness"
    ADD CONSTRAINT "pre_trip_readiness_trip_id_key" UNIQUE ("trip_id");



ALTER TABLE ONLY "public"."pre_trip_tasks"
    ADD CONSTRAINT "pre_trip_tasks_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."prediction_models"
    ADD CONSTRAINT "prediction_models_pkey" PRIMARY KEY ("user_id");



ALTER TABLE ONLY "public"."prep_items"
    ADD CONSTRAINT "prep_items_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."presence"
    ADD CONSTRAINT "presence_pkey" PRIMARY KEY ("trip_id", "member_id");



ALTER TABLE ONLY "public"."price_snapshots"
    ADD CONSTRAINT "price_snapshots_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."privacy_controls"
    ADD CONSTRAINT "privacy_controls_pkey" PRIMARY KEY ("user_id");



ALTER TABLE ONLY "public"."profile_signals"
    ADD CONSTRAINT "profile_signals_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."provider_cache"
    ADD CONSTRAINT "provider_cache_pkey" PRIMARY KEY ("key");



ALTER TABLE ONLY "public"."provider_circuit"
    ADD CONSTRAINT "provider_circuit_pkey" PRIMARY KEY ("provider");



ALTER TABLE ONLY "public"."provider_quota"
    ADD CONSTRAINT "provider_quota_pkey" PRIMARY KEY ("provider", "date");



ALTER TABLE ONLY "public"."rate_limit_buckets"
    ADD CONSTRAINT "rate_limit_buckets_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."rating_prompt_state"
    ADD CONSTRAINT "rating_prompt_state_pkey" PRIMARY KEY ("user_id");



ALTER TABLE ONLY "public"."readiness_items"
    ADD CONSTRAINT "readiness_items_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."recommendation_engagement"
    ADD CONSTRAINT "recommendation_engagement_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."recommendation_engagement"
    ADD CONSTRAINT "recommendation_engagement_user_id_recommendation_id_engagem_key" UNIQUE ("user_id", "recommendation_id", "engagement_type");



ALTER TABLE ONLY "public"."recommendation_trending"
    ADD CONSTRAINT "recommendation_trending_pkey" PRIMARY KEY ("recommendation_id");



ALTER TABLE ONLY "public"."recommendations"
    ADD CONSTRAINT "recommendations_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."release_checklist"
    ADD CONSTRAINT "release_checklist_pkey" PRIMARY KEY ("item");



ALTER TABLE ONLY "public"."replan_applied"
    ADD CONSTRAINT "replan_applied_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."replan_cache"
    ADD CONSTRAINT "replan_cache_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."reservation_poll_schedule"
    ADD CONSTRAINT "reservation_poll_schedule_pkey" PRIMARY KEY ("reservation_id");



ALTER TABLE ONLY "public"."reservation_price_history"
    ADD CONSTRAINT "reservation_price_history_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."reservations"
    ADD CONSTRAINT "reservations_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."rollcall_responses"
    ADD CONSTRAINT "rollcall_responses_pkey" PRIMARY KEY ("rollcall_id", "member_id");



ALTER TABLE ONLY "public"."rollcalls"
    ADD CONSTRAINT "rollcalls_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."safety_advisories"
    ADD CONSTRAINT "safety_advisories_pkey" PRIMARY KEY ("country_code", "source");



ALTER TABLE ONLY "public"."safety_assessments"
    ADD CONSTRAINT "safety_assessments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."safety_assessments"
    ADD CONSTRAINT "safety_assessments_user_id_trip_id_destination_key" UNIQUE ("user_id", "trip_id", "destination");



ALTER TABLE ONLY "public"."safety_notes"
    ADD CONSTRAINT "safety_notes_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."safety_preferences"
    ADD CONSTRAINT "safety_preferences_pkey" PRIMARY KEY ("user_id");



ALTER TABLE ONLY "public"."safety_reports"
    ADD CONSTRAINT "safety_reports_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."safety_rules"
    ADD CONSTRAINT "safety_rules_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."satisfaction_ledger"
    ADD CONSTRAINT "satisfaction_ledger_pkey" PRIMARY KEY ("poll_id", "member_id");



ALTER TABLE ONLY "public"."saved_recommendations"
    ADD CONSTRAINT "saved_recommendations_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."saved_recommendations"
    ADD CONSTRAINT "saved_recommendations_user_id_recommendation_id_key" UNIQUE ("user_id", "recommendation_id");



ALTER TABLE ONLY "public"."search_analytics"
    ADD CONSTRAINT "search_analytics_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."secure_documents"
    ADD CONSTRAINT "secure_documents_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."serendipity_dismissed"
    ADD CONSTRAINT "serendipity_dismissed_pkey" PRIMARY KEY ("user_id", "candidate_key");



ALTER TABLE ONLY "public"."serendipity_preferences"
    ADD CONSTRAINT "serendipity_preferences_pkey" PRIMARY KEY ("user_id");



ALTER TABLE ONLY "public"."serendipity_suggestions"
    ADD CONSTRAINT "serendipity_suggestions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."settlement_calculations"
    ADD CONSTRAINT "settlement_calculations_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."settlement_calculations"
    ADD CONSTRAINT "settlement_calculations_trip_id_key" UNIQUE ("trip_id");



ALTER TABLE ONLY "public"."settlement_disputes"
    ADD CONSTRAINT "settlement_disputes_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."settlement_disputes"
    ADD CONSTRAINT "settlement_disputes_settlement_id_key" UNIQUE ("settlement_id");



ALTER TABLE ONLY "public"."settlement_history"
    ADD CONSTRAINT "settlement_history_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."settlement_proofs"
    ADD CONSTRAINT "settlement_proofs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."settlement_proofs"
    ADD CONSTRAINT "settlement_proofs_settlement_id_key" UNIQUE ("settlement_id");



ALTER TABLE ONLY "public"."settlements"
    ADD CONSTRAINT "settlements_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."share_links"
    ADD CONSTRAINT "share_links_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."share_links"
    ADD CONSTRAINT "share_links_token_hash_key" UNIQUE ("token_hash");



ALTER TABLE ONLY "public"."shareable_calendars"
    ADD CONSTRAINT "shareable_calendars_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."shareable_calendars"
    ADD CONSTRAINT "shareable_calendars_share_token_key" UNIQUE ("share_token");



ALTER TABLE ONLY "public"."slo_metrics"
    ADD CONSTRAINT "slo_metrics_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."support_conversations"
    ADD CONSTRAINT "support_conversations_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."taxonomy_versions"
    ADD CONSTRAINT "taxonomy_versions_pkey" PRIMARY KEY ("version");



ALTER TABLE ONLY "public"."tips_preferences"
    ADD CONSTRAINT "tips_preferences_pkey" PRIMARY KEY ("user_id");



ALTER TABLE ONLY "public"."traffic_updates"
    ADD CONSTRAINT "traffic_updates_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."travel_alerts"
    ADD CONSTRAINT "travel_alerts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."travel_operations"
    ADD CONSTRAINT "travel_operations_pkey" PRIMARY KEY ("operation_id");



ALTER TABLE ONLY "public"."traveler_profiles"
    ADD CONSTRAINT "traveler_profiles_pkey" PRIMARY KEY ("user_id");



ALTER TABLE ONLY "public"."trip_assemblies"
    ADD CONSTRAINT "trip_assemblies_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."trip_assemblies"
    ADD CONSTRAINT "trip_assemblies_trip_id_key" UNIQUE ("trip_id");



ALTER TABLE ONLY "public"."trip_change_log"
    ADD CONSTRAINT "trip_change_log_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."trip_change_previews"
    ADD CONSTRAINT "trip_change_previews_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."trip_forecasts"
    ADD CONSTRAINT "trip_forecasts_pkey" PRIMARY KEY ("trip_id", "scope", "member_id");



ALTER TABLE ONLY "public"."trip_groups"
    ADD CONSTRAINT "trip_groups_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."trip_health_analyses"
    ADD CONSTRAINT "trip_health_analyses_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."trip_impacts"
    ADD CONSTRAINT "trip_impacts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."trip_issues"
    ADD CONSTRAINT "trip_issues_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."trip_members"
    ADD CONSTRAINT "trip_members_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."trip_planning_preferences"
    ADD CONSTRAINT "trip_planning_preferences_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."trips"
    ADD CONSTRAINT "trips_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."typing_indicators"
    ADD CONSTRAINT "typing_indicators_pkey" PRIMARY KEY ("group_id", "user_id");



ALTER TABLE ONLY "public"."operation_attempts"
    ADD CONSTRAINT "uq_operation_attempt" UNIQUE ("operation_id", "attempt_number");



ALTER TABLE ONLY "public"."idempotency_records"
    ADD CONSTRAINT "uq_user_idempotency_key" UNIQUE ("user_id", "idempotency_key");



ALTER TABLE ONLY "public"."user_actions"
    ADD CONSTRAINT "user_actions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."user_alert_preferences"
    ADD CONSTRAINT "user_alert_preferences_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."user_alert_preferences"
    ADD CONSTRAINT "user_alert_preferences_user_id_key" UNIQUE ("user_id");



ALTER TABLE ONLY "public"."user_behavior_profiles"
    ADD CONSTRAINT "user_behavior_profiles_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."user_behavior_profiles"
    ADD CONSTRAINT "user_behavior_profiles_user_id_analysis_date_key" UNIQUE ("user_id", "analysis_date");



ALTER TABLE ONLY "public"."user_devices"
    ADD CONSTRAINT "user_devices_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."user_limits"
    ADD CONSTRAINT "user_limits_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."user_limits"
    ADD CONSTRAINT "user_limits_user_id_key" UNIQUE ("user_id");



ALTER TABLE ONLY "public"."user_push_tokens"
    ADD CONSTRAINT "user_push_tokens_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."user_push_tokens"
    ADD CONSTRAINT "user_push_tokens_user_id_expo_push_token_key" UNIQUE ("user_id", "expo_push_token");



ALTER TABLE ONLY "public"."user_recommendation_profiles"
    ADD CONSTRAINT "user_recommendation_profiles_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."user_recommendation_profiles"
    ADD CONSTRAINT "user_recommendation_profiles_user_id_key" UNIQUE ("user_id");



ALTER TABLE ONLY "public"."weather_forecasts"
    ADD CONSTRAINT "weather_forecasts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."weather_forecasts"
    ADD CONSTRAINT "weather_forecasts_user_id_trip_id_location_forecast_date_key" UNIQUE ("user_id", "trip_id", "location", "forecast_date");



CREATE INDEX "alert_preferences_v2_trip_id_idx" ON "public"."alert_preferences_v2" USING "btree" ("trip_id");



CREATE UNIQUE INDEX "alert_preferences_v2_user_kind_trip_uq" ON "public"."alert_preferences_v2" USING "btree" ("user_id", "kind", "trip_id") NULLS NOT DISTINCT;



CREATE INDEX "api_alerts_unnotified_idx" ON "public"."api_alerts" USING "btree" ("created_at") WHERE (("resolved_at" IS NULL) AND ("notified_at" IS NULL));



CREATE INDEX "auth_identities_provider_subject_idx" ON "public"."auth_identities" USING "btree" ("provider_subject");



CREATE INDEX "booking_reservations_trip_id_idx" ON "public"."booking_reservations" USING "btree" ("trip_id");



CREATE INDEX "calendar_invitations_trip_id_idx" ON "public"."calendar_invitations" USING "btree" ("trip_id");



CREATE INDEX "checkins_trip_id_idx" ON "public"."checkins" USING "btree" ("trip_id");



CREATE INDEX "copilot_drafts_trip_id_idx" ON "public"."copilot_drafts" USING "btree" ("trip_id");



CREATE INDEX "day_energy_snapshots_trip_id_idx" ON "public"."day_energy_snapshots" USING "btree" ("trip_id");



CREATE INDEX "disaster_alerts_trip_id_idx" ON "public"."disaster_alerts" USING "btree" ("trip_id");



CREATE INDEX "disruption_reports_trip_id_idx" ON "public"."disruption_reports" USING "btree" ("trip_id");



CREATE INDEX "eta_links_trip_id_idx" ON "public"."eta_links" USING "btree" ("trip_id");



CREATE INDEX "export_jobs_trip_id_idx" ON "public"."export_jobs" USING "btree" ("trip_id");



CREATE INDEX "flight_disruptions_trip_id_idx" ON "public"."flight_disruptions" USING "btree" ("trip_id");



CREATE INDEX "flight_signals_trip_id_idx" ON "public"."flight_signals" USING "btree" ("trip_id");



CREATE INDEX "fx_rates_quote_asof_idx" ON "public"."fx_rates" USING "btree" ("quote", "as_of" DESC);



CREATE INDEX "health_assessments_trip_id_idx" ON "public"."health_assessments" USING "btree" ("trip_id");



CREATE INDEX "hotel_loyalty_cache_expires" ON "public"."hotel_loyalty_cache" USING "btree" ("user_id", "program", "expires_at");



CREATE INDEX "hotel_loyalty_tokens_active" ON "public"."hotel_loyalty_tokens" USING "btree" ("user_id", "is_active", "connection_status");



CREATE INDEX "hotel_oauth_sessions_user_expires" ON "public"."hotel_oauth_sessions" USING "btree" ("user_id", "expires_at");



CREATE INDEX "hotel_token_audit_log_user_program" ON "public"."hotel_token_audit_log" USING "btree" ("user_id", "program", "created_at" DESC);



CREATE INDEX "idempotency_records_trip_id_idx" ON "public"."idempotency_records" USING "btree" ("trip_id");



CREATE INDEX "idx_agent_metrics_name" ON "public"."agent_metrics" USING "btree" ("agent_name");



CREATE INDEX "idx_agent_metrics_timestamp" ON "public"."agent_metrics" USING "btree" ("execution_timestamp" DESC);



CREATE INDEX "idx_airline_loyalty_cache_expires" ON "public"."airline_loyalty_cache" USING "btree" ("expires_at");



CREATE INDEX "idx_airline_loyalty_cache_user_program" ON "public"."airline_loyalty_cache" USING "btree" ("user_id", "program");



CREATE INDEX "idx_alert_batches_scheduled" ON "public"."alert_batches" USING "btree" ("scheduled_for", "status");



CREATE INDEX "idx_alert_batches_user_status" ON "public"."alert_batches" USING "btree" ("user_id", "status");



CREATE INDEX "idx_alert_delivery_alert" ON "public"."alert_delivery_log" USING "btree" ("alert_id");



CREATE UNIQUE INDEX "idx_alert_preferences_user_global" ON "public"."alert_preferences" USING "btree" ("user_id") WHERE ("trip_id" IS NULL);



CREATE UNIQUE INDEX "idx_alert_preferences_user_trip" ON "public"."alert_preferences" USING "btree" ("user_id", "trip_id") WHERE ("trip_id" IS NOT NULL);



CREATE INDEX "idx_alerts_severity" ON "public"."api_alerts" USING "btree" ("severity", "created_at" DESC);



CREATE INDEX "idx_availability_reservation" ON "public"."availability_snapshots" USING "btree" ("reservation_id", "snapshot_at" DESC);



CREATE INDEX "idx_better_deals_reservation" ON "public"."better_deals" USING "btree" ("reservation_id", "expires_at" DESC);



CREATE INDEX "idx_budget_analyses_itinerary_id" ON "public"."budget_analyses" USING "btree" ("itinerary_id");



CREATE INDEX "idx_budget_analyses_trip_id" ON "public"."budget_analyses" USING "btree" ("trip_id");



CREATE INDEX "idx_cache_expires" ON "public"."api_cache_entries" USING "btree" ("expires_at");



CREATE INDEX "idx_cache_service" ON "public"."api_cache_entries" USING "btree" ("service");



CREATE INDEX "idx_cache_stats_hits" ON "public"."cache_stats" USING "btree" ("cache_hits" DESC);



CREATE INDEX "idx_cache_stats_updated" ON "public"."cache_stats" USING "btree" ("updated_at" DESC);



CREATE INDEX "idx_calculations_trip" ON "public"."settlement_calculations" USING "btree" ("trip_id");



CREATE INDEX "idx_calendar_connections_user" ON "public"."calendar_connections" USING "btree" ("user_id");



CREATE INDEX "idx_calendar_event_mappings_trip" ON "public"."calendar_event_mappings" USING "btree" ("user_id", "trip_id");



CREATE INDEX "idx_calendar_sync_log_trip" ON "public"."calendar_sync_log" USING "btree" ("trip_id");



CREATE INDEX "idx_calendar_sync_log_user" ON "public"."calendar_sync_log" USING "btree" ("user_id");



CREATE INDEX "idx_concurrency_audit_created" ON "public"."concurrency_audit_log" USING "btree" ("created_at" DESC);



CREATE INDEX "idx_concurrency_audit_event" ON "public"."concurrency_audit_log" USING "btree" ("event_type");



CREATE INDEX "idx_concurrency_audit_operation" ON "public"."concurrency_audit_log" USING "btree" ("operation_id");



CREATE INDEX "idx_copilot_proposals_alert" ON "public"."copilot_proposals" USING "btree" ("alert_id") WHERE ("alert_id" IS NOT NULL);



CREATE INDEX "idx_copilot_proposals_base_version" ON "public"."copilot_proposals" USING "btree" ("base_itinerary_version_id");



CREATE INDEX "idx_copilot_proposals_trip" ON "public"."copilot_proposals" USING "btree" ("trip_id", "user_id", "created_at" DESC);



CREATE INDEX "idx_copilot_proposals_trip_status" ON "public"."copilot_proposals" USING "btree" ("trip_id", "status");



CREATE INDEX "idx_cost_alerts_timestamp" ON "public"."cost_alerts" USING "btree" ("alert_timestamp" DESC);



CREATE INDEX "idx_cost_alerts_type" ON "public"."cost_alerts" USING "btree" ("threshold_type");



CREATE INDEX "idx_cost_daily_date" ON "public"."api_cost_daily" USING "btree" ("date" DESC);



CREATE INDEX "idx_cost_log_date" ON "public"."api_cost_log" USING "btree" ("called_at" DESC);



CREATE INDEX "idx_cost_log_service_date" ON "public"."api_cost_log" USING "btree" ("service", "called_at" DESC);



CREATE INDEX "idx_daily_friction_itinerary_id" ON "public"."daily_friction_scores" USING "btree" ("itinerary_id");



CREATE INDEX "idx_daily_friction_trip_id" ON "public"."daily_friction_scores" USING "btree" ("trip_id");



CREATE INDEX "idx_daily_friction_user_id" ON "public"."daily_friction_scores" USING "btree" ("user_id");



CREATE INDEX "idx_daily_spend_date" ON "public"."daily_spend" USING "btree" ("date" DESC);



CREATE INDEX "idx_dedup_cache_expires" ON "public"."dedup_cache" USING "btree" ("cache_expires_at");



CREATE INDEX "idx_dedup_cache_savings" ON "public"."dedup_cache" USING "btree" ("estimated_savings" DESC);



CREATE INDEX "idx_dedup_expires" ON "public"."alert_dedup_log" USING "btree" ("expires_at");



CREATE INDEX "idx_dedup_user_fingerprint" ON "public"."alert_dedup_log" USING "btree" ("user_id", "fingerprint");



CREATE INDEX "idx_delivery_batch" ON "public"."delivery_attempts" USING "btree" ("batch_id");



CREATE INDEX "idx_delivery_user_channel" ON "public"."delivery_attempts" USING "btree" ("user_id", "channel", "created_at" DESC);



CREATE INDEX "idx_disputes_settlement" ON "public"."settlement_disputes" USING "btree" ("settlement_id");



CREATE INDEX "idx_document_imports_status" ON "public"."document_imports" USING "btree" ("user_id", "processing_status");



CREATE INDEX "idx_document_imports_trip" ON "public"."document_imports" USING "btree" ("trip_id", "user_id");



CREATE INDEX "idx_document_imports_user" ON "public"."document_imports" USING "btree" ("user_id");



CREATE INDEX "idx_email_attachments_message" ON "public"."email_attachments" USING "btree" ("import_message_id");



CREATE INDEX "idx_email_connections_user" ON "public"."email_connections" USING "btree" ("user_id");



CREATE INDEX "idx_email_imports_connection" ON "public"."email_message_imports" USING "btree" ("email_connection_id");



CREATE INDEX "idx_email_imports_status" ON "public"."email_message_imports" USING "btree" ("user_id", "extraction_status");



CREATE INDEX "idx_email_imports_trip" ON "public"."email_message_imports" USING "btree" ("matched_trip_id");



CREATE INDEX "idx_email_imports_user" ON "public"."email_message_imports" USING "btree" ("user_id");



CREATE INDEX "idx_expenses_category" ON "public"."expenses" USING "btree" ("category");



CREATE INDEX "idx_expenses_group" ON "public"."expenses" USING "btree" ("group_id");



CREATE INDEX "idx_expenses_paid_by" ON "public"."expenses" USING "btree" ("paid_by");



CREATE INDEX "idx_expenses_trip" ON "public"."expenses" USING "btree" ("trip_id");



CREATE INDEX "idx_group_members_group" ON "public"."group_members" USING "btree" ("group_id");



CREATE INDEX "idx_group_members_token" ON "public"."group_members" USING "btree" ("invite_token");



CREATE INDEX "idx_group_members_user" ON "public"."group_members" USING "btree" ("user_id");



CREATE INDEX "idx_happiness_scores_trip" ON "public"."happiness_scores" USING "btree" ("trip_id");



CREATE INDEX "idx_happiness_scores_user" ON "public"."happiness_scores" USING "btree" ("user_id");



CREATE INDEX "idx_happy_moments_trip" ON "public"."happy_moments" USING "btree" ("trip_id");



CREATE INDEX "idx_happy_moments_user" ON "public"."happy_moments" USING "btree" ("user_id");



CREATE INDEX "idx_idempotency_keys_key" ON "public"."idempotency_keys" USING "btree" ("idempotency_key");



CREATE INDEX "idx_idempotency_keys_operation_id" ON "public"."idempotency_keys" USING "btree" ("operation_id");



CREATE INDEX "idx_idempotency_records_key" ON "public"."idempotency_records" USING "btree" ("idempotency_key");



CREATE INDEX "idx_idempotency_records_operation" ON "public"."idempotency_records" USING "btree" ("operation_id");



CREATE INDEX "idx_idempotency_records_user" ON "public"."idempotency_records" USING "btree" ("user_id");



CREATE INDEX "idx_important_info_trip" ON "public"."important_information" USING "btree" ("trip_id", "user_id") WHERE ("trip_id" IS NOT NULL);



CREATE INDEX "idx_important_info_user" ON "public"."important_information" USING "btree" ("user_id");



CREATE INDEX "idx_inapp_user_active" ON "public"."inapp_notifications" USING "btree" ("user_id", "dismissed", "created_at" DESC);



CREATE INDEX "idx_inapp_user_unread" ON "public"."inapp_notifications" USING "btree" ("user_id", "read", "created_at" DESC);



CREATE INDEX "idx_itinerary_versions_alert" ON "public"."itinerary_versions" USING "btree" ("alert_id") WHERE ("alert_id" IS NOT NULL);



CREATE INDEX "idx_itinerary_versions_is_active" ON "public"."itinerary_versions" USING "btree" ("trip_id", "is_active");



CREATE INDEX "idx_itinerary_versions_post_activation_status" ON "public"."itinerary_versions" USING "btree" ("trip_id", "post_activation_status");



CREATE INDEX "idx_itinerary_versions_proposal" ON "public"."itinerary_versions" USING "btree" ("proposal_id");



CREATE INDEX "idx_itinerary_versions_trip_id" ON "public"."itinerary_versions" USING "btree" ("trip_id");



CREATE INDEX "idx_itinerary_versions_user_id" ON "public"."itinerary_versions" USING "btree" ("user_id");



CREATE INDEX "idx_line_items_expense" ON "public"."expense_line_items" USING "btree" ("expense_id");



CREATE INDEX "idx_loop_executions_date" ON "public"."loop_executions" USING "btree" ("execution_start" DESC);



CREATE INDEX "idx_loop_executions_name" ON "public"."loop_executions" USING "btree" ("loop_name");



CREATE INDEX "idx_loop_executions_status" ON "public"."loop_executions" USING "btree" ("status");



CREATE INDEX "idx_messages_group" ON "public"."group_messages" USING "btree" ("group_id", "created_at" DESC);



CREATE INDEX "idx_messages_pinned" ON "public"."group_messages" USING "btree" ("group_id", "pinned") WHERE ("pinned" = true);



CREATE INDEX "idx_messages_user" ON "public"."group_messages" USING "btree" ("user_id");



CREATE INDEX "idx_monitored_entities_reservation" ON "public"."monitored_entities" USING "btree" ("reservation_id") WHERE ("reservation_id" IS NOT NULL);



CREATE INDEX "idx_monitored_entities_trip" ON "public"."monitored_entities" USING "btree" ("trip_id", "user_id");



CREATE INDEX "idx_monitored_entities_type" ON "public"."monitored_entities" USING "btree" ("trip_id", "entity_type");



CREATE INDEX "idx_monitoring_events_entity" ON "public"."monitoring_events" USING "btree" ("monitored_entity_id") WHERE ("monitored_entity_id" IS NOT NULL);



CREATE INDEX "idx_monitoring_events_entity_type" ON "public"."monitoring_events" USING "btree" ("monitored_entity_id", "event_type", "status");



CREATE INDEX "idx_monitoring_events_fingerprint" ON "public"."monitoring_events" USING "btree" ("fingerprint") WHERE ("fingerprint" IS NOT NULL);



CREATE INDEX "idx_monitoring_events_impact_status" ON "public"."monitoring_events" USING "btree" ("impact_analysis_status") WHERE ("impact_analysis_status" = 'PENDING'::"text");



CREATE INDEX "idx_monitoring_events_status" ON "public"."monitoring_events" USING "btree" ("trip_id", "status");



CREATE INDEX "idx_monitoring_events_trip" ON "public"."monitoring_events" USING "btree" ("trip_id", "detected_at" DESC);



CREATE INDEX "idx_monitoring_snapshots_entity" ON "public"."monitoring_snapshots" USING "btree" ("monitored_entity_id", "captured_at" DESC);



CREATE INDEX "idx_notification_eligibility_alert" ON "public"."notification_eligibility" USING "btree" ("alert_id");



CREATE INDEX "idx_notification_eligibility_user" ON "public"."notification_eligibility" USING "btree" ("user_id", "trip_id");



CREATE INDEX "idx_offline_packs_trip" ON "public"."offline_trip_packs" USING "btree" ("trip_id");



CREATE INDEX "idx_offline_packs_user" ON "public"."offline_trip_packs" USING "btree" ("user_id");



CREATE INDEX "idx_operation_attempts_operation_id" ON "public"."operation_attempts" USING "btree" ("operation_id");



CREATE INDEX "idx_operation_attempts_status" ON "public"."operation_attempts" USING "btree" ("status");



CREATE INDEX "idx_operation_locks_expires_at" ON "public"."operation_locks" USING "btree" ("expires_at");



CREATE INDEX "idx_operation_locks_operation_id" ON "public"."operation_locks" USING "btree" ("operation_id");



CREATE INDEX "idx_operation_locks_trip_id" ON "public"."operation_locks" USING "btree" ("trip_id");



CREATE INDEX "idx_pace_analyses_itinerary_id" ON "public"."pace_analyses" USING "btree" ("itinerary_id");



CREATE INDEX "idx_pace_analyses_trip_id" ON "public"."pace_analyses" USING "btree" ("trip_id");



CREATE INDEX "idx_perf_metrics_date" ON "public"."performance_metrics" USING "btree" ("measurement_date" DESC);



CREATE INDEX "idx_perf_metrics_endpoint" ON "public"."performance_metrics" USING "btree" ("endpoint");



CREATE INDEX "idx_pipeline_recovery_log_next_attempt_at" ON "public"."pipeline_recovery_log" USING "btree" ("next_attempt_at") WHERE ("recovery_status" = 'RETRY_PENDING'::"text");



CREATE INDEX "idx_pipeline_recovery_log_operation_id_status" ON "public"."pipeline_recovery_log" USING "btree" ("operation_id", "recovery_status") WHERE ("operation_id" IS NOT NULL);



CREATE INDEX "idx_pipeline_recovery_operation_type" ON "public"."pipeline_recovery_log" USING "btree" ("operation_type");



CREATE INDEX "idx_plan_changes_itinerary_id" ON "public"."plan_changes" USING "btree" ("itinerary_id");



CREATE INDEX "idx_plan_changes_trip_id" ON "public"."plan_changes" USING "btree" ("trip_id");



CREATE INDEX "idx_poll_options_poll" ON "public"."poll_options" USING "btree" ("poll_id");



CREATE INDEX "idx_poll_votes_poll" ON "public"."poll_votes" USING "btree" ("poll_id");



CREATE INDEX "idx_poll_votes_user" ON "public"."poll_votes" USING "btree" ("user_id");



CREATE INDEX "idx_polls_group" ON "public"."polls" USING "btree" ("group_id");



CREATE INDEX "idx_polls_status" ON "public"."polls" USING "btree" ("status");



CREATE INDEX "idx_polls_trip" ON "public"."polls" USING "btree" ("trip_id");



CREATE INDEX "idx_pre_trip_readiness_trip" ON "public"."pre_trip_readiness" USING "btree" ("trip_id");



CREATE INDEX "idx_pre_trip_readiness_version_id" ON "public"."pre_trip_readiness" USING "btree" ("itinerary_version_id");



CREATE INDEX "idx_pre_trip_tasks_status" ON "public"."pre_trip_tasks" USING "btree" ("trip_id", "status");



CREATE INDEX "idx_pre_trip_tasks_trip" ON "public"."pre_trip_tasks" USING "btree" ("trip_id", "user_id");



CREATE INDEX "idx_price_history_reservation" ON "public"."reservation_price_history" USING "btree" ("reservation_id", "recorded_at" DESC);



CREATE INDEX "idx_price_history_user" ON "public"."reservation_price_history" USING "btree" ("user_id", "recorded_at" DESC);



CREATE INDEX "idx_price_snapshots_reservation" ON "public"."price_snapshots" USING "btree" ("reservation_id", "recorded_at" DESC);



CREATE INDEX "idx_rate_limit_key_window" ON "public"."rate_limit_buckets" USING "btree" ("bucket_key", "window_end");



CREATE INDEX "idx_reactions_message" ON "public"."message_reactions" USING "btree" ("message_id");



CREATE INDEX "idx_readiness_items_severity" ON "public"."readiness_items" USING "btree" ("trip_id", "severity");



CREATE INDEX "idx_readiness_items_status" ON "public"."readiness_items" USING "btree" ("trip_id", "status");



CREATE INDEX "idx_readiness_items_trip" ON "public"."readiness_items" USING "btree" ("trip_id", "user_id");



CREATE INDEX "idx_recommendations_score" ON "public"."recommendations" USING "btree" ("overall_score" DESC);



CREATE INDEX "idx_recommendations_trip" ON "public"."recommendations" USING "btree" ("trip_id");



CREATE INDEX "idx_recommendations_user_location" ON "public"."recommendations" USING "btree" ("user_id", "location", "category");



CREATE INDEX "idx_recovery_log_object" ON "public"."pipeline_recovery_log" USING "btree" ("related_object_type", "related_object_id");



CREATE INDEX "idx_recovery_log_pending" ON "public"."pipeline_recovery_log" USING "btree" ("recovery_status", "created_at") WHERE ("recovery_status" = ANY (ARRAY['PENDING'::"text", 'RETRYING'::"text"]));



CREATE INDEX "idx_recovery_log_trip" ON "public"."pipeline_recovery_log" USING "btree" ("trip_id", "recovery_status");



CREATE UNIQUE INDEX "idx_recovery_log_upsert" ON "public"."pipeline_recovery_log" USING "btree" ("related_object_id", "operation") WHERE ("related_object_id" IS NOT NULL);



CREATE INDEX "idx_reservations_conf" ON "public"."reservations" USING "btree" ("trip_id", "confirmation_number") WHERE ("confirmation_number" IS NOT NULL);



CREATE INDEX "idx_reservations_date" ON "public"."reservations" USING "btree" ("trip_id", "start_date");



CREATE INDEX "idx_reservations_trip" ON "public"."reservations" USING "btree" ("trip_id", "user_id");



CREATE INDEX "idx_reservations_type" ON "public"."reservations" USING "btree" ("trip_id", "reservation_type");



CREATE INDEX "idx_search_analytics_count" ON "public"."search_analytics" USING "btree" ("search_count" DESC);



CREATE INDEX "idx_search_analytics_type" ON "public"."search_analytics" USING "btree" ("search_type");



CREATE INDEX "idx_secure_docs_active" ON "public"."secure_documents" USING "btree" ("user_id", "is_active");



CREATE INDEX "idx_secure_docs_trip" ON "public"."secure_documents" USING "btree" ("trip_id", "user_id") WHERE ("trip_id" IS NOT NULL);



CREATE INDEX "idx_secure_docs_type" ON "public"."secure_documents" USING "btree" ("user_id", "document_type");



CREATE INDEX "idx_secure_docs_user" ON "public"."secure_documents" USING "btree" ("user_id");



CREATE INDEX "idx_settlement_history_created" ON "public"."settlement_history" USING "btree" ("created_at");



CREATE INDEX "idx_settlement_history_settlement" ON "public"."settlement_history" USING "btree" ("settlement_id");



CREATE INDEX "idx_settlements_from" ON "public"."settlements" USING "btree" ("from_user");



CREATE INDEX "idx_settlements_group" ON "public"."settlements" USING "btree" ("group_id");



CREATE INDEX "idx_settlements_payer_trip" ON "public"."settlements" USING "btree" ("from_user", "trip_id", "status");



CREATE INDEX "idx_settlements_pending" ON "public"."settlements" USING "btree" ("status", "created_at");



CREATE INDEX "idx_settlements_receiver_trip" ON "public"."settlements" USING "btree" ("to_user", "trip_id", "status");



CREATE INDEX "idx_settlements_status" ON "public"."settlements" USING "btree" ("status");



CREATE INDEX "idx_settlements_to" ON "public"."settlements" USING "btree" ("to_user");



CREATE INDEX "idx_settlements_trip" ON "public"."settlements" USING "btree" ("trip_id");



CREATE INDEX "idx_snapshots_event" ON "public"."monitoring_snapshots" USING "btree" ("monitoring_event_id") WHERE ("monitoring_event_id" IS NOT NULL);



CREATE INDEX "idx_snapshots_pipeline" ON "public"."monitoring_snapshots" USING "btree" ("pipeline_status") WHERE ("pipeline_status" = 'PENDING'::"text");



CREATE INDEX "idx_splits_expense" ON "public"."expense_splits" USING "btree" ("expense_id");



CREATE INDEX "idx_splits_settled" ON "public"."expense_splits" USING "btree" ("settled");



CREATE INDEX "idx_splits_user" ON "public"."expense_splits" USING "btree" ("user_id");



CREATE INDEX "idx_travel_alerts_category" ON "public"."travel_alerts" USING "btree" ("alert_category");



CREATE INDEX "idx_travel_alerts_fingerprint" ON "public"."travel_alerts" USING "btree" ("fingerprint") WHERE ("fingerprint" IS NOT NULL);



CREATE INDEX "idx_travel_alerts_group" ON "public"."travel_alerts" USING "btree" ("alert_group_id") WHERE ("alert_group_id" IS NOT NULL);



CREATE INDEX "idx_travel_alerts_impacts" ON "public"."travel_alerts" USING "gin" ("impact_ids") WHERE ("impact_ids" IS NOT NULL);



CREATE INDEX "idx_travel_alerts_scheduled" ON "public"."travel_alerts" USING "btree" ("scheduled_for") WHERE ("scheduled_for" IS NOT NULL);



CREATE INDEX "idx_travel_alerts_scoring" ON "public"."travel_alerts" USING "btree" ("trip_id", "status", "impact_score" DESC NULLS LAST) WHERE ("status" = 'ACTIVE'::"text");



CREATE INDEX "idx_travel_alerts_snooze" ON "public"."travel_alerts" USING "btree" ("snooze_until") WHERE ("snooze_until" IS NOT NULL);



CREATE INDEX "idx_travel_alerts_status" ON "public"."travel_alerts" USING "btree" ("trip_id", "status", "priority");



CREATE INDEX "idx_travel_alerts_trip" ON "public"."travel_alerts" USING "btree" ("trip_id", "user_id");



CREATE INDEX "idx_travel_alerts_unread" ON "public"."travel_alerts" USING "btree" ("trip_id", "unread") WHERE ("unread" = true);



CREATE INDEX "idx_travel_operations_idempotency" ON "public"."travel_operations" USING "btree" ("idempotency_key") WHERE ("idempotency_key" IS NOT NULL);



CREATE INDEX "idx_travel_operations_state" ON "public"."travel_operations" USING "btree" ("current_state");



CREATE INDEX "idx_travel_operations_trip_id" ON "public"."travel_operations" USING "btree" ("trip_id");



CREATE INDEX "idx_travel_operations_type" ON "public"."travel_operations" USING "btree" ("operation_type");



CREATE INDEX "idx_travel_operations_user_id" ON "public"."travel_operations" USING "btree" ("user_id");



CREATE INDEX "idx_trip_assemblies_trip" ON "public"."trip_assemblies" USING "btree" ("trip_id");



CREATE INDEX "idx_trip_assemblies_user" ON "public"."trip_assemblies" USING "btree" ("user_id");



CREATE INDEX "idx_trip_change_log_created_at" ON "public"."trip_change_log" USING "btree" ("created_at" DESC);



CREATE INDEX "idx_trip_change_log_trip_id" ON "public"."trip_change_log" USING "btree" ("trip_id");



CREATE INDEX "idx_trip_change_log_user_id" ON "public"."trip_change_log" USING "btree" ("user_id");



CREATE INDEX "idx_trip_change_previews_status" ON "public"."trip_change_previews" USING "btree" ("status");



CREATE INDEX "idx_trip_change_previews_trip_id" ON "public"."trip_change_previews" USING "btree" ("trip_id");



CREATE INDEX "idx_trip_groups_trip" ON "public"."trip_groups" USING "btree" ("trip_id");



CREATE INDEX "idx_trip_health_analyses_version_id" ON "public"."trip_health_analyses" USING "btree" ("version_id");



CREATE INDEX "idx_trip_health_itinerary_id" ON "public"."trip_health_analyses" USING "btree" ("itinerary_id");



CREATE INDEX "idx_trip_health_trip_id" ON "public"."trip_health_analyses" USING "btree" ("trip_id");



CREATE INDEX "idx_trip_health_user_id" ON "public"."trip_health_analyses" USING "btree" ("user_id");



CREATE INDEX "idx_trip_impacts_alert_status" ON "public"."trip_impacts" USING "btree" ("alert_generation_status") WHERE ("alert_generation_status" = 'PENDING'::"text");



CREATE INDEX "idx_trip_impacts_event" ON "public"."trip_impacts" USING "btree" ("monitoring_event_id");



CREATE INDEX "idx_trip_impacts_level" ON "public"."trip_impacts" USING "btree" ("trip_id", "impact_level");



CREATE INDEX "idx_trip_impacts_status" ON "public"."trip_impacts" USING "btree" ("trip_id", "status");



CREATE INDEX "idx_trip_impacts_trip" ON "public"."trip_impacts" USING "btree" ("trip_id", "user_id");



CREATE INDEX "idx_trip_issues_itinerary_id" ON "public"."trip_issues" USING "btree" ("itinerary_id");



CREATE INDEX "idx_trip_issues_status" ON "public"."trip_issues" USING "btree" ("trip_id", "status");



CREATE INDEX "idx_trip_issues_trip_id" ON "public"."trip_issues" USING "btree" ("trip_id");



CREATE INDEX "idx_trip_issues_user_id" ON "public"."trip_issues" USING "btree" ("user_id");



CREATE INDEX "idx_user_actions_date" ON "public"."user_actions" USING "btree" ("date" DESC);



CREATE INDEX "idx_user_actions_feature" ON "public"."user_actions" USING "btree" ("feature");



CREATE INDEX "idx_user_actions_user_id" ON "public"."user_actions" USING "btree" ("user_id");



CREATE INDEX "idx_user_limits_user_id" ON "public"."user_limits" USING "btree" ("user_id");



CREATE INDEX "idx_user_profiles_type" ON "public"."user_behavior_profiles" USING "btree" ("user_type");



CREATE INDEX "idx_user_profiles_user_id" ON "public"."user_behavior_profiles" USING "btree" ("user_id");



CREATE INDEX "ix_activity_actor" ON "public"."activity_events" USING "btree" ("trip_id", "actor_member_id", "at" DESC);



CREATE INDEX "ix_activity_trip" ON "public"."activity_events" USING "btree" ("trip_id", "at" DESC);



CREATE INDEX "ix_agreement_responses_member" ON "public"."agreement_responses" USING "btree" ("trip_id", "member_id");



CREATE INDEX "ix_agreement_responses_trip" ON "public"."agreement_responses" USING "btree" ("trip_id");



CREATE UNIQUE INDEX "ix_alert_prefs_v2_uq" ON "public"."alert_preferences_v2" USING "btree" ("user_id", "kind", "trip_id") NULLS NOT DISTINCT;



CREATE INDEX "ix_alert_prefs_v2_user" ON "public"."alert_preferences_v2" USING "btree" ("user_id");



CREATE INDEX "ix_audit_trip" ON "public"."audit_log" USING "btree" ("trip_id", "created_at" DESC);



CREATE INDEX "ix_ballots_v2_poll" ON "public"."ballots_v2" USING "btree" ("poll_id");



CREATE INDEX "ix_bargain_norms_country" ON "public"."bargain_norms" USING "btree" ("country_code");



CREATE INDEX "ix_budget_notif_scheduled" ON "public"."budget_notification_queue" USING "btree" ("scheduled_for") WHERE ("sent_at" IS NULL);



CREATE INDEX "ix_checkins_due" ON "public"."checkins" USING "btree" ("due_at", "status");



CREATE INDEX "ix_claims_trip" ON "public"."disruption_claims" USING "btree" ("trip_id", "member_id");



CREATE INDEX "ix_comments_target" ON "public"."comments" USING "btree" ("trip_id", "target_type", "target_id");



CREATE INDEX "ix_comments_thread" ON "public"."comments" USING "btree" ("thread_id", "created_at");



CREATE INDEX "ix_copilot_messages" ON "public"."copilot_messages" USING "btree" ("thread_id", "created_at");



CREATE INDEX "ix_copilot_threads" ON "public"."copilot_threads" USING "btree" ("trip_id", "user_id", "last_message_at" DESC);



CREATE INDEX "ix_cost_index_city" ON "public"."cost_index" USING "btree" ("city_code");



CREATE INDEX "ix_dep_edges_trip" ON "public"."dep_edges" USING "btree" ("trip_id");



CREATE INDEX "ix_dep_nodes_trip" ON "public"."dep_nodes" USING "btree" ("trip_id");



CREATE INDEX "ix_devices_user" ON "public"."user_devices" USING "btree" ("user_id");



CREATE INDEX "ix_disruption_cases_trip" ON "public"."disruption_cases" USING "btree" ("trip_id", "status");



CREATE INDEX "ix_embassies_lookup" ON "public"."embassies" USING "btree" ("nationality", "country");



CREATE INDEX "ix_eta_links_token" ON "public"."eta_links" USING "btree" ("token");



CREATE INDEX "ix_export_jobs_user" ON "public"."export_jobs" USING "btree" ("user_id", "created_at" DESC);



CREATE INDEX "ix_idempotency_created" ON "public"."idempotency_keys" USING "btree" ("created_at");



CREATE INDEX "ix_item_ratings_trip" ON "public"."item_ratings" USING "btree" ("trip_id");



CREATE INDEX "ix_item_ratings_user" ON "public"."item_ratings" USING "btree" ("user_id", "created_at" DESC);



CREATE INDEX "ix_itinerary_items_trip" ON "public"."itinerary_items" USING "btree" ("trip_id");



CREATE INDEX "ix_itinerary_items_trip_date" ON "public"."itinerary_items" USING "btree" ("trip_id", "date");



CREATE INDEX "ix_itinerary_items_trip_start" ON "public"."itinerary_items" USING "btree" ("trip_id", "start_time");



CREATE INDEX "ix_location_shares_token" ON "public"."location_shares" USING "btree" ("link_token");



CREATE INDEX "ix_location_shares_user" ON "public"."location_shares" USING "btree" ("user_id", "status");



CREATE INDEX "ix_member_guest_hash" ON "public"."trip_members" USING "btree" ("guest_token_hash") WHERE ("guest_token_hash" IS NOT NULL);



CREATE INDEX "ix_member_trip" ON "public"."trip_members" USING "btree" ("trip_id");



CREATE INDEX "ix_outbox_user" ON "public"."outbox_items" USING "btree" ("user_id", "status");



CREATE INDEX "ix_phrase_cards_country" ON "public"."phrase_cards" USING "btree" ("country_code", "context");



CREATE INDEX "ix_place_reports_place" ON "public"."place_reports" USING "btree" ("place_id", "status");



CREATE INDEX "ix_poll_options_v2_poll" ON "public"."poll_options_v2" USING "btree" ("poll_id");



CREATE INDEX "ix_polls_v2_trip" ON "public"."polls_v2" USING "btree" ("trip_id", "status");



CREATE INDEX "ix_prep_items_trip_member" ON "public"."prep_items" USING "btree" ("trip_id", "member_id");



CREATE INDEX "ix_presence_trip" ON "public"."presence" USING "btree" ("trip_id", "last_seen_at" DESC);



CREATE INDEX "ix_proposals_trip" ON "public"."change_proposals" USING "btree" ("trip_id", "status", "created_at" DESC);



CREATE INDEX "ix_provider_cache_expires" ON "public"."provider_cache" USING "btree" ("expires_at");



CREATE INDEX "ix_provider_cache_provider" ON "public"."provider_cache" USING "btree" ("provider");



CREATE INDEX "ix_replan_applied_trip" ON "public"."replan_applied" USING "btree" ("trip_id");



CREATE INDEX "ix_replan_cache_trip" ON "public"."replan_cache" USING "btree" ("trip_id", "expires_at");



CREATE INDEX "ix_safety_notes_trip" ON "public"."safety_notes" USING "btree" ("trip_id", "computed_at" DESC);



CREATE INDEX "ix_safety_reports_location" ON "public"."safety_reports" USING "btree" ("lat", "lng", "expires_at");



CREATE INDEX "ix_satisfaction_trip_member" ON "public"."satisfaction_ledger" USING "btree" ("trip_id", "member_id", "created_at" DESC);



CREATE INDEX "ix_seren_user_trip" ON "public"."serendipity_suggestions" USING "btree" ("user_id", "trip_id", "shown_at" DESC);



CREATE INDEX "ix_share_links_token" ON "public"."share_links" USING "btree" ("token_hash");



CREATE INDEX "ix_share_links_trip" ON "public"."share_links" USING "btree" ("trip_id");



CREATE INDEX "ix_signals_trip" ON "public"."profile_signals" USING "btree" ("trip_id") WHERE ("trip_id" IS NOT NULL);



CREATE INDEX "ix_signals_user" ON "public"."profile_signals" USING "btree" ("user_id", "occurred_at" DESC);



CREATE INDEX "ix_slo_metrics_metric" ON "public"."slo_metrics" USING "btree" ("metric", "measured_at" DESC);



CREATE INDEX "ix_snapshots_trip_date" ON "public"."day_snapshots" USING "btree" ("trip_id", "date", "created_at" DESC);



CREATE INDEX "ix_support_convos_user" ON "public"."support_conversations" USING "btree" ("user_id", "created_at" DESC);



CREATE INDEX "location_shares_trip_id_idx" ON "public"."location_shares" USING "btree" ("trip_id");



CREATE INDEX "loyalty_aggregator_connections_external_idx" ON "public"."loyalty_aggregator_connections" USING "btree" ("aggregator", "external_user_id") WHERE ("external_user_id" IS NOT NULL);



CREATE INDEX "loyalty_aggregator_connections_user_idx" ON "public"."loyalty_aggregator_connections" USING "btree" ("user_id");



CREATE UNIQUE INDEX "outbox_items_user_idempotency_key_uq" ON "public"."outbox_items" USING "btree" ("user_id", "idempotency_key");



CREATE INDEX "packing_items_trip_id_idx" ON "public"."packing_items" USING "btree" ("trip_id", "sort_order");



CREATE INDEX "place_reports_trip_id_idx" ON "public"."place_reports" USING "btree" ("trip_id");



CREATE INDEX "planning_sessions_trip_id_idx" ON "public"."planning_sessions" USING "btree" ("trip_id");



CREATE UNIQUE INDEX "rate_limit_buckets_key_type_window_uniq" ON "public"."rate_limit_buckets" USING "btree" ("bucket_key", "bucket_type", "window_start");



CREATE INDEX "rollcalls_trip_id_idx" ON "public"."rollcalls" USING "btree" ("trip_id");



CREATE INDEX "safety_assessments_trip_id_idx" ON "public"."safety_assessments" USING "btree" ("trip_id");



CREATE INDEX "safety_reports_trip_id_idx" ON "public"."safety_reports" USING "btree" ("trip_id");



CREATE INDEX "saved_recommendations_trip_id_idx" ON "public"."saved_recommendations" USING "btree" ("trip_id");



CREATE INDEX "serendipity_suggestions_trip_id_idx" ON "public"."serendipity_suggestions" USING "btree" ("trip_id");



CREATE INDEX "shareable_calendars_trip_id_idx" ON "public"."shareable_calendars" USING "btree" ("trip_id");



CREATE INDEX "support_conversations_trip_id_idx" ON "public"."support_conversations" USING "btree" ("trip_id");



CREATE INDEX "traffic_updates_trip_id_idx" ON "public"."traffic_updates" USING "btree" ("trip_id");



CREATE UNIQUE INDEX "trip_groups_one_per_trip" ON "public"."trip_groups" USING "btree" ("trip_id");



CREATE INDEX "trip_planning_preferences_trip_id_idx" ON "public"."trip_planning_preferences" USING "btree" ("trip_id");



CREATE UNIQUE INDEX "uq_copilot_proposal_operation" ON "public"."copilot_proposals" USING "btree" ("proposal_operation_id") WHERE ("proposal_operation_id" IS NOT NULL);



CREATE UNIQUE INDEX "uq_monitoring_event_fingerprint" ON "public"."monitoring_events" USING "btree" ("trip_id", "event_fingerprint") WHERE ("event_fingerprint" IS NOT NULL);



CREATE UNIQUE INDEX "uq_notification_eligibility_opportunity" ON "public"."notification_eligibility" USING "btree" ("alert_id", "user_id", "channel") WHERE (("alert_id" IS NOT NULL) AND ("user_id" IS NOT NULL) AND ("channel" IS NOT NULL));



CREATE UNIQUE INDEX "uq_travel_alert_fingerprint" ON "public"."travel_alerts" USING "btree" ("trip_id", "alert_fingerprint") WHERE (("alert_fingerprint" IS NOT NULL) AND ("status" <> 'DISMISSED'::"text"));



CREATE UNIQUE INDEX "uq_trip_impact_logical" ON "public"."trip_impacts" USING "btree" ("monitoring_event_id", "affected_entity_id", "impact_type") WHERE (("monitoring_event_id" IS NOT NULL) AND ("affected_entity_id" IS NOT NULL) AND ("impact_type" IS NOT NULL));



CREATE UNIQUE INDEX "ux_member_user" ON "public"."trip_members" USING "btree" ("trip_id", "user_id") WHERE (("user_id" IS NOT NULL) AND ("removed_at" IS NULL));



CREATE INDEX "weather_forecasts_trip_id_idx" ON "public"."weather_forecasts" USING "btree" ("trip_id");



CREATE OR REPLACE TRIGGER "alert_preferences_updated_at" BEFORE UPDATE ON "public"."alert_preferences" FOR EACH ROW EXECUTE FUNCTION "public"."update_alert_preferences_updated_at"();



CREATE OR REPLACE TRIGGER "document_imports_updated_at" BEFORE UPDATE ON "public"."document_imports" FOR EACH ROW EXECUTE FUNCTION "public"."update_document_imports_updated_at"();



CREATE OR REPLACE TRIGGER "email_connections_updated_at" BEFORE UPDATE ON "public"."email_connections" FOR EACH ROW EXECUTE FUNCTION "public"."update_email_updated_at"();



CREATE OR REPLACE TRIGGER "email_imports_updated_at" BEFORE UPDATE ON "public"."email_message_imports" FOR EACH ROW EXECUTE FUNCTION "public"."update_email_updated_at"();



CREATE OR REPLACE TRIGGER "group_members_follow_trip" BEFORE INSERT OR DELETE OR UPDATE ON "public"."group_members" FOR EACH ROW EXECUTE FUNCTION "private"."guard_expense_roster"();



CREATE OR REPLACE TRIGGER "important_information_updated_at" BEFORE UPDATE ON "public"."important_information" FOR EACH ROW EXECUTE FUNCTION "public"."update_vault_updated_at"();



CREATE OR REPLACE TRIGGER "loyalty_aggregator_connections_touch" BEFORE UPDATE ON "public"."loyalty_aggregator_connections" FOR EACH ROW EXECUTE FUNCTION "public"."touch_loyalty_aggregator_connections"();



CREATE OR REPLACE TRIGGER "monitored_entities_updated_at" BEFORE UPDATE ON "public"."monitored_entities" FOR EACH ROW EXECUTE FUNCTION "public"."update_monitoring_updated_at"();



CREATE OR REPLACE TRIGGER "monitoring_events_updated_at" BEFORE UPDATE ON "public"."monitoring_events" FOR EACH ROW EXECUTE FUNCTION "public"."update_monitoring_updated_at"();



CREATE OR REPLACE TRIGGER "monitoring_providers_updated_at" BEFORE UPDATE ON "public"."monitoring_providers" FOR EACH ROW EXECUTE FUNCTION "public"."update_monitoring_updated_at"();



CREATE OR REPLACE TRIGGER "offline_packs_updated_at" BEFORE UPDATE ON "public"."offline_trip_packs" FOR EACH ROW EXECUTE FUNCTION "public"."update_offline_packs_updated_at"();



CREATE OR REPLACE TRIGGER "pre_trip_readiness_updated_at" BEFORE UPDATE ON "public"."pre_trip_readiness" FOR EACH ROW EXECUTE FUNCTION "public"."update_readiness_updated_at"();



CREATE OR REPLACE TRIGGER "pre_trip_tasks_updated_at" BEFORE UPDATE ON "public"."pre_trip_tasks" FOR EACH ROW EXECUTE FUNCTION "public"."update_readiness_updated_at"();



CREATE OR REPLACE TRIGGER "readiness_items_updated_at" BEFORE UPDATE ON "public"."readiness_items" FOR EACH ROW EXECUTE FUNCTION "public"."update_readiness_updated_at"();



CREATE OR REPLACE TRIGGER "reservations_updated_at" BEFORE UPDATE ON "public"."reservations" FOR EACH ROW EXECUTE FUNCTION "public"."update_reservations_updated_at"();



CREATE OR REPLACE TRIGGER "secure_documents_updated_at" BEFORE UPDATE ON "public"."secure_documents" FOR EACH ROW EXECUTE FUNCTION "public"."update_vault_updated_at"();



CREATE OR REPLACE TRIGGER "travel_alerts_updated_at" BEFORE UPDATE ON "public"."travel_alerts" FOR EACH ROW EXECUTE FUNCTION "public"."update_travel_alerts_updated_at"();



CREATE OR REPLACE TRIGGER "trip_assemblies_updated_at" BEFORE UPDATE ON "public"."trip_assemblies" FOR EACH ROW EXECUTE FUNCTION "public"."update_trip_assemblies_updated_at"();



CREATE OR REPLACE TRIGGER "trip_groups_follow_trip" BEFORE INSERT OR DELETE ON "public"."trip_groups" FOR EACH ROW EXECUTE FUNCTION "private"."guard_expense_roster"();



CREATE OR REPLACE TRIGGER "trip_impacts_updated_at" BEFORE UPDATE ON "public"."trip_impacts" FOR EACH ROW EXECUTE FUNCTION "public"."update_trip_impacts_updated_at"();



CREATE OR REPLACE TRIGGER "trip_members_expense_group" AFTER INSERT OR DELETE OR UPDATE ON "public"."trip_members" FOR EACH ROW EXECUTE FUNCTION "private"."trip_members_sync_expense_group"();



CREATE OR REPLACE TRIGGER "trips_normalize_tz" BEFORE INSERT OR UPDATE OF "primary_tz" ON "public"."trips" FOR EACH ROW EXECUTE FUNCTION "public"."normalize_trip_tz"();



CREATE OR REPLACE TRIGGER "update_itinerary_versions_updated_at" BEFORE UPDATE ON "public"."itinerary_versions" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_packing_items_updated_at" BEFORE UPDATE ON "public"."packing_items" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_trip_issues_updated_at" BEFORE UPDATE ON "public"."trip_issues" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



ALTER TABLE ONLY "public"."activity_events"
    ADD CONSTRAINT "activity_events_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."activity_read_markers"
    ADD CONSTRAINT "activity_read_markers_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."agreement_completions"
    ADD CONSTRAINT "agreement_completions_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."agreement_questionnaires"
    ADD CONSTRAINT "agreement_questionnaires_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."agreement_responses"
    ADD CONSTRAINT "agreement_responses_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."airline_loyalty_cache"
    ADD CONSTRAINT "airline_loyalty_cache_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."alert_batches"
    ADD CONSTRAINT "alert_batches_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."alert_delivery_log"
    ADD CONSTRAINT "alert_delivery_log_alert_id_fkey" FOREIGN KEY ("alert_id") REFERENCES "public"."travel_alerts"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."alert_preferences"
    ADD CONSTRAINT "alert_preferences_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."alert_preferences_v2"
    ADD CONSTRAINT "alert_preferences_v2_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."alert_queue_stats"
    ADD CONSTRAINT "alert_queue_stats_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."alignment_reports"
    ADD CONSTRAINT "alignment_reports_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."audit_log"
    ADD CONSTRAINT "audit_log_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."auth_identities"
    ADD CONSTRAINT "auth_identities_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."platform_users"("id");



ALTER TABLE ONLY "public"."ballots_v2"
    ADD CONSTRAINT "ballots_v2_poll_id_fkey" FOREIGN KEY ("poll_id") REFERENCES "public"."polls_v2"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."better_deals"
    ADD CONSTRAINT "better_deals_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."booking_connections"
    ADD CONSTRAINT "booking_connections_platform_id_fkey" FOREIGN KEY ("platform_id") REFERENCES "public"."booking_platforms"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."booking_connections"
    ADD CONSTRAINT "booking_connections_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."booking_reservations"
    ADD CONSTRAINT "booking_reservations_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."booking_reservations"
    ADD CONSTRAINT "booking_reservations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."budget_aggregates"
    ADD CONSTRAINT "budget_aggregates_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."budget_analyses"
    ADD CONSTRAINT "budget_analyses_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."budget_analyses"
    ADD CONSTRAINT "budget_analyses_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."budget_notification_queue"
    ADD CONSTRAINT "budget_notification_queue_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."budget_preferences"
    ADD CONSTRAINT "budget_preferences_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."calendar_connections"
    ADD CONSTRAINT "calendar_connections_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."calendar_event_mappings"
    ADD CONSTRAINT "calendar_event_mappings_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."calendar_invitations"
    ADD CONSTRAINT "calendar_invitations_sent_by_fkey" FOREIGN KEY ("sent_by") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."calendar_invitations"
    ADD CONSTRAINT "calendar_invitations_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."calendar_sync_errors"
    ADD CONSTRAINT "calendar_sync_errors_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "public"."calendar_connections"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."calendar_sync_errors"
    ADD CONSTRAINT "calendar_sync_errors_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."calendar_sync_log"
    ADD CONSTRAINT "calendar_sync_log_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."change_proposals"
    ADD CONSTRAINT "change_proposals_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."checkins"
    ADD CONSTRAINT "checkins_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."claim_expenses"
    ADD CONSTRAINT "claim_expenses_claim_id_fkey" FOREIGN KEY ("claim_id") REFERENCES "public"."disruption_claims"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."comments"
    ADD CONSTRAINT "comments_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."copilot_drafts"
    ADD CONSTRAINT "copilot_drafts_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."copilot_messages"
    ADD CONSTRAINT "copilot_messages_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "public"."copilot_threads"("id");



ALTER TABLE ONLY "public"."copilot_proposals"
    ADD CONSTRAINT "copilot_proposals_alert_id_fkey" FOREIGN KEY ("alert_id") REFERENCES "public"."travel_alerts"("id");



ALTER TABLE ONLY "public"."copilot_proposals"
    ADD CONSTRAINT "copilot_proposals_base_itinerary_version_id_fkey" FOREIGN KEY ("base_itinerary_version_id") REFERENCES "public"."itinerary_versions"("id");



ALTER TABLE ONLY "public"."copilot_proposals"
    ADD CONSTRAINT "copilot_proposals_monitoring_event_id_fkey" FOREIGN KEY ("monitoring_event_id") REFERENCES "public"."monitoring_events"("id");



ALTER TABLE ONLY "public"."copilot_proposals"
    ADD CONSTRAINT "copilot_proposals_result_itinerary_version_id_fkey" FOREIGN KEY ("result_itinerary_version_id") REFERENCES "public"."itinerary_versions"("id");



ALTER TABLE ONLY "public"."copilot_proposals"
    ADD CONSTRAINT "copilot_proposals_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."copilot_threads"
    ADD CONSTRAINT "copilot_threads_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."copilot_trip_summaries"
    ADD CONSTRAINT "copilot_trip_summaries_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."cost_alerts"
    ADD CONSTRAINT "cost_alerts_acknowledged_by_user_id_fkey" FOREIGN KEY ("acknowledged_by_user_id") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."daily_friction_scores"
    ADD CONSTRAINT "daily_friction_scores_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."daily_friction_scores"
    ADD CONSTRAINT "daily_friction_scores_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."daily_friction_scores"
    ADD CONSTRAINT "daily_friction_scores_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "public"."itinerary_versions"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."day_energy_snapshots"
    ADD CONSTRAINT "day_energy_snapshots_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."day_snapshots"
    ADD CONSTRAINT "day_snapshots_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."delivery_attempts"
    ADD CONSTRAINT "delivery_attempts_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "public"."alert_batches"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."dep_edges"
    ADD CONSTRAINT "dep_edges_from_node_id_fkey" FOREIGN KEY ("from_node_id") REFERENCES "public"."dep_nodes"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."dep_edges"
    ADD CONSTRAINT "dep_edges_to_node_id_fkey" FOREIGN KEY ("to_node_id") REFERENCES "public"."dep_nodes"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."dep_edges"
    ADD CONSTRAINT "dep_edges_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."dep_nodes"
    ADD CONSTRAINT "dep_nodes_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."disaster_alerts"
    ADD CONSTRAINT "disaster_alerts_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."disaster_alerts"
    ADD CONSTRAINT "disaster_alerts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."dismissed_alerts"
    ADD CONSTRAINT "dismissed_alerts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."disruption_cases"
    ADD CONSTRAINT "disruption_cases_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."disruption_claims"
    ADD CONSTRAINT "disruption_claims_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."disruption_reports"
    ADD CONSTRAINT "disruption_reports_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."document_imports"
    ADD CONSTRAINT "document_imports_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."email_attachments"
    ADD CONSTRAINT "email_attachments_import_message_id_fkey" FOREIGN KEY ("import_message_id") REFERENCES "public"."email_message_imports"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."email_attachments"
    ADD CONSTRAINT "email_attachments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."email_connections"
    ADD CONSTRAINT "email_connections_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."email_message_imports"
    ADD CONSTRAINT "email_message_imports_email_connection_id_fkey" FOREIGN KEY ("email_connection_id") REFERENCES "public"."email_connections"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."email_message_imports"
    ADD CONSTRAINT "email_message_imports_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."eta_links"
    ADD CONSTRAINT "eta_links_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."expense_line_items"
    ADD CONSTRAINT "expense_line_items_expense_id_fkey" FOREIGN KEY ("expense_id") REFERENCES "public"."expenses"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."expense_splits"
    ADD CONSTRAINT "expense_splits_expense_id_fkey" FOREIGN KEY ("expense_id") REFERENCES "public"."expenses"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."expense_splits"
    ADD CONSTRAINT "expense_splits_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."expenses"
    ADD CONSTRAINT "expenses_paid_by_fkey" FOREIGN KEY ("paid_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."expenses"
    ADD CONSTRAINT "expenses_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."export_jobs"
    ADD CONSTRAINT "export_jobs_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."idempotency_records"
    ADD CONSTRAINT "fk_idempotency_records_operation_id" FOREIGN KEY ("operation_id") REFERENCES "public"."travel_operations"("operation_id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."flight_disruptions"
    ADD CONSTRAINT "flight_disruptions_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."flight_disruptions"
    ADD CONSTRAINT "flight_disruptions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."flight_signals"
    ADD CONSTRAINT "flight_signals_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."fx_rates"
    ADD CONSTRAINT "fx_rates_quote_fkey" FOREIGN KEY ("quote") REFERENCES "public"."currencies"("iso_code");



ALTER TABLE ONLY "public"."group_members"
    ADD CONSTRAINT "group_members_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "public"."trip_groups"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."group_members"
    ADD CONSTRAINT "group_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."group_messages"
    ADD CONSTRAINT "group_messages_pinned_by_fkey" FOREIGN KEY ("pinned_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."group_messages"
    ADD CONSTRAINT "group_messages_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."happiness_scores"
    ADD CONSTRAINT "happiness_scores_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."happy_moments"
    ADD CONSTRAINT "happy_moments_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."health_assessments"
    ADD CONSTRAINT "health_assessments_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."health_assessments"
    ADD CONSTRAINT "health_assessments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."hotel_loyalty_cache"
    ADD CONSTRAINT "hotel_loyalty_cache_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."hotel_loyalty_tokens"
    ADD CONSTRAINT "hotel_loyalty_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."hotel_token_audit_log"
    ADD CONSTRAINT "hotel_token_audit_log_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."idempotency_records"
    ADD CONSTRAINT "idempotency_records_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."idempotency_records"
    ADD CONSTRAINT "idempotency_records_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."important_information"
    ADD CONSTRAINT "important_information_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."inapp_notifications"
    ADD CONSTRAINT "inapp_notifications_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "public"."alert_batches"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."inapp_notifications"
    ADD CONSTRAINT "inapp_notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."item_ratings"
    ADD CONSTRAINT "item_ratings_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."itinerary_items"
    ADD CONSTRAINT "itinerary_items_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."itinerary_versions"
    ADD CONSTRAINT "itinerary_versions_alert_id_fkey" FOREIGN KEY ("alert_id") REFERENCES "public"."travel_alerts"("id");



ALTER TABLE ONLY "public"."itinerary_versions"
    ADD CONSTRAINT "itinerary_versions_impact_id_fkey" FOREIGN KEY ("impact_id") REFERENCES "public"."trip_impacts"("id");



ALTER TABLE ONLY "public"."itinerary_versions"
    ADD CONSTRAINT "itinerary_versions_monitoring_event_id_fkey" FOREIGN KEY ("monitoring_event_id") REFERENCES "public"."monitoring_events"("id");



ALTER TABLE ONLY "public"."itinerary_versions"
    ADD CONSTRAINT "itinerary_versions_parent_version_id_fkey" FOREIGN KEY ("parent_version_id") REFERENCES "public"."itinerary_versions"("id");



ALTER TABLE ONLY "public"."itinerary_versions"
    ADD CONSTRAINT "itinerary_versions_proposal_id_fkey" FOREIGN KEY ("proposal_id") REFERENCES "public"."copilot_proposals"("id");



ALTER TABLE ONLY "public"."itinerary_versions"
    ADD CONSTRAINT "itinerary_versions_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."itinerary_versions"
    ADD CONSTRAINT "itinerary_versions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."location_points"
    ADD CONSTRAINT "location_points_share_id_fkey" FOREIGN KEY ("share_id") REFERENCES "public"."location_shares"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."location_shares"
    ADD CONSTRAINT "location_shares_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."loyalty_aggregator_connections"
    ADD CONSTRAINT "loyalty_aggregator_connections_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."member_preferences"
    ADD CONSTRAINT "member_preferences_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "public"."trip_groups"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."member_preferences"
    ADD CONSTRAINT "member_preferences_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."message_attachments"
    ADD CONSTRAINT "message_attachments_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "public"."group_messages"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."message_reactions"
    ADD CONSTRAINT "message_reactions_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "public"."group_messages"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."message_reactions"
    ADD CONSTRAINT "message_reactions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."monitored_entities"
    ADD CONSTRAINT "monitored_entities_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "public"."monitoring_providers"("id");



ALTER TABLE ONLY "public"."monitored_entities"
    ADD CONSTRAINT "monitored_entities_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."monitoring_events"
    ADD CONSTRAINT "monitoring_events_duplicate_of_event_id_fkey" FOREIGN KEY ("duplicate_of_event_id") REFERENCES "public"."monitoring_events"("id");



ALTER TABLE ONLY "public"."monitoring_events"
    ADD CONSTRAINT "monitoring_events_monitored_entity_id_fkey" FOREIGN KEY ("monitored_entity_id") REFERENCES "public"."monitored_entities"("id");



ALTER TABLE ONLY "public"."monitoring_snapshots"
    ADD CONSTRAINT "monitoring_snapshots_monitored_entity_id_fkey" FOREIGN KEY ("monitored_entity_id") REFERENCES "public"."monitored_entities"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."monitoring_snapshots"
    ADD CONSTRAINT "monitoring_snapshots_monitoring_event_id_fkey" FOREIGN KEY ("monitoring_event_id") REFERENCES "public"."monitoring_events"("id");



ALTER TABLE ONLY "public"."monitoring_snapshots"
    ADD CONSTRAINT "monitoring_snapshots_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "public"."monitoring_providers"("id");



ALTER TABLE ONLY "public"."monitoring_snapshots"
    ADD CONSTRAINT "monitoring_snapshots_superseded_by_snapshot_id_fkey" FOREIGN KEY ("superseded_by_snapshot_id") REFERENCES "public"."monitoring_snapshots"("id");



ALTER TABLE ONLY "public"."notification_eligibility"
    ADD CONSTRAINT "notification_eligibility_alert_id_fkey" FOREIGN KEY ("alert_id") REFERENCES "public"."travel_alerts"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."notification_eligibility"
    ADD CONSTRAINT "notification_eligibility_monitoring_event_id_fkey" FOREIGN KEY ("monitoring_event_id") REFERENCES "public"."monitoring_events"("id");



ALTER TABLE ONLY "public"."notification_eligibility"
    ADD CONSTRAINT "notification_eligibility_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."oauth_states"
    ADD CONSTRAINT "oauth_states_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."offline_manifests"
    ADD CONSTRAINT "offline_manifests_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."offline_trip_packs"
    ADD CONSTRAINT "offline_trip_packs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."onboarding_completions"
    ADD CONSTRAINT "onboarding_completions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."operation_attempts"
    ADD CONSTRAINT "operation_attempts_operation_id_fkey" FOREIGN KEY ("operation_id") REFERENCES "public"."travel_operations"("operation_id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."operation_locks"
    ADD CONSTRAINT "operation_locks_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."pace_analyses"
    ADD CONSTRAINT "pace_analyses_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."pace_analyses"
    ADD CONSTRAINT "pace_analyses_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."packing_items"
    ADD CONSTRAINT "packing_items_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."pipeline_recovery_log"
    ADD CONSTRAINT "pipeline_recovery_log_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id");



ALTER TABLE ONLY "public"."pipeline_recovery_log"
    ADD CONSTRAINT "pipeline_recovery_log_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."place_reports"
    ADD CONSTRAINT "place_reports_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."plan_changes"
    ADD CONSTRAINT "plan_changes_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."plan_changes"
    ADD CONSTRAINT "plan_changes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."planning_sessions"
    ADD CONSTRAINT "planning_sessions_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."planning_sessions"
    ADD CONSTRAINT "planning_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."platform_connections"
    ADD CONSTRAINT "platform_connections_platform_id_fkey" FOREIGN KEY ("platform_id") REFERENCES "public"."booking_platforms"("id");



ALTER TABLE ONLY "public"."platform_connections"
    ADD CONSTRAINT "platform_connections_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."playbook_step_completions"
    ADD CONSTRAINT "playbook_step_completions_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."poll_options"
    ADD CONSTRAINT "poll_options_poll_id_fkey" FOREIGN KEY ("poll_id") REFERENCES "public"."polls"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."poll_options_v2"
    ADD CONSTRAINT "poll_options_v2_poll_id_fkey" FOREIGN KEY ("poll_id") REFERENCES "public"."polls_v2"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."poll_votes"
    ADD CONSTRAINT "poll_votes_option_id_fkey" FOREIGN KEY ("option_id") REFERENCES "public"."poll_options"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."poll_votes"
    ADD CONSTRAINT "poll_votes_poll_id_fkey" FOREIGN KEY ("poll_id") REFERENCES "public"."polls"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."poll_votes"
    ADD CONSTRAINT "poll_votes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."polls"
    ADD CONSTRAINT "polls_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."polls"
    ADD CONSTRAINT "polls_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."polls_v2"
    ADD CONSTRAINT "polls_v2_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."pre_trip_readiness"
    ADD CONSTRAINT "pre_trip_readiness_itinerary_version_id_fkey" FOREIGN KEY ("itinerary_version_id") REFERENCES "public"."itinerary_versions"("id");



ALTER TABLE ONLY "public"."pre_trip_readiness"
    ADD CONSTRAINT "pre_trip_readiness_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."pre_trip_tasks"
    ADD CONSTRAINT "pre_trip_tasks_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."prep_items"
    ADD CONSTRAINT "prep_items_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."presence"
    ADD CONSTRAINT "presence_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."price_snapshots"
    ADD CONSTRAINT "price_snapshots_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."profile_signals"
    ADD CONSTRAINT "profile_signals_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."profile_signals"
    ADD CONSTRAINT "profile_signals_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_id_fkey" FOREIGN KEY ("id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."readiness_items"
    ADD CONSTRAINT "readiness_items_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."recommendation_engagement"
    ADD CONSTRAINT "recommendation_engagement_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."recommendations"
    ADD CONSTRAINT "recommendations_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."recommendations"
    ADD CONSTRAINT "recommendations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."replan_applied"
    ADD CONSTRAINT "replan_applied_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."replan_cache"
    ADD CONSTRAINT "replan_cache_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."reservations"
    ADD CONSTRAINT "reservations_possible_duplicate_id_fkey" FOREIGN KEY ("possible_duplicate_id") REFERENCES "public"."reservations"("id");



ALTER TABLE ONLY "public"."reservations"
    ADD CONSTRAINT "reservations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."rollcall_responses"
    ADD CONSTRAINT "rollcall_responses_rollcall_id_fkey" FOREIGN KEY ("rollcall_id") REFERENCES "public"."rollcalls"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."rollcalls"
    ADD CONSTRAINT "rollcalls_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."safety_assessments"
    ADD CONSTRAINT "safety_assessments_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."safety_assessments"
    ADD CONSTRAINT "safety_assessments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."safety_notes"
    ADD CONSTRAINT "safety_notes_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."safety_reports"
    ADD CONSTRAINT "safety_reports_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."satisfaction_ledger"
    ADD CONSTRAINT "satisfaction_ledger_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."saved_recommendations"
    ADD CONSTRAINT "saved_recommendations_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."saved_recommendations"
    ADD CONSTRAINT "saved_recommendations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."search_analytics"
    ADD CONSTRAINT "search_analytics_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."secure_documents"
    ADD CONSTRAINT "secure_documents_replaced_by_id_fkey" FOREIGN KEY ("replaced_by_id") REFERENCES "public"."secure_documents"("id");



ALTER TABLE ONLY "public"."secure_documents"
    ADD CONSTRAINT "secure_documents_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."serendipity_suggestions"
    ADD CONSTRAINT "serendipity_suggestions_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."settlement_calculations"
    ADD CONSTRAINT "settlement_calculations_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."settlement_disputes"
    ADD CONSTRAINT "settlement_disputes_settlement_id_fkey" FOREIGN KEY ("settlement_id") REFERENCES "public"."settlements"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."settlement_history"
    ADD CONSTRAINT "settlement_history_settlement_id_fkey" FOREIGN KEY ("settlement_id") REFERENCES "public"."settlements"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."settlement_proofs"
    ADD CONSTRAINT "settlement_proofs_settlement_id_fkey" FOREIGN KEY ("settlement_id") REFERENCES "public"."settlements"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."settlements"
    ADD CONSTRAINT "settlements_from_user_fkey" FOREIGN KEY ("from_user") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."settlements"
    ADD CONSTRAINT "settlements_to_user_fkey" FOREIGN KEY ("to_user") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."settlements"
    ADD CONSTRAINT "settlements_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."share_links"
    ADD CONSTRAINT "share_links_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."shareable_calendars"
    ADD CONSTRAINT "shareable_calendars_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."shareable_calendars"
    ADD CONSTRAINT "shareable_calendars_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."support_conversations"
    ADD CONSTRAINT "support_conversations_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."traffic_updates"
    ADD CONSTRAINT "traffic_updates_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."traffic_updates"
    ADD CONSTRAINT "traffic_updates_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."travel_alerts"
    ADD CONSTRAINT "travel_alerts_copilot_proposal_id_fkey" FOREIGN KEY ("copilot_proposal_id") REFERENCES "public"."copilot_proposals"("id");



ALTER TABLE ONLY "public"."travel_alerts"
    ADD CONSTRAINT "travel_alerts_monitoring_event_id_fkey" FOREIGN KEY ("monitoring_event_id") REFERENCES "public"."monitoring_events"("id");



ALTER TABLE ONLY "public"."travel_alerts"
    ADD CONSTRAINT "travel_alerts_primary_impact_id_fkey" FOREIGN KEY ("primary_impact_id") REFERENCES "public"."trip_impacts"("id");



ALTER TABLE ONLY "public"."travel_alerts"
    ADD CONSTRAINT "travel_alerts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."travel_operations"
    ADD CONSTRAINT "travel_operations_parent_operation_id_fkey" FOREIGN KEY ("parent_operation_id") REFERENCES "public"."travel_operations"("operation_id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."travel_operations"
    ADD CONSTRAINT "travel_operations_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."travel_operations"
    ADD CONSTRAINT "travel_operations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."traveler_profiles"
    ADD CONSTRAINT "traveler_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."trip_assemblies"
    ADD CONSTRAINT "trip_assemblies_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."trip_change_log"
    ADD CONSTRAINT "trip_change_log_redone_by_change_id_fkey" FOREIGN KEY ("redone_by_change_id") REFERENCES "public"."trip_change_log"("id");



ALTER TABLE ONLY "public"."trip_change_log"
    ADD CONSTRAINT "trip_change_log_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."trip_change_log"
    ADD CONSTRAINT "trip_change_log_undone_by_change_id_fkey" FOREIGN KEY ("undone_by_change_id") REFERENCES "public"."trip_change_log"("id");



ALTER TABLE ONLY "public"."trip_change_log"
    ADD CONSTRAINT "trip_change_log_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."trip_change_previews"
    ADD CONSTRAINT "trip_change_previews_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."trip_change_previews"
    ADD CONSTRAINT "trip_change_previews_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."trip_forecasts"
    ADD CONSTRAINT "trip_forecasts_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."trip_groups"
    ADD CONSTRAINT "trip_groups_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."trip_groups"
    ADD CONSTRAINT "trip_groups_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."trip_health_analyses"
    ADD CONSTRAINT "trip_health_analyses_alert_id_fkey" FOREIGN KEY ("alert_id") REFERENCES "public"."travel_alerts"("id");



ALTER TABLE ONLY "public"."trip_health_analyses"
    ADD CONSTRAINT "trip_health_analyses_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."trip_health_analyses"
    ADD CONSTRAINT "trip_health_analyses_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."trip_health_analyses"
    ADD CONSTRAINT "trip_health_analyses_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "public"."itinerary_versions"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."trip_impacts"
    ADD CONSTRAINT "trip_impacts_generated_alert_id_fkey" FOREIGN KEY ("generated_alert_id") REFERENCES "public"."travel_alerts"("id");



ALTER TABLE ONLY "public"."trip_impacts"
    ADD CONSTRAINT "trip_impacts_monitored_entity_id_fkey" FOREIGN KEY ("monitored_entity_id") REFERENCES "public"."monitored_entities"("id");



ALTER TABLE ONLY "public"."trip_impacts"
    ADD CONSTRAINT "trip_impacts_monitoring_event_id_fkey" FOREIGN KEY ("monitoring_event_id") REFERENCES "public"."monitoring_events"("id");



ALTER TABLE ONLY "public"."trip_impacts"
    ADD CONSTRAINT "trip_impacts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."trip_issues"
    ADD CONSTRAINT "trip_issues_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."trip_issues"
    ADD CONSTRAINT "trip_issues_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."trip_issues"
    ADD CONSTRAINT "trip_issues_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "public"."itinerary_versions"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."trip_members"
    ADD CONSTRAINT "trip_members_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."trip_members"
    ADD CONSTRAINT "trip_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."platform_users"("id");



ALTER TABLE ONLY "public"."trip_planning_preferences"
    ADD CONSTRAINT "trip_planning_preferences_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."trip_planning_preferences"
    ADD CONSTRAINT "trip_planning_preferences_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."trips"
    ADD CONSTRAINT "trips_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."typing_indicators"
    ADD CONSTRAINT "typing_indicators_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."user_actions"
    ADD CONSTRAINT "user_actions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."user_alert_preferences"
    ADD CONSTRAINT "user_alert_preferences_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."user_behavior_profiles"
    ADD CONSTRAINT "user_behavior_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."user_devices"
    ADD CONSTRAINT "user_devices_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."platform_users"("id");



ALTER TABLE ONLY "public"."user_limits"
    ADD CONSTRAINT "user_limits_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."user_push_tokens"
    ADD CONSTRAINT "user_push_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."user_recommendation_profiles"
    ADD CONSTRAINT "user_recommendation_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."weather_forecasts"
    ADD CONSTRAINT "weather_forecasts_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."weather_forecasts"
    ADD CONSTRAINT "weather_forecasts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE "private"."archived_generated_itineraries" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "Anyone can read embassies" ON "public"."embassies" FOR SELECT USING (true);



CREATE POLICY "Anyone can view invitation by token" ON "public"."calendar_invitations" FOR SELECT TO "authenticated", "anon" USING (("expires_at" > "now"()));



CREATE POLICY "Anyone can view valid shareable calendars by token" ON "public"."shareable_calendars" FOR SELECT TO "authenticated", "anon" USING (("expires_at" > "now"()));



CREATE POLICY "Authenticated users can create rollcalls" ON "public"."rollcalls" FOR INSERT WITH CHECK (("triggered_by" = "private"."current_platform_user_id"()));



CREATE POLICY "Author or organizer can update" ON "public"."group_messages" FOR UPDATE USING ((("user_id" = "auth"."uid"()) OR (EXISTS ( SELECT 1
   FROM "public"."group_members" "gm"
  WHERE (("gm"."group_id" = "group_messages"."group_id") AND ("gm"."user_id" = "auth"."uid"()) AND ("gm"."role" = 'organizer'::"text"))))));



CREATE POLICY "Creators can manage" ON "public"."trip_groups" USING (("created_by" = "auth"."uid"()));



CREATE POLICY "Group members add expenses" ON "public"."expenses" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."group_members" "gm"
  WHERE (("gm"."group_id" = "expenses"."group_id") AND ("gm"."user_id" = "auth"."uid"()) AND ("gm"."status" = 'active'::"text")))));



CREATE POLICY "Group members can view" ON "public"."trip_groups" FOR SELECT USING (((EXISTS ( SELECT 1
   FROM "public"."group_members" "gm"
  WHERE (("gm"."group_id" = "trip_groups"."id") AND ("gm"."user_id" = "auth"."uid"()) AND ("gm"."status" = 'active'::"text")))) OR ("created_by" = "auth"."uid"())));



CREATE POLICY "Group members create polls" ON "public"."polls" FOR INSERT WITH CHECK (("auth"."uid"() = "created_by"));



CREATE POLICY "Group members send messages" ON "public"."group_messages" FOR INSERT WITH CHECK ((("auth"."uid"() = "user_id") AND (EXISTS ( SELECT 1
   FROM "public"."group_members" "gm"
  WHERE (("gm"."group_id" = "group_messages"."group_id") AND ("gm"."user_id" = "auth"."uid"()) AND ("gm"."status" = 'active'::"text"))))));



CREATE POLICY "Group members view expenses" ON "public"."expenses" FOR SELECT USING ((("deleted_at" IS NULL) AND (EXISTS ( SELECT 1
   FROM "public"."group_members" "gm"
  WHERE (("gm"."group_id" = "expenses"."group_id") AND ("gm"."user_id" = "auth"."uid"()) AND ("gm"."status" = 'active'::"text"))))));



CREATE POLICY "Group members view line items" ON "public"."expense_line_items" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM ("public"."expenses" "e"
     JOIN "public"."group_members" "gm" ON (("gm"."group_id" = "e"."group_id")))
  WHERE (("e"."id" = "expense_line_items"."expense_id") AND ("gm"."user_id" = "auth"."uid"()) AND ("gm"."status" = 'active'::"text")))));



CREATE POLICY "Group members view messages" ON "public"."group_messages" FOR SELECT USING ((("deleted_at" IS NULL) AND (EXISTS ( SELECT 1
   FROM "public"."group_members" "gm"
  WHERE (("gm"."group_id" = "group_messages"."group_id") AND ("gm"."user_id" = "auth"."uid"()) AND ("gm"."status" = 'active'::"text"))))));



CREATE POLICY "Group members view options" ON "public"."poll_options" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM ("public"."polls" "p"
     JOIN "public"."group_members" "gm" ON (("gm"."group_id" = "p"."group_id")))
  WHERE (("p"."id" = "poll_options"."poll_id") AND ("gm"."user_id" = "auth"."uid"()) AND ("gm"."status" = 'active'::"text")))));



CREATE POLICY "Group members view polls" ON "public"."polls" FOR SELECT USING (((EXISTS ( SELECT 1
   FROM "public"."group_members" "gm"
  WHERE (("gm"."group_id" = "polls"."group_id") AND ("gm"."user_id" = "auth"."uid"()) AND ("gm"."status" = 'active'::"text")))) OR ("created_by" = "auth"."uid"())));



CREATE POLICY "Group members view settlements" ON "public"."settlements" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."group_members" "gm"
  WHERE (("gm"."group_id" = "settlements"."group_id") AND ("gm"."user_id" = "auth"."uid"()) AND ("gm"."status" = 'active'::"text")))));



CREATE POLICY "Group members view splits" ON "public"."expense_splits" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM ("public"."expenses" "e"
     JOIN "public"."group_members" "gm" ON (("gm"."group_id" = "e"."group_id")))
  WHERE (("e"."id" = "expense_splits"."expense_id") AND ("gm"."user_id" = "auth"."uid"()) AND ("gm"."status" = 'active'::"text")))));



CREATE POLICY "Members can read all responses in their rollcall" ON "public"."rollcall_responses" FOR SELECT USING (("rollcall_id" IN ( SELECT "r"."id"
   FROM "public"."rollcalls" "r"
  WHERE ("r"."trip_id" IN ( SELECT "tm"."trip_id"
           FROM "public"."trip_members" "tm"
          WHERE (("tm"."user_id" = "private"."current_platform_user_id"()) AND ("tm"."removed_at" IS NULL)))))));



CREATE POLICY "Members can view group members" ON "public"."group_members" FOR SELECT USING ((("user_id" = "auth"."uid"()) OR (EXISTS ( SELECT 1
   FROM "public"."group_members" "gm2"
  WHERE (("gm2"."group_id" = "group_members"."group_id") AND ("gm2"."user_id" = "auth"."uid"()))))));



CREATE POLICY "Members manage own rollcall responses" ON "public"."rollcall_responses" USING (("member_id" = "private"."current_platform_user_id"())) WITH CHECK (("member_id" = "private"."current_platform_user_id"()));



CREATE POLICY "Members view preferences in group" ON "public"."member_preferences" FOR SELECT USING ((("user_id" = "auth"."uid"()) OR (EXISTS ( SELECT 1
   FROM "public"."group_members" "gm"
  WHERE (("gm"."group_id" = "member_preferences"."group_id") AND ("gm"."user_id" = "auth"."uid"()) AND ("gm"."status" = 'active'::"text"))))));



CREATE POLICY "Payer or organizer can update" ON "public"."expenses" FOR UPDATE USING ((("paid_by" = "auth"."uid"()) OR (EXISTS ( SELECT 1
   FROM "public"."group_members" "gm"
  WHERE (("gm"."group_id" = "expenses"."group_id") AND ("gm"."user_id" = "auth"."uid"()) AND ("gm"."role" = 'organizer'::"text"))))));



CREATE POLICY "Public read trending" ON "public"."recommendation_trending" FOR SELECT USING (true);



CREATE POLICY "Trip members can read rollcalls" ON "public"."rollcalls" FOR SELECT USING ((("trip_id" IN ( SELECT "tm"."trip_id"
   FROM "public"."trip_members" "tm"
  WHERE (("tm"."user_id" = "private"."current_platform_user_id"()) AND ("tm"."removed_at" IS NULL)))) OR ("triggered_by" = "private"."current_platform_user_id"())));



CREATE POLICY "Users can access own monitoring events" ON "public"."monitoring_events" USING (((EXISTS ( SELECT 1
   FROM "public"."monitored_entities" "me"
  WHERE (("me"."id" = "monitoring_events"."monitored_entity_id") AND ("me"."user_id" = "auth"."uid"())))) OR (EXISTS ( SELECT 1
   FROM "public"."trips" "t"
  WHERE (("t"."id" = "monitoring_events"."trip_id") AND ("t"."user_id" = "auth"."uid"()))))));



CREATE POLICY "Users can insert own profile" ON "public"."profiles" FOR UPDATE USING (("auth"."uid"() = "id"));



CREATE POLICY "Users can insert own trip changes" ON "public"."trip_change_log" FOR INSERT WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can insert their own friction scores" ON "public"."daily_friction_scores" FOR INSERT WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can insert their own health analyses" ON "public"."trip_health_analyses" FOR INSERT WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can insert their own issues" ON "public"."trip_issues" FOR INSERT WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can insert their own versions" ON "public"."itinerary_versions" FOR INSERT WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can manage invitations they sent" ON "public"."calendar_invitations" TO "authenticated" USING (("sent_by" = "auth"."uid"()));



CREATE POLICY "Users can manage own alerts" ON "public"."travel_alerts" USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can manage own attachments" ON "public"."email_attachments" USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can manage own document imports" ON "public"."document_imports" USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can manage own documents" ON "public"."secure_documents" USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can manage own email connections" ON "public"."email_connections" USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can manage own email imports" ON "public"."email_message_imports" USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can manage own important info" ON "public"."important_information" USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can manage own monitored entities" ON "public"."monitored_entities" USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can manage own notification eligibility" ON "public"."notification_eligibility" USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can manage own offline packs" ON "public"."offline_trip_packs" USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can manage own preferences" ON "public"."alert_preferences" USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can manage own previews" ON "public"."trip_change_previews" USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can manage own readiness" ON "public"."pre_trip_readiness" USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can manage own readiness items" ON "public"."readiness_items" USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can manage own reservations" ON "public"."reservations" USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can manage own tasks" ON "public"."pre_trip_tasks" USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can manage own trip assemblies" ON "public"."trip_assemblies" USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can manage own trip impacts" ON "public"."trip_impacts" USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can manage their own better deals" ON "public"."better_deals" USING (("user_id" = "auth"."uid"()));



CREATE POLICY "Users can manage their own booking conflicts" ON "public"."booking_conflicts" USING (("user_id" = "auth"."uid"()));



CREATE POLICY "Users can manage their own booking connections" ON "public"."booking_connections" USING (("user_id" = "auth"."uid"()));



CREATE POLICY "Users can manage their own booking reservations" ON "public"."booking_reservations" USING (("user_id" = "auth"."uid"()));



CREATE POLICY "Users can manage their own disaster alerts" ON "public"."disaster_alerts" USING (("user_id" = "auth"."uid"()));



CREATE POLICY "Users can manage their own flight disruptions" ON "public"."flight_disruptions" USING (("user_id" = "auth"."uid"()));



CREATE POLICY "Users can manage their own health assessments" ON "public"."health_assessments" USING (("user_id" = "auth"."uid"()));



CREATE POLICY "Users can manage their own oauth states" ON "public"."oauth_states" USING (("user_id" = "auth"."uid"()));



CREATE POLICY "Users can manage their own price snapshots" ON "public"."price_snapshots" USING (("user_id" = "auth"."uid"()));



CREATE POLICY "Users can manage their own safety assessments" ON "public"."safety_assessments" USING (("user_id" = "auth"."uid"()));



CREATE POLICY "Users can manage their own shareable calendars" ON "public"."shareable_calendars" TO "authenticated" USING (("created_by" = "auth"."uid"()));



CREATE POLICY "Users can manage their own traffic updates" ON "public"."traffic_updates" USING (("user_id" = "auth"."uid"()));



CREATE POLICY "Users can manage their own trips" ON "public"."trips" USING (("auth"."uid"() = "user_id")) WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can manage their own weather forecasts" ON "public"."weather_forecasts" USING (("user_id" = "auth"."uid"()));



CREATE POLICY "Users can update own profile" ON "public"."profiles" FOR INSERT WITH CHECK (("auth"."uid"() = "id"));



CREATE POLICY "Users can update own trip changes" ON "public"."trip_change_log" FOR UPDATE USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can update their own friction scores" ON "public"."daily_friction_scores" FOR UPDATE USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can update their own health analyses" ON "public"."trip_health_analyses" FOR UPDATE USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can update their own issues" ON "public"."trip_issues" FOR UPDATE USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can update their own versions" ON "public"."itinerary_versions" FOR UPDATE USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can view own profile" ON "public"."profiles" FOR SELECT USING (("auth"."uid"() = "id"));



CREATE POLICY "Users can view own trip changes" ON "public"."trip_change_log" FOR SELECT USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can view their own friction scores" ON "public"."daily_friction_scores" FOR SELECT USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can view their own health analyses" ON "public"."trip_health_analyses" FOR SELECT USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can view their own issues" ON "public"."trip_issues" FOR SELECT USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can view their own versions" ON "public"."itinerary_versions" FOR SELECT USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users cast votes" ON "public"."poll_votes" FOR INSERT WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "Users delete own engagement" ON "public"."recommendation_engagement" FOR DELETE USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users manage own airline cache" ON "public"."airline_loyalty_cache" USING (("auth"."uid"() = "user_id")) WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "Users manage own alert prefs" ON "public"."user_alert_preferences" USING (("user_id" = "auth"."uid"())) WITH CHECK (("user_id" = "auth"."uid"()));



CREATE POLICY "Users manage own batches" ON "public"."alert_batches" USING (("user_id" = "auth"."uid"())) WITH CHECK (("user_id" = "auth"."uid"()));



CREATE POLICY "Users manage own budget analyses" ON "public"."budget_analyses" USING (("auth"."uid"() = "user_id")) WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "Users manage own calendar connections" ON "public"."calendar_connections" USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users manage own checkins" ON "public"."checkins" USING ((("auth"."uid"())::"text" = "user_id"));



CREATE POLICY "Users manage own connections" ON "public"."platform_connections" USING (("user_id" = "auth"."uid"())) WITH CHECK (("user_id" = "auth"."uid"()));



CREATE POLICY "Users manage own dismissed alerts" ON "public"."dismissed_alerts" USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users manage own emergency info" ON "public"."emergency_info" USING ((("auth"."uid"())::"text" = "user_id"));



CREATE POLICY "Users manage own event mappings" ON "public"."calendar_event_mappings" USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users manage own location points" ON "public"."location_points" USING (("share_id" IN ( SELECT "location_shares"."id"
   FROM "public"."location_shares"
  WHERE ("location_shares"."user_id" = ("auth"."uid"())::"text"))));



CREATE POLICY "Users manage own location shares" ON "public"."location_shares" USING ((("auth"."uid"())::"text" = "user_id"));



CREATE POLICY "Users manage own notifications" ON "public"."inapp_notifications" USING (("user_id" = "auth"."uid"())) WITH CHECK (("user_id" = "auth"."uid"()));



CREATE POLICY "Users manage own pace analyses" ON "public"."pace_analyses" USING (("auth"."uid"() = "user_id")) WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "Users manage own plan changes" ON "public"."plan_changes" USING (("auth"."uid"() = "user_id")) WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "Users manage own planning preferences" ON "public"."trip_planning_preferences" USING (("auth"."uid"() = "user_id")) WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "Users manage own planning sessions" ON "public"."planning_sessions" USING (("auth"."uid"() = "user_id")) WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "Users manage own poll schedule" ON "public"."reservation_poll_schedule" USING (("user_id" = "auth"."uid"())) WITH CHECK (("user_id" = "auth"."uid"()));



CREATE POLICY "Users manage own preferences" ON "public"."member_preferences" USING (("user_id" = "auth"."uid"()));



CREATE POLICY "Users manage own profiles" ON "public"."user_recommendation_profiles" USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users manage own push tokens" ON "public"."user_push_tokens" USING (("user_id" = "auth"."uid"())) WITH CHECK (("user_id" = "auth"."uid"()));



CREATE POLICY "Users manage own reactions" ON "public"."message_reactions" USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users manage own recommendations" ON "public"."recommendations" USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users manage own saved" ON "public"."saved_recommendations" USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users manage own typing" ON "public"."typing_indicators" USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users see own recovery logs" ON "public"."pipeline_recovery_log" FOR SELECT USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users view own conflicts" ON "public"."booking_conflicts" USING (("user_id" = "auth"."uid"())) WITH CHECK (("user_id" = "auth"."uid"()));



CREATE POLICY "Users view own dedup log" ON "public"."alert_dedup_log" FOR SELECT USING (("user_id" = "auth"."uid"()));



CREATE POLICY "Users view own delivery attempts" ON "public"."delivery_attempts" USING (("user_id" = "auth"."uid"())) WITH CHECK (("user_id" = "auth"."uid"()));



CREATE POLICY "Users view own delivery log" ON "public"."alert_delivery_log" USING (("user_id" = "auth"."uid"())) WITH CHECK (("user_id" = "auth"."uid"()));



CREATE POLICY "Users view own price history" ON "public"."reservation_price_history" USING (("user_id" = "auth"."uid"())) WITH CHECK (("user_id" = "auth"."uid"()));



CREATE POLICY "Users view own queue stats" ON "public"."alert_queue_stats" USING (("user_id" = "auth"."uid"())) WITH CHECK (("user_id" = "auth"."uid"()));



CREATE POLICY "Users view own rate counters" ON "public"."alert_rate_counters" USING (("user_id" = "auth"."uid"())) WITH CHECK (("user_id" = "auth"."uid"()));



CREATE POLICY "Users view own snapshots" ON "public"."availability_snapshots" USING (("user_id" = "auth"."uid"())) WITH CHECK (("user_id" = "auth"."uid"()));



CREATE POLICY "Users view own sync errors" ON "public"."calendar_sync_errors" USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users view own sync log" ON "public"."calendar_sync_log" USING (("auth"."uid"() = "user_id")) WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "Users view own votes" ON "public"."poll_votes" FOR SELECT USING (("user_id" = "auth"."uid"()));



CREATE POLICY "Users write own engagement" ON "public"."recommendation_engagement" FOR INSERT WITH CHECK (("auth"."uid"() = "user_id"));



ALTER TABLE "public"."account_deletion_requests" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."activity_events" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."activity_read_markers" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."agent_metrics" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."agreement_completions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."agreement_questionnaires" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."agreement_responses" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."airline_loyalty_cache" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."alert_batches" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."alert_dedup_log" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."alert_delivery_log" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."alert_preferences" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."alert_preferences_v2" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."alert_queue_stats" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."alert_rate_counters" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."alignment_reports" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "anon read" ON "public"."emergency_numbers" FOR SELECT TO "anon" USING (true);



ALTER TABLE "public"."api_alerts" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."api_cache_entries" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."api_cost_daily" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."api_cost_log" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."api_service_health" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."audit_log" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."auth_identities" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "authenticated read" ON "public"."bargain_norms" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "authenticated read" ON "public"."booking_platforms" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "authenticated read" ON "public"."cost_index" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "authenticated read" ON "public"."dietary_phrase_cards" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "authenticated read" ON "public"."emergency_numbers" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "authenticated read" ON "public"."entry_requirement_changes" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "authenticated read" ON "public"."entry_requirements" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "authenticated read" ON "public"."feature_flags" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "authenticated read" ON "public"."monitoring_providers" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "authenticated read" ON "public"."phrase_cards" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "authenticated read" ON "public"."safety_advisories" FOR SELECT TO "authenticated" USING (true);



ALTER TABLE "public"."availability_snapshots" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."ballots_v2" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."bargain_norms" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."better_deals" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."booking_conflicts" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."booking_connections" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."booking_platforms" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."booking_reservations" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."budget_aggregates" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."budget_analyses" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."budget_notification_queue" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."budget_preferences" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."cache_stats" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."calendar_connections" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."calendar_event_mappings" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."calendar_invitations" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."calendar_share_viewers" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."calendar_sync_errors" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."calendar_sync_log" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."canary_test_log" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."change_proposals" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."checkins" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."circuit_breaker_state" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."claim_expenses" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."comment_reactions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."comments" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."concurrency_audit_log" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."copilot_drafts" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."copilot_messages" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."copilot_proposals" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."copilot_settings" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."copilot_threads" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."copilot_trip_summaries" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."cost_alerts" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."cost_index" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."currencies" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "currencies readable" ON "public"."currencies" FOR SELECT TO "authenticated" USING (true);



ALTER TABLE "public"."daily_friction_scores" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."daily_spend" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."data_export_requests" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."day_energy_snapshots" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."day_snapshots" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."dedup_cache" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."delivery_attempts" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."dep_edges" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."dep_nodes" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."dietary_phrase_cards" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."disaster_alerts" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."dismissed_alerts" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."disruption_cases" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."disruption_claims" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."disruption_reports" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."document_imports" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."email_attachments" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."email_connections" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."email_message_imports" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."embassies" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."emergency_info" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."emergency_numbers" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."entry_requirement_changes" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."entry_requirements" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."eta_links" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."expense_line_items" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."expense_splits" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."expenses" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."export_jobs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."feature_flags" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."flight_disruptions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."flight_signals" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."fx_rates" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "fx_rates readable" ON "public"."fx_rates" FOR SELECT TO "authenticated" USING (true);



ALTER TABLE "public"."group_members" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."group_messages" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."happiness_scores" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."happy_moments" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."health_assessments" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."hotel_loyalty_cache" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."hotel_loyalty_tokens" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."hotel_oauth_sessions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."hotel_token_audit_log" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."idempotency_keys" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."idempotency_records" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."important_information" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."inapp_notifications" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."item_ratings" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."itinerary_items" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."itinerary_versions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."location_points" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."location_shares" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."loop_executions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."loyalty_aggregator_connections" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."member_preferences" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."message_attachments" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."message_reactions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."monitored_entities" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."monitoring_events" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."monitoring_providers" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."monitoring_snapshots" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."notification_eligibility" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."oauth_states" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."offline_manifests" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."offline_trip_packs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."onboarding_completions" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "onboarding_completions_delete_own" ON "public"."onboarding_completions" FOR DELETE TO "authenticated" USING (("auth"."uid"() = "user_id"));



CREATE POLICY "onboarding_completions_insert_own" ON "public"."onboarding_completions" FOR INSERT TO "authenticated" WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "onboarding_completions_select_own" ON "public"."onboarding_completions" FOR SELECT TO "authenticated" USING (("auth"."uid"() = "user_id"));



CREATE POLICY "onboarding_completions_update_own" ON "public"."onboarding_completions" FOR UPDATE TO "authenticated" USING (("auth"."uid"() = "user_id")) WITH CHECK (("auth"."uid"() = "user_id"));



ALTER TABLE "public"."operation_attempts" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."operation_locks" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."outbox_items" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "own connections delete" ON "public"."loyalty_aggregator_connections" FOR DELETE USING (("auth"."uid"() = "user_id"));



CREATE POLICY "own connections insert" ON "public"."loyalty_aggregator_connections" FOR INSERT WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "own connections select" ON "public"."loyalty_aggregator_connections" FOR SELECT USING (("auth"."uid"() = "user_id"));



CREATE POLICY "own connections update" ON "public"."loyalty_aggregator_connections" FOR UPDATE USING (("auth"."uid"() = "user_id")) WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "own item update" ON "public"."prep_items" FOR UPDATE TO "authenticated" USING (("member_id" = ( SELECT "private"."current_platform_user_id"() AS "current_platform_user_id"))) WITH CHECK (("member_id" = ( SELECT "private"."current_platform_user_id"() AS "current_platform_user_id")));



CREATE POLICY "own preferences" ON "public"."safety_preferences" TO "authenticated" USING (("user_id" = ( SELECT "private"."current_platform_user_id"() AS "current_platform_user_id"))) WITH CHECK (("user_id" = ( SELECT "private"."current_platform_user_id"() AS "current_platform_user_id")));



CREATE POLICY "own row read" ON "public"."search_analytics" FOR SELECT TO "authenticated" USING ((( SELECT "auth"."uid"() AS "uid") = "user_id"));



CREATE POLICY "own row read" ON "public"."user_actions" FOR SELECT TO "authenticated" USING ((( SELECT "auth"."uid"() AS "uid") = "user_id"));



CREATE POLICY "own row read" ON "public"."user_behavior_profiles" FOR SELECT TO "authenticated" USING ((( SELECT "auth"."uid"() AS "uid") = "user_id"));



CREATE POLICY "own row read" ON "public"."user_limits" FOR SELECT TO "authenticated" USING ((( SELECT "auth"."uid"() AS "uid") = "user_id"));



CREATE POLICY "own_calibration" ON "public"."personal_calibration" USING (("user_id" = ("auth"."uid"())::"text"));



ALTER TABLE "public"."pace_analyses" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."packing_items" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."performance_metrics" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."personal_calibration" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."phrase_cards" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."pipeline_recovery_log" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."place_reports" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."plan_changes" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."planning_sessions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."platform_connections" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."platform_users" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."playbook_step_completions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."playbooks" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."poll_options" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."poll_options_v2" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."poll_votes" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."polls" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."polls_v2" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."pre_trip_readiness" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."pre_trip_tasks" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."prediction_models" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."prep_items" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."presence" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."price_snapshots" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."privacy_controls" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."profile_signals" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "profile_signals_delete_own" ON "public"."profile_signals" FOR DELETE TO "authenticated" USING (("auth"."uid"() = "user_id"));



CREATE POLICY "profile_signals_insert_own" ON "public"."profile_signals" FOR INSERT TO "authenticated" WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "profile_signals_select_own" ON "public"."profile_signals" FOR SELECT TO "authenticated" USING (("auth"."uid"() = "user_id"));



CREATE POLICY "profile_signals_update_own" ON "public"."profile_signals" FOR UPDATE TO "authenticated" USING (("auth"."uid"() = "user_id")) WITH CHECK (("auth"."uid"() = "user_id"));



ALTER TABLE "public"."profiles" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."provider_cache" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."provider_circuit" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."provider_quota" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "public_read_taxonomy" ON "public"."taxonomy_versions" FOR SELECT USING (true);



ALTER TABLE "public"."rate_limit_buckets" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."rating_prompt_state" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "read_own_engagement" ON "public"."recommendation_engagement" FOR SELECT TO "authenticated" USING (("user_id" = "auth"."uid"()));



ALTER TABLE "public"."readiness_items" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."recommendation_engagement" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."recommendation_trending" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."recommendations" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."release_checklist" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."replan_applied" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."replan_cache" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "reporter insert" ON "public"."safety_reports" FOR INSERT WITH CHECK ((("reporter_id" = ( SELECT "private"."current_platform_user_id"() AS "current_platform_user_id")) AND ( SELECT "private"."is_trip_member"("safety_reports"."trip_id") AS "is_trip_member")));



CREATE POLICY "reporter update" ON "public"."safety_reports" FOR UPDATE TO "authenticated" USING (("reporter_id" = ( SELECT "private"."current_platform_user_id"() AS "current_platform_user_id"))) WITH CHECK (("reporter_id" = ( SELECT "private"."current_platform_user_id"() AS "current_platform_user_id")));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."activity_events" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."agreement_completions" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."agreement_questionnaires" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."agreement_responses" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."airline_loyalty_cache" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."alert_batches" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."alert_dedup_log" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."alert_delivery_log" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."alert_preferences" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."alert_queue_stats" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."alert_rate_counters" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."alignment_reports" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."api_cache_entries" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."api_cost_daily" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."availability_snapshots" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."ballots_v2" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."bargain_norms" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."better_deals" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."booking_conflicts" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."booking_connections" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."booking_platforms" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."booking_reservations" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."budget_aggregates" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."budget_analyses" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."budget_notification_queue" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."budget_preferences" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."calendar_connections" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."calendar_event_mappings" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."calendar_invitations" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."calendar_sync_errors" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."calendar_sync_log" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."change_proposals" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."checkins" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."comments" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."copilot_drafts" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."copilot_messages" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."copilot_proposals" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."copilot_settings" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."copilot_threads" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."copilot_trip_summaries" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."cost_index" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."currencies" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."daily_friction_scores" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."day_energy_snapshots" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."day_snapshots" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."delivery_attempts" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."dietary_phrase_cards" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."disaster_alerts" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."dismissed_alerts" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."document_imports" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."email_attachments" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."email_connections" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."email_message_imports" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."embassies" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."emergency_info" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."emergency_numbers" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."entry_requirement_changes" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."entry_requirements" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."expense_line_items" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."expense_splits" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."expenses" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."feature_flags" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."flight_disruptions" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."fx_rates" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."group_members" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."group_messages" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."health_assessments" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."hotel_loyalty_cache" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."hotel_loyalty_tokens" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."hotel_oauth_sessions" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."hotel_token_audit_log" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."idempotency_records" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."important_information" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."inapp_notifications" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."item_ratings" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."itinerary_items" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."itinerary_versions" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."location_points" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."location_shares" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."loyalty_aggregator_connections" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."member_preferences" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."message_attachments" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."message_reactions" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."monitored_entities" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."monitoring_events" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."monitoring_providers" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."notification_eligibility" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."oauth_states" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."offline_trip_packs" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."onboarding_completions" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."pace_analyses" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."packing_items" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."personal_calibration" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."phrase_cards" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."pipeline_recovery_log" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."plan_changes" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."planning_sessions" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."platform_connections" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."poll_options" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."poll_options_v2" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."poll_votes" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."polls" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."polls_v2" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."pre_trip_readiness" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."pre_trip_tasks" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."prediction_models" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."prep_items" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."price_snapshots" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."profile_signals" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."profiles" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."rate_limit_buckets" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."rating_prompt_state" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."readiness_items" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."recommendation_engagement" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."recommendation_trending" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."recommendations" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."reservation_poll_schedule" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."reservation_price_history" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."reservations" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."rollcall_responses" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."rollcalls" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."safety_advisories" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."safety_assessments" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."safety_notes" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."safety_preferences" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."safety_reports" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."satisfaction_ledger" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."saved_recommendations" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."search_analytics" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."secure_documents" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."serendipity_dismissed" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."serendipity_preferences" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."serendipity_suggestions" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."settlements" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."shareable_calendars" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."taxonomy_versions" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."traffic_updates" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."travel_alerts" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."travel_operations" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."traveler_profiles" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."trip_assemblies" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."trip_change_log" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."trip_change_previews" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."trip_forecasts" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."trip_groups" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."trip_health_analyses" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."trip_impacts" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."trip_issues" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."trip_planning_preferences" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."trips" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."typing_indicators" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."user_actions" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."user_alert_preferences" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."user_behavior_profiles" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."user_limits" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."user_push_tokens" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."user_recommendation_profiles" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



CREATE POLICY "require_mfa_when_enrolled" ON "public"."weather_forecasts" AS RESTRICTIVE TO "authenticated" USING (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied")) WITH CHECK (( SELECT "private"."mfa_satisfied"() AS "mfa_satisfied"));



ALTER TABLE "public"."reservation_poll_schedule" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."reservation_price_history" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."reservations" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."rollcall_responses" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."rollcalls" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."safety_advisories" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."safety_assessments" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."safety_notes" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."safety_preferences" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."safety_reports" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."safety_rules" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."satisfaction_ledger" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."saved_recommendations" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."search_analytics" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."secure_documents" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."serendipity_dismissed" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."serendipity_preferences" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."serendipity_suggestions" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "service role only" ON "public"."hotel_oauth_sessions" USING (false);



CREATE POLICY "service_only_copilot_drafts" ON "public"."copilot_drafts" USING (false);



CREATE POLICY "service_only_copilot_messages" ON "public"."copilot_messages" USING (false);



CREATE POLICY "service_only_copilot_settings" ON "public"."copilot_settings" USING (false);



CREATE POLICY "service_only_copilot_summaries" ON "public"."copilot_trip_summaries" USING (false);



CREATE POLICY "service_only_copilot_threads" ON "public"."copilot_threads" USING (false);



CREATE POLICY "service_only_day_energy" ON "public"."day_energy_snapshots" USING (false);



CREATE POLICY "service_only_item_ratings" ON "public"."item_ratings" USING (false);



CREATE POLICY "service_only_prediction_models" ON "public"."prediction_models" USING (false);



CREATE POLICY "service_only_rating_prompt_state" ON "public"."rating_prompt_state" USING (false);



CREATE POLICY "service_only_seren_dismissed" ON "public"."serendipity_dismissed" USING (false);



CREATE POLICY "service_only_seren_prefs" ON "public"."serendipity_preferences" USING (false);



CREATE POLICY "service_only_seren_suggestions" ON "public"."serendipity_suggestions" USING (false);



CREATE POLICY "service_role_all" ON "public"."concurrency_audit_log" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "service_role_all" ON "public"."idempotency_records" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "service_role_all" ON "public"."operation_attempts" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "service_role_all" ON "public"."travel_operations" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "service_role_all_ballots" ON "public"."ballots_v2" USING (("auth"."role"() = 'service_role'::"text"));



CREATE POLICY "service_role_all_ledger" ON "public"."satisfaction_ledger" USING (("auth"."role"() = 'service_role'::"text"));



CREATE POLICY "service_role_all_responses" ON "public"."agreement_responses" USING (("auth"."role"() = 'service_role'::"text"));



CREATE POLICY "service_role_forecast_write" ON "public"."trip_forecasts" USING (("auth"."role"() = 'service_role'::"text"));



CREATE POLICY "service_role_full_access_idempotency_keys" ON "public"."idempotency_keys" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "service_role_full_access_operation_locks" ON "public"."operation_locks" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "service_role_only" ON "public"."api_cache_entries" USING (("auth"."role"() = 'service_role'::"text"));



CREATE POLICY "service_role_only" ON "public"."api_cost_daily" USING (("auth"."role"() = 'service_role'::"text"));



CREATE POLICY "service_role_only" ON "public"."budget_preferences" USING (("auth"."role"() = 'service_role'::"text"));



CREATE POLICY "service_role_only" ON "public"."rate_limit_buckets" USING (("auth"."role"() = 'service_role'::"text"));



CREATE POLICY "service_role_only_notif" ON "public"."budget_notification_queue" USING (("auth"."role"() = 'service_role'::"text"));



CREATE POLICY "service_role_write" ON "public"."budget_aggregates" USING (("auth"."role"() = 'service_role'::"text"));



CREATE POLICY "service_role_write_activity" ON "public"."activity_events" USING (("auth"."role"() = 'service_role'::"text"));



CREATE POLICY "service_role_write_comments" ON "public"."comments" USING (("auth"."role"() = 'service_role'::"text"));



CREATE POLICY "service_role_write_completions" ON "public"."agreement_completions" USING (("auth"."role"() = 'service_role'::"text"));



CREATE POLICY "service_role_write_options" ON "public"."poll_options_v2" USING (("auth"."role"() = 'service_role'::"text"));



CREATE POLICY "service_role_write_polls" ON "public"."polls_v2" USING (("auth"."role"() = 'service_role'::"text"));



CREATE POLICY "service_role_write_proposals" ON "public"."change_proposals" USING (("auth"."role"() = 'service_role'::"text"));



CREATE POLICY "service_role_write_questionnaire" ON "public"."agreement_questionnaires" USING (("auth"."role"() = 'service_role'::"text"));



CREATE POLICY "service_role_write_report" ON "public"."alignment_reports" USING (("auth"."role"() = 'service_role'::"text"));



CREATE POLICY "service_role_write_snapshots" ON "public"."day_snapshots" USING (("auth"."role"() = 'service_role'::"text"));



ALTER TABLE "public"."settlement_calculations" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."settlement_disputes" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."settlement_history" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."settlement_proofs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."settlements" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."share_links" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."shareable_calendars" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."slo_metrics" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."support_conversations" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."taxonomy_versions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."tips_preferences" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."traffic_updates" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."travel_alerts" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."travel_operations" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."traveler_profiles" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "traveler_profiles_delete_own" ON "public"."traveler_profiles" FOR DELETE TO "authenticated" USING (("auth"."uid"() = "user_id"));



CREATE POLICY "traveler_profiles_insert_own" ON "public"."traveler_profiles" FOR INSERT TO "authenticated" WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "traveler_profiles_select_own" ON "public"."traveler_profiles" FOR SELECT TO "authenticated" USING (("auth"."uid"() = "user_id"));



CREATE POLICY "traveler_profiles_update_own" ON "public"."traveler_profiles" FOR UPDATE TO "authenticated" USING (("auth"."uid"() = "user_id")) WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "trip editors delete" ON "public"."itinerary_items" FOR DELETE TO "authenticated" USING (( SELECT "private"."can_edit_trip"("itinerary_items"."trip_id") AS "can_edit_trip"));



CREATE POLICY "trip editors delete" ON "public"."packing_items" FOR DELETE TO "authenticated" USING (( SELECT "private"."can_edit_trip"("packing_items"."trip_id") AS "can_edit_trip"));



CREATE POLICY "trip editors insert" ON "public"."itinerary_items" FOR INSERT TO "authenticated" WITH CHECK (( SELECT "private"."can_edit_trip"("itinerary_items"."trip_id") AS "can_edit_trip"));



CREATE POLICY "trip editors insert" ON "public"."packing_items" FOR INSERT TO "authenticated" WITH CHECK (( SELECT "private"."can_edit_trip"("packing_items"."trip_id") AS "can_edit_trip"));



CREATE POLICY "trip editors update" ON "public"."itinerary_items" FOR UPDATE TO "authenticated" USING (( SELECT "private"."can_edit_trip"("itinerary_items"."trip_id") AS "can_edit_trip")) WITH CHECK (( SELECT "private"."can_edit_trip"("itinerary_items"."trip_id") AS "can_edit_trip"));



CREATE POLICY "trip editors update" ON "public"."packing_items" FOR UPDATE TO "authenticated" USING (( SELECT "private"."can_edit_trip"("packing_items"."trip_id") AS "can_edit_trip")) WITH CHECK (( SELECT "private"."can_edit_trip"("packing_items"."trip_id") AS "can_edit_trip"));



CREATE POLICY "trip members insert own item" ON "public"."prep_items" FOR INSERT WITH CHECK ((( SELECT "private"."is_trip_member"("prep_items"."trip_id") AS "is_trip_member") AND ("member_id" = ( SELECT "private"."current_platform_user_id"() AS "current_platform_user_id"))));



CREATE POLICY "trip members read" ON "public"."budget_aggregates" FOR SELECT USING (( SELECT "private"."is_trip_member"("budget_aggregates"."trip_id") AS "is_trip_member"));



CREATE POLICY "trip members read" ON "public"."itinerary_items" FOR SELECT USING (( SELECT "private"."is_trip_member"("itinerary_items"."trip_id") AS "is_trip_member"));



CREATE POLICY "trip members read" ON "public"."packing_items" FOR SELECT TO "authenticated" USING (( SELECT "private"."is_trip_member"("packing_items"."trip_id") AS "is_trip_member"));



CREATE POLICY "trip members read" ON "public"."prep_items" FOR SELECT USING (( SELECT "private"."is_trip_member"("prep_items"."trip_id") AS "is_trip_member"));



CREATE POLICY "trip members read" ON "public"."safety_notes" FOR SELECT USING (( SELECT "private"."is_trip_member"("safety_notes"."trip_id") AS "is_trip_member"));



CREATE POLICY "trip members read" ON "public"."safety_reports" FOR SELECT USING (( SELECT "private"."is_trip_member"("safety_reports"."trip_id") AS "is_trip_member"));



CREATE POLICY "trip members read versions" ON "public"."itinerary_versions" FOR SELECT TO "authenticated" USING (( SELECT "private"."is_trip_member"("itinerary_versions"."trip_id") AS "is_trip_member"));



ALTER TABLE "public"."trip_assemblies" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."trip_change_log" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."trip_change_previews" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."trip_forecasts" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."trip_groups" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."trip_health_analyses" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."trip_impacts" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."trip_issues" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."trip_members" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "trip_members_forecast" ON "public"."trip_forecasts" FOR SELECT TO "authenticated" USING ("private"."is_trip_member"("trip_id"));



CREATE POLICY "trip_members_read_activity" ON "public"."activity_events" FOR SELECT TO "authenticated" USING ("private"."is_trip_member"("trip_id"));



CREATE POLICY "trip_members_read_comments" ON "public"."comments" FOR SELECT TO "authenticated" USING ("private"."is_trip_member"("trip_id"));



CREATE POLICY "trip_members_read_completions" ON "public"."agreement_completions" FOR SELECT TO "authenticated" USING ("private"."is_trip_member"("trip_id"));



CREATE POLICY "trip_members_read_options" ON "public"."poll_options_v2" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."polls_v2" "p"
  WHERE (("p"."id" = "poll_options_v2"."poll_id") AND "private"."is_trip_member"("p"."trip_id")))));



CREATE POLICY "trip_members_read_polls" ON "public"."polls_v2" FOR SELECT TO "authenticated" USING ("private"."is_trip_member"("trip_id"));



CREATE POLICY "trip_members_read_proposals" ON "public"."change_proposals" FOR SELECT TO "authenticated" USING ("private"."is_trip_member"("trip_id"));



CREATE POLICY "trip_members_read_questionnaire" ON "public"."agreement_questionnaires" FOR SELECT TO "authenticated" USING ("private"."is_trip_member"("trip_id"));



CREATE POLICY "trip_members_read_report" ON "public"."alignment_reports" FOR SELECT TO "authenticated" USING ("private"."is_trip_member"("trip_id"));



CREATE POLICY "trip_members_read_snapshots" ON "public"."day_snapshots" FOR SELECT TO "authenticated" USING ("private"."is_trip_member"("trip_id"));



ALTER TABLE "public"."trip_planning_preferences" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."trips" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."typing_indicators" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."user_actions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."user_alert_preferences" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."user_behavior_profiles" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."user_devices" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."user_limits" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."user_push_tokens" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."user_recommendation_profiles" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "users own audit logs" ON "public"."hotel_token_audit_log" USING (("auth"."uid"() = "user_id"));



CREATE POLICY "users own cache" ON "public"."hotel_loyalty_cache" USING (("auth"."uid"() = "user_id"));



CREATE POLICY "users own tokens" ON "public"."hotel_loyalty_tokens" USING (("auth"."uid"() = "user_id"));



CREATE POLICY "users_own_operations" ON "public"."travel_operations" FOR SELECT TO "authenticated" USING (("user_id" = "auth"."uid"()));



CREATE POLICY "users_own_records" ON "public"."idempotency_records" FOR SELECT TO "authenticated" USING (("user_id" = "auth"."uid"()));



CREATE POLICY "users_read_own_proposals" ON "public"."copilot_proposals" FOR SELECT TO "authenticated" USING (("auth"."uid"() = "user_id"));



ALTER TABLE "public"."weather_forecasts" ENABLE ROW LEVEL SECURITY;




ALTER PUBLICATION "supabase_realtime" OWNER TO "postgres";












GRANT USAGE ON SCHEMA "private" TO "authenticated";



GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";



GRANT ALL ON FUNCTION "public"."citextin"("cstring") TO "postgres";
GRANT ALL ON FUNCTION "public"."citextin"("cstring") TO "anon";
GRANT ALL ON FUNCTION "public"."citextin"("cstring") TO "authenticated";
GRANT ALL ON FUNCTION "public"."citextin"("cstring") TO "service_role";



GRANT ALL ON FUNCTION "public"."citextout"("public"."citext") TO "postgres";
GRANT ALL ON FUNCTION "public"."citextout"("public"."citext") TO "anon";
GRANT ALL ON FUNCTION "public"."citextout"("public"."citext") TO "authenticated";
GRANT ALL ON FUNCTION "public"."citextout"("public"."citext") TO "service_role";



GRANT ALL ON FUNCTION "public"."citextrecv"("internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."citextrecv"("internal") TO "anon";
GRANT ALL ON FUNCTION "public"."citextrecv"("internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."citextrecv"("internal") TO "service_role";



GRANT ALL ON FUNCTION "public"."citextsend"("public"."citext") TO "postgres";
GRANT ALL ON FUNCTION "public"."citextsend"("public"."citext") TO "anon";
GRANT ALL ON FUNCTION "public"."citextsend"("public"."citext") TO "authenticated";
GRANT ALL ON FUNCTION "public"."citextsend"("public"."citext") TO "service_role";



GRANT ALL ON FUNCTION "public"."citext"(boolean) TO "postgres";
GRANT ALL ON FUNCTION "public"."citext"(boolean) TO "anon";
GRANT ALL ON FUNCTION "public"."citext"(boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."citext"(boolean) TO "service_role";



GRANT ALL ON FUNCTION "public"."citext"(character) TO "postgres";
GRANT ALL ON FUNCTION "public"."citext"(character) TO "anon";
GRANT ALL ON FUNCTION "public"."citext"(character) TO "authenticated";
GRANT ALL ON FUNCTION "public"."citext"(character) TO "service_role";



GRANT ALL ON FUNCTION "public"."citext"("inet") TO "postgres";
GRANT ALL ON FUNCTION "public"."citext"("inet") TO "anon";
GRANT ALL ON FUNCTION "public"."citext"("inet") TO "authenticated";
GRANT ALL ON FUNCTION "public"."citext"("inet") TO "service_role";











































































































































































REVOKE ALL ON FUNCTION "private"."can_edit_trip"("p_trip_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "private"."can_edit_trip"("p_trip_id" "uuid") TO "authenticated";



REVOKE ALL ON FUNCTION "private"."current_platform_user_id"() FROM PUBLIC;
GRANT ALL ON FUNCTION "private"."current_platform_user_id"() TO "authenticated";



REVOKE ALL ON FUNCTION "private"."guard_expense_roster"() FROM PUBLIC;



REVOKE ALL ON FUNCTION "private"."itinerary_ensure_baseline"("p_trip_id" "uuid") FROM PUBLIC;



REVOKE ALL ON FUNCTION "private"."itinerary_snapshot_version"("p_trip_id" "uuid", "p_method" "text", "p_name" "text", "p_summary" "text"[]) FROM PUBLIC;



REVOKE ALL ON FUNCTION "private"."mfa_satisfied"() FROM PUBLIC;
GRANT ALL ON FUNCTION "private"."mfa_satisfied"() TO "authenticated";



REVOKE ALL ON FUNCTION "private"."security_sentinel_run"() FROM PUBLIC;



REVOKE ALL ON FUNCTION "private"."sentinel_alert"("p_severity" "text", "p_check" "text", "p_message" "text", "p_details" "jsonb") FROM PUBLIC;



REVOKE ALL ON FUNCTION "private"."sentinel_diff"("p_key" "text", "p_items" "text"[], "p_severity" "text", "p_message" "text", "p_cumulative" boolean, "p_alert_removed" boolean) FROM PUBLIC;



REVOKE ALL ON FUNCTION "private"."sync_trip_expense_group"("p_trip" "uuid") FROM PUBLIC;



REVOKE ALL ON FUNCTION "private"."trip_edit_role"("p_trip_id" "uuid") FROM PUBLIC;



REVOKE ALL ON FUNCTION "private"."trip_members_sync_expense_group"() FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."check_alert_cleanup_health"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."check_alert_cleanup_health"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."check_alert_flush_health"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."check_alert_flush_health"() TO "service_role";



GRANT ALL ON FUNCTION "public"."citext_cmp"("public"."citext", "public"."citext") TO "postgres";
GRANT ALL ON FUNCTION "public"."citext_cmp"("public"."citext", "public"."citext") TO "anon";
GRANT ALL ON FUNCTION "public"."citext_cmp"("public"."citext", "public"."citext") TO "authenticated";
GRANT ALL ON FUNCTION "public"."citext_cmp"("public"."citext", "public"."citext") TO "service_role";



GRANT ALL ON FUNCTION "public"."citext_eq"("public"."citext", "public"."citext") TO "postgres";
GRANT ALL ON FUNCTION "public"."citext_eq"("public"."citext", "public"."citext") TO "anon";
GRANT ALL ON FUNCTION "public"."citext_eq"("public"."citext", "public"."citext") TO "authenticated";
GRANT ALL ON FUNCTION "public"."citext_eq"("public"."citext", "public"."citext") TO "service_role";



GRANT ALL ON FUNCTION "public"."citext_ge"("public"."citext", "public"."citext") TO "postgres";
GRANT ALL ON FUNCTION "public"."citext_ge"("public"."citext", "public"."citext") TO "anon";
GRANT ALL ON FUNCTION "public"."citext_ge"("public"."citext", "public"."citext") TO "authenticated";
GRANT ALL ON FUNCTION "public"."citext_ge"("public"."citext", "public"."citext") TO "service_role";



GRANT ALL ON FUNCTION "public"."citext_gt"("public"."citext", "public"."citext") TO "postgres";
GRANT ALL ON FUNCTION "public"."citext_gt"("public"."citext", "public"."citext") TO "anon";
GRANT ALL ON FUNCTION "public"."citext_gt"("public"."citext", "public"."citext") TO "authenticated";
GRANT ALL ON FUNCTION "public"."citext_gt"("public"."citext", "public"."citext") TO "service_role";



GRANT ALL ON FUNCTION "public"."citext_hash"("public"."citext") TO "postgres";
GRANT ALL ON FUNCTION "public"."citext_hash"("public"."citext") TO "anon";
GRANT ALL ON FUNCTION "public"."citext_hash"("public"."citext") TO "authenticated";
GRANT ALL ON FUNCTION "public"."citext_hash"("public"."citext") TO "service_role";



GRANT ALL ON FUNCTION "public"."citext_hash_extended"("public"."citext", bigint) TO "postgres";
GRANT ALL ON FUNCTION "public"."citext_hash_extended"("public"."citext", bigint) TO "anon";
GRANT ALL ON FUNCTION "public"."citext_hash_extended"("public"."citext", bigint) TO "authenticated";
GRANT ALL ON FUNCTION "public"."citext_hash_extended"("public"."citext", bigint) TO "service_role";



GRANT ALL ON FUNCTION "public"."citext_larger"("public"."citext", "public"."citext") TO "postgres";
GRANT ALL ON FUNCTION "public"."citext_larger"("public"."citext", "public"."citext") TO "anon";
GRANT ALL ON FUNCTION "public"."citext_larger"("public"."citext", "public"."citext") TO "authenticated";
GRANT ALL ON FUNCTION "public"."citext_larger"("public"."citext", "public"."citext") TO "service_role";



GRANT ALL ON FUNCTION "public"."citext_le"("public"."citext", "public"."citext") TO "postgres";
GRANT ALL ON FUNCTION "public"."citext_le"("public"."citext", "public"."citext") TO "anon";
GRANT ALL ON FUNCTION "public"."citext_le"("public"."citext", "public"."citext") TO "authenticated";
GRANT ALL ON FUNCTION "public"."citext_le"("public"."citext", "public"."citext") TO "service_role";



GRANT ALL ON FUNCTION "public"."citext_lt"("public"."citext", "public"."citext") TO "postgres";
GRANT ALL ON FUNCTION "public"."citext_lt"("public"."citext", "public"."citext") TO "anon";
GRANT ALL ON FUNCTION "public"."citext_lt"("public"."citext", "public"."citext") TO "authenticated";
GRANT ALL ON FUNCTION "public"."citext_lt"("public"."citext", "public"."citext") TO "service_role";



GRANT ALL ON FUNCTION "public"."citext_ne"("public"."citext", "public"."citext") TO "postgres";
GRANT ALL ON FUNCTION "public"."citext_ne"("public"."citext", "public"."citext") TO "anon";
GRANT ALL ON FUNCTION "public"."citext_ne"("public"."citext", "public"."citext") TO "authenticated";
GRANT ALL ON FUNCTION "public"."citext_ne"("public"."citext", "public"."citext") TO "service_role";



GRANT ALL ON FUNCTION "public"."citext_pattern_cmp"("public"."citext", "public"."citext") TO "postgres";
GRANT ALL ON FUNCTION "public"."citext_pattern_cmp"("public"."citext", "public"."citext") TO "anon";
GRANT ALL ON FUNCTION "public"."citext_pattern_cmp"("public"."citext", "public"."citext") TO "authenticated";
GRANT ALL ON FUNCTION "public"."citext_pattern_cmp"("public"."citext", "public"."citext") TO "service_role";



GRANT ALL ON FUNCTION "public"."citext_pattern_ge"("public"."citext", "public"."citext") TO "postgres";
GRANT ALL ON FUNCTION "public"."citext_pattern_ge"("public"."citext", "public"."citext") TO "anon";
GRANT ALL ON FUNCTION "public"."citext_pattern_ge"("public"."citext", "public"."citext") TO "authenticated";
GRANT ALL ON FUNCTION "public"."citext_pattern_ge"("public"."citext", "public"."citext") TO "service_role";



GRANT ALL ON FUNCTION "public"."citext_pattern_gt"("public"."citext", "public"."citext") TO "postgres";
GRANT ALL ON FUNCTION "public"."citext_pattern_gt"("public"."citext", "public"."citext") TO "anon";
GRANT ALL ON FUNCTION "public"."citext_pattern_gt"("public"."citext", "public"."citext") TO "authenticated";
GRANT ALL ON FUNCTION "public"."citext_pattern_gt"("public"."citext", "public"."citext") TO "service_role";



GRANT ALL ON FUNCTION "public"."citext_pattern_le"("public"."citext", "public"."citext") TO "postgres";
GRANT ALL ON FUNCTION "public"."citext_pattern_le"("public"."citext", "public"."citext") TO "anon";
GRANT ALL ON FUNCTION "public"."citext_pattern_le"("public"."citext", "public"."citext") TO "authenticated";
GRANT ALL ON FUNCTION "public"."citext_pattern_le"("public"."citext", "public"."citext") TO "service_role";



GRANT ALL ON FUNCTION "public"."citext_pattern_lt"("public"."citext", "public"."citext") TO "postgres";
GRANT ALL ON FUNCTION "public"."citext_pattern_lt"("public"."citext", "public"."citext") TO "anon";
GRANT ALL ON FUNCTION "public"."citext_pattern_lt"("public"."citext", "public"."citext") TO "authenticated";
GRANT ALL ON FUNCTION "public"."citext_pattern_lt"("public"."citext", "public"."citext") TO "service_role";



GRANT ALL ON FUNCTION "public"."citext_smaller"("public"."citext", "public"."citext") TO "postgres";
GRANT ALL ON FUNCTION "public"."citext_smaller"("public"."citext", "public"."citext") TO "anon";
GRANT ALL ON FUNCTION "public"."citext_smaller"("public"."citext", "public"."citext") TO "authenticated";
GRANT ALL ON FUNCTION "public"."citext_smaller"("public"."citext", "public"."citext") TO "service_role";



REVOKE ALL ON FUNCTION "public"."fx_convert"("p_from" character, "p_to" character, "p_amount_minor" bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."fx_convert"("p_from" character, "p_to" character, "p_amount_minor" bigint) TO "authenticated";
GRANT ALL ON FUNCTION "public"."fx_convert"("p_from" character, "p_to" character, "p_amount_minor" bigint) TO "service_role";



GRANT ALL ON FUNCTION "public"."generate_prefixed_id"("prefix" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."generate_prefixed_id"("prefix" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."generate_prefixed_id"("prefix" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."handle_new_user"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."itinerary_add_items"("p_trip_id" "uuid", "p_items" "jsonb", "p_version_name" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."itinerary_add_items"("p_trip_id" "uuid", "p_items" "jsonb", "p_version_name" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."itinerary_add_items"("p_trip_id" "uuid", "p_items" "jsonb", "p_version_name" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."itinerary_delete_items"("p_item_ids" "uuid"[], "p_version_name" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."itinerary_delete_items"("p_item_ids" "uuid"[], "p_version_name" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."itinerary_delete_items"("p_item_ids" "uuid"[], "p_version_name" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."itinerary_restore_version"("p_version_id" "uuid", "p_expect_active" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."itinerary_restore_version"("p_version_id" "uuid", "p_expect_active" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."itinerary_restore_version"("p_version_id" "uuid", "p_expect_active" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."itinerary_undo_change"("p_version_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."itinerary_undo_change"("p_version_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."itinerary_undo_change"("p_version_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."itinerary_update_item"("p_item_id" "uuid", "p_patch" "jsonb", "p_version_name" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."itinerary_update_item"("p_item_id" "uuid", "p_patch" "jsonb", "p_version_name" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."itinerary_update_item"("p_item_id" "uuid", "p_patch" "jsonb", "p_version_name" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."normalize_trip_tz"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."normalize_trip_tz"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."rate_limit_hit"("p_bucket_key" "text", "p_bucket_type" "text", "p_limit" integer, "p_window_seconds" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."rate_limit_hit"("p_bucket_key" "text", "p_bucket_type" "text", "p_limit" integer, "p_window_seconds" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."regexp_match"("public"."citext", "public"."citext") TO "postgres";
GRANT ALL ON FUNCTION "public"."regexp_match"("public"."citext", "public"."citext") TO "anon";
GRANT ALL ON FUNCTION "public"."regexp_match"("public"."citext", "public"."citext") TO "authenticated";
GRANT ALL ON FUNCTION "public"."regexp_match"("public"."citext", "public"."citext") TO "service_role";



GRANT ALL ON FUNCTION "public"."regexp_match"("public"."citext", "public"."citext", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."regexp_match"("public"."citext", "public"."citext", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."regexp_match"("public"."citext", "public"."citext", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."regexp_match"("public"."citext", "public"."citext", "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."regexp_matches"("public"."citext", "public"."citext") TO "postgres";
GRANT ALL ON FUNCTION "public"."regexp_matches"("public"."citext", "public"."citext") TO "anon";
GRANT ALL ON FUNCTION "public"."regexp_matches"("public"."citext", "public"."citext") TO "authenticated";
GRANT ALL ON FUNCTION "public"."regexp_matches"("public"."citext", "public"."citext") TO "service_role";



GRANT ALL ON FUNCTION "public"."regexp_matches"("public"."citext", "public"."citext", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."regexp_matches"("public"."citext", "public"."citext", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."regexp_matches"("public"."citext", "public"."citext", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."regexp_matches"("public"."citext", "public"."citext", "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."regexp_replace"("public"."citext", "public"."citext", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."regexp_replace"("public"."citext", "public"."citext", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."regexp_replace"("public"."citext", "public"."citext", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."regexp_replace"("public"."citext", "public"."citext", "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."regexp_replace"("public"."citext", "public"."citext", "text", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."regexp_replace"("public"."citext", "public"."citext", "text", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."regexp_replace"("public"."citext", "public"."citext", "text", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."regexp_replace"("public"."citext", "public"."citext", "text", "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."regexp_split_to_array"("public"."citext", "public"."citext") TO "postgres";
GRANT ALL ON FUNCTION "public"."regexp_split_to_array"("public"."citext", "public"."citext") TO "anon";
GRANT ALL ON FUNCTION "public"."regexp_split_to_array"("public"."citext", "public"."citext") TO "authenticated";
GRANT ALL ON FUNCTION "public"."regexp_split_to_array"("public"."citext", "public"."citext") TO "service_role";



GRANT ALL ON FUNCTION "public"."regexp_split_to_array"("public"."citext", "public"."citext", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."regexp_split_to_array"("public"."citext", "public"."citext", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."regexp_split_to_array"("public"."citext", "public"."citext", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."regexp_split_to_array"("public"."citext", "public"."citext", "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."regexp_split_to_table"("public"."citext", "public"."citext") TO "postgres";
GRANT ALL ON FUNCTION "public"."regexp_split_to_table"("public"."citext", "public"."citext") TO "anon";
GRANT ALL ON FUNCTION "public"."regexp_split_to_table"("public"."citext", "public"."citext") TO "authenticated";
GRANT ALL ON FUNCTION "public"."regexp_split_to_table"("public"."citext", "public"."citext") TO "service_role";



GRANT ALL ON FUNCTION "public"."regexp_split_to_table"("public"."citext", "public"."citext", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."regexp_split_to_table"("public"."citext", "public"."citext", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."regexp_split_to_table"("public"."citext", "public"."citext", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."regexp_split_to_table"("public"."citext", "public"."citext", "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."replace"("public"."citext", "public"."citext", "public"."citext") TO "postgres";
GRANT ALL ON FUNCTION "public"."replace"("public"."citext", "public"."citext", "public"."citext") TO "anon";
GRANT ALL ON FUNCTION "public"."replace"("public"."citext", "public"."citext", "public"."citext") TO "authenticated";
GRANT ALL ON FUNCTION "public"."replace"("public"."citext", "public"."citext", "public"."citext") TO "service_role";



REVOKE ALL ON FUNCTION "public"."replan_apply_atomic"("p_trip_id" "uuid", "p_base_version" integer, "p_ops" "jsonb", "p_applied_id" "text", "p_alternative_id" "text", "p_applied_by" "text", "p_undo_expires_at" timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."replan_apply_atomic"("p_trip_id" "uuid", "p_base_version" integer, "p_ops" "jsonb", "p_applied_id" "text", "p_alternative_id" "text", "p_applied_by" "text", "p_undo_expires_at" timestamp with time zone) TO "service_role";



GRANT ALL ON FUNCTION "public"."split_part"("public"."citext", "public"."citext", integer) TO "postgres";
GRANT ALL ON FUNCTION "public"."split_part"("public"."citext", "public"."citext", integer) TO "anon";
GRANT ALL ON FUNCTION "public"."split_part"("public"."citext", "public"."citext", integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."split_part"("public"."citext", "public"."citext", integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."strpos"("public"."citext", "public"."citext") TO "postgres";
GRANT ALL ON FUNCTION "public"."strpos"("public"."citext", "public"."citext") TO "anon";
GRANT ALL ON FUNCTION "public"."strpos"("public"."citext", "public"."citext") TO "authenticated";
GRANT ALL ON FUNCTION "public"."strpos"("public"."citext", "public"."citext") TO "service_role";



GRANT ALL ON FUNCTION "public"."texticlike"("public"."citext", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."texticlike"("public"."citext", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."texticlike"("public"."citext", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."texticlike"("public"."citext", "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."texticlike"("public"."citext", "public"."citext") TO "postgres";
GRANT ALL ON FUNCTION "public"."texticlike"("public"."citext", "public"."citext") TO "anon";
GRANT ALL ON FUNCTION "public"."texticlike"("public"."citext", "public"."citext") TO "authenticated";
GRANT ALL ON FUNCTION "public"."texticlike"("public"."citext", "public"."citext") TO "service_role";



GRANT ALL ON FUNCTION "public"."texticnlike"("public"."citext", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."texticnlike"("public"."citext", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."texticnlike"("public"."citext", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."texticnlike"("public"."citext", "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."texticnlike"("public"."citext", "public"."citext") TO "postgres";
GRANT ALL ON FUNCTION "public"."texticnlike"("public"."citext", "public"."citext") TO "anon";
GRANT ALL ON FUNCTION "public"."texticnlike"("public"."citext", "public"."citext") TO "authenticated";
GRANT ALL ON FUNCTION "public"."texticnlike"("public"."citext", "public"."citext") TO "service_role";



GRANT ALL ON FUNCTION "public"."texticregexeq"("public"."citext", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."texticregexeq"("public"."citext", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."texticregexeq"("public"."citext", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."texticregexeq"("public"."citext", "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."texticregexeq"("public"."citext", "public"."citext") TO "postgres";
GRANT ALL ON FUNCTION "public"."texticregexeq"("public"."citext", "public"."citext") TO "anon";
GRANT ALL ON FUNCTION "public"."texticregexeq"("public"."citext", "public"."citext") TO "authenticated";
GRANT ALL ON FUNCTION "public"."texticregexeq"("public"."citext", "public"."citext") TO "service_role";



GRANT ALL ON FUNCTION "public"."texticregexne"("public"."citext", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."texticregexne"("public"."citext", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."texticregexne"("public"."citext", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."texticregexne"("public"."citext", "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."texticregexne"("public"."citext", "public"."citext") TO "postgres";
GRANT ALL ON FUNCTION "public"."texticregexne"("public"."citext", "public"."citext") TO "anon";
GRANT ALL ON FUNCTION "public"."texticregexne"("public"."citext", "public"."citext") TO "authenticated";
GRANT ALL ON FUNCTION "public"."texticregexne"("public"."citext", "public"."citext") TO "service_role";



GRANT ALL ON FUNCTION "public"."touch_loyalty_aggregator_connections"() TO "anon";
GRANT ALL ON FUNCTION "public"."touch_loyalty_aggregator_connections"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."touch_loyalty_aggregator_connections"() TO "service_role";



GRANT ALL ON FUNCTION "public"."translate"("public"."citext", "public"."citext", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."translate"("public"."citext", "public"."citext", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."translate"("public"."citext", "public"."citext", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."translate"("public"."citext", "public"."citext", "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."try_jsonb"("p" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."try_jsonb"("p" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."try_jsonb"("p" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."update_alert_preferences_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."update_alert_preferences_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_alert_preferences_updated_at"() TO "service_role";



GRANT ALL ON FUNCTION "public"."update_document_imports_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."update_document_imports_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_document_imports_updated_at"() TO "service_role";



GRANT ALL ON FUNCTION "public"."update_email_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."update_email_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_email_updated_at"() TO "service_role";



GRANT ALL ON FUNCTION "public"."update_monitoring_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."update_monitoring_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_monitoring_updated_at"() TO "service_role";



GRANT ALL ON FUNCTION "public"."update_offline_packs_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."update_offline_packs_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_offline_packs_updated_at"() TO "service_role";



GRANT ALL ON FUNCTION "public"."update_readiness_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."update_readiness_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_readiness_updated_at"() TO "service_role";



GRANT ALL ON FUNCTION "public"."update_reservations_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."update_reservations_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_reservations_updated_at"() TO "service_role";



GRANT ALL ON FUNCTION "public"."update_travel_alerts_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."update_travel_alerts_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_travel_alerts_updated_at"() TO "service_role";



GRANT ALL ON FUNCTION "public"."update_trip_assemblies_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."update_trip_assemblies_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_trip_assemblies_updated_at"() TO "service_role";



GRANT ALL ON FUNCTION "public"."update_trip_impacts_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."update_trip_impacts_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_trip_impacts_updated_at"() TO "service_role";



GRANT ALL ON FUNCTION "public"."update_updated_at_column"() TO "anon";
GRANT ALL ON FUNCTION "public"."update_updated_at_column"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_updated_at_column"() TO "service_role";



GRANT ALL ON FUNCTION "public"."update_vault_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."update_vault_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_vault_updated_at"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."verify_cron_key"("p_key" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."verify_cron_key"("p_key" "text") TO "service_role";












GRANT ALL ON FUNCTION "public"."max"("public"."citext") TO "postgres";
GRANT ALL ON FUNCTION "public"."max"("public"."citext") TO "anon";
GRANT ALL ON FUNCTION "public"."max"("public"."citext") TO "authenticated";
GRANT ALL ON FUNCTION "public"."max"("public"."citext") TO "service_role";



GRANT ALL ON FUNCTION "public"."min"("public"."citext") TO "postgres";
GRANT ALL ON FUNCTION "public"."min"("public"."citext") TO "anon";
GRANT ALL ON FUNCTION "public"."min"("public"."citext") TO "authenticated";
GRANT ALL ON FUNCTION "public"."min"("public"."citext") TO "service_role";















GRANT ALL ON TABLE "public"."account_deletion_requests" TO "anon";
GRANT ALL ON TABLE "public"."account_deletion_requests" TO "authenticated";
GRANT ALL ON TABLE "public"."account_deletion_requests" TO "service_role";



GRANT ALL ON TABLE "public"."activity_events" TO "anon";
GRANT ALL ON TABLE "public"."activity_events" TO "authenticated";
GRANT ALL ON TABLE "public"."activity_events" TO "service_role";



GRANT ALL ON TABLE "public"."activity_read_markers" TO "anon";
GRANT ALL ON TABLE "public"."activity_read_markers" TO "authenticated";
GRANT ALL ON TABLE "public"."activity_read_markers" TO "service_role";



GRANT ALL ON TABLE "public"."agent_metrics" TO "anon";
GRANT ALL ON TABLE "public"."agent_metrics" TO "authenticated";
GRANT ALL ON TABLE "public"."agent_metrics" TO "service_role";



GRANT ALL ON SEQUENCE "public"."agent_metrics_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."agent_metrics_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."agent_metrics_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."agreement_completions" TO "anon";
GRANT ALL ON TABLE "public"."agreement_completions" TO "authenticated";
GRANT ALL ON TABLE "public"."agreement_completions" TO "service_role";



GRANT ALL ON TABLE "public"."agreement_questionnaires" TO "anon";
GRANT ALL ON TABLE "public"."agreement_questionnaires" TO "authenticated";
GRANT ALL ON TABLE "public"."agreement_questionnaires" TO "service_role";



GRANT ALL ON TABLE "public"."agreement_responses" TO "anon";
GRANT ALL ON TABLE "public"."agreement_responses" TO "authenticated";
GRANT ALL ON TABLE "public"."agreement_responses" TO "service_role";



GRANT ALL ON TABLE "public"."airline_loyalty_cache" TO "anon";
GRANT ALL ON TABLE "public"."airline_loyalty_cache" TO "authenticated";
GRANT ALL ON TABLE "public"."airline_loyalty_cache" TO "service_role";



GRANT ALL ON TABLE "public"."alert_batches" TO "anon";
GRANT ALL ON TABLE "public"."alert_batches" TO "authenticated";
GRANT ALL ON TABLE "public"."alert_batches" TO "service_role";



GRANT ALL ON TABLE "public"."alert_dedup_log" TO "anon";
GRANT ALL ON TABLE "public"."alert_dedup_log" TO "authenticated";
GRANT ALL ON TABLE "public"."alert_dedup_log" TO "service_role";



GRANT ALL ON TABLE "public"."alert_delivery_log" TO "anon";
GRANT ALL ON TABLE "public"."alert_delivery_log" TO "authenticated";
GRANT ALL ON TABLE "public"."alert_delivery_log" TO "service_role";



GRANT ALL ON TABLE "public"."alert_preferences" TO "anon";
GRANT ALL ON TABLE "public"."alert_preferences" TO "authenticated";
GRANT ALL ON TABLE "public"."alert_preferences" TO "service_role";



GRANT ALL ON TABLE "public"."alert_preferences_v2" TO "anon";
GRANT ALL ON TABLE "public"."alert_preferences_v2" TO "authenticated";
GRANT ALL ON TABLE "public"."alert_preferences_v2" TO "service_role";



GRANT ALL ON SEQUENCE "public"."alert_preferences_v2_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."alert_preferences_v2_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."alert_preferences_v2_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."alert_queue_stats" TO "anon";
GRANT ALL ON TABLE "public"."alert_queue_stats" TO "authenticated";
GRANT ALL ON TABLE "public"."alert_queue_stats" TO "service_role";



GRANT ALL ON TABLE "public"."alert_rate_counters" TO "anon";
GRANT ALL ON TABLE "public"."alert_rate_counters" TO "authenticated";
GRANT ALL ON TABLE "public"."alert_rate_counters" TO "service_role";



GRANT ALL ON TABLE "public"."alignment_reports" TO "anon";
GRANT ALL ON TABLE "public"."alignment_reports" TO "authenticated";
GRANT ALL ON TABLE "public"."alignment_reports" TO "service_role";



GRANT ALL ON TABLE "public"."api_alerts" TO "anon";
GRANT ALL ON TABLE "public"."api_alerts" TO "authenticated";
GRANT ALL ON TABLE "public"."api_alerts" TO "service_role";



GRANT ALL ON TABLE "public"."api_cache_entries" TO "anon";
GRANT ALL ON TABLE "public"."api_cache_entries" TO "authenticated";
GRANT ALL ON TABLE "public"."api_cache_entries" TO "service_role";



GRANT ALL ON TABLE "public"."api_cost_daily" TO "anon";
GRANT ALL ON TABLE "public"."api_cost_daily" TO "authenticated";
GRANT ALL ON TABLE "public"."api_cost_daily" TO "service_role";



GRANT ALL ON TABLE "public"."api_cost_log" TO "anon";
GRANT ALL ON TABLE "public"."api_cost_log" TO "authenticated";
GRANT ALL ON TABLE "public"."api_cost_log" TO "service_role";



GRANT ALL ON TABLE "public"."api_service_health" TO "anon";
GRANT ALL ON TABLE "public"."api_service_health" TO "authenticated";
GRANT ALL ON TABLE "public"."api_service_health" TO "service_role";



GRANT ALL ON TABLE "public"."audit_log" TO "anon";
GRANT ALL ON TABLE "public"."audit_log" TO "authenticated";
GRANT ALL ON TABLE "public"."audit_log" TO "service_role";



GRANT ALL ON TABLE "public"."auth_identities" TO "anon";
GRANT ALL ON TABLE "public"."auth_identities" TO "authenticated";
GRANT ALL ON TABLE "public"."auth_identities" TO "service_role";



GRANT ALL ON TABLE "public"."availability_snapshots" TO "anon";
GRANT ALL ON TABLE "public"."availability_snapshots" TO "authenticated";
GRANT ALL ON TABLE "public"."availability_snapshots" TO "service_role";



GRANT ALL ON TABLE "public"."ballots_v2" TO "anon";
GRANT ALL ON TABLE "public"."ballots_v2" TO "authenticated";
GRANT ALL ON TABLE "public"."ballots_v2" TO "service_role";



GRANT ALL ON TABLE "public"."bargain_norms" TO "anon";
GRANT ALL ON TABLE "public"."bargain_norms" TO "authenticated";
GRANT ALL ON TABLE "public"."bargain_norms" TO "service_role";



GRANT ALL ON TABLE "public"."better_deals" TO "anon";
GRANT ALL ON TABLE "public"."better_deals" TO "authenticated";
GRANT ALL ON TABLE "public"."better_deals" TO "service_role";



GRANT ALL ON TABLE "public"."booking_conflicts" TO "anon";
GRANT ALL ON TABLE "public"."booking_conflicts" TO "authenticated";
GRANT ALL ON TABLE "public"."booking_conflicts" TO "service_role";



GRANT ALL ON TABLE "public"."booking_connections" TO "anon";
GRANT ALL ON TABLE "public"."booking_connections" TO "authenticated";
GRANT ALL ON TABLE "public"."booking_connections" TO "service_role";



GRANT ALL ON TABLE "public"."booking_platforms" TO "anon";
GRANT ALL ON TABLE "public"."booking_platforms" TO "authenticated";
GRANT ALL ON TABLE "public"."booking_platforms" TO "service_role";



GRANT ALL ON TABLE "public"."booking_reservations" TO "anon";
GRANT ALL ON TABLE "public"."booking_reservations" TO "authenticated";
GRANT ALL ON TABLE "public"."booking_reservations" TO "service_role";



GRANT ALL ON TABLE "public"."budget_aggregates" TO "anon";
GRANT ALL ON TABLE "public"."budget_aggregates" TO "authenticated";
GRANT ALL ON TABLE "public"."budget_aggregates" TO "service_role";



GRANT ALL ON TABLE "public"."budget_analyses" TO "anon";
GRANT ALL ON TABLE "public"."budget_analyses" TO "authenticated";
GRANT ALL ON TABLE "public"."budget_analyses" TO "service_role";



GRANT ALL ON TABLE "public"."budget_notification_queue" TO "anon";
GRANT ALL ON TABLE "public"."budget_notification_queue" TO "authenticated";
GRANT ALL ON TABLE "public"."budget_notification_queue" TO "service_role";



GRANT ALL ON TABLE "public"."budget_preferences" TO "anon";
GRANT ALL ON TABLE "public"."budget_preferences" TO "authenticated";
GRANT ALL ON TABLE "public"."budget_preferences" TO "service_role";



GRANT ALL ON TABLE "public"."cache_stats" TO "anon";
GRANT ALL ON TABLE "public"."cache_stats" TO "authenticated";
GRANT ALL ON TABLE "public"."cache_stats" TO "service_role";



GRANT ALL ON SEQUENCE "public"."cache_stats_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."cache_stats_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."cache_stats_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."calendar_connections" TO "anon";
GRANT ALL ON TABLE "public"."calendar_connections" TO "authenticated";
GRANT ALL ON TABLE "public"."calendar_connections" TO "service_role";



GRANT ALL ON TABLE "public"."calendar_event_mappings" TO "anon";
GRANT ALL ON TABLE "public"."calendar_event_mappings" TO "authenticated";
GRANT ALL ON TABLE "public"."calendar_event_mappings" TO "service_role";



GRANT ALL ON TABLE "public"."calendar_invitations" TO "anon";
GRANT ALL ON TABLE "public"."calendar_invitations" TO "authenticated";
GRANT ALL ON TABLE "public"."calendar_invitations" TO "service_role";



GRANT ALL ON TABLE "public"."calendar_share_viewers" TO "anon";
GRANT ALL ON TABLE "public"."calendar_share_viewers" TO "authenticated";
GRANT ALL ON TABLE "public"."calendar_share_viewers" TO "service_role";



GRANT ALL ON TABLE "public"."calendar_sync_errors" TO "anon";
GRANT ALL ON TABLE "public"."calendar_sync_errors" TO "authenticated";
GRANT ALL ON TABLE "public"."calendar_sync_errors" TO "service_role";



GRANT ALL ON TABLE "public"."calendar_sync_log" TO "anon";
GRANT ALL ON TABLE "public"."calendar_sync_log" TO "authenticated";
GRANT ALL ON TABLE "public"."calendar_sync_log" TO "service_role";



GRANT ALL ON TABLE "public"."canary_test_log" TO "anon";
GRANT ALL ON TABLE "public"."canary_test_log" TO "authenticated";
GRANT ALL ON TABLE "public"."canary_test_log" TO "service_role";



GRANT ALL ON TABLE "public"."change_proposals" TO "anon";
GRANT ALL ON TABLE "public"."change_proposals" TO "authenticated";
GRANT ALL ON TABLE "public"."change_proposals" TO "service_role";



GRANT ALL ON TABLE "public"."checkins" TO "anon";
GRANT ALL ON TABLE "public"."checkins" TO "authenticated";
GRANT ALL ON TABLE "public"."checkins" TO "service_role";



GRANT ALL ON TABLE "public"."circuit_breaker_state" TO "anon";
GRANT ALL ON TABLE "public"."circuit_breaker_state" TO "authenticated";
GRANT ALL ON TABLE "public"."circuit_breaker_state" TO "service_role";



GRANT ALL ON TABLE "public"."claim_expenses" TO "anon";
GRANT ALL ON TABLE "public"."claim_expenses" TO "authenticated";
GRANT ALL ON TABLE "public"."claim_expenses" TO "service_role";



GRANT ALL ON TABLE "public"."comment_reactions" TO "anon";
GRANT ALL ON TABLE "public"."comment_reactions" TO "authenticated";
GRANT ALL ON TABLE "public"."comment_reactions" TO "service_role";



GRANT ALL ON TABLE "public"."comments" TO "anon";
GRANT ALL ON TABLE "public"."comments" TO "authenticated";
GRANT ALL ON TABLE "public"."comments" TO "service_role";



GRANT ALL ON TABLE "public"."concurrency_audit_log" TO "anon";
GRANT ALL ON TABLE "public"."concurrency_audit_log" TO "authenticated";
GRANT ALL ON TABLE "public"."concurrency_audit_log" TO "service_role";



GRANT ALL ON TABLE "public"."copilot_drafts" TO "anon";
GRANT ALL ON TABLE "public"."copilot_drafts" TO "authenticated";
GRANT ALL ON TABLE "public"."copilot_drafts" TO "service_role";



GRANT ALL ON TABLE "public"."copilot_messages" TO "anon";
GRANT ALL ON TABLE "public"."copilot_messages" TO "authenticated";
GRANT ALL ON TABLE "public"."copilot_messages" TO "service_role";



GRANT ALL ON TABLE "public"."copilot_proposals" TO "anon";
GRANT ALL ON TABLE "public"."copilot_proposals" TO "authenticated";
GRANT ALL ON TABLE "public"."copilot_proposals" TO "service_role";



GRANT ALL ON TABLE "public"."copilot_settings" TO "anon";
GRANT ALL ON TABLE "public"."copilot_settings" TO "authenticated";
GRANT ALL ON TABLE "public"."copilot_settings" TO "service_role";



GRANT ALL ON TABLE "public"."copilot_threads" TO "anon";
GRANT ALL ON TABLE "public"."copilot_threads" TO "authenticated";
GRANT ALL ON TABLE "public"."copilot_threads" TO "service_role";



GRANT ALL ON TABLE "public"."copilot_trip_summaries" TO "anon";
GRANT ALL ON TABLE "public"."copilot_trip_summaries" TO "authenticated";
GRANT ALL ON TABLE "public"."copilot_trip_summaries" TO "service_role";



GRANT ALL ON TABLE "public"."cost_alerts" TO "anon";
GRANT ALL ON TABLE "public"."cost_alerts" TO "authenticated";
GRANT ALL ON TABLE "public"."cost_alerts" TO "service_role";



GRANT ALL ON SEQUENCE "public"."cost_alerts_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."cost_alerts_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."cost_alerts_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."cost_index" TO "anon";
GRANT ALL ON TABLE "public"."cost_index" TO "authenticated";
GRANT ALL ON TABLE "public"."cost_index" TO "service_role";



GRANT ALL ON TABLE "public"."currencies" TO "anon";
GRANT ALL ON TABLE "public"."currencies" TO "authenticated";
GRANT ALL ON TABLE "public"."currencies" TO "service_role";



GRANT ALL ON TABLE "public"."daily_friction_scores" TO "anon";
GRANT ALL ON TABLE "public"."daily_friction_scores" TO "authenticated";
GRANT ALL ON TABLE "public"."daily_friction_scores" TO "service_role";



GRANT ALL ON TABLE "public"."daily_spend" TO "anon";
GRANT ALL ON TABLE "public"."daily_spend" TO "authenticated";
GRANT ALL ON TABLE "public"."daily_spend" TO "service_role";



GRANT ALL ON SEQUENCE "public"."daily_spend_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."daily_spend_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."daily_spend_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."data_export_requests" TO "anon";
GRANT ALL ON TABLE "public"."data_export_requests" TO "authenticated";
GRANT ALL ON TABLE "public"."data_export_requests" TO "service_role";



GRANT ALL ON TABLE "public"."day_energy_snapshots" TO "anon";
GRANT ALL ON TABLE "public"."day_energy_snapshots" TO "authenticated";
GRANT ALL ON TABLE "public"."day_energy_snapshots" TO "service_role";



GRANT ALL ON TABLE "public"."day_snapshots" TO "anon";
GRANT ALL ON TABLE "public"."day_snapshots" TO "authenticated";
GRANT ALL ON TABLE "public"."day_snapshots" TO "service_role";



GRANT ALL ON TABLE "public"."dedup_cache" TO "anon";
GRANT ALL ON TABLE "public"."dedup_cache" TO "authenticated";
GRANT ALL ON TABLE "public"."dedup_cache" TO "service_role";



GRANT ALL ON SEQUENCE "public"."dedup_cache_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."dedup_cache_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."dedup_cache_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."delivery_attempts" TO "anon";
GRANT ALL ON TABLE "public"."delivery_attempts" TO "authenticated";
GRANT ALL ON TABLE "public"."delivery_attempts" TO "service_role";



GRANT ALL ON TABLE "public"."dep_edges" TO "anon";
GRANT ALL ON TABLE "public"."dep_edges" TO "authenticated";
GRANT ALL ON TABLE "public"."dep_edges" TO "service_role";



GRANT ALL ON TABLE "public"."dep_nodes" TO "anon";
GRANT ALL ON TABLE "public"."dep_nodes" TO "authenticated";
GRANT ALL ON TABLE "public"."dep_nodes" TO "service_role";



GRANT ALL ON TABLE "public"."dietary_phrase_cards" TO "anon";
GRANT ALL ON TABLE "public"."dietary_phrase_cards" TO "authenticated";
GRANT ALL ON TABLE "public"."dietary_phrase_cards" TO "service_role";



GRANT ALL ON TABLE "public"."disaster_alerts" TO "anon";
GRANT ALL ON TABLE "public"."disaster_alerts" TO "authenticated";
GRANT ALL ON TABLE "public"."disaster_alerts" TO "service_role";



GRANT ALL ON TABLE "public"."dismissed_alerts" TO "anon";
GRANT ALL ON TABLE "public"."dismissed_alerts" TO "authenticated";
GRANT ALL ON TABLE "public"."dismissed_alerts" TO "service_role";



GRANT ALL ON TABLE "public"."disruption_cases" TO "anon";
GRANT ALL ON TABLE "public"."disruption_cases" TO "authenticated";
GRANT ALL ON TABLE "public"."disruption_cases" TO "service_role";



GRANT ALL ON TABLE "public"."disruption_claims" TO "anon";
GRANT ALL ON TABLE "public"."disruption_claims" TO "authenticated";
GRANT ALL ON TABLE "public"."disruption_claims" TO "service_role";



GRANT ALL ON TABLE "public"."disruption_reports" TO "anon";
GRANT ALL ON TABLE "public"."disruption_reports" TO "authenticated";
GRANT ALL ON TABLE "public"."disruption_reports" TO "service_role";



GRANT ALL ON TABLE "public"."document_imports" TO "anon";
GRANT ALL ON TABLE "public"."document_imports" TO "authenticated";
GRANT ALL ON TABLE "public"."document_imports" TO "service_role";



GRANT ALL ON TABLE "public"."email_attachments" TO "anon";
GRANT ALL ON TABLE "public"."email_attachments" TO "authenticated";
GRANT ALL ON TABLE "public"."email_attachments" TO "service_role";



GRANT ALL ON TABLE "public"."email_connections" TO "anon";
GRANT ALL ON TABLE "public"."email_connections" TO "authenticated";
GRANT ALL ON TABLE "public"."email_connections" TO "service_role";



GRANT ALL ON TABLE "public"."email_message_imports" TO "anon";
GRANT ALL ON TABLE "public"."email_message_imports" TO "authenticated";
GRANT ALL ON TABLE "public"."email_message_imports" TO "service_role";



GRANT ALL ON TABLE "public"."email_import_history" TO "anon";
GRANT ALL ON TABLE "public"."email_import_history" TO "authenticated";
GRANT ALL ON TABLE "public"."email_import_history" TO "service_role";



GRANT ALL ON TABLE "public"."embassies" TO "anon";
GRANT ALL ON TABLE "public"."embassies" TO "authenticated";
GRANT ALL ON TABLE "public"."embassies" TO "service_role";



GRANT ALL ON TABLE "public"."emergency_info" TO "anon";
GRANT ALL ON TABLE "public"."emergency_info" TO "authenticated";
GRANT ALL ON TABLE "public"."emergency_info" TO "service_role";



GRANT ALL ON TABLE "public"."emergency_numbers" TO "anon";
GRANT ALL ON TABLE "public"."emergency_numbers" TO "authenticated";
GRANT ALL ON TABLE "public"."emergency_numbers" TO "service_role";



GRANT ALL ON TABLE "public"."entry_requirement_changes" TO "anon";
GRANT ALL ON TABLE "public"."entry_requirement_changes" TO "authenticated";
GRANT ALL ON TABLE "public"."entry_requirement_changes" TO "service_role";



GRANT ALL ON TABLE "public"."entry_requirements" TO "anon";
GRANT ALL ON TABLE "public"."entry_requirements" TO "authenticated";
GRANT ALL ON TABLE "public"."entry_requirements" TO "service_role";



GRANT ALL ON TABLE "public"."eta_links" TO "anon";
GRANT ALL ON TABLE "public"."eta_links" TO "authenticated";
GRANT ALL ON TABLE "public"."eta_links" TO "service_role";



GRANT ALL ON TABLE "public"."expense_line_items" TO "anon";
GRANT ALL ON TABLE "public"."expense_line_items" TO "authenticated";
GRANT ALL ON TABLE "public"."expense_line_items" TO "service_role";



GRANT ALL ON TABLE "public"."expense_splits" TO "anon";
GRANT ALL ON TABLE "public"."expense_splits" TO "authenticated";
GRANT ALL ON TABLE "public"."expense_splits" TO "service_role";



GRANT ALL ON TABLE "public"."expenses" TO "anon";
GRANT ALL ON TABLE "public"."expenses" TO "authenticated";
GRANT ALL ON TABLE "public"."expenses" TO "service_role";



GRANT ALL ON TABLE "public"."export_jobs" TO "anon";
GRANT ALL ON TABLE "public"."export_jobs" TO "authenticated";
GRANT ALL ON TABLE "public"."export_jobs" TO "service_role";



GRANT ALL ON TABLE "public"."feature_flags" TO "anon";
GRANT ALL ON TABLE "public"."feature_flags" TO "authenticated";
GRANT ALL ON TABLE "public"."feature_flags" TO "service_role";



GRANT ALL ON TABLE "public"."flight_disruptions" TO "anon";
GRANT ALL ON TABLE "public"."flight_disruptions" TO "authenticated";
GRANT ALL ON TABLE "public"."flight_disruptions" TO "service_role";



GRANT ALL ON TABLE "public"."flight_signals" TO "anon";
GRANT ALL ON TABLE "public"."flight_signals" TO "authenticated";
GRANT ALL ON TABLE "public"."flight_signals" TO "service_role";



GRANT ALL ON TABLE "public"."fx_rates" TO "anon";
GRANT ALL ON TABLE "public"."fx_rates" TO "authenticated";
GRANT ALL ON TABLE "public"."fx_rates" TO "service_role";



GRANT ALL ON TABLE "public"."fx_latest" TO "anon";
GRANT ALL ON TABLE "public"."fx_latest" TO "authenticated";
GRANT ALL ON TABLE "public"."fx_latest" TO "service_role";



GRANT ALL ON TABLE "public"."group_members" TO "anon";
GRANT ALL ON TABLE "public"."group_members" TO "authenticated";
GRANT ALL ON TABLE "public"."group_members" TO "service_role";



GRANT ALL ON TABLE "public"."group_messages" TO "anon";
GRANT ALL ON TABLE "public"."group_messages" TO "authenticated";
GRANT ALL ON TABLE "public"."group_messages" TO "service_role";



GRANT ALL ON TABLE "public"."happiness_scores" TO "anon";
GRANT ALL ON TABLE "public"."happiness_scores" TO "authenticated";
GRANT ALL ON TABLE "public"."happiness_scores" TO "service_role";



GRANT ALL ON TABLE "public"."happy_moments" TO "anon";
GRANT ALL ON TABLE "public"."happy_moments" TO "authenticated";
GRANT ALL ON TABLE "public"."happy_moments" TO "service_role";



GRANT ALL ON TABLE "public"."health_assessments" TO "anon";
GRANT ALL ON TABLE "public"."health_assessments" TO "authenticated";
GRANT ALL ON TABLE "public"."health_assessments" TO "service_role";



GRANT ALL ON TABLE "public"."hotel_loyalty_cache" TO "anon";
GRANT ALL ON TABLE "public"."hotel_loyalty_cache" TO "authenticated";
GRANT ALL ON TABLE "public"."hotel_loyalty_cache" TO "service_role";



GRANT ALL ON TABLE "public"."hotel_loyalty_tokens" TO "anon";
GRANT ALL ON TABLE "public"."hotel_loyalty_tokens" TO "authenticated";
GRANT ALL ON TABLE "public"."hotel_loyalty_tokens" TO "service_role";



GRANT ALL ON TABLE "public"."hotel_oauth_sessions" TO "anon";
GRANT ALL ON TABLE "public"."hotel_oauth_sessions" TO "authenticated";
GRANT ALL ON TABLE "public"."hotel_oauth_sessions" TO "service_role";



GRANT ALL ON TABLE "public"."hotel_token_audit_log" TO "anon";
GRANT ALL ON TABLE "public"."hotel_token_audit_log" TO "authenticated";
GRANT ALL ON TABLE "public"."hotel_token_audit_log" TO "service_role";



GRANT ALL ON TABLE "public"."idempotency_keys" TO "anon";
GRANT ALL ON TABLE "public"."idempotency_keys" TO "authenticated";
GRANT ALL ON TABLE "public"."idempotency_keys" TO "service_role";



GRANT ALL ON TABLE "public"."idempotency_records" TO "anon";
GRANT ALL ON TABLE "public"."idempotency_records" TO "authenticated";
GRANT ALL ON TABLE "public"."idempotency_records" TO "service_role";



GRANT ALL ON TABLE "public"."important_information" TO "anon";
GRANT ALL ON TABLE "public"."important_information" TO "authenticated";
GRANT ALL ON TABLE "public"."important_information" TO "service_role";



GRANT ALL ON TABLE "public"."inapp_notifications" TO "anon";
GRANT ALL ON TABLE "public"."inapp_notifications" TO "authenticated";
GRANT ALL ON TABLE "public"."inapp_notifications" TO "service_role";



GRANT ALL ON TABLE "public"."item_ratings" TO "anon";
GRANT ALL ON TABLE "public"."item_ratings" TO "authenticated";
GRANT ALL ON TABLE "public"."item_ratings" TO "service_role";



GRANT ALL ON TABLE "public"."itinerary_items" TO "anon";
GRANT ALL ON TABLE "public"."itinerary_items" TO "authenticated";
GRANT ALL ON TABLE "public"."itinerary_items" TO "service_role";



GRANT ALL ON TABLE "public"."itinerary_versions" TO "anon";
GRANT ALL ON TABLE "public"."itinerary_versions" TO "authenticated";
GRANT ALL ON TABLE "public"."itinerary_versions" TO "service_role";



GRANT ALL ON TABLE "public"."location_points" TO "anon";
GRANT ALL ON TABLE "public"."location_points" TO "authenticated";
GRANT ALL ON TABLE "public"."location_points" TO "service_role";



GRANT ALL ON TABLE "public"."location_shares" TO "anon";
GRANT ALL ON TABLE "public"."location_shares" TO "authenticated";
GRANT ALL ON TABLE "public"."location_shares" TO "service_role";



GRANT ALL ON TABLE "public"."loop_executions" TO "anon";
GRANT ALL ON TABLE "public"."loop_executions" TO "authenticated";
GRANT ALL ON TABLE "public"."loop_executions" TO "service_role";



GRANT ALL ON SEQUENCE "public"."loop_executions_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."loop_executions_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."loop_executions_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."loyalty_aggregator_connections" TO "anon";
GRANT ALL ON TABLE "public"."loyalty_aggregator_connections" TO "authenticated";
GRANT ALL ON TABLE "public"."loyalty_aggregator_connections" TO "service_role";



GRANT ALL ON TABLE "public"."member_preferences" TO "anon";
GRANT ALL ON TABLE "public"."member_preferences" TO "authenticated";
GRANT ALL ON TABLE "public"."member_preferences" TO "service_role";



GRANT ALL ON TABLE "public"."message_attachments" TO "anon";
GRANT ALL ON TABLE "public"."message_attachments" TO "authenticated";
GRANT ALL ON TABLE "public"."message_attachments" TO "service_role";



GRANT ALL ON TABLE "public"."message_reactions" TO "anon";
GRANT ALL ON TABLE "public"."message_reactions" TO "authenticated";
GRANT ALL ON TABLE "public"."message_reactions" TO "service_role";



GRANT ALL ON TABLE "public"."monitored_entities" TO "anon";
GRANT ALL ON TABLE "public"."monitored_entities" TO "authenticated";
GRANT ALL ON TABLE "public"."monitored_entities" TO "service_role";



GRANT ALL ON TABLE "public"."monitoring_events" TO "anon";
GRANT ALL ON TABLE "public"."monitoring_events" TO "authenticated";
GRANT ALL ON TABLE "public"."monitoring_events" TO "service_role";



GRANT ALL ON TABLE "public"."monitoring_providers" TO "anon";
GRANT ALL ON TABLE "public"."monitoring_providers" TO "authenticated";
GRANT ALL ON TABLE "public"."monitoring_providers" TO "service_role";



GRANT ALL ON TABLE "public"."monitoring_snapshots" TO "anon";
GRANT ALL ON TABLE "public"."monitoring_snapshots" TO "authenticated";
GRANT ALL ON TABLE "public"."monitoring_snapshots" TO "service_role";



GRANT ALL ON TABLE "public"."notification_eligibility" TO "anon";
GRANT ALL ON TABLE "public"."notification_eligibility" TO "authenticated";
GRANT ALL ON TABLE "public"."notification_eligibility" TO "service_role";



GRANT ALL ON TABLE "public"."oauth_states" TO "anon";
GRANT ALL ON TABLE "public"."oauth_states" TO "authenticated";
GRANT ALL ON TABLE "public"."oauth_states" TO "service_role";



GRANT ALL ON TABLE "public"."offline_manifests" TO "anon";
GRANT ALL ON TABLE "public"."offline_manifests" TO "authenticated";
GRANT ALL ON TABLE "public"."offline_manifests" TO "service_role";



GRANT ALL ON TABLE "public"."offline_trip_packs" TO "anon";
GRANT ALL ON TABLE "public"."offline_trip_packs" TO "authenticated";
GRANT ALL ON TABLE "public"."offline_trip_packs" TO "service_role";



GRANT ALL ON TABLE "public"."onboarding_completions" TO "anon";
GRANT ALL ON TABLE "public"."onboarding_completions" TO "authenticated";
GRANT ALL ON TABLE "public"."onboarding_completions" TO "service_role";



GRANT ALL ON TABLE "public"."operation_attempts" TO "anon";
GRANT ALL ON TABLE "public"."operation_attempts" TO "authenticated";
GRANT ALL ON TABLE "public"."operation_attempts" TO "service_role";



GRANT ALL ON TABLE "public"."operation_locks" TO "anon";
GRANT ALL ON TABLE "public"."operation_locks" TO "authenticated";
GRANT ALL ON TABLE "public"."operation_locks" TO "service_role";



GRANT ALL ON TABLE "public"."outbox_items" TO "anon";
GRANT ALL ON TABLE "public"."outbox_items" TO "authenticated";
GRANT ALL ON TABLE "public"."outbox_items" TO "service_role";



GRANT ALL ON TABLE "public"."pace_analyses" TO "anon";
GRANT ALL ON TABLE "public"."pace_analyses" TO "authenticated";
GRANT ALL ON TABLE "public"."pace_analyses" TO "service_role";



GRANT ALL ON TABLE "public"."packing_items" TO "service_role";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."packing_items" TO "authenticated";



GRANT ALL ON TABLE "public"."performance_metrics" TO "anon";
GRANT ALL ON TABLE "public"."performance_metrics" TO "authenticated";
GRANT ALL ON TABLE "public"."performance_metrics" TO "service_role";



GRANT ALL ON SEQUENCE "public"."performance_metrics_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."performance_metrics_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."performance_metrics_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."personal_calibration" TO "anon";
GRANT ALL ON TABLE "public"."personal_calibration" TO "authenticated";
GRANT ALL ON TABLE "public"."personal_calibration" TO "service_role";



GRANT ALL ON TABLE "public"."phrase_cards" TO "anon";
GRANT ALL ON TABLE "public"."phrase_cards" TO "authenticated";
GRANT ALL ON TABLE "public"."phrase_cards" TO "service_role";



GRANT ALL ON TABLE "public"."pipeline_recovery_log" TO "anon";
GRANT ALL ON TABLE "public"."pipeline_recovery_log" TO "authenticated";
GRANT ALL ON TABLE "public"."pipeline_recovery_log" TO "service_role";



GRANT ALL ON TABLE "public"."place_reports" TO "anon";
GRANT ALL ON TABLE "public"."place_reports" TO "authenticated";
GRANT ALL ON TABLE "public"."place_reports" TO "service_role";



GRANT ALL ON TABLE "public"."plan_changes" TO "anon";
GRANT ALL ON TABLE "public"."plan_changes" TO "authenticated";
GRANT ALL ON TABLE "public"."plan_changes" TO "service_role";



GRANT ALL ON TABLE "public"."planning_sessions" TO "anon";
GRANT ALL ON TABLE "public"."planning_sessions" TO "authenticated";
GRANT ALL ON TABLE "public"."planning_sessions" TO "service_role";



GRANT ALL ON TABLE "public"."platform_connections" TO "anon";
GRANT ALL ON TABLE "public"."platform_connections" TO "authenticated";
GRANT ALL ON TABLE "public"."platform_connections" TO "service_role";



GRANT ALL ON TABLE "public"."platform_users" TO "anon";
GRANT ALL ON TABLE "public"."platform_users" TO "authenticated";
GRANT ALL ON TABLE "public"."platform_users" TO "service_role";



GRANT ALL ON TABLE "public"."playbook_step_completions" TO "anon";
GRANT ALL ON TABLE "public"."playbook_step_completions" TO "authenticated";
GRANT ALL ON TABLE "public"."playbook_step_completions" TO "service_role";



GRANT ALL ON TABLE "public"."playbooks" TO "anon";
GRANT ALL ON TABLE "public"."playbooks" TO "authenticated";
GRANT ALL ON TABLE "public"."playbooks" TO "service_role";



GRANT ALL ON TABLE "public"."poll_options" TO "anon";
GRANT ALL ON TABLE "public"."poll_options" TO "authenticated";
GRANT ALL ON TABLE "public"."poll_options" TO "service_role";



GRANT ALL ON TABLE "public"."poll_options_v2" TO "anon";
GRANT ALL ON TABLE "public"."poll_options_v2" TO "authenticated";
GRANT ALL ON TABLE "public"."poll_options_v2" TO "service_role";



GRANT ALL ON TABLE "public"."poll_votes" TO "anon";
GRANT ALL ON TABLE "public"."poll_votes" TO "authenticated";
GRANT ALL ON TABLE "public"."poll_votes" TO "service_role";



GRANT ALL ON TABLE "public"."polls" TO "anon";
GRANT ALL ON TABLE "public"."polls" TO "authenticated";
GRANT ALL ON TABLE "public"."polls" TO "service_role";



GRANT ALL ON TABLE "public"."polls_v2" TO "anon";
GRANT ALL ON TABLE "public"."polls_v2" TO "authenticated";
GRANT ALL ON TABLE "public"."polls_v2" TO "service_role";



GRANT ALL ON TABLE "public"."pre_trip_readiness" TO "anon";
GRANT ALL ON TABLE "public"."pre_trip_readiness" TO "authenticated";
GRANT ALL ON TABLE "public"."pre_trip_readiness" TO "service_role";



GRANT ALL ON TABLE "public"."pre_trip_tasks" TO "anon";
GRANT ALL ON TABLE "public"."pre_trip_tasks" TO "authenticated";
GRANT ALL ON TABLE "public"."pre_trip_tasks" TO "service_role";



GRANT ALL ON TABLE "public"."prediction_models" TO "anon";
GRANT ALL ON TABLE "public"."prediction_models" TO "authenticated";
GRANT ALL ON TABLE "public"."prediction_models" TO "service_role";



GRANT ALL ON TABLE "public"."prep_items" TO "anon";
GRANT ALL ON TABLE "public"."prep_items" TO "authenticated";
GRANT ALL ON TABLE "public"."prep_items" TO "service_role";



GRANT ALL ON TABLE "public"."presence" TO "anon";
GRANT ALL ON TABLE "public"."presence" TO "authenticated";
GRANT ALL ON TABLE "public"."presence" TO "service_role";



GRANT ALL ON TABLE "public"."price_snapshots" TO "anon";
GRANT ALL ON TABLE "public"."price_snapshots" TO "authenticated";
GRANT ALL ON TABLE "public"."price_snapshots" TO "service_role";



GRANT ALL ON TABLE "public"."privacy_controls" TO "anon";
GRANT ALL ON TABLE "public"."privacy_controls" TO "authenticated";
GRANT ALL ON TABLE "public"."privacy_controls" TO "service_role";



GRANT ALL ON TABLE "public"."profile_signals" TO "anon";
GRANT ALL ON TABLE "public"."profile_signals" TO "authenticated";
GRANT ALL ON TABLE "public"."profile_signals" TO "service_role";



GRANT ALL ON TABLE "public"."profiles" TO "anon";
GRANT ALL ON TABLE "public"."profiles" TO "authenticated";
GRANT ALL ON TABLE "public"."profiles" TO "service_role";



GRANT ALL ON TABLE "public"."provider_cache" TO "anon";
GRANT ALL ON TABLE "public"."provider_cache" TO "authenticated";
GRANT ALL ON TABLE "public"."provider_cache" TO "service_role";



GRANT ALL ON TABLE "public"."provider_circuit" TO "anon";
GRANT ALL ON TABLE "public"."provider_circuit" TO "authenticated";
GRANT ALL ON TABLE "public"."provider_circuit" TO "service_role";



GRANT ALL ON TABLE "public"."provider_quota" TO "anon";
GRANT ALL ON TABLE "public"."provider_quota" TO "authenticated";
GRANT ALL ON TABLE "public"."provider_quota" TO "service_role";



GRANT ALL ON TABLE "public"."rate_limit_buckets" TO "anon";
GRANT ALL ON TABLE "public"."rate_limit_buckets" TO "authenticated";
GRANT ALL ON TABLE "public"."rate_limit_buckets" TO "service_role";



GRANT ALL ON TABLE "public"."rating_prompt_state" TO "anon";
GRANT ALL ON TABLE "public"."rating_prompt_state" TO "authenticated";
GRANT ALL ON TABLE "public"."rating_prompt_state" TO "service_role";



GRANT ALL ON TABLE "public"."readiness_items" TO "anon";
GRANT ALL ON TABLE "public"."readiness_items" TO "authenticated";
GRANT ALL ON TABLE "public"."readiness_items" TO "service_role";



GRANT ALL ON TABLE "public"."recommendation_engagement" TO "anon";
GRANT ALL ON TABLE "public"."recommendation_engagement" TO "authenticated";
GRANT ALL ON TABLE "public"."recommendation_engagement" TO "service_role";



GRANT ALL ON TABLE "public"."recommendation_trending" TO "anon";
GRANT ALL ON TABLE "public"."recommendation_trending" TO "authenticated";
GRANT ALL ON TABLE "public"."recommendation_trending" TO "service_role";



GRANT ALL ON TABLE "public"."recommendations" TO "anon";
GRANT ALL ON TABLE "public"."recommendations" TO "authenticated";
GRANT ALL ON TABLE "public"."recommendations" TO "service_role";



GRANT ALL ON TABLE "public"."release_checklist" TO "anon";
GRANT ALL ON TABLE "public"."release_checklist" TO "authenticated";
GRANT ALL ON TABLE "public"."release_checklist" TO "service_role";



GRANT ALL ON TABLE "public"."replan_applied" TO "anon";
GRANT ALL ON TABLE "public"."replan_applied" TO "authenticated";
GRANT ALL ON TABLE "public"."replan_applied" TO "service_role";



GRANT ALL ON TABLE "public"."replan_cache" TO "anon";
GRANT ALL ON TABLE "public"."replan_cache" TO "authenticated";
GRANT ALL ON TABLE "public"."replan_cache" TO "service_role";



GRANT ALL ON TABLE "public"."reservation_poll_schedule" TO "anon";
GRANT ALL ON TABLE "public"."reservation_poll_schedule" TO "authenticated";
GRANT ALL ON TABLE "public"."reservation_poll_schedule" TO "service_role";



GRANT ALL ON TABLE "public"."reservation_price_history" TO "anon";
GRANT ALL ON TABLE "public"."reservation_price_history" TO "authenticated";
GRANT ALL ON TABLE "public"."reservation_price_history" TO "service_role";



GRANT ALL ON TABLE "public"."reservations" TO "anon";
GRANT ALL ON TABLE "public"."reservations" TO "authenticated";
GRANT ALL ON TABLE "public"."reservations" TO "service_role";



GRANT ALL ON TABLE "public"."rollcall_responses" TO "anon";
GRANT ALL ON TABLE "public"."rollcall_responses" TO "authenticated";
GRANT ALL ON TABLE "public"."rollcall_responses" TO "service_role";



GRANT ALL ON TABLE "public"."rollcalls" TO "anon";
GRANT ALL ON TABLE "public"."rollcalls" TO "authenticated";
GRANT ALL ON TABLE "public"."rollcalls" TO "service_role";



GRANT ALL ON TABLE "public"."safety_advisories" TO "anon";
GRANT ALL ON TABLE "public"."safety_advisories" TO "authenticated";
GRANT ALL ON TABLE "public"."safety_advisories" TO "service_role";



GRANT ALL ON TABLE "public"."safety_assessments" TO "anon";
GRANT ALL ON TABLE "public"."safety_assessments" TO "authenticated";
GRANT ALL ON TABLE "public"."safety_assessments" TO "service_role";



GRANT ALL ON TABLE "public"."safety_notes" TO "anon";
GRANT ALL ON TABLE "public"."safety_notes" TO "authenticated";
GRANT ALL ON TABLE "public"."safety_notes" TO "service_role";



GRANT ALL ON TABLE "public"."safety_preferences" TO "anon";
GRANT ALL ON TABLE "public"."safety_preferences" TO "authenticated";
GRANT ALL ON TABLE "public"."safety_preferences" TO "service_role";



GRANT ALL ON TABLE "public"."safety_reports" TO "anon";
GRANT ALL ON TABLE "public"."safety_reports" TO "authenticated";
GRANT ALL ON TABLE "public"."safety_reports" TO "service_role";



GRANT ALL ON TABLE "public"."safety_rules" TO "anon";
GRANT ALL ON TABLE "public"."safety_rules" TO "authenticated";
GRANT ALL ON TABLE "public"."safety_rules" TO "service_role";



GRANT ALL ON TABLE "public"."satisfaction_ledger" TO "anon";
GRANT ALL ON TABLE "public"."satisfaction_ledger" TO "authenticated";
GRANT ALL ON TABLE "public"."satisfaction_ledger" TO "service_role";



GRANT ALL ON TABLE "public"."saved_recommendations" TO "anon";
GRANT ALL ON TABLE "public"."saved_recommendations" TO "authenticated";
GRANT ALL ON TABLE "public"."saved_recommendations" TO "service_role";



GRANT ALL ON TABLE "public"."search_analytics" TO "anon";
GRANT ALL ON TABLE "public"."search_analytics" TO "authenticated";
GRANT ALL ON TABLE "public"."search_analytics" TO "service_role";



GRANT ALL ON SEQUENCE "public"."search_analytics_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."search_analytics_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."search_analytics_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."secure_documents" TO "anon";
GRANT ALL ON TABLE "public"."secure_documents" TO "authenticated";
GRANT ALL ON TABLE "public"."secure_documents" TO "service_role";



GRANT ALL ON TABLE "public"."serendipity_dismissed" TO "anon";
GRANT ALL ON TABLE "public"."serendipity_dismissed" TO "authenticated";
GRANT ALL ON TABLE "public"."serendipity_dismissed" TO "service_role";



GRANT ALL ON TABLE "public"."serendipity_preferences" TO "anon";
GRANT ALL ON TABLE "public"."serendipity_preferences" TO "authenticated";
GRANT ALL ON TABLE "public"."serendipity_preferences" TO "service_role";



GRANT ALL ON TABLE "public"."serendipity_suggestions" TO "anon";
GRANT ALL ON TABLE "public"."serendipity_suggestions" TO "authenticated";
GRANT ALL ON TABLE "public"."serendipity_suggestions" TO "service_role";



GRANT ALL ON TABLE "public"."settlement_calculations" TO "anon";
GRANT ALL ON TABLE "public"."settlement_calculations" TO "authenticated";
GRANT ALL ON TABLE "public"."settlement_calculations" TO "service_role";



GRANT ALL ON TABLE "public"."settlement_disputes" TO "anon";
GRANT ALL ON TABLE "public"."settlement_disputes" TO "authenticated";
GRANT ALL ON TABLE "public"."settlement_disputes" TO "service_role";



GRANT ALL ON TABLE "public"."settlement_history" TO "anon";
GRANT ALL ON TABLE "public"."settlement_history" TO "authenticated";
GRANT ALL ON TABLE "public"."settlement_history" TO "service_role";



GRANT ALL ON TABLE "public"."settlement_proofs" TO "anon";
GRANT ALL ON TABLE "public"."settlement_proofs" TO "authenticated";
GRANT ALL ON TABLE "public"."settlement_proofs" TO "service_role";



GRANT ALL ON TABLE "public"."settlements" TO "anon";
GRANT ALL ON TABLE "public"."settlements" TO "authenticated";
GRANT ALL ON TABLE "public"."settlements" TO "service_role";



GRANT ALL ON TABLE "public"."share_links" TO "anon";
GRANT ALL ON TABLE "public"."share_links" TO "authenticated";
GRANT ALL ON TABLE "public"."share_links" TO "service_role";



GRANT ALL ON TABLE "public"."shareable_calendars" TO "anon";
GRANT ALL ON TABLE "public"."shareable_calendars" TO "authenticated";
GRANT ALL ON TABLE "public"."shareable_calendars" TO "service_role";



GRANT ALL ON TABLE "public"."slo_metrics" TO "anon";
GRANT ALL ON TABLE "public"."slo_metrics" TO "authenticated";
GRANT ALL ON TABLE "public"."slo_metrics" TO "service_role";



GRANT ALL ON TABLE "public"."support_conversations" TO "anon";
GRANT ALL ON TABLE "public"."support_conversations" TO "authenticated";
GRANT ALL ON TABLE "public"."support_conversations" TO "service_role";



GRANT ALL ON TABLE "public"."taxonomy_versions" TO "anon";
GRANT ALL ON TABLE "public"."taxonomy_versions" TO "authenticated";
GRANT ALL ON TABLE "public"."taxonomy_versions" TO "service_role";



GRANT ALL ON TABLE "public"."tips_preferences" TO "anon";
GRANT ALL ON TABLE "public"."tips_preferences" TO "authenticated";
GRANT ALL ON TABLE "public"."tips_preferences" TO "service_role";



GRANT ALL ON TABLE "public"."traffic_updates" TO "anon";
GRANT ALL ON TABLE "public"."traffic_updates" TO "authenticated";
GRANT ALL ON TABLE "public"."traffic_updates" TO "service_role";



GRANT ALL ON TABLE "public"."travel_alerts" TO "anon";
GRANT ALL ON TABLE "public"."travel_alerts" TO "authenticated";
GRANT ALL ON TABLE "public"."travel_alerts" TO "service_role";



GRANT ALL ON TABLE "public"."travel_operations" TO "anon";
GRANT ALL ON TABLE "public"."travel_operations" TO "authenticated";
GRANT ALL ON TABLE "public"."travel_operations" TO "service_role";



GRANT ALL ON TABLE "public"."traveler_profiles" TO "anon";
GRANT ALL ON TABLE "public"."traveler_profiles" TO "authenticated";
GRANT ALL ON TABLE "public"."traveler_profiles" TO "service_role";



GRANT ALL ON TABLE "public"."trip_assemblies" TO "anon";
GRANT ALL ON TABLE "public"."trip_assemblies" TO "authenticated";
GRANT ALL ON TABLE "public"."trip_assemblies" TO "service_role";



GRANT ALL ON TABLE "public"."trip_change_log" TO "anon";
GRANT ALL ON TABLE "public"."trip_change_log" TO "authenticated";
GRANT ALL ON TABLE "public"."trip_change_log" TO "service_role";



GRANT ALL ON TABLE "public"."trip_change_previews" TO "anon";
GRANT ALL ON TABLE "public"."trip_change_previews" TO "authenticated";
GRANT ALL ON TABLE "public"."trip_change_previews" TO "service_role";



GRANT ALL ON TABLE "public"."trip_forecasts" TO "anon";
GRANT ALL ON TABLE "public"."trip_forecasts" TO "authenticated";
GRANT ALL ON TABLE "public"."trip_forecasts" TO "service_role";



GRANT ALL ON TABLE "public"."trip_groups" TO "anon";
GRANT ALL ON TABLE "public"."trip_groups" TO "authenticated";
GRANT ALL ON TABLE "public"."trip_groups" TO "service_role";



GRANT ALL ON TABLE "public"."trip_health_analyses" TO "anon";
GRANT ALL ON TABLE "public"."trip_health_analyses" TO "authenticated";
GRANT ALL ON TABLE "public"."trip_health_analyses" TO "service_role";



GRANT ALL ON TABLE "public"."trip_impacts" TO "anon";
GRANT ALL ON TABLE "public"."trip_impacts" TO "authenticated";
GRANT ALL ON TABLE "public"."trip_impacts" TO "service_role";



GRANT ALL ON TABLE "public"."trip_issues" TO "anon";
GRANT ALL ON TABLE "public"."trip_issues" TO "authenticated";
GRANT ALL ON TABLE "public"."trip_issues" TO "service_role";



GRANT ALL ON TABLE "public"."trip_members" TO "anon";
GRANT ALL ON TABLE "public"."trip_members" TO "authenticated";
GRANT ALL ON TABLE "public"."trip_members" TO "service_role";



GRANT ALL ON TABLE "public"."trip_planning_preferences" TO "anon";
GRANT ALL ON TABLE "public"."trip_planning_preferences" TO "authenticated";
GRANT ALL ON TABLE "public"."trip_planning_preferences" TO "service_role";



GRANT ALL ON TABLE "public"."trips" TO "anon";
GRANT ALL ON TABLE "public"."trips" TO "authenticated";
GRANT ALL ON TABLE "public"."trips" TO "service_role";



GRANT ALL ON TABLE "public"."typing_indicators" TO "anon";
GRANT ALL ON TABLE "public"."typing_indicators" TO "authenticated";
GRANT ALL ON TABLE "public"."typing_indicators" TO "service_role";



GRANT ALL ON TABLE "public"."user_actions" TO "anon";
GRANT ALL ON TABLE "public"."user_actions" TO "authenticated";
GRANT ALL ON TABLE "public"."user_actions" TO "service_role";



GRANT ALL ON SEQUENCE "public"."user_actions_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."user_actions_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."user_actions_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."user_alert_preferences" TO "anon";
GRANT ALL ON TABLE "public"."user_alert_preferences" TO "authenticated";
GRANT ALL ON TABLE "public"."user_alert_preferences" TO "service_role";



GRANT ALL ON TABLE "public"."user_behavior_profiles" TO "anon";
GRANT ALL ON TABLE "public"."user_behavior_profiles" TO "authenticated";
GRANT ALL ON TABLE "public"."user_behavior_profiles" TO "service_role";



GRANT ALL ON SEQUENCE "public"."user_behavior_profiles_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."user_behavior_profiles_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."user_behavior_profiles_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."user_devices" TO "anon";
GRANT ALL ON TABLE "public"."user_devices" TO "authenticated";
GRANT ALL ON TABLE "public"."user_devices" TO "service_role";



GRANT ALL ON TABLE "public"."user_limits" TO "anon";
GRANT ALL ON TABLE "public"."user_limits" TO "authenticated";
GRANT ALL ON TABLE "public"."user_limits" TO "service_role";



GRANT ALL ON SEQUENCE "public"."user_limits_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."user_limits_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."user_limits_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."user_push_tokens" TO "anon";
GRANT ALL ON TABLE "public"."user_push_tokens" TO "authenticated";
GRANT ALL ON TABLE "public"."user_push_tokens" TO "service_role";



GRANT ALL ON TABLE "public"."user_recommendation_profiles" TO "anon";
GRANT ALL ON TABLE "public"."user_recommendation_profiles" TO "authenticated";
GRANT ALL ON TABLE "public"."user_recommendation_profiles" TO "service_role";



GRANT ALL ON TABLE "public"."weather_forecasts" TO "anon";
GRANT ALL ON TABLE "public"."weather_forecasts" TO "authenticated";
GRANT ALL ON TABLE "public"."weather_forecasts" TO "service_role";









ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "service_role";































