/*
 * Roma Mobility - versione web.
 *
 * Stessa logica dell'app Expo, portata su una pagina sola:
 *  - le fermate arrivano dai due file GTFS in data/ (stops.txt e cotral_stops.txt, formato CSV);
 *  - gli orari arrivano da Transitland interrogata con lo stop_id della fermata;
 *  - la mappa e' Leaflet con le tessere OpenStreetMap, senza chiavi da pagare.
 */

"use strict";

/* ------------------------------------------------------------------ *
 * Configurazione
 * ------------------------------------------------------------------ */

const TRANSITLAND_BASE = "https://transit.land/api/v2/rest";
const ATAC_FEED = "f-sr-atac~romatpl~trenitalia";
const COTRAL_FEED = "f-cotral~lazio~italia";

// Su Netlify la chiave resta sul server, dentro la funzione netlify/functions/departures.js.
// Se la funzione non risponde (per esempio aprendo il sito in locale) si chiama Transitland
// direttamente con questa chiave, che pero' a quel punto e' leggibile da chiunque apra la pagina.
const PROXY_URL = "/api/departures";
const FALLBACK_API_KEY = "D40zc165Qo8cv9hvsZyiBxJDp5yeYASq";

const ROME = { lat: 41.9028, lon: 12.4964 };
const MARKER_MIN_ZOOM = 14; // sotto questo zoom niente pin: sarebbero migliaia
const MAX_MARKERS = 400;
const GPS_ZOOM = 17;

const WINDOW_OPTIONS = [30, 60, 90, 180];
const REFRESH_OPTIONS = [15, 30, 60];
const STORAGE = {
  favorites: "roma-mobility-web/favorites",
  settings: "roma-mobility-web/settings",
  lastPosition: "roma-mobility-web/last-position",
  seenVersion: "roma-mobility-web/seen-version",
};

// Cambia a ogni pubblicazione: chi apre l'app dopo un aggiornamento vede cosa c'e' di nuovo.
const APP_VERSION = "2026.09.27-1";
const APP_NEWS = "Tutti i numeri civici di Roma (archivio ufficiale ANNCSU), ricerca per locali e categorie con la distanza, e i tragitti con le stesse fermate uniti in una scheda con gli orari di tutte le linee.";

/* ------------------------------------------------------------------ *
 * Utilita'
 * ------------------------------------------------------------------ */

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

