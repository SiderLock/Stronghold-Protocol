// Loaded only by a ready match UI. Persistent storage is optional; renderer demand always wins over filling.
import { assets } from './assets.js';
import { data } from './data.js';
import { assetCache } from './assetCache.js';
import { store } from './store.js';
import { settingsStore } from './ui/settingsStore.js';
import { ownDiyRecord, ownStandIn } from './ui/gameLogic.js';
import { currentAssetPlan, visualAssetURLs, backgroundFillAllowed } from './assetPlan.js';
import { createAssetPreloader } from './assetPriority.js';
import { loadFxList, FX_LIST_URL } from './render/vfx/available.js';
import { renderAssetKey, createAssetTransfer, releaseAssetReader } from '../../shared/assetCache.js';

let current = null, local = null, localPending = false, fx = null, fxLoaded = false;
let servedAssets = null, servedLocal = null;
let remainingSources = [], remainingURLs = [];
const lists = new WeakMap();
const list = (manifest) => {
  if (!manifest || typeof manifest !== 'object') return [];
  if (!lists.has(manifest)) lists.set(manifest, visualAssetURLs(manifest));
  return lists.get(manifest);
};
function remaining() {
  const sources = [servedAssets || assets.manifest, servedLocal || local, fx, fxLoaded];
  if (!sources.every((v, i) => v === remainingSources[i])) {
    remainingSources = sources;
    remainingURLs = [...(!fxLoaded ? [FX_LIST_URL] : []),
      ...sources.slice(0, 3).flatMap(list).filter((u) => renderAssetKey(u, globalThis.location?.origin || 'http://localhost'))];
  }
  return remainingURLs;
}
const loader = createAssetPreloader({ load: async (url, { background, signal }) => {
  if (url === FX_LIST_URL) {
    // The list is shared with foreground effects: cancelling an optional consumer must not poison its shared promise.
    fx = await loadFxList((u) => fetch(u, { priority: 'low' }));
    if (signal?.aborted) throw new Error('preempted');
    // Refresh URL lists only, after foreground readiness. Never replace this live match's data or pinned catalog.
    for (const path of ['/data/assets.json', '/data/local-assets.json']) {
      try {
        const response = await fetch(path, { priority: 'low', cache: 'no-cache', signal });
        if (response.ok) { const value = await response.json(); if (path === '/data/assets.json') servedAssets = value; else servedLocal = value; }
      } catch (err) { if (signal?.aborted) throw err; }
    }
    fxLoaded = true; refresh(); return;
  }
  const transfer = createAssetTransfer({ signal, timeoutMs: 30000 });
  const options = { priority: background ? 'low' : 'high', cache: 'force-cache', signal: transfer.signal };
  const consume = async (response) => {
    if (!response.ok) throw new Error(`asset ${response.status}`);
    const reader = response.body?.getReader(); let count = 0;
    if (reader) {
      try { while (true) { const next = await transfer.wait(reader.read()); if (next.done) break; count += next.value.length; if (next.value.byteLength) transfer.progress(); } }
      finally { releaseAssetReader(reader); }
    } else { count = (await transfer.wait(response.arrayBuffer())).byteLength; transfer.progress(); }
    return count;
  };
  try {
    let count = await consume(await transfer.wait(fetch(url, options)));
    if (!count) {
      // The same download-manager fallback as the scene loader, using only the manifest's exact size.
      const rec = Object.values((servedLocal || local)?.groups || {}).flatMap((g) => Object.values(g)).find((r) => r?.path === url && r.bytes > 0);
      if (rec) count = await consume(await transfer.wait(fetch(url, { ...options, headers: { Range: `bytes=0-${rec.bytes - 1}` } })));
    }
    if (!count) throw new Error('empty asset');
  } finally { transfer.close(); }
} });

function refresh() {
  const state = store.get(), cache = assetCache.getState();
  const allow = !!current && settingsStore.get().renderCache && cache.renderCacheReady
    && !cache.emergency && state.room?.code === current.room && state.me?.playerId === current.me && !!state.match.public
    && (!!current.priv || !current.pub.players?.some((p) => p.playerId === current.me));
  if (!allow) { loader.update({ allow: false }); return; }
  if (!assets.loaded || !local) {
    if (!localPending) {
      localPending = true;
      Promise.all([assets.ready(), assets.local()]).then(([, lm]) => { local = lm || {}; refresh(); })
        .catch(() => { localPending = false; }); // a later state change may retry after transient manifest failure
    }
    return;
  }
  const { pub, priv } = current;
  const chess = (id) => {
    const base = data.lookup('chess', id);
    const rec = ownDiyRecord(base, priv, { chess: data.get('chess'), backups: data.get('backups') }) || base;
    return ownStandIn(rec, priv, data.get('backups')) || rec;
  };
  const required = currentAssetPlan({ pub, priv, assets, local, chess,
    token: (id) => data.lookup('tokens', id) || data.get('backups')?.tokens?.[id], enemy: (id) => data.lookup('enemies', id) });
  // This queue uses ordinary immutable art reads, not the explicit limited-download API. Never bypass a host's cap.
  loader.update({ allow: true, stopped: cache.renderCacheFull || !backgroundFillAllowed(cache.policy), required,
    remaining: remaining() });
}
settingsStore.subscribe(refresh);
assetCache.subscribe(refresh);
store.subscribe((s, prev) => { if (s.match.public !== prev.match.public || s.room !== prev.room) { if (!s.match.public || !s.room) current = null; refresh(); } });
// Read the small summary only; do not acquire a full catalog or change the live match's pin.
setInterval(() => {
  if (current && settingsStore.get().renderCache && !document.hidden && navigator.onLine !== false)
    assetCache.refreshRenderingPolicy().catch(() => {});
}, 15000);

export function warmMatchAssets(pub, priv) {
  const state = store.get();
  current = pub && Number(pub.round) >= 1 ? { pub, priv, room: state.room?.code, me: state.me?.playerId } : null;
  refresh();
}
export const assetPreloadStatus = () => loader.status();
