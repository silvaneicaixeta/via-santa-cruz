(() => {
  const SUPABASE_URL = "https://hkujbdfqhbkejpbsfode.supabase.co";
  const SUPABASE_KEY = "sb_publishable_KIsDfvNnPTlnFUAvFN74YA_ufMJcAGH";
  const USERS_API = SUPABASE_URL + "/functions/v1/vsc-agenda-admin-users";
  const DASH_API = SUPABASE_URL + "/functions/v1/vsc-agenda-admin-dashboard";

  const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false }
  });

  const els = {
    open: document.getElementById("agenda-admin-open"),
    close: document.getElementById("agenda-admin-close"),
    main: document.getElementById("agenda-main-view"),
    admin: document.getElementById("agenda-admin-view"),
    sources: document.getElementById("admin-sources"),
    events: document.getElementById("admin-events"),
    dateRequests: document.getElementById("admin-date-requests"),
    accessRequests: document.getElementById("admin-access-requests"),
    health: document.getElementById("admin-health-message"),
    accessBody: document.getElementById("admin-access-body"),
    usersBody: document.getElementById("admin-users-body"),
    dateBody: document.getElementById("admin-date-body"),
    auditBody: document.getElementById("admin-audit-body"),
    message: document.getElementById("agenda-admin-message")
  };

  if (!els.open || !els.admin) return;

  const roleLabels = {
    admin: "Administração",
    clergy: "Clero",
    parish: "Paróquia",
    curia: "Cúria",
    collaborator: "Colaborador"
  };

  const auditLabels = {
    agenda_access: "Acesso à Agenda",
    access_request_submitted: "Solicitação enviada",
    access_request_approved: "Acesso aprovado",
    access_request_rejected: "Solicitação não aprovada",
    access_suspended: "Acesso suspenso",
    access_reactivated: "Acesso reativado",
    date_request_status_changed: "Situação da solicitação de data alterada"
  };

  const dateStatusLabels = {
    recebida: "Recebida",
    em_analise: "Em análise",
    confirmada: "Confirmada",
    nao_atendida: "Não atendida",
    cancelada: "Cancelada"
  };

  async function sessionToken() {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.access_token) throw new Error("session");
    return session.access_token;
  }

  async function api(url, options = {}) {
    const token = await sessionToken();
    const response = await fetch(url, {
      method: options.method || "GET",
      headers: {
        Authorization: "Bearer " + token,
        apikey: SUPABASE_KEY,
        "Content-Type": "application/json"
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      cache: "no-store"
    });
    if (response.status === 401) throw new Error("session");
    if (response.status === 403) throw new Error("forbidden");
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.detail || data.error || "request_failed");
    return data;
  }

  function td(value) {
    const cell = document.createElement("td");
    cell.textContent = value ?? "—";
    return cell;
  }

  function smallButton(label, action, danger = false) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "agenda-admin-small-button" + (danger ? " danger" : "");
    button.textContent = label;
    button.addEventListener("click", action);
    return button;
  }

  async function loadUsers() {
    const data = await api(USERS_API);
    const pending = (data.requests || []).filter(row => row.status === "pending");
    els.accessRequests.textContent = String(pending.length);

    els.accessBody.innerHTML = "";
    if (!pending.length) {
      const tr = document.createElement("tr");
      const cell = td("Nenhuma solicitação pendente.");
      cell.colSpan = 5;
      tr.appendChild(cell);
      els.accessBody.appendChild(tr);
    } else {
      pending.forEach(row => {
        const tr = document.createElement("tr");
        tr.appendChild(td(new Date(row.created_at).toLocaleString("pt-BR")));

        const name = document.createElement("td");
        const strong = document.createElement("strong");
        strong.textContent = row.full_name;
        const br = document.createElement("br");
        const small = document.createElement("small");
        small.textContent = row.email;
        name.append(strong, br, small);
        tr.appendChild(name);

        const roleCell = document.createElement("td");
        const select = document.createElement("select");
        ["clergy","parish","curia","collaborator"].forEach(value => {
          const option = document.createElement("option");
          option.value = value;
          option.textContent = roleLabels[value];
          option.selected = value === row.requested_role;
          select.appendChild(option);
        });
        roleCell.appendChild(select);
        tr.appendChild(roleCell);

        tr.appendChild(td([row.institution, row.ministry_role].filter(Boolean).join(" · ") || "—"));

        const actions = document.createElement("td");
        actions.style.display = "flex";
        actions.style.gap = ".4rem";
        actions.style.flexWrap = "wrap";
        actions.append(
          smallButton("Aprovar", async () => {
            els.message.textContent = "Aprovando acesso…";
            try {
              const result = await api(USERS_API, {
                method: "POST",
                body: { action: "approve_request", request_id: row.id, role: select.value }
              });
              els.message.textContent = result.message || "Acesso aprovado.";
              await loadAll();
            } catch (err) {
              els.message.textContent = "Não foi possível aprovar: " + err.message;
            }
          }),
          smallButton("Não aprovar", async () => {
            if (!confirm("Marcar esta solicitação como não aprovada?")) return;
            try {
              await api(USERS_API, { method: "POST", body: { action: "reject_request", request_id: row.id } });
              els.message.textContent = "Solicitação marcada como não aprovada.";
              await loadAll();
            } catch (err) {
              els.message.textContent = "Não foi possível atualizar: " + err.message;
            }
          }, true)
        );
        tr.appendChild(actions);
        els.accessBody.appendChild(tr);
      });
    }

    els.usersBody.innerHTML = "";
    (data.users || []).forEach(row => {
      const tr = document.createElement("tr");
      tr.append(
        td(row.display_name),
        td(row.email),
        td(roleLabels[row.role] || row.role),
        td(row.last_sign_in_at ? new Date(row.last_sign_in_at).toLocaleString("pt-BR") : "Nunca"),
        td(row.access_status === "active" ? "Ativo" : "Suspenso")
      );
      const action = document.createElement("td");
      if (row.role === "admin") {
        action.textContent = "—";
      } else {
        action.appendChild(smallButton(
          row.access_status === "active" ? "Suspender" : "Reativar",
          async () => {
            const next = row.access_status === "active" ? "suspended" : "active";
            try {
              await api(USERS_API, {
                method: "POST",
                body: { action: "status", user_id: row.user_id, access_status: next }
              });
              els.message.textContent = next === "active" ? "Acesso reativado." : "Acesso suspenso.";
              await loadAll();
            } catch (err) {
              els.message.textContent = "Não foi possível alterar o acesso: " + err.message;
            }
          },
          row.access_status === "active"
        ));
      }
      tr.appendChild(action);
      els.usersBody.appendChild(tr);
    });

    els.auditBody.innerHTML = "";
    (data.audit || []).slice(0, 60).forEach(row => {
      const tr = document.createElement("tr");
      const detail = row.metadata ? Object.entries(row.metadata)
        .filter(([key]) => !["role"].includes(key))
        .slice(0, 4)
        .map(([key,value]) => key + ": " + String(value))
        .join(" · ") : "";
      tr.append(
        td(new Date(row.occurred_at).toLocaleString("pt-BR")),
        td(row.email || row.metadata?.email || "—"),
        td(auditLabels[row.action] || row.action),
        td(detail || "—")
      );
      els.auditBody.appendChild(tr);
    });
  }

  async function loadDashboard() {
    const data = await api(DASH_API);
    const health = data.health || {};
    els.sources.textContent = (health.sources_ok ?? 0) + "/" + (health.sources_total ?? 0);
    els.events.textContent = String(health.future_events ?? 0);
    els.dateRequests.textContent = String(data.date_requests?.total ?? 0);

    const failed = (health.sources || []).filter(s => s.enabled && s.last_status !== 200);
    const oldest = health.oldest_sync_at
      ? new Date(health.oldest_sync_at).toLocaleString("pt-BR", { day:"2-digit", month:"2-digit", hour:"2-digit", minute:"2-digit" })
      : "não informada";
    els.health.textContent = failed.length
      ? "Atenção: " + failed.map(s => s.label || s.source_key).join(", ") + " apresentou falha na última sincronização. Sincronização de referência: " + oldest + "."
      : "Todas as fontes ativas responderam corretamente. Sincronização de referência: " + oldest + ".";

    els.dateBody.innerHTML = "";
    const rows = data.date_requests?.recent || [];
    if (!rows.length) {
      const tr = document.createElement("tr");
      const cell = td("Nenhuma solicitação registrada.");
      cell.colSpan = 5;
      tr.appendChild(cell);
      els.dateBody.appendChild(tr);
    } else {
      rows.forEach(row => {
        const tr = document.createElement("tr");
        tr.append(
          td(new Date(row.created_at).toLocaleString("pt-BR")),
          td(row.parish_name + (row.city ? " — " + row.city : "")),
          td(new Date(row.requested_date + "T12:00:00").toLocaleDateString("pt-BR")),
          td(row.event_type)
        );

        const statusCell = document.createElement("td");
        const select = document.createElement("select");
        ["recebida","em_analise","confirmada","nao_atendida","cancelada"].forEach(value => {
          const option = document.createElement("option");
          option.value = value;
          option.textContent = dateStatusLabels[value];
          option.selected = value === row.status;
          select.appendChild(option);
        });
        select.addEventListener("change", async () => {
          const old = row.status;
          try {
            await api(DASH_API, {
              method: "POST",
              body: { action: "date_request_status", request_id: row.id, status: select.value }
            });
            els.message.textContent = "Situação da solicitação atualizada.";
            await loadAll();
          } catch (err) {
            select.value = old;
            els.message.textContent = "Não foi possível atualizar a solicitação: " + err.message;
          }
        });
        statusCell.appendChild(select);
        tr.appendChild(statusCell);
        els.dateBody.appendChild(tr);
      });
    }
  }

  async function loadAll() {
    els.message.textContent = "Atualizando administração…";
    try {
      await Promise.all([loadDashboard(), loadUsers()]);
      els.message.textContent = "Dados atualizados em " + new Date().toLocaleString("pt-BR") + ".";
    } catch (err) {
      if (err.message === "forbidden") {
        els.open.hidden = true;
        els.admin.hidden = true;
        els.main.hidden = false;
        return;
      }
      els.message.textContent = "Não foi possível carregar a administração agora.";
    }
  }

  els.open.addEventListener("click", async () => {
    els.main.hidden = true;
    els.admin.hidden = false;
    window.scrollTo({ top: 0, behavior: "smooth" });
    await loadAll();
  });

  els.close.addEventListener("click", () => {
    els.admin.hidden = true;
    els.main.hidden = false;
    window.scrollTo({ top: 0, behavior: "smooth" });
  });
})();