// Browser asset-cache coordinator; pure at import time so importing it under Node is safe.
// All expensive work runs in a dedicated worker. UI consumes codes through i18n, never raw errors.
import { ASSET_CACHE_META, ASSET_CACHE_LATEST_KEY, ASSET_CACHE_SW_PROTOCOL, MAX_MANIFEST_BYTES, verifyAssetCatalog,
  assetCacheCatalogKey, validateAssetCacheSummary, catalogMatchesSummary, assetCacheError,
  IMPORTED_ASSET_CACHE, IMPORTED_ASSET_CACHE_PREFIX, IMPORTED_ASSET_PATH, IMPORTED_INDEX_URL, IMPORTED_BORROWED_URL,
  ASSET_CACHE_INDEX_URL } from '../../shared/assetCache.js';

// Re-exported for the imported-art helpers' consumers (public/sw.js duplicates these constants as a classic script).
export { IMPORTED_ASSET_CACHE, IMPORTED_ASSET_CACHE_PREFIX, IMPORTED_ASSET_PATH, IMPORTED_INDEX_URL, IMPORTED_BORROWED_URL,
  ASSET_CACHE_INDEX_URL };

const initialState = (env) => {
  const supported = !!(env.isSecureContext && env.caches && env.navigator?.serviceWorker
    && env.Worker && env.crypto?.subtle && env.navigator?.locks);
  return { supported, phase: 'idle', error: null,
    totalFiles: 0, readyFiles: 0, totalBytes: 0, readyBytes: 0, missingFiles: 0, missingBytes: 0,
    speedBps: 0, version: null, storage: { usage: 0, quota: 0, persisted: false,
      persistenceSupported: supported && typeof env.navigator?.storage?.persist === 'function' }, playing: false,
    hasCatalog: false, catalogCurrent: false, catalogComplete: false, serverMissingFiles: 0,
    serverVersion: null, requireAssetCache: false, importStats: null, scanStats: null, waiting: false, policy: null,
    catalogUpdateRetryAt: 0, emergency: false,
    persistence: 'idle' };
};

