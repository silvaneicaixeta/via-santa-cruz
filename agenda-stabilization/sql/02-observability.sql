-- Read-only views: accessible exclusively to service_role.
begin;
create view public.vsc_agenda_sync_source_health with (security_invoker=true) as
 select s.source_key,s.label,s.last_synced_at as last_success_at,
  a.attempted_at as last_attempt_at,a.status as last_attempt_status,
  a.http_status,a.error_code,a.event_count,a.legacy_links_retained,a.duration_ms,r.origin,r.id as run_id
 from public.vsc_agenda_sources s
 left join lateral(select * from public.vsc_agenda_sync_results
  where source_key=s.source_key order by attempted_at desc limit 1) a on true
 left join public.vsc_agenda_sync_runs r on r.id=a.run_id;
revoke all on public.vsc_agenda_sync_source_health from public,anon,authenticated;
grant select on public.vsc_agenda_sync_source_health to service_role;
commit;