function normalizeText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function numberOrNull(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim().replace(",", ".");
  if (!text) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

// Toglie dal nome il codice che i file COTRAL ripetono in coda ("Velletri # CF952A").
function cleanStopName(value, code) {
  const text = String(value || "").trim();
  const codeText = String(code || "").trim();
  if (!codeText) return text.replace(/\s*#\s*\S+\s*$/, "").trim();
  const suffix = "#" + codeText;
  const lower = text.toLowerCase();
  const at = lower.lastIndexOf(suffix.toLowerCase());
  const cut = at >= 0 ? text.slice(0, at) : text.replace(/\s*#\s*\S+\s*$/, "");
  return cut.replace(/\s+/g, " ").trim();
}

function haversineMeters(a, b) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
}

function distanceLabel(meters) {
  if (!Number.isFinite(meters)) return "";
  return meters < 950 ? Math.round(meters) + " m" : (meters / 1000).toFixed(1).replace(".", ",") + " km";
}

function waitLabel(date, now = new Date()) {
  const minutes = Math.round((date.getTime() - now.getTime()) / 60000);
  if (minutes <= 0) return "in arrivo";
  if (minutes === 1) return "1 min";
  if (minutes < 60) return minutes + " min";
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? hours + " h " + rest + " min" : hours + " h";
}

// 75 -> "1 ora e 15 minuti", 180 -> "3 ore", 45 -> "45 minuti".
function timeWindowLabel(minutes) {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  const parts = [];
  if (hours) parts.push(hours + (hours === 1 ? " ora" : " ore"));
  if (rest) parts.push(rest + " minuti");
  return parts.join(" e ") || "0 minuti";
}

/* ------------------------------------------------------------------ *
 * Ora di Roma (il telefono potrebbe stare su un altro fuso)
 * ------------------------------------------------------------------ */

const romeClockFormat = new Intl.DateTimeFormat("it-IT", {
  timeZone: "Europe/Rome",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

const romePartsFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Rome",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

function romeParts(date = new Date()) {
  const parts = {};
  romePartsFormat.formatToParts(date).forEach((part) => {
    if (part.type !== "literal") parts[part.type] = part.value;
  });
  return parts;
}

function romeDateString(date = new Date()) {
  const p = romeParts(date);
  return p.year + "-" + p.month + "-" + p.day;
}

function romeSecondsOfDay(date = new Date()) {
  const p = romeParts(date);
  return Number(p.hour) * 3600 + Number(p.minute) * 60 + Number(p.second);
}

function formatClock(date) {
  return romeClockFormat.format(date);
}

// "25:10:00" (orario GTFS oltre la mezzanotte) -> secondi dall'inizio del giorno di servizio.
function clockToSeconds(clock) {
  const match = /^(\d{1,3}):(\d{2})(?::(\d{2}))?$/.exec(String(clock || "").trim());
  if (!match) return null;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3] || 0);
}

function daysBetweenIsoDates(isoA, isoB) {
  const a = Date.parse(isoA + "T12:00:00Z");
  const b = Date.parse(isoB + "T12:00:00Z");
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.round((a - b) / 86400000);
}


/* ------------------------------------------------------------------ *
 * Come si leggono i nomi
 * ------------------------------------------------------------------ */

// Nei file GTFS e' tutto in maiuscolo ("PIAVE/XX SETTEMBRE"): sullo schermo diventa "Piave/XX Settembre".
const KEEP_UPPERCASE = new Set(["MA", "MB", "MB1", "MC", "FS", "FL", "GRA", "XX", "II", "III", "IV", "VI", "VII", "VIII", "IX", "XI", "XII", "XIII", "XIV", "XV", "XX", "XXI"]);
const LOWERCASE_WORDS = new Set(["di", "da", "de", "del", "della", "dello", "dei", "degli", "delle", "e", "ed", "a", "al", "allo", "alla", "ai", "agli", "alle", "in", "su", "per", "con", "tra", "fra", "il", "lo", "la", "i", "gli", "le", "un", "uno", "una"]);

function prettyWord(word, index) {
  if (!word) return word;
  const upper = word.toUpperCase();
  if (KEEP_UPPERCASE.has(upper)) return upper;
  const lower = word.toLowerCase();
  // Prima le preposizioni: "DI" sembrerebbe anche un numero romano (501).
  if (index > 0 && LOWERCASE_WORDS.has(lower)) return lower;
  if (/^[IVXLCDM]+$/.test(upper) && upper.length > 1 && !LOWERCASE_WORDS.has(lower)) return upper;
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

function prettyName(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  let index = 0;
  // Se chi pubblica i dati ha gia' scritto in minuscolo si sistemano solo le preposizioni rimaste
  // maiuscole ("Arco DI Travertino"); altrimenti si riscrive tutto parola per parola.
  const words = text !== text.toUpperCase()
    ? text.replace(/(\s)(DI|DEL|DELLA|DELLO|DEI|DEGLI|DELLE|DA|DAL|DALLA|E|IN)(?=\s)/g, (match, space, word) => space + word.toLowerCase())
    : text.replace(/[^\s\/\-.,()]+/g, (word) => prettyWord(word, index++));
  // Abbreviazioni: "P.za", "L.go", "Staz.ne", "Osp.le" (non "Staz.Ne").
  return words.replace(/\b([A-Z][a-z]*)\.(Za|Zza|Go|Le|So|Ne|Lo|Li|Ni)\b/g, (match, first, second) => first + "." + second.toLowerCase());
}

// I file COTRAL scrivono "COMUNE | Luogo": sullo schermo e' piu' naturale "Luogo, Comune".
function prettyCotralName(value) {
  const parts = String(value || "").split("|").map((part) => part.trim()).filter(Boolean);
  if (parts.length < 2) return prettyName(parts[0] || value);
  const town = prettyName(parts[0]);
  const place = prettyName(parts.slice(1).join(" "));
  return place + ", " + town;
}

// I feed chiamano le metro "MEA", "MEB1": sulle banchine e sui cartelli c'e' scritto MA, MB1.
function prettyLineName(value) {
  const text = String(value || "").trim().toUpperCase();
  const metro = /^ME([ABC]1?)$/.exec(text);
  if (metro) return "M" + metro[1];
  return text.replace(/^0+(?=\d)/, "");
}

// Il colore segue le linee vere: metro A arancio, B blu, C verde; COTRAL blu scuro; bus in grigio.
function lineTone(row) {
  const line = prettyLineName(row.line);
  if (line === "MA") return "tone-ma";
  if (line === "MB" || line === "MB1") return "tone-mb";
  if (line === "MC") return "tone-mc";
  if (row.operator === "COTRAL") return "tone-cotral";
  return "tone-bus";
}

/* ------------------------------------------------------------------ *
 * Lettura dei file GTFS (.txt)
 * ------------------------------------------------------------------ */

function parseCsvLine(line) {
  const output = [];
  let current = "";
  let quoted = false;
  const text = String(line || "");
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"' && quoted && text[index + 1] === '"') {
      current += '"';
      index += 1;
      continue;
    }
    if (char === '"') {
      quoted = !quoted;
      continue;
    }
    if (char === "," && !quoted) {
      output.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  output.push(current.trim());
  return output;
}

// Regge tutti e due i dialetti dei file: stops.txt (LF, virgolette solo sui nomi)
// e cotral_stops.txt (BOM iniziale, CRLF, tutti i campi tra virgolette).
function parseCsv(text) {
  const lines = String(text || "")
    .replace(/^﻿/, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .filter((line) => line.trim());
  if (!lines.length) return [];
  const headers = parseCsvLine(lines[0]).map((value) => value.trim());
  return lines.slice(1).map((line) => {
    const values = parseCsvLine(line);
    const row = {};
    headers.forEach((header, index) => {
      row[header] = values[index] === undefined ? "" : values[index];
    });
    return row;
  });
}

function metroLineFromStopId(stopId) {
  const raw = String(stopId || "").toUpperCase();
  if (raw.startsWith("C")) return "C";
  if (raw.startsWith("B1")) return "B1";
  if (raw.startsWith("B")) return "B";
  if (raw.startsWith("A")) return "A";
  return "";
}

// Senza stop_times.txt non si sa quali linee servono la fermata: la metro si riconosce dal
// codice (AD12, BP8...), tutto il resto e' superficie.
function isMetroStopId(stopId) {
  return /^[ABC][A-Z0-9]+$/.test(String(stopId || "").trim().toUpperCase());
}

function parseAtacStops(rows) {
  const stops = [];
  rows.forEach((row) => {
    const stopId = String(row.stop_id || "").trim();
    const lat = numberOrNull(row.stop_lat);
    const lon = numberOrNull(row.stop_lon);
    if (!stopId || lat === null || lon === null) return;
    const code = String(row.stop_code || stopId).trim();
    const metro = isMetroStopId(stopId);
    stops.push({
      id: "atac:" + stopId,
      operator: "ATAC",
      feed: ATAC_FEED,
      stopId,
      code,
      name: prettyName(cleanStopName(row.stop_name || "Fermata", code)),
      lat,
      lon,
      mode: metro ? "Metro" : "Bus",
      metroLine: metro ? metroLineFromStopId(stopId) : "",
    });
  });

  // Le banchine della metro diventano una stazione sola: i file ATAC non hanno parent_station,
  // quindi si raggruppa per nome + linea (Termini A e Termini B restano due stazioni distinte).
  const stations = new Map();
  const plain = [];
  stops.forEach((stop) => {
    if (stop.mode !== "Metro") {
      plain.push(stop);
      return;
    }
    const key = normalizeText(stop.name) + "|" + stop.metroLine;
    if (!stations.has(key)) stations.set(key, []);
    stations.get(key).push(stop);
  });

  stations.forEach((children, key) => {
    const first = children[0];
    const sorted = children.slice().sort((a, b) => a.stopId.localeCompare(b.stopId));
    plain.push({
      id: "metro:" + key,
      operator: "ATAC",
      feed: ATAC_FEED,
      stopId: first.stopId,
      code: "Metro " + first.metroLine,
      name: first.name,
      lat: sorted.reduce((sum, item) => sum + item.lat, 0) / sorted.length,
      lon: sorted.reduce((sum, item) => sum + item.lon, 0) / sorted.length,
      mode: "MetroStation",
      metroLine: first.metroLine,
      children: sorted,
    });
  });

  return plain;
}

function parseCotralStops(rows) {
  const stops = [];
  rows.forEach((row) => {
    const stopId = String(row.stop_id || "").trim();
    const lat = numberOrNull(row.stop_lat);
    const lon = numberOrNull(row.stop_lon);
    if (!stopId || lat === null || lon === null) return;
    stops.push({
      id: "cotral:" + stopId,
      operator: "COTRAL",
      feed: COTRAL_FEED,
      stopId,
      code: stopId,
      name: prettyCotralName(cleanStopName(row.stop_name || "Fermata Cotral", stopId)),
      lat,
      lon,
      mode: "Cotral",
      metroLine: "",
    });
  });
  return stops;
}

function withSearchText(stop) {
  const childCodes = (stop.children || []).map((child) => child.code + " " + child.stopId).join(" ");
  stop.search = normalizeText([stop.code, stop.stopId, stop.name, stop.operator, stop.metroLine, childCodes].join(" "));
  return stop;
}

async function loadStops() {
  const read = async (path) => {
    const response = await fetch(path, { cache: "force-cache" });
    if (!response.ok) throw new Error("non riesco a leggere " + path + " (HTTP " + response.status + ")");
    return response.text();
  };

  const [atacText, cotralText] = await Promise.all([
    read("data/stops.txt"),
    read("data/cotral_stops.txt").catch((error) => {
      console.warn("cotral_stops.txt non caricato:", error);
      return "";
    }),
  ]);

  const atac = parseAtacStops(parseCsv(atacText));
  if (!atac.length) throw new Error("stops.txt non contiene fermate con coordinate valide");
  const cotral = cotralText ? parseCotralStops(parseCsv(cotralText)) : [];
  return atac.concat(cotral).map(withSearchText);
}


/* ------------------------------------------------------------------ *
 * Orari da Transitland (interrogata con lo stop_id della fermata)
 * ------------------------------------------------------------------ */

let proxyAvailable = null; // null = da scoprire, true = funzione Netlify attiva, false = chiamata diretta

function departureParams(windowMinutes) {
  return {
    relative_date: "today",
    next: String(Math.max(10, windowMinutes) * 60),
    // Con use_service_window=true Transitland risponde con lo stesso giorno della settimana ma di
    // un'altra data: tornavano le corse di sette giorni dopo, e senza nessuna previsione in tempo reale.
    use_service_window: "false",
    limit: "80",
    include_alerts: "false",
  };
}

// Ripiego per i feed fermi al passato (COTRAL e' aggiornato all'estate 2025): senza rimappatura
// non tornerebbe nessuna corsa.
function fallbackParams(windowMinutes) {
  return Object.assign(departureParams(windowMinutes), { use_service_window: "true" });
}

// Chiede qualcosa a Transitland: prima dalla funzione Netlify (la chiave resta sul server),
// se non c'e' (sito aperto in locale) direttamente, con la chiave di riserva.
async function requestTransitland(proxyQuery, directPath) {
  if (proxyAvailable !== false) {
    try {
      const response = await fetch(PROXY_URL + "?" + proxyQuery.toString());
      if (response.ok) {
        proxyAvailable = true;
        return response.json();
      }
      // 404 = la funzione non c'e' (sito aperto in locale o senza Netlify Functions).
      if (response.status === 404 || response.status === 405) proxyAvailable = false;
      else throw new Error("il servizio orari ha risposto " + response.status);
    } catch (error) {
      if (proxyAvailable === true) throw error;
      proxyAvailable = false;
    }
  }

  const response = await fetch(TRANSITLAND_BASE + directPath, {
    headers: { Accept: "application/json", apikey: FALLBACK_API_KEY },
  });
  if (response.status === 401 || response.status === 403) throw new Error("chiave Transitland rifiutata o scaduta");
  if (!response.ok) throw new Error("Transitland ha risposto " + response.status);
  return response.json();
}

async function requestDepartures(stop, params) {
  const key = stop.feed + ":" + stop.stopId;
  const query = new URLSearchParams(params);
  const proxyQuery = new URLSearchParams(params);
  proxyQuery.set("stop", key);
  const encodedKey = key.split(":").map(encodeURIComponent).join(":");
  return requestTransitland(proxyQuery, "/stops/" + encodedKey + "/departures?" + query.toString());
}

// Tutte le fermate di una corsa, in ordine, con i loro orari: e' da qui che escono le fermate successive.
const tripCache = new Map();

async function requestTrip(routeId, tripId) {
  const cacheKey = routeId + "/" + tripId;
  if (tripCache.has(cacheKey)) return tripCache.get(cacheKey);
  const proxyQuery = new URLSearchParams({ route: String(routeId), trip: String(tripId) });
  const payload = await requestTransitland(proxyQuery, "/routes/" + encodeURIComponent(routeId) + "/trips/" + encodeURIComponent(tripId));
  const trip = Array.isArray(payload?.trips) ? payload.trips[0] : null;
  if (!trip || !Array.isArray(trip.stop_times)) throw new Error("corsa non trovata");
  tripCache.set(cacheKey, trip);
  return trip;
}

function collectDepartures(payload) {
  if (Array.isArray(payload?.departures)) return payload.departures;
  if (Array.isArray(payload?.stops)) {
    return payload.stops.flatMap((stop) => (Array.isArray(stop?.departures) ? stop.departures : []));
  }
  return [];
}

function parseIsoInstant(value) {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time) : null;
}

// Trasforma una partenza grezza in una riga da mostrare.
function mapDeparture(raw, stop, platformLabel) {
  const scheduledIso = raw?.departure?.scheduled_local || raw?.arrival?.scheduled_local || null;
  const estimatedIso = raw?.departure?.estimated_local || raw?.arrival?.estimated_local || null;
  const scheduledClock = raw?.departure?.scheduled || raw?.departure_time || raw?.arrival?.scheduled || null;
  const delay = raw?.departure?.delay ?? raw?.arrival?.delay ?? null;
  const relationship = String(raw?.schedule_relationship || "").toUpperCase();
  const isStatic = relationship === "STATIC" || relationship === "NO_DATA";

  const today = romeDateString();
  const serviceDate = /^\d{4}-\d{2}-\d{2}$/.test(String(raw?.service_date || "")) ? raw.service_date : today;
  // Se il feed non copre oggi, Transitland risponde con un giorno equivalente di un'altra data:
  // l'orario vale come indicazione, quindi lo si riporta a oggi invece di mostrarlo fra mesi.
  const approximate = Math.abs(daysBetweenIsoDates(serviceDate, today)) > 1;

  let date = null;
  if (!approximate) {
    date = parseIsoInstant(estimatedIso) || parseIsoInstant(scheduledIso);
  }
  if (!date) {
    const seconds = clockToSeconds(scheduledClock);
    if (seconds === null) return null;
    // Differenza rispetto all'orologio di Roma: niente conti sui fusi, va bene anche dopo la mezzanotte.
    let delta = seconds - romeSecondsOfDay();
    if (delta < -6 * 3600) delta += 86400;
    date = new Date(Date.now() + delta * 1000);
  }

  const isRealtime = !approximate && !isStatic && Boolean(estimatedIso || (delay !== null && delay !== undefined));
  const scheduledDate = parseIsoInstant(scheduledIso);
  const line = String(
    raw?.trip?.route?.route_short_name || raw?.trip?.route?.route_long_name || raw?.trip?.route?.route_id || "",
  ).trim();
  const shortLine = prettyLineName(line);
  const escapedLine = shortLine.replace(/[.*+?^${}()|[\]\\]/g, (char) => "\\" + char);
  const lineSuffix = new RegExp("\\s*\\(" + escapedLine + "\\)\\s*$", "i");
  const destination = String(raw?.trip?.trip_headsign || raw?.stop_headsign || raw?.trip?.route?.route_long_name || "")
    .replace(/\s*#\s*\S+\s*$/, "")
    // La linea e' gia' scritta nella targhetta accanto: "Anagnina (MA)" diventa "Anagnina".
    .replace(lineSuffix, "")
    .trim();

  // Di quanto il mezzo e' avanti o indietro rispetto al programma: serve per stimare le fermate dopo.
  const estimatedDate = parseIsoInstant(estimatedIso);
  const offsetSeconds = isRealtime && estimatedDate && scheduledDate
    ? Math.round((estimatedDate.getTime() - scheduledDate.getTime()) / 1000)
    : 0;

  return {
    key: [raw?.trip?.trip_id || "", line, destination, formatClock(date), platformLabel || ""].join("|"),
    routeId: raw?.trip?.route?.id || null,
    tripId: raw?.trip?.id || null,
    stopSequence: Number.isFinite(Number(raw?.stop_sequence)) ? Number(raw.stop_sequence) : null,
    fromStopId: stop.stopId,
    fromFeed: stop.feed,
    offsetSeconds,
    line: prettyLineName(line) || "-",
    operator: stop.operator,
    destination: prettyName(destination) || "Direzione sconosciuta",
    platformLabel: platformLabel || "",
    date,
    displayTime: formatClock(date),
    scheduledTime: scheduledDate ? formatClock(scheduledDate) : null,
    delayMinutes: delay === null || delay === undefined ? null : Math.round(delay / 60),
    isRealtime,
    approximate,
  };
}

function sortAndDedupe(rows, windowMinutes) {
  const now = Date.now();
  const end = now + windowMinutes * 60000;
  const seen = new Map();
  rows
    .filter((row) => row && row.date.getTime() > now - 60000 && row.date.getTime() <= end)
    .sort((a, b) => a.date - b.date)
    .forEach((row) => {
      const existing = seen.get(row.key);
      if (!existing || (row.isRealtime && !existing.isRealtime)) seen.set(row.key, row);
    });
  return Array.from(seen.values()).sort((a, b) => a.date - b.date);
}

// Il calendario COTRAL su Transitland si ferma all'agosto 2025 (il server COTRAL ha un certificato
// scaduto e Transitland non riesce piu' a scaricarlo): per oggi non c'e' nessuna corsa. Si chiede
// quindi subito il giorno equivalente di quel calendario, e su 6 ore, perche' i COTRAL passano di rado.
const COTRAL_WINDOW_MINUTES = 360;

function isCotral(stop) {
  return stop && stop.feed === COTRAL_FEED;
}

// Una fermata normale e' una sola chiamata; una stazione della metro sono le sue banchine.
async function loadDepartures(stop, windowMinutes) {
  if (isCotral(stop)) {
    const cotralWindow = Math.max(windowMinutes, COTRAL_WINDOW_MINUTES);
    const payload = await requestDepartures(stop, fallbackParams(cotralWindow));
    const rows = collectDepartures(payload).map((item) => mapDeparture(item, stop, "")).filter(Boolean);
    return sortAndDedupe(rows, cotralWindow);
  }

  const targets = stop.mode === "MetroStation" && stop.children?.length
    ? stop.children.map((child) => ({ stop: child, label: child.code }))
    : [{ stop, label: "" }];

  const results = await Promise.all(
    targets.map(async ({ stop: target, label }) => {
      const payload = await requestDepartures(target, departureParams(windowMinutes));
      // Il calendario ATAC e' aggiornato: se oggi non passa niente (una linea sospesa, come il tram a
      // Rossini) la scheda resta vuota, invece di ripescare corse di un altro giorno segnate con "~".
      return collectDepartures(payload)
        .map((item) => mapDeparture(item, target, label))
        .filter((row) => row && !row.approximate);
    }),
  );

  return sortAndDedupe(results.flat(), windowMinutes);
}

/* ------------------------------------------------------------------ *
 * Stato salvato nel telefono
 * ------------------------------------------------------------------ */

function readStorage(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (error) {
    return fallback;
  }
}

function writeStorage(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (error) {
    // Spazio pieno o navigazione privata: le preferenze non si salvano, l'app funziona lo stesso.
  }
}

const state = {
  stops: [],
  byId: new Map(),
  favorites: readStorage(STORAGE.favorites, {}),
  settings: Object.assign(
    { windowMinutes: 60, refreshSeconds: 30, theme: "auto", locationAllowed: false },
    readStorage(STORAGE.settings, {}),
  ),
  position: null,
  filter: "tutte",
  query: "",
  openStop: null,
  directionFilter: "",
  refreshTimer: null,
};

function isFavorite(stop) {
  return Boolean(state.favorites[stop.id]);
}

function toggleFavorite(stop) {
  if (state.favorites[stop.id]) delete state.favorites[stop.id];
  else state.favorites[stop.id] = true;
  writeStorage(STORAGE.favorites, state.favorites);
}

function saveSettings() {
  writeStorage(STORAGE.settings, state.settings);
}


/* ------------------------------------------------------------------ *
 * Tema
 * ------------------------------------------------------------------ */

const THEMES = [
  { value: "auto", label: "Automatico" },
  { value: "light", label: "Chiaro" },
  { value: "dark", label: "Scuro" },
];

// Colore della barra dell'orologio di iOS: bianco sul chiaro, blu notte sullo scuro.
const BAR_LIGHT = "#ffffff";
const BAR_DARK = "#101c33";

// Colore della striscia dell'orologio. Da iOS 26 Safari non legge piu' theme-color: usa lo sfondo del
// body, o un elemento fixed largo quanto lo schermo se ce n'e' uno in cima (per questo l'impianto
// della pagina non ne ha: vedi il commento su body in styles.css).
function setBarColor(color) {
  // iOS 26: la striscia e' lo sfondo del body. Scriverlo direttamente nello stile la ridipinge subito
  // (col solo cambio della variabile CSS iOS puo' aspettare il ridisegno successivo).
  document.body.style.backgroundColor = color;
  // iOS fino al 18 e Android usano ancora theme-color.
  const meta = document.getElementById("theme-color");
  if (meta) meta.setAttribute("content", color);
}

function darkNow() {
  if (state.settings.theme === "dark") return true;
  if (state.settings.theme === "light") return false;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function applyTheme() {
  const root = document.documentElement;
  if (state.settings.theme === "auto") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", state.settings.theme);

  const dark = darkNow();
  setBarColor(dark ? BAR_DARK : BAR_LIGHT);
  if (map) {
    applyTiles();
    refreshMarkers();
  }
}

/* ------------------------------------------------------------------ *
 * Mappa
 * ------------------------------------------------------------------ */

let map = null;
let markerLayer = null;
let meMarker = null;
const grid = new Map(); // indice a celle: con 21.000 fermate scorrerle tutte a ogni spostamento e' troppo
const CELL = 0.01;

// Le tessere restano quelle libere di OpenStreetMap; il tema cambia solo come vengono rese,
// smorzate sul chiaro e scurite sullo scuro, cosi' i pallini colorati delle fermate risaltano.
const LIGHT_TILES = "saturate(0.78) brightness(1.03) contrast(0.96)";
const DARK_TILES = "invert(1) hue-rotate(180deg) saturate(0.55) brightness(0.92) contrast(0.9)";

function applyTiles() {
  const pane = document.querySelector(".leaflet-tile-pane");
  if (pane) pane.style.filter = darkNow() ? DARK_TILES : LIGHT_TILES;
}

function cellKey(lat, lon) {
  return Math.floor(lat / CELL) + ":" + Math.floor(lon / CELL);
}

function buildGrid(stops) {
  grid.clear();
  stops.forEach((stop) => {
    const key = cellKey(stop.lat, stop.lon);
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key).push(stop);
  });
}

function stopsInBounds(bounds) {
  const south = bounds.getSouth();
  const north = bounds.getNorth();
  const west = bounds.getWest();
  const east = bounds.getEast();
  const found = [];
  for (let row = Math.floor(south / CELL); row <= Math.floor(north / CELL); row += 1) {
    for (let col = Math.floor(west / CELL); col <= Math.floor(east / CELL); col += 1) {
      const cell = grid.get(row + ":" + col);
      if (!cell) continue;
      cell.forEach((stop) => {
        if (stop.lat >= south && stop.lat <= north && stop.lon >= west && stop.lon <= east) found.push(stop);
      });
      if (found.length > MAX_MARKERS * 4) return found;
    }
  }
  return found;
}

// Gli stessi colori delle linee vere, gli stessi del logo.
const TONES = {
  "tone-ma": "#e08a2e",
  "tone-mb": "#2f7fd1",
  "tone-mc": "#4e9a5f",
  "tone-cotral": "#1b2e4f",
  "tone-bus": "#7c8aa3",
};

// Le preferite sono sempre gialle, sulla mappa e negli elenchi.
const FAVORITE_COLOR = "#f2c230";

function stopTone(stop) {
  if (stop.mode === "MetroStation") return "tone-m" + String(stop.metroLine || "a").toLowerCase().charAt(0);
  if (stop.operator === "COTRAL") return "tone-cotral";
  return "tone-bus";
}

function refreshMarkers() {
  if (!map || !markerLayer) return;
  markerLayer.clearLayers();
  // Con un percorso aperto sulla mappa si vede solo quello, senza i pallini di tutte le fermate.
  if (nav.shown) return;
  const hint = $("#map-hint");
  const far = map.getZoom() < MARKER_MIN_ZOOM;
  // Con un percorso sulla mappa l'avviso non serve.
  hint.hidden = !far || Boolean(nav.shown);

  const center = map.getCenter();
  const from = { lat: center.lat, lon: center.lng };
  // Da lontano restano solo le preferite: le tue fermate si trovano sempre.
  const inView = far
    ? state.stops.filter((stop) => isFavorite(stop) && map.getBounds().contains([stop.lat, stop.lon]))
    : stopsInBounds(map.getBounds());
  const visible = inView
    .sort((a, b) => haversineMeters(from, a) - haversineMeters(from, b))
    .slice(0, MAX_MARKERS)
    // Le preferite si disegnano per ultime, sopra le altre.
    .sort((a, b) => Number(isFavorite(a)) - Number(isFavorite(b)));

  // Piu' ci si avvicina, piu' i pallini crescono: da lontano restano puntini discreti.
  const zoom = map.getZoom();
  const base = zoom >= 18 ? 7 : zoom >= 17 ? 6 : zoom >= 16 ? 5 : 4;
  const ring = darkNow() ? BAR_DARK : "#ffffff";

  visible.forEach((stop) => {
    const station = stop.mode === "MetroStation";
    const favorite = isFavorite(stop);
    const marker = L.circleMarker([stop.lat, stop.lon], {
      radius: (station ? base + 2.5 : base) + (favorite ? 1.5 : 0),
      color: ring,
      weight: station || favorite ? 2.5 : 1.6,
      fillColor: favorite ? FAVORITE_COLOR : TONES[stopTone(stop)],
      fillOpacity: 1,
    });
    marker.on("click", () => openStop(stop));
    marker.bindTooltip(stop.name, { direction: "top", offset: [0, -8], className: "stop-tip" });
    marker.addTo(markerLayer);
  });
}

function initMap() {
  // Si riparte da dove eri l'ultima volta: la mappa e' subito sulle tue fermate, anche prima del GPS.
  const last = readStorage(STORAGE.lastPosition, null);
  const start = last && Number.isFinite(last.lat) ? [last.lat, last.lon] : [ROME.lat, ROME.lon];
  map = L.map("map", { preferCanvas: true, zoomControl: false, attributionControl: true }).setView(start, last ? 16 : 13);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(map);
  applyTiles();
  markerLayer = L.layerGroup().addTo(map);
  map.on("moveend zoomend", refreshMarkers);
  if (last) state.position = { lat: last.lat, lon: last.lon };
  refreshMarkers();
}

function centerMap(lat, lon, zoom) {
  if (!map) return;
  map.setView([lat, lon], zoom || Math.max(map.getZoom(), 16), { animate: true });
}

function showPosition(coords, zoom) {
  state.position = { lat: coords.latitude, lon: coords.longitude };
  writeStorage(STORAGE.lastPosition, { lat: coords.latitude, lon: coords.longitude, at: Date.now() });
  if (!map) return;
  if (meMarker) meMarker.remove();
  meMarker = L.circleMarker([coords.latitude, coords.longitude], {
    radius: 7,
    color: darkNow() ? BAR_DARK : "#ffffff",
    weight: 3,
    fillColor: "#2f7fd1",
    fillOpacity: 1,
  }).addTo(map);
  if (zoom) map.setView([coords.latitude, coords.longitude], zoom);
}

// Con silenzioso = true (la ricerca automatica all'apertura) un tentativo fallito non disturba.
function askPosition(zoom, silenzioso) {
  const button = $("#btn-gps");
  if (!navigator.geolocation) {
    if (!silenzioso) toast("Questo browser non sa dirmi dove sei.");
    return;
  }
  button.classList.add("is-busy");
  navigator.geolocation.getCurrentPosition(
    (result) => {
      button.classList.remove("is-busy");
      // Il primo si' resta salvato: dalle prossime aperture la posizione si cerca da sola.
      if (!state.settings.locationAllowed) {
        state.settings.locationAllowed = true;
        saveSettings();
      }
      showPosition(result.coords, zoom);
      refreshMarkers();
      renderList();
    },
    (error) => {
      button.classList.remove("is-busy");
      if (error && error.code === 1) {
        state.settings.locationAllowed = false;
        saveSettings();
      }
      if (!silenzioso) toast("Non trovo la tua posizione. Controlla di averla attivata per questo sito.");
    },
    { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 },
  );
}

let toastTimer = null;

function toast(message) {
  const box = $("#toast");
  box.textContent = message;
  box.hidden = false;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    box.hidden = true;
  }, 4200);
}

/* ------------------------------------------------------------------ *
 * Sezioni
 * ------------------------------------------------------------------ */

function showView(name) {
  $$(".view").forEach((view) => {
    view.hidden = view.id !== "view-" + name;
  });
  $$(".tab").forEach((tab) => {
    const on = tab.dataset.view === name;
    tab.classList.toggle("is-on", on);
    if (on) tab.setAttribute("aria-current", "page");
    else tab.removeAttribute("aria-current");
  });
  if (name === "map" && map) window.setTimeout(() => map.invalidateSize(), 60);
  if (name === "list") renderList();
  // Il rullo si posiziona solo quando e' visibile (nascosto non ha misure).
  if (name === "settings") window.setTimeout(syncWheel, 0);
}

/* ------------------------------------------------------------------ *
 * Ricerca: fermate nei file, vie e piazze da OpenStreetMap
 * ------------------------------------------------------------------ */

const placeCache = new Map();
let placeTimer = null;
let placeToken = 0;

// Il riquadro tiene la ricerca dentro il Lazio, cosi' "Via Roma" non porta a Milano.
const LAZIO_VIEWBOX = "11.35,42.95,14.05,40.95";

async function searchPlaces(query) {
  const key = query.toLowerCase();
  if (placeCache.has(key)) return placeCache.get(key);
  const url =
    "https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&addressdetails=1&accept-language=it" +
    "&countrycodes=it&bounded=1&viewbox=" + LAZIO_VIEWBOX + "&q=" + encodeURIComponent(query);
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error("ricerca luoghi non disponibile");
  const payload = await response.json();
  const seen = new Set();
  const places = payload
    .filter((item) => Number.isFinite(Number(item.lat)) && Number.isFinite(Number(item.lon)))
    .map((item) => {
      const address = item.address || {};
      const name = item.name || String(item.display_name || "").split(",")[0];
      const town = address.city || address.town || address.village || address.municipality || "";
      return { name: name.trim(), town: town.trim(), lat: Number(item.lat), lon: Number(item.lon) };
    })
    .filter((place) => {
      const placeKey = place.name.toLowerCase() + "|" + place.town.toLowerCase();
      if (seen.has(placeKey)) return false;
      seen.add(placeKey);
      return true;
    });
  placeCache.set(key, places);
  return places;
}

function schedulePlaceSearch() {
  window.clearTimeout(placeTimer);
  const query = state.query.trim();
  const list = $("#place-list");
  if (query.length < 3 || state.filter !== "tutte") {
    list.hidden = true;
    list.innerHTML = "";
    return;
  }
  // Mezzo secondo di pausa: si interroga OpenStreetMap solo quando si smette di scrivere.
  placeTimer = window.setTimeout(async () => {
    const token = ++placeToken;
    try {
      const places = await searchPlaces(query);
      if (token !== placeToken) return;
      renderPlaces(places);
    } catch (error) {
      if (token !== placeToken) return;
      list.hidden = true;
      list.innerHTML = "";
    }
  }, 500);
}

function renderPlaces(places) {
  const list = $("#place-list");
  if (!places.length) {
    list.hidden = true;
    list.innerHTML = "";
    return;
  }

  list.hidden = false;
  list.innerHTML = places
    .map((place, index) => {
      const where = place.town && place.town !== place.name ? "<small>" + escapeHtml(place.town) + "</small>" : "";
      return (
        '<li><button type="button" class="stop-row" data-place="' + index + '">' +
        '<span class="badge tone-place"><svg viewBox="0 0 24 24" aria-hidden="true">' +
        '<path d="M12 21.5s7-6.1 7-11.2A7 7 0 0 0 5 10.3c0 5.1 7 11.2 7 11.2Z"/><circle cx="12" cy="10" r="2.4"/>' +
        "</svg></span>" +
        '<span class="stop-name">' + escapeHtml(place.name) + where + "</span>" +
        "</button></li>"
      );
    })
    .join("");

  list.querySelectorAll("[data-place]").forEach((button) => {
    button.addEventListener("click", () => {
      const place = places[Number(button.dataset.place)];
      if (!place) return;
      showView("map");
      centerMap(place.lat, place.lon, 17);
      toast("Sei su " + place.name + ".");
    });
  });
  renderList();
}

/* ------------------------------------------------------------------ *
 * Elenco delle fermate
 * ------------------------------------------------------------------ */

// Nei nomi delle fermate "via", "piazza" o "metro" non compaiono quasi mai: cercando
// "piazza Bologna" o "metro Termini" si tiene solo la parte che conta davvero.
const PAROLE_GENERICHE = new Set([
  "via", "viale", "v", "piazza", "piazzale", "largo", "corso", "lungotevere", "ponte", "circonvallazione",
  "vicolo", "borgo", "stazione", "fermata", "palina", "metro", "metropolitana", "linea", "bus", "autobus", "capolinea",
]);

function searchWords(query) {
  const words = query.split(" ").filter(Boolean);
  const significant = words.filter((word) => !PAROLE_GENERICHE.has(word));
  return significant.length ? significant : words;
}

function referencePoint() {
  if (state.position) return state.position;
  if (map) {
    const center = map.getCenter();
    return { lat: center.lat, lon: center.lng };
  }
  return { lat: ROME.lat, lon: ROME.lon };
}

function badgeText(stop) {
  if (stop.mode === "MetroStation") return "M" + stop.metroLine;
  // Il codice interno COTRAL (f13090) non e' scritto da nessuna parte alla fermata: meglio la sigla.
  if (stop.operator === "COTRAL") return "COTRAL";
  return stop.code;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char];
  });
}

function matchesFilter(stop) {
  switch (state.filter) {
    case "metro":
      return stop.mode === "MetroStation";
    case "bus":
      return stop.operator === "ATAC" && stop.mode !== "MetroStation";
    case "cotral":
      return stop.operator === "COTRAL";
    case "preferite":
      return isFavorite(stop);
    default:
      return true;
  }
}