export function createAssetCacheManager({ environment = globalThis, doFetch, workerURL = '/js/asset-cache-worker.js',
  swURL = '/asset-cache-sw.js', statusURL = '/api/asset-cache/status',
  catalogURL = '/api/asset-cache/catalog', catalogUpdateURL = '/api/asset-cache/catalog-update' } = {}) {
  const env = environment;
  const state = initialState(env);
  const listeners = new Set();
  const fetcher = doFetch || ((...args) => env.fetch(...args));
  let catalog = null;
  let initialized = false;
  let initializing = null;
  let registration = null;
  let ownPlaying = false;
  let worker = null;
  let task = null;
  let nextID = 0;
  let operation = null;
  let backgroundTimer = null;
  let checkingStorage = null;
  let summary = null;
  let checkingSummary = null;
  let admissionRefresh = null;
  let summaryAt = 0;
  let persistenceRequest = null;
  let compatibleSW = null;
  const getState = () => ({ ...state, storage: { ...state.storage }, importStats: state.importStats && { ...state.importStats },
    scanStats: state.scanStats && { ...state.scanStats }, policy: state.policy && { ...state.policy } });
  const patch = (next) => {
    Object.assign(state, next);
    for (const fn of [...listeners]) { try { fn(getState()); } catch { /* Consumer must not break cache progress. */ } }
  };

  // A page loaded under the legacy classic /sw.js never got a persisted PLAYING pin (that worker has no message
  // handler), yet it may still be in a match. New pages advertise their match state in localStorage so the page that
  // performs the migration can refuse to replace the worker while a sibling tab is playing. The 20 s lease covers a
  // crashed tab; a live tab refreshes it every 5 s.
  const PLAYING_MARKER = 'sp-asset-cache-playing:';
  const PLAYING_LEASE_MS = 20000;
  const pageMarker = (() => { try { return env.crypto?.randomUUID?.() || String(Math.random()).slice(2); } catch { return 'page'; } })();
  let markerTimer = null;
  const otherPagePlaying = () => {
    try {
      const storage = env.localStorage;
      if (!storage) return false;
      const now = Date.now();
      const own = PLAYING_MARKER + pageMarker;
      for (let i = storage.length - 1; i >= 0; i--) {
        const key = storage.key(i);
        if (!key || !key.startsWith(PLAYING_MARKER) || key === own) continue;
        const at = Number(storage.getItem(key));
        if (Number.isFinite(at) && now - at < PLAYING_LEASE_MS) return true;
        storage.removeItem(key); // crashed / closed tab
      }
    } catch { /* storage disabled: fall back to the SW pins */ }
    return false;
  };
  const markPlaying = (value) => {
    try {
      const storage = env.localStorage;
      if (!storage) return;
      if (value) {
        storage.setItem(PLAYING_MARKER + pageMarker, String(Date.now()));
        if (markerTimer === null && typeof env.setInterval === 'function') {
          markerTimer = env.setInterval(() => {
            try { storage.setItem(PLAYING_MARKER + pageMarker, String(Date.now())); } catch { /* storage gone */ }
          }, 5000);
        }
      } else {
        storage.removeItem(PLAYING_MARKER + pageMarker);
        if (markerTimer !== null) { env.clearInterval(markerTimer); markerTimer = null; }
      }
    } catch { /* private mode / storage disabled */ }
  };
  // A closed tab releases the lease at once; a crashed one expires after PLAYING_LEASE_MS.
  const releaseMarker = () => markPlaying(false);
  try { env.addEventListener?.('pagehide', releaseMarker); } catch { /* no window (tests) */ }

  function timeLimited(promise, ms, code) {
    return new Promise((resolve, reject) => {
      const timer = env.setTimeout(() => reject(assetCacheError(code)), ms);
      promise.then((value) => { env.clearTimeout(timer); resolve(value); }, (error) => { env.clearTimeout(timer); reject(error); });
    });
  }

  async function updateStorage() {
    if (checkingStorage) return checkingStorage;
    checkingStorage = (async () => {
      // Quota and persistence inspection can fail independently in private browser modes.
      // estimate() can stall in some browsers; do not block the dialog's summary on it.
      const [estimate, persisted] = await Promise.allSettled([
        timeLimited(Promise.resolve().then(() => env.navigator.storage?.estimate?.()), 5000, 'ASSET_CACHE_STORAGE_ERROR'),
        timeLimited(Promise.resolve().then(() => env.navigator.storage?.persisted?.()), 5000, 'ASSET_CACHE_STORAGE_ERROR'),
      ]);
      patch({ storage: { ...state.storage,
        ...(estimate.status === 'fulfilled' && estimate.value
          ? { usage: estimate.value.usage || 0, quota: estimate.value.quota || 0 } : {}),
        ...(persisted.status === 'fulfilled' && typeof persisted.value === 'boolean'
          ? { persisted: persisted.value } : {}),
      } });
    })();
    try { await checkingStorage; } finally { checkingStorage = null; }
  }

  async function swMessage(type, payload = {}, target = env.navigator.serviceWorker.controller || registration?.active,
    timeoutMs = 10000) {
    if (!target) throw assetCacheError('ASSET_CACHE_SW_UNAVAILABLE');
    // A controller from an older deployment (/sw.js) does not answer messages at all: the rejection is a plain
    // timeout. A DOMException's numeric legacy code (AbortError 20) must never reach the UI as an error code.
    const code = (value) => (typeof value === 'string' && value ? value : 'ASSET_CACHE_STORAGE_ERROR');
    return new Promise((resolve, reject) => {
      const channel = new env.MessageChannel();
      const timer = env.setTimeout(() => { channel.port1.close(); reject(assetCacheError('ASSET_CACHE_SW_UNAVAILABLE')); }, timeoutMs);
      channel.port1.onmessage = ({ data }) => {
        env.clearTimeout(timer); channel.port1.close();
        if (data?.ok) resolve(data); else reject(assetCacheError(code(data?.error)));
      };
      try { target.postMessage({ type, ...payload }, [channel.port2]); }
      catch (error) { env.clearTimeout(timer); channel.port1.close(); reject(assetCacheError('ASSET_CACHE_SW_UNAVAILABLE', error)); }
    });
  }

  function waitForSW(worker, states) {
    if (states.includes(worker.state)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const finish = (error) => {
        env.clearTimeout(timer); worker.removeEventListener('statechange', changed);
        if (error) reject(error); else resolve();
      };
      const changed = () => {
        if (states.includes(worker.state)) finish();
        else if (worker.state === 'redundant') finish(assetCacheError('ASSET_CACHE_SW_UPDATE_REQUIRED'));
      };
      const timer = env.setTimeout(() => finish(assetCacheError('ASSET_CACHE_SW_UPDATE_REQUIRED')), 15000);
      worker.addEventListener('statechange', changed);
      changed();
    });
  }

  function waitForController(target) {
    const serviceWorker = env.navigator.serviceWorker;
    if (serviceWorker.controller === target) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const finish = (error) => {
        env.clearTimeout(timer); serviceWorker.removeEventListener('controllerchange', changed);
        if (error) reject(error); else resolve();
      };
      const changed = () => { if (serviceWorker.controller === target) finish(); };
      const timer = env.setTimeout(() => finish(assetCacheError('ASSET_CACHE_SW_UPDATE_REQUIRED')), 15000);
      serviceWorker.addEventListener('controllerchange', changed);
      changed();
    });
  }

  // One merged SW (public/asset-cache-sw.js) owns scope '/': it serves the pre-cache and the title screen's imported
  // art, and answers the ASSET_CACHE_* messages. A page loaded from an earlier deployment may still be controlled by
  // the classic /sw.js: that worker only serves imported art and answers no messages, so every pre-cache action used
  // to time out before it could upgrade. The new worker is activated only when no live page has a playing pin.
  async function compatibleSWNow({ cache = true } = {}) {
    const current = env.navigator.serviceWorker.controller;
    if (!current) return null;
    if (cache && current === compatibleSW) return current;
    try {
      const response = await swMessage('ASSET_CACHE_CAPABILITIES', {}, current, 2500);
      if (response.protocol === ASSET_CACHE_SW_PROTOCOL && response.imported) { if (cache) compatibleSW = current; return current; }
    } catch { /* /sw.js has no message handler; a timed-out probe must not block the upgrade. */ }
    return null;
  }

  /** Ask the waiting merged worker to activate; the worker itself refuses while any live page has a playing pin. */
  async function activateWaiting(job) {
    const waiting = registration?.waiting;
    if (!waiting) return false;
    if (job?.paused) throw assetCacheError('ASSET_CACHE_PAUSED');
    if (state.playing || ownPlaying || otherPagePlaying()) throw assetCacheError('ASSET_CACHE_PLAYING');
    const capabilities = await swMessage('ASSET_CACHE_CAPABILITIES', {}, waiting, 2500);
    if (capabilities?.protocol !== ASSET_CACHE_SW_PROTOCOL || !capabilities.imported) return false;
    if (job?.paused) throw assetCacheError('ASSET_CACHE_PAUSED');
    const guard = await swMessage('ASSET_CACHE_CAN_MUTATE', {}, waiting, 5000);
    if (guard.playing) throw assetCacheError('ASSET_CACHE_PLAYING');
    if (job?.paused) throw assetCacheError('ASSET_CACHE_PAUSED');
    await swMessage('ASSET_CACHE_ACTIVATE', {}, waiting, 10000);
    await waitForSW(waiting, ['activated']);
    await waitForController(waiting);
    compatibleSW = null;
    return true;
  }

  // An explicit operation first makes sure its messages will reach the merged worker, then checks the match guard.
  // The old order probed the legacy controller first and always timed out before the waiting worker could replace it.
  async function ensureCompatibleSW(job) {
    if (job?.paused) throw assetCacheError('ASSET_CACHE_PAUSED');
    // A legacy controller never received this page's PLAYING pin; never replace it while this page (or a sibling tab
    // that also predates the merged worker) is in a match. The waiting worker's own pin check covers modern tabs.
    if (state.playing || ownPlaying || otherPagePlaying()) throw assetCacheError('ASSET_CACHE_PLAYING');
    if (await compatibleSWNow()) return;
    if (!registration) await initialize();
    if (!registration) throw assetCacheError('ASSET_CACHE_SW_UPDATE_REQUIRED');
    if (!env.navigator.serviceWorker.controller && registration.active) {
      try { await waitForController(registration.active); } catch { /* still installing */ }
      if (await compatibleSWNow()) return;
    }
    if (job?.paused) throw assetCacheError('ASSET_CACHE_PAUSED');
    try {
      if (await activateWaiting(job)) {
        if (await compatibleSWNow()) return;
      }
      if (!registration.waiting) {
        await timeLimited(registration.update(), 15000, 'ASSET_CACHE_SW_UPDATE_REQUIRED');
        if (registration.installing) await waitForSW(registration.installing, ['installed', 'activated']);
        if (await activateWaiting(job) && await compatibleSWNow()) return;
      }
    } catch (error) {
      if (error.code === 'ASSET_CACHE_PLAYING' || error.code === 'ASSET_CACHE_PAUSED') throw error;
      throw assetCacheError('ASSET_CACHE_SW_UPDATE_REQUIRED', error);
    }
    if (!await compatibleSWNow()) throw assetCacheError('ASSET_CACHE_SW_UPDATE_REQUIRED');
  }

  const settledPhase = () => !catalog ? 'catalog-required' : !state.catalogCurrent ? 'catalog-stale'
    : state.missingFiles || !state.catalogComplete ? 'idle' : 'ready';

  async function refreshSummary({ force = false } = {}) {
    if (state.emergency) {
      if (summary) return summary;
      throw assetCacheError('ASSET_CACHE_EMERGENCY');
    }
    if (checkingSummary) return checkingSummary;
    if (!force && summary && Date.now() - summaryAt < 30000) return summary;
    checkingSummary = (async () => {
      const abort = new env.AbortController();
      const timer = env.setTimeout(() => abort.abort(), 15000);
      try {
        const response = await fetcher(statusURL, { cache: 'no-store', signal: abort.signal });
        if (!response.ok) throw assetCacheError('ASSET_CACHE_CATALOG_UNAVAILABLE');
        const next = validateAssetCacheSummary(await response.json());
        summary = next; summaryAt = Date.now();
        patch({ catalogCurrent: catalogMatchesSummary(catalog, next), catalogComplete: next.complete,
          serverMissingFiles: next.missingFiles, serverVersion: next.version,
          requireAssetCache: !!next.requireAssetCache, policy: next.policy || null,
          ...(!catalog ? { totalFiles: next.totalFiles, totalBytes: next.totalBytes,
            missingFiles: next.totalFiles, missingBytes: next.totalBytes } : {}) });
        return next;
      } catch (error) {
        summary = null; summaryAt = 0;
        patch({ catalogCurrent: false });
        throw error.code ? error : assetCacheError('ASSET_CACHE_CATALOG_UNAVAILABLE', error);
      }
      finally { env.clearTimeout(timer); }
    })();
    try { return await checkingSummary; } finally { checkingSummary = null; }
  }

  /** Cache Storage is the only directory source on reload, including older SW installations. */
  async function localCatalog() {
    const meta = await env.caches.open(ASSET_CACHE_META);
    const origin = env.location.origin;
    const latest = await (await meta.match(origin + ASSET_CACHE_LATEST_KEY))?.json();
    if (!latest?.version) return null;
    const response = await meta.match(origin + assetCacheCatalogKey(latest.version));
    if (!response) return null;
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > MAX_MANIFEST_BYTES) throw assetCacheError('ASSET_CACHE_BAD_CATALOG');
    let value;
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch (error) { throw assetCacheError('ASSET_CACHE_BAD_CATALOG', error); }
    const next = await verifyAssetCatalog(value, env.crypto);
    if (next.version !== latest.version) throw assetCacheError('ASSET_CACHE_BAD_CATALOG');
    return next;
  }

  async function adoptCatalog(value, { restoring = false } = {}) {
    const next = await verifyAssetCatalog(value, env.crypto);
    if (!restoring && !catalogMatchesSummary(next, summary)) throw assetCacheError('ASSET_CACHE_STALE_CATALOG');
    if (ownPlaying && catalog && catalog.version !== next.version) throw assetCacheError('ASSET_CACHE_PLAYING');
    await swMessage('ASSET_CACHE_PIN', { catalog: next, playing: ownPlaying });
    const changed = catalog?.version !== next.version;
    catalog = next;
    patch({ version: next.version, hasCatalog: true, totalFiles: next.totalFiles, totalBytes: next.totalBytes,
      catalogCurrent: catalogMatchesSummary(next, summary),
      ...(changed ? { readyFiles: 0, readyBytes: 0, missingFiles: next.totalFiles, missingBytes: next.totalBytes, importStats: null } : {}) });
    return next;
  }

  async function adoptMatchingLocalCatalog() {
    if (ownPlaying || state.catalogCurrent) return;
    const next = await localCatalog();
    if (catalogMatchesSummary(next, summary)) await adoptCatalog(next);
  }

  function stopWorker(code = 'ASSET_CACHE_PAUSED') {
    if (!worker) return;
    worker.terminate(); worker = null;
    const previous = task; task = null;
    previous?.reject(assetCacheError(code));
  }

  function runWorker(action, extra = {}) {
    if (task) throw assetCacheError('ASSET_CACHE_BUSY');
    if (!worker) {
      try { worker = new env.Worker(workerURL); }
      catch (error) { throw assetCacheError('ASSET_CACHE_WORKER_UNAVAILABLE', error); }
      worker.onmessage = ({ data }) => {
        if (!task || data.id !== task.id) return;
        if (data.type === 'progress') {
          const { readyFiles, readyBytes, missingFiles, missingBytes, speedBps, importStats, scanStats, waiting } = data;
          patch({ readyFiles, readyBytes, missingFiles, missingBytes,
            ...(speedBps === undefined ? {} : { speedBps }), ...(importStats ? { importStats } : {}),
            ...(scanStats ? { scanStats } : {}), ...(waiting === undefined ? {} : { waiting }) });
        } else if (data.type === 'done' || data.type === 'error') {
          const finished = task; task = null;
          if (data.type === 'done') finished.resolve(data.catalog ? { catalog: data.catalog } : getState());
          else finished.reject(assetCacheError(data.code || 'ASSET_CACHE_STORAGE_ERROR'));
        }
      };
      worker.onerror = () => stopWorker('ASSET_CACHE_WORKER_UNAVAILABLE');
      worker.onmessageerror = () => stopWorker('ASSET_CACHE_WORKER_UNAVAILABLE');
    }
    return new Promise((resolve, reject) => {
      task = { id: ++nextID, resolve, reject };
      try { worker.postMessage({ id: task.id, action, catalog, ...extra }); }
      catch (error) { task = null; reject(assetCacheError('ASSET_CACHE_WORKER_UNAVAILABLE', error)); }
    });
  }

  async function assertMutable() {
    const result = await swMessage('ASSET_CACHE_CAN_MUTATE');
    patch({ playing: ownPlaying || !!result.playing });
    if (state.playing) throw assetCacheError('ASSET_CACHE_PLAYING');
  }

  function passiveScan() {
    if (!initialized || operation || backgroundTimer !== null) return;
    backgroundTimer = env.setTimeout(() => {
      backgroundTimer = null;
      if (!operation) perform('scan', { refresh: false }).catch(() => {});
    }, 1000);
  }

  // A room create should not wait for a second full Cache Storage walk when the last local
  // scan already proved the current catalog complete. Recheck in the background so later
  // admissions still observe evictions without putting the initial click on the critical path.
  function refreshAdmissionInBackground() {
    if (admissionRefresh || operation || !initialized) return;
    admissionRefresh = Promise.resolve().then(() => scan({ refresh: true })).catch(() => {}).finally(() => {
      admissionRefresh = null;
    });
  }

  function onSWMessage({ data }) {
    if (data?.type === 'ASSET_CACHE_PLAYING_CHANGED') {
      patch({ playing: ownPlaying || !!data.playing });
      if (data.playing && operation) pause();
    } else if (data?.type === 'ASSET_CACHE_UPDATED') passiveScan();
  }

  async function initialize() {
    if (initialized) {
      // Reopening the panel does not fetch or scan the directory. Recheck only the live-tab guard,
      // since another playing tab may have closed without sending a final message.
      if (!operation) {
        try { const result = await swMessage('ASSET_CACHE_CAN_MUTATE'); patch({ playing: ownPlaying || !!result.playing }); }
        catch { /* Explicit operations report SW failures; opening the dialog stays usable. */ }
      }
      return getState();
    }
    if (initializing) return initializing;
    if (!state.supported) {
      patch({ phase: 'unsupported', error: env.isSecureContext ? 'ASSET_CACHE_UNSUPPORTED' : 'ASSET_CACHE_HTTPS_REQUIRED' });
      return getState();
    }
    initializing = (async () => {
      patch({ phase: 'initializing', error: null });
      let restoreError = null;
      let summaryError = null;
      // The status summary is a plain fetch and is what the dialog shows (server version, totals).
      // Never let a slow Service Worker / Cache Storage keep the panel on 0/0 尚未校验.
      try { await refreshSummary(); }
      catch (error) { summaryError = error.code || 'ASSET_CACHE_CATALOG_UNAVAILABLE'; }
      // Settle the dialog out of "checking" as soon as the summary is known, so 在线补齐/获取目录
      // are not disabled for the whole Service Worker bring-up. ensureReady still waits for this promise.
      if (summary && !catalog) patch({ phase: 'catalog-required', error: summaryError });
      try {
        try {
          registration = await timeLimited(env.navigator.serviceWorker.register(swURL, { scope: '/', type: 'module', updateViaCache: 'none' }),
            15000, 'ASSET_CACHE_SW_UNAVAILABLE');
        } catch (moduleError) {
          // Browsers without module service workers (Firefox before 114) keep the classic title-import worker so
          // local pack import still works; only the pre-cache panel is unavailable there.
          if (moduleError?.name !== 'TypeError' && moduleError?.name !== 'NotSupportedError') throw moduleError;
          registration = await timeLimited(env.navigator.serviceWorker.register('/sw.js', { scope: '/' }),
            15000, 'ASSET_CACHE_SW_UNAVAILABLE');
          patch({ supported: false, error: 'ASSET_CACHE_UNSUPPORTED' });
        }
        registration = await timeLimited(env.navigator.serviceWorker.ready, 15000, 'ASSET_CACHE_SW_UNAVAILABLE');
        env.navigator.serviceWorker.addEventListener('message', onSWMessage);
        if (!state.supported) { await updateStorage(); return getState(); }
        // Do not replace an older controller just because a page loaded: a live match on another tab must keep
        // its worker. The first explicit pre-cache action upgrades through ensureCompatibleSW (before the guard).
        if (!env.navigator.serviceWorker.controller && registration?.active) {
          try { await waitForController(registration.active); } catch { /* still installing */ }
        }
        try {
          // Cache Storage can stall under storage pressure; never hang initialization on it.
          const local = await timeLimited(localCatalog(), 8000, 'ASSET_CACHE_STORAGE_ERROR');
          // Pin before PLAYING so an older active SW can also restore a direct match reconnect.
          if (local) await adoptCatalog(local, { restoring: true });
        } catch (error) { restoreError = error.code || 'ASSET_CACHE_STORAGE_ERROR'; }
        // Probe without caching: a later explicit operation must re-check the worker, so a legacy controller
        // replaced mid-session is still upgraded (and the probe tests rely on that).
        if (await compatibleSWNow({ cache: false })) {
          try {
            const playback = await swMessage('ASSET_CACHE_PLAYING', { playing: ownPlaying });
            patch({ playing: ownPlaying || !!playback.playing });
          } catch { /* PLAYING is a match guard; a failed handshake must not block 缺项补齐. */ }
        }
        // Mutations still call ensureCompatibleSW first; do not cache a successful probe here or a
        // later outdated worker would skip its upgrade check.
        initialized = true;
        if (catalog) await timeLimited(runWorker('scan'), 60000, 'ASSET_CACHE_STORAGE_ERROR');
        patch({ phase: settledPhase(), error: restoreError || summaryError });
      } catch (error) {
        const paused = error.code === 'ASSET_CACHE_PLAYING' || error.code === 'ASSET_CACHE_PAUSED';
        if (paused) {
          patch({ phase: 'paused', error: null });
        } else if (summary) {
          // Summary already landed: settle into a usable phase and report the SW/storage failure.
          patch({ phase: settledPhase(), error: restoreError || summaryError || error.code || 'ASSET_CACHE_STORAGE_ERROR' });
        } else {
          patch({ phase: 'error', error: restoreError || summaryError || error.code || 'ASSET_CACHE_STORAGE_ERROR' });
        }
      }
      await updateStorage();
      return getState();
    })();
    try { return await initializing; } finally { initializing = null; }
  }

  async function ensureReady() {
    await initialize();
    if (!initialized) throw assetCacheError(state.error || 'ASSET_CACHE_UNSUPPORTED');
  }

  // Only an explicit owner action may transfer the full directory. Checking, admission and
  // initialization continue to use the small status summary.
  async function fetchCatalogUpdate(job, { full = false } = {}) {
    if (Date.now() < state.catalogUpdateRetryAt) throw assetCacheError('ASSET_CACHE_CATALOG_UPDATE_RATE_LIMITED');
    const abort = new env.AbortController();
    job.abort = abort;
    const timer = env.setTimeout(() => abort.abort(), 120000);
    try {
      const params = new URLSearchParams({ from: catalog?.version || '', to: summary.version,
        readyFiles: String(state.readyFiles), readyBytes: String(state.readyBytes) });
      const response = await fetcher(full ? catalogURL : `${catalogUpdateURL}?${params}`, { cache: 'no-store', signal: abort.signal,
        headers: full ? {} : { 'X-Asset-Cache-Update': 'manual' } });
      if (!response.ok) {
        if (response.status === 429) {
          const retryAfter = response.headers.get('Retry-After');
          const delay = /^\d+(?:\.\d+)?$/.test(retryAfter || '')
            ? Number(retryAfter) * 1000 : Date.parse(retryAfter || '') - Date.now();
          // Honor the server's real remaining cooldown; a transport/validation failure is not
          // evidence of rate limiting, and cold-directory acquisition has no fixed cooldown.
          patch({ catalogUpdateRetryAt: Date.now() + (Number.isFinite(delay) && delay > 0 ? delay : 1000) });
          throw assetCacheError('ASSET_CACHE_CATALOG_UPDATE_RATE_LIMITED');
        }
        if (!full && response.status === 409) {
          await refreshSummary({ force: true });
          throw assetCacheError('ASSET_CACHE_STALE_CATALOG');
        }
        if (response.status === 503) {
          // 503 also means catalogue construction/compression failed. Only the server's explicit
          // small error code proves that the owner disabled online transfers.
          let unavailable = 'ASSET_CACHE_CATALOG_UNAVAILABLE';
          if (response.body && Number(response.headers.get('Content-Length')) <= 4096) {
            const reader = response.body.getReader();
            const cancel = () => { reader.cancel().catch(() => {}); };
            abort.signal.addEventListener('abort', cancel, { once: true });
            try {
              const chunks = []; let size = 0;
              while (true) {
                if (job.paused || abort.signal.aborted) break;
                const { done, value } = await reader.read();
                if (done) break;
                size += value.byteLength;
                if (size > 4096) break;
                chunks.push(value);
              }
              if (size <= 4096 && !abort.signal.aborted && !job.paused) {
                const bytes = new Uint8Array(size); let offset = 0;
                for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
                const code = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))?.error;
                if (code === 'ASSET_CACHE_ONLINE_DISABLED') unavailable = code;
                else if (code === 'ASSET_CACHE_EMERGENCY' || code === 'SERVER_EMERGENCY') unavailable = 'ASSET_CACHE_EMERGENCY';
              }
            } catch { /* Unknown/unreadable server errors stay unavailable, not owner-disabled. */ }
            finally {
              abort.signal.removeEventListener('abort', cancel);
              await reader.cancel().catch(() => {});
              reader.releaseLock();
            }
          }
          throw assetCacheError(unavailable);
        }
        throw assetCacheError('ASSET_CACHE_CATALOG_UNAVAILABLE');
      }
      // Content-Length can be compressed. Always bound the *decoded* stream too, before JSON
      // parsing or adoption, so gzip cannot bypass the same limit used by local ZIP/JSON imports.
      if (Number(response.headers.get('Content-Length')) > MAX_MANIFEST_BYTES) throw assetCacheError('ASSET_CACHE_BAD_CATALOG');
      if (!response.body) throw assetCacheError('ASSET_CACHE_BAD_CATALOG');
      const reader = response.body.getReader();
      const cancel = () => { reader.cancel().catch(() => {}); };
      abort.signal.addEventListener('abort', cancel, { once: true });
      const chunks = []; let size = 0;
      try {
        while (true) {
          if (job.paused) throw assetCacheError('ASSET_CACHE_PAUSED');
          if (abort.signal.aborted) throw assetCacheError('ASSET_CACHE_CATALOG_UNAVAILABLE');
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > MAX_MANIFEST_BYTES) throw assetCacheError('ASSET_CACHE_BAD_CATALOG');
          chunks.push(value);
        }
      } finally {
        abort.signal.removeEventListener('abort', cancel);
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      if (job.paused) throw assetCacheError('ASSET_CACHE_PAUSED');
      if (abort.signal.aborted) throw assetCacheError('ASSET_CACHE_CATALOG_UNAVAILABLE');
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      let value;
      try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
      catch (error) { throw assetCacheError('ASSET_CACHE_BAD_CATALOG', error); }
      return await verifyAssetCatalog(value, env.crypto);
    } catch (error) {
      if (job.paused) throw assetCacheError('ASSET_CACHE_PAUSED', error);
      throw error.code ? error : assetCacheError('ASSET_CACHE_CATALOG_UNAVAILABLE', error);
    } finally {
      env.clearTimeout(timer);
      // Header/body validation can reject before acquiring a reader. Abort in every exit path
      // too, releasing the server's shared transfer lease rather than leaving a response flowing.
      abort.abort();
      job.abort = null;
    }
  }

  async function acquireCurrentCatalog(job) {
    if (catalog && state.catalogCurrent) return;
    if (Date.now() < state.catalogUpdateRetryAt) throw assetCacheError('ASSET_CACHE_CATALOG_UPDATE_RATE_LIMITED');
    if (catalog) {
      await runWorker('scan');
      if (job.paused) throw assetCacheError('ASSET_CACHE_PAUSED');
    }
    const full = !catalog || !state.readyFiles || !state.readyBytes;
    await assertMutable();
    if (job.paused) throw assetCacheError('ASSET_CACHE_PAUSED');
    const next = await fetchCatalogUpdate(job, { full });
    if (job.paused) throw assetCacheError('ASSET_CACHE_PAUSED');
    // Recheck deployment and every playing tab after transfer. A failed adoption preserves
    // the old directory and all verified contents, even for an empty old catalog.
    await refreshSummary({ force: true });
    if (!catalogMatchesSummary(next, summary)) throw assetCacheError('ASSET_CACHE_STALE_CATALOG');
    await assertMutable();
    if (job.paused) throw assetCacheError('ASSET_CACHE_PAUSED');
    await adoptCatalog(next);
  }

  async function perform(action, { deep = false, file = null, refresh = false } = {}) {
    if (state.emergency && (action === 'download' || action === 'catalog-update')) throw assetCacheError('ASSET_CACHE_EMERGENCY');
    await ensureReady();
    if (state.emergency && (action === 'download' || action === 'catalog-update')) throw assetCacheError('ASSET_CACHE_EMERGENCY');
    if (operation) throw assetCacheError('ASSET_CACHE_BUSY');
    const phase = action === 'catalog-update' ? 'updating-catalog' : action === 'import' || action === 'catalog' ? 'importing'
      : action === 'download' ? 'downloading' : deep ? 'verifying' : 'checking';
    const mutates = action !== 'scan' || deep;
    const job = { paused: false, action };
    operation = job;
    patch({ phase, error: null, speedBps: 0, waiting: false,
      ...(action === 'import' ? { importStats: null } : {}), ...(deep ? { scanStats: null } : {}) });
    try {
      const run = async () => {
        if (job.paused) throw assetCacheError('ASSET_CACHE_PAUSED');
        if (mutates) {
          // Upgrade/probe first: with a legacy /sw.js controller the guard message below would only time out and
          // the waiting merged worker would never be reached (the 0.3.1 import failure).
          await ensureCompatibleSW(job);
          await assertMutable();
          if (job.paused) throw assetCacheError('ASSET_CACHE_PAUSED');
          if (action !== 'clear') await refreshSummary({ force: true });
          if (action === 'catalog-update') {
            await acquireCurrentCatalog(job);
          } else if (action === 'catalog') {
            const result = await runWorker('read-catalog', { file, format: 'json' });
            if (job.paused) throw assetCacheError('ASSET_CACHE_PAUSED');
            await assertMutable();
            await adoptCatalog(result.catalog);
          } else if (action !== 'clear') {
            await adoptMatchingLocalCatalog();
            // A cold browser has no local directory to index. The explicit online fill action
            // may fetch the current directory first, then continue through the normal worker
            // download path. This keeps ordinary checks/status requests small while making the
            // user initiated "download missing" action self contained.
            if (action === 'download' && !state.catalogCurrent) await acquireCurrentCatalog(job);
            if (action === 'import' && !state.catalogCurrent) {
              const result = await runWorker('read-catalog', { file, format: 'zip' });
              if (job.paused) throw assetCacheError('ASSET_CACHE_PAUSED');
              await assertMutable();
              await adoptCatalog(result.catalog);
            }
            if (!catalog) throw assetCacheError('ASSET_CACHE_CATALOG_REQUIRED');
            if (!state.catalogCurrent) throw assetCacheError('ASSET_CACHE_STALE_CATALOG');
          }
          await assertMutable();
        } else if (refresh) {
          await refreshSummary({ force: true });
          await adoptMatchingLocalCatalog();
        }
        if (!mutates) {
          // A local scan does not need the SW; only the playing guard does. Keep scanning when an upgrade is
          // pending instead of failing the whole check with a message timeout.
          if (await compatibleSWNow()) {
            try {
              const playback = await swMessage('ASSET_CACHE_CAN_MUTATE');
              patch({ playing: ownPlaying || !!playback.playing });
            } catch { /* a failed guard must not hide what the local scan found */ }
          }
        }
        if (job.paused) throw assetCacheError('ASSET_CACHE_PAUSED');
        if (action === 'clear') {
          await swMessage('ASSET_CACHE_CLEAR');
          patch({ readyFiles: 0, readyBytes: 0, missingFiles: state.totalFiles, missingBytes: state.totalBytes });
        } else if (catalog) {
          // The download worker runs several files at once, bounded by the server's per-client lease (state.policy,
          // /api/asset-cache/status → policy.maxDownloadsPerClient). Asking for more only provokes 429s.
          const maxParallel = action === 'download'
            ? Math.max(1, Math.min(6, Number(state.policy?.maxDownloadsPerClient) || 2)) : 1;
          await runWorker(action === 'catalog' || action === 'catalog-update' ? 'scan' : action, { deep, maxParallel, ...(file ? { file } : {}) });
          // Stale copies are housekeeping: a failure here (e.g. a legacy cache without an index) must not turn a
          // finished import/download into an error after every byte was already verified and written.
          if (action === 'import' || action === 'download') {
            try { await swMessage('ASSET_CACHE_PRUNE'); } catch { /* keep the verified bytes */ }
          }
        }
      };
      if (mutates) await env.navigator.locks.request('sp-asset-cache-mutation', { ifAvailable: true }, async (lock) => {
        if (!lock) throw assetCacheError('ASSET_CACHE_BUSY');
        await run();
      });
      else await run();
      patch({ phase: settledPhase(), speedBps: 0, waiting: false });
      return getState();
    } catch (error) {
      const code = job.paused ? 'ASSET_CACHE_PAUSED' : error.code || 'ASSET_CACHE_STORAGE_ERROR';
      patch({ phase: code === 'ASSET_CACHE_PAUSED' ? 'paused' : 'error', error: code === 'ASSET_CACHE_PAUSED' ? null : code,
        speedBps: 0, waiting: false });
      // Pausing is a successful user action, and must not create an unhandled promise rejection.
      if (code === 'ASSET_CACHE_PAUSED') return getState();
      throw assetCacheError(code, error);
    } finally { operation = null; await updateStorage(); }
  }

  function pause() {
    if (operation) operation.paused = true;
    operation?.abort?.abort();
    stopWorker();
    if (operation) patch({ phase: 'paused', speedBps: 0, waiting: false, error: null });
  }
  const scan = (options = {}) => operation && !options.deep ? Promise.resolve(getState()) : perform('scan', { refresh: true, ...options });
  const manager = {
    getState, state: getState, initialize, scan,
    updateCatalog: () => perform('catalog-update'),
    downloadCatalog: () => perform('catalog-update'),
    setEmergency(value) {
      const emergency = !!value;
      if (state.emergency === emergency) return;
      patch({ emergency });
      if (emergency && (operation?.action === 'download' || operation?.action === 'catalog-update')) pause();
    },
    setRequirement(value) { if (typeof value === 'boolean' && state.requireAssetCache !== value) patch({ requireAssetCache: value }); },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    downloadMissing: () => perform('download'),
    importZip(file) {
      if (!(file instanceof env.Blob)) return Promise.reject(assetCacheError('ASSET_CACHE_ZIP_INVALID'));
      return perform('import', { file });
    },
    importCatalog(file) {
      if (!(file instanceof env.Blob)) return Promise.reject(assetCacheError('ASSET_CACHE_BAD_CATALOG'));
      return perform('catalog', { file });
    },
    async admission({ fast = false } = {}) {
      // Fail open locally: optional mode remains usable when browser storage is unavailable.
      // Required mode is enforced by the server and refuses an absent/partial report.
      if (!state.supported) return null;
      if (fast && catalog && state.catalogCurrent && state.catalogComplete
        && state.missingFiles === 0 && state.readyFiles === state.totalFiles && state.readyBytes === state.totalBytes) {
        const report = { schema: catalog.schema, version: catalog.version,
          readyFiles: state.readyFiles, readyBytes: state.readyBytes };
        refreshAdmissionInBackground();
        return report;
      }
      if (fast) {
        // A cold or partial cache must be rejected by the server in strict mode, but the
        // create click itself must still reach the server immediately. Keep the expensive
        // recount off the request path so an optional room is never held behind storage I/O.
        refreshAdmissionInBackground();
        return null;
      }
      if (operation) return null;
      try {
        await scan({ refresh: true });
        if (!catalog || !state.catalogCurrent || !state.catalogComplete || operation) return null;
        return { schema: catalog.schema, version: catalog.version, readyFiles: state.readyFiles, readyBytes: state.readyBytes };
      } catch { return null; }
    },
    pause, clear: () => perform('clear'),
    requestPersistence() {
      if (!state.supported || !state.storage.persistenceSupported) {
        patch({ persistence: 'unsupported' });
        return Promise.resolve(false);
      }
      if (state.storage.persisted) {
        patch({ persistence: 'granted' });
        return Promise.resolve(true);
      }
      if (persistenceRequest) return persistenceRequest;

      // Invoke persist() before the first await so browsers retain the user activation.
      let pending;
      patch({ persistence: 'requesting' });
      try { pending = env.navigator.storage.persist(); }
      catch {
        patch({ persistence: 'error' });
        return Promise.resolve(false);
      }
      persistenceRequest = (async () => {
        try {
          const granted = !!await pending;
          await updateStorage();
          patch({ persistence: granted ? 'granted' : 'denied',
            storage: { ...state.storage, persisted: granted || state.storage.persisted } });
          return granted;
        } catch {
          await updateStorage();
          patch({ persistence: 'error' });
          return false;
        } finally { persistenceRequest = null; }
      })();
      return persistenceRequest;
    },
    async setPlaying(value) {
      if (ownPlaying === !!value) return;
      ownPlaying = !!value;
      patch({ playing: ownPlaying });
      markPlaying(ownPlaying);
      if (ownPlaying) pause();
      if (registration) {
        try {
          const result = await swMessage('ASSET_CACHE_PLAYING', { playing: ownPlaying });
          patch({ playing: ownPlaying || !!result.playing });
        } catch { /* No SW must never prevent entering a match. */ }
      }
      if (!ownPlaying && !initialized && !initializing) await initialize();
      // Do not apply catalog upgrades on this page automatically: assets/data modules may still
      // hold old manifests. Explicit operations in the lobby or a normal reload adopt the new catalog.
    },
    destroy() {
      pause();
      try { env.removeEventListener?.('pagehide', releaseMarker); } catch { /* no window */ }
      markPlaying(false);
      if (backgroundTimer !== null) env.clearTimeout(backgroundTimer);
      env.navigator?.serviceWorker?.removeEventListener('message', onSWMessage);
      listeners.clear();
    },
  };
  return manager;
}

