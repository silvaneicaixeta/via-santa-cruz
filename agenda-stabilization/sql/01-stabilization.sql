-- PREPARED ONLY. Apply to an isolated database first; production requires approval.
begin;
alter table public.vsc_agenda_events add column occurrence_key text;

create table public.vsc_agenda_sync_runs (
 id uuid primary key default gen_random_uuid(),
 origin text not null check (origin in ('manual','automatic')),
 actor_id uuid references auth.users(id) on delete set null,
 started_at timestamptz not null default clock_timestamp(),
 finished_at timestamptz,
 status text not null default 'running' check(status in ('running','success','partial','failed','expired')),
 error_code text,
 check (error_code is null or error_code ~ '^[a-z0-9_]{1,64}$')
);
create table public.vsc_agenda_sync_lease (
 singleton boolean primary key default true check(singleton),
 run_id uuid references public.vsc_agenda_sync_runs(id),
 expires_at timestamptz
);
insert into public.vsc_agenda_sync_lease(singleton) values(true);
create table public.vsc_agenda_sync_results (
 run_id uuid not null references public.vsc_agenda_sync_runs(id),
 source_key text not null references public.vsc_agenda_sources(source_key),
 attempted_at timestamptz not null default clock_timestamp(),
 finished_at timestamptz,
 status text not null default 'running' check(status in ('running','success','failed')),
 event_count integer not null default 0 check(event_count >= 0),
 legacy_links_retained integer not null default 0 check(legacy_links_retained >= 0),
 http_status integer,
 duration_ms integer not null default 0 check(duration_ms >= 0),
 error_code text check(error_code is null or error_code ~ '^[a-z0-9_]{1,64}$'),
 primary key(run_id,source_key)
);
alter table public.vsc_agenda_sync_runs enable row level security;
alter table public.vsc_agenda_sync_lease enable row level security;
alter table public.vsc_agenda_sync_results enable row level security;
revoke all on public.vsc_agenda_sync_runs, public.vsc_agenda_sync_lease,
 public.vsc_agenda_sync_results from public, anon, authenticated;
grant select,insert,update on public.vsc_agenda_sync_runs,public.vsc_agenda_sync_lease,
 public.vsc_agenda_sync_results to service_role;

-- Existing linker no longer elevates caller privileges and never erases a valid link.
create or replace function public.vsc_agenda_link_events(target_source text default null)
returns integer language plpgsql security invoker set search_path=pg_catalog as $$
declare affected integer;
begin
 update public.vsc_agenda_events e
 set parish_ref_id=public.vsc_agenda_resolve_parish(e.title,e.location)
 where (target_source is null or e.source_key=target_source)
   and e.source_key <> 'liturgico' and e.parish_ref_id is null;
 get diagnostics affected=row_count;
 return affected;
end $$;
revoke all on function public.vsc_agenda_link_events(text) from public,anon,authenticated;
grant execute on function public.vsc_agenda_link_events(text) to service_role;

create function public.vsc_agenda_sync_begin(p_origin text,p_actor uuid default null)
returns uuid language plpgsql security invoker set search_path=pg_catalog as $$
declare l public.vsc_agenda_sync_lease; r uuid;
begin
 if p_origin not in ('manual','automatic') then raise exception 'invalid_origin'; end if;
 if p_origin='manual' and not exists(select 1 from public.vsc_agenda_access
   where user_id=p_actor and role='admin' and access_status='active')
 then raise exception 'admin_required'; end if;
 select * into l from public.vsc_agenda_sync_lease where singleton for update;
 if l.run_id is not null and l.expires_at > clock_timestamp() then
   raise exception 'sync_busy' using errcode='55P03';
 end if;
 if l.run_id is not null then
   update public.vsc_agenda_sync_runs set status='expired',finished_at=clock_timestamp(),
     error_code='lease_expired' where id=l.run_id and status='running';
   update public.vsc_agenda_sync_results set status='failed',finished_at=clock_timestamp(),
     error_code='lease_expired' where run_id=l.run_id and status='running';
 end if;
 insert into public.vsc_agenda_sync_runs(origin,actor_id) values(p_origin,p_actor) returning id into r;
 update public.vsc_agenda_sync_lease set run_id=r,expires_at=clock_timestamp()+interval '180 seconds'
   where singleton;
 return r;
end $$;