function renderList() {
  const listEl = $("#stop-list");
  const emptyEl = $("#list-empty");
  if (!listEl || !state.stops.length) return;
  const point = referencePoint();
  const query = normalizeText(state.query);

  let stops = state.stops.filter(matchesFilter);
  if (query) {
    const words = searchWords(query);
    stops = stops.filter((stop) => words.every((word) => stop.search.includes(word)));
  }

  const rows = stops
    .map((stop) => ({ stop, distance: haversineMeters(point, stop) }))
    // Cercando "termini" la stazione della metro deve venire prima delle decine di paline omonime.
    .sort((a, b) => {
      if (query) {
        const rank = (item) => (item.stop.mode === "MetroStation" ? 0 : 1);
        if (rank(a) !== rank(b)) return rank(a) - rank(b);
      }
      return a.distance - b.distance;
    })
    .slice(0, 40);

  listEl.innerHTML = rows
    .map(({ stop, distance }) => {
      return (
        '<li><button type="button" class="stop-row" data-stop="' + escapeHtml(stop.id) + '">' +
        '<span class="badge ' + stopTone(stop) + (isFavorite(stop) ? " is-favorite" : "") + '">' + escapeHtml(badgeText(stop)) + "</span>" +
        '<span class="stop-name">' + escapeHtml(stop.name) + "</span>" +
        (isFavorite(stop) ? '<span class="stop-star" aria-label="Preferita">&#9733;</span>' : "") +
        '<span class="stop-distance">' + distanceLabel(distance) + "</span>" +
        "</button></li>"
      );
    })
    .join("");

  listEl.querySelectorAll("[data-stop]").forEach((button) => {
    button.addEventListener("click", () => {
      const stop = state.byId.get(button.dataset.stop);
      if (stop) openStop(stop, { center: true });
    });
  });

  const note = $("#search-note");
  const placesShown = !$("#place-list").hidden;
  if (rows.length) {
    emptyEl.hidden = true;
    note.textContent = state.query.trim()
      ? rows.length + (rows.length === 1 ? " fermata trovata" : " fermate trovate")
      : state.position
        ? "Le fermate più vicine a te"
        : "Le fermate più vicine al centro della mappa";
  } else {
    emptyEl.hidden = false;
    note.textContent = "";
    if (state.filter === "preferite") {
      emptyEl.textContent = "Qui finiscono le fermate a cui metti la stella. Aprine una e tocca la stella in alto.";
    } else if (query) {
      emptyEl.textContent = placesShown
        ? "Nessuna fermata con questo nome. Tocca il luogo qui sopra per vederlo sulla mappa."
        : "Nessuna fermata con questo nome. Prova con il numero scritto sulla palina.";
    } else {
      emptyEl.textContent = "Nessuna fermata qui intorno.";
    }
  }
}

/* ------------------------------------------------------------------ *
 * Scheda della fermata
 * ------------------------------------------------------------------ */

let currentRows = [];
let loadToken = 0; // la risposta di una fermata aperta prima non deve sovrascrivere quella nuova
let etaTicker = null;

function stopSubtitle(stop) {
  if (stop.mode === "MetroStation") return "Metropolitana, linea " + stop.metroLine;
  if (stop.operator === "COTRAL") return "Autobus COTRAL, fermata " + stop.stopId;
  return "Fermata " + stop.code;
}

function openStop(stop, options = {}) {
  state.openStop = stop;
  state.directionFilter = "";
  currentRows = [];
  tripToken += 1;

  $("#sheet-stop").hidden = false;
  $("#panel-departures").hidden = false;
  $("#panel-trip").hidden = true;
  $("#sheet-title").textContent = stop.name;
  $("#sheet-sub").textContent = stopSubtitle(stop);
  $("#sheet-directions").hidden = true;
  $("#sheet-directions").innerHTML = "";
  setFavoriteButton(isFavorite(stop));
  if (options.center) centerMap(stop.lat, stop.lon, 17);

  // Via i dati della fermata precedente: finche' non arrivano i nuovi si vede che sta caricando.
  showSkeleton();
  refreshDepartures();
  startAutoRefresh();
}

function closeSheet() {
  $("#sheet-stop").hidden = true;
  state.openStop = null;
  tripToken += 1;
  stopAutoRefresh();
}

function setFavoriteButton(on) {
  const button = $("#sheet-fav");
  button.classList.toggle("is-on", on);
  button.setAttribute("aria-pressed", on ? "true" : "false");
  button.setAttribute("aria-label", on ? "Togli dai preferiti" : "Salva nei preferiti");
}

function showSkeleton() {
  $("#sheet-status").textContent = "Cerco gli orari…";
  $("#sheet-rows").innerHTML = Array.from({ length: 4 })
    .map(() => '<li><div class="departure is-loading"><span class="skeleton skeleton-line"></span><span class="skeleton skeleton-text"></span><span class="skeleton skeleton-eta"></span></div></li>')
    .join("");
}

async function refreshDepartures() {
  const stop = state.openStop;
  if (!stop) return;
  const token = ++loadToken;
  const button = $("#sheet-refresh");
  button.disabled = true;

  try {
    const rows = await loadDepartures(stop, state.settings.windowMinutes);
    if (token !== loadToken || state.openStop !== stop) return; // e' gia' stata aperta un'altra fermata
    currentRows = rows;
    renderDirections();
    renderDepartures();
    if (isCotral(stop)) {
      $("#sheet-status").textContent = rows.length
        ? "Orari indicativi: il calendario COTRAL disponibile è fermo ad agosto 2025. Tocca una corsa per le fermate successive."
        : "Nessuna corsa nelle prossime 6 ore secondo l’ultimo calendario COTRAL disponibile (agosto 2025).";
    } else {
      $("#sheet-status").textContent = rows.length
        ? "Aggiornato alle " + formatClock(new Date()) + ". Tocca una corsa per le fermate successive."
        : "Nessun mezzo in arrivo entro " + timeWindowLabel(state.settings.windowMinutes) + ".";
    }
  } catch (error) {
    if (token !== loadToken) return;
    currentRows = [];
    $("#sheet-rows").innerHTML = "";
    $("#sheet-status").textContent = "Orari non disponibili adesso. Riprova fra poco.";
    console.warn("orari non disponibili:", error);
  } finally {
    if (token === loadToken) button.disabled = false;
  }
}

// Per la metro i tasti non portano il codice della banchina ma la direzione vera, presa dalle corse.
function renderDirections() {
  const box = $("#sheet-directions");
  const stop = state.openStop;
  if (!stop || stop.mode !== "MetroStation" || !currentRows.length) {
    box.hidden = true;
    return;
  }

  const byPlatform = new Map();
  currentRows.forEach((row) => {
    if (!row.platformLabel) return;
    if (!byPlatform.has(row.platformLabel)) byPlatform.set(row.platformLabel, new Map());
    const destinations = byPlatform.get(row.platformLabel);
    destinations.set(row.destination, (destinations.get(row.destination) || 0) + 1);
  });
  if (byPlatform.size < 2) {
    box.hidden = true;
    return;
  }

  const options = [{ value: "", label: "Tutte" }].concat(
    Array.from(byPlatform.entries()).map(([platform, destinations]) => {
      const best = Array.from(destinations.entries()).sort((a, b) => b[1] - a[1])[0];
      return { value: platform, label: "Verso " + (best ? best[0] : platform) };
    }),
  );

  box.hidden = false;
  box.innerHTML = options
    .map(
      (option) =>
        '<button type="button" class="chip' + (option.value === state.directionFilter ? " is-on" : "") +
        '" data-direction="' + escapeHtml(option.value) + '">' + escapeHtml(option.label) + "</button>",
    )
    .join("");
  box.querySelectorAll("[data-direction]").forEach((chip) => {
    chip.addEventListener("click", () => {
      state.directionFilter = chip.dataset.direction;
      box.querySelectorAll(".chip").forEach((element) => element.classList.toggle("is-on", element === chip));
      renderDepartures();
    });
  });
}

// Quanto manca: sotto l'ora si contano i minuti, sopra si scrive in ore.
function etaText(date, now) {
  const minutes = Math.round((date.getTime() - now.getTime()) / 60000);
  if (minutes <= 0) return { value: "ora", unit: "" };
  return durationText(minutes);
}

function durationText(minutes) {
  if (minutes < 60) return { value: String(Math.max(0, minutes)), unit: "min" };
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return { value: hours + "h" + (rest ? " " + String(rest).padStart(2, "0") : ""), unit: "" };
}

function etaHtml(eta, row) {
  const classes = ["eta"];
  if (row.isRealtime) classes.push("is-live");
  if (row.approximate) classes.push("is-guess");
  return (
    '<span class="' + classes.join(" ") + '">' +
    '<span class="eta-value">' + escapeHtml(eta.value) + "</span>" +
    (eta.unit ? '<span class="eta-unit">' + eta.unit + "</span>" : "") +
    "</span>"
  );
}

function visibleRows() {
  return state.directionFilter
    ? currentRows.filter((row) => row.platformLabel === state.directionFilter)
    : currentRows;
}

const CHEVRON = '<svg class="chevron" viewBox="0 0 12 12" aria-hidden="true"><polyline points="4 2 8 6 4 10"/></svg>';

function renderDepartures() {
  const list = $("#sheet-rows");
  const now = new Date();
  const rows = visibleRows();

  if (!rows.length) {
    list.innerHTML = "";
    return;
  }

  list.innerHTML = rows
    .map((row) => {
      const title = row.isRealtime
        ? "In tempo reale"
        : row.approximate
          ? "Orario indicativo, da un calendario non aggiornato"
          : "Orario programmato, previsto alle " + row.displayTime;
      return (
        '<li><button type="button" class="departure" data-row="' + escapeHtml(row.key) + '" title="' + escapeHtml(title) + '">' +
        '<span class="line ' + lineTone(row) + '">' + escapeHtml(row.line) + "</span>" +
        '<span class="destination">' + escapeHtml(row.destination) + "</span>" +
        etaHtml(etaText(row.date, now), row) +
        CHEVRON +
        "</button></li>"
      );
    })
    .join("");

  list.querySelectorAll("[data-row]").forEach((button) => {
    button.addEventListener("click", () => {
      const row = currentRows.find((item) => item.key === button.dataset.row);
      if (row) openTrip(row);
    });
  });
}

function startAutoRefresh() {
  stopAutoRefresh();
  state.refreshTimer = window.setInterval(() => {
    if (document.visibilityState === "visible" && state.openStop && $("#panel-trip").hidden) refreshDepartures();
  }, state.settings.refreshSeconds * 1000);
  // I minuti scendono da soli, senza richiamare ogni volta gli orari.
  etaTicker = window.setInterval(() => {
    if (state.openStop && currentRows.length && $("#panel-trip").hidden) renderDepartures();
  }, 20000);
}

function stopAutoRefresh() {
  if (state.refreshTimer) window.clearInterval(state.refreshTimer);
  if (etaTicker) window.clearInterval(etaTicker);
  state.refreshTimer = null;
  etaTicker = null;
}

/* ------------------------------------------------------------------ *
 * Fermate successive di una corsa
 * ------------------------------------------------------------------ */

let tripToken = 0;
const platformToStation = new Map(); // banchina metro (AD12) -> stazione, per aprire la fermata giusta

function localStopFor(stopId, feed) {
  const id = String(stopId || "");
  if (feed === COTRAL_FEED) return state.byId.get("cotral:" + id) || null;
  return platformToStation.get(id) || state.byId.get("atac:" + id) || null;
}

function tripStopName(stopTime, feed) {
  const local = localStopFor(stopTime.stop?.stop_id, feed);
  if (local) return local.name;
  const raw = cleanStopName(stopTime.stop?.stop_name || "Fermata", stopTime.stop?.stop_id);
  return feed === COTRAL_FEED ? prettyCotralName(raw) : prettyName(raw);
}

async function openTrip(row) {
  const token = ++tripToken;
  $("#panel-departures").hidden = true;
  $("#panel-trip").hidden = false;

  const lineBadge = $("#trip-line");
  lineBadge.className = "line " + lineTone(row);
  lineBadge.textContent = row.line;
  $("#trip-destination").textContent = "Verso " + row.destination;
  $("#trip-sub").textContent = "Da " + (state.openStop ? state.openStop.name : "questa fermata");
  $("#trip-status").textContent = "Cerco le fermate…";
  const list = $("#trip-stops");
  list.className = "trip-stops " + lineTone(row);
  list.innerHTML = Array.from({ length: 5 })
    .map(() => '<li class="trip-stop"><span class="trip-dot"></span><span class="skeleton skeleton-text"></span><span class="skeleton skeleton-eta"></span></li>')
    .join("");

  if (!row.routeId || !row.tripId) {
    list.innerHTML = "";
    $("#trip-status").textContent = "Per questa corsa le fermate successive non sono disponibili.";
    return;
  }

  try {
    const trip = await requestTrip(row.routeId, row.tripId);
    if (token !== tripToken) return;
    renderTrip(trip, row);
  } catch (error) {
    if (token !== tripToken) return;
    list.innerHTML = "";
    $("#trip-status").textContent = "Non riesco a leggere il percorso di questa corsa. Riprova fra poco.";
    console.warn("percorso non disponibile:", error);
  }
}

function renderTrip(trip, row) {
  const list = $("#trip-stops");
  const stopTimes = trip.stop_times.slice().sort((a, b) => a.stop_sequence - b.stop_sequence);

  // La fermata di partenza: prima per numero d'ordine nella corsa, poi per codice.
  let origin = stopTimes.findIndex((item) => row.stopSequence !== null && item.stop_sequence === row.stopSequence);
  if (origin < 0) origin = stopTimes.findIndex((item) => String(item.stop?.stop_id) === String(row.fromStopId));
  if (origin < 0) {
    list.innerHTML = "";
    $("#trip-status").textContent = "Non trovo questa fermata nel percorso della corsa.";
    return;
  }

  const originSeconds = clockToSeconds(stopTimes[origin].departure_time || stopTimes[origin].arrival_time);
  const remaining = stopTimes.slice(origin);
  const now = new Date();

  list.innerHTML = remaining
    .map((stopTime, index) => {
      const seconds = clockToSeconds(stopTime.arrival_time || stopTime.departure_time);
      const travel = originSeconds !== null && seconds !== null ? Math.max(0, seconds - originSeconds) : null;
      // L'arrivo e' la partenza da qui (gia' corretta col ritardo, se in tempo reale) piu' il viaggio.
      const arrival = travel !== null ? new Date(row.date.getTime() + travel * 1000) : null;
      const name = escapeHtml(tripStopName(stopTime, row.fromFeed));
      const local = localStopFor(stopTime.stop?.stop_id, row.fromFeed);

      if (index === 0) {
        const leave = etaText(row.date, now);
        return (
          '<li class="trip-stop is-origin"><span class="trip-dot"></span>' +
          '<span class="trip-name">' + name + "<small>Parti da qui alle " + escapeHtml(formatClock(row.date)) + "</small></span>" +
          '<span class="trip-time">' + etaHtml(leave, row) + "<small>alla partenza</small></span></li>"
        );
      }

      const minutes = travel !== null ? Math.round(travel / 60) : null;
      const duration = minutes !== null ? durationText(minutes) : { value: "–", unit: "" };
      const data = local ? ' data-open="' + escapeHtml(local.id) + '" role="button" tabindex="0"' : "";
      return (
        '<li class="trip-stop"' + data + '><span class="trip-dot"></span>' +
        '<span class="trip-name">' + name + "</span>" +
        '<span class="trip-time">' + etaHtml(duration, row) +
        (arrival ? "<small>arrivo " + escapeHtml(formatClock(arrival)) + "</small>" : "") +
        "</span></li>"
      );
    })
    .join("");

  const count = remaining.length - 1;
  const last = remaining[remaining.length - 1];
  const total = originSeconds !== null ? clockToSeconds(last.arrival_time || last.departure_time) - originSeconds : null;
  $("#trip-status").textContent = count
    ? count + (count === 1 ? " fermata" : " fermate") + " fino al capolinea" +
      (total !== null && total > 0 ? ", " + Math.round(total / 60) + " minuti di viaggio." : ".") +
      (row.isRealtime ? " Tempi calcolati sulla posizione attuale del mezzo." : "")
    : "Questa è l’ultima fermata della corsa.";

  // Toccando una fermata della lista se ne aprono le partenze.
  list.querySelectorAll("[data-open]").forEach((item) => {
    const open = () => {
      const stop = state.byId.get(item.dataset.open);
      if (stop) openStop(stop, { center: true });
    };
    item.addEventListener("click", open);
    item.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        open();
      }
    });
  });
}

/* ------------------------------------------------------------------ *
 * Rullo "Quanto guardare avanti": ore e minuti a quarti d'ora, da 15 minuti a 3 ore
 * ------------------------------------------------------------------ */

const WHEEL_ITEM = 40;
const WHEEL_HOURS = [0, 1, 2, 3];
const WHEEL_MINUTES = [0, 15, 30, 45];
let wheelTimer = null;

function wheelIndex(column) {
  const last = column.children.length - 1;
  return Math.min(last, Math.max(0, Math.round(column.scrollTop / WHEEL_ITEM)));
}

function moveWheel(column, index, smooth) {
  column.scrollTo({ top: index * WHEEL_ITEM, behavior: smooth ? "smooth" : "auto" });
}

function paintWheel(hours, minutes) {
  $$("#wheel-hours .wheel-item").forEach((item, index) => {
    item.classList.toggle("is-on", WHEEL_HOURS[index] === hours);
  });
  $$("#wheel-minutes .wheel-item").forEach((item, index) => {
    const value = WHEEL_MINUTES[index];
    item.classList.toggle("is-on", value === minutes);
    // Oltre le 3 ore non si va, e zero minuti non ha senso: quelle voci si vedono spente.
    item.classList.toggle("is-off", (hours === 3 && value > 0) || (hours === 0 && value === 0));
  });
  const hoursCol = $("#wheel-hours");
  const minutesCol = $("#wheel-minutes");
  hoursCol.setAttribute("aria-valuenow", String(hours));
  hoursCol.setAttribute("aria-valuetext", hours + (hours === 1 ? " ora" : " ore"));
  minutesCol.setAttribute("aria-valuenow", String(minutes));
  minutesCol.setAttribute("aria-valuetext", minutes + " minuti");
  $("#wheel-summary").innerHTML = "Vedi i mezzi in arrivo entro <strong>" + timeWindowLabel(hours * 60 + minutes) + "</strong>.";
}

// Quando il rullo si ferma: si legge la scelta, si correggono i casi impossibili, si salva.
function commitWheel() {
  const hoursCol = $("#wheel-hours");
  const minutesCol = $("#wheel-minutes");
  const hours = WHEEL_HOURS[wheelIndex(hoursCol)];
  let minuteIndex = wheelIndex(minutesCol);
  if (hours === 3 && minuteIndex > 0) minuteIndex = 0;
  if (hours === 0 && minuteIndex === 0) minuteIndex = 1;
  if (minuteIndex !== wheelIndex(minutesCol)) moveWheel(minutesCol, minuteIndex, true);

  const minutes = WHEEL_MINUTES[minuteIndex];
  paintWheel(hours, minutes);
  const total = hours * 60 + minutes;
  if (total !== state.settings.windowMinutes) {
    state.settings.windowMinutes = total;
    saveSettings();
  }
}

function syncWheel() {
  const total = Math.min(180, Math.max(15, Math.round(state.settings.windowMinutes / 15) * 15));
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  moveWheel($("#wheel-hours"), WHEEL_HOURS.indexOf(hours), false);
  moveWheel($("#wheel-minutes"), WHEEL_MINUTES.indexOf(minutes), false);
  paintWheel(hours, minutes);
}

function buildWheel() {
  const hoursCol = $("#wheel-hours");
  const minutesCol = $("#wheel-minutes");
  hoursCol.innerHTML = WHEEL_HOURS.map((h) => '<div class="wheel-item">' + h + (h === 1 ? " ora" : " ore") + "</div>").join("");
  minutesCol.innerHTML = WHEEL_MINUTES.map((m) => '<div class="wheel-item">' + String(m).padStart(2, "0") + " min</div>").join("");

  [hoursCol, minutesCol].forEach((column) => {
    column.addEventListener("scroll", () => {
      window.clearTimeout(wheelTimer);
      wheelTimer = window.setTimeout(commitWheel, 120);
    });
    // Toccare una voce la porta al centro.
    Array.from(column.children).forEach((item, index) => {
      item.addEventListener("click", () => moveWheel(column, index, true));
    });
    // Con la tastiera: frecce su e giu'.
    column.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
      event.preventDefault();
      const next = wheelIndex(column) + (event.key === "ArrowDown" ? 1 : -1);
      moveWheel(column, Math.min(column.children.length - 1, Math.max(0, next)), true);
    });
  });
}

