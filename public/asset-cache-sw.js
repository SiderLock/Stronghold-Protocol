// Asset-only cache: HTML, application code, data, APIs and private announcements never enter it.
// Content hashes let unchanged files survive upgrades; per-client catalogs pin live matches.
//
// This is the single service worker for scope '/' (main.js no longer registers public/sw.js): besides the pre-cache
// catalog it serves the title screen's imported art from sp-imported-assets-v1, so the two import entries share one
// controller instead of replacing each other.
import { ASSET_CACHE_NAME, ASSET_CACHE_META, ASSET_CACHE_SW_PROTOCOL, ASSET_CACHE_INDEX_URL, assetContentKey, catalogURLMap,
  verifyAssetCatalog, decodedAssetPath, isVerifiedAssetResponse, validatedCacheHeaders,
  parseAssetRange, sha256Hex, IMPORTED_ASSET_CACHE, IMPORTED_ASSET_PATH, IMPORTED_BORROWED_URL } from '/shared/assetCache.js';

const origin = self.location.origin;
const catalogPath = (version) => `${origin}/__sp_asset_cache__/catalog/${version}`;
const pinPath = (id) => `${origin}/__sp_asset_cache__/pin/${encodeURIComponent(id)}`;
const latestPath = `${origin}/__sp_asset_cache__/latest`;
const catalogs = new Map();
const pins = new Map();
let passiveActive = 0;
let lastNotify = 0;
let messages = Promise.resolve();

// Do not interrupt existing pages on an SW update. A new version activates naturally when old
// clients are gone, or on an explicit idle-only ACTIVATE request; first installation can claim
// current pages without requiring a reload.
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

async function readJSON(cache, path) {
  try { return await (await cache.match(path))?.json(); } catch { return null; }
}

async function getCatalog(version) {
  if (!version) return null;
  if (!catalogs.has(version)) {
    const meta = await caches.open(ASSET_CACHE_META);
    const catalog = await readJSON(meta, catalogPath(version));
    try { const checked = await verifyAssetCatalog(catalog); catalogs.set(version, { catalog: checked, urls: catalogURLMap(checked) }); }
    catch { return null; }
  }
  return catalogs.get(version);
}

async function getPin(clientId) {
  if (pins.has(clientId)) return pins.get(clientId);
  const meta = await caches.open(ASSET_CACHE_META);
  const pin = await readJSON(meta, pinPath(clientId));
  if (pin) pins.set(clientId, pin);
  return pin;
}

async function livePlaying() {
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const liveIDs = new Set(clients.map((client) => client.id));
  // A browser tab can disappear without a final page message. Do not let its playing pin
  // permanently block cache maintenance in all other tabs.
  for (const id of [...pins.keys()]) if (!liveIDs.has(id)) pins.delete(id);
  const states = await Promise.all(clients.map((client) => getPin(client.id)));
  return states.some((pin) => pin?.playing);
}

async function broadcast(message) {
  for (const client of await self.clients.matchAll({ type: 'window', includeUncontrolled: true })) client.postMessage(message);
}

