import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {database,snapshot} from "./helpers.mjs";
test("Rollback containment retains rows and restrictive linker ACLs; maintenance handler has no DB/calendar access",async()=>{
 const db=await database();try{
 const before=await snapshot(db.pg);await db.pg.exec("reset role");
 await db.pg.exec(await readFile(new URL("../sql/04-rollback-security.sql",import.meta.url),"utf8"));
 await db.pg.exec("set role service_role");assert.deepEqual(await snapshot(db.pg),before);
 await db.pg.exec("reset role;set role authenticated");
 await assert.rejects(db.pg.query("select public.vsc_agenda_link_events('test')"),/permission denied/);
 const code=await readFile(new URL("../rollback/vsc-agenda-sync/index.ts",import.meta.url),"utf8");
 assert.match(code,/status:503/);assert.doesNotMatch(code,/createClient|fetch\(/);
 }finally{await db.close();}
});
