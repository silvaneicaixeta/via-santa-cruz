import {PGlite} from "pglite-pg17";
import {readFile} from "node:fs/promises";
export const admin="00000000-0000-4000-8000-000000000001";
export const common="00000000-0000-4000-8000-000000000002";
export const parish="00000000-0000-4000-8000-000000000003";
export const secret="test-only-"+ "x".repeat(48);
export const now=()=>Date.parse("2026-10-09T12:00:00Z");
export const ics=(events)=>"BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//Isolated tests//EN\n"+events.join("\n")+"\nEND:VCALENDAR";
export const event=(props=[])=>["BEGIN:VEVENT","UID:stable","DTSTART:20261009T130000Z","DTEND:20261009T140000Z","SUMMARY:Reunião",...props,"END:VEVENT"].join("\n");
export const row=(extra={})=>({source_key:"test",event_uid:"stable",title:"Reunião",raw_title:"Reunião",
 starts_at:"2026-10-09T13:00:00.000Z",ends_at:"2026-10-09T14:00:00.000Z",all_day:false,
 cancelled:false,bishop_absent:false,occurrence_key:"2026-10-09T13:00:00.000Z",...extra});
export async function database() {
 const pg=new PGlite();
 for(const name of ["tests/bootstrap.sql","sql/01-stabilization.sql","sql/02-observability.sql"])
   await pg.exec(await readFile(new URL("../"+name,import.meta.url),"utf8"));
 await pg.exec(`insert into auth.users values('${admin}'),('${common}');
 insert into public.vsc_agenda_access(user_id,display_name,role,must_change_password)
 values('${admin}','Isolated Admin','admin',false),('${common}','Isolated User','collaborator',false);
 insert into public.vsc_agenda_sources(source_key,label,calendar_id,source_group,category,last_synced_at,last_status)
 values('test','Synthetic Calendar','fixture.invalid','main','diocese','2026-10-08T00:00:00Z',200);
 insert into public.vsc_agenda_parishes(id,canonical_name,city) values('${parish}','Sagrado Coração de Jesus','Janaúba');
 insert into public.vsc_agenda_parish_aliases(parish_id,alias_name,alias_city,alias_key)
 values('${parish}','Sagrado Coração','Janaúba','synthetic_alias');
 insert into public.vsc_agenda_events(source_key,event_uid,title,starts_at,ends_at,parish_ref_id)
 values('test','stable','Anterior','2026-10-09T13:00:00Z','2026-10-09T14:00:00Z','${parish}');
 set role service_role;`);
 const client={
   auth:{getUser:async token=>({data:{user:token==="admin"?{id:admin}:token==="common"?{id:common}:null},
     error:["admin","common"].includes(token)?null:{message:"invalid"}})},
   rpc:async(name,args)=>{
     if(!/^vsc_agenda_sync_/.test(name))throw new Error("Unexpected test RPC");
     const keys=Object.keys(args);const values=Object.values(args).map(x=>Array.isArray(x)?JSON.stringify(x):x);
     try {const result=await pg.query("select public."+name+"("+keys.map((k,i)=>k+" => $"+(i+1)).join(",")+") as value",values);
       return {data:result.rows[0].value,error:null};}catch(error){return {data:null,error};}
   },
   from:table=>{
     let filters=[];let selection="";
     const q={select(cols){selection=cols;return q;},eq(k,v){filters.push([k,v]);return q;},
       async maybeSingle(){const rows=await query();return {data:rows[0]||null,error:null};},
       async order(){return {data:await query(),error:null};}};
     async function query(){if(!["vsc_agenda_access","vsc_agenda_sources"].includes(table))throw new Error("Unexpected test table");
       const safe=selection.split(",");if(safe.some(s=>!/^[a-z_]+$/.test(s)))throw new Error("Invalid selection");
       return (await pg.query("select "+safe.join(",")+" from public."+table+" where "+
         filters.map(([k],i)=>k+"=$"+(i+1)).join(" and ")+" order by 1",filters.map(([,v])=>v))).rows;}
     return q;
   }
 };
 return {pg,client,close:()=>pg.close()};
}
export const request=(token="admin",body={})=>new Request("https://isolated.invalid/sync",{method:"POST",
 headers:{"Content-Type":"application/json",...(token==="automatic"?{"x-vsc-sync-token":secret}:token?{Authorization:"Bearer "+token}:{})},
 body:JSON.stringify(body)});
export const deps=(text=ics([event()]))=>({now,sleep:async()=>{},random:()=>0,
 fetcher:async()=>new Response(text,{headers:{"Content-Type":"text/calendar"}})});
export async function snapshot(pg) {
 return (await pg.query("select to_jsonb(e) as value from public.vsc_agenda_events e order by source_key,event_uid,starts_at")).rows;
}