/* ------------------------------------------------------------------ *
 * Impostazioni
 * ------------------------------------------------------------------ */

function chipRow(container, options, isActive, onPick) {
  container.innerHTML = options
    .map(
      (option) =>
        '<button type="button" class="chip' + (isActive(option.value) ? " is-on" : "") + '" data-value="' +
        option.value + '">' + option.label + "</button>",
    )
    .join("");
  container.querySelectorAll("[data-value]").forEach((chip) => {
    chip.addEventListener("click", () => onPick(chip.dataset.value));
  });
}

function renderSettings() {
  chipRow(
    $("#opt-theme"),
    THEMES,
    (value) => state.settings.theme === value,
    (value) => {
      state.settings.theme = value;
      saveSettings();
      applyTheme();
      renderSettings();
    },
  );

  chipRow(
    $("#opt-refresh"),
    [
      { value: 15, label: "15 secondi" },
      { value: 30, label: "30 secondi" },
      { value: 60, label: "1 minuto" },
    ],
    (value) => state.settings.refreshSeconds === value,
    (value) => {
      state.settings.refreshSeconds = Number(value);
      saveSettings();
      renderSettings();
    },
  );

  $("#app-version").textContent = "Versione " + APP_VERSION;
}

/* ------------------------------------------------------------------ *
 * Aggiornamenti: l'app si aggiorna da sola e lo dice
 * ------------------------------------------------------------------ */

let bannerAction = null;

function showBanner(title, text, actionLabel, action) {
  $("#update-text").innerHTML = "<strong>" + escapeHtml(title) + "</strong>" + escapeHtml(text);
  const button = $("#update-action");
  button.hidden = !action;
  button.textContent = actionLabel || "Aggiorna";
  bannerAction = action || null;
  $("#update-banner").hidden = false;
  if (!action) window.setTimeout(() => ($("#update-banner").hidden = true), 9000);
}

// Chi apre l'app dopo una pubblicazione vede in una riga cosa e' cambiato.
function announceNewVersion() {
  const seen = readStorage(STORAGE.seenVersion, null);
  if (seen && seen !== APP_VERSION) showBanner("Roma Mobility è stata aggiornata", APP_NEWS);
  writeStorage(STORAGE.seenVersion, APP_VERSION);
}

function watchForUpdates() {
  if (!("serviceWorker" in navigator)) return;
  let hadController = Boolean(navigator.serviceWorker.controller);

  // Quando il nuovo service worker prende il posto del vecchio, la versione nuova e' pronta.
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!hadController) {
      hadController = true; // prima installazione, non un aggiornamento
      return;
    }
    showBanner("C’è una versione nuova", "Tocca Aggiorna per usarla subito.", "Aggiorna", () => window.location.reload());
  });

  navigator.serviceWorker
    .register("sw.js")
    .then((registration) => {
      // Si controlla a ogni ritorno sull'app e ogni mezz'ora mentre resta aperta.
      const check = () => registration.update().catch(() => {});
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") check();
      });
      window.setInterval(check, 30 * 60 * 1000);
    })
    .catch(() => {
      // Senza service worker il sito funziona comunque, solo senza copia offline.
    });
}

/* ------------------------------------------------------------------ *
 * Collegamenti e avvio
 * ------------------------------------------------------------------ */

function wireEvents() {
  $$(".tab").forEach((tab) => tab.addEventListener("click", () => showView(tab.dataset.view)));
  $$("[data-close]").forEach((element) => element.addEventListener("click", closeSheet));
  $("#btn-gps").addEventListener("click", () => askPosition(GPS_ZOOM));
  $("#trip-back").addEventListener("click", () => {
    tripToken += 1;
    $("#panel-trip").hidden = true;
    $("#panel-departures").hidden = false;
    renderDepartures();
  });
  $("#sheet-refresh").addEventListener("click", () => {
    showSkeleton();
    refreshDepartures();
  });
  $("#sheet-fav").addEventListener("click", () => {
    if (!state.openStop) return;
    toggleFavorite(state.openStop);
    setFavoriteButton(isFavorite(state.openStop));
    renderList();
    refreshMarkers();
  });
  $("#update-action").addEventListener("click", () => {
    if (bannerAction) bannerAction();
  });
  $("#update-close").addEventListener("click", () => {
    $("#update-banner").hidden = true;
  });

  let searchTimer = null;
  $("#search").addEventListener("input", (event) => {
    state.query = event.target.value;
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(renderList, 130);
    schedulePlaceSearch();
  });

  $$("#search-filters .chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      state.filter = chip.dataset.filter;
      $$("#search-filters .chip").forEach((element) => element.classList.toggle("is-on", element === chip));
      renderList();
      schedulePlaceSearch();
    });
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !$("#sheet-stop").hidden) closeSheet();
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && state.openStop && $("#panel-trip").hidden) refreshDepartures();
  });

  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (state.settings.theme === "auto") applyTheme();
  });
}

async function boot() {
  applyTheme();
  watchForUpdates();
  try {
    state.stops = await loadStops();
    state.stops.forEach((stop) => {
      state.byId.set(stop.id, stop);
      (stop.children || []).forEach((child) => platformToStation.set(child.stopId, stop));
    });
    buildGrid(state.stops);

    $("#splash").hidden = true;
    $("#app").hidden = false;
    $("#tabs").hidden = false;

    initMap();
    buildWheel();
    renderSettings();
    wireEvents();
    wireNavigation();
    showView("map");
    announceNewVersion();

    // A ogni apertura si cerca la posizione: se non e' ancora stata condivisa, e' qui che viene chiesta;
    // se e' gia' stata data, arriva senza domande.
    askPosition(GPS_ZOOM, true);
  } catch (error) {
    const box = $("#splash-error");
    box.hidden = false;
    box.textContent = "Non riesco a caricare le fermate. Controlla la rete e riapri il sito.";
    console.error(error);
  }
}


/* ================================================================== *
 * Navigazione: da dove a dove, con i mezzi
 *
 * I percorsi li calcola Transitous (api.transitous.org), un servizio pubblico e gratuito basato su
 * MOTIS che carica gli stessi dati aperti di Roma (ATAC con il tempo reale) e i treni regionali.
 * Le sue fermate hanno lo stop_id dei nostri file ("it-Lazio-Rome_71262" -> 71262), cosi' dal
 * percorso si apre la scheda della fermata. I bus COTRAL mancano anche li': il loro calendario
 * pubblico non si scarica. Condizioni d'uso: progetto non commerciale, poche richieste, link visibile
 * alle fonti (nelle impostazioni e in fondo ai percorsi).
 * ================================================================== */

const TRANSITOUS = "https://api.transitous.org/api";
const NAV_RECENTS_KEY = "roma-mobility-web/nav-recents";
const NAV_LAST_KEY = "roma-mobility-web/nav-last";
const RAIL_MODES = new Set(["RAIL", "REGIONAL_RAIL", "REGIONAL_FAST_RAIL", "HIGHSPEED_RAIL", "LONG_DISTANCE", "NIGHT_RAIL", "SUBURBAN"]);

const nav = {
  from: { here: true },
  to: null,
  picking: "to", // quale dei due campi si sta scegliendo
  returnTo: null, // da dove si e' arrivati alla ricerca: null (mappa) o "plan"
  timeMode: "now",
  timeValue: "",
  timeDay: 0, // 0 = oggi, 1 = domani...
  settingSlot: null, // "home", "work" o "place" mentre si sceglie un preferito
  sort: "fast",
  itineraries: [],
  direct: [],
  nextCursor: null,
  token: 0,
  routeLayer: null,
  shown: null,
};

/* ---------------- icone (disegnate, niente emoji) ---------------- */

const ICON = {
  walk: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="13" cy="4.5" r="1.8"/><path d="M10 21l2-6 3 3v3M12 15l-1-5 3-2 3 4h3M11 10l-3 2-1 4"/></svg>',
  bike: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="17" r="3.5"/><circle cx="18" cy="17" r="3.5"/><path d="M6 17l4-8h5l3 8M10 9l-1.5-3H6M13 17l-3-8"/></svg>',
  bus: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="3.5" width="14" height="14" rx="3"/><path d="M5 11h14M8 20.5v-3M16 20.5v-3"/><circle cx="8.5" cy="14.3" r=".6"/><circle cx="15.5" cy="14.3" r=".6"/></svg>',
  tram: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="5" width="12" height="12.5" rx="3"/><path d="M6 11h12M9 2.5h6M12 2.5V5M8 21l2-3.5M16 21l-2-3.5"/></svg>',
  metro: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="3.5" width="14" height="14" rx="4"/><path d="M9 7.5l3 4 3-4M8 21l2-3.5M16 21l-2-3.5"/></svg>',
  train: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="3" width="12" height="14.5" rx="4"/><path d="M6 10.5h12M8 21l2-3.5M16 21l-2-3.5"/><circle cx="9.5" cy="13.8" r=".6"/><circle cx="14.5" cy="13.8" r=".6"/></svg>',
  pin: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21.5s7-6.1 7-11.2A7 7 0 0 0 5 10.3c0 5.1 7 11.2 7 11.2Z"/><circle cx="12" cy="10" r="2.4"/></svg>',
  here: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3.5"/><circle cx="12" cy="12" r="8"/></svg>',
  clock: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>',
  sep: '<svg class="leg-sep" viewBox="0 0 12 12" aria-hidden="true"><polyline points="4 2 8 6 4 10"/></svg>',
};

/* ---------------- piccole utilita' ---------------- */

function clockOf(iso) {
  return formatClock(new Date(iso));
}

// Sotto l'ora "45 min", sopra "1 h 12 min" (o "2 h" tondo).
function durationLabel(minutes) {
  const total = Math.max(0, Math.round(minutes));
  if (total < 60) return total + " min";
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  return hours + " h" + (rest ? " " + rest + " min" : "");
}

function minutesBetween(fromIso, toIso) {
  return Math.max(0, Math.round((new Date(toIso) - new Date(fromIso)) / 60000));
}

function metersLabel(meters) {
  if (!Number.isFinite(meters)) return "";
  return meters < 950 ? Math.round(meters / 10) * 10 + " m" : (meters / 1000).toFixed(1).replace(".", ",") + " km";
}

function transitousStopId(stopId) {
  const text = String(stopId || "");
  return text.includes("_") ? text.slice(text.lastIndexOf("_") + 1) : text;
}

function localStopForLeg(place) {
  if (!place || !place.stopId) return null;
  return localStopFor(transitousStopId(place.stopId), ATAC_FEED);
}

function placeLabel(place, fallback) {
  if (!place || place.name === "START" || place.name === "END" || !place.name) return fallback;
  const local = localStopForLeg(place);
  return local ? local.name : prettyName(place.name);
}

function isTransit(leg) {
  return leg.mode !== "WALK" && leg.mode !== "BIKE" && leg.mode !== "CAR";
}

function legKind(leg) {
  if (leg.mode === "SUBWAY" || leg.mode === "METRO") return "metro";
  if (leg.mode === "TRAM") return "tram";
  if (RAIL_MODES.has(leg.mode)) return "train";
  return "bus";
}

function legLine(leg) {
  const raw = leg.routeShortName || leg.displayName || "";
  const name = prettyLineName(raw);
  if (legKind(leg) === "train") return name && name !== "REG" ? name : "Treno";
  return name || "Linea";
}

function legTone(leg) {
  const kind = legKind(leg);
  if (kind === "train") return "tone-rail";
  const line = legLine(leg);
  if (line === "MA") return "tone-ma";
  if (line === "MB" || line === "MB1") return "tone-mb";
  if (line === "MC") return "tone-mc";
  return "tone-bus";
}

// Colore della linea sulla mappa: metro coi loro colori, treni magenta, bus e tram blu (chiaro sullo scuro).
function legColor(leg) {
  const tone = legTone(leg);
  if (tone === "tone-ma") return "#e08a2e";
  if (tone === "tone-mb") return "#2f7fd1";
  if (tone === "tone-mc") return "#4e9a5f";
  if (tone === "tone-rail") return "#b4235a";
  return darkNow() ? "#9ec3ff" : "#1b2e4f";
}

function legChip(leg) {
  return '<span class="leg-chip ' + legTone(leg) + '">' + ICON[legKind(leg)] + escapeHtml(legLine(leg)) + "</span>";
}

function legsHtml(itinerary) {
  const parts = [];
  itinerary.legs.forEach((leg) => {
    if (isTransit(leg)) parts.push(legChip(leg));
    else if (leg.mode === "WALK" && leg.duration >= 60) parts.push('<span class="leg-walk" title="A piedi">' + ICON.walk + "</span>");
  });
  return '<div class="legs">' + parts.join(ICON.sep) + "</div>";
}

// Decodifica i tracciati "polyline" di Google (MOTIS indica la precisione).
function decodePolyline(encoded, precision = 6) {
  const factor = Math.pow(10, precision);
  const points = [];
  let index = 0;
  let lat = 0;
  let lon = 0;
  while (index < encoded.length) {
    for (const axis of [0, 1]) {
      let result = 0;
      let shift = 0;
      let byte;
      do {
        byte = encoded.charCodeAt(index++) - 63;
        result |= (byte & 0x1f) << shift;
        shift += 5;
      } while (byte >= 0x20 && index < encoded.length);
      const delta = result & 1 ? ~(result >> 1) : result >> 1;
      if (axis === 0) lat += delta;
      else lon += delta;
    }
    points.push([lat / factor, lon / factor]);
  }
  return points;
}

/* ---------------- posizione ---------------- */

function currentPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      if (state.position) return resolve(state.position);
      return reject(new Error("posizione non disponibile"));
    }
    navigator.geolocation.getCurrentPosition(
      (result) => {
        showPosition(result.coords);
        resolve({ lat: result.coords.latitude, lon: result.coords.longitude });
      },
      () => (state.position ? resolve(state.position) : reject(new Error("posizione non disponibile"))),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 },
    );
  });
}

async function resolvePoint(point) {
  if (point.here) return currentPosition();
  return { lat: point.lat, lon: point.lon };
}

/* ---------------- pannello ---------------- */

function openNavPanel(page) {
  $("#nav-panel").hidden = false;
  $("#nav-page-search").hidden = page !== "search";
  $("#nav-page-plan").hidden = page !== "plan";
}

function closeNavPanel() {
  $("#nav-panel").hidden = true;
}

/* ---------------- ricerca del luogo ---------------- */

const geocodeCache = new Map();
let geocodeTimer = null;
let geocodeToken = 0;

function readRecents() {
  const list = readStorage(NAV_RECENTS_KEY, []);
  return Array.isArray(list) ? list : [];
}

function rememberPlace(place) {
  if (place.here) return;
  const list = readRecents().filter((item) => !(item.name === place.name && item.sub === place.sub));
  list.unshift({ name: place.name, sub: place.sub || "", lat: place.lat, lon: place.lon, kind: place.kind || "place", tone: place.tone || "" });
  writeStorage(NAV_RECENTS_KEY, list.slice(0, 8));
}

function startSearch(picking, returnTo) {
  nav.picking = picking;
  nav.settingSlot = null;
  nav.returnTo = returnTo || null;
  openNavPanel("search");
  const input = $("#nav-search-input");
  input.value = "";
  input.placeholder = picking === "from" ? "Da dove parti?" : "Dove vuoi andare?";
  renderSearchHome();
  input.focus({ preventScroll: true });
}

/* ---------------- preferiti: Casa, Lavoro, luoghi e tragitti ---------------- */

const NAV_SAVED_KEY = "roma-mobility-web/nav-saved";

const ICON_HOME = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 11 12 4l8 7"/><path d="M6 10v10h12V10"/><path d="M10 20v-5h4v5"/></svg>';
const ICON_WORK = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="7.5" width="17" height="12" rx="2"/><path d="M9 7.5V5.5h6v2M3.5 12.5h17"/></svg>';
const ICON_STAR = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3.6 2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8L3.5 9.8l5.9-.9Z"/></svg>';
const ICON_EDIT = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16Z"/><path d="m13.5 6.5 4 4"/></svg>';
const ICON_STREET = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 21 10 3M17 21 14 3M12 6v2M12 11v2M12 16v2"/></svg>';
const ICON_FOOD = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3v8M5 3v5a2 2 0 0 0 4 0V3M7 11v10M17 21V3c-2 1-3 4-3 8h3"/></svg>';
const ICON_HEALTH = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="4"/><path d="M12 8v8M8 12h8"/></svg>';
const ICON_SCHOOL = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m2.5 9 9.5-5 9.5 5-9.5 5Z"/><path d="M6.5 11v5c3 2 8 2 11 0v-5M21.5 9v5"/></svg>';
const ICON_SHOP = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 8h14l-1 12H6Z"/><path d="M9 8a3 3 0 0 1 6 0"/></svg>';
const ICON_ROUTE = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="18" r="2.2"/><circle cx="18" cy="6" r="2.2"/><path d="M8 18h6a3.5 3.5 0 0 0 0-7h-4a3.5 3.5 0 0 1 0-7h6"/></svg>';

function readSaved() {
  const saved = readStorage(NAV_SAVED_KEY, {}) || {};
  return {
    home: saved.home || null,
    work: saved.work || null,
    places: Array.isArray(saved.places) ? saved.places : [],
    trips: Array.isArray(saved.trips) ? saved.trips : [],
  };
}

function writeSaved(saved) {
  writeStorage(NAV_SAVED_KEY, saved);
}

function cleanPoint(place) {
  if (!place || place.here) return { here: true };
  return { name: place.name, sub: place.sub || "", lat: place.lat, lon: place.lon, kind: place.kind || "place", tone: place.tone || "", category: place.category || "" };
}

function samePlace(a, b) {
  if (!a || !b) return false;
  if (a.here || b.here) return Boolean(a.here && b.here);
  return a.name === b.name && Math.abs(a.lat - b.lat) < 0.0005 && Math.abs(a.lon - b.lon) < 0.0005;
}

function isSavedPlace(place) {
  return readSaved().places.some((item) => samePlace(item, place));
}

function toggleSavedPlace(place) {
  const saved = readSaved();
  const exists = saved.places.some((item) => samePlace(item, place));
  saved.places = exists ? saved.places.filter((item) => !samePlace(item, place)) : [cleanPoint(place)].concat(saved.places).slice(0, 20);
  writeSaved(saved);
  return !exists;
}

function tripSaved(from, to) {
  return readSaved().trips.some((trip) => samePlace(trip.from, from) && samePlace(trip.to, to));
}

function toggleSavedTrip() {
  if (!nav.to) return;
  const saved = readSaved();
  const exists = tripSaved(nav.from, nav.to);
  saved.trips = exists
    ? saved.trips.filter((trip) => !(samePlace(trip.from, nav.from) && samePlace(trip.to, nav.to)))
    : [{ from: cleanPoint(nav.from), to: cleanPoint(nav.to) }].concat(saved.trips).slice(0, 12);
  writeSaved(saved);
  updateTripStar();
  toast(exists ? "Tragitto tolto dai preferiti." : "Tragitto salvato: lo trovi in «Dove vuoi andare?».");
}

function updateTripStar() {
  const button = $("#nav-fav-trip");
  if (!button) return;
  const on = Boolean(nav.to) && tripSaved(nav.from, nav.to);
  button.classList.toggle("is-on", on);
  button.setAttribute("aria-pressed", on ? "true" : "false");
  button.setAttribute("aria-label", on ? "Togli il tragitto dai preferiti" : "Salva il tragitto nei preferiti");
}

/* ---------------- mete frequenti (suggerimenti senza rete) ---------------- */

