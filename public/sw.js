/**
 * Minimal app-shell service worker for yapper. We only cache the app shell
 * (HTML, CSS, JS bundles, icons). Model files and HF CDN content are NOT
 * cached by us — the browser's own HTTP cache handles them and they're
 * already large enough to make service-worker caching pointless.
 *
 * Strategy: cache-first for the shell, network-first for everything else.
 * This gives instant launches after the first visit and stays out of the
 * way of normal browsing.
 */

const SHELL_CACHE = 'yapper-shell-v1';
const SHELL_ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './favicon.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      // Clear any cache that doesn't match the current build's
      // SHELL_CACHE name. The `yapper-shell-` prefix covers all
      // historical versions (v1, v2, build-id timestamps, etc.),
      // not just the exact current one. This is the safety net: if
      // a deploy's generateBundle rename somehow misses an
      // instance, the next activate will still clear it.
      Promise.all(
        keys
          .filter((k) => k.startsWith('yapper-shell-') && k !== SHELL_CACHE)
          .map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Only handle same-origin GETs. Cross-origin (HF, jsdelivr, etc.) goes
  // straight to the network so we don't fight the browser's cache.
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) {
    return;
  }

  // Navigation requests: try cache, fall back to network, fall back to
  // cached index.html (so the app works offline after first visit).
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          // Refresh the shell cache with the latest index.html.
          const clone = response.clone();
          caches.open(SHELL_CACHE).then((cache) => cache.put(event.request, clone));
          return response;
        })
        .catch(() =>
          caches.match(event.request).then((cached) => cached || caches.match('./index.html'))
        )
    );
    return;
  }

  // Static assets (JS, CSS, SVG, etc.): cache-first.
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((response) => {
        // Only cache successful, basic responses. Don't cache 206 ranges,
        // cross-origin, or errors.
        if (response && response.status === 200 && response.type === 'basic') {
          const clone = response.clone();
          caches.open(SHELL_CACHE).then((cache) => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => cached);
    })
  );
});
