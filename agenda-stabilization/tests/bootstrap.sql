create role anon; create role authenticated; create role service_role bypassrls;
create sequence public.vsc_agenda_audit_id_seq;
create schema auth; create table auth.users(id uuid primary key);
grant usage on schema public,auth to service_role,anon,authenticated;
create table public.vsc_agenda_sources (
 source_key text not null,
 label text not null,
 calendar_id text not null,
 source_group text not null,
 category text not null,
 enabled boolean default true not null,
 last_status integer,
 last_synced_at timestamp with time zone,
 created_at timestamp with time zone default now() not null,
 updated_at timestamp with time zone default now() not null
);
create table public.vsc_agenda_parishes (
 id uuid default gen_random_uuid() not null,
 directory_place_id text,
 canonical_name text not null,
 city text,
 forania text,
 is_active boolean default true not null,
 source text default 'manual'::text not null,
 created_at timestamp with time zone default now() not null,
 updated_at timestamp with time zone default now() not null,
 entity_type text default 'parish'::text not null,
 official_abbreviation text
);
create table public.vsc_agenda_parish_aliases (
 id uuid default gen_random_uuid() not null,
 parish_id uuid not null,
 alias_name text not null,
 alias_city text,
 alias_key text not null,
 created_at timestamp with time zone default now() not null
);
create table public.vsc_agenda_access (
 user_id uuid not null,
 display_name text not null,
 role text default 'collaborator'::text not null,
 access_status text default 'active'::text not null,
 parish_id uuid,
 can_manage_requests boolean default false not null,
 can_manage_users boolean default false not null,
 created_at timestamp with time zone default now() not null,
 updated_at timestamp with time zone default now() not null,
 must_change_password boolean default true not null
);
create table public.vsc_agenda_access_requests (
 id uuid default gen_random_uuid() not null,
 full_name text not null,
 email text not null,
 requested_role text not null,
 institution text,
 ministry_role text,
 notes text,
 status text default 'pending'::text not null,
 decided_by uuid,
 decided_at timestamp with time zone,
 auth_user_id uuid,
 created_at timestamp with time zone default now() not null,
 updated_at timestamp with time zone default now() not null
);
create table public.vsc_agenda_audit (
 id bigint not null,
 user_id uuid,
 action text not null,
 metadata jsonb default '{}'::jsonb not null,
 occurred_at timestamp with time zone default now() not null
);
create table public.vsc_agenda_events (
 source_key text not null,
 event_uid text not null,
 title text not null,
 raw_title text,
 starts_at timestamp with time zone not null,
 ends_at timestamp with time zone not null,
 all_day boolean default false not null,
 location text,
 description text,
 cancelled boolean default false not null,
 synced_at timestamp with time zone default now() not null,
 parish_ref_id uuid,
 bishop_absent boolean default false not null
);
alter table public.vsc_agenda_sources add CHECK ((source_group = ANY (ARRAY['main'::text, 'special'::text])));
alter table public.vsc_agenda_sources add PRIMARY KEY (source_key);
alter table public.vsc_agenda_parishes add PRIMARY KEY (id);
alter table public.vsc_agenda_parishes add UNIQUE (directory_place_id);
alter table public.vsc_agenda_parishes add UNIQUE (canonical_name, city);
alter table public.vsc_agenda_parish_aliases add PRIMARY KEY (id);
alter table public.vsc_agenda_parish_aliases add UNIQUE (alias_key);
alter table public.vsc_agenda_parish_aliases add FOREIGN KEY (parish_id) REFERENCES vsc_agenda_parishes(id) ON DELETE CASCADE;
alter table public.vsc_agenda_access add CHECK ((role = ANY (ARRAY['admin'::text, 'clergy'::text, 'parish'::text, 'curia'::text, 'collaborator'::text])));
alter table public.vsc_agenda_access add CHECK ((access_status = ANY (ARRAY['active'::text, 'suspended'::text])));
alter table public.vsc_agenda_access add PRIMARY KEY (user_id);
alter table public.vsc_agenda_access add FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
alter table public.vsc_agenda_access add FOREIGN KEY (parish_id) REFERENCES vsc_agenda_parishes(id) ON DELETE SET NULL;
alter table public.vsc_agenda_access_requests add CHECK ((requested_role = ANY (ARRAY['clergy'::text, 'parish'::text, 'curia'::text, 'collaborator'::text])));
alter table public.vsc_agenda_access_requests add CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text, 'cancelled'::text])));
alter table public.vsc_agenda_access_requests add PRIMARY KEY (id);
alter table public.vsc_agenda_access_requests add FOREIGN KEY (decided_by) REFERENCES auth.users(id) ON DELETE SET NULL;
alter table public.vsc_agenda_access_requests add FOREIGN KEY (auth_user_id) REFERENCES auth.users(id) ON DELETE SET NULL;
alter table public.vsc_agenda_audit add PRIMARY KEY (id);
alter table public.vsc_agenda_audit add FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE SET NULL;
alter table public.vsc_agenda_events add PRIMARY KEY (source_key, event_uid, starts_at);
alter table public.vsc_agenda_events add FOREIGN KEY (source_key) REFERENCES vsc_agenda_sources(source_key) ON DELETE CASCADE;
alter table public.vsc_agenda_events add FOREIGN KEY (parish_ref_id) REFERENCES vsc_agenda_parishes(id) ON DELETE SET NULL;
alter table public.vsc_agenda_parishes add CHECK ((entity_type = ANY (ARRAY['parish'::text, 'quasi_parish'::text, 'institution'::text])));
CREATE OR REPLACE FUNCTION public.vsc_agenda_link_events(target_source text DEFAULT NULL::text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare affected integer;
begin
  update public.vsc_agenda_events e
     set parish_ref_id = public.vsc_agenda_resolve_parish(e.title,e.location)
   where (target_source is null or e.source_key=target_source)
     and e.source_key <> 'liturgico';
  get diagnostics affected = row_count;
  return affected;
end;
$function$;

CREATE OR REPLACE FUNCTION public.vsc_agenda_normalize(input text)
 RETURNS text
 LANGUAGE plpgsql
 IMMUTABLE
AS $function$
declare v text := lower(coalesce(input,''));
begin
  v := translate(v,
    'áàâãäéèêëíìîïóòôõöúùûüç',
    'aaaaaeeeeiiiiooooouuuuc');
  v := regexp_replace(v, '[^a-z0-9]+', ' ', 'g');
  v := regexp_replace(v, '\mqpar\M|\mq par\M', 'quase paroquia', 'g');
  v := regexp_replace(v, '\mpar\M', 'paroquia', 'g');
  v := regexp_replace(v, '\mn sra\M', 'nossa senhora', 'g');
  v := regexp_replace(v, '\msto\M', 'santo', 'g');
  v := regexp_replace(v, '\msta\M', 'santa', 'g');
  v := regexp_replace(v, '\s+', ' ', 'g');
  return trim(v);
end;
$function$;

CREATE OR REPLACE FUNCTION public.vsc_agenda_resolve_parish(event_title text, event_location text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE sql
 STABLE
AS $function$
with params as (
  select public.vsc_agenda_normalize(coalesce(event_title,'') || ' ' || coalesce(event_location,'')) as event_text
),
alias_base as (
  select
    a.parish_id,
    public.vsc_agenda_normalize(a.alias_name) as alias_norm,
    public.vsc_agenda_normalize(a.alias_city) as city_norm
  from public.vsc_agenda_parish_aliases a
),
alias_counts as (
  select alias_norm, count(distinct parish_id) as parish_count
  from alias_base
  where alias_norm <> ''
  group by alias_norm
),
candidate_scores as (
  select
    ab.parish_id,
    max(case when ab.city_norm <> '' and strpos(p.event_text, ab.city_norm) > 0 then 1 else 0 end) as city_hit,
    max(length(ab.alias_norm)) as alias_len
  from alias_base ab
  join alias_counts ac using(alias_norm)
  cross join params p
  where ab.alias_norm <> ''
    and strpos(p.event_text, ab.alias_norm) > 0
    and (
      (ab.city_norm <> '' and strpos(p.event_text, ab.city_norm) > 0)
      or ac.parish_count = 1
    )
  group by ab.parish_id
),
ranked_alias as (
  select *,
         dense_rank() over(order by city_hit desc, alias_len desc) as rnk
  from candidate_scores
),
alias_choice as (
  select case
    when count(*) filter(where rnk=1)=1
    then (array_agg(parish_id) filter(where rnk=1))[1]
    else null::uuid
  end as parish_id
  from ranked_alias
),
city_base as (
  select
    p.id,
    public.vsc_agenda_normalize(p.city) as city_norm,
    count(*) over(partition by public.vsc_agenda_normalize(p.city)) as city_count
  from public.vsc_agenda_parishes p
  where p.entity_type in ('parish','quasi_parish')
    and coalesce(p.city,'') <> ''
),
city_candidates as (
  select cb.id, length(cb.city_norm) as city_len
  from city_base cb
  cross join params p
  where cb.city_count=1
    and cb.city_norm <> ''
    and strpos(p.event_text, cb.city_norm) > 0
),
ranked_city as (
  select *, dense_rank() over(order by city_len desc) as rnk
  from city_candidates
),
city_choice as (
  select case
    when count(*) filter(where rnk=1)=1
    then (array_agg(id) filter(where rnk=1))[1]
    else null::uuid
  end as parish_id
  from ranked_city
)
select coalesce((select parish_id from alias_choice),(select parish_id from city_choice));
$function$;

grant all on all tables in schema public to service_role; grant usage,select on all sequences in schema public to service_role;

