// Sprite Cloud PWA service worker — caches the XMB shell + cover art.
const CACHE = "sprite-cloud-v1";

// Shell assets — pre-cached on install for instant offline XMB
const SHELL = ["/xmb", "/manifest.json"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL).catch(() => {}))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Only intercept same-origin GET requests
  if (request.method !== "GET" || url.origin !== self.location.origin) return;

  // Cache cover art (images from games API)
  if (url.pathname.includes("/covers/") || url.pathname.includes("/cover")) {
    event.respondWith(
      caches.open(CACHE).then((cache) =>
        cache.match(request).then((cached) => {
          const network = fetch(request)
            .then((resp) => {
              if (resp.ok) cache.put(request, resp.clone());
              return resp;
            })
            .catch(() => cached);
          return cached || network;
        })
      )
    );
    return;
  }

  // Network-first for API + dynamic content, cache fallback for shell
  if (url.pathname === "/xmb" || url.pathname.startsWith("/_next/")) {
    event.respondWith(
      fetch(request)
        .then((resp) => {
          const cloned = resp.clone();
          caches.open(CACHE).then((cache) => cache.put(request, cloned));
          return resp;
        })
        .catch(() => caches.match(request))
    );
    return;
  }

  // Default: network-first
  event.respondWith(
    fetch(request).catch(() => caches.match(request))
  );
});
