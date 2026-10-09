import test from "node:test";
import assert from "node:assert/strict";
import {database,snapshot,row} from "./helpers.mjs";
async function start(db){
 const run=(await db.client.rpc("vsc_agenda_sync_begin",{p_origin:"automatic",p_actor:null})).data;
 await db.client.rpc("vsc_agenda_sync_source_begin",{p_run:run,p_source:"test"});return run;
}
const args=(run,events,extra={})=>({p_run:run,p_source:"test",p_events:events,
 p_min:"2026-01-01",p_max:"2027-01-01",p_duration:1,p_calendar:"fixture.invalid",...extra});
test("Source configuration changes and large snapshot shrinkage abort before any event write",async()=>{
 const db=await database();try{
 const run=await start(db),before=await snapshot(db.pg);
 let result=await db.client.rpc("vsc_agenda_sync_replace",args(run,[row()],{p_calendar:"different.invalid"}));
 assert.match(result.error.message,/source_changed/);assert.deepEqual(await snapshot(db.pg),before);
 for(let i=0;i<10;i++)await db.pg.query("insert into public.vsc_agenda_events(source_key,event_uid,title,starts_at,ends_at) values('test',$1,'Synthetic','2026-10-10T12:00Z','2026-10-10T13:00Z')",["old-"+i]);
 const full=await snapshot(db.pg);
 result=await db.client.rpc("vsc_agenda_sync_replace",args(run,[row()]));
 assert.match(result.error.message,/snapshot_drop_guard/);assert.deepEqual(await snapshot(db.pg),full);
 }finally{await db.close();}
});
test("Unmapped pre-migration institutional links are retained for review rather than silently deleted",async()=>{
 const db=await database();try{
 const run=await start(db);
 const result=await db.client.rpc("vsc_agenda_sync_replace",args(run,[row({event_uid:"new-id"})]));
 assert.equal(result.error,null);
 const rows=await snapshot(db.pg);assert.equal(rows.length,2);
 assert.ok(rows.find(r=>r.value.event_uid==="stable").value.parish_ref_id);
 assert.equal((await db.pg.query("select legacy_links_retained from public.vsc_agenda_sync_results")).rows[0].legacy_links_retained,1);
 }finally{await db.close();}
});