export const assetCache = createAssetCacheManager();

// Imported-art helpers (upstream 0.3.0, public/sw.js): Cache Storage for a player-imported pack. Kept beside the
// asset-cache coordinator above so every consumer can import both APIs from this module.
// The constants themselves live in shared/assetCache.js: the merged module SW (public/asset-cache-sw.js) and the
// worker read the same module, so the two sides cannot drift. public/sw.js stays a classic fallback for browsers
// without module service workers and keeps its own copy (a unit test checks the sync).
//
// The worker serves only same-origin GET of a content-hashed /assets/, /fonts/ or /media/ URL. A hit comes from
// this cache. A miss goes to the network and is not written here. HTML, scripts, /data/, /sim/ and /ws are never
// matched. A Range request is left to the network so audio seeking still reaches the server. What an import stored is
// also listed in one index entry of the cache (IMPORTED_INDEX_URL): Chrome cannot list a cache that large.

/**
 * Whether a request should be answered from the import cache.
 * `pageOrigin` is the page (and the worker) origin. A relative URL is resolved against it.
 * @param {Request | { url?: string, method?: string, headers?: { get?: Function, range?: string } } | string} request
 * @param {string} [pageOrigin]
 */
export function shouldServeImportedAsset(request, pageOrigin) {
  const method = typeof request === 'string' ? 'GET' : (request?.method || 'GET');
  if (String(method).toUpperCase() !== 'GET') return false;
  if (request && typeof request === 'object' && request.headers) {
    const headers = request.headers;
    const range = typeof headers.get === 'function' ? headers.get('range') : (headers.range || headers.Range);
    if (range) return false;
  }
  const raw = typeof request === 'string' ? request : request?.url;
  if (!raw || !pageOrigin) return false;
  let url;
  try { url = new URL(raw, pageOrigin); } catch { return false; }
  if (url.origin !== pageOrigin) return false;
  return IMPORTED_ASSET_PATH.test(url.pathname);
}

