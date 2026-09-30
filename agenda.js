(() => {
  const API = "https://vgpivbxykeobgjzqlqcl.supabase.co/functions/v1/vsc-agenda";
  const list = document.getElementById("agenda-list");
  const status = document.getElementById("agenda-status");
  const updated = document.getElementById("agenda-updated");
  const search = document.getElementById("agenda-search");
  const categorySelect = document.getElementById("agenda-category");
  const parishSelect = document.getElementById("agenda-parish");
  const tabs = Array.from(document.querySelectorAll(".agenda-tab"));
  const viewButtons = Array.from(document.querySelectorAll(".agenda-view-button"));
  const calendar = document.getElementById("agenda-calendar");
  const calendarTitle = document.getElementById("agenda-calendar-title");
  const calendarGrid = document.getElementById("agenda-calendar-grid");
  const dayEvents = document.getElementById("agenda-day-events");
  const prevMonth = document.getElementById("agenda-prev-month");
  const nextMonth = document.getElementById("agenda-next-month");

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
  let currentParish = "all";
  let currentView = "list";
  let currentEvents = [];
  let calendarCursor = startOfMonth(new Date());

  function esc(value) {
    return String(value || "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
    })[c]);
  }

  function normalize(value) {
    return String(value || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();
  }

  function startOfMonth(date) {
    return new Date(date.getFullYear(), date.getMonth(), 1, 12, 0, 0);
  }

  function dateKey(date) {
    return new Intl.DateTimeFormat("en-CA", {
      year: "numeric", month: "2-digit", day: "2-digit", timeZone: TZ
    }).format(date);
  }

  function monthKey(date) {
    return dateKey(date).slice(0, 7);
  }

  function extractParish(title) {
    const value = String(title || "");
    const matches = [...value.matchAll(/(?:Par\.|Paróquia)\s+([^\n]+)/gi)];
    if (!matches.length) return "";
    let label = matches[matches.length - 1][1]
      .replace(/^Paróquia\s+/i, "")
      .replace(/\s*\([^)]*\)\s*$/g, "")
      .replace(/\s+\(Ver Horário\)\s*$/i, "")
      .trim();

    // Mantém a cidade quando ela faz parte do título e remove complementos muito específicos.
    label = label.replace(/\s+-\s+.*$/g, "").trim();
    return label;
  }

  function parishKey(title) {
    return normalize(extractParish(title))
      .replace(/^sta\.?\s+/,"santa ")
      .replace(/^sto\.?\s+/,"santo ")
      .replace(/^n\.?\s*sra\.?\s+/,"nossa senhora ")
      .replace(/^qpar\.?\s+/,"");
  }

  function formatRange(ev) {
    const start = new Date(ev.start);
    const end = new Date(ev.end);
    if (!ev.all_day) return fmtTime.format(start);

    const effectiveEnd = new Date(end.getTime() - 1);
    const sameDay = fmtLongDate.format(start) === fmtLongDate.format(effectiveEnd);
    return sameDay ? "Dia inteiro" : fmtLongDate.format(start) + " a " + fmtLongDate.format(effectiveEnd);
  }

  function buildGoogleCalendarUrl(ev) {
    const start = new Date(ev.start);
    const end = new Date(ev.end);
    const formatUtc = (date) => date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");

    let dates;
    if (ev.all_day) {
      const dateOnly = (value) => dateKey(new Date(value)).replace(/-/g, "");
      dates = dateOnly(start) + "/" + dateOnly(end);
    } else {
      dates = formatUtc(start) + "/" + formatUtc(end);
    }

    const params = new URLSearchParams({ action: "TEMPLATE", text: ev.title, dates });
    if (ev.location) params.set("location", ev.location);
    if (ev.description) params.set("details", ev.description);
    return "https://calendar.google.com/calendar/render?" + params.toString();
  }

  function populateFilters(events) {
    const categories = Array.from(new Set(events.map((ev) => ev.category).filter(Boolean)))
      .sort((a, b) => a.localeCompare(b, "pt-BR"));

    categorySelect.innerHTML = '<option value="all">Todas as categorias</option>';
    categories.forEach((category) => {
      const option = document.createElement("option");
      option.value = category;
      option.textContent = category;
      categorySelect.appendChild(option);
    });
    categorySelect.value = currentCategory;

    const parishMap = new Map();
    events.forEach((ev) => {
      const label = extractParish(ev.title);
      const key = parishKey(ev.title);
      if (label && key && !parishMap.has(key)) parishMap.set(key, label);
    });

    const parishes = Array.from(parishMap.entries()).sort((a, b) => a[1].localeCompare(b[1], "pt-BR"));
    parishSelect.innerHTML = '<option value="all">Todas as paróquias</option>';
    parishes.forEach(([key, label]) => {
      const option = document.createElement("option");
      option.value = key;
      option.textContent = label;
      parishSelect.appendChild(option);
    });
    parishSelect.value = currentParish;
    parishSelect.closest(".agenda-select-field").hidden = currentScope !== "main";
  }

  function filteredEvents() {
    const term = normalize(search.value.trim());

    return currentEvents.filter((ev) => {
      if (currentCategory !== "all" && ev.category !== currentCategory) return false;
      if (currentParish !== "all" && parishKey(ev.title) !== currentParish) return false;

      if (!term) return true;
      const haystack = normalize([ev.title, ev.location, ev.description, ev.category, ev.source_label].filter(Boolean).join(" "));
      return haystack.includes(term);
    });
  }

  function renderEventCard(ev) {
    const date = new Date(ev.start);
    const card = document.createElement("article");
    card.className = "agenda-event" + (ev.cancelled ? " is-cancelled" : "");

    const badges = ['<span class="agenda-badge">' + esc(ev.category || ev.source_label) + "</span>"];
    if (ev.cancelled) badges.unshift('<span class="agenda-badge cancelled">Cancelado</span>');

    const desc = ev.description && currentScope !== "liturgico"
      ? '<p class="agenda-description">' + esc(ev.description).replace(/\n/g, "<br>") + "</p>"
      : "";

    const calendarAction = ev.cancelled ? "" :
      '<a class="agenda-add" target="_blank" rel="noopener" href="' + esc(buildGoogleCalendarUrl(ev)) + '">Adicionar à minha agenda</a>';

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
        desc + calendarAction +
      "</div>";

    return card;
  }

  function renderList(events) {
    list.innerHTML = "";
    if (!events.length) {
      status.textContent = "Nenhum acontecimento encontrado com estes filtros.";
      return;
    }

    status.textContent = (events.length === 1 ? "1 acontecimento" : events.length + " acontecimentos") + " encontrado" + (events.length === 1 ? "" : "s") + ".";

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
      monthEvents.forEach((ev) => cards.appendChild(renderEventCard(ev)));
      section.appendChild(cards);
      frag.appendChild(section);
    });
    list.appendChild(frag);
  }

  function renderDayEvents(dayKey, events) {
    const selected = events.filter((ev) => dateKey(new Date(ev.start)) === dayKey);
    dayEvents.innerHTML = "";
    if (!selected.length) return;

    const heading = document.createElement("h3");
    heading.textContent = fmtLongDate.format(new Date(selected[0].start));
    dayEvents.appendChild(heading);
    selected.forEach((ev) => dayEvents.appendChild(renderEventCard(ev)));
  }

  function renderCalendar(events) {
    const cursor = calendarCursor;
    calendarTitle.textContent = fmtMonthYear.format(cursor);
    calendarGrid.innerHTML = "";
    dayEvents.innerHTML = "";

    const year = cursor.getFullYear();
    const month = cursor.getMonth();
    const first = new Date(year, month, 1, 12);
    const last = new Date(year, month + 1, 0, 12);
    const leading = first.getDay();

    for (let i = 0; i < leading; i++) {
      const blank = document.createElement("div");
      blank.className = "agenda-calendar-cell is-empty";
      calendarGrid.appendChild(blank);
    }

    for (let day = 1; day <= last.getDate(); day++) {
      const date = new Date(year, month, day, 12);
      const key = dateKey(date);
      const dayMatches = events.filter((ev) => dateKey(new Date(ev.start)) === key);

      const cell = document.createElement("button");
      cell.type = "button";
      cell.className = "agenda-calendar-cell" + (dayMatches.length ? " has-events" : "");
      cell.innerHTML = '<span class="agenda-calendar-number">' + day + '</span>' +
        (dayMatches.length ? '<span class="agenda-calendar-count">' + dayMatches.length + '</span>' : "");

      const preview = document.createElement("span");
      preview.className = "agenda-calendar-preview";
      dayMatches.slice(0, 2).forEach((ev) => {
        const item = document.createElement("span");
        item.textContent = ev.title;
        preview.appendChild(item);
      });
      cell.appendChild(preview);

      if (dayMatches.length) cell.addEventListener("click", () => renderDayEvents(key, events));
      calendarGrid.appendChild(cell);
    }

    const monthMatches = events.filter((ev) => {
      const d = new Date(ev.start);
      return d.getFullYear() === year && d.getMonth() === month;
    });
    status.textContent = monthMatches.length === 1 ? "1 acontecimento neste mês." : monthMatches.length + " acontecimentos neste mês.";
  }

  function applyFilters() {
    const events = filteredEvents();
    if (currentView === "month") renderCalendar(events);
    else renderList(events);
  }

  function setView(view) {
    currentView = view;
    viewButtons.forEach((button) => button.classList.toggle("active", button.dataset.view === view));
    const isMonth = view === "month";
    calendar.hidden = !isMonth;
    list.hidden = isMonth;
    applyFilters();
  }

  async function load(scope) {
    currentScope = scope;
    currentCategory = "all";
    currentParish = "all";
    currentEvents = [];
    list.innerHTML = "";
    calendarGrid.innerHTML = "";
    dayEvents.innerHTML = "";
    status.textContent = "Carregando agenda…";
    updated.textContent = "";
    search.value = "";
    tabs.forEach((tab) => tab.classList.toggle("active", tab.dataset.scope === scope));

    try {
      const response = await fetch(API + "?scope=" + encodeURIComponent(scope) + "&days=365", { cache: "no-store" });
      if (!response.ok) throw new Error("http");
      const data = await response.json();

      currentEvents = data.events || [];
      populateFilters(currentEvents);

      const firstEvent = currentEvents.find((ev) => new Date(ev.start) >= new Date());
      calendarCursor = firstEvent ? startOfMonth(new Date(firstEvent.start)) : startOfMonth(new Date());
      applyFilters();

      const syncDates = (data.sources || [])
        .map((source) => source.last_synced_at)
        .filter(Boolean)
        .map((value) => new Date(value))
        .filter((date) => !Number.isNaN(date.getTime()));

      const reference = syncDates.length
        ? new Date(Math.max(...syncDates.map((date) => date.getTime())))
        : (data.generated_at ? new Date(data.generated_at) : null);

      if (reference && !Number.isNaN(reference.getTime())) updated.textContent = "Atualizado em " + fmtUpdated.format(reference);
    } catch {
      status.textContent = "Não foi possível carregar a agenda agora. Tente novamente em alguns instantes.";
    }
  }

  search.addEventListener("input", applyFilters);
  categorySelect.addEventListener("change", () => { currentCategory = categorySelect.value; applyFilters(); });
  parishSelect.addEventListener("change", () => { currentParish = parishSelect.value; applyFilters(); });
  viewButtons.forEach((button) => button.addEventListener("click", () => setView(button.dataset.view || "list")));
  prevMonth.addEventListener("click", () => { calendarCursor = new Date(calendarCursor.getFullYear(), calendarCursor.getMonth() - 1, 1, 12); applyFilters(); });
  nextMonth.addEventListener("click", () => { calendarCursor = new Date(calendarCursor.getFullYear(), calendarCursor.getMonth() + 1, 1, 12); applyFilters(); });
  tabs.forEach((tab) => tab.addEventListener("click", () => load(tab.dataset.scope || "main")));

  load("main");
})();