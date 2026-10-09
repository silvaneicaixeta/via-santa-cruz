



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

