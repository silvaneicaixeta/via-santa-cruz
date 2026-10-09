import test from "node:test";
import assert from "node:assert/strict";
import {parseCalendar,downloadCalendar,retryAfter,createHandler} from "../functions/vsc-agenda-sync/core.mjs";
import {ics,event,now,database,snapshot,request,secret,deps} from "./helpers.mjs";
const source={source_key:"test",calendar_id:"fixture.invalid"};
const min=Date.parse("2025-01-01"),max=Date.parse("2028-01-01");
const parse=text=>parseCalendar(text,source,min,max);

test("429 Retry-After seconds and HTTP date are respected; exponential fallback bounded",async()=>{
 let time=now(),count=0;const waits=[];
 const result=await downloadCalendar(source,{now:()=>time,random:()=>0,sleep:async ms=>{waits.push(ms);time+=ms;},
  fetcher:async()=>++count<3?new Response("",{status:429,headers:{"Retry-After":count===1?"2":new Date(time+3000).toUTCString()}}):new Response(ics([event()]))});
 assert.deepEqual(waits,[2000,3000]);assert.equal(result.attempts,3);
 assert.equal(retryAfter("nonsense",time),null);
 const fallback=[];let t=0,c=0;
 await downloadCalendar(source,{now:()=>t,random:()=>0,sleep:async ms=>{fallback.push(ms);t+=ms;},
  fetcher:async()=>++c<3?new Response("",{status:503}):new Response(ics([event()]))});
 assert.deepEqual(fallback,[1000,2000]);
});

test("Long Retry-After defers without retrying early; repeated 429 preserves existing rows",async()=>{
 let calls=0;
 await assert.rejects(downloadCalendar(source,{now:()=>0,deadline:110000,fetcher:async()=>{calls++;return new Response("",{status:429,headers:{"Retry-After":"300"}});}}),
  e=>e.code==="rate_limited_deferred");
 assert.equal(calls,1);
 const db=await database();try {
 const before=await snapshot(db.pg);const d=deps();d.fetcher=async()=>new Response("",{status:429});
 const response=await createHandler(db.client,secret,d)(request("automatic"));assert.equal(response.status,207);
 assert.deepEqual(await snapshot(db.pg),before);
 const health=(await db.pg.query("select * from public.vsc_agenda_sync_source_health")).rows[0];
 assert.equal(health.http_status,429);assert.equal(health.last_success_at.toISOString(),"2026-10-08T00:00:00.000Z");
 }finally{await db.close();}
});

test("Daily, weekly, monthly, yearly recurrence; EXDATE, RDATE, COUNT, UNTIL",()=>{
 const daily=parse(ics([event(["RRULE:FREQ=DAILY;COUNT=4","EXDATE:20261010T130000Z","RDATE:20261020T130000Z"])]));
 assert.deepEqual(daily.map(x=>x.starts_at.slice(0,10)),["2026-10-09","2026-10-11","2026-10-12","2026-10-20"]);
 const weekly=parse(ics([event(["RRULE:FREQ=WEEKLY;COUNT=3;BYDAY=FR"])]));assert.equal(weekly.length,3);
 const monthly=parse(ics([event(["RRULE:FREQ=MONTHLY;COUNT=3"])]));assert.equal(monthly.length,3);
 const yearly=parse(ics([event(["RRULE:FREQ=YEARLY;UNTIL=20271009T130000Z"])]));assert.equal(yearly.length,2);
 assert.ok(yearly.every(x=>x.event_uid==="stable"));
});

test("Moved/cancelled recurrence exceptions replace original occurrence; original identity retained",()=>{
 const exception=["BEGIN:VEVENT","UID:stable","RECURRENCE-ID:20261010T130000Z","DTSTART:20261010T150000Z",
  "DTEND:20261010T160000Z","SUMMARY:🚫 Cancelado","STATUS:CANCELLED","END:VEVENT"].join("\n");
 const rows=parse(ics([event(["RRULE:FREQ=DAILY;COUNT=3"]),exception]));
 assert.equal(rows.length,3);const moved=rows[1];
 assert.equal(moved.starts_at,"2026-10-10T15:00:00.000Z");assert.equal(moved.occurrence_key,"2026-10-10T13:00:00.000Z");
 assert.equal(moved.cancelled,true);
});

test("RANGE=THISANDFUTURE shifts subsequent instances correctly",()=>{
 const exception=["BEGIN:VEVENT","UID:stable","RECURRENCE-ID;RANGE=THISANDFUTURE:20261010T130000Z",
  "DTSTART:20261010T150000Z","DTEND:20261010T160000Z","SUMMARY:Alterado","END:VEVENT"].join("\n");
 const rows=parse(ics([event(["RRULE:FREQ=DAILY;COUNT=3"]),exception]));
 assert.deepEqual(rows.map(x=>x.starts_at.slice(11,16)),["13:00","15:00","15:00"]);
});

test("Date-only, floating Brazil time, IANA DST and leap day remain correct",()=>{
 const allDay=["BEGIN:VEVENT","UID:date","DTSTART;VALUE=DATE:20261009","DTEND;VALUE=DATE:20261010","SUMMARY:Festa","END:VEVENT"].join("\n");
 const date=parse(ics([allDay]))[0];assert.equal(date.starts_at,"2026-10-09T03:00:00.000Z");
 assert.equal(date.ends_at,"2026-10-10T03:00:00.000Z");assert.equal(date.all_day,true);
 const tz=["BEGIN:VEVENT","UID:dst","DTSTART;TZID=America/New_York:20261030T090000",
 "DTEND;TZID=America/New_York:20261030T100000","SUMMARY:DST","RRULE:FREQ=DAILY;COUNT=5","END:VEVENT"].join("\n");
 const rows=parse(ics([tz]));assert.equal(rows[0].starts_at.slice(11,16),"13:00");assert.equal(rows[2].starts_at.slice(11,16),"14:00");
 const leap=["BEGIN:VEVENT","UID:leap","DTSTART;VALUE=DATE:20240229","DTEND;VALUE=DATE:20240301","SUMMARY:Leap","RRULE:FREQ=YEARLY;COUNT=2","END:VEVENT"].join("\n");
 const expanded=parseCalendar(ics([leap]),source,Date.parse("2024-01-01"),Date.parse("2029-01-01"));
 assert.deepEqual(expanded.map(x=>x.starts_at.slice(0,10)),["2024-02-29","2028-02-29"]);
});

test("Bishop absence remains distinct from actual cancellation; invalid/unknown zones fail closed",()=>{
 assert.throws(()=>parse(ics([event(["SUMMARY:⚠️ Visita"])])),/duplicate_property/);
 const absent=parse(ics([event().replace("SUMMARY:Reunião","SUMMARY:⚠️ Visita")]))[0];
 assert.equal(absent.bishop_absent,true);assert.equal(absent.cancelled,false);assert.equal(absent.title,"Visita");
 const canceled=parse(ics([event().replace("SUMMARY:Reunião","SUMMARY:🚫 Visita")]))[0];
 assert.equal(canceled.cancelled,true);assert.equal(canceled.bishop_absent,false);
 assert.throws(()=>parse(ics([event().replace("DTSTART:20261009T130000Z","DTSTART;TZID=Unknown/Zone:20261009T130000")])),/unknown_timezone/);
});
