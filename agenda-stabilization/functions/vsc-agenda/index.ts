import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const allowedOrigins = new Set([
  "https://viasantacruz.com.br",
  "https://www.viasantacruz.com.br",
  "https://agenda.viasantacruz.com.br",
]);

function cors(origin: string | null) {
  const h: Record<string, string> = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, apikey, content-type",
    "Vary": "Origin",
  };
  if (origin && allowedOrigins.has(origin)) h["Access-Control-Allow-Origin"] = origin;
  return h;
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin");

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors(origin) });
  }

  if (!["GET", "POST"].includes(req.method)) {
    return new Response("Method not allowed", { status: 405, headers: cors(origin) });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!supabaseUrl || !anonKey || !serviceKey) {
    return new Response(JSON.stringify({ error: "server_configuration" }), {
      status: 500,
      headers: { ...cors(origin), "Content-Type": "application/json" },
    });
  }

  const authHeader = req.headers.get("authorization") || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!token) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { ...cors(origin), "Content-Type": "application/json" },
    });
  }

  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData, error: userError } = await userClient.auth.getUser(token);
  if (userError || !userData?.user) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { ...cors(origin), "Content-Type": "application/json" },
    });
  }

  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: access, error: accessError } = await supabase
    .from("vsc_agenda_access")
    .select("display_name,role,access_status,must_change_password,can_manage_users")
    .eq("user_id", userData.user.id)
    .maybeSingle();

  if (accessError || !access || access.access_status !== "active") {
    return new Response(JSON.stringify({ error: "forbidden" }), {
      status: 403,
      headers: { ...cors(origin), "Content-Type": "application/json" },
    });
  }

  if (req.method === "POST") {
    let body: Record<string, unknown> = {};
    try { body = await req.json(); }
    catch {
      return new Response(JSON.stringify({ error: "invalid_json" }), {
        status: 400,
        headers: { ...cors(origin), "Content-Type": "application/json" },
      });
    }

    const action = String(body.action || "").trim();

    if (action === "complete_password_setup") {
      const { error: updateError } = await supabase
        .from("vsc_agenda_access")
        .update({
          must_change_password: false,
          updated_at: new Date().toISOString(),
        })
        .eq("user_id", userData.user.id);

      if (updateError) {
        return new Response(JSON.stringify({ error: "database_error" }), {
          status: 500,
          headers: { ...cors(origin), "Content-Type": "application/json" },
        });
      }

      await supabase.from("vsc_agenda_audit").insert({
        user_id: userData.user.id,
        action: "password_setup_completed",
        metadata: { channel: "agenda_diocesana" },
      });

      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: {
          ...cors(origin),
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "private, no-store",
        },
      });
    }

    return new Response(JSON.stringify({ error: "unsupported_action" }), {
      status: 400,
      headers: { ...cors(origin), "Content-Type": "application/json" },
    });
  }

  const url = new URL(req.url);
  const requestedScope = (url.searchParams.get("scope") || "main").toLowerCase();

  if (requestedScope === "main") {
    const since = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const { count: recentAccessCount } = await supabase
      .from("vsc_agenda_audit")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userData.user.id)
      .eq("action", "agenda_access")
      .gte("occurred_at", since);

    if (!recentAccessCount) {
      await supabase.from("vsc_agenda_audit").insert({
        user_id: userData.user.id,
        action: "agenda_access",
        metadata: { role: access.role },
      });
    }
  }
  const scope = url.searchParams.get("scope") || "main";
  const daysRaw = Number(url.searchParams.get("days") || "365");
  const days = Number.isFinite(daysRaw) ? Math.min(Math.max(Math.trunc(daysRaw), 1), 730) : 365;

  if (!["main", "liturgico", "padroeiros", "all"].includes(scope)) {
    return new Response(JSON.stringify({ error: "invalid_scope" }), {
      status: 400,
      headers: { ...cors(origin), "Content-Type": "application/json" },
    });
  }

  let sourceQuery = supabase
    .from("vsc_agenda_sources")
    .select("source_key,label,source_group,category,last_status,last_synced_at")
    .eq("enabled", true);

  if (scope === "main") sourceQuery = sourceQuery.or("source_group.eq.main,source_key.eq.padroeiros");
  if (scope === "liturgico") sourceQuery = sourceQuery.eq("source_key", "liturgico");
  if (scope === "padroeiros") sourceQuery = sourceQuery.eq("source_key", "padroeiros");

  const { data: sources, error: sourceError } = await sourceQuery;

  if (sourceError) {
    return new Response(JSON.stringify({ error: "source_read_failed" }), {
      status: 500,
      headers: { ...cors(origin), "Content-Type": "application/json" },
    });
  }

  const keys = (sources || []).map((s: any) => s.source_key);
  const now = new Date();
  const max = new Date(now.getTime() + days * 86400000);

  let events: any[] = [];
  if (keys.length) {
    const { data, error } = await supabase
      .from("vsc_agenda_events")
      .select("source_key,event_uid,title,raw_title,starts_at,ends_at,all_day,location,description,cancelled,bishop_absent,parish_ref_id,vsc_agenda_parishes(canonical_name,official_abbreviation,city,forania,entity_type)")
      .in("source_key", keys)
      .gte("starts_at", new Date(now.getTime() - 400 * 86400000).toISOString())
      .lte("starts_at", max.toISOString())
      .order("starts_at", { ascending: true });

    if (error) {
      return new Response(JSON.stringify({ error: "event_read_failed" }), {
        status: 500,
        headers: { ...cors(origin), "Content-Type": "application/json" },
      });
    }

    const byKey = new Map((sources || []).map((s: any) => [s.source_key, s]));
    events = (data || []).map((e: any) => {
      const s: any = byKey.get(e.source_key) || {};
      return {
        id: e.event_uid,
        title: e.title,
        raw_title: e.raw_title,
        start: e.starts_at,
        end: e.ends_at,
        all_day: e.all_day,
        location: e.location,
        description: e.description,
        cancelled: e.cancelled,
        bishop_absent: Boolean(e.bishop_absent),
        source: e.source_key,
        source_label: s.label || e.source_key,
        category: s.category || e.source_key,
        group: s.source_group || "main",
        parish_id: e.parish_ref_id || null,
        parish_name: e.vsc_agenda_parishes?.canonical_name || null,
        parish_abbreviation: e.vsc_agenda_parishes?.official_abbreviation || null,
        parish_city: e.vsc_agenda_parishes?.city || null,
        forania: e.vsc_agenda_parishes?.forania || null,
        entity_type: e.vsc_agenda_parishes?.entity_type || null,
      };
    });
  }

  const payload = {
    generated_at: new Date().toISOString(),
    timezone: "America/Sao_Paulo",
    scope,
    days,
    events,
    access: {
      display_name: access.display_name,
      role: access.role,
      can_manage_users: Boolean(access.can_manage_users),
      must_change_password: access.must_change_password,
    },
    sources: (sources || []).map((s: any) => ({
      key: s.source_key,
      label: s.label,
      category: s.category,
      available: Boolean(s.last_synced_at),
      status: s.last_status,
      last_synced_at: s.last_synced_at,
    })),
  };

  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      ...cors(origin),
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "private, no-store",
    },
  });
});
