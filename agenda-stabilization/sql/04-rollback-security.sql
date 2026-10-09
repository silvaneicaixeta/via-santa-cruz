-- Emergency containment AFTER approval, not an automatic down migration.
-- First disable the approved scheduler and stop in-flight runs. Do not drop history.
-- Install rollback/vsc-agenda-sync/index.ts for containment. Do not reinstate
-- the unsafe old synchronizer as an automatic rollback.
begin;
revoke all on function public.vsc_agenda_link_events(text) from public,anon,authenticated;
grant execute on function public.vsc_agenda_link_events(text) to service_role;
alter function public.vsc_agenda_link_events(text) security invoker;
alter function public.vsc_agenda_link_events(text) set search_path=pg_catalog;
commit;
-- New tables and occurrence_key are additive: retain them during rollback.
-- The old dashboard/sync source is archived in baseline/ for reproducibility.
-- Never restore the previously exposed PUBLIC/anon/authenticated linker grants.
