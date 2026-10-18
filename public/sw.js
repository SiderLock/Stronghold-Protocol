// Classic service worker for art a player imported on this origin.
// Legacy fallback only: the merged module worker (public/asset-cache-sw.js) is what main.js uses. Keep these constants
// in sync with shared/assetCache.js; this classic file cannot import that module.
const IMPORTED_ASSET_CACHE = 'sp-imported-assets-v1';
const IMPORTED_ASSET_CACHE_PREFIX = 'sp-imported-assets-';
const IMPORTED_ASSET_PATH = /^\/(?:assets|fonts|media)\/~[0-9a-f]{16}\//;

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names
      .filter((name) => name.startsWith(IMPORTED_ASSET_CACHE_PREFIX) && name !== IMPORTED_ASSET_CACHE)
      .map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  if (request.headers.has('range')) return;
  let url;
  try { url = new URL(request.url); } catch { return; }
  if (url.origin !== self.location.origin) return;
  if (!IMPORTED_ASSET_PATH.test(url.pathname)) return;
  event.respondWith((async () => {
    const cache = await caches.open(IMPORTED_ASSET_CACHE);
    // The exact key: an import stores each URL without a query, so the path is the key. `ignoreSearch` would make
    // Chrome scan every entry — about 4 s per request once a whole pack (some 43,000 entries) is imported.
    const hit = await cache.match(url.origin + url.pathname);
    if (hit) return hit;
    // Do not cache the network response. The browser's own HTTP cache still applies to this fetch.
    return fetch(request);
  })());
});