// Coordinate controllate una per una: servono per suggerire mentre si scrive, anche prima della rete.
const POPULAR_PLACES = [
  ["Stazione Termini", 41.9010, 12.5016],
  ["Colosseo", 41.8902, 12.4922],
  ["Fontana di Trevi", 41.9009, 12.4833],
  ["Pantheon", 41.8986, 12.4769],
  ["Piazza Navona", 41.8992, 12.4731],
  ["Piazza di Spagna", 41.9057, 12.4823],
  ["Piazza Venezia", 41.8958, 12.4826],
  ["Basilica di San Pietro", 41.9022, 12.4539],
  ["Musei Vaticani", 41.9065, 12.4536],
  ["Trastevere, Santa Maria in Trastevere", 41.8894, 12.4700],
  ["Stazione Tiburtina", 41.9104, 12.5306],
  ["Stazione Ostiense", 41.8718, 12.4863],
  ["Aeroporto di Fiumicino", 41.7995, 12.2462],
  ["Aeroporto di Ciampino", 41.7994, 12.5949],
  ["Circo Massimo", 41.8861, 12.4851],
  ["Galleria Borghese", 41.9142, 12.4921],
  ["Piazza del Popolo", 41.9109, 12.4764],
  ["Campo de’ Fiori", 41.8956, 12.4722],
  ["Stadio Olimpico", 41.9340, 12.4547],
  ["EUR, Palazzo dei Congressi", 41.8339, 12.4722],
].map(([name, lat, lon]) => ({ name, sub: "Roma", lat, lon, kind: "place", popular: true, search: normalizeText(name) }));

// Parole scritte a meta' ("colos", "piazza nav"): ogni parola deve comparire all'inizio di una parola del nome.
function matchesWords(haystack, words) {
  const parts = haystack.split(" ");
  return words.every((word) => parts.some((part) => part.startsWith(word)));
}

function localSuggestions(text) {
  const words = normalizeText(text).split(" ").filter(Boolean);
  if (!words.length) return [];
  const saved = readSaved();
  const own = [saved.home && { ...saved.home, slot: "home", name: "Casa", sub: saved.home.name }, saved.work && { ...saved.work, slot: "work", name: "Lavoro", sub: saved.work.name }]
    .filter(Boolean)
    .concat(saved.places, readRecents())
    .filter((place) => matchesWords(normalizeText(place.name + " " + (place.sub || "")), words));
  const popular = POPULAR_PLACES.filter((place) => matchesWords(place.search, words));
  const significant = searchWords(words.join(" "));
  const stops = state.stops
    .filter((stop) => matchesWords(stop.search, significant))
    .sort((a, b) => (a.mode === "MetroStation" ? 0 : 1) - (b.mode === "MetroStation" ? 0 : 1))
    .slice(0, 3)
    .map((stop) => ({
      name: stop.name,
      sub: stopSubtitle(stop),
      lat: stop.lat,
      lon: stop.lon,
      kind: "stop",
      tone: stop.mode === "MetroStation" ? stopTone(stop) : "tone-stop",
    }));
  return dedupePlaces(own.concat(popular, stops)).slice(0, 6);
}

// Stesso nome a meno di 400 m = stesso luogo (il servizio restituisce spesso lo stesso posto piu' volte).
function dedupePlaces(list) {
  const kept = [];
  list.forEach((place) => {
    const key = normalizeText(place.name);
    const twin = kept.find((other) => normalizeText(other.name) === key && haversineMeters(other, place) < 400);
    if (!twin) kept.push(place);
  });
  return kept;
}

/* ---------------- righe degli elenchi ---------------- */

function placeIcon(place) {
  if (place.here) return { cls: "is-here", svg: ICON.here };
  if (place.slot === "home") return { cls: "is-fav", svg: ICON_HOME };
  if (place.slot === "work") return { cls: "is-fav", svg: ICON_WORK };
  if (place.trip) return { cls: "is-fav", svg: ICON_ROUTE };
  if (place.saved) return { cls: "is-fav", svg: ICON_STAR };
  if (place.kind === "stop") return { cls: place.tone || "tone-stop", svg: place.tone && place.tone !== "tone-stop" ? ICON.metro : ICON.bus };
  if (place.kind === "address") return { cls: "", svg: ICON_HOME };
  if (place.kind === "street") return { cls: "", svg: ICON_STREET };
  const category = String(place.category || "");
  if (/restaurant|fast_food|cafe|bar|pub|ice_cream|bakery|food/.test(category)) return { cls: "", svg: ICON_FOOD };
  if (/pharmacy|hospital|clinic|doctor|dentist/.test(category)) return { cls: "", svg: ICON_HEALTH };
  if (/school|university|college|kindergarten|library/.test(category)) return { cls: "", svg: ICON_SCHOOL };
  if (/shop|supermarket|mall|store|marketplace/.test(category)) return { cls: "", svg: ICON_SHOP };
  return { cls: "", svg: ICON.pin };
}

// action: null | "star" (salva/togli il luogo) | "edit" (Casa, Lavoro) | "unstar-trip"
function placeRow(place, index, group, action) {
  const icon = placeIcon(place);
  let actionHtml = "";
  if (action === "star") {
    const on = isSavedPlace(place);
    actionHtml = '<button type="button" class="nav-row-action' + (on ? " is-on" : "") + '" data-action="star" data-group="' + group +
      '" data-index="' + index + '" aria-pressed="' + on + '" aria-label="' + (on ? "Togli dai preferiti" : "Salva nei preferiti") + '">' + ICON_STAR + "</button>";
  } else if (action === "edit") {
    actionHtml = '<button type="button" class="nav-row-action" data-action="edit" data-group="' + group + '" data-index="' + index +
      '" aria-label="Cambia l’indirizzo di ' + escapeHtml(place.name) + '">' + ICON_EDIT + "</button>";
  } else if (action === "unstar-trip") {
    actionHtml = '<button type="button" class="nav-row-action is-on" data-action="unstar-trip" data-group="' + group + '" data-index="' + index +
      '" aria-label="Togli il tragitto dai preferiti">' + ICON_STAR + "</button>";
  }
  return (
    '<li><div class="nav-row-wrap"><button type="button" class="nav-row" data-group="' + group + '" data-index="' + index + '">' +
    '<span class="nav-row-icon ' + icon.cls + '">' + icon.svg + "</span>" +
    '<span class="nav-row-text"><span class="nav-row-title">' + escapeHtml(place.name) + "</span>" +
    (place.sub ? '<span class="nav-row-sub' + (place.empty ? " is-empty" : "") + '">' + escapeHtml(place.sub) + "</span>" : "") +
    "</span></button>" + actionHtml + "</div></li>"
  );
}

function bindPlaceRows(container, groups) {
  container.querySelectorAll(".nav-row").forEach((row) => {
    row.addEventListener("click", () => {
      const place = groups[row.dataset.group][Number(row.dataset.index)];
      if (!place) return;
      if (place.trip) {
        nav.from = place.trip.from;
        nav.to = place.trip.to;
        showPlan();
      } else if (place.slot && place.empty) {
        startSettingSlot(place.slot);
      } else {
        choosePlace(place);
      }
    });
  });
  container.querySelectorAll(".nav-row-action").forEach((button) => {
    button.addEventListener("click", () => {
      const place = groups[button.dataset.group][Number(button.dataset.index)];
      if (!place) return;
      if (button.dataset.action === "star") {
        const on = toggleSavedPlace(place);
        button.classList.toggle("is-on", on);
        button.setAttribute("aria-pressed", String(on));
        button.setAttribute("aria-label", on ? "Togli dai preferiti" : "Salva nei preferiti");
        if (!$("#nav-search-input").value.trim()) renderSearchHome();
      } else if (button.dataset.action === "edit") {
        startSettingSlot(place.slot);
      } else if (button.dataset.action === "unstar-trip") {
        const saved = readSaved();
        saved.trips = saved.trips.filter((trip) => !(samePlace(trip.from, place.trip.from) && samePlace(trip.to, place.trip.to)));
        writeSaved(saved);
        renderSearchHome();
      }
    });
  });
}

/* ---------------- pagina di ricerca ---------------- */

// Impostare Casa, Lavoro o un nuovo luogo preferito: la ricerca sceglie il posto e lo salva.
function startSettingSlot(slot) {
  nav.settingSlot = slot;
  const input = $("#nav-search-input");
  input.value = "";
  input.placeholder = slot === "home" ? "Indirizzo di casa" : slot === "work" ? "Indirizzo del lavoro" : "Luogo da salvare nei preferiti";
  renderSearchHome();
  input.focus({ preventScroll: true });
}

function renderSearchHome() {
  const body = $("#nav-search-body");
  const saved = readSaved();
  const groups = {
    here: [{ here: true, name: "Posizione attuale", sub: "Usa dove ti trovi adesso" }],
    fav: [],
    trips: saved.trips.map((trip) => ({ trip, name: "Verso " + pointText(trip.to), sub: "Da " + pointText(trip.from) })),
    recent: readRecents(),
    popular: POPULAR_PLACES.slice(0, 8),
  };
  let html = "";

  if (nav.settingSlot) {
    // Mentre si imposta un preferito si mostrano solo i posti da cui sceglierlo.
    html += '<p class="nav-empty">Scrivi l’indirizzo, oppure scegli uno dei luoghi qui sotto.</p>';
  } else {
    if (nav.picking === "from") html += '<ul class="nav-list">' + placeRow(groups.here[0], 0, "here") + "</ul>";

    groups.fav = [
      saved.home ? { ...saved.home, slot: "home", name: "Casa", sub: saved.home.name } : { slot: "home", name: "Casa", sub: "Tocca per impostare", empty: true },
      saved.work ? { ...saved.work, slot: "work", name: "Lavoro", sub: saved.work.name } : { slot: "work", name: "Lavoro", sub: "Tocca per impostare", empty: true },
    ].concat(saved.places.map((place) => ({ ...place, saved: true })));
    html += '<div class="nav-section-head"><p class="nav-section">Preferiti</p>' +
      '<button type="button" class="text-button" id="nav-add-fav">+ Aggiungi</button></div><ul class="nav-list">' +
      groups.fav.map((place, i) => placeRow(place, i, "fav", place.slot ? (place.empty ? null : "edit") : "star")).join("") + "</ul>";

    if (groups.trips.length) {
      html += '<p class="nav-section">Tragitti preferiti</p><ul class="nav-list">' +
        groups.trips.map((trip, i) => placeRow(trip, i, "trips", "unstar-trip")).join("") + "</ul>";
    }

    // Aprendo dalla mappa, c'e' anche l'ultimo percorso: un tocco e si ritrovano i risultati.
    const last = readStorage(NAV_LAST_KEY, null);
    if (nav.picking === "to" && !nav.returnTo && last && last.to && !tripSaved(last.from, last.to)) {
      groups.last = [{ trip: last, name: pointText(last.to), sub: "Da " + pointText(last.from) }];
      html += '<p class="nav-section">Ultimo percorso</p><ul class="nav-list">' + placeRow(groups.last[0], 0, "last", null) + "</ul>";
    }
  }

  if (groups.recent.length) {
    html += '<p class="nav-section">Recenti</p><ul class="nav-list">' +
      groups.recent.map((p, i) => placeRow(p, i, "recent", nav.settingSlot ? null : "star")).join("") + "</ul>";
  }
  html += '<p class="nav-section">Mete frequenti</p><ul class="nav-list">' +
    groups.popular.map((p, i) => placeRow(p, i, "popular", nav.settingSlot ? null : "star")).join("") + "</ul>";

  body.innerHTML = html;
  bindPlaceRows(body, groups);
  const addButton = $("#nav-add-fav");
  if (addButton) addButton.addEventListener("click", () => startSettingSlot("place"));
}

// Campidoglio: da qui parte la numerazione delle vie consolari.
const ROME_CENTER = { lat: 41.8933, lon: 12.4829 };

// Parole che non distinguono una via dall'altra ("via", "di", "della"...).
const STREET_FILLERS = new Set([
  "via", "viale", "v", "piazza", "piazzale", "p", "largo", "corso", "vicolo", "lungotevere", "circonvallazione",
  "borgo", "strada", "di", "del", "della", "dello", "dei", "degli", "delle", "de", "d", "da", "n", "numero", "civico",
]);

function streetWords(text) {
  return normalizeText(text).split(" ").filter((word) => word && !STREET_FILLERS.has(word));
}

// "Via Prenestina 300", "via prenestina, 300", "via prenestina n. 300/b" -> via + numero civico.
function parseAddress(text) {
  const match = normalizeText(text).match(/^(.*?[a-z].*?)\s+(?:n\s+)?(\d{1,4})\s*([a-z])?(?:\s+\d+)?$/);
  if (!match || !streetWords(match[1]).length) return null;
  return { street: match[1], number: Number(match[2]), label: match[2] + (match[3] || "").toUpperCase() };
}

/* ---------------- numeri civici ufficiali di Roma (ANNCSU) ---------------- */

// L'archivio nazionale dei numeri civici (Agenzia delle Entrate e Istat, CC BY 4.0) ha ogni civico di
// Roma con le sue coordinate; OpenStreetMap, e quindi Transitous, ne conosce solo una parte.
// In data/civici: vie.json (tutte le vie) e 32 file con i civici, scaricati solo quando servono.
const CIVICI_URL = "data/civici/";
const STREET_TYPES = new Set(["via", "viale", "piazza", "piazzale", "largo", "corso", "vicolo", "lungotevere", "circonvallazione", "borgo", "strada", "salita", "clivo", "vicolo", "galleria", "passeggiata", "rampa", "scalinata", "piazzetta", "lungomare", "traversa", "contrada", "localita"]);
let streetIndex = null;
const civiciShards = new Map();

function loadStreetIndex() {
  if (!streetIndex) {
    streetIndex = fetch(CIVICI_URL + "vie.json")
      .then((response) => {
        if (!response.ok) throw new Error("vie " + response.status);
        return response.json();
      })
      .then((rows) => rows.map(([name, shard, lat, lon]) => {
        const words = normalizeText(name).split(" ");
        return { name, shard, lat: lat / 1e5, lon: lon / 1e5, type: words[0], words: streetWords(name) };
      }))
      .catch((error) => {
        streetIndex = null;
        throw error;
      });
  }
  return streetIndex;
}

function loadCivici(shard) {
  if (!civiciShards.has(shard)) {
    civiciShards.set(shard, fetch(CIVICI_URL + "civici-" + String(shard).padStart(2, "0") + ".json")
      .then((response) => {
        if (!response.ok) throw new Error("civici " + response.status);
        return response.json();
      })
      .catch((error) => {
        civiciShards.delete(shard);
        throw error;
      }));
  }
  return civiciShards.get(shard);
}

// Ogni civico e' scritto come differenza dal precedente, in centomillesimi di grado.
function decodeCivici(entry) {
  let lat = entry[0];
  let lon = entry[1];
  return entry[2].split(";").map((part) => {
    const [label, delta] = part.split(":");
    const [dLat, dLon] = delta.split(",").map(Number);
    lat += dLat;
    lon += dLon;
    return { label, number: parseInt(label, 10), lat: lat / 1e5, lon: lon / 1e5 };
  });
}

