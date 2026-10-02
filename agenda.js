(() => {
  const API = "https://vgpivbxykeobgjzqlqcl.supabase.co/functions/v1/vsc-agenda";
  const TZ = "America/Sao_Paulo";

  const els = {
    list: document.getElementById("agenda-list"),
    status: document.getElementById("agenda-status"),
    updated: document.getElementById("agenda-updated"),
    search: document.getElementById("agenda-search"),
    includeLiturgy: document.getElementById("agenda-include-liturgy"),
    viewButtons: Array.from(document.querySelectorAll(".agenda-view-button")),
    calendar: document.getElementById("agenda-calendar"),
    calendarTitle: document.getElementById("agenda-calendar-title"),
    calendarGrid: document.getElementById("agenda-calendar-grid"),
    dayEvents: document.getElementById("agenda-day-events"),
    prevMonth: document.getElementById("agenda-prev-month"),
    nextMonth: document.getElementById("agenda-next-month"),
    filterButton: document.getElementById("agenda-filter-button"),
    filterCount: document.getElementById("agenda-filter-count"),
    activeFilters: document.getElementById("agenda-active-filters"),
    filterModal: document.getElementById("agenda-filter-modal"),
    filterTypes: document.getElementById("filter-types"),
    filterScopes: document.getElementById("filter-scopes"),
    filterParishes: document.getElementById("filter-parishes"),
    filterCities: document.getElementById("filter-cities"),
    parishSearch: document.getElementById("filter-parish-search"),
    year: document.getElementById("filter-year"),
    start: document.getElementById("filter-start"),
    end: document.getElementById("filter-end"),
    confirmed: document.getElementById("filter-confirmed"),
    cancelled: document.getElementById("filter-cancelled"),
    applyFilters: document.getElementById("agenda-apply-filters"),
    clearFilters: document.getElementById("agenda-clear-filters"),
    printButton: document.getElementById("agenda-print-button"),
    printList: document.getElementById("agenda-print-list"),
    printSummary: document.getElementById("agenda-print-summary")
  };

  const fmtDay = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", timeZone: TZ });
  const fmtMonthShort = new Intl.DateTimeFormat("pt-BR", { month: "short", timeZone: TZ });
  const fmtWeek = new Intl.DateTimeFormat("pt-BR", { weekday: "long", timeZone: TZ });
  const fmtWeekShort = new Intl.DateTimeFormat("pt-BR", { weekday: "short", timeZone: TZ });
  const fmtTime = new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: TZ });
  const fmtMonthYear = new Intl.DateTimeFormat("pt-BR", { month: "long", year: "numeric", timeZone: TZ });
  const fmtLongDate = new Intl.DateTimeFormat("pt-BR", { day: "numeric", month: "long", year: "numeric", timeZone: TZ });
  const fmtUpdated = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: TZ });

  let currentScope = "main";
  let currentView = "list";
  let agendaEvents = [];
  let liturgyEvents = [];
  let currentEvents = [];
  let calendarCursor = startOfMonth(new Date());

  const filters = {
    period: "upcoming",
    year: String(new Date().getFullYear()),
    start: "",
    end: "",
    types: new Set(),
    scopes: new Set(),
    parishes: new Set(),
    cities: new Set(),
    confirmed: true,
    cancelled: true
  };

  function esc(value) {
    return String(value || "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
    })[c]);
  }

  function normalize(value) {
    return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
  }

  function startOfMonth(date) { return new Date(date.getFullYear(), date.getMonth(), 1, 12); }

  function dateKey(date) {
    return new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: TZ }).format(date);
  }

  function monthKey(date) { return dateKey(date).slice(0, 7); }

  function normalizeParishName(value) {
    return normalize(value)
      .replace(/^paroquia\s+/g, "")
      .replace(/\bsta\.?\b/g, "santa")
      .replace(/\bsto\.?\b/g, "santo")
      .replace(/\bn\.?\s*sra\.?\b/g, "nossa senhora")
      .replace(/\bs\.?\s*jose\b/g, "sao jose")
      .replace(/[.,;]+$/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function displayParishName(value) {
    return String(value || "")
      .replace(/^Paróquia\s+/i, "")
      .replace(/\bN\.?\s*Sra\.?\b/gi, "Nossa Senhora")
      .replace(/\bSto\.?\b/gi, "Santo")
      .replace(/\bSta\.?\b/gi, "Santa")
      .replace(/\s+/g, " ")
      .replace(/[.,;]+$/g, "")
      .trim();
  }

  function cityKey(value) {
    return normalize(value)
      .replace(/\bsto\.?\b/g, "santo")
      .replace(/[.,;]+$/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function displayCity(value) {
    const cleaned = String(value || "")
      .replace(/\s*\([^)]*\)\s*$/g, "")
      .replace(/[.,;]+$/g, "")
      .replace(/\s+/g, " ")
      .trim();

    const aliases = {
      "rio pardo": "Rio Pardo de Minas",
      "sto. antônio do retiro": "Santo Antônio do Retiro",
      "sto antônio do retiro": "Santo Antônio do Retiro"
    };
    return aliases[normalize(cleaned)] || cleaned;
  }

  function canonicalType(title, source) {
    if (source === "liturgico") return "Liturgia";
    const t = normalize(title);
    if (source === "crisma" || /^crisma\b/.test(t)) return "Crisma";
    if (source === "padroeiros" || /\bpadroeir[oa]\b/.test(t)) return "Padroeiro";
    if (/\bnovena\b|\bnovenario\b/.test(t)) return "Novena / Novenário";
    if (/\bfesta\b/.test(t)) return "Festa";
    if (/\bmissa\b|\bcelebracao\b|\bhora santa\b|\bdedicacao\b/.test(t)) return "Celebração";
    if (/\breuniao\b|\bconsep\b|\bconser\b/.test(t)) return "Reunião";
    if (/\bformacao\b/.test(t)) return "Formação";
    if (/\bretiro\b/.test(t)) return "Retiro";
    if (/\bassembleia\b/.test(t)) return "Assembleia";
    if (/\bcoleta\b/.test(t)) return "Coleta";
    if (/\bposse\b|\bconstituicao\b|\bordenacao\b|\berecao\b/.test(t)) return "Ato canônico";
    if (/\bcongresso\b|\bencontro\b|\bromaria\b|\bdnj\b/.test(t)) return "Encontro / Congresso";
    if (/\baniv\b|\baniversario\b|\bfundacao\b|\binstalacao\b|^dia\b|\bconclusao do ano pastoral\b/.test(t)) return "Efeméride";
    if (/\bsemana\b|\bmes da\b|\bmes do\b|\babertura do mes\b/.test(t)) return "Tempo pastoral";
    return "Outros";
  }

  function parseEvent(ev) {
    const title = String(ev.title || "").trim();
    const parts = title.split(/\s+-\s+/).map((p) => p.trim()).filter(Boolean);

    let type = "";
    let community = "";
    let parish = "";
    let city = "";

    if (parts.length) {
      const first = parts[0];
      const known = first.match(/^(Crisma|Novena|Novenário|Festa|Celebração|Missa|Tríduo|Retiro|Reunião|Encontro|Assembleia|Abertura(?: da| do)? Novena|Abertura)/i);
      type = known ? known[1] : first.split(/\s+/).slice(0, 2).join(" ");

      for (let i = 1; i < parts.length; i++) {
        const part = parts[i];
        if (/^Com\./i.test(part)) community = part;
        else if (/^(?:QPar\.|Quase\s+Par\.|Par\.|Paróquia)\s+/i.test(part)) {
          parish = part.replace(/^(?:QPar\.|Quase\s+Par\.|Par\.|Paróquia)\s+/i, "").trim();
          if (parts[i + 1] && !/^Com\.|^(?:QPar\.|Par\.|Paróquia)/i.test(parts[i + 1])) city = parts[i + 1];
        }
      }
    }

    if (!parish) {
      const patron = title.match(/(?:Padroeir[oa]\s+)?(?:Quase\s+Par\.|QPar\.|Par\.|Paróquia)\s+(.+?)\s*\/\s*(.+)$/i);
      if (patron) { parish = patron[1].replace(/^Paróquia\s+/i, "").trim(); city = patron[2].trim(); }
    }

    if (!parish) {
      const legacy = title.match(/(?:QPar\.|Par\.|Paróquia)\s+(.+?)\s+em\s+([^()]+?)(?:\s*\(|$)/i);
      if (legacy) { parish = legacy[1].trim(); city = legacy[2].trim(); }
    }

    if (!parish) {
      const legacyComma = title.match(/(?:QPar\.|Par\.|Paróquia)\s+(.+?),\s*([^,()]+?)(?:\s*\(|$)/i);
      if (legacyComma) { parish = legacyComma[1].trim(); city = legacyComma[2].trim(); }
    }

    if (parish && !city) {
      const embeddedEm = parish.match(/^(.+?)\s+em\s+(.+)$/i);
      const embeddedComma = parish.match(/^(.+?),\s*(.+)$/);
      if (embeddedEm) { parish = embeddedEm[1].trim(); city = embeddedEm[2].trim(); }
      else if (embeddedComma) { parish = embeddedComma[1].trim(); city = embeddedComma[2].trim(); }
    }

    parish = displayParishName(parish);
    city = displayCity(city);

    if (!city && ev.location && !/[0-9]/.test(ev.location)) city = displayCity(ev.location);

    const sourceScope = {
      "leste-ii": "Leste II",
      "cnbb": "CNBB",
      "comire": "COMIRE",
      "dioc-informativo": "Diocese",
      "crisma": "Paróquias",
      "paroquiais": "Paróquias",
      "padroeiros": "Paróquias"
    };
    const scope = sourceScope[ev.source] || ev.source_label || "Diocese";
    type = canonicalType(title, ev.source);

    const parishLabel = parish ? parish + (city ? " — " + city : "") : "";
    const parishKey = parish ? normalizeParishName(parish) + "|" + cityKey(city) : "";

    return { type, community, parish, city, cityKey: cityKey(city), parishLabel, parishKey, scope };
  }

  function formatRange(ev) {
    const start = new Date(ev.start), end = new Date(ev.end);
    if (!ev.all_day) return fmtTime.format(start);
    const effectiveEnd = new Date(end.getTime() - 1);
    return dateKey(start) === dateKey(effectiveEnd) ? "Dia inteiro" : fmtLongDate.format(start) + " a " + fmtLongDate.format(effectiveEnd);
  }

  function buildGoogleCalendarUrl(ev) {
    const start = new Date(ev.start), end = new Date(ev.end);
    const utc = (d) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
    const only = (d) => dateKey(new Date(d)).replace(/-/g, "");
    const dates = ev.all_day ? only(start) + "/" + only(end) : utc(start) + "/" + utc(end);
    const params = new URLSearchParams({ action: "TEMPLATE", text: ev.title, dates });
    if (ev.location) params.set("location", ev.location);
    if (ev.description) params.set("details", ev.description);
    return "https://calendar.google.com/calendar/render?" + params.toString();
  }

  function optionList(container, values, selectedSet, kind) {
    container.innerHTML = "";
    values.forEach(({ key, label }) => {
      const item = document.createElement("label");
      item.dataset.search = normalize(label);
      const input = document.createElement("input");
      input.type = "checkbox";
      input.value = key;
      input.checked = selectedSet.has(key);
      input.dataset.filterKind = kind;
      item.append(input, document.createTextNode(" " + label));
      container.appendChild(item);
    });
  }

  function populateFilterChoices(events) {
    const structuralEvents = events.filter((ev) => ev.source !== "liturgico");
    const meta = structuralEvents.map((ev) => ({ ev, p: parseEvent(ev) }));
    const unique = (items) => Array.from(new Map(items.filter((x) => x.key && x.label).map((x) => [x.key, x])).values())
      .sort((a, b) => a.label.localeCompare(b.label, "pt-BR"));

    optionList(els.filterTypes, unique(meta.map(({p}) => ({ key: normalize(p.type), label: p.type }))), filters.types, "types");
    optionList(els.filterScopes, unique(meta.map(({p}) => ({ key: normalize(p.scope), label: p.scope }))), filters.scopes, "scopes");
    optionList(els.filterParishes, unique(meta.map(({p}) => ({ key: p.parishKey, label: p.parishLabel }))), filters.parishes, "parishes");
    optionList(els.filterCities, unique(meta.map(({p}) => ({ key: p.cityKey, label: p.city }))), filters.cities, "cities");

    const years = Array.from(new Set(events.map((ev) => new Date(ev.start).getFullYear()))).sort();
    els.year.innerHTML = "";
    years.forEach((year) => {
      const option = document.createElement("option");
      option.value = String(year);
      option.textContent = String(year);
      els.year.appendChild(option);
    });
    if (!years.includes(Number(filters.year)) && years.length) filters.year = String(years[0]);
    els.year.value = filters.year;
  }

  function selectedCheckboxes(kind) {
    return new Set(Array.from(document.querySelectorAll('input[data-filter-kind="' + kind + '"]:checked')).map((input) => input.value));
  }

  function inPeriod(ev) {
    if (currentScope !== "main" || filters.period === "all") return true;
    const date = new Date(ev.start), now = new Date();

    if (filters.period === "next30") {
      const start = new Date(now.getTime() - 86400000);
      const end = new Date(now.getTime() + 30 * 86400000);
      return date >= start && date <= end;
    }
    if (filters.period === "upcoming") {
      const start = new Date(now.getTime() - 86400000);
      const end = new Date(now.getTime() + 90 * 86400000);
      return date >= start && date <= end;
    }
    if (filters.period === "month") return monthKey(date) === monthKey(now);
    if (filters.period === "past30") {
      const start = new Date(now.getTime() - 30 * 86400000);
      return date >= start && date <= now;
    }
    if (filters.period === "year") return String(date.getFullYear()) === filters.year;
    if (filters.period === "custom") {
      const key = dateKey(date);
      if (filters.start && key < filters.start) return false;
      if (filters.end && key > filters.end) return false;
    }
    return true;
  }

  function filteredEvents() {
    const term = normalize(els.search.value);
    return currentEvents.filter((ev) => {
      const p = parseEvent(ev);
      if (!inPeriod(ev)) return false;

      const structuralFilterActive = filters.types.size || filters.scopes.size || filters.parishes.size || filters.cities.size;
      if (ev.source === "liturgico" && structuralFilterActive) return false;

      if (filters.types.size && !filters.types.has(normalize(p.type))) return false;
      if (filters.scopes.size && !filters.scopes.has(normalize(p.scope))) return false;
      if (filters.parishes.size && !filters.parishes.has(p.parishKey)) return false;
      if (filters.cities.size && !filters.cities.has(p.cityKey)) return false;
      if (ev.cancelled && !filters.cancelled) return false;
      if (!ev.cancelled && !filters.confirmed) return false;
      if (!term) return true;
      return normalize([ev.title, ev.location, ev.description, p.type, p.scope, p.parishLabel, p.city].filter(Boolean).join(" ")).includes(term);
    });
  }

  function renderEventCard(ev) {
    const date = new Date(ev.start), p = parseEvent(ev);
    const card = document.createElement("article");
    card.className = "agenda-event" + (ev.cancelled ? " is-cancelled" : "");

    const badges = [];
    if (ev.cancelled) badges.push('<span class="agenda-badge cancelled">Cancelado</span>');
    if (ev.source !== "liturgico") badges.push('<span class="agenda-badge">' + esc(p.type || ev.category) + "</span>");

    const timeLabel = ev.source === "liturgico" && ev.all_day ? "" : formatRange(ev);
    const meta = [timeLabel, p.city || ev.location].filter(Boolean).join(" · ");
    card.innerHTML =
      '<div class="agenda-date"><strong class="agenda-day">' + esc(fmtDay.format(date)) + '</strong><span class="agenda-month-short">' +
      esc(fmtMonthShort.format(date).replace(".", "").toUpperCase()) + '</span></div>' +
      '<div class="agenda-event-copy"><div class="agenda-badges">' + badges.join("") + '</div><h3>' + esc(ev.title) + '</h3>' +
      '<div class="agenda-event-bottom"><p class="agenda-meta">' + esc(meta) + '</p>' +
      (ev.cancelled ? "" : '<a class="agenda-add" target="_blank" rel="noopener" href="' + esc(buildGoogleCalendarUrl(ev)) + '">+ Agenda</a>') +
      "</div></div>";
    return card;
  }

  function renderList(events) {
    els.list.innerHTML = "";
    if (!events.length) { els.status.textContent = "Nenhum acontecimento encontrado com estes filtros."; return; }
    els.status.textContent = (events.length === 1 ? "1 acontecimento encontrado." : events.length + " acontecimentos encontrados.");

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
    els.list.appendChild(frag);
  }

  function renderDayEvents(key, events) {
    els.dayEvents.innerHTML = "";
    const selected = events.filter((ev) => dateKey(new Date(ev.start)) === key);
    if (!selected.length) return;
    const h = document.createElement("h3");
    h.textContent = fmtLongDate.format(new Date(selected[0].start));
    els.dayEvents.appendChild(h);
    selected.forEach((ev) => els.dayEvents.appendChild(renderEventCard(ev)));
  }

  function renderCalendar(events) {
    els.calendarTitle.textContent = fmtMonthYear.format(calendarCursor);
    els.calendarGrid.innerHTML = "";
    els.dayEvents.innerHTML = "";
    const year = calendarCursor.getFullYear(), month = calendarCursor.getMonth();
    const first = new Date(year, month, 1, 12), last = new Date(year, month + 1, 0, 12);

    for (let i = 0; i < first.getDay(); i++) {
      const blank = document.createElement("div");
      blank.className = "agenda-calendar-cell is-empty";
      els.calendarGrid.appendChild(blank);
    }

    for (let day = 1; day <= last.getDate(); day++) {
      const date = new Date(year, month, day, 12), key = dateKey(date);
      const matches = events.filter((ev) => dateKey(new Date(ev.start)) === key);
      const cell = document.createElement("button");
      cell.type = "button";
      cell.className = "agenda-calendar-cell" + (matches.length ? " has-events" : "");
      cell.innerHTML = '<span class="agenda-calendar-number">' + day + "</span>" +
        (matches.length ? '<span class="agenda-calendar-count">' + matches.length + "</span>" : "");
      if (matches.length) cell.addEventListener("click", () => renderDayEvents(key, events));
      els.calendarGrid.appendChild(cell);
    }

    const monthMatches = events.filter((ev) => {
      const d = new Date(ev.start);
      return d.getFullYear() === year && d.getMonth() === month;
    });
    els.status.textContent = monthMatches.length === 1 ? "1 acontecimento neste mês." : monthMatches.length + " acontecimentos neste mês.";
  }

  function filterSummaryLabels() {
    const labels = [];
    if (filters.period === "next30") labels.push("Próximos 30 dias");
    if (filters.period === "upcoming") labels.push("Próximos 90 dias");
    if (filters.period === "month") labels.push("Mês atual — completo");
    if (filters.period === "past30") labels.push("Últimos 30 dias");
    if (filters.period === "year") labels.push("Ano " + filters.year);
    if (filters.period === "custom") labels.push((filters.start || "…") + " a " + (filters.end || "…"));
    if (filters.types.size) labels.push(...Array.from(filters.types));
    if (filters.scopes.size) labels.push(...Array.from(filters.scopes));
    if (filters.parishes.size) labels.push(filters.parishes.size + " paróquia(s)");
    if (filters.cities.size) labels.push(filters.cities.size + " cidade(s)");
    if (!filters.cancelled) labels.push("somente confirmados");
    if (!filters.confirmed) labels.push("somente cancelados");
    if (els.includeLiturgy && els.includeLiturgy.checked) labels.push("com calendário litúrgico");
    return labels;
  }

  function renderActiveFilters() {
    els.activeFilters.innerHTML = "";
    const labels = filterSummaryLabels();
    const count = Math.max(0, labels.length - (filters.period === "upcoming" ? 1 : 0));
    els.filterCount.hidden = !count;
    els.filterCount.textContent = String(count);
    labels.forEach((label) => {
      const span = document.createElement("span");
      span.textContent = label;
      els.activeFilters.appendChild(span);
    });
  }

  function renderPrint(events) {
    els.printSummary.textContent = filterSummaryLabels().join(" · ");
    els.printList.innerHTML = "";
    let lastMonth = "";

    events.forEach((ev) => {
      const d = new Date(ev.start);
      const month = fmtMonthYear.format(d);
      if (month !== lastMonth) {
        const heading = document.createElement("h2");
        heading.className = "agenda-print-month";
        heading.textContent = month.charAt(0).toUpperCase() + month.slice(1);
        els.printList.appendChild(heading);
        lastMonth = month;
      }

      const row = document.createElement("div");
      row.className = "agenda-print-row";
      const time = ev.all_day ? (ev.source === "liturgico" ? "" : "Dia inteiro") : fmtTime.format(d);
      row.innerHTML = '<strong>' + esc(pdfDayLabel(ev)) + '</strong><span>' + esc(time) + '</span><div>' +
        esc(ev.title) + (ev.cancelled ? " — CANCELADO" : "") + "</div>";
      els.printList.appendChild(row);
    });

    const foot = document.getElementById("agenda-print-foot");
    if (foot) foot.textContent = "viasantacruz.com.br · Gerado em " + generatedStamp() + " · Programação sujeita a alterações a qualquer momento.";
  }

  function pdfSafeText(value) {
    return String(value || "")
      .replace(/[\u{1F300}-\u{1FAFF}]/gu, "")
      .replace(/[\u{25A0}-\u{25FF}]/gu, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function pdfWeekday(date) {
    const value = fmtWeekShort.format(date).replace(".", "").toLowerCase();
    return value.charAt(0).toUpperCase() + value.slice(1);
  }

  function pdfDayLabel(ev) {
    const start = new Date(ev.start);
    const end = new Date(ev.end);
    const effectiveEnd = ev.all_day ? new Date(end.getTime() - 1) : end;

    const startDay = fmtDay.format(start);
    const endDay = fmtDay.format(effectiveEnd);
    const startMonth = fmtMonthShort.format(start).replace(".", "").toLowerCase();
    const endMonth = fmtMonthShort.format(effectiveEnd).replace(".", "").toLowerCase();
    const startWeek = pdfWeekday(start);
    const endWeek = pdfWeekday(effectiveEnd);

    if (dateKey(start) === dateKey(effectiveEnd)) return startDay + " " + startWeek;
    if (monthKey(start) === monthKey(effectiveEnd)) return startDay + " " + startWeek + "–" + endDay + " " + endWeek;
    return startDay + " " + startWeek + " " + startMonth + "–" + endDay + " " + endWeek + " " + endMonth;
  }

  function generatedStamp() {
    return new Intl.DateTimeFormat("pt-BR", {
      day: "2-digit", month: "2-digit", year: "numeric",
      hour: "2-digit", minute: "2-digit", timeZone: TZ
    }).format(new Date());
  }

  function generatePdf(events) {
    const api = window.jspdf && window.jspdf.jsPDF;
    if (!api) {
      renderPrint(events);
      window.print();
      return;
    }

    const doc = new api({ unit: "mm", format: "a4", orientation: "portrait" });
    const marginX = 15;
    const pageWidth = 210;
    const pageHeight = 297;
    const usableWidth = pageWidth - marginX * 2;
    let y = 18;

    const nextPage = () => {
      doc.addPage();
      y = 18;
    };

    const ensure = (height) => {
      if (y + height > pageHeight - 18) nextPage();
    };

    doc.setFont("helvetica", "bold");
    doc.setFontSize(9);
    doc.text("DIOCESE DE JANAÚBA", marginX, y);
    y += 6;

    doc.setFont("times", "bold");
    doc.setFontSize(18);
    doc.text("Agenda Diocesana - seleção", marginX, y);
    y += 8;

    doc.setFont("helvetica", "normal");
    doc.setFontSize(8.5);
    const summary = pdfSafeText(filterSummaryLabels().join(" · "));
    if (summary) {
      const summaryLines = doc.splitTextToSize(summary, usableWidth);
      doc.text(summaryLines, marginX, y);
      y += summaryLines.length * 4 + 3;
    }

    doc.setDrawColor(190);
    doc.line(marginX, y, pageWidth - marginX, y);
    y += 6;

    let lastMonth = "";
    events.forEach((ev) => {
      const d = new Date(ev.start);
      const month = fmtMonthYear.format(d);

      if (month !== lastMonth) {
        ensure(12);
        doc.setFont("times", "bold");
        doc.setFontSize(13);
        doc.text(month.charAt(0).toUpperCase() + month.slice(1), marginX, y);
        y += 7;
        lastMonth = month;
      }

      const date = pdfSafeText(pdfDayLabel(ev));
      let time = "";
      if (!(ev.source === "liturgico" && ev.all_day)) {
        if (ev.all_day) time = "Dia inteiro";
        else time = pdfSafeText(fmtTime.format(d));
      }

      const cleanTitle = pdfSafeText(ev.title);
      const titleText = ev.cancelled ? "CANCELADO — " + cleanTitle : cleanTitle;
      const dateWidth = 36;
      const timeWidth = 22;
      const titleX = marginX + dateWidth + timeWidth;
      const titleLines = doc.splitTextToSize(titleText, pageWidth - marginX - titleX);
      const rowHeight = Math.max(5.8, titleLines.length * 4.2 + 0.8);
      ensure(rowHeight + 4);

      y += 1.8;

      doc.setFont("helvetica", "bold");
      doc.setFontSize(9);
      doc.setTextColor(0);
      doc.text(date, marginX, y);

      doc.setFont("helvetica", "normal");
      doc.setFontSize(8.5);
      if (time) doc.text(time, marginX + dateWidth, y);

      doc.setFont("helvetica", ev.cancelled ? "bold" : "normal");
      doc.setFontSize(9);
      if (ev.cancelled) doc.setTextColor(145, 55, 45);
      doc.text(titleLines, titleX, y);
      doc.setTextColor(0);

      y += rowHeight;
      doc.setDrawColor(225);
      doc.line(marginX, y, pageWidth - marginX, y);
      y += 1.8;
    });

    const stamp = generatedStamp();
    const pages = doc.getNumberOfPages();
    for (let page = 1; page <= pages; page++) {
      doc.setPage(page);
      doc.setDrawColor(210);
      doc.line(marginX, pageHeight - 13, pageWidth - marginX, pageHeight - 13);
      doc.setFont("helvetica", "normal");
      doc.setFontSize(7.2);
      doc.setTextColor(90);
      doc.text("viasantacruz.com.br · Gerado em " + stamp, marginX, pageHeight - 8);
      doc.text("Programação sujeita a alterações a qualquer momento.", pageWidth - marginX, pageHeight - 8, { align: "right" });
      doc.setTextColor(0);
    }

    const now = new Date();
    const filename = "agenda-diocesana-" + now.toISOString().slice(0, 10) + ".pdf";
    try {
      doc.save(filename);
    } catch {
      const url = doc.output("bloburl");
      window.open(url, "_blank", "noopener");
    }
  }

  function apply() {
    const events = filteredEvents();
    renderActiveFilters();
    renderPrint(events);
    if (currentView === "month") renderCalendar(events);
    else renderList(events);
  }

  function setView(view) {
    currentView = view;
    els.viewButtons.forEach((button) => button.classList.toggle("active", button.dataset.view === view));
    els.calendar.hidden = view !== "month";
    els.list.hidden = view === "month";
    apply();
  }

  function openFilters() {
    populateFilterChoices(currentEvents);
    document.querySelector('input[name="filter-period"][value="' + filters.period + '"]').checked = true;
    els.year.value = filters.year;
    els.start.value = filters.start;
    els.end.value = filters.end;
    els.confirmed.checked = filters.confirmed;
    els.cancelled.checked = filters.cancelled;
    els.filterModal.hidden = false;
    document.body.classList.add("filter-open");
  }

  function closeFilters() {
    els.filterModal.hidden = true;
    document.body.classList.remove("filter-open");
  }

  function clearFilters() {
    filters.period = "upcoming"; filters.types.clear(); filters.scopes.clear(); filters.parishes.clear(); filters.cities.clear();
    filters.confirmed = true; filters.cancelled = true; filters.start = ""; filters.end = "";
    closeFilters(); apply();
  }

  function refreshCombinedEvents() {
    currentEvents = els.includeLiturgy?.checked
      ? [...agendaEvents, ...liturgyEvents].sort((a, b) => new Date(a.start) - new Date(b.start))
      : [...agendaEvents];

    populateFilterChoices(currentEvents);
    apply();
  }

  async function load() {
    currentScope = "main";
    els.status.textContent = "Carregando agenda…";
    els.updated.textContent = "";
    els.filterButton.hidden = false;
    els.printButton.hidden = false;

    try {
      const [agendaResponse, liturgyResponse] = await Promise.all([
        fetch(API + "?scope=main&days=730", { cache: "no-store" }),
        fetch(API + "?scope=liturgico&days=730", { cache: "no-store" })
      ]);
      if (!agendaResponse.ok || !liturgyResponse.ok) throw new Error("http");

      const [agendaData, liturgyData] = await Promise.all([
        agendaResponse.json(),
        liturgyResponse.json()
      ]);

      agendaEvents = agendaData.events || [];
      liturgyEvents = liturgyData.events || [];
      refreshCombinedEvents();

      const future = currentEvents.find((ev) => new Date(ev.start) >= new Date());
      calendarCursor = future ? startOfMonth(new Date(future.start)) : startOfMonth(new Date());

      const allSources = [
        ...(agendaData.sources || []),
        ...(els.includeLiturgy?.checked ? (liturgyData.sources || []) : [])
      ];
      const dates = allSources
        .filter((s) => s.available && s.last_synced_at)
        .map((s) => new Date(s.last_synced_at))
        .filter((d) => !Number.isNaN(d.getTime()));
      const generated = new Date(agendaData.generated_at || liturgyData.generated_at);
      const ref = dates.length ? new Date(Math.min(...dates.map((d) => d.getTime()))) : generated;

      if (!Number.isNaN(ref.getTime())) {
        els.updated.textContent = "Dados sincronizados até " + fmtUpdated.format(ref) + ". Alterações posteriores podem ainda não aparecer aqui.";
      }
    } catch {
      els.status.textContent = "Não foi possível carregar a agenda agora. Tente novamente em alguns instantes.";
    }
  }

  els.search.addEventListener("input", apply);
  els.filterButton.addEventListener("click", openFilters);
  document.querySelectorAll("[data-close-filter]").forEach((el) => el.addEventListener("click", closeFilters));
  els.clearFilters.addEventListener("click", clearFilters);
  els.applyFilters.addEventListener("click", () => {
    filters.period = document.querySelector('input[name="filter-period"]:checked').value;
    filters.year = els.year.value;
    filters.start = els.start.value;
    filters.end = els.end.value;
    filters.types = selectedCheckboxes("types");
    filters.scopes = selectedCheckboxes("scopes");
    filters.parishes = selectedCheckboxes("parishes");
    filters.cities = selectedCheckboxes("cities");
    filters.confirmed = els.confirmed.checked;
    filters.cancelled = els.cancelled.checked;
    closeFilters(); apply();
  });
  els.parishSearch.addEventListener("input", () => {
    const term = normalize(els.parishSearch.value);
    Array.from(els.filterParishes.children).forEach((label) => { label.hidden = term && !label.dataset.search.includes(term); });
  });
  els.viewButtons.forEach((button) => button.addEventListener("click", () => setView(button.dataset.view || "list")));
  els.prevMonth.addEventListener("click", () => { calendarCursor = new Date(calendarCursor.getFullYear(), calendarCursor.getMonth() - 1, 1, 12); apply(); });
  els.nextMonth.addEventListener("click", () => { calendarCursor = new Date(calendarCursor.getFullYear(), calendarCursor.getMonth() + 1, 1, 12); apply(); });
  if (els.includeLiturgy) {
    els.includeLiturgy.addEventListener("change", () => {
      refreshCombinedEvents();
      const visible = els.includeLiturgy.checked ? "incluído" : "ocultado";
      els.status.textContent = "Calendário litúrgico " + visible + ".";
      setTimeout(() => apply(), 650);
    });
  }
  els.printButton.addEventListener("click", () => {
    const events = filteredEvents();
    if (!events.length) {
      els.status.textContent = "Não há acontecimentos nesta seleção para gerar o PDF.";
      return;
    }
    renderPrint(events);
    generatePdf(events);
  });
  document.addEventListener("keydown", (event) => { if (event.key === "Escape" && !els.filterModal.hidden) closeFilters(); });

  load();
})();