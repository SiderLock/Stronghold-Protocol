// Fixed pre-capability Service Worker for cross-version browser tests. Its 16-alias
// limit deliberately models the pre-v0.2.6 validator; it never implements activation.
import { ASSET_CACHE_NAME, ASSET_CACHE_META, assetContentKey, assetCacheCatalogKey,
  ASSET_CACHE_LATEST_KEY, verifyAssetCatalog, catalogURLMap, decodedAssetPath,
  isVerifiedAssetResponse } from '/shared/assetCache.js';

const origin = self.location.origin;
const pinPath = (id) => `${origin}/__sp_asset_cache__/pin/${encodeURIComponent(id)}`;
let messages = Promise.resolve();

self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

async function readJSON(cache, url) {
  try { return await (await cache.match(url))?.json(); } catch { return null; }
}

async function verifyLegacyCatalog(catalog) {
  if (catalog?.files?.some((entry) => entry.aliases?.length > 16)) {
    throw new Error('ASSET_CACHE_BAD_CATALOG');
  }
  return verifyAssetCatalog(catalog);
}

async function livePlaying(meta) {
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const pins = await Promise.all(clients.map((client) => readJSON(meta, pinPath(client.id))));
  return pins.some((pin) => pin?.playing);
}

async function broadcast(message) {
  for (const client of await self.clients.matchAll({ type: 'window', includeUncontrolled: true })) {
    client.postMessage(message);
  }
}

async function handleMessage(event) {
  const source = event.source;
  const port = event.ports?.[0];
  if (!source?.id || !port) return;
  const meta = await caches.open(ASSET_CACHE_META);
  try {
    if (event.data?.type === 'ASSET_CACHE_PIN') {
      const catalog = await verifyLegacyCatalog(event.data.catalog);
      const previous = await readJSON(meta, pinPath(source.id));
      if (previous?.playing && previous.version !== catalog.version) throw new Error('ASSET_CACHE_PLAYING');
      await meta.put(origin + assetCacheCatalogKey(catalog.version), Response.json(catalog));
      await meta.put(origin + ASSET_CACHE_LATEST_KEY, Response.json({ version: catalog.version }));
      await meta.put(pinPath(source.id), Response.json({ version: catalog.version,
        playing: !!previous?.playing || !!event.data.playing }));
      port.postMessage({ ok: true });
    } else if (event.data?.type === 'ASSET_CACHE_PLAYING') {
      const pin = await readJSON(meta, pinPath(source.id)) || { version: null };
      pin.playing = !!event.data.playing;
      await meta.put(pinPath(source.id), Response.json(pin));
      const playing = await livePlaying(meta);
      await broadcast({ type: 'ASSET_CACHE_PLAYING_CHANGED', playing });
      port.postMessage({ ok: true, playing });
    } else if (event.data?.type === 'ASSET_CACHE_CAN_MUTATE') {
      port.postMessage({ ok: true, playing: await livePlaying(meta) });
    } else if (event.data?.type === 'ASSET_CACHE_CLEAR') {
      if (await livePlaying(meta)) throw new Error('ASSET_CACHE_PLAYING');
      await caches.delete(ASSET_CACHE_NAME);
      await broadcast({ type: 'ASSET_CACHE_UPDATED' });
      port.postMessage({ ok: true });
    } else {
      port.postMessage({ ok: false, error: 'ASSET_CACHE_BAD_MESSAGE' });
    }
  } catch (error) {
    port.postMessage({ ok: false, error: error.code || error.message });
  }
}

self.addEventListener('message', (event) => {
  messages = messages.then(() => handleMessage(event), () => handleMessage(event));
  event.waitUntil(messages);
});

async function fetchAsset(event, pathname) {
  try {
    const meta = await caches.open(ASSET_CACHE_META);
    const pin = await readJSON(meta, pinPath(event.clientId));
    const value = pin?.version && await readJSON(meta, origin + assetCacheCatalogKey(pin.version));
    if (value) {
      const catalog = await verifyLegacyCatalog(value);
      const entry = catalogURLMap(catalog).get(pathname);
      if (entry) {
        const cache = await caches.open(ASSET_CACHE_NAME);
        const hit = await cache.match(origin + assetContentKey(entry.sha256));
        if (isVerifiedAssetResponse(hit, entry)) return hit;
      }
    }
  } catch { /* A legacy invalid directory must still allow a network fallback. */ }
  return fetch(event.request);
}

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const pathname = decodedAssetPath(event.request.url, origin);
  if (pathname) event.respondWith(fetchAsset(event, pathname));
});