/** Why import is unavailable, or `{ ok: true }` on a secure context that has the APIs. */
export function importSupport(nav = globalThis.navigator, secure = globalThis.isSecureContext) {
  if (!secure) return { ok: false, reason: 'insecure' };
  if (!nav?.serviceWorker || !globalThis.caches || !globalThis.crypto?.subtle) return { ok: false, reason: 'unsupported' };
  return { ok: true };
}

/**
 * Register the merged asset worker. Kept as a small boot helper for callers that only need imported art; the
 * pre-cache manager registers the same worker in initialize(). Failures are swallowed: a missing worker must not
 * stop the game. Unit tests import the downloader and must not register a worker as a side effect.
 * @returns {Promise<boolean>}
 */
export function registerImportedAssetWorker(nav = globalThis.navigator, secure = globalThis.isSecureContext) {
  if (!secure || !nav?.serviceWorker?.register) return Promise.resolve(false);
  return nav.serviceWorker.register('/asset-cache-sw.js', { scope: '/', type: 'module', updateViaCache: 'none' })
    .then(() => true, () => false);
}

/** Content-Type stored with an imported response, chosen from the URL the game will request. */
export function contentTypeFor(url) {
  const path = String(url || '').split('?')[0].toLowerCase();
  if (path.endsWith('.png')) return 'image/png';
  if (path.endsWith('.jpg') || path.endsWith('.jpeg')) return 'image/jpeg';
  if (path.endsWith('.webp')) return 'image/webp';
  if (path.endsWith('.gif')) return 'image/gif';
  if (path.endsWith('.mp3')) return 'audio/mpeg';
  if (path.endsWith('.ogg') || path.endsWith('.oga')) return 'audio/ogg';
  if (path.endsWith('.m4a') || path.endsWith('.aac')) return 'audio/aac';
  if (path.endsWith('.wav')) return 'audio/wav';
  if (path.endsWith('.opus')) return 'audio/ogg';
  if (path.endsWith('.woff2')) return 'font/woff2';
  if (path.endsWith('.woff')) return 'font/woff';
  if (path.endsWith('.css')) return 'text/css; charset=utf-8';
  if (path.endsWith('.json')) return 'application/json';
  if (path.endsWith('.atlas')) return 'text/plain; charset=utf-8';
  return 'application/octet-stream';
}

