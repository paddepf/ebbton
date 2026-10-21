'use strict';

const settings = require('./settings');

/**
 * Minimaler ChurchTools-Client.
 * Authentifizierung über Personal Access Token:  Authorization: Login <token>
 */

/**
 * Gerade Anführungszeichen aus ChurchTools typografisch setzen: "Text" → „Text“, 'Text' → ‚Text‘, Apostroph ' → ’
 * (in Abschnittsnamen, Dateinamen und ID3-Titeln sähe man sonst die Schreibmaschinenzeichen). Öffnend ist ein Zeichen
 * am Anfang oder nach Leerraum bzw. Klammer, sonst schließend; ein einfaches schließt ein ‚ nur vor Leerraum,
 * Satzzeichen oder Textende, sonst ist es ein Apostroph („Gott's“).
 */
function typoQuotes(text) {
  if (typeof text !== 'string' || !/["']/.test(text)) return text;
  return text
    .replace(/(^|[\s(\[{\/–—-])"/g, '$1„')
    .replace(/"/g, '“')
    .replace(/(^|[\s(\[{\/–—-])'/g, '$1‚')
    .replace(/‚([^‚]*?)'(?=$|[\s.,;:!?)\]}–—-])/g, '‚$1‘')
    .replace(/'/g, '’');
}

function baseUrl() {
  const url = (settings.get('churchToolsUrl') || '').trim().replace(/\/+$/, '');
  if (!url) throw new Error('Es ist keine ChurchTools-Adresse hinterlegt.');
  return url;
}

async function requestRaw(pathname, params) {
  const token = await settings.churchToolsToken();
  if (!token) throw new Error('Es ist kein ChurchTools-Token hinterlegt.');

  const url = new URL(baseUrl() + pathname);
  Object.entries(params || {}).forEach(([k, v]) => {
    if (v == null) return;
    if (Array.isArray(v)) v.forEach((x) => url.searchParams.append(k + '[]', x));
    else url.searchParams.set(k, v);
  });

  // Die Zeitgrenze gilt auch für den Antwortkörper: Stockt er (WLAN, Proxy), hinge der Aufruf sonst ohne Ende.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    let res;
    try {
      res = await fetch(url, {
        headers: {
          Authorization: `Login ${token}`,
          Accept: 'application/json'
        },
        signal: controller.signal
      });
    } catch (err) {
      if (err.name === 'AbortError') throw new Error('ChurchTools antwortet nicht (Zeitüberschreitung).');
      throw new Error('ChurchTools ist nicht erreichbar: ' + err.message);
    }

    if (res.status === 401 || res.status === 403) {
      throw new Error('ChurchTools hat den Zugriff abgelehnt. Bitte Token prüfen.');
    }
    if (res.status === 502 || res.status === 503 || res.status === 504) {
      // Störung oder Sperre beim Anbieter (so im Oktober 2026: alle Instanzen wegen einer PHP-Lücke gesperrt).
      const err = new Error(`ChurchTools ist vorübergehend nicht erreichbar (Fehler ${res.status}, Störung beim Anbieter). ` +
        'Gottesdienst von Hand eintragen und den Ablauf aus einer Vorlage wählen.');
      err.status = res.status;
      throw err;
    }
    if (!res.ok) {
      const err = new Error(`ChurchTools meldet Fehler ${res.status}.`);
      err.status = res.status;
      throw err;
    }
    try {
      return await res.json();
    } catch (err) {
      if (err.name === 'AbortError') throw new Error('ChurchTools antwortet nicht (Zeitüberschreitung).');
      // z. B. eine HTML-Anmeldeseite bei falscher Adresse
      throw new Error('ChurchTools hat keine gültige Antwort geliefert. Bitte die Adresse prüfen.');
    }
  } finally {
    clearTimeout(timeout);
  }
}

async function request(pathname, params) {
  const json = await requestRaw(pathname, params);
  return json && json.data !== undefined ? json.data : json;
}

/** Holt alle Seiten einer Liste (ChurchTools liefert lange Listen seitenweise). */
async function requestAll(pathname, params) {
  const out = [];
  for (let page = 1; page <= 20; page++) {
    const json = await requestRaw(pathname, { ...params, page, limit: 100 });
    const data = json && json.data !== undefined ? json.data : json;
    if (Array.isArray(data)) out.push(...data);
    const pg = json?.meta?.pagination;
    if (!pg || !pg.lastPage || page >= pg.lastPage) break;
  }
  return out;
}

function isoDate(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Verbindung und Token prüfen. */
async function test() {
  const me = await request('/api/whoami');
  return {
    ok: true,
    name: me?.firstName ? `${me.firstName} ${me.lastName || ''}`.trim() : (me?.cmsUserId || 'Unbekannt')
  };
}

/**
 * Gottesdienste/Termine in einem Zeitraum.
 * @param {string} from ISO-Datum
 * @param {string} to   ISO-Datum
 */
async function listServices(from, to) {
  // ChurchTools behandelt `to` als exklusiv (from = to liefert nichts): einen Tag zugeben, danach nach Ortsdatum filtern.
  const [ty, tm, td] = String(to || from).split('-').map(Number);
  const toExclusive = isoDate(new Date(ty, tm - 1, td + 1));
  const raw = await requestAll('/api/events', { from, to: toExclusive });
  const list = raw.filter((e) => {
    const t = e.startDate ? new Date(e.startDate) : null;
    if (!t || Number.isNaN(+t)) return true;
    const day = isoDate(t);
    return day >= from && day <= (to || from);
  });
  // Optional nur bestimmte Kalender (Einstellung; leer = alle). Termine ohne Kalenderangabe bleiben.
  const wanted = (settings.get('churchToolsCalendarIds') || []).map(String);
  const filtered = wanted.length === 0 ? list : list.filter((e) => {
    const id = e.calendar?.id ?? e.calendarId ?? e.calendar_id;
    return id == null || wanted.includes(String(id));
  });
  return filtered
    .map((e) => ({
      id: e.id,
      name: e.name || e.caption || 'Gottesdienst',
      start: e.startDate || e.start_date || null,
      end: e.endDate || null,
      date: (e.startDate || '').slice(0, 10) || from
    }))
    .sort((a, b) => String(a.start).localeCompare(String(b.start)));
}

/** Gottesdienste von heute (mit Vorschlag des nächstliegenden). */
async function todaysServices() {
  const today = isoDate(new Date());
  const list = await listServices(today, today);
  return { date: today, services: list };
}

/**
 * Ablaufplan eines Termins.
 * Liefert eine flache Liste von Programmpunkten in Reihenfolge.
 */
async function agenda(eventId) {
  const data = await request(`/api/events/${eventId}/agenda`);
  const items = data?.items || data?.agendaItems || [];
  const flat = [];

  const walk = (list, headerTitle) => {
    // Überschriften kommen verschachtelt (mit Unterpunkten) oder als flache Liste (Überschrift, danach
    // ihre Punkte). In beiden Fällen wird der Titel zur Kategorie der folgenden Punkte.
    let currentHeader = headerTitle;
    (list || []).forEach((item) => {
      const title = typoQuotes(item.title || item.bezeichnung || 'Programmpunkt');
      if (item.type === 'header' || item.isHeader) {
        const children = item.items || item.children;
        if (children && children.length) walk(children, title);
        else currentHeader = title;
        return;
      }
      flat.push({
        id: item.id ?? null,
        title,
        category: currentHeader || item.serviceCategoryName || null,
        duration: item.duration ?? null,
        responsible: responsibleText(item),
        position: item.position ?? flat.length
      });
      if (item.items || item.children) walk(item.items || item.children, title);
    });
  };

  walk(items, null);
  flat.sort((a, b) => (a.position || 0) - (b.position || 0));
  return {
    id: data?.id ?? null,
    name: data?.name || null,
    items: flat
  };
}

/* ------------------------------------------------------- Personen und Dienste */

/** Name einer Person aus den verschiedenen Formen, in denen ChurchTools sie liefern kann. */
function personName(p) {
  if (!p) return '';
  if (typeof p === 'string') return p.trim();
  const inner = p.person || p;
  const attrs = inner.domainAttributes || inner;
  const full = [attrs.firstName || attrs.vorname, attrs.lastName || attrs.name_nachname || attrs.nachname]
    .filter(Boolean).join(' ').trim();
  return full || String(inner.title || inner.text || inner.displayName || '').trim();
}

/** Zuständige Person(en) eines Ablaufpunkts als Text, z. B. "Anna Beispiel, Ben Muster". */
function responsibleText(item) {
  const r = item.responsible ?? item.responsibles ?? item.responsiblePersons;
  if (!r) return null;
  const names = [];
  if (typeof r === 'string') names.push(r);
  else if (Array.isArray(r)) r.forEach((p) => names.push(personName(p)));
  else {
    // Verknüpfte Personen haben Vorrang vor dem Freitext (der meist denselben Namen trägt).
    if (Array.isArray(r.persons)) r.persons.forEach((p) => names.push(personName(p)));
    if (!names.some(Boolean) && r.text) names.push(String(r.text));
    if (!names.some(Boolean)) names.push(personName(r));
  }
  const unique = [...new Set(names.map((n) => String(n).trim()).filter(Boolean))];
  return unique.length ? unique.join(', ') : null;
}

let servicesCache = null;

/** Alle Dienste (Id -> Name), z. B. "Leitung", "Predigt". */
async function serviceNames() {
  if (servicesCache) return servicesCache;
  const data = await request('/api/services');
  const map = {};
  (Array.isArray(data) ? data : []).forEach((s) => { map[s.id] = s.name; });
  servicesCache = map;
  return map;
}

/**
 * Personen, die für einen Termin in der Dienstplanung eingetragen sind – gefiltert auf die
 * gewünschten Dienste (z. B. "Leitung", "Predigt"; Teilübereinstimmung, ohne Groß-/Kleinschreibung).
 * @returns {{suggestions: {role:string, name:string}[], found: number}}
 */
async function eventServices(eventId, wanted) {
  const wantedList = (wanted || []).map((w) => String(w).trim().toLowerCase()).filter(Boolean);

  const event = await request(`/api/events/${eventId}`, { include: 'eventServices' });
  const info = eventInfoText(event);
  if (wantedList.length === 0) return { suggestions: [], found: 0, info };
  const entries = event?.eventServices || event?.services || [];
  let names = {};
  try { names = await serviceNames(); } catch { /* Dienstnamen fehlen: dann nur Einträge mit eigenem Namen */ }

  const out = [];
  for (const es of entries) {
    const role = String(es.serviceName || names[es.serviceId] || es.service?.name || '').trim();
    if (!role || !wantedList.some((w) => role.toLowerCase().includes(w))) continue;
    let name = personName(es.person);
    // Manche Antworten tragen den Personennamen direkt unter "name"
    if (!name && es.name && String(es.name).trim().toLowerCase() !== role.toLowerCase()) name = String(es.name).trim();
    if (!name && es.personId) {
      try { name = personName(await request(`/api/persons/${es.personId}`)); } catch { /* ohne Namen überspringen */ }
    }
    if (name) out.push({ role, name });
  }
  return { suggestions: out, found: entries.length, info };
}

const ENTITIES = { nbsp: ' ', amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' };

/** Ein HTML-Entity in einem Durchgang (sonst würde aus „&amp;quot;“ ein Anführungszeichen statt „&quot;“). */
function decodeEntity(whole, name) {
  const lower = name.toLowerCase();
  if (lower[0] !== '#') return ENTITIES[lower];
  const code = lower[1] === 'x' ? parseInt(lower.slice(2), 16) : parseInt(lower.slice(1), 10);
  return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
}

/**
 * Infotext des Termins (z. B. „Kolosser 2,6-7 Verwurzelt in Christus“ bei der Bibelstunde): die erste Zeile
 * aus dem ersten gefüllten Feld, ohne HTML und doppelte Leerzeichen. Die Feldnamen sind nicht gegen eine echte
 * Instanz geprüft, deshalb werden mehrere gängige probiert.
 */
function eventInfoText(event) {
  for (const key of ['description', 'information', 'note', 'notes', 'info']) {
    const raw = event && event[key];
    if (typeof raw !== 'string') continue;
    const line = raw
      .replace(/<br\s*\/?>|<\/p>|<\/div>|<\/li>/gi, '\n')
      .replace(/<[^>]*>/g, '')
      .replace(/&(#x[0-9a-f]+|#\d+|nbsp|amp|quot|apos|lt|gt);/gi, decodeEntity)
      .split(/\r?\n/)
      .map((l) => l.replace(/\s+/g, ' ').trim())
      .find(Boolean);
    const text = typoQuotes(line);
    if (text) return text.length > 150 ? text.slice(0, 149).trimEnd() + '…' : text;
  }
  return null;
}

/** Kalender (für die Auswahl in den Einstellungen). */
async function listCalendars() {
  const data = await request('/api/calendars');
  return (Array.isArray(data) ? data : [])
    .map((c) => ({ id: c.id, name: c.name || c.nameTranslated || `Kalender ${c.id}` }))
    .sort((a, b) => String(a.name).localeCompare(String(b.name), 'de'));
}

/**
 * Rohantworten zu einem Termin für die Fehlersuche: genau die Anfragen, die `agenda` und `eventServices` stellen,
 * unverändert. Die Antwortform ist nicht gegen eine echte Instanz geprüft (siehe CLAUDE.md); mit dieser Datei lässt
 * sich nachsehen, wo Personen, Dienste und Infotext wirklich stehen. Ein Fehler bei einer Anfrage bricht die übrigen
 * nicht ab. Der Token steht nicht darin.
 */
async function rawDump(eventId, { requester = requestRaw } = {}) {
  const queries = [
    [`/api/events/${eventId}`, { include: 'eventServices' }],
    [`/api/events/${eventId}/agenda`, null],
    ['/api/services', null]
  ];
  const out = { erstellt: new Date().toISOString(), adresse: baseUrl(), termin: eventId, anfragen: [] };
  const run = async (pfad, params) => {
    try {
      out.anfragen.push({ pfad, params, antwort: await requester(pfad, params) });
    } catch (err) {
      out.anfragen.push({ pfad, params, fehler: err.message, status: err.status ?? null });
    }
  };
  for (const [pfad, params] of queries) await run(pfad, params);
  // Personen, die die Dienstplanung nur als Id nennt (höchstens drei, als Beispiel für die Form).
  const event = out.anfragen[0].antwort?.data;
  const ids = [...new Set((event?.eventServices || []).filter((es) => !es.person && es.personId).map((es) => es.personId))];
  for (const id of ids.slice(0, 3)) await run(`/api/persons/${id}`, null);
  return out;
}

/** Zwischenspeicher leeren, z. B. nach geänderter Adresse oder geändertem Token. */
function resetCache() {
  servicesCache = null;
}

module.exports = { test, listServices, listCalendars, todaysServices, agenda, eventServices, eventInfoText, rawDump, typoQuotes, resetCache, isoDate };
