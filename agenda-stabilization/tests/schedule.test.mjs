import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {createHandler} from "../functions/vsc-agenda-sync/core.mjs";
import {database,request,deps,secret,now} from "./helpers.mjs";

test("Prepared workflow is outside active workflow directory, schedule disabled, concurrency and server secrets only",async()=>{
 const yaml=await readFile(new URL("../proposals/agenda-sync-DISABLED.yml",import.meta.url),"utf8");
 const active=yaml.split("\n").filter(l=>!l.trim().startsWith("#")).join("\n");
 assert.doesNotMatch(active,/schedule:/);assert.match(yaml,/'17 \* \* \* \*'/);
 assert.match(active,/cancel-in-progress: false/);assert.match(active,/permissions: \{\}/);
 assert.match(active,/environment: agenda-homologacao/);assert.match(active,/secrets.VSC_AGENDA_SYNC_TOKEN/);
 assert.doesNotMatch(active,/SUPABASE_SERVICE_ROLE_KEY/);
});
test("24 simulated hourly service invocations succeed and maintain isolated event links and history",async()=>{
 const db=await database();try{
 for(let h=0;h<24;h++){
  const d=deps();d.now=()=>now()+h*3600000;
  const result=await createHandler(db.client,secret,d)(request("automatic"));assert.equal(result.status,200);
 }
 const runs=(await db.pg.query("select origin,status,count(*)::integer as n from public.vsc_agenda_sync_runs group by origin,status")).rows;
 assert.deepEqual(runs,[{origin:"automatic",status:"success",n:24}]);
 const counts=(await db.pg.query("select count(*)::integer as n from public.vsc_agenda_events where parish_ref_id is not null")).rows;
 assert.equal(counts[0].n,1);
 assert.equal((await db.pg.query("select count(*)::integer as n from public.vsc_agenda_sync_results where status='success'")).rows[0].n,24);
 }finally{await db.close();}
});