/** Put one body at each URL. Each put gets its own copy: Cache Storage consumes the body. */
export async function putImportedAsset(cache, urls, bytes, typeFor = contentTypeFor) {
  const body = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  await Promise.all([...urls].map((url) => {
    const copy = body.slice();
    const response = new Response(copy, {
      status: 200,
      headers: { 'Content-Type': typeFor(url) },
    });
    return cache.put(url, response);
  }));
}

function pathnameOf(url) {
  try { return new URL(url, 'http://localhost').pathname; } catch { return ''; }
}

/**
 * The import's own list of the pathnames it stored: a JSON array kept in the import cache at this same-origin path,
 * which the worker never answers (not a hashed /assets/, /fonts/ or /media/ URL). Chrome refuses Cache.keys() for a
 * cache of more than about 15,000 entries ("Operation too large"); a whole pack stores some 43,000 (the audio twice).
 */
async function readImportList(cache, url) {
  try {
    const hit = await cache.match(url);
    if (!hit) return null;
    const list = await hit.json();
    return Array.isArray(list) ? new Set(list.filter((p) => typeof p === 'string' && p && p !== url)) : null;
  } catch {
    return null;
  }
}

async function writeImportList(cache, url, paths) {
  await cache.put(url, new Response(JSON.stringify([...paths].sort()), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  }));
}

