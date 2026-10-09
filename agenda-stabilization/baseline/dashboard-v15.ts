import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const allowedOrigins = new Set([
  "https://agenda.viasantacruz.com.br",
  "https://agenda-diocesana-via-santa-cruz.silvanei-caixeta.chatgpt.site",
]);

function cors(origin: string | null) {
  const allowed = origin && allowedOrigins.has(origin) ? origin : "https://agenda.viasantacruz.com.br";
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Headers": "authorization, apikey, content-type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Vary": "Origin",
  };
}


async function sendResendEmail(to: string, subject: string, text: string) {
  const apiKey = Deno.env.get("RESEND_API_KEY") || "";
  const fromEmail = Deno.env.get("RESEND_FROM_EMAIL") || "";
  const fromName = Deno.env.get("RESEND_FROM_NAME") || "Via Santa Cruz — Diocese de Janaúba";
  const replyTo = Deno.env.get("AGENDA_REPLY_TO") || "";
  if (!apiKey || !fromEmail) throw new Error("resend_not_configured");

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: `${fromName} <${fromEmail}>`,
      to: [to],
      subject,
      text,
      reply_to: replyTo || undefined,
    }),
  });

  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500);
    throw new Error(`resend_${response.status}: ${detail}`);
  }
}

function protocolFromId(id: string) {
  return "VSC-" + String(id || "").slice(0, 8).toUpperCase();
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin");
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(origin) });
  if (!["GET", "POST"].includes(req.method) || !origin || !allowedOrigins.has(origin)) {
    return new Response(JSON.stringify({ error: "forbidden" }), {
      status: 403, headers: { ...cors(origin), "Content-Type": "application/json" },
    });
  }

  const authHeader = req.headers.get("authorization") || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!token) return new Response(JSON.stringify({ error: "unauthorized" }), {
    status: 401, headers: { ...cors(origin), "Content-Type": "application/json" },
  });

  const url = Deno.env.get("SUPABASE_URL") || "";
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (!url || !anonKey || !serviceKey) {
    return new Response(JSON.stringify({ error: "server_configuration" }), {
      status: 500, headers: { ...cors(origin), "Content-Type": "application/json" },
    });
  }

  const userClient = createClient(url, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData, error: userError } = await userClient.auth.getUser(token);
  if (userError || !userData?.user) return new Response(JSON.stringify({ error: "unauthorized" }), {
    status: 401, headers: { ...cors(origin), "Content-Type": "application/json" },
  });

  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: access } = await admin
    .from("vsc_agenda_access")
    .select("role,access_status")
    .eq("user_id", userData.user.id)
    .maybeSingle();

  if (!access || access.role !== "admin" || access.access_status !== "active") {
    return new Response(JSON.stringify({ error: "forbidden" }), {
      status: 403, headers: { ...cors(origin), "Content-Type": "application/json" },
    });
  }

  if (req.method === "POST") {
    let body: Record<string, unknown> = {};
    try { body = await req.json(); } catch {
      return new Response(JSON.stringify({ error: "invalid_json" }), {
        status: 400, headers: { ...cors(origin), "Content-Type": "application/json" },
      });
    }
    const action = String(body.action || "").trim();

    if (action === "sync_now") {
      const syncResponse = await fetch(url + "/functions/v1/vsc-agenda-sync", {
        method: "POST",
        headers: {
          "Authorization": "Bearer " + serviceKey,
          "apikey": serviceKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
      });

      const syncPayload = await syncResponse.json().catch(() => ({}));
      const failed = Array.isArray(syncPayload?.results)
        ? syncPayload.results.filter((row: any) => !row.ok)
        : [];

      await admin.from("vsc_agenda_audit").insert({
        user_id: userData.user.id,
        action: "agenda_sync_manual",
        metadata: {
          ok: syncResponse.ok && failed.length === 0,
          failed_sources: failed.map((row: any) => row.source),
        },
      });

      if (!syncResponse.ok) {
        return new Response(JSON.stringify({ error: "sync_failed" }), {
          status: 502, headers: { ...cors(origin), "Content-Type": "application/json" },
        });
      }

      return new Response(JSON.stringify({
        ok: failed.length === 0,
        synced_at: syncPayload?.synced_at || new Date().toISOString(),
        failed_sources: failed.map((row: any) => row.source),
        message: failed.length
          ? "Sincronização concluída com falha em: " + failed.map((row: any) => row.source).join(", ") + "."
          : "Sincronização concluída com sucesso.",
      }), {
        headers: { ...cors(origin), "Content-Type": "application/json; charset=utf-8" },
      });
    }

    if (action === "date_request_status") {
      const requestId = String(body.request_id || "").trim();
      const status = String(body.status || "").trim();
      const allowedStatuses = ["recebida","em_analise","confirmada","nao_atendida","cancelada"];
      if (!requestId || !allowedStatuses.includes(status)) {
        return new Response(JSON.stringify({ error: "invalid_fields" }), {
          status: 400, headers: { ...cors(origin), "Content-Type": "application/json" },
        });
      }
      const { data: requestRow, error: readError } = await admin
        .from("vsc_date_requests")
        .select("id,parish_name,city,requester_name,email,event_type,requested_date,requested_time,status")
        .eq("id", requestId)
        .maybeSingle();

      if (readError || !requestRow) {
        return new Response(JSON.stringify({ error: "request_not_found" }), {
          status: 404, headers: { ...cors(origin), "Content-Type": "application/json" },
        });
      }

      const previousStatus = requestRow.status;
      const { error } = await admin.from("vsc_date_requests")
        .update({ status, updated_at: new Date().toISOString() })
        .eq("id", requestId);
      if (error) {
        return new Response(JSON.stringify({ error: "database_error" }), {
          status: 500, headers: { ...cors(origin), "Content-Type": "application/json" },
        });
      }

      const statusLabels: Record<string,string> = {
        recebida: "Recebida",
        em_analise: "Em análise",
        confirmada: "Confirmada",
        nao_atendida: "Não atendida",
        cancelada: "Cancelada",
      };

      let notificationSent = false;
      let notificationError = "";
      if (requestRow.email && previousStatus !== status) {
        try {
          const protocol = protocolFromId(requestId);
          const message = [
            `Olá, ${requestRow.requester_name || "solicitante"}.`,
            "",
            `A situação da sua solicitação de data ${protocol} foi atualizada.`,
            `Nova situação: ${statusLabels[status] || status}`,
            "",
            `Paróquia / instituição: ${requestRow.parish_name}${requestRow.city ? " — " + requestRow.city : ""}`,
            `Tipo: ${requestRow.event_type}`,
            `Data solicitada: ${requestRow.requested_date}${requestRow.requested_time ? " às " + requestRow.requested_time : ""}`,
            "",
            status === "confirmada"
              ? "A data foi confirmada pela Assessoria Episcopal."
              : status === "nao_atendida"
                ? "No momento, a solicitação não poderá ser atendida."
                : status === "cancelada"
                  ? "A solicitação foi marcada como cancelada."
                  : status === "em_analise"
                    ? "A solicitação está em análise pela Assessoria Episcopal."
                    : "A solicitação foi registrada e permanece aguardando análise.",
            "",
            "Em caso de dúvida, responda a este e-mail.",
            "",
            "Via Santa Cruz — Diocese de Janaúba",
          ].join("\n");

          await sendResendEmail(
            requestRow.email,
            `Atualização da solicitação ${protocol} — Agenda Diocesana`,
            message,
          );
          notificationSent = true;
        } catch (mailError) {
          notificationError = String(mailError instanceof Error ? mailError.message : mailError).slice(0, 500);
          console.error("date_request_status_notification_failed", notificationError);
        }
      }

      await admin.from("vsc_agenda_audit").insert({
        user_id: userData.user.id,
        action: "date_request_status_changed",
        metadata: {
          request_id: requestId,
          previous_status: previousStatus,
          status,
          notification_sent: previousStatus === status ? null : notificationSent,
          notification_error: previousStatus === status ? null : (notificationError || null),
        },
      });
      return new Response(JSON.stringify({
        ok: true,
        notification_sent: previousStatus === status ? null : notificationSent,
        message: previousStatus === status
          ? "Situação mantida."
          : notificationSent
            ? "Situação atualizada e solicitante notificado por e-mail."
            : "Situação atualizada, mas a notificação por e-mail não foi enviada.",
      }), {
        headers: { ...cors(origin), "Content-Type": "application/json; charset=utf-8" },
      });
    }
    return new Response(JSON.stringify({ error: "unsupported_action" }), {
      status: 400, headers: { ...cors(origin), "Content-Type": "application/json" },
    });
  }

  const [sourcesRes, eventsRes, requestCountsRes, recentRequestsRes] = await Promise.all([
    admin.from("vsc_agenda_sources")
      .select("source_key,label,last_status,last_synced_at,enabled")
      .order("source_key"),
    admin.from("vsc_agenda_events")
      .select("source_key", { count: "exact", head: true })
      .gte("starts_at", new Date().toISOString()),
    admin.from("vsc_date_requests").select("status"),
    admin.from("vsc_date_requests")
      .select("id,parish_name,city,requester_name,requester_role,email,phone,event_type,community,requested_date,requested_time,alternate_date,alternate_time,notes,status,created_at")
      .order("created_at", { ascending: false })
      .limit(50),
  ]);

  if (sourcesRes.error || eventsRes.error || requestCountsRes.error || recentRequestsRes.error) {
    return new Response(JSON.stringify({ error: "database_error" }), {
      status: 500, headers: { ...cors(origin), "Content-Type": "application/json" },
    });
  }

  const sources = sourcesRes.data || [];
  const syncDates = sources
    .filter((s) => s.enabled && s.last_status === 200 && s.last_synced_at)
    .map((s) => new Date(s.last_synced_at))
    .filter((d) => !Number.isNaN(d.getTime()));

  const statuses: Record<string, number> = {};
  for (const row of requestCountsRes.data || []) {
    statuses[row.status] = (statuses[row.status] || 0) + 1;
  }

  return new Response(JSON.stringify({
    generated_at: new Date().toISOString(),
    health: {
      sources_total: sources.filter((s) => s.enabled).length,
      sources_ok: sources.filter((s) => s.enabled && s.last_status === 200).length,
      future_events: eventsRes.count || 0,
      oldest_sync_at: syncDates.length ? new Date(Math.min(...syncDates.map((d) => d.getTime()))).toISOString() : null,
      newest_sync_at: syncDates.length ? new Date(Math.max(...syncDates.map((d) => d.getTime()))).toISOString() : null,
      sources,
    },
    date_requests: {
      total: (requestCountsRes.data || []).length,
      statuses,
      recent: recentRequestsRes.data || [],
    },
  }), {
    headers: {
      ...cors(origin),
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
});