async function handleMessage(event) {
  const data = event.data;
  const source = event.source;
  if (!data || !source?.id || !event.ports?.[0]) return;
  const port = event.ports[0];
  try {
    if (data.type === 'ASSET_CACHE_CAPABILITIES') {
      port.postMessage({ ok: true, protocol: ASSET_CACHE_SW_PROTOCOL, imported: true });
      return;
    }
    if (data.type === 'ASSET_CACHE_ACTIVATE') {
      // A waiting worker does not receive the active worker's PLAYING writes. Read each live
      // page's persisted pin afresh on every explicit attempt, without removing any metadata.
      pins.clear();
      if (await livePlaying()) throw new Error('ASSET_CACHE_PLAYING');
      await self.skipWaiting();
      port.postMessage({ ok: true });
      return;
    }
    const meta = await caches.open(ASSET_CACHE_META);
    if (data.type === 'ASSET_CACHE_PIN') {
      const catalog = await verifyAssetCatalog(data.catalog);
      const previous = await getPin(source.id);
      // A live page cannot change its material interpretation mid-match.
      if (previous?.playing && previous.version && previous.version !== catalog.version) throw new Error('ASSET_CACHE_PLAYING');
      await meta.put(catalogPath(catalog.version), Response.json(catalog));
      await meta.put(latestPath, Response.json({ version: catalog.version }));
      catalogs.set(catalog.version, { catalog, urls: catalogURLMap(catalog) });
      // Only the explicit PLAYING message may clear this flag. A pending catalog adoption
      // must not downgrade a page that entered a match while storage was being written.
      const pin = { version: catalog.version, playing: !!previous?.playing || !!data.playing };
      await meta.put(pinPath(source.id), Response.json(pin)); pins.set(source.id, pin);
      port.postMessage({ ok: true });
    } else if (data.type === 'ASSET_CACHE_PLAYING') {
      const pin = await getPin(source.id) || { version: null };
      pin.playing = !!data.playing;
      await meta.put(pinPath(source.id), Response.json(pin)); pins.set(source.id, pin);
      const playing = await livePlaying();
      await broadcast({ type: 'ASSET_CACHE_PLAYING_CHANGED', playing });
      port.postMessage({ ok: true, playing });
    } else if (data.type === 'ASSET_CACHE_CAN_MUTATE') {
      port.postMessage({ ok: true, playing: await livePlaying() });
    } else if (data.type === 'ASSET_CACHE_CLEAR') {
      if (await livePlaying()) throw new Error('ASSET_CACHE_PLAYING');
      await caches.delete(ASSET_CACHE_NAME);
      // Borrowed paths point at the pre-cache bytes that just went away; the stored import index is untouched.
      try {
        const imported = await caches.open(IMPORTED_ASSET_CACHE);
        await imported.delete(IMPORTED_BORROWED_URL);
      } catch { /* no imported cache on this origin */ }
      await broadcast({ type: 'ASSET_CACHE_UPDATED' });
      port.postMessage({ ok: true });
    } else if (data.type === 'ASSET_CACHE_PRUNE') {
      if (await livePlaying()) throw new Error('ASSET_CACHE_PLAYING');
      const live = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const versions = new Set([(await readJSON(meta, latestPath))?.version]);
      for (const client of live) versions.add((await getPin(client.id))?.version);
      const keep = new Set();
      for (const version of versions) {
        const indexed = await getCatalog(version);
        for (const entry of indexed?.catalog.files || []) keep.add(origin + assetContentKey(entry.sha256));
      }
      const cache = await caches.open(ASSET_CACHE_NAME);
      // Cache.keys() throws "Operation too large" for a full 0.3.1 pack (18,242 content keys, ~10 MB query cap).
      // The worker writes this SHA index after every operation; prune uses it and never enumerates the cache.
      const index = await readJSON(cache, origin + ASSET_CACHE_INDEX_URL);
      if (Array.isArray(index)) {
        const kept = [];
        const shas = index.filter((sha) => typeof sha === 'string' && /^[a-f0-9]{64}$/.test(sha));
        for (let i = 0; i < shas.length; i += 32) {
          await Promise.all(shas.slice(i, i + 32).map(async (sha) => {
            const key = origin + assetContentKey(sha);
            if (keep.has(key)) kept.push(sha);
            else await cache.delete(key);
          }));
        }
        await cache.put(origin + ASSET_CACHE_INDEX_URL, Response.json(kept.sort()));
      } else {
        // Legacy cache written before the index existed. Only a small one can be enumerated; when the query is too
        // large, skip stale cleanup instead of failing the import/download that just succeeded.
        try {
          const kept = [];
          for (const key of await cache.keys()) {
            if (keep.has(key.url)) {
              const sha = key.headers.get('x-sp-asset-sha256');
              if (/^[a-f0-9]{64}$/.test(sha || '')) kept.push(sha);
            } else await cache.delete(key);
          }
          if (kept.length) await cache.put(origin + ASSET_CACHE_INDEX_URL, Response.json(kept.sort()));
        } catch { /* too large to enumerate without an index: leave the stale entries for now */ }
      }
      const livePins = new Set(live.map((client) => pinPath(client.id)));
      for (const key of await meta.keys()) {
        if (key.url.includes('/__sp_asset_cache__/pin/') && !livePins.has(key.url)) { await meta.delete(key.url); }
        if (key.url.includes('/__sp_asset_cache__/catalog/') && !versions.has(key.url.split('/').at(-1))) {
          await meta.delete(key.url); catalogs.delete(key.url.split('/').at(-1));
        }
      }
      for (const id of pins.keys()) if (!livePins.has(pinPath(id))) pins.delete(id);
      port.postMessage({ ok: true });
    } else throw new Error('ASSET_CACHE_BAD_MESSAGE');
  } catch (error) {
    // DOMException's legacy numeric code (AbortError 20) is not a protocol code; never send it to the page as one.
    const code = typeof error?.code === 'string' ? error.code
      : (typeof error?.message === 'string' && /^ASSET_CACHE_[A-Z_]+$/.test(error.message) ? error.message : 'ASSET_CACHE_STORAGE_ERROR');
    port.postMessage({ ok: false, error: code });
  }
}
self.addEventListener('message', (event) => {
  // Metadata writes are asynchronous. Preserve delivery order so PIN and PLAYING do not
  // race their reads/puts and silently lose either the pinned version or the match guard.
  messages = messages.then(() => handleMessage(event), () => handleMessage(event));
  event.waitUntil(messages);
});

