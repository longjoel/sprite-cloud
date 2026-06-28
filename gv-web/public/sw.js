// ── sw.js — Games Vault service worker ──────────────────────────────
// Cache-first for static assets; network-first for API calls.
// Makes the PWA installable and provides an offline shell.

const CACHE_VERSION = "gv-v1";
const STATIC_CACHE = CACHE_VERSION + "-static";

// Assets to pre-cache on install (app shell + player)
const PRE_CACHE = [
  "/",
  "/dashboard",
  "/player/player-bundle.js",
  "/player/index.js",
  "/player/play.js",
  "/player/player-entry.js",
  "/player/touch-gamepad.js",
  "/player/index.html",
  "/manifest.json",
];

// Install: pre-cache shell assets
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) => {
      return cache.addAll(PRE_CACHE).catch((err) => {
        // Some paths may 404 (e.g. /dashboard when not authed) — that's OK
        console.log("[gv sw] pre-cache partial:", err.message);
      });
    })
  );
  self.skipWaiting();
});

// Activate: clean old caches
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((k) => k !== STATIC_CACHE).map((k) => caches.delete(k))
      );
    })
  );
  self.clients.claim();
});

// Fetch: cache-first for static, network-first for API
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Don't cache API / Next.js data requests
  if (
    url.pathname.startsWith("/api/") ||
    url.pathname.startsWith("/_next/data/") ||
    url.pathname.startsWith("/sdp")
  ) {
    return; // Let browser handle normally
  }

  // Cache-first for static assets
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;

      return fetch(event.request).then((response) => {
        // Only cache same-origin GET requests
        if (
          response.ok &&
          event.request.method === "GET" &&
          url.origin === self.location.origin
        ) {
          const clone = response.clone();
          caches.open(STATIC_CACHE).then((cache) => {
            cache.put(event.request, clone);
          });
        }
        return response;
      });
    })
  );
});