function matchStreets(index, text, limit) {
  const typed = streetWords(text);
  if (!typed.length || typed.join("").length < 3) return [];
  const typedType = normalizeText(text).split(" ")[0];
  const near = referencePoint();
  return index
    .map((street) => {
      if (!typed.every((word) => street.words.some((candidate) => candidate.startsWith(word)))) return null;
      const extra = street.words.filter((candidate) => !typed.some((word) => candidate.startsWith(word))).length;
      const whole = typed.every((word) => street.words.includes(word));
      let score = (whole ? 3 : 0) - extra * 1.2 - haversineMeters(near, street) / 5000;
      if (STREET_TYPES.has(typedType)) score += typedType === street.type ? 1.5 : -1;
      return { street, score };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((result) => result.street);
}

function distanceNote(place) {
  if (!state.position) return "";
  return metersLabel(haversineMeters(state.position, place)) + " · ";
}

// Indirizzi ufficiali: "via anapo 51" -> Via Anapo 51; "via anapo" -> la via.
async function officialAddresses(text) {
  const address = parseAddress(text);
  const index = await loadStreetIndex();
  const streets = matchStreets(index, address ? address.street : text, address ? 3 : 4);
  if (!address) {
    return streets.map((street) => ({ name: prettyName(street.name), sub: distanceNote(street) + "Roma", lat: street.lat, lon: street.lon, kind: "street" }));
  }
  const results = [];
  const typed = streetWords(address.street);
  for (const [position, street] of streets.entries()) {
    const shard = await loadCivici(street.shard);
    if (!shard[street.name]) continue;
    const numbers = decodeCivici(shard[street.name]);
    const exact = numbers.find((item) => item.label === address.label) || numbers.find((item) => item.number === address.number);
    const pretty = prettyName(street.name);
    if (exact) {
      results.push({ name: pretty + " " + exact.label, sub: distanceNote(exact) + "Roma", lat: exact.lat, lon: exact.lon, kind: "address" });
      continue;
    }
    // Il civico non esiste: il piu' vicino, ma solo sulla via che hai scritto (non su "Via Capranica Prenestina").
    const sameStreet = street.words.every((candidate) => typed.some((word) => candidate.startsWith(word)));
    if (position > 0 || !sameStreet) continue;
    const closest = numbers
      .slice()
      .sort((a, b) => Math.abs(a.number - address.number) + (a.number % 2 === address.number % 2 ? 0 : 0.5) -
        (Math.abs(b.number - address.number) + (b.number % 2 === address.number % 2 ? 0 : 0.5)))[0];
    if (closest) {
      results.push({
        name: pretty + " " + closest.label,
        sub: "Il " + address.label + " non c’è, questo è il più vicino · Roma",
        lat: closest.lat,
        lon: closest.lon,
        kind: "address",
      });
    }
  }
  return results;
}

function areaTown(item) {
  // Aree dal piu' grande al piu' piccolo: Italia / Lazio / Roma (provincia) / Genazzano, oppure
  // Italia / Lazio / Roma / Roma / Municipio Roma V. Il comune e' l'ultima prima dei municipi.
  const areas = (item.areas || []).map((area) => area.name).filter((name) => name && !/^Municipio/i.test(name));
  return areas.length > 2 ? areas[areas.length - 1] : areas.find((name) => name !== "Italia" && name !== "Lazio") || "";
}

// Il servizio mette spesso in cima civici sbagliati (Via Casilina km 71,700 a Ferentino per "via casilina 700",
// Via di Casal Boccone 208 per "via di boccea 200"): si riordina guardando via giusta, civico e distanza.
function rankGeocode(items, text) {
  const address = parseAddress(text);
  const typed = streetWords(address ? address.street : text);
  const near = referencePoint();
  return items
    .map((item, rank) => {
      const words = streetWords(item.street || item.name);
      const hits = typed.filter((word) => words.some((candidate) => candidate.startsWith(word))).length;
      const extra = words.filter((candidate) => !typed.some((word) => candidate.startsWith(word))).length;
      let score = -rank * 0.3;
      if (typed.length) score += hits === typed.length ? 6 - Math.min(extra, 3) * 0.5 : hits * 1.5;
      // Vicino conta molto (la farmacia a 200 m prima di quella a 5 km), ma in scala: da 20 a 40 km cambia poco.
      score -= Math.log2(1 + haversineMeters(near, item) / 1000) * 1.5;
      const result = { item, score, sameStreet: hits === typed.length && typed.length > 0, extra, exact: false, nearNumber: null };
      if (address) {
        const houseNumber = String(item.houseNumber || "");
        if (/km/i.test(houseNumber)) result.score -= 6;
        else if (houseNumber) {
          const number = parseInt(houseNumber, 10);
          if (number === address.number) {
            result.score += 4;
            result.exact = true;
          } else if (Math.abs(number - address.number) <= 12) {
            result.score += 2.5;
            result.nearNumber = number;
          } else result.score -= 1;
        } else if (item.type === "ADDRESS") result.score += 0.5;
      }
      return result;
    })
    .sort((a, b) => b.score - a.score);
}

async function geocodeRequest(text) {
  const near = referencePoint();
  const url = TRANSITOUS + "/v1/geocode?text=" + encodeURIComponent(text) + "&place=" + near.lat.toFixed(4) + "," + near.lon.toFixed(4) +
    "&placeBias=5&numResults=20&language=it";
  const response = await fetch(url);
  if (!response.ok) throw new Error("ricerca non disponibile");
  const payload = await response.json();
  return (Array.isArray(payload) ? payload : [])
    .filter((item) => Number.isFinite(item.lat) && Number.isFinite(item.lon))
    // Solo il Lazio: stesso riquadro della ricerca delle fermate.
    .filter((item) => item.lat > 40.7 && item.lat < 43.0 && item.lon > 11.3 && item.lon < 14.1);
}

async function geocode(text) {
  const key = text.toLowerCase();
  if (geocodeCache.has(key)) return geocodeCache.get(key);
  const address = parseAddress(text);
  let ranked = rankGeocode(await geocodeRequest(text), text);

  // Civico che OpenStreetMap non conosce: meglio portare sulla via giusta che su un'altra via.
  let streetOnly = null;
  if (address && !ranked.some((r) => r.sameStreet && (r.exact || r.nearNumber !== null))) {
    const streets = rankGeocode(await geocodeRequest(address.street), address.street)
      .filter((r) => r.sameStreet && r.extra === 0 && r.item.type === "ADDRESS" && !r.item.houseNumber);
    // La numerazione parte dal lato verso il centro: per i civici bassi si sceglie quel tratto.
    if (address.number <= 60) streets.sort((a, b) => haversineMeters(ROME_CENTER, a.item) - haversineMeters(ROME_CENTER, b.item));
    streetOnly = streets[0] || null;
    if (streetOnly) ranked = [streetOnly].concat(ranked);
  }

  const places = ranked.map((r) => {
    const item = r.item;
    const town = areaTown(item);
    const isStop = item.type === "STOP";
    const local = isStop ? localStopFor(transitousStopId(item.id), ATAC_FEED) : null;
    let name = local ? local.name : prettyName(item.name);
    let sub = isStop ? (local ? stopSubtitle(local) : "Fermata") + (town ? ", " + town : "") : town;
    if (!isStop && item.street && item.houseNumber && item.name.indexOf(item.street) === -1) sub = [item.street + " " + item.houseNumber, town].filter(Boolean).join(", ");
    if (address && r.nearNumber !== null && r.sameStreet && r.extra === 0) sub = "Civico più vicino al " + address.number + (town ? " · " + town : "");
    if (r === streetOnly) sub = "Civico " + address.number + " non trovato: ti porto sulla via" + (town ? " · " + town : "");
    if (!isStop && r !== streetOnly) sub = distanceNote(item) + sub;
    return {
      name,
      sub,
      lat: item.lat,
      lon: item.lon,
      category: item.category || "",
      kind: isStop ? "stop" : "place",
      tone: local && local.mode === "MetroStation" ? stopTone(local) : isStop ? "tone-stop" : "",
    };
  });
  const unique = dedupePlaces(places).slice(0, 10);
  geocodeCache.set(key, unique);
  return unique;
}

function renderFound(local, remote, waiting, official = [], addressFirst = false) {
  const body = $("#nav-search-body");
  const known = local.concat(official);
  // Con gli indirizzi ufficiali, le vie e i civici di Transitous a Roma sono doppioni meno precisi.
  const remoteOnly = remote.filter((place) => !known.some((other) => normalizeText(other.name) === normalizeText(place.name) && haversineMeters(other, place) < 400) &&
    !(official.length && place.kind === "place" && !place.category && official.some((other) => haversineMeters(other, place) < 1500)));
  const groups = { local, remote: remoteOnly, official };
  const section = (title, list, group) => list.length
    ? '<p class="nav-section">' + title + '</p><ul class="nav-list">' + list.map((p, i) => placeRow(p, i, group, nav.settingSlot || p.slot ? null : "star")).join("") + "</ul>"
    : "";
  const addresses = section("Indirizzi", official, "official");
  let html = (addressFirst ? addresses : "") + section("Suggerimenti", local, "local") + section("Luoghi", remoteOnly, "remote") + (addressFirst ? "" : addresses);
  if (!local.length && !remoteOnly.length && !official.length) {
    html = waiting
      ? '<div class="skeleton trip-skeleton"></div>'
      : '<p class="nav-empty">Nessun luogo con questo nome. Prova con la via, il quartiere o il nome del locale.</p>';
  }
  body.innerHTML = html;
  bindPlaceRows(body, groups);
}

function onSearchInput() {
  const text = $("#nav-search-input").value.trim();
  window.clearTimeout(geocodeTimer);
  if (!text) {
    renderSearchHome();
    return;
  }
  // Subito i suggerimenti che l'app conosce gia' (mete frequenti, preferiti, fermate): bastano 1-2 lettere.
  const local = localSuggestions(text);
  renderFound(local, [], text.length >= 2);
  if (text.length < 2) return;

  // "via ...", "piazza ..." o un numero civico: in cima gli indirizzi.
  const address = parseAddress(text);
  const addressFirst = Boolean(address) || STREET_TYPES.has(normalizeText(text).split(" ")[0]);
  // Con un civico, dei risultati di Transitous restano solo locali, fermate e la via giusta
  // (niente "Via Napoli 51" per "via anapo 51").
  const relevant = (list) => address
    ? list.filter((place) => place.kind === "stop" || place.category || matchesWords(normalizeText(place.name), streetWords(address.street)))
    : list;
  const body = $("#nav-search-body");
  body.setAttribute("aria-busy", "true");
  geocodeTimer = window.setTimeout(async () => {
    const token = ++geocodeToken;
    let official = [];
    let places = [];
    // Gli indirizzi ufficiali arrivano prima (file sul sito): si mostrano senza aspettare Transitous.
    const officialDone = officialAddresses(text)
      .then((list) => {
        official = list;
        if (token === geocodeToken) renderFound(local, places, true, official, addressFirst);
      })
      .catch(() => {});
    try {
      places = relevant(await geocode(text));
      await officialDone;
      if (token !== geocodeToken) return;
      renderFound(local, places, false, official, addressFirst);
    } catch (error) {
      await officialDone;
      if (token !== geocodeToken) return;
      if (official.length) renderFound(local, [], false, official, addressFirst);
      else if (!local.length) body.innerHTML = '<p class="nav-empty">La ricerca non risponde adesso. Controlla la connessione e riprova.</p>';
    } finally {
      if (token === geocodeToken) body.removeAttribute("aria-busy");
    }
  }, 200);
}

function choosePlace(place) {
  // Si sta impostando Casa, Lavoro o un preferito: si salva e si torna all'elenco.
  if (nav.settingSlot) {
    const saved = readSaved();
    const point = cleanPoint(place.here ? state.position && { name: "Posizione attuale", lat: state.position.lat, lon: state.position.lon } : place);
    if (nav.settingSlot === "home") saved.home = point;
    else if (nav.settingSlot === "work") saved.work = point;
    else if (!saved.places.some((item) => samePlace(item, point))) saved.places.unshift(point);
    writeSaved(saved);
    const label = nav.settingSlot === "home" ? "Casa" : nav.settingSlot === "work" ? "Lavoro" : place.name;
    nav.settingSlot = null;
    toast("Fatto: «" + label + "» è nei preferiti.");
    const input = $("#nav-search-input");
    input.value = "";
    input.placeholder = nav.picking === "from" ? "Da dove parti?" : "Dove vuoi andare?";
    renderSearchHome();
    return;
  }

  // Casa e Lavoro si usano col loro indirizzo, ma nella pianificazione si leggono col loro nome.
  const target = place.slot ? { ...place, name: place.name, sub: place.sub } : place;
  if (!place.popular && !place.slot && !place.trip) rememberPlace(target);
  const chosen = place.here ? { here: true } : cleanPoint(target);
  if (nav.picking === "from") nav.from = chosen;
  else {
    nav.to = chosen;
    if (!nav.returnTo) nav.from = { here: true };
  }
  if (!nav.to) {
    startSearch("to", "plan");
    return;
  }
  showPlan();
}

/* ---------------- pianifica un viaggio ---------------- */

function pointText(point) {
  if (!point) return "";
  return point.here ? "Posizione attuale" : point.name;
}

function showPlan(replan = true) {
  openNavPanel("plan");
  if (nav.to) writeStorage(NAV_LAST_KEY, { from: nav.from, to: nav.to });
  $("#nav-from-text").textContent = pointText(nav.from);
  const toText = $("#nav-to-text");
  toText.textContent = nav.to ? pointText(nav.to) : "Scegli la meta";
  toText.classList.toggle("is-empty", !nav.to);
  updateTripStar();
  updateTimeText();
  if (replan || !nav.itineraries.length) planTrip();
}

function timeParam() {
  if (nav.timeMode === "now" || !nav.timeValue) return null;
  const [hours, minutes] = nav.timeValue.split(":").map(Number);
  const date = new Date();
  date.setDate(date.getDate() + (nav.timeDay || 0));
  date.setHours(hours, minutes, 0, 0);
  return date.toISOString();
}

const DAY_FORMAT = new Intl.DateTimeFormat("it-IT", { weekday: "short", day: "numeric", month: "short" });

function dayLabel(offset) {
  if (offset === 0) return "Oggi";
  if (offset === 1) return "Domani";
  const date = new Date();
  date.setDate(date.getDate() + offset);
  const text = DAY_FORMAT.format(date);
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function updateTimeText() {
  const label = $("#nav-time-text");
  // Testo corto: deve stare su una riga nel tasto.
  const day = nav.timeDay || 0;
  const when = day === 0 ? "" : dayLabel(day) + " ";
  if (nav.timeMode === "depart") label.textContent = (day ? when : "Partenza ") + "alle " + nav.timeValue;
  else if (nav.timeMode === "arrive") label.textContent = (day ? when : "Arrivo ") + "entro le " + nav.timeValue;
  else label.textContent = "Partendo ora";
}

function planSkeleton() {
  return Array.from({ length: 3 }).map(() => '<div class="skeleton trip-skeleton"></div>').join("");
}

async function planTrip(more) {
  if (!nav.to) return;
  const results = $("#nav-results");
  const token = ++nav.token;
  if (!more) {
    nav.itineraries = [];
    nav.direct = [];
    nav.nextCursor = null;
    results.setAttribute("aria-busy", "true");
    results.innerHTML = planSkeleton();
  }

  try {
    const [from, to] = await Promise.all([resolvePoint(nav.from), resolvePoint(nav.to)]);
    const params = new URLSearchParams({
      fromPlace: from.lat.toFixed(6) + "," + from.lon.toFixed(6),
      toPlace: to.lat.toFixed(6) + "," + to.lon.toFixed(6),
      numItineraries: "8",
      directModes: "WALK,BIKE",
      maxDirectTime: "5400",
      // Di serie Transitous guarda solo 15 minuti di partenze e al massimo 15 minuti a piedi
      // all’inizio e alla fine: troppo poco, molte mete restavano senza percorso.
      searchWindow: "3600",
      maxPreTransitTime: "1800",
      maxPostTransitTime: "1800",
    });
    const time = timeParam();
    if (time) params.set("time", time);
    if (nav.timeMode === "arrive") params.set("arriveBy", "true");
    if (more && nav.nextCursor) params.set("pageCursor", nav.nextCursor);

    const response = await fetch(TRANSITOUS + "/v5/plan?" + params.toString());
    if (!response.ok) throw new Error("pianificatore: risposta " + response.status);
    const payload = await response.json();
    if (token !== nav.token) return;

    const known = new Set(nav.itineraries.map((it) => it.startTime + "|" + it.endTime + "|" + it.legs.length));
    (payload.itineraries || [])
      .filter((it) => !it.legs.some(implausibleLeg))
      .forEach((it) => {
        const key = it.startTime + "|" + it.endTime + "|" + it.legs.length;
        if (!known.has(key)) nav.itineraries.push(it);
      });
    if (!more) nav.direct = payload.direct || [];
    nav.nextCursor = payload.nextPageCursor || null;
    // Pagina vuota (per esempio di notte): si prova da sola la pagina dopo, una volta.
    if (!nav.itineraries.length && nav.nextCursor && !more) {
      planTrip(true);
      return;
    }
    renderPlan();
  } catch (error) {
    if (token !== nav.token) return;
    results.innerHTML = /posizione/.test(error.message)
      ? '<p class="nav-empty">Non trovo la tua posizione. Attivala per questo sito oppure scegli un punto di partenza.</p>'
      : '<p class="nav-empty">Non riesco a calcolare il percorso adesso. Controlla la connessione e riprova.</p>';
    console.warn("pianificazione non riuscita:", error);
  } finally {
    if (token === nav.token) results.removeAttribute("aria-busy");
  }
}

// Alcune corse ATAC arrivano da Transitous con un tempo reale sballato: tutte le fermate allo stesso
// minuto, cosi' un bus di 7 minuti risulta di 0. Un percorso costruito su quei tempi puo' promettere
// coincidenze impossibili, quindi si scarta. Regola: tratta prevista di almeno 4 minuti che in tempo
// reale durerebbe meno della meta'.
function implausibleLeg(leg) {
  if (!isTransit(leg) || !leg.realTime || !leg.scheduledStartTime || !leg.scheduledEndTime) return false;
  const scheduled = new Date(leg.scheduledEndTime) - new Date(leg.scheduledStartTime);
  const live = new Date(leg.endTime) - new Date(leg.startTime);
  return scheduled >= 240000 && live < scheduled * 0.5;
}

function walkingSeconds(itinerary) {
  return itinerary.legs.filter((leg) => !isTransit(leg)).reduce((sum, leg) => sum + (leg.duration || 0), 0);
}

// Stesse linee dalla stessa fermata = stessa scheda, con piu' orari di partenza (come fa Moovit).
function groupItineraries(list) {
  const groups = new Map();
  list.forEach((itinerary) => {
    // Stesse fermate di salita e discesa = stesso tragitto, anche con linee diverse (come Moovit:
    // "3NAV / 19BUS" da Pitagora con gli orari di tutte e due).
    const signature = itinerary.legs
      .filter(isTransit)
      .map((leg) => normalizeText(placeLabel(leg.from, "")) + ">" + normalizeText(placeLabel(leg.to, "")))
      .join("|");
    if (!groups.has(signature)) groups.set(signature, []);
    groups.get(signature).push(itinerary);
  });
  return Array.from(groups.values()).map((items) => {
    items.sort((a, b) => new Date(a.startTime) - new Date(b.startTime));
    return { best: items[0], all: items };
  });
}

function sortGroups(groups) {
  const byArrival = (a, b) => new Date(a.best.endTime) - new Date(b.best.endTime);
  if (nav.sort === "walk") return groups.sort((a, b) => walkingSeconds(a.best) - walkingSeconds(b.best) || byArrival(a, b));
  if (nav.sort === "changes") return groups.sort((a, b) => a.best.transfers - b.best.transfers || byArrival(a, b));
  return groups.sort(byArrival);
}

function departureLine(group) {
  const first = group.best.legs.find(isTransit);
  if (!first) return "";
  const now = new Date();
  const times = group.all
    .map((it) => it.legs.find(isTransit))
    .filter(Boolean)
    .slice(0, 4)
    .map((leg) => ({ leg, minutes: Math.round((new Date(leg.startTime) - now) / 60000) }));
  // "Parte tra 2 min, 11 min" entro l'ora, "alle 08:32, 08:41" piu' avanti (o un altro giorno).
  const strong = (item, text) => '<strong class="' + (item.leg.realTime ? "is-live" : "") + '">' + text + "</strong>";
  const soon = times.filter((item) => item.minutes > 0 && item.minutes < 60).map((item) => strong(item, item.minutes + " min"));
  const later = times.filter((item) => item.minutes >= 60).map((item) => strong(item, clockOf(item.leg.startTime)));
  const parts = [];
  if (times.some((item) => item.minutes <= 0)) parts.push(strong(times[0], "adesso"));
  if (soon.length) parts.push("tra " + soon.join(", "));
  if (later.length) parts.push("alle " + later.join(", "));
  return '<p class="trip-depart">Parte ' + parts.join(", poi ") + " da " + escapeHtml(placeLabel(first.from, "fermata")) + "</p>";
}

// Per ogni tratta coi mezzi, le linee che la fanno nel gruppo: "3NAV / 19BUS".
function groupLines(group) {
  const sets = [];
  group.all.forEach((itinerary) => {
    itinerary.legs.filter(isTransit).forEach((leg, k) => {
      sets[k] = sets[k] || [];
      if (!sets[k].some((item) => item.line === legLine(leg))) sets[k].push({ line: legLine(leg), leg });
    });
  });
  return sets;
}

function groupLegsHtml(group) {
  const sets = groupLines(group);
  const parts = [];
  let k = 0;
  group.best.legs.forEach((leg) => {
    if (isTransit(leg)) {
      const set = sets[k++] || [{ line: legLine(leg), leg }];
      parts.push('<span class="leg-chip ' + legTone(leg) + '">' + ICON[legKind(leg)] + escapeHtml(set.map((item) => item.line).join(" / ")) + "</span>");
    } else if (leg.mode === "WALK" && leg.duration >= 60) parts.push('<span class="leg-walk" title="A piedi">' + ICON.walk + "</span>");
  });
  return '<div class="legs">' + parts.join(ICON.sep) + "</div>";
}

// "tra 1 min, 15, 25" entro l'ora, poi l'orario: come nell'elenco delle partenze.
function timesText(legs) {
  const now = Date.now();
  return legs.map((leg, i) => {
    const minutes = Math.round((Date.parse(leg.startTime) - now) / 60000);
    const text = minutes <= 0 ? "adesso" : minutes < 60 ? minutes + (i === 0 ? " min" : "") : clockOf(leg.startTime);
    return '<strong class="' + (leg.realTime ? "is-live" : "") + '">' + text + "</strong>";
  }).join(", ");
}

function tripCard(group, index) {
  const it = group.best;
  const minutes = Math.round(it.duration / 60);
  const walk = Math.round(walkingSeconds(it) / 60);
  const extra = [walk ? durationLabel(walk) + " a piedi" : "", it.transfers ? it.transfers + (it.transfers === 1 ? " cambio" : " cambi") : "senza cambi"].filter(Boolean).join(" · ");
  return (
    '<button type="button" class="trip-card" data-group="' + index + '">' +
    '<span class="trip-time"><span class="trip-duration">' + (minutes < 60 ? minutes + " <small>min</small>" : Math.floor(minutes / 60) + '<span class="unit">h</span>' + (minutes % 60 ? " " + (minutes % 60) + " <small>min</small>" : "")) + "</span>" +
    '<span class="trip-clock">' + clockOf(it.startTime) + "<strong>" + clockOf(it.endTime) + "</strong></span></span>" +
    '<span class="trip-body">' + groupLegsHtml(group) + departureLine(group) + '<p class="trip-extra">' + extra + "</p></span>" +
    "</button>"
  );
}

function renderPlan() {
  const results = $("#nav-results");
  const groups = sortGroups(groupItineraries(nav.itineraries));
  nav.groups = groups;
  let html = "";

  if (groups.length) {
    html += groups.map(tripCard).join("");
  } else {
    html += '<p class="nav-empty">Nessun percorso con i mezzi a quest’ora. Prova un altro orario, oppure a piedi o in bici.</p>';
  }

  const walk = nav.direct.find((d) => d.legs.every((leg) => leg.mode === "WALK"));
  const bike = nav.direct.find((d) => d.legs.some((leg) => leg.mode === "BIKE"));
  if (walk || bike) {
    html += '<p class="nav-section">A piedi e in bici</p><div class="direct-grid">';
    [["walk", walk, "A piedi"], ["bike", bike, "Bici"]].forEach(([kind, it, label]) => {
      if (!it) return;
      const meters = it.legs.reduce((sum, leg) => sum + (leg.distance || 0), 0);
      html += '<button type="button" class="direct-card" data-direct="' + kind + '"><strong>' + durationLabel(it.duration / 60) +
        '</strong><span>' + ICON[kind] + label + " " + metersLabel(meters) + "</span></button>";
    });
    html += "</div>";
  }

  if (nav.nextCursor && groups.length) html += '<button type="button" class="pill-button nav-more" id="nav-more">Partenze più tardi</button>';
  html += '<p class="nav-credit">Percorsi calcolati con <a href="https://transitous.org/sources/" target="_blank" rel="noopener">Transitous</a>, dati di Roma Mobilità e Trenitalia.</p>';
  results.innerHTML = html;

  results.querySelectorAll("[data-group]").forEach((card) => {
    card.addEventListener("click", () => showItinerary(nav.groups[Number(card.dataset.group)].best));
  });
  results.querySelectorAll("[data-direct]").forEach((card) => {
    card.addEventListener("click", () => showItinerary(card.dataset.direct === "walk" ? walk : bike));
  });
  const moreButton = $("#nav-more");
  if (moreButton) moreButton.addEventListener("click", () => {
    moreButton.disabled = true;
    moreButton.textContent = "Cerco…";
    planTrip(true);
  });
}

/* ---------------- percorso sulla mappa ---------------- */

function clearRoute() {
  if (nav.routeLayer) nav.routeLayer.remove();
  nav.routeLayer = null;
  nav.shown = null;
  $("#route-sheet").hidden = true;
  $("#view-map").classList.remove("has-route");
  window.setTimeout(() => map.invalidateSize(), 0);
  $("#nav-open").hidden = false;
  $("#btn-gps").hidden = false;
  refreshMarkers();
}

function drawRoute(itinerary) {
  if (nav.routeLayer) nav.routeLayer.remove();
  const layer = L.layerGroup();
  const bounds = [];
  const ring = darkNow() ? BAR_DARK : "#ffffff";

  itinerary.legs.forEach((leg) => {
    const geometry = leg.legGeometry;
    const points = geometry && geometry.points ? decodePolyline(geometry.points, geometry.precision || 6) : [[leg.from.lat, leg.from.lon], [leg.to.lat, leg.to.lon]];
    points.forEach((point) => bounds.push(point));
    const transit = isTransit(leg);
    L.polyline(points, {
      color: transit ? legColor(leg) : darkNow() ? "#9aa7bf" : "#5b6680",
      weight: transit ? 6 : 4,
      opacity: 0.95,
      dashArray: transit ? null : "1 8",
      lineCap: "round",
    }).addTo(layer);
    if (transit) {
      [leg.from, leg.to].forEach((stop) => {
        L.circleMarker([stop.lat, stop.lon], { radius: 6, color: legColor(leg), weight: 3, fillColor: ring, fillOpacity: 1 }).addTo(layer);
      });
    }
  });

  const first = itinerary.legs[0].from;
  const last = itinerary.legs[itinerary.legs.length - 1].to;
  L.circleMarker([first.lat, first.lon], { radius: 7, color: ring, weight: 3, fillColor: "#2f7fd1", fillOpacity: 1 }).addTo(layer);
  L.circleMarker([last.lat, last.lon], { radius: 8, color: ring, weight: 3, fillColor: "#e0572e", fillOpacity: 1 }).addTo(layer);

  layer.addTo(map);
  nav.routeLayer = layer;
  // La mappa ora occupa solo la parte sopra la lista: basta un margine uguale su tutti i lati.
  map.fitBounds(bounds, { padding: [30, 30] });
}

function stepHtml({ cls, tone, place, placeStop, note, time, live, extra }) {
  const link = placeStop ? ' is-link" data-open="' + escapeHtml(placeStop.id) + '" role="button" tabindex="0' : "";
  return (
    '<li class="step ' + cls + '" style="--tone:' + tone + '">' +
    '<span class="step-rail" aria-hidden="true"></span><span class="step-dot" aria-hidden="true"></span>' +
    '<div class="step-main"><div class="step-place' + link + '">' + escapeHtml(place) + "</div>" +
    (note ? '<div class="step-note">' + note + "</div>" : "") + (extra || "") + "</div>" +
    '<span class="step-time' + (live ? " is-live" : "") + '">' + (time || "") + "</span></li>"
  );
}

function lineChoices(itinerary, k) {
  const group = (nav.groups || []).find((item) => item.all.includes(itinerary));
  if (!group) return [];
  const byLine = new Map();
  group.all.forEach((other) => {
    const leg = other.legs.filter(isTransit)[k];
    if (!leg || Date.parse(leg.startTime) < Date.now() - 60000) return;
    const key = legLine(leg) + "|" + (leg.headsign || "");
    if (!byLine.has(key)) byLine.set(key, []);
    byLine.get(key).push(leg);
  });
  return Array.from(byLine.values())
    .map((list) => list.sort((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime)).slice(0, 3))
    .sort((a, b) => Date.parse(a[0].startTime) - Date.parse(b[0].startTime));
}

function choicesHtml(choices) {
  if (choices.length < 2 && !(choices[0] && choices[0].length > 1)) return "";
  return '<ul class="step-choices">' + choices.map((list) =>
    "<li>" + legChip(list[0]) + '<span class="choice-head">' + escapeHtml(prettyName(list[0].headsign || "")) + "</span>" +
    '<span class="choice-times">' + timesText(list) + "</span></li>").join("") + "</ul>";
}

function renderSteps(itinerary) {
  const fromName = pointText(nav.from) || "Partenza";
  const toName = pointText(nav.to) || "Arrivo";
  const steps = [];
  const legs = itinerary.legs;
  let transitIndex = 0;

  legs.forEach((leg, index) => {
    const isFirst = index === 0;
    const startName = isFirst ? fromName : placeLabel(leg.from, "Fermata");
    if (isTransit(leg)) {
      const tone = legColor(leg);
      const stops = (leg.intermediateStops || []).filter((stop) => stop.name);
      const count = stops.length + 1;
      const minutes = minutesBetween(leg.startTime, leg.endTime);
      const list = stops.length
        ? '<button type="button" class="step-toggle" aria-expanded="false">' + count + " fermate · " + durationLabel(minutes) + "</button>" +
          '<ul class="step-stops" hidden>' + stops.map((stop) =>
            "<li><span>" + escapeHtml(placeLabel(stop, "Fermata")) + "</span><span>" + clockOf(stop.arrival || stop.departure) + "</span></li>").join("") + "</ul>"
        : '<div class="step-note">' + count + " fermata · " + durationLabel(minutes) + "</div>";
      steps.push(stepHtml({
        cls: "is-transit",
        tone,
        place: startName,
        placeStop: localStopForLeg(leg.from),
        note: null,
        time: clockOf(leg.startTime),
        live: leg.realTime,
        extra: '<div class="step-line">' + legChip(leg) + "<span>verso " + escapeHtml(prettyName(leg.headsign || "")) + "</span></div>" +
          choicesHtml(lineChoices(itinerary, transitIndex++)) + list,
      }));
    } else {
      const minutes = Math.max(1, Math.round((leg.duration || 0) / 60));
      const label = leg.mode === "BIKE" ? "In bici" : "A piedi";
      steps.push(stepHtml({
        cls: "is-walk",
        tone: "var(--scheduled)",
        place: startName,
        placeStop: isFirst ? null : localStopForLeg(leg.from),
        note: label + " " + durationLabel(minutes) + (leg.distance ? " · " + metersLabel(leg.distance) : ""),
        time: clockOf(leg.startTime),
        live: false,
      }));
    }
  });

  const lastLeg = legs[legs.length - 1];
  steps.push(stepHtml({ cls: "is-end", tone: "#e0572e", place: toName, note: "Sei arrivato", time: clockOf(lastLeg.endTime), live: false }));

  const list = $("#route-steps");
  list.innerHTML = steps.join("");
  list.querySelectorAll(".step-toggle").forEach((button) => {
    button.addEventListener("click", () => {
      const stopsList = button.nextElementSibling;
      const open = stopsList.hidden;
      stopsList.hidden = !open;
      button.setAttribute("aria-expanded", open ? "true" : "false");
    });
  });
  list.querySelectorAll("[data-open]").forEach((item) => {
    const open = () => {
      const stop = state.byId.get(item.dataset.open);
      if (stop) openStop(stop);
    };
    item.addEventListener("click", open);
    item.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        open();
      }
    });
  });
}

