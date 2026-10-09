import ICAL from "ical.js";

export class SyncError extends Error {
  constructor(code, status = 500, http = null) { super(code); this.code = code; this.status = status; this.http = http; }
}
const reject = (code, status = 422, http = null) => { throw new SyncError(code, status, http); };

async function secretEquals(a, b) {
  if (!a || !b || b.length < 32 || a.length > 256) return false;
  const hash = async s => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  const [x,y] = await Promise.all([hash(a),hash(b)]);
  let diff = 0; for (let i=0;i<x.length;i++) diff |= x[i] ^ y[i];
  return diff === 0;
}
export async function authorize(req, db, automaticSecret) {
  const service = req.headers.get("x-vsc-sync-token");
  if (service !== null) {
    if (!await secretEquals(service, automaticSecret)) reject("unauthorized",401);
    return {origin:"automatic",actor:null};
  }
  const token = /^Bearer (.+)$/i.exec(req.headers.get("authorization") || "")?.[1];
  if (!token) reject("unauthorized",401);
  const {data,error} = await db.auth.getUser(token);
  if (error || !data?.user || data.user.is_anonymous) reject("unauthorized",401);
  const access = await db.from("vsc_agenda_access").select("role,access_status").eq("user_id",data.user.id).maybeSingle();
  if (access.error) reject("authorization_unavailable",503);
  if (access.data?.role !== "admin" || access.data?.access_status !== "active") reject("forbidden",403);
  return {origin:"manual",actor:data.user.id};
}

export function retryAfter(value, now) {
  if (!value) return null;
  if (/^\d+$/.test(value.trim())) return Number(value)*1000;
  const date=Date.parse(value); return Number.isFinite(date) ? Math.max(0,date-now) : null;
}
export async function downloadCalendar(source, {
  fetcher=fetch, sleep=ms=>new Promise(r=>setTimeout(r,ms)), now=Date.now,
  deadline=now()+110000, signal, random=Math.random, timeoutMs=10000
}={}) {
  const url="https://calendar.google.com/calendar/ical/"+encodeURIComponent(source.calendar_id)+"/public/basic.ics";
  for(let attempt=0;attempt<3;attempt++) {
    if(now()+timeoutMs >= deadline) reject("deadline_exceeded",504);
    let response;
    try {
      response=await fetcher(url,{headers:{"User-Agent":"ViaSantaCruz-AgendaSync/2.0","Accept":"text/calendar"},
        signal: signal ? AbortSignal.any([signal,AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs), redirect:"error"});
    } catch { if (signal?.aborted) reject("deadline_exceeded",504); }
    const http=response?.status || null;
    if(response?.ok) {
      // Body read is bounded by the same timeout, with a strict size ceiling.
      const reader=response.body?.getReader(); if(!reader) reject("empty_calendar",422,http);
      const chunks=[];let size=0;
      try {
        for(;;) {const {done,value}=await reader.read();if(done)break;
          size+=value.byteLength;if(size>5*1024*1024){await reader.cancel();reject("calendar_too_large",422,http);}chunks.push(value);}
      } catch(e) { if(e instanceof SyncError)throw e;reject("download_incomplete",502,http); }
      const bytes=new Uint8Array(size);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.length;}
      let text;try {text=new TextDecoder("utf-8",{fatal:true}).decode(bytes);}
      catch {reject("invalid_encoding",422,http);}
      if(!text.trim()) reject("empty_calendar",422,http);
      return {text,http,attempts:attempt+1};
    }
    if(response && http !== 429 && !(http>=500 && http<=599)) reject("http_error",502,http);
    if(attempt===2) reject(http===429 ? "rate_limited" : "download_failed",502,http);
    const wait=Math.max(retryAfter(response?.headers.get("Retry-After"),now()) || 0, 1000*2**attempt+Math.floor(random()*250));
    // Never truncate Retry-After and retry early: defer the source if it exceeds this run's budget.
    if(now()+wait+timeoutMs >= deadline) reject(http===429 ? "rate_limited_deferred":"retry_deferred",503,http);
    await response?.body?.cancel(); await sleep(wait);
  }
}