async function notifyUpdate() {
  if (Date.now() - lastNotify < 1000) return;
  lastNotify = Date.now();
  await broadcast({ type: 'ASSET_CACHE_UPDATED' });
}

async function cachedResponse(response, entry, request) {
  const headers = new Headers(validatedCacheHeaders(entry));
  headers.set('Accept-Ranges', 'bytes');
  const range = request.headers.get('range');
  if (range) {
    const part = parseAssetRange(range, entry.bytes);
    if (!part) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${entry.bytes}` } });
    // A Range response is created from the full verified body; partial downloads never enter cache.
    const bytes = await response.arrayBuffer();
    headers.set('Content-Length', String(part.end - part.start + 1));
    headers.set('Content-Range', `bytes ${part.start}-${part.end}/${entry.bytes}`);
    return new Response(bytes.slice(part.start, part.end + 1), { status: 206, headers });
  }
  return new Response(response.body, { status: 200, headers });
}

/** Exact-key hit in the title screen's imported-art cache (public/sw.js's rule), or null. */
async function importedHit(request) {
  if (request.headers.has('range')) return null;
  let url;
  try { url = new URL(request.url); } catch { return null; }
  if (url.origin !== origin || !IMPORTED_ASSET_PATH.test(url.pathname)) return null;
  try {
    const cache = await caches.open(IMPORTED_ASSET_CACHE);
    // Exact key: an import stores each URL without a query. ignoreSearch would scan every entry of a full pack.
    return (await cache.match(origin + url.pathname)) || null;
  } catch { return null; }
}

async function fetchAsset(event, path) {
  try {
    const pin = await getPin(event.clientId);
    // A new document has fresh application data but has not declared its asset version yet.
    // Never serve another page's last catalog before it pins its own version after deployment.
    const indexed = await getCatalog(pin?.version);
    // A ~hash path matches only this pinned catalog's exact aliases. Stripping it could serve old model bytes
    // for a new manifest (or replace the model's aggregate hash with an unrelated file hash).
    const entry = indexed?.urls.get(path);
    if (!entry) {
      const imported = await importedHit(event.request);
      return imported || fetch(event.request);
    }
    const cache = await caches.open(ASSET_CACHE_NAME);
    const key = origin + assetContentKey(entry.sha256);
    const hit = await cache.match(key);
    if (isVerifiedAssetResponse(hit, entry)) return cachedResponse(hit, entry, event.request);
    // The title import already verified these bytes against the served manifests; one copy in either cache is
    // enough, so do not download a second time before the pre-cache's own passive fill can run.
    const imported = await importedHit(event.request);
    if (imported) return imported;
    const response = await fetch(event.request);
    // Ordinary gameplay remains immediate. Verification runs after returning the network response,
    // with a small concurrency ceiling so a model burst cannot create hundreds of buffered bodies.
    if (response.status === 200 && !event.request.headers.has('range') && passiveActive < 2) {
      const reported = Number(response.headers.get('content-length'));
      if (response.headers.has('content-encoding') || !reported || reported === entry.bytes) {
        passiveActive++;
        const copy = response.clone();
        event.waitUntil((async () => {
          try {
            const reader = copy.body.getReader();
            const body = new Uint8Array(entry.bytes);
            let offset = 0;
            try {
              while (true) {
                const chunk = await reader.read();
                if (chunk.done) break;
                if (offset + chunk.value.length > entry.bytes) return;
                body.set(chunk.value, offset); offset += chunk.value.length;
              }
            } finally { await reader.cancel().catch(() => {}); }
            if (offset === entry.bytes && await sha256Hex(body) === entry.sha256) {
              const request = new Request(key, { headers: { 'X-SP-Asset-SHA256': entry.sha256, 'X-SP-Asset-Bytes': String(entry.bytes) } });
              // Passive fills share the mutation lock with import/verification/clear. Never
              // re-create cleared content or overwrite a verification result concurrently.
              await self.navigator.locks.request('sp-asset-cache-mutation', { ifAvailable: true }, async (lock) => {
                if (!lock) return;
                await cache.put(request, new Response(body, { headers: validatedCacheHeaders(entry) }));
                await notifyUpdate();
              });
            }
          } catch { /* Quota, unavailable disk and a stale server asset must not break gameplay. */ }
          finally { passiveActive--; }
        })());
      }
    }
    return response;
  } catch { return fetch(event.request); }
}

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const path = decodedAssetPath(event.request.url, origin);
  if (path) event.respondWith(fetchAsset(event, path));
});