function showItinerary(itinerary) {
  if (!itinerary) return;
  nav.shown = itinerary;
  closeNavPanel();
  showView("map");
  $("#nav-open").hidden = true;
  $("#btn-gps").hidden = true;
  $("#map-hint").hidden = true;

  const minutes = Math.round(itinerary.duration / 60);
  $("#route-summary").innerHTML =
    '<div class="route-total"><strong>' + durationLabel(minutes) + "</strong><span>" + clockOf(itinerary.startTime) + " – " + clockOf(itinerary.endTime) +
    '</span><button type="button" id="route-start" class="start-button">' + ICON_PLAY + "Avvia</button></div>" +
    (itinerary.legs.some(isTransit) ? groupLegsHtml((nav.groups || []).find((group) => group.all.includes(itinerary)) || { best: itinerary, all: [itinerary] }) : "");
  renderSteps(itinerary);
  $("#route-sheet").hidden = false;
  $("#view-map").classList.add("has-route");
  // La mappa si ridisegna dopo che il foglio ha preso la sua altezza.
  window.setTimeout(() => {
    map.invalidateSize();
    drawRoute(itinerary);
  }, 60);
}

/* ---------------- orario ---------------- */

// Rullo generico: una colonna di valori che si ferma sempre su uno, come quello di iOS ma senza
// tasti in piu'. Serve per l'orario di partenza o di arrivo.
function makeWheel(column, values, label) {
  column.innerHTML = values.map((value) => '<div class="wheel-item">' + label(value) + "</div>").join("");
  let timer = null;
  const index = () => Math.min(values.length - 1, Math.max(0, Math.round(column.scrollTop / WHEEL_ITEM)));
  const paint = () => {
    const current = index();
    Array.from(column.children).forEach((item, i) => item.classList.toggle("is-on", i === current));
    column.setAttribute("aria-valuenow", String(values[current]));
    column.setAttribute("aria-valuetext", label(values[current]));
  };
  column.addEventListener("scroll", () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(paint, 100);
  });
  Array.from(column.children).forEach((item, i) => {
    item.addEventListener("click", () => column.scrollTo({ top: i * WHEEL_ITEM, behavior: "smooth" }));
  });
  column.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    const next = Math.min(values.length - 1, Math.max(0, index() + (event.key === "ArrowDown" ? 1 : -1)));
    column.scrollTo({ top: next * WHEEL_ITEM, behavior: "smooth" });
  });
  return {
    get: () => values[index()],
    set: (value) => {
      const i = Math.max(0, values.indexOf(value));
      column.scrollTop = i * WHEEL_ITEM;
      paint();
    },
  };
}

let timeWheels = null;

function timeWheelsReady() {
  if (timeWheels) return timeWheels;
  const hours = Array.from({ length: 24 }, (_, i) => i);
  const minutes = Array.from({ length: 12 }, (_, i) => i * 5);
  const days = Array.from({ length: 14 }, (_, i) => i);
  timeWheels = {
    days: makeWheel($("#time-days"), days, dayLabel),
    hours: makeWheel($("#time-hours"), hours, (h) => String(h).padStart(2, "0")),
    minutes: makeWheel($("#time-minutes"), minutes, (m) => String(m).padStart(2, "0")),
  };
  return timeWheels;
}

function openTimeSheet() {
  $("#time-sheet").hidden = false;
  if (!nav.timeValue) {
    // Di partenza, il prossimo quarto d'ora.
    const now = new Date(Date.now() + 15 * 60000);
    const rounded = Math.ceil(now.getMinutes() / 5) * 5;
    now.setMinutes(rounded % 60);
    if (rounded === 60) now.setHours(now.getHours() + 1);
    nav.timeValue = String(now.getHours()).padStart(2, "0") + ":" + String(now.getMinutes()).padStart(2, "0");
  }
  setTimeMode(nav.timeMode);
}

function setTimeMode(mode) {
  nav.pendingMode = mode;
  $$("#time-mode .chip").forEach((chip) => chip.classList.toggle("is-on", chip.dataset.mode === mode));
  $("#time-field").hidden = mode === "now";
  if (mode !== "now") {
    // Il rullo si posiziona quando e' visibile (nascosto non ha misure).
    window.setTimeout(() => {
      const [h, m] = nav.timeValue.split(":").map(Number);
      const wheels = timeWheelsReady();
      wheels.days.set(nav.timeDay || 0);
      wheels.hours.set(h);
      wheels.minutes.set(Math.round(m / 5) * 5 % 60);
    }, 0);
  }
}

function wireNavigation() {
  // La barra sulla mappa riparte sempre da una ricerca vuota; l'ultimo percorso resta fra i recenti.
  $("#nav-open").addEventListener("click", () => startSearch("to", null));
  $("#nav-search-input").addEventListener("input", onSearchInput);
  $("#nav-search-cancel").addEventListener("click", () => {
    if (nav.settingSlot) {
      startSearch(nav.picking, nav.returnTo);
      return;
    }
    if (nav.returnTo === "plan" && nav.to) showPlan(false);
    else closeNavPanel();
  });
  $("#nav-plan-back").addEventListener("click", closeNavPanel);
  $("#nav-fav-trip").addEventListener("click", toggleSavedTrip);
  $("#stop-route-btn").addEventListener("click", () => {
    const stop = state.openStop;
    if (!stop) return;
    closeSheet();
    showView("map");
    nav.from = { here: true };
    nav.to = { name: stop.name, sub: stopSubtitle(stop), lat: stop.lat, lon: stop.lon, kind: "stop", tone: stop.mode === "MetroStation" ? stopTone(stop) : "tone-stop" };
    nav.returnTo = null;
    rememberPlace(nav.to);
    showPlan();
  });
  $("#nav-from").addEventListener("click", () => startSearch("from", "plan"));
  $("#nav-to").addEventListener("click", () => startSearch("to", "plan"));
  $("#nav-swap").addEventListener("click", () => {
    const from = nav.from;
    nav.from = nav.to || { here: true };
    nav.to = from;
    showPlan();
  });
  $("#nav-show-map").addEventListener("click", () => {
    if (nav.groups && nav.groups.length) showItinerary(nav.groups[0].best);
  });
  $$("#nav-sort .chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      nav.sort = chip.dataset.sort;
      $$("#nav-sort .chip").forEach((element) => element.classList.toggle("is-on", element === chip));
      if (nav.itineraries.length) renderPlan();
    });
  });

  $("#nav-time").addEventListener("click", openTimeSheet);
  $$("[data-time-close]").forEach((element) => element.addEventListener("click", () => ($("#time-sheet").hidden = true)));
  $$("#time-mode .chip").forEach((chip) => chip.addEventListener("click", () => setTimeMode(chip.dataset.mode)));
  $("#time-confirm").addEventListener("click", () => {
    nav.timeMode = nav.pendingMode || "now";
    if (nav.timeMode !== "now") {
      const wheels = timeWheelsReady();
      nav.timeValue = String(wheels.hours.get()).padStart(2, "0") + ":" + String(wheels.minutes.get()).padStart(2, "0");
      nav.timeDay = wheels.days.get();
    } else {
      nav.timeDay = 0;
    }
    $("#time-sheet").hidden = true;
    updateTimeText();
    planTrip();
  });

  $("#route-back").addEventListener("click", () => {
    clearRoute();
    showPlan(false);
  });
  $("#route-close").addEventListener("click", clearRoute);

  const sheet = $("#route-sheet");
  L.DomEvent.disableScrollPropagation(sheet);
  L.DomEvent.disableClickPropagation(sheet);
  let unlockTimer = null;
  const lockMap = () => {
    window.clearTimeout(unlockTimer);
    if (map && map.dragging.enabled()) map.dragging.disable();
  };
  // Sblocco con un attimo di ritardo: lo scorrimento per inerzia continua dopo che il dito si alza.
  const unlockMap = () => {
    window.clearTimeout(unlockTimer);
    unlockTimer = window.setTimeout(() => map && map.dragging.enable(), 700);
  };
  sheet.addEventListener("touchstart", lockMap, { passive: true });
  sheet.addEventListener("pointerdown", lockMap);
  sheet.addEventListener("touchend", unlockMap);
  sheet.addEventListener("touchcancel", unlockMap);
  sheet.addEventListener("pointerup", unlockMap);
  sheet.addEventListener("pointercancel", unlockMap);

  wireLive();
}


/* ------------------------------------------------------------------ *
 * Navigazione attiva ("Avvia"), come su Moovit: un riquadro con l'indicazione
 * del momento sopra la mappa, che avanza da solo con la posizione e l'orario,
 * e gli avvisi sul telefono anche a schermo spento.
 *
 * Su iPhone una pagina web a schermo spento viene congelata: non puo' mandare
 * notifiche da sola. Gli avvisi quindi si programmano all'avvio su ntfy.sh
 * (servizio gratuito e senza account) e li consegna l'app ntfy all'ora giusta.
 * ------------------------------------------------------------------ */

const NAV_LIVE_KEY = "roma-mobility-web/nav-live";
const ALERTS_KEY = "roma-mobility-web/alerts";
const NTFY = "https://ntfy.sh/";
// Una posizione piu' vecchia di cosi' non dice piu' dove sei: si ragiona con l'orario.
const FIX_FRESH_MS = 90000;

const live = {
  on: false,
  itinerary: null,
  destName: "",
  steps: [],
  index: 0,
  pausedUntil: 0, // dopo le frecce l'avanzamento automatico aspetta un po'
  watchId: null,
  timer: null,
  follow: true,
  lastFocus: 0,
  wakeLock: null,
  fix: null,
  topic: "",
  alertIds: [],
};

const ICON_PLAY = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l10.5-6.5Z"/></svg>';
const ICON_PREV = '<svg viewBox="0 0 24 24" aria-hidden="true"><polyline points="15 5 8 12 15 19"/></svg>';
const ICON_NEXT = '<svg viewBox="0 0 24 24" aria-hidden="true"><polyline points="9 5 16 12 9 19"/></svg>';