/** The index as a Set, or null without a readable one. */
async function readImportIndex(cache) {
  return readImportList(cache, IMPORTED_INDEX_URL);
}

/** Pathnames whose bytes the title import borrows from the pre-cache, or null without a readable list. */
async function readImportedBorrowed(cache) {
  return readImportList(cache, IMPORTED_BORROWED_URL);
}

/** Pathnames of Cache.keys() (throws for a cache too large to list). */
async function keyPaths(cache) {
  const out = new Set();
  for (const req of await cache.keys()) {
    const path = pathnameOf(typeof req === 'string' ? req : req.url);
    if (path && path !== IMPORTED_INDEX_URL && path !== IMPORTED_BORROWED_URL) out.add(path);
  }
  return out;
}

/**
 * Pathnames currently stored for imported art (assets, fonts and the audio /media/ alias): the import's index, else
 * the cache's keys (a cache written without an index); an empty set when neither can be read. Paths borrowed from the
 * pre-cache (the title import skipped rewriting a file it already had) are included: the merged SW serves both caches.
 */
export async function listImportedPaths(cachesApi = globalThis.caches) {
  if (!cachesApi?.open) return new Set();
  try {
    const cache = await cachesApi.open(IMPORTED_ASSET_CACHE);
    const stored = (await readImportIndex(cache)) ?? await keyPaths(cache);
    const borrowed = await readImportedBorrowed(cache);
    if (borrowed) for (const path of borrowed) stored.add(path);
    return stored;
  } catch {
    return new Set();
  }
}

