// ── sw.js — Sprite Cloud service worker ──────────────────────────────
// Network-first for all requests; cache fallback only when offline.
// Never caches navigation (HTML) requests — those always go to the network.
// This prevents stale cache errors on deploy.

const CACHE_VERSION = "gv-v18";
const STATIC_CACHE = CACHE_VERSION + "-static";

// Static assets safe to cache (JS bundles, images, manifests)
const CACHEABLE_EXTENSIONS = [
  ".js", ".css", ".png", ".svg", ".ico", ".webp",
  ".woff", ".woff2", ".json",
];

function isCacheableAsset(url) {
  if (url.origin !== self.location.origin) return false;
  // Never cache navigation (HTML pages) — they change on deploy
  const mode = (typeof Request !== "undefined" && event && event.request && event.request.mode);
  return CACHEABLE_EXTENSIONS.some((ext) => url.pathname.endsWith(ext));
}

// Install: no pre-caching — cache fills on first real fetch
self.addEventListener("install", () => {
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

// Fetch: network-first for cacheable assets, pass-through for everything else
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Never intercept navigation / API / data requests
  if (
    event.request.mode === "navigate" ||
    url.pathname.startsWith("/api/") ||
    url.pathname.startsWith("/_next/") ||
    url.pathname.startsWith("/sdp")
  ) {
    return; // Let browser handle normally
  }

  // Only cache static assets with known extensions
  if (!isCacheableAsset(url)) return;

  // Network-first: try network, fall back to cache
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok && event.request.method === "GET") {
          const clone = response.clone();
          caches.open(STATIC_CACHE).then((cache) => {
            cache.put(event.request, clone);
          });
        }
        return response;
      })
      .catch(() => {
        // Offline fallback: serve from cache if available
        return caches.match(event.request);
      })
  );
});
