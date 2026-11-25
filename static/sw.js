const CACHE_NAME = "goldforex-v2";
const STATIC_ASSETS = [
  "/",
  "/static/css/style.css",
  "/static/js/main.js",
  "/static/js/state.js",
  "/static/js/format.js",
  "/static/js/api.js",
  "/static/js/scoring.js",
  "/static/js/market.js",
  "/static/js/wallet.js",
  "/static/js/tools.js",
  "/static/js/alerts.js",
  "/static/js/charts.js",
  "/lwc.js",
  "/manifest.json",
  "/static/icon.svg"
];

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC_ASSETS)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.map(key => {
          if (key !== CACHE_NAME) return caches.delete(key);
        })
      )
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);

  // Network-first for HTML, API, JS, and CSS so updates are immediate
  if (
    url.pathname === "/" ||
    url.pathname.startsWith("/api/") ||
    url.pathname.endsWith(".html") ||
    url.pathname.endsWith(".js") ||
    url.pathname.endsWith(".css")
  ) {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          if (response && response.status === 200 && response.type === "basic") {
            const toCache = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, toCache));
          }
          return response;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // Cache-first for images, fonts, icons, manifest
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        if (!response || response.status !== 200) return response;
        const toCache = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(event.request, toCache));
        return response;
      });
    })
  );
});