/**
 * Add the pathnames an import stored to the index (assetPack.js, as an import ends — finished, cancelled or failed).
 * Without an index yet, the cache's keys seed it when Cache.keys() still answers.
 * @param {Cache} cache the open import cache
 * @param {Iterable<string>} paths
 */
export async function addImportedPaths(cache, paths) {
  let all = await readImportIndex(cache);
  if (!all) {
    try { all = await keyPaths(cache); } catch { all = new Set(); }
  }
  for (const p of paths) if (typeof p === 'string' && p && p !== IMPORTED_INDEX_URL && p !== IMPORTED_BORROWED_URL) all.add(p);
  await writeImportList(cache, IMPORTED_INDEX_URL, all);
}

/**
 * Record paths whose bytes already live in the pre-cache. The title import checks each file's full SHA-256 against
 * `sp-asset-cache-v1` before writing; a hit is not stored twice. The merged SW serves the pre-cache copy, and the
 * pre-cache's clear removes this list again (public/asset-cache-sw.js).
 * @param {Cache} cache the open import cache
 * @param {Iterable<string>} paths
 */
export async function addImportedBorrowedPaths(cache, paths) {
  let all = await readImportedBorrowed(cache);
  if (!all) all = new Set();
  for (const p of paths) if (typeof p === 'string' && p && p !== IMPORTED_INDEX_URL && p !== IMPORTED_BORROWED_URL) all.add(p);
  await writeImportList(cache, IMPORTED_BORROWED_URL, all);
}

