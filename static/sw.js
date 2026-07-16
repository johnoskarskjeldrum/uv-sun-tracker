// Enkel service worker: cache app-skallet slik at PWA-en kan installeres
// og laste raskt. API-kall (/api/...) gaar alltid mot nettet.
const CACHE = "sol-tracker-v1";
const SHELL = [
  "/",
  "/index.html",
  "/style.css",
  "/app.js",
  "/manifest.webmanifest",
  "/icon.svg",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (url.pathname.startsWith("/api/")) return; // aldri cache API-svar
  e.respondWith(
    caches.match(e.request).then((cached) => cached || fetch(e.request))
  );
});