function wallMillis(t, zone) {
  const stamp=Date.UTC(t.year,t.month-1,t.day,t.hour||0,t.minute||0,t.second||0);
  const formatter=new Intl.DateTimeFormat("en-CA",{timeZone:zone,year:"numeric",month:"2-digit",day:"2-digit",
    hour:"2-digit",minute:"2-digit",second:"2-digit",hourCycle:"h23"});
  let candidate=stamp;
  for(let i=0;i<4;i++) {
    const parts=Object.fromEntries(formatter.formatToParts(candidate).map(p=>[p.type,p.value]));
    const represented=Date.UTC(+parts.year,+parts.month-1,+parts.day,+parts.hour,+parts.minute,+parts.second);
    const delta=stamp-represented; if(delta===0)return candidate; candidate+=delta;
  }
  reject("nonexistent_local_time");
}
function timeMillis(t, fallback) {
  if(t.isDate || t.zone.tzid==="floating") return wallMillis(t,fallback);
  return t.toUnixTime()*1000;
}
function validDateProperty(p) {
  for(const raw of p.jCal[3] instanceof Array ? p.jCal[3] : p.jCal.slice(3)) {
    if(typeof raw!=="string") continue;
    const m=/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})Z?)?$/.exec(raw);
    if(!m) reject("invalid_date");
    const [year,month,day,hour,minute,second]=m.slice(1).map(x=>Number(x||0));
    const date=new Date(Date.UTC(year,month-1,day,hour,minute,second));
    if(year<1900 || year>2200 || date.getUTCFullYear()!==year || date.getUTCMonth()!==month-1 ||
       date.getUTCDate()!==day || hour>23 || minute>59 || second>59) reject("invalid_date");
  }
}
export function parseCalendar(text, source, min, max) {
  try {
    const normalized=text.replace(/^\uFEFF/,"").replace(/\r\n/g,"\n").trim();
    if(!normalized.startsWith("BEGIN:VCALENDAR\n") || !normalized.endsWith("\nEND:VCALENDAR")) reject("invalid_calendar");
    const begin=(normalized.match(/^BEGIN:VEVENT$/gm)||[]).length;
    if(!begin || begin!==(normalized.match(/^END:VEVENT$/gm)||[]).length) reject("invalid_calendar");
    const root=new ICAL.Component(ICAL.parse(normalized));
    if(root.name!=="vcalendar" || root.getFirstPropertyValue("version")!=="2.0") reject("invalid_calendar");
    const components=root.getAllSubcomponents("vevent");
    if(components.length!==begin) reject("invalid_calendar");
    const fallback=String(root.getFirstPropertyValue("x-wr-timezone")||"America/Sao_Paulo");
    new Intl.DateTimeFormat("en",{timeZone:fallback}); // Unknown zones fail closed.
    // Bind IANA zones omitted from VTIMEZONE to this calendar only; never global mutable state.
    const original=root.getTimeZoneByID.bind(root);
    root.getTimeZoneByID=id=>{
      const embedded=original(id);if(embedded)return embedded;
      try {new Intl.DateTimeFormat("en",{timeZone:id});} catch {reject("unknown_timezone");}
      const zone=new ICAL.Timezone({tzid:id});
      zone.utcOffset=t=>(Date.UTC(t.year,t.month-1,t.day,t.hour,t.minute,t.second)-wallMillis(t,id))/1000;
      return zone;
    };
    const masters=new Map(),exceptions=[],keys=new Set();
    for(const c of components) {
      for(const name of ["uid","dtstart","dtend","summary","recurrence-id","duration","status"])
        if(c.getAllProperties(name).length>1)reject("duplicate_property");
      if(c.hasProperty("dtend") && c.hasProperty("duration"))reject("invalid_event");
      if(!c.getFirstPropertyValue("uid") || !c.hasProperty("dtstart")) reject("invalid_event");
      for(const name of ["dtstart","dtend","recurrence-id","exdate","rdate"])
        for(const p of c.getAllProperties(name)) validDateProperty(p);
      if(c.hasProperty("exrule") || c.getAllProperties("rrule").length>1) reject("unsupported_recurrence");
      const e=new ICAL.Event(c,{strictExceptions:true,exceptions:[]});
      if(e.isRecurrenceException())exceptions.push(e);
      else {if(masters.has(e.uid))reject("duplicate_master");masters.set(e.uid,e);}
    }
    for(const e of exceptions) {
      const master=masters.get(e.uid);if(!master)reject("orphan_exception");
      const key=e.uid+"|"+e.recurrenceId.toString();if(keys.has(key))reject("duplicate_exception");
      keys.add(key);master.relateException(e);
    }
    const rows=[],identities=new Set();
    function emit(item,start,end,recurrence) {
      const from=timeMillis(start,fallback),to=timeMillis(end,fallback);
      if(!Number.isFinite(from)||!Number.isFinite(to)||to<from)reject("invalid_date");
      const raw=String(item.summary||"").trim();if(!raw)reject("missing_summary");
      if(from<min||from>max)return;
      const title=raw.replace(/^🚫\s*/,"").replace(/^⚠️?\s*/,"").trim();
      if(!title)reject("missing_summary");
      const row={source_key:source.source_key,event_uid:item.uid,title,raw_title:raw,
        starts_at:new Date(from).toISOString(),ends_at:new Date(to).toISOString(),all_day:start.isDate,
        location:item.location||null,description:item.description||null,
        cancelled:item.component.getFirstPropertyValue("status")==="CANCELLED"||/^🚫/.test(raw),
        bishop_absent:/^⚠️?/.test(raw),occurrence_key:new Date(timeMillis(recurrence,fallback)).toISOString()};
      const key=row.event_uid+"|"+row.starts_at;if(identities.has(key))reject("duplicate_event");
      identities.add(key);rows.push(row);if(rows.length>20000)reject("expansion_limit");
    }
    for(const e of masters.values()) {
      if(!e.isRecurring()) {emit(e,e.startDate,e.endDate,e.startDate);continue;}
      const rule=e.component.getFirstPropertyValue("rrule");
      // ICAL.js 2.2.1 normalizes implicit yearly Feb 29 to Mar 1. Make the
      // RFC 5545 implicit month/day explicit so invalid years are skipped.
      if(rule?.freq==="YEARLY" && e.startDate.month===2 && e.startDate.day===29 &&
        !["BYMONTH","BYMONTHDAY","BYYEARDAY","BYWEEKNO","BYDAY"].some(k=>rule.parts[k])) {
        rule.setComponent("BYMONTH",[2]);rule.setComponent("BYMONTHDAY",[29]);
      }
      const iterator=e.iterator();let n=0,next;
      while((next=iterator.next())) {
        if(++n>100000)reject("expansion_limit");
        // RANGE exceptions may move future instances backwards; retain a safe bounded horizon.
        if(timeMillis(next,fallback)>max+366*86400000)break;
        const d=e.getOccurrenceDetails(next);emit(d.item,d.startDate,d.endDate,d.recurrenceId);
      }
    }
    if(!rows.length)reject("empty_snapshot");
    return rows;
  } catch(e) { if(e instanceof SyncError)throw e; reject("invalid_calendar"); }
}

