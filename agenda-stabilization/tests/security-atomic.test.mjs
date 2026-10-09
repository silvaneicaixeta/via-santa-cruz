import test from "node:test";
import assert from "node:assert/strict";
import {createHandler} from "../functions/vsc-agenda-sync/core.mjs";
import {database,request,deps,snapshot,secret,admin,common,parish,row} from "./helpers.mjs";

test("Authorization: absent/invalid/common/service-role JWT denied; active admin and dedicated service allowed",async()=>{
 const db=await database();try {
 const handler=createHandler(db.client,secret,deps());
 for(const [token,status] of [[null,401],["invalid",401],["common",403],["service_role_jwt",401]]) {
  const before=await snapshot(db.pg);const r=await handler(request(token));
  assert.equal(r.status,status);assert.deepEqual(await snapshot(db.pg),before);
 }
 const invalid=request("automatic");invalid.headers.set("x-vsc-sync-token","invalid");
 assert.equal((await handler(invalid)).status,401);
 assert.equal((await createHandler(db.client,"",deps())(request("automatic"))).status,401);
 for(const token of ["admin","automatic"]){const r=await handler(request(token));assert.equal(r.status,200);
  const p=await r.json();assert.equal(p.origin,token==="admin"?"manual":"automatic");assert.ok(!JSON.stringify(p).includes(secret));}
 await db.pg.query("update public.vsc_agenda_access set access_status='suspended' where user_id=$1",[admin]);
 assert.equal((await handler(request("admin"))).status,403);
 }finally{await db.close();}
});

test("Linker and all sync RPCs denied to PUBLIC/anon/authenticated; no SECURITY DEFINER; safe search_path",async()=>{
 const db=await database();try {
 await db.pg.exec("reset role");
 const funcs=await db.pg.query("select proname,prosecdef,proconfig,oid from pg_proc where pronamespace='public'::regnamespace and (proname like 'vsc_agenda_sync_%' or proname='vsc_agenda_link_events')");
 for(const f of funcs.rows){
  assert.equal(f.prosecdef,false);assert.ok(f.proconfig.includes("search_path=pg_catalog"));
  for(const role of ["anon","authenticated"]){
   const p=await db.pg.query("select has_function_privilege($1,$2,'EXECUTE') as allowed",[role,f.oid]);assert.equal(p.rows[0].allowed,false);
  }
 }
 for(const role of ["anon","authenticated"]){
  await db.pg.exec("set role "+role);
  await assert.rejects(db.pg.query("select public.vsc_agenda_link_events('test')"),/permission denied/);
  await assert.rejects(db.pg.query("select * from public.vsc_agenda_sync_runs"),/permission denied/);
  await db.pg.exec("reset role");
 }
 await db.pg.exec("set role service_role");
 assert.equal((await db.pg.query("select public.vsc_agenda_link_events('test') as n")).rows[0].n,0);
 const run=await db.client.rpc("vsc_agenda_sync_begin",{p_origin:"manual",p_actor:common});assert.match(run.error.message,/admin_required/);
 }finally{await db.close();}
});

test("Atomic upsert preserves stable IDs, valid links, old history and resolves Sagrado Coração",async()=>{
 const db=await database();try {
 await db.pg.query("insert into public.vsc_agenda_events(source_key,event_uid,title,starts_at,ends_at) values('test','history','Historical','2020-01-01','2020-01-01')");
 const r=await createHandler(db.client,secret,deps())(request("admin"));assert.equal(r.status,200);
 const events=await snapshot(db.pg);
 assert.equal(events.length,2);
 const current=events.find(e=>e.value.event_uid==="stable").value;
 assert.equal(current.parish_ref_id,parish);assert.equal(current.title,"Reunião");
 await db.pg.query("update public.vsc_agenda_events set parish_ref_id=null,title='Sagrado Coração',location='Janaúba' where event_uid='stable'");
 await db.pg.query("select public.vsc_agenda_link_events('test')");
 assert.equal((await snapshot(db.pg)).find(e=>e.value.event_uid==="stable").value.parish_ref_id,parish);
 }finally{await db.close();}
});

test("Write failure after event writes rolls back ALL rows, links, source timestamp; failure history survives",async()=>{
 const db=await database();try {
 const before=await snapshot(db.pg);
 await db.pg.exec(`reset role; create function public.test_failure() returns trigger language plpgsql as $$
 begin if NEW.last_status=200 then raise exception 'simulated storage failure';end if;return NEW;end $$;
 create trigger test_failure before update on public.vsc_agenda_sources for each row execute function public.test_failure(); set role service_role;`);
 const r=await createHandler(db.client,secret,deps())(request("admin"));
 assert.equal(r.status,207);assert.deepEqual(await snapshot(db.pg),before);
 const state=(await db.pg.query("select * from public.vsc_agenda_sync_source_health")).rows[0];
 assert.equal(state.last_attempt_status,"failed");assert.equal(state.error_code,"database_failed");
 assert.equal(state.last_success_at.toISOString(),"2026-10-08T00:00:00.000Z");
 assert.equal((await db.pg.query("select status from public.vsc_agenda_sync_runs")).rows[0].status,"failed");
 }finally{await db.close();}
});

