/*
 * Copia locale del sito: dopo la prima visita si apre anche con rete ballerina.
 *
 * Due comportamenti diversi, per non restare mai con una versione vecchia in mano:
 *  - pagina, CSS e JS: prima si prova la rete, la copia serve solo se la rete non c'e';
 *  - fermate e icone: prima la copia (sono file grandi che non cambiano quasi mai),
 *    intanto in sottofondo si aggiornano.
 * Gli orari (/api/) e le tessere della mappa non vengono mai salvati: devono essere freschi.
 */

const CACHE_VERSION = "roma-mobility-v26";
const SHELL = [
  "./",
  "index.html",
  "styles.css",
  "app.js",
  "manifest.webmanifest",
  "icons/icon-192.png",
  "icons/logo-light.png",
  "icons/logo-dark.png",
  "icons/icon-512.png",
  "icons/apple-touch-icon.png",
  "data/stops.txt",
  "data/cotral_stops.txt",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_VERSION)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_VERSION).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

function save(request, response) {
  if (response && response.ok) {
    const copy = response.clone();
    caches.open(CACHE_VERSION).then((cache) => cache.put(request, copy));
  }
  return response;
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return;

  const isData = url.pathname.startsWith("/data/") || url.pathname.startsWith("/icons/");

  if (isData) {
    event.respondWith(
      caches.match(request).then((cached) => {
        const network = fetch(request)
          .then((response) => save(request, response))
          .catch(() => cached);
        return cached || network;
      }),
    );
    return;
  }

  event.respondWith(
    fetch(request)
      .then((response) => save(request, response))
      .catch(() => caches.match(request).then((cached) => cached || caches.match("index.html"))),
  );
});
