(() => {
  const API = "https://vgpivbxykeobgjzqlqcl.supabase.co/functions/v1/vsc-agenda";
  const list = document.getElementById("agenda-list");
  const status = document.getElementById("agenda-status");
  const tabs = Array.from(document.querySelectorAll(".agenda-tab"));

  const fmtDate = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "short", timeZone: "America/Sao_Paulo" });
  const fmtWeek = new Intl.DateTimeFormat("pt-BR", { weekday: "long", timeZone: "America/Sao_Paulo" });
  const fmtTime = new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo" });

  function esc(value) {
    return String(value || "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
    })[c]);
  }

  function render(events, scope) {
    list.innerHTML = "";
    if (!events.length) {
      status.textContent = "Nenhum acontecimento encontrado neste período.";
      return;
    }

    status.textContent = "";
    const frag = document.createDocumentFragment();

    events.forEach((ev) => {
      const date = new Date(ev.start);
      const card = document.createElement("article");
      card.className = "agenda-event" + (ev.cancelled ? " is-cancelled" : "");
      const time = ev.all_day ? "Dia inteiro" : fmtTime.format(date);
      const badge = ev.cancelled
        ? '<span class="agenda-badge cancelled">Cancelado</span>'
        : '<span class="agenda-badge">' + esc(ev.category || ev.source_label) + "</span>";

      const desc = ev.description && scope !== "liturgico"
        ? '<p class="agenda-description">' + esc(ev.description).replace(/\n/g, "<br>") + "</p>"
        : "";

      card.innerHTML =
        '<div class="agenda-date">' +
          "<strong>" + esc(fmtDate.format(date).replace(".", "").toUpperCase()) + "</strong>" +
          "<span>" + esc(fmtWeek.format(date)) + "</span>" +
        "</div>" +
        '<div class="agenda-event-copy">' +
          '<div class="agenda-badges">' + badge + "</div>" +
          "<h2>" + esc(ev.title) + "</h2>" +
          '<p class="agenda-meta">' + esc(time) + (ev.location ? " · " + esc(ev.location) : "") + "</p>" +
          desc +
        "</div>";

      frag.appendChild(card);
    });

    list.appendChild(frag);
  }

  async function load(scope) {
    status.textContent = "Carregando agenda…";
    list.innerHTML = "";
    tabs.forEach((tab) => tab.classList.toggle("active", tab.dataset.scope === scope));

    try {
      const response = await fetch(API + "?scope=" + encodeURIComponent(scope) + "&days=365", { cache: "no-store" });
      if (!response.ok) throw new Error("http");
      const data = await response.json();

      const unavailable = (data.sources || []).filter((source) => !source.available);
      if (unavailable.length && !(data.events || []).length) {
        status.textContent = "As agendas estão temporariamente indisponíveis. Tente novamente em alguns instantes.";
        return;
      }

      render(data.events || [], scope);
    } catch {
      status.textContent = "Não foi possível carregar a agenda agora. Tente novamente em alguns instantes.";
    }
  }

  tabs.forEach((tab) => tab.addEventListener("click", () => load(tab.dataset.scope || "main")));
  load("main");
})();