create function public.vsc_agenda_sync_assert(p_run uuid)
returns void language plpgsql security invoker set search_path=pg_catalog as $$
begin
 perform 1 from public.vsc_agenda_sync_lease where singleton and run_id=p_run
   and expires_at > clock_timestamp() for update;
 if not found then raise exception 'lease_lost' using errcode='55P03'; end if;
end $$;

create function public.vsc_agenda_sync_source_begin(p_run uuid,p_source text)
returns void language plpgsql security invoker set search_path=pg_catalog as $$
begin
 perform public.vsc_agenda_sync_assert(p_run);
 if not exists(select 1 from public.vsc_agenda_sources where source_key=p_source and enabled)
 then raise exception 'invalid_source'; end if;
 insert into public.vsc_agenda_sync_results(run_id,source_key) values(p_run,p_source);
end $$;

create function public.vsc_agenda_sync_replace(p_run uuid,p_source text,p_events jsonb,
 p_min timestamptz,p_max timestamptz,p_duration integer,p_calendar text)
returns integer language plpgsql security invoker set search_path=pg_catalog as $$
declare n integer; old_count integer; legacy_count integer;
begin
 perform public.vsc_agenda_sync_assert(p_run);
 perform 1 from public.vsc_agenda_sources where source_key=p_source
  and calendar_id=p_calendar and enabled for update;
 if not found then raise exception 'source_changed'; end if;
 perform 1 from public.vsc_agenda_sync_results
  where run_id=p_run and source_key=p_source and status='running' for update;
 if not found then raise exception 'source_not_running'; end if;
 if p_min is null or p_max is null or p_duration is null or p_events is null
   or p_min >= p_max or p_duration < 0 or jsonb_typeof(p_events) <> 'array'
   or jsonb_array_length(p_events)=0 or jsonb_array_length(p_events)>20000
 then raise exception 'invalid_snapshot'; end if;
 -- Cast and validate the entire snapshot BEFORE any event write. NULLs are rejected.
 if exists(select 1 from jsonb_populate_recordset(null::public.vsc_agenda_events,p_events) x
   where x.source_key is distinct from p_source or coalesce(x.event_uid,'')=''
   or coalesce(x.title,'')='' or x.starts_at is null or x.ends_at is null
   or not isfinite(x.starts_at) or not isfinite(x.ends_at)
   or x.starts_at < p_min or x.starts_at > p_max or x.ends_at < x.starts_at
   or x.all_day is null or x.cancelled is null or x.bishop_absent is null
   or coalesce(x.occurrence_key,'')='' or x.parish_ref_id is not null)
 then raise exception 'invalid_event'; end if;
 if exists(select 1 from jsonb_populate_recordset(null::public.vsc_agenda_events,p_events) x
   group by x.event_uid,x.starts_at having count(*)>1)
 then raise exception 'duplicate_event'; end if;
 n=jsonb_array_length(p_events);
 select count(*) into old_count from public.vsc_agenda_events
  where source_key=p_source and starts_at between p_min and p_max;
 if old_count >= 10 and n < old_count * 0.5 then raise exception 'snapshot_drop_guard'; end if;
 -- Existing UID and PK are retained. Original recurrence identity transfers links
 -- when an exception moves. Pre-migration ambiguous links are left untouched.
 insert into public.vsc_agenda_events(source_key,event_uid,title,raw_title,starts_at,ends_at,
  all_day,location,description,cancelled,bishop_absent,synced_at,parish_ref_id,occurrence_key)
 select p_source,x.event_uid,x.title,x.raw_title,x.starts_at,x.ends_at,x.all_day,x.location,
   x.description,x.cancelled,x.bishop_absent,clock_timestamp(),
   (select e.parish_ref_id from public.vsc_agenda_events e
    where e.source_key=p_source and e.event_uid=x.event_uid and e.parish_ref_id is not null
     and (coalesce(e.occurrence_key,e.starts_at::text)=x.occurrence_key or e.starts_at=x.starts_at)
    order by (e.starts_at=x.starts_at) desc limit 1),x.occurrence_key
 from jsonb_populate_recordset(null::public.vsc_agenda_events,p_events) x
 on conflict(source_key,event_uid,starts_at) do update set
  title=excluded.title,raw_title=excluded.raw_title,ends_at=excluded.ends_at,
  all_day=excluded.all_day,location=excluded.location,description=excluded.description,
  cancelled=excluded.cancelled,bishop_absent=excluded.bishop_absent,
  synced_at=excluded.synced_at,occurrence_key=excluded.occurrence_key,
  parish_ref_id=coalesce(public.vsc_agenda_events.parish_ref_id,excluded.parish_ref_id);
 delete from public.vsc_agenda_events e where e.source_key=p_source
   and e.starts_at between p_min and p_max and not exists(
    select 1 from jsonb_populate_recordset(null::public.vsc_agenda_events,p_events) x
     where x.event_uid=e.event_uid and x.starts_at=e.starts_at)
   -- Unknown pre-migration institutional links must be reviewed rather than lost.
   and not (e.parish_ref_id is not null and e.occurrence_key is null);
 perform public.vsc_agenda_link_events(p_source);
 select count(*) into legacy_count from public.vsc_agenda_events e where e.source_key=p_source
   and e.starts_at between p_min and p_max and e.parish_ref_id is not null
   and e.occurrence_key is null and not exists(
     select 1 from jsonb_populate_recordset(null::public.vsc_agenda_events,p_events) x
     where x.event_uid=e.event_uid and x.starts_at=e.starts_at);
 update public.vsc_agenda_sources set last_status=200,last_synced_at=clock_timestamp(),
  updated_at=clock_timestamp() where source_key=p_source;
 update public.vsc_agenda_sync_results set status='success',finished_at=clock_timestamp(),
  event_count=n,http_status=200,legacy_links_retained=legacy_count,
  duration_ms=greatest(p_duration,ceil(extract(epoch from clock_timestamp()-attempted_at)*1000)::integer)
  where run_id=p_run and source_key=p_source;
 return n;
