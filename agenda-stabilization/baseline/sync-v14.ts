import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

type Source = {
  source_key: string;
  label: string;
  calendar_id: string;
  source_group: "main" | "special";
  category: string;
};

function unfoldIcs(text: string) {
  return text.replace(/\r\n[ \t]/g, "").replace(/\n[ \t]/g, "").split(/\r?\n/);
}

function unescapeIcs(value: string) {
  return value
    .replace(/\\n/gi, "\n")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\")
    .trim();
}

function parseDateValue(raw: string, params = ""): { iso: string; allDay: boolean } | null {
  const value = raw.trim();
  const allDay = /VALUE=DATE/i.test(params) || /^\d{8}$/.test(value);

  if (allDay) {
    if (!/^\d{8}$/.test(value)) return null;
    const y = value.slice(0, 4), m = value.slice(4, 6), d = value.slice(6, 8);
    return { iso: `${y}-${m}-${d}T00:00:00-03:00`, allDay: true };
  }

  const m = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s = "00", z] = m;
  if (z) return { iso: `${y}-${mo}-${d}T${h}:${mi}:${s}Z`, allDay: false };
  return { iso: `${y}-${mo}-${d}T${h}:${mi}:${s}-03:00`, allDay: false };
}

function parseIcs(text: string, source: Source) {
  const lines = unfoldIcs(text);
  const events: any[] = [];
  let current: Record<string, any> | null = null;

  for (const line of lines) {
    if (line === "BEGIN:VEVENT") {
      current = {};
      continue;
    }

    if (line === "END:VEVENT") {
      if (current?.summary && current?.start) {
        const rawTitle = String(current.summary);
        const bishopAbsent = /^⚠️?\s*/.test(rawTitle);
        const cleanTitle = rawTitle
          .replace(/^🚫\s*/, "")
          .replace(/^⚠️?\s*/, "")
          .trim();

        events.push({
          source_key: source.source_key,
          event_uid: current.uid || `${source.source_key}-${current.start}-${cleanTitle}`,
          title: cleanTitle,
          raw_title: rawTitle,
          starts_at: current.start,
          ends_at: current.end || current.start,
          all_day: Boolean(current.allDay),
          location: current.location || null,
          description: current.description || null,
          cancelled: current.status === "CANCELLED" || /^🚫/.test(rawTitle),
          bishop_absent: bishopAbsent,
          synced_at: new Date().toISOString(),
          _rrule: current.rrule || null,
          _recurrence_id: current.recurrenceId || null,
        });
      }
      current = null;
      continue;
    }

    if (!current) continue;
    const idx = line.indexOf(":");
    if (idx < 0) continue;

    const left = line.slice(0, idx);
    const value = line.slice(idx + 1);
    const [name, ...paramParts] = left.split(";");
    const params = paramParts.join(";");

    switch (name.toUpperCase()) {
      case "UID": current.uid = unescapeIcs(value); break;
      case "SUMMARY": current.summary = unescapeIcs(value); break;
      case "LOCATION": current.location = unescapeIcs(value); break;
      case "DESCRIPTION": current.description = unescapeIcs(value); break;
      case "STATUS": current.status = value.trim().toUpperCase(); break;
      case "RRULE": current.rrule = value.trim(); break;
      case "RECURRENCE-ID": {
        const parsed = parseDateValue(value, params);
        if (parsed) current.recurrenceId = parsed.iso;
        break;
      }
      case "DTSTART": {
        const parsed = parseDateValue(value, params);
        if (parsed) {
          current.start = parsed.iso;
          current.allDay = parsed.allDay;
        }
        break;
      }
      case "DTEND": {
        const parsed = parseDateValue(value, params);
        if (parsed) current.end = parsed.iso;
        break;
      }
    }
  }

  return events;
}

function parseUntil(rule: string | null) {
  if (!rule) return null;
  const match = rule.match(/(?:^|;)UNTIL=([^;]+)/i);
  if (!match) return null;
  const raw = match[1];
  if (/^\d{8}$/.test(raw)) {
    const y = raw.slice(0,4), m = raw.slice(4,6), d = raw.slice(6,8);
    return Date.parse(`${y}-${m}-${d}T23:59:59Z`);
  }
  const parsed = parseDateValue(raw);
  return parsed ? Date.parse(parsed.iso) : null;
}

function replaceYear(iso: string, year: number) {
  return iso.replace(/^\d{4}/, String(year).padStart(4, "0"));
}