function capitalize(text) {
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

// "il bus 64", "la metro B", "il tram 8", "il treno FL1": come lo si direbbe a voce.
function lineArticle(leg) {
  const kind = legKind(leg);
  const line = legLine(leg);
  if (kind === "metro") return "la metro " + line.replace(/^M/, "");
  if (kind === "tram") return "il tram " + line;
  if (kind === "train") return line === "Treno" ? "il treno" : "il treno " + line;
  return "il bus " + line;
}

/* ---------------- passi del viaggio ---------------- */

function buildLiveSteps(itinerary, destName) {
  const steps = [];
  const legs = itinerary.legs;
  legs.forEach((leg, index) => {
    const start = Date.parse(leg.startTime);
    const end = Date.parse(leg.endTime);
    const next = legs[index + 1];
    const last = index === legs.length - 1;

    if (!isTransit(leg)) {
      // Cambio sulla stessa banchina: non e' un passo da seguire.
      if (index > 0 && !last && (leg.distance || 0) < 30 && (leg.duration || 0) < 90) return;
      const bike = leg.mode === "BIKE";
      const toName = last ? destName : placeLabel(leg.to, "la fermata");
      steps.push({
        kind: bike ? "bike" : "walk",
        icon: bike ? ICON.bike : ICON.walk,
        tone: "var(--scheduled)",
        title: (bike ? "Pedala fino a " : "Cammina fino a ") + toName,
        detail: durationLabel(Math.max(1, Math.round((leg.duration || 0) / 60))) + (leg.distance ? " · " + metersLabel(leg.distance) : "") +
          (next && isTransit(next) ? " · poi " + lineArticle(next) : ""),
        start,
        end,
        target: { lat: leg.to.lat, lon: leg.to.lon },
        radius: last ? 40 : 35,
      });
      return;
    }

    const line = lineArticle(leg);
    const fromName = placeLabel(leg.from, "la fermata");
    const toName = placeLabel(leg.to, "la fermata");
    const headsign = prettyName(leg.headsign || "");
    const before = steps.length ? steps[steps.length - 1].end : start;
    const k = legs.slice(0, index).filter(isTransit).length;
    const others = lineChoices(itinerary, k).filter((list) => legLine(list[0]) !== legLine(leg));
    steps.push({
      kind: "wait",
      others: others.map((list) => ({ line: lineArticle(list[0]), start: Date.parse(list[0].startTime) })),
      icon: ICON[legKind(leg)],
      tone: legColor(leg),
      chip: legChip(leg),
      title: "Aspetta " + line,
      detail: "",
      start: Math.min(before, start),
      end: start,
      target: { lat: leg.from.lat, lon: leg.from.lon },
      live: leg.realTime,
      line,
      fromName,
      headsign,
    });
    const stops = (leg.intermediateStops || [])
      .filter((stop) => stop.name && Number.isFinite(stop.lat))
      .map((stop) => ({ name: placeLabel(stop, "Fermata"), lat: stop.lat, lon: stop.lon, time: Date.parse(stop.arrival || stop.departure) || 0 }));
    stops.push({ name: toName, lat: leg.to.lat, lon: leg.to.lon, time: end });
    steps.push({
      kind: "ride",
      icon: ICON[legKind(leg)],
      tone: legColor(leg),
      chip: legChip(leg),
      title: "Scendi a " + toName,
      detail: "",
      start,
      end,
      target: { lat: leg.to.lat, lon: leg.to.lon },
      radius: 80,
      live: leg.realTime,
      stops,
      line,
      fromName,
      headsign,
    });
  });

  const lastLeg = legs[legs.length - 1];
  steps.push({
    kind: "arrive",
    icon: ICON.pin,
    tone: "#e0572e",
    title: "Sei arrivato",
    detail: destName,
    start: Date.parse(lastLeg.endTime),
    end: Infinity,
    target: { lat: lastLeg.to.lat, lon: lastLeg.to.lon },
  });
  return steps;
}

function freshFix() {
  return live.fix && Date.now() - live.fix.at < FIX_FRESH_MS ? live.fix : null;
}

// Fermate che mancano, destinazione compresa: con la posizione se c'e', altrimenti con l'orario.
function remainingStops(step, now) {
  const total = step.stops.length;
  const fix = freshFix();
  if (fix) {
    let nearest = -1;
    let best = 250;
    step.stops.forEach((stop, i) => {
      const distance = haversineMeters(fix, stop);
      if (distance < best) {
        best = distance;
        nearest = i;
      }
    });
    if (nearest >= 0) return Math.max(0, total - nearest - 1);
  }
  const reached = step.stops.filter((stop) => stop.time && stop.time <= now).length;
  return Math.max(0, total - reached);
}

function liveDetail(step, now) {
  if (step.kind === "wait") {
    return step.chip + " <span>A " + escapeHtml(step.fromName) + (step.headsign ? " · direzione " + escapeHtml(step.headsign) : "") +
      " · parte alle " + clockOf(step.end) +
      (step.others && step.others.length ? " · oppure " + escapeHtml(step.others.map((o) => o.line + " alle " + clockOf(o.start)).join(", ")) : "") + "</span>";
  }
  if (step.kind === "ride") {
    const left = remainingStops(step, now);
    const text = left === 0 ? "Scendi adesso" : left === 1 ? "Scendi alla prossima fermata" : "Direzione " + step.headsign + " · arrivo alle " + clockOf(step.end);
    return step.chip + " <span>" + escapeHtml(text) + "</span>";
  }
  return escapeHtml(step.detail);
}

// Il numero grande a destra: minuti all'arrivo del mezzo, metri che mancano, fermate che mancano.
function liveWhen(step, now) {
  const minutesTo = (time) => Math.ceil((time - now) / 60000);
  if (step.kind === "wait") {
    const minutes = minutesTo(step.end);
    if (minutes <= 0) return { value: "ora", unit: "" };
    return minutes < 60 ? { value: minutes, unit: "min" } : { value: clockOf(step.end), unit: "" };
  }
  if (step.kind === "ride") {
    const left = remainingStops(step, now);
    return { value: left, unit: left === 1 ? "fermata" : "fermate" };
  }
  if (step.kind === "walk" || step.kind === "bike") {
    const fix = freshFix();
    if (fix) {
      const meters = haversineMeters(fix, step.target);
      return meters >= 1000 ? { value: (meters / 1000).toFixed(1).replace(".", ","), unit: "km" } : { value: Math.max(0, Math.round(meters / 10) * 10), unit: "m" };
    }
    return { value: Math.max(0, minutesTo(step.end)), unit: "min" };
  }
  return { value: "", unit: "" };
}

/* ---------------- avanzamento ---------------- */

function stepDone(step, now) {
  const fix = freshFix();
  const distance = fix && step.target ? haversineMeters(fix, step.target) : null;
  if (step.kind === "walk" || step.kind === "bike") return fix ? distance <= step.radius : now >= step.end;
  // Il mezzo e' partito: se ti sei allontanato dalla fermata ci sei salito (senza posizione, dopo un paio di minuti).
  if (step.kind === "wait") return now >= step.end + 20000 && (!fix || distance > 100 || now >= step.end + 120000);
  if (step.kind === "ride") return fix ? distance <= step.radius && now >= step.end - 180000 : now >= step.end;
  return false;
}

function autoAdvance() {
  if (!live.on || Date.now() < live.pausedUntil) return;
  const now = Date.now();
  let index = live.index;
  while (index < live.steps.length - 1 && stepDone(live.steps[index], now)) index += 1;
  if (index !== live.index) goToStep(index, false);
}

function goToStep(index, manual) {
  const next = Math.max(0, Math.min(live.steps.length - 1, index));
  const changed = next !== live.index;
  live.index = next;
  if (manual) live.pausedUntil = Date.now() + 45000;
  saveLive();
  renderLive();
  if (changed || manual) {
    live.follow = true;
    focusStep();
  }
}

/* ---------------- schermo ---------------- */

function renderLive() {
  if (!live.on) return;
  const now = Date.now();
  const step = live.steps[live.index];
  $("#live-card").style.setProperty("--tone", step.tone);
  $("#live-icon").innerHTML = step.icon;
  $("#live-title").textContent = step.title;
  $("#live-sub").innerHTML = liveDetail(step, now);
  const when = liveWhen(step, now);
  const whenBox = $("#live-when");
  whenBox.innerHTML = when.value === "" ? "" : escapeHtml(String(when.value)) + (when.unit ? "<small>" + when.unit + "</small>" : "");
  whenBox.classList.toggle("is-live", Boolean(step.live) && step.kind === "wait");
  $("#live-count").textContent = "Passo " + (live.index + 1) + " di " + live.steps.length;
  $("#live-prev").disabled = live.index === 0;
  $("#live-next").disabled = live.index === live.steps.length - 1;

  const arrival = live.steps[live.steps.length - 1].start;
  const left = Math.round((arrival - now) / 60000);
  $("#live-eta").textContent = step.kind === "arrive" ? "Sei arrivato" : "Arrivo alle " + clockOf(arrival);
  $("#live-left").textContent = step.kind === "arrive" ? live.destName : left > 0 ? "tra " + durationLabel(left) : "tra poco";
  if (!$("#live-list").hidden) renderLiveList();
}

function renderLiveList() {
  $("#live-list").innerHTML = live.steps
    .map((step, i) =>
      '<li><button type="button" class="live-row' + (i === live.index ? " is-current" : i < live.index ? " is-done" : "") +
      '" data-step="' + i + '" style="--tone:' + step.tone + '"><span class="live-row-icon">' + step.icon + "</span>" +
      '<span class="live-row-text">' + escapeHtml(step.title) + "</span>" +
      '<span class="live-row-time">' + clockOf(step.kind === "wait" ? step.end : step.start) + "</span></button></li>")
    .join("");
}

// Inquadra quello che serve adesso: te e il prossimo punto, oppure le fermate che mancano.
function focusStep() {
  if (!live.on || !map) return;
  const step = live.steps[live.index];
  const fix = freshFix();
  const points = step.kind === "ride"
    ? step.stops.slice(Math.max(0, step.stops.length - remainingStops(step, Date.now()) - 1)).map((stop) => [stop.lat, stop.lon])
    : [[step.target.lat, step.target.lon]];
  if (fix) points.push([fix.lat, fix.lon]);
  const box = $("#view-map").getBoundingClientRect();
  const top = Math.max(20, $("#live-card").getBoundingClientRect().bottom - box.top + 16);
  const bottom = Math.max(20, box.bottom - $("#live-bar").getBoundingClientRect().top + 16);
  map.fitBounds(points, { paddingTopLeft: [28, top], paddingBottomRight: [28, bottom], maxZoom: 17 });
  live.lastFocus = Date.now();
}

function onLiveFix(position) {
  live.fix = { lat: position.coords.latitude, lon: position.coords.longitude, at: Date.now() };
  showPosition(position.coords);
  autoAdvance();
  renderLive();
  if (live.follow && Date.now() - live.lastFocus > 8000) focusStep();
}

function tickLive() {
  autoAdvance();
  renderLive();
}

async function keepAwake() {
  // Schermo acceso mentre si seguono le indicazioni (iOS 16.4+; se non c'e', pazienza).
  try {
    if (live.on && "wakeLock" in navigator && document.visibilityState === "visible" && !live.wakeLock) {
      live.wakeLock = await navigator.wakeLock.request("screen");
      live.wakeLock.addEventListener("release", () => (live.wakeLock = null));
    }
  } catch (error) {
    live.wakeLock = null;
  }
}

function saveLive() {
  if (!live.on) return;
  writeStorage(NAV_LIVE_KEY, {
    itinerary: live.itinerary,
    from: nav.from,
    to: nav.to,
    index: live.index,
    topic: live.topic,
    alertIds: live.alertIds,
  });
}

function startLive(itinerary, resume) {
  if (!itinerary) return;
  if (live.on) stopLive(false);
  live.on = true;
  live.itinerary = itinerary;
  live.destName = pointText(nav.to) || "Arrivo";
  live.steps = buildLiveSteps(itinerary, live.destName);
  live.index = resume ? Math.min(resume.index || 0, live.steps.length - 1) : 0;
  live.topic = resume ? resume.topic || "" : "";
  live.alertIds = resume ? resume.alertIds || [] : [];
  live.pausedUntil = 0;
  live.follow = true;
  nav.shown = itinerary;

  closeNavPanel();
  showView("map");
  $("#route-sheet").hidden = true;
  $("#view-map").classList.remove("has-route");
  $("#view-map").classList.add("is-live");
  $("#nav-open").hidden = true;
  $("#map-hint").hidden = true;
  $("#btn-gps").hidden = false;
  $("#live").hidden = false;
  $("#live-list").hidden = true;
  $("#view-map").classList.remove("live-list-open");
  $("#live-steps-btn").setAttribute("aria-expanded", "false");
  document.body.classList.add("live-on");
  refreshMarkers();

  if (navigator.geolocation) {
    live.watchId = navigator.geolocation.watchPosition(onLiveFix, () => {}, { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 });
  }
  live.timer = window.setInterval(tickLive, 5000);
  keepAwake();
  autoAdvance();
  renderLive();
  saveLive();
  window.setTimeout(() => {
    map.invalidateSize();
    drawRoute(itinerary);
    focusStep();
  }, 60);

  if (!resume) scheduleAlerts();
  $("#live-hint").hidden = resume || readAlertSettings().on;
}

function stopLive(backToRoute) {
  if (!live.on) return;
  live.on = false;
  window.clearInterval(live.timer);
  if (live.watchId !== null && navigator.geolocation) navigator.geolocation.clearWatch(live.watchId);
  live.watchId = null;
  if (live.wakeLock) live.wakeLock.release().catch(() => {});
  live.wakeLock = null;
  cancelAlerts();
  writeStorage(NAV_LIVE_KEY, null);
  $("#live").hidden = true;
  $("#view-map").classList.remove("is-live", "live-list-open");
  document.body.classList.remove("live-on");
  const arrival = live.steps.length ? live.steps[live.steps.length - 1].start : 0;
  if (backToRoute && Date.now() < arrival) showItinerary(live.itinerary);
  else clearRoute();
}

// Riaperta l'app durante un viaggio (iOS a volte la chiude a schermo spento): si riprende da dove eri.
function resumeLive() {
  const saved = readStorage(NAV_LIVE_KEY, null);
  if (!saved || !saved.itinerary || !saved.itinerary.legs) return;
  const legs = saved.itinerary.legs;
  const arrival = Date.parse(legs[legs.length - 1].endTime);
  if (Date.now() > arrival + 30 * 60000) {
    writeStorage(NAV_LIVE_KEY, null);
    return;
  }
  nav.from = saved.from || { here: true };
  nav.to = saved.to || null;
  startLive(saved.itinerary, saved);
}

/* ---------------- avvisi a schermo spento (ntfy) ---------------- */

function randomId(length) {
  const letters = "abcdefghijkmnpqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (byte) => letters[byte % letters.length]).join("");
}

// Il canale e' un nome casuale: chi non lo conosce non puo' leggere gli avvisi.
function readAlertSettings() {
  let settings = readStorage(ALERTS_KEY, null);
  if (!settings || !settings.topic) {
    settings = { topic: "roma-mobility-" + randomId(16), on: false };
    writeStorage(ALERTS_KEY, settings);
  }
  return settings;
}

function plannedAlerts(steps, destName) {
  const alerts = [];
  steps.forEach((step, i) => {
    if (step.kind !== "ride") return;
    const stopName = step.stops[step.stops.length - 1].name;
    alerts.push({
      at: step.start - 180000,
      title: capitalize(step.line) + " passa tra 3 minuti",
      message: "Alla fermata " + step.fromName + (step.headsign ? ", direzione " + step.headsign : "") + ". Parte alle " + clockOf(step.start) + ".",
      priority: 4,
    });
    // Quando il mezzo lascia la penultima fermata, la prossima e' quella giusta.
    const before = step.stops.length >= 2 ? step.stops[step.stops.length - 2] : null;
    const prepareAt = before && before.time > step.start ? before.time : step.end - 120000;
    if (prepareAt > step.start) {
      alerts.push({ at: prepareAt, title: "Scendi alla prossima fermata", message: "La prossima è " + stopName + ": preparati a scendere.", priority: 5 });
    }
    const next = steps[i + 1];
    let message = "Sei quasi arrivato.";
    if (next && (next.kind === "walk" || next.kind === "bike")) message = next.title + " (" + next.detail + ").";
    else if (next && next.kind === "wait" && steps[i + 2]) {
      const ride = steps[i + 2];
      message = "Ora prendi " + ride.line + ": parte alle " + clockOf(ride.start) + " da " + ride.fromName + ".";
    } else if (next && next.kind === "arrive") message = "Sei arrivato a " + destName + ".";
    alerts.push({ at: step.end, title: "Scendi ora: " + stopName, message, priority: 4 });
  });

  const first = steps[0];
  if (first && (first.kind === "walk" || first.kind === "bike")) {
    const ride = steps.find((step) => step.kind === "ride");
    alerts.push({
      at: first.start - 60000,
      title: "È ora di partire",
      message: first.title + (ride ? ": " + ride.line + " parte alle " + clockOf(ride.start) + "." : "."),
      priority: 4,
    });
  }
  const lastMove = steps[steps.length - 2];
  if (lastMove && lastMove.kind !== "ride") {
    alerts.push({ at: steps[steps.length - 1].start, title: "Sei arrivato", message: destName, priority: 3 });
  }
  return alerts.sort((a, b) => a.at - b.at);
}

async function publishAlert(topic, alert, id) {
  const body = { topic, title: alert.title, message: alert.message, priority: alert.priority || 4, sequence_id: id };
  if (alert.at) body.delay = String(Math.round(alert.at / 1000));
  const response = await fetch(NTFY, { method: "POST", body: JSON.stringify(body) });
  if (!response.ok) throw new Error("ntfy ha risposto " + response.status);
}

async function scheduleAlerts() {
  const settings = readAlertSettings();
  if (!settings.on) return;
  // ntfy accetta avvisi programmati da 10 secondi in poi.
  const alerts = plannedAlerts(live.steps, live.destName).filter((alert) => alert.at > Date.now() + 12000);
  if (!alerts.length) return;
  const trip = "rm" + Date.now().toString(36);
  live.topic = settings.topic;
  live.alertIds = [];
  const results = await Promise.all(alerts.map(async (alert, i) => {
    const id = trip + "-" + i;
    try {
      await publishAlert(settings.topic, alert, id);
      live.alertIds.push(id);
      return true;
    } catch (error) {
      return false;
    }
  }));
  saveLive();
  const sent = results.filter(Boolean).length;
  if (!live.on) return cancelAlerts();
  toast(sent === alerts.length
    ? "Avvisi pronti: te ne arriveranno " + sent + " durante il viaggio, anche a schermo spento."
    : "Non sono riuscito a programmare tutti gli avvisi: segui le indicazioni nell’app.");
}

// Terminato il viaggio, gli avvisi non ancora arrivati si cancellano (e quelli arrivati spariscono da ntfy).
function cancelAlerts() {
  const topic = live.topic;
  const ids = live.alertIds;
  live.alertIds = [];
  if (!topic) return;
  ids.forEach((id) => fetch(NTFY + encodeURIComponent(topic) + "/" + encodeURIComponent(id), { method: "DELETE", keepalive: true }).catch(() => {}));
}

function renderAlertsCard() {
  const settings = readAlertSettings();
  $("#alerts-topic").textContent = settings.topic;
  chipRow(
    $("#opt-alerts"),
    [
      { value: "on", label: "Accesi" },
      { value: "off", label: "Spenti" },
    ],
    (value) => (value === "on") === settings.on,
    (value) => {
      settings.on = value === "on";
      writeStorage(ALERTS_KEY, settings);
      renderAlertsCard();
    },
  );
  $("#alerts-test").disabled = !settings.on;
}

/* ---------------- collegamenti ---------------- */

function wireLive() {
  renderAlertsCard();

  // "Avvia" sta nel riepilogo del percorso, che si ridisegna a ogni percorso aperto.
  $("#route-summary").addEventListener("click", (event) => {
    if (event.target.closest("#route-start") && nav.shown) startLive(nav.shown, null);
  });
  $("#live-prev").innerHTML = ICON_PREV;
  $("#live-next").innerHTML = ICON_NEXT;
  $("#live-prev").addEventListener("click", () => goToStep(live.index - 1, true));
  $("#live-next").addEventListener("click", () => goToStep(live.index + 1, true));
  $("#live-stop").addEventListener("click", () => stopLive(true));
  $("#live-steps-btn").addEventListener("click", () => {
    const list = $("#live-list");
    list.hidden = !list.hidden;
    $("#view-map").classList.toggle("live-list-open", !list.hidden);
    $("#live-steps-btn").setAttribute("aria-expanded", list.hidden ? "false" : "true");
    if (!list.hidden) {
      renderLiveList();
      const current = list.querySelector(".is-current");
      if (current) current.scrollIntoView({ block: "nearest" });
    }
  });
  $("#live-list").addEventListener("click", (event) => {
    const row = event.target.closest("[data-step]");
    if (!row) return;
    $("#live-list").hidden = true;
    $("#view-map").classList.remove("live-list-open");
    $("#live-steps-btn").setAttribute("aria-expanded", "false");
    goToStep(Number(row.dataset.step), true);
  });
  $("#live-hint-close").addEventListener("click", () => ($("#live-hint").hidden = true));
  $("#live-hint-open").addEventListener("click", () => {
    $("#live-hint").hidden = true;
    showView("settings");
    window.setTimeout(() => $("#alerts-card").scrollIntoView({ block: "start", behavior: "smooth" }), 80);
  });

  // Spostando la mappa col dito si smette di seguirti; il tasto posizione ti riprende.
  map.on("dragstart", () => {
    if (live.on) live.follow = false;
  });
  $("#btn-gps").addEventListener("click", () => {
    if (!live.on) return;
    live.follow = true;
    window.setTimeout(focusStep, 400);
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible" || !live.on) return;
    keepAwake();
    tickLive();
    focusStep();
  });

  $("#alerts-copy").addEventListener("click", async () => {
    const topic = readAlertSettings().topic;
    try {
      await navigator.clipboard.writeText(topic);
      toast("Nome del canale copiato: incollalo in ntfy.");
    } catch (error) {
      toast("Copia a mano il nome del canale: " + topic);
    }
  });
  $("#alerts-test").addEventListener("click", async () => {
    const button = $("#alerts-test");
    button.disabled = true;
    try {
      await publishAlert(readAlertSettings().topic, { title: "Prova riuscita", message: "Gli avvisi di Roma Mobility arrivano su questo telefono.", priority: 3 }, "prova-" + Date.now().toString(36));
      toast("Avviso mandato: se non arriva, controlla di esserti iscritto al canale in ntfy.");
    } catch (error) {
      toast("ntfy non risponde adesso. Riprova tra poco.");
    } finally {
      button.disabled = false;
    }
  });

  resumeLive();
}

boot();