async function rpc(db,name,args) {
  const {data,error}=await db.rpc(name,args);
  if(error) {
    const code=["sync_busy","lease_lost","source_changed","snapshot_drop_guard","invalid_snapshot","invalid_event","duplicate_event","admin_required"]
      .find(c=>error.message?.includes(c)) || "database_failed";
    throw new SyncError(code,code==="sync_busy"?409:500);
  }
  return data;
}
export async function synchronize(db,identity,requestedSource="",deps={}) {
  const now=deps.now||Date.now, started=now(),deadline=started+110000;
  const min=started-400*86400000,max=started+730*86400000;
  const run=await rpc(db,"vsc_agenda_sync_begin",{p_origin:identity.origin,p_actor:identity.actor});
  const results=[];let fatal=null;
  try {
    let query=db.from("vsc_agenda_sources").select("source_key,calendar_id").eq("enabled",true);
    if(requestedSource)query=query.eq("source_key",requestedSource);
    const sources=await query.order("source_key");
    if(sources.error)reject("source_read_failed");
    if(!sources.data?.length)reject("source_not_found",404);
    for(const [index,source] of sources.data.entries()) {
      const sourceStart=now();
      // Reserve each remaining source a fair share, including the inter-source pause.
      // An early rate-limited calendar cannot consume the whole run on every hour.
      const remaining=sources.data.length-index;
      const sourceDeadline=sourceStart+Math.max(0,(deadline-sourceStart-800*remaining)/remaining);
      let receivedHttp=null;
      await rpc(db,"vsc_agenda_sync_source_begin",{p_run:run,p_source:source.source_key});
      try {
        const loaded=await downloadCalendar(source,{...deps,now,deadline:sourceDeadline});
        receivedHttp=loaded.http;
        const events=parseCalendar(loaded.text,source,min,max);
        const count=await rpc(db,"vsc_agenda_sync_replace",{p_run:run,p_source:source.source_key,
          p_events:events,p_min:new Date(min).toISOString(),p_max:new Date(max).toISOString(),
          p_duration:now()-sourceStart,p_calendar:source.calendar_id});
        results.push({source:source.source_key,ok:true,status:200,count});
      } catch(e) {
        const safe=e instanceof SyncError?e:new SyncError("unexpected_failure");
        await rpc(db,"vsc_agenda_sync_source_fail",{p_run:run,p_source:source.source_key,p_code:safe.code,
          p_http:safe.http||receivedHttp,p_duration:Math.max(0,now()-sourceStart)});
        results.push({source:source.source_key,ok:false,status:safe.http||safe.status,count:0,error:safe.code});
      }
      if(deps.sleep)await deps.sleep(800);else await new Promise(r=>setTimeout(r,800));
    }
  } catch(e) {fatal=e instanceof SyncError?e:new SyncError("unexpected_failure");}
  const status=await rpc(db,"vsc_agenda_sync_finish",{p_run:run,p_error:fatal?.code||null});
  if(fatal)throw fatal;
  const successful=results.some(r=>r.ok);
  return {ok:status==="success",run_id:run,origin:identity.origin,status,results,
    // Compatibility field means a committed update, never just an attempt.
    synced_at:successful?new Date(now()).toISOString():null,attempted_at:new Date(started).toISOString()};
}
export function createHandler(db,automaticSecret,deps={}) {
  return async req=>{
    try {
      if(req.method!=="POST")reject("method_not_allowed",405);
      const identity=await authorize(req,db,automaticSecret);
      let body;try {body=await req.json();}catch {reject("invalid_json",400);}
      if(!body||typeof body!=="object"||Array.isArray(body) ||
        (body.source_key!==undefined && (typeof body.source_key!=="string" || !/^[a-z0-9-]{1,64}$/.test(body.source_key))))
        reject("invalid_source",400);
      const payload=await synchronize(db,identity,body.source_key||"",deps);
      return Response.json(payload,{status:payload.ok?200:207,headers:{"Cache-Control":"no-store"}});
    } catch(e) {
      const safe=e instanceof SyncError?e:new SyncError("unexpected_failure");
      return Response.json({error:safe.code},{status:safe.status,headers:{"Cache-Control":"no-store"}});
    }
  };
}