function expandYearlyRecurrences(events: any[], min: number, max: number) {
  const expanded: any[] = [];
  const minYear = new Date(min).getUTCFullYear() - 1;
  const maxYear = new Date(max).getUTCFullYear() + 1;

  for (const event of events) {
    const rule = String(event._rrule || "");
    if (!/FREQ=YEARLY/i.test(rule)) {
      expanded.push(event);
      continue;
    }

    const baseStart = Date.parse(event.starts_at);
    const baseEnd = Date.parse(event.ends_at);
    if (!Number.isFinite(baseStart) || !Number.isFinite(baseEnd)) continue;

    const until = parseUntil(rule);
    const baseYear = Number(event.starts_at.slice(0,4));

    for (let year = Math.max(baseYear, minYear); year <= maxYear; year++) {
      const startIso = replaceYear(event.starts_at, year);
      const startMs = Date.parse(startIso);
      if (!Number.isFinite(startMs)) continue;

      // Evita normalizações inválidas de datas como 29/02 em ano não bissexto.
      if (startIso.slice(5,10) !== new Date(startMs).toISOString().slice(5,10) && event.all_day) continue;
      if (until !== null && startMs > until) continue;

      const duration = Math.max(0, baseEnd - baseStart);
      const endMs = startMs + duration;

      expanded.push({
        ...event,
        starts_at: startIso,
        ends_at: new Date(endMs).toISOString(),
        synced_at: new Date().toISOString(),
      });
    }
  }

  // Instâncias explícitas/exceções prevalecem sobre a expansão do evento mestre.
  const deduped = new Map<string, any>();
  for (const event of expanded) {
    const key = `${event.source_key}|${event.event_uid}|${event.starts_at}`;
    const clean = { ...event };
    delete clean._rrule;
    delete clean._recurrence_id;
    deduped.set(key, clean);
  }

  return Array.from(deduped.values());
}

async function fetchCalendar(source: Source) {
  const encoded = encodeURIComponent(source.calendar_id);
  const url = `https://calendar.google.com/calendar/ical/${encoded}/public/basic.ics`;

  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await fetch(url, {
      headers: { "User-Agent": "ViaSantaCruz-AgendaSync/1.0" },
      redirect: "follow",
    });

    if (response.status === 429 && attempt < 2) {
      await new Promise((resolve) => setTimeout(resolve, 1200 * (attempt + 1)));
      continue;
    }

    if (!response.ok) {
      return { ok: false, status: response.status, events: [] as any[] };
    }

    const text = await response.text();
    return { ok: true, status: response.status, events: parseIcs(text, source) };
  }

  return { ok: false, status: 429, events: [] as any[] };
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  let requestedSource = "";
  try {
    const body = await req.json();
    requestedSource = String(body?.source_key || "").trim();
  } catch {
    requestedSource = "";
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) {
    return new Response(JSON.stringify({ error: "server_configuration" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  let sourceQuery = supabase
    .from("vsc_agenda_sources")
    .select("source_key,label,calendar_id,source_group,category")
    .eq("enabled", true);

  if (requestedSource) sourceQuery = sourceQuery.eq("source_key", requestedSource);

  const { data: sources, error: sourceError } = await sourceQuery.order("source_key");

  if (sourceError) {
    return new Response(JSON.stringify({ error: "source_read_failed" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  const now = Date.now();
  const min = now - 400 * 86400000;
  const max = now + 730 * 86400000;
  const results: any[] = [];

  for (const source of (sources || []) as Source[]) {
    try {
      const loaded = await fetchCalendar(source);

      if (!loaded.ok) {
        await supabase
          .from("vsc_agenda_sources")
          .update({ last_status: loaded.status, updated_at: new Date().toISOString() })
          .eq("source_key", source.source_key);

        results.push({ source: source.source_key, ok: false, status: loaded.status, count: 0 });
        await new Promise((resolve) => setTimeout(resolve, 800));
        continue;
      }

      const expanded = expandYearlyRecurrences(loaded.events, min, max);
      const filtered = expanded.filter((event: any) => {
        const t = Date.parse(event.starts_at);
        return Number.isFinite(t) && t >= min && t <= max;
      });

      const { error: deleteError } = await supabase
        .from("vsc_agenda_events")
        .delete()
        .eq("source_key", source.source_key);

      if (deleteError) throw deleteError;

      if (filtered.length) {
        const { error: insertError } = await supabase
          .from("vsc_agenda_events")
          .insert(filtered);
        if (insertError) throw insertError;
      }

      const { error: linkError } = await supabase.rpc("vsc_agenda_link_events", {
        target_source: source.source_key,
      });
      if (linkError) throw linkError;

      await supabase
        .from("vsc_agenda_sources")
        .update({
          last_status: 200,
          last_synced_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("source_key", source.source_key);

      results.push({ source: source.source_key, ok: true, status: 200, count: filtered.length });
    } catch {
      await supabase
        .from("vsc_agenda_sources")
        .update({ last_status: 500, updated_at: new Date().toISOString() })
        .eq("source_key", source.source_key);

      results.push({ source: source.source_key, ok: false, status: 500, count: 0 });
    }

    await new Promise((resolve) => setTimeout(resolve, 800));
  }

  return new Response(JSON.stringify({
    ok: true,
    synced_at: new Date().toISOString(),
    results,
  }), {
    status: 200,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
});
