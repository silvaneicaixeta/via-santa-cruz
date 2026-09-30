(() => {
  const API = "https://vgpivbxykeobgjzqlqcl.supabase.co/functions/v1/vsc-agenda";
  const list = document.getElementById("agenda-list");
  const status = document.getElementById("agenda-status");
  const updated = document.getElementById("agenda-updated");
  const search = document.getElementById("agenda-search");
  const categoryHost = document.getElementById("agenda-categories");
  const tabs = Array.from(document.querySelectorAll(".agenda-tab"));

  const TZ = "America/Sao_Paulo";
  const fmtDay = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", timeZone: TZ });
  const fmtMonthShort = new Intl.DateTimeFormat("pt-BR", { month: "short", timeZone: TZ });
  const fmtWeek = new Intl.DateTimeFormat("pt-BR", { weekday: "long", timeZone: TZ });
  const fmtTime = new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: TZ });
  const fmtMonthYear = new Intl.DateTimeFormat("pt-BR", { month: "long", year: "numeric", timeZone: TZ });
  const fmtLongDate = new Intl.DateTimeFormat("pt-BR", { day: "numeric", month: "long", timeZone: TZ });
  const fmtUpdated = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: TZ });

  let currentScope = "main";
  let currentCategory = "all";
  let currentEvents = [];

  function esc(value) {
    return String(value || "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
    })[c]);
  }

  function normalize(value) {
    return String(value || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase();
  }

  function monthKey(date) {
    const parts = new Intl.DateTimeFormat("en-CA", {
      year: "numeric", month: "2-digit", timeZone: TZ
    }).formatToParts(date);
    const year = parts.find((p) => p.type === "year").value;
    const month = parts.find((p) => p.type === "month").value;
    return year + "-" + month;
  }

  function formatRange(ev) {
    const start = new Date(ev.start);
    const end = new Date(ev.end);

    if (!ev.all_day) return fmtTime.format(start);

    const effectiveEnd = new Date(end.getTime() - 1);
    const sameDay = fmtLongDate.format(start) === fmtLongDate.format(effectiveEnd);
    if (sameDay) return "Dia inteiro";

    return fmtLongDate.format(start) + " a " + fmtLongDate.format(effectiveEnd);
  }

  function buildGoogleCalendarUrl(ev) {
    const start = new Date(ev.start);
    const end = new Date(ev.end);
    const formatUtc = (date) => date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");

    let dates;
    if (ev.all_day) {
      const dateOnly = (value) => {
        const d = new Date(value);
        return new Intl.DateTimeFormat("en-CA", {
          year: "numeric", month: "2-digit", day: "2-digit", timeZone: TZ
        }).format(d).replace(/-/g, "");
      };
      dates = dateOnly(start) + "/" + dateOnly(end);
    } else {
      dates = formatUtc(start) + "/" + formatUtc(end);
    }

    const params = new URLSearchParams({
      action: "TEMPLATE",
      text: ev.title,
      dates
    });
    if (ev.location) params.set("location", ev.location);
    if (ev.description) params.set("details", ev.description);
    return "https://calendar.google.com/calendar/render?" + params.toString();
  }

  function renderCategories(events) {
    categoryHost.innerHTML = "";
    if (currentScope !== "main") return;

    const categories = Array.from(new Set(events.map((ev) => ev.category).filter(Boolean)))
      .sort((a, b) => a.localeCompare(b, "pt-BR"));

    if (categories.length < 2) return;

    ["all", ...categories].forEach((category) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "agenda-category" + (category === currentCategory ? " active" : "");
      button.dataset.category = category;
      button.textContent = category === "all" ? "Todos" : category;
      button.addEventListener("click", () => {
        currentCategory = category;
        renderCategories(currentEvents);
        applyFilters();
      });
      categoryHost.appendChild(button);
    });
  }

  function filteredEvents() {
    const term = normalize(search.value.trim());

    return currentEvents.filter((ev) => {
      const categoryOk = currentCategory === "all" || ev.category === currentCategory;
      if (!categoryOk) return false;
      if (!term) return true;

      const haystack = normalize([
        ev.title,
        ev.location,
        ev.description,
        ev.category,
        ev.source_label
      ].filter(Boolean).join(" "));

      return haystack.includes(term);
    });
  }

  function render(events) {
    list.innerHTML = "";

    if (!events.length) {
      status.textContent = "Nenhum acontecimento encontrado com estes filtros.";
      return;
    }

    const countLabel = events.length === 1 ? "1 acontecimento" : events.length + " acontecimentos";
    status.textContent = countLabel + " encontrado" + (events.length === 1 ? "" : "s") + ".";

    const groups = new Map();
    events.forEach((ev) => {
      const key = monthKey(new Date(ev.start));
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(ev);
    });

    const frag = document.createDocumentFragment();

    groups.forEach((monthEvents) => {
      const section = document.createElement("section");
      section.className = "agenda-month";

      const heading = document.createElement("h2");
      heading.className = "agenda-month-title";
      heading.textContent = fmtMonthYear.format(new Date(monthEvents[0].start));
      section.appendChild(heading);

      const cards = document.createElement("div");
      cards.className = "agenda-month-events";

      monthEvents.forEach((ev) => {
        const date = new Date(ev.start);
        const card = document.createElement("article");
        card.className = "agenda-event" + (ev.cancelled ? " is-cancelled" : "");

        const badges = [
          '<span class="agenda-badge">' + esc(ev.category || ev.source_label) + "</span>"
        ];
        if (ev.cancelled) badges.unshift('<span class="agenda-badge cancelled">Cancelado</span>');

        const desc = ev.description && currentScope !== "liturgico"
          ? '<p class="agenda-description">' + esc(ev.description).replace(/\n/g, "<br>") + "</p>"
          : "";

        const calendarAction = ev.cancelled
          ? ""
          : '<a class="agenda-add" target="_blank" rel="noopener" href="' + esc(buildGoogleCalendarUrl(ev)) + '">Adicionar à minha agenda</a>';

        card.innerHTML =
          '<div class="agenda-date">' +
            '<strong class="agenda-day">' + esc(fmtDay.format(date)) + "</strong>" +
            '<span class="agenda-month-short">' + esc(fmtMonthShort.format(date).replace(".", "").toUpperCase()) + "</span>" +
            '<span class="agenda-weekday">' + esc(fmtWeek.format(date)) + "</span>" +
          "</div>" +
          '<div class="agenda-event-copy">' +
            '<div class="agenda-badges">' + badges.join("") + "</div>" +
            "<h3>" + esc(ev.title) + "</h3>" +
            '<p class="agenda-meta">' + esc(formatRange(ev)) + (ev.location ? " · " + esc(ev.location) : "") + "</p>" +
            desc +
            calendarAction +
          "</div>";

        cards.appendChild(card);
      });

      section.appendChild(cards);
      frag.appendChild(section);
    });

    list.appendChild(frag);
  }

  function applyFilters() {
    render(filteredEvents());
  }

  async function load(scope) {
    currentScope = scope;
    currentCategory = "all";
    currentEvents = [];
    list.innerHTML = "";
    status.textContent = "Carregando agenda…";
    updated.textContent = "";
    categoryHost.innerHTML = "";
    search.value = "";

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

      currentEvents = data.events || [];
      renderCategories(currentEvents);
      applyFilters();

      const syncDates = (data.sources || [])
        .map((source) => source.last_synced_at)
        .filter(Boolean)
        .map((value) => new Date(value))
        .filter((date) => !Number.isNaN(date.getTime()));

      const reference = syncDates.length
        ? new Date(Math.max(...syncDates.map((date) => date.getTime())))
        : (data.generated_at ? new Date(data.generated_at) : null);

      if (reference && !Number.isNaN(reference.getTime())) {
        updated.textContent = "Atualizado em " + fmtUpdated.format(reference);
      }
    } catch {
      status.textContent = "Não foi possível carregar a agenda agora. Tente novamente em alguns instantes.";
    }
  }

  search.addEventListener("input", applyFilters);
  tabs.forEach((tab) => tab.addEventListener("click", () => load(tab.dataset.scope || "main")));
  load("main");
})();