/** How many imported files are stored, counting /assets/ and /fonts/ only (not the /media/ alias). */
export async function countImportedFiles(cachesApi = globalThis.caches) {
  const paths = await listImportedPaths(cachesApi);
  let n = 0;
  for (const path of paths) {
    if (path.startsWith('/assets/') || path.startsWith('/fonts/')) n++;
  }
  return n;
}

/**
 * Delete the stored pathnames that `wanted` does not name and rewrite the index to what remains (设置 → 素材存储 →
 * 清理旧版本素材, 0.3.1). A file that changed got a new hash, so its old copy is never served again (shared/assetPaths.js)
 * but stayed here. `removedFiles` counts /assets/ and /fonts/ only, like countImportedFiles (an audio file is stored twice).
 * Borrowed paths are only dropped from their list: their bytes belong to the pre-cache, not to this cache.
 * @param {Set<string>} wanted pathnames the server's current manifests name, their /media aliases included
 * @returns {Promise<{ removed: number, removedFiles: number, kept: number }>}
 */
export async function pruneImportedPaths(wanted, cachesApi = globalThis.caches) {
  const cache = await cachesApi.open(IMPORTED_ASSET_CACHE);
  // no index yet: the keys, when Cache.keys() still answers (a whole pack always wrote an index)
  const stored = (await readImportIndex(cache)) ?? await keyPaths(cache);
  const borrowed = await readImportedBorrowed(cache);
  const stale = [...stored].filter((p) => !wanted.has(p));
  const kept = [...stored].filter((p) => wanted.has(p));
  const keptBorrowed = borrowed ? [...borrowed].filter((p) => wanted.has(p)) : [];
  let removed = 0, removedFiles = 0;
  for (let i = 0; i < stale.length; i += 32) {
    await Promise.all(stale.slice(i, i + 32).map(async (p) => {
      let gone;
      try { gone = await cache.delete(p); } catch { kept.push(p); return; }
      if (!gone) return; // listed but absent: it leaves the index
      removed++;
      if (p.startsWith('/assets/') || p.startsWith('/fonts/')) removedFiles++;
    }));
  }
  await writeImportList(cache, IMPORTED_INDEX_URL, kept);
  if (borrowed) await writeImportList(cache, IMPORTED_BORROWED_URL, keptBorrowed);
  return { removed, removedFiles, kept: kept.length + keptBorrowed.length };
}

/** Delete every version of the import cache. The worker stays registered. */
export async function clearImportedAssets(cachesApi = globalThis.caches) {
  if (!cachesApi?.delete) return false;
  try {
    if (cachesApi.keys) {
      const names = await cachesApi.keys();
      const ours = names.filter((name) => String(name).startsWith(IMPORTED_ASSET_CACHE_PREFIX));
      if (ours.length) {
        await Promise.all(ours.map((name) => cachesApi.delete(name)));
        return true;
      }
    }
    return await cachesApi.delete(IMPORTED_ASSET_CACHE);
  } catch {
    return false;
  }
}

/** `navigator.storage.estimate()`, or null. `usage` is the whole origin, not only this cache. */
export async function storageEstimate(nav = globalThis.navigator) {
  try {
    const est = await nav?.storage?.estimate?.();
    if (!est) return null;
    return { usage: est.usage || 0, quota: est.quota || 0 };
  } catch {
    return null;
  }
}

/**
 * Whether the browser already keeps the origin's storage (`navigator.storage.persisted()`), or null where it cannot say:
 * StorageManager exists only in a secure context, so plain http to a LAN IP reads null too. 设置 → 素材存储 shows it.
 * @returns {Promise<boolean | null>}
 */
export async function storagePersisted(nav = globalThis.navigator) {
  try {
    if (!nav?.storage?.persisted) return null;
    return await nav.storage.persisted();
  } catch {
    return null;
  }
}

/**
 * Ask the browser to keep the origin's storage. The return value is not a promise that the bytes will survive
 * eviction (iOS may still drop them after about seven days).
 * @returns {Promise<boolean | null>}
 */
export async function askPersistStorage(nav = globalThis.navigator) {
  try {
    if (!nav?.storage?.persist) return null;
    return await nav.storage.persist();
  } catch {
    return null;
  }
}