test("Empty, truncated, invalid 200, missing SUMMARY, invalid dates and empty window preserve old data",async()=>{
 const db=await database();try {
 const before=await snapshot(db.pg);
 const bodies=["","<html>Google error</html>","BEGIN:VCALENDAR\nVERSION:2.0\nEND:VCALENDAR",
   deps().fetcher ? "BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nUID:x\nEND:VCALENDAR":"",
   "BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nUID:x\nDTSTART:20260230T130000Z\nSUMMARY:Invalid\nEND:VEVENT\nEND:VCALENDAR",
   "BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nUID:x\nDTSTART:20200101T130000Z\nSUMMARY:Old\nEND:VEVENT\nEND:VCALENDAR"];
 for(const text of bodies){const r=await createHandler(db.client,secret,deps(text))(request("admin"));
  assert.equal(r.status,207);assert.deepEqual(await snapshot(db.pg),before);}
 }finally{await db.close();}
});

test("Concurrent manual and automatic invocation: exactly one runs and other returns 409",async()=>{
 const db=await database();try {
 let loaded;const started=new Promise(r=>loaded=r);let release;const gate=new Promise(r=>release=r);
 const d=deps();const fetcher=d.fetcher;d.fetcher=async(...args)=>{loaded();await gate;return fetcher(...args);};
 const first=createHandler(db.client,secret,d)(request("admin"));await started;
 const second=await createHandler(db.client,secret,deps())(request("automatic"));assert.equal(second.status,409);
 release();assert.equal((await first).status,200);
 assert.equal((await db.pg.query("select count(*)::integer as n from public.vsc_agenda_sync_runs")).rows[0].n,1);
 }finally{await db.close();}
});

test("Expired lease fencing rejects old writer and admits a new service run",async()=>{
 const db=await database();try {
 const first=(await db.client.rpc("vsc_agenda_sync_begin",{p_origin:"manual",p_actor:admin})).data;
 await db.client.rpc("vsc_agenda_sync_source_begin",{p_run:first,p_source:"test"});
 await db.pg.exec("update public.vsc_agenda_sync_lease set expires_at=clock_timestamp()-interval '1 second'");
 const second=(await db.client.rpc("vsc_agenda_sync_begin",{p_origin:"automatic",p_actor:null})).data;
 assert.notEqual(first,second);
 const before=await snapshot(db.pg);
 const write=await db.client.rpc("vsc_agenda_sync_replace",{p_run:first,p_source:"test",p_events:[row()],
  p_min:"2026-01-01",p_max:"2027-01-01",p_duration:1,p_calendar:"fixture.invalid"});
 assert.match(write.error.message,/lease_lost/);assert.deepEqual(await snapshot(db.pg),before);
 assert.equal((await db.pg.query("select status from public.vsc_agenda_sync_runs where id=$1",[first])).rows[0].status,"expired");
 }finally{await db.close();}
});

test("RPC rejects null snapshots and duplicates before modifying existing events",async()=>{
 const db=await database();try {
 const run=(await db.client.rpc("vsc_agenda_sync_begin",{p_origin:"automatic",p_actor:null})).data;
 await db.client.rpc("vsc_agenda_sync_source_begin",{p_run:run,p_source:"test"});
 const before=await snapshot(db.pg);
 for(const rows of [null,[],[row(),row()],[row({ends_at:"2026-01-01"})]]){
  const write=await db.client.rpc("vsc_agenda_sync_replace",{p_run:run,p_source:"test",p_events:rows,
    p_min:"2026-01-01",p_max:"2027-01-01",p_duration:1,p_calendar:"fixture.invalid"});assert.ok(write.error);assert.deepEqual(await snapshot(db.pg),before);
 }
 }finally{await db.close();}
});

test("Moved recurrence retains institutional link using original occurrence identity",async()=>{
 const db=await database();try {
 await db.pg.query("update public.vsc_agenda_events set occurrence_key=$1 where event_uid='stable'",[row().occurrence_key]);
 const run=(await db.client.rpc("vsc_agenda_sync_begin",{p_origin:"automatic",p_actor:null})).data;
 await db.client.rpc("vsc_agenda_sync_source_begin",{p_run:run,p_source:"test"});
 const write=await db.client.rpc("vsc_agenda_sync_replace",{p_run:run,p_source:"test",
   p_events:[row({starts_at:"2026-10-10T13:00:00Z",ends_at:"2026-10-10T14:00:00Z"})],
   p_min:"2026-01-01",p_max:"2027-01-01",p_duration:1,p_calendar:"fixture.invalid"});assert.equal(write.error,null);
 const after=await snapshot(db.pg);assert.equal(after.length,1);assert.equal(after[0].value.parish_ref_id,parish);
 }finally{await db.close();}
});