end $$;

create function public.vsc_agenda_sync_source_fail(p_run uuid,p_source text,
 p_code text,p_http integer,p_duration integer)
returns void language plpgsql security invoker set search_path=pg_catalog as $$
begin
 perform public.vsc_agenda_sync_assert(p_run);
 update public.vsc_agenda_sync_results set status='failed',finished_at=clock_timestamp(),
  error_code=p_code,http_status=p_http,duration_ms=p_duration
  where run_id=p_run and source_key=p_source and status='running';
 update public.vsc_agenda_sources set last_status=case when p_http=200 then 500 else coalesce(p_http,500) end,
  updated_at=clock_timestamp() where source_key=p_source;
end $$;

create function public.vsc_agenda_sync_finish(p_run uuid,p_error text default null)
returns text language plpgsql security invoker set search_path=pg_catalog as $$
declare result text;
begin
 perform public.vsc_agenda_sync_assert(p_run);
 update public.vsc_agenda_sync_results set status='failed',finished_at=clock_timestamp(),
  error_code=coalesce(p_error,'run_interrupted') where run_id=p_run and status='running';
 select case when p_error is not null then 'failed'
  when count(*)=0 then 'failed'
  when bool_and(status='success') then 'success'
  when bool_or(status='success') then 'partial' else 'failed' end into result
 from public.vsc_agenda_sync_results where run_id=p_run;
 update public.vsc_agenda_sync_runs set status=result,error_code=p_error,
  finished_at=clock_timestamp() where id=p_run;
 update public.vsc_agenda_sync_lease set run_id=null,expires_at=null where singleton and run_id=p_run;
 return result;
end $$;

revoke all on function public.vsc_agenda_sync_begin(text,uuid),
 public.vsc_agenda_sync_assert(uuid),public.vsc_agenda_sync_source_begin(uuid,text),
 public.vsc_agenda_sync_replace(uuid,text,jsonb,timestamptz,timestamptz,integer,text),
 public.vsc_agenda_sync_source_fail(uuid,text,text,integer,integer),
 public.vsc_agenda_sync_finish(uuid,text) from public,anon,authenticated;
grant execute on function public.vsc_agenda_sync_begin(text,uuid),
 public.vsc_agenda_sync_assert(uuid),public.vsc_agenda_sync_source_begin(uuid,text),
 public.vsc_agenda_sync_replace(uuid,text,jsonb,timestamptz,timestamptz,integer,text),
 public.vsc_agenda_sync_source_fail(uuid,text,text,integer,integer),
 public.vsc_agenda_sync_finish(uuid,text) to service_role;
commit;
