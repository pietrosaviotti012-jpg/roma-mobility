/*
 * Piccolo tramite fra il sito e Transitland: serve solo a non pubblicare la chiave API
 * dentro la pagina. Su Netlify va impostata la variabile d'ambiente TRANSITLAND_API_KEY.
 *
 * Risponde a due domande, e solo a quelle:
 *  - ?stop=feed:stop_id&...     partenze da una fermata
 *  - ?route=123&trip=456        tutte le fermate di una corsa (per le fermate successive)
 */

const BASE = "https://transit.land/api/v2/rest";

// "f-sr-atac~romatpl~trenitalia:70240": feed Onestop + stop_id della fermata.
const STOP_KEY = /^[a-z0-9~._-]+:[a-z0-9~._-]+$/i;
// Linee e corse si chiedono con i numeri interni di Transitland.
const NUMERIC_ID = /^\d{1,15}$/;

// Solo i parametri che usa il sito: cosi' questa funzione non diventa un proxy aperto.
const ALLOWED = new Set(["relative_date", "next", "use_service_window", "limit", "include_alerts", "service_date"]);

exports.handler = async (event) => {
  const apiKey = process.env.TRANSITLAND_API_KEY;
  if (!apiKey) {
    return json(500, { error: "Manca la variabile TRANSITLAND_API_KEY nelle impostazioni del sito." });
  }

  const incoming = new URLSearchParams(event.queryStringParameters || {});
  let url = "";
  let maxAge = 15;

  if (incoming.has("route") || incoming.has("trip")) {
    const route = incoming.get("route") || "";
    const trip = incoming.get("trip") || "";
    if (!NUMERIC_ID.test(route) || !NUMERIC_ID.test(trip)) return json(400, { error: "Corsa non valida." });
    url = `${BASE}/routes/${route}/trips/${trip}`;
    // Le fermate di una corsa non cambiano durante il giorno: si possono tenere piu' a lungo.
    maxAge = 3600;
  } else {
    const stopKey = incoming.get("stop") || "";
    if (!STOP_KEY.test(stopKey)) return json(400, { error: "Fermata non valida." });
    const query = new URLSearchParams();
    incoming.forEach((value, key) => {
      if (ALLOWED.has(key) && value) query.append(key, value);
    });
    const encodedKey = stopKey.split(":").map(encodeURIComponent).join(":");
    url = `${BASE}/stops/${encodedKey}/departures?${query.toString()}`;
  }

  try {
    const response = await fetch(url, { headers: { Accept: "application/json", apikey: apiKey } });
    const body = await response.text();
    if (!response.ok) {
      return json(response.status, { error: `Transitland ha risposto ${response.status}` });
    }
    return {
      statusCode: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": `public, max-age=${maxAge}`,
      },
      body,
    };
  } catch (error) {
    return json(502, { error: "Transitland non risponde: " + (error && error.message ? error.message : "errore di rete") });
  }
};

function json(statusCode, payload) {
  return {
    statusCode,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    body: JSON.stringify(payload),
  };
}
