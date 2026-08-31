const CACHE_NAME = "reelforge-shell-v1";
const APP_SHELL = [
  "/",
  "/styles.css",
  "/app.js",
  "/manifest.webmanifest",
  "/icons/icon-192x192.png",
  "/icons/icon-512x512.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
    ))
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const requestUrl = new URL(event.request.url);
  if (
    event.request.method !== "GET" ||
    requestUrl.origin !== self.location.origin ||
    requestUrl.pathname.startsWith("/api/") ||
    requestUrl.pathname.startsWith("/media/") ||
    requestUrl.pathname.startsWith("/editor-media/") ||
    requestUrl.pathname.startsWith("/timeline-media/") ||
    requestUrl.pathname.startsWith("/creative-media/") ||
    requestUrl.pathname.startsWith("/cover-media/") ||
    // ZIPs de lotes podem passar de centenas de MB: nunca vão para o cache.
    requestUrl.pathname.startsWith("/creative-download/")
  ) {
    return;
  }

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok) {
          const clone = response.clone();
          return caches.open(CACHE_NAME).then((cache) => {
            // Sem return/await, falha de quota vira unhandled rejection.
            return cache.put(event.request, clone).catch(() => {});
          }).then(() => response);
        }
        return response;
      })
      .catch(() => caches.match(event.request).then((cached) => cached || caches.match("/")))
  );
});
