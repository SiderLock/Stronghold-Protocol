import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createAssetCacheManager } from '../public/js/assetCache.js';
import { ASSET_CACHE_LATEST_KEY, ASSET_CACHE_SW_PROTOCOL, MAX_MANIFEST_BYTES, assetCacheCatalogKey, assetCacheSummary } from '../shared/assetCache.js';

const catalog = { schema: 1, files: [{ url: '/assets/a.png', bytes: 3,
  sha256: 'b'.repeat(64), type: 'image/png', aliases: [] }], totalFiles: 1, totalBytes: 3, complete: true, missing: [] };
catalog.version = createHash('sha256').update(JSON.stringify({ schema: 1, files: catalog.files })).digest('hex');

function fixture({ storage = {}, secure = true, persistedCatalog = true, fastUpdateTimeout = false, online = false, renderCache = false } = {}) {
  const messages = [], work = [], listeners = new Map(), catalogUpdates = [];
  let catalogReads = 0, statusReads = 0, broken = false, playing = false, ready = 0;
  let updateResponse = () => Response.json({ error: 'ASSET_CACHE_CATALOG_LOCAL_ONLY' }, { status: 403 });
  let catalogResponse = () => Response.json({ error: 'ASSET_CACHE_CATALOG_LOCAL_ONLY' }, { status: 403 });
  let serverSummary = assetCacheSummary(catalog);
  const origin = 'https://game.test';
  const metadata = new Map();
  if (persistedCatalog) {
    metadata.set(origin + ASSET_CACHE_LATEST_KEY, { version: catalog.version });
    metadata.set(origin + assetCacheCatalogKey(catalog.version), catalog);
  }
  const sw = { postMessage(data, ports) {
    messages.push(data);
    if (data.type === 'ASSET_CACHE_PLAYING') playing = data.playing;
    if (data.type === 'ASSET_CACHE_PIN') {
      metadata.set(origin + ASSET_CACHE_LATEST_KEY, { version: data.catalog.version });
      metadata.set(origin + assetCacheCatalogKey(data.catalog.version), structuredClone(data.catalog));
    }
    if (data.type === 'ASSET_CACHE_CLEAR') ready = 0;
    ports[0].postMessage({ ok: true, playing, protocol: ASSET_CACHE_SW_PROTOCOL, imported: true, renderCache });
  } };
  const registration = { active: sw };
  const environment = {
    isSecureContext: secure, location: { origin }, crypto: globalThis.crypto, Blob, MessageChannel, AbortController,
    caches: { open: async () => ({ match: async (url) => metadata.has(url) ? Response.json(metadata.get(url)) : undefined }) },
    setTimeout: (fn, ms) => setTimeout(fn, ms === 1000 ? 1 : fastUpdateTimeout && ms === 120000 ? 20 : ms), clearTimeout,
    navigator: {
      serviceWorker: { controller: sw, ready: Promise.resolve(registration),
        register: async () => registration, addEventListener: (name, fn) => listeners.set(name, fn),
        removeEventListener: (name) => listeners.delete(name) },
      locks: { request: async (_name, _options, fn) => fn({}) },
      storage: { estimate: async () => ({ usage: 1, quota: 1000 }), persisted: async () => false, ...storage },
    },
    Worker: class {
      postMessage(message) {
        work.push(message);
        setTimeout(async () => {
          if (message.action === 'read-catalog') {
            const parsed = message.format === 'json' ? JSON.parse(await message.file.text()) : catalog;
            this.onmessage?.({ data: { id: message.id, type: 'done', catalog: parsed } }); return;
          }
          if (message.action === 'import' || message.action === 'download') ready = message.catalog.totalFiles;
          const readyFiles = Math.min(ready, message.catalog.totalFiles);
          const readyBytes = message.catalog.files.slice(0, readyFiles).reduce((sum, item) => sum + item.bytes, 0);
          this.onmessage?.({ data: { id: message.id, type: 'progress', readyFiles, readyBytes,
            missingFiles: message.catalog.totalFiles - readyFiles, missingBytes: message.catalog.totalBytes - readyBytes } });
          this.onmessage?.({ data: { id: message.id, type: 'done' } });
        }, 0);
      }
      terminate() { this.onmessage = null; }
    },
  };
  const manager = createAssetCacheManager({ environment, doFetch: async (url, options) => {
    if (url.includes('catalog-update')) {
      catalogUpdates.push({ url, options }); return updateResponse(url, options);
    }
    if (url.includes('catalog')) { catalogReads++; return catalogResponse(url, options); }
    statusReads++;
    return Response.json(broken ? {} : { ...serverSummary, policy: { enabled: online } });
  } });
  return { manager, environment, registration, messages, work, metadata, catalogUpdates, catalogReads: () => catalogReads, statusReads: () => statusReads,
    updateResponse: (value) => { updateResponse = typeof value === 'function' ? value : () => value; },
    catalogResponse: (value) => { catalogResponse = typeof value === 'function' ? value : () => value; },
    externalPlaying(value) {
      playing = value; listeners.get('message')?.({ data: { type: 'ASSET_CACHE_PLAYING_CHANGED', playing: value } });
    },
    broken: (value) => { broken = value; }, summary: (value) => { serverSummary = value; }, ready: (value) => { ready = value; },
    update: () => listeners.get('message')?.({ data: { type: 'ASSET_CACHE_UPDATED' } }) };
}

test('a summary failure is retryable by explicit checking; reopening never downloads a directory or refetches status', async () => {
  const f = fixture();
  try {
    f.broken(true);
    assert.equal((await f.manager.initialize()).error, 'ASSET_CACHE_CATALOG_UNAVAILABLE');
    f.broken(false);
    await f.manager.initialize();
    assert.equal(f.statusReads(), 1, 'reopening does not create repeated HTTP requests');
    assert.equal((await f.manager.scan()).phase, 'idle');
    assert.equal(f.statusReads(), 2);
    await f.manager.initialize();
    assert.equal(f.catalogReads(), 0);
    assert.equal(f.statusReads(), 2);
    assert.equal(f.manager.getState().policy.enabled, false, 'disabled online filling still leaves local import available');
  } finally { f.manager.destroy(); }
});

test('render-cache consent supports live matches without relaxing import guards or accepting old workers', async () => {
  const f = fixture({ renderCache: true });
  const old = fixture();
  try {
    assert.equal(await f.manager.configureRendering(true), true);
    assert.equal(f.manager.getState().renderCacheReady, true);
    await f.manager.setPlaying(true);
    assert.equal(await f.manager.configureRendering(false, { clear: true }), true);
    assert.ok(f.messages.some((m) => m.type === 'ASSET_CACHE_RENDER_CONSENT' && m.clear));
    assert.equal(f.manager.getState().renderCacheReady, false);
    assert.equal(await old.manager.configureRendering(true), false, 'older workers need an idle upgrade or a reopened page');
    assert.ok(!old.messages.some((m) => m.type === 'ASSET_CACHE_RENDER_CONSENT'));
  } finally { f.manager.destroy(); old.manager.destroy(); }
});

test('a direct combat reconnect restores the persisted directory before playing and does not download one', async () => {
  const f = fixture();
  try {
    await f.manager.setPlaying(true);
    assert.equal((await f.manager.initialize()).phase, 'idle');
    assert.equal(f.catalogReads(), 0);
    assert.equal(f.messages.filter((m) => m.type === 'ASSET_CACHE_PLAYING').at(-1).playing, true);
    await f.manager.setPlaying(false);
    assert.equal(f.manager.getState().phase, 'idle'); assert.equal(f.catalogReads(), 0);
    assert.ok(f.messages.findIndex((m) => m.type === 'ASSET_CACHE_PIN') < f.messages.findIndex((m) => m.type === 'ASSET_CACHE_PLAYING'));
    const before = f.messages.length;
    await f.manager.setPlaying(false); await f.manager.setPlaying(false);
    assert.equal(f.messages.length, before, 'high-frequency store emits do not rewrite the playing pin');
  } finally { f.manager.destroy(); }
});

test('passive asset progress notifications inspect local keys without repeatedly downloading the catalog', async () => {
  const f = fixture();
  try {
    await f.manager.initialize();
    f.update(); f.update();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(f.catalogReads(), 0); assert.equal(f.statusReads(), 1);
    assert.equal(f.work.filter((job) => job.action === 'scan').length, 2, 'notifications are coalesced into one local scan');
  } finally { f.manager.destroy(); }
});

test('a cold browser can explicitly download the directory and then fill missing files online', async () => {
  const f = fixture({ persistedCatalog: false, online: true });
  try {
    assert.equal((await f.manager.initialize()).phase, 'catalog-required');
    assert.equal(f.manager.getState().hasCatalog, false);
    f.catalogResponse(Response.json(catalog));
    await f.manager.downloadMissing();
    assert.equal(f.manager.getState().phase, 'ready');
    assert.equal(f.catalogReads(), 1);
    assert.equal(f.manager.getState().catalogCurrent, true);
  } finally { f.manager.destroy(); }
});

test('the complete ZIP can bootstrap a cold browser; a matching local directory makes old/partial ZIP manifests optional', async () => {
  const f = fixture({ persistedCatalog: false });
  try {
    await f.manager.importZip(new Blob(['ZIP fixture']));
    assert.equal(f.manager.getState().phase, 'ready');
    assert.equal(f.work.filter((job) => job.action === 'read-catalog').length, 1);
    await f.manager.importZip(new Blob(['partial ZIP fixture']));
    assert.equal(f.work.filter((job) => job.action === 'read-catalog').length, 1);
    assert.ok(f.metadata.has('https://game.test' + assetCacheCatalogKey(catalog.version)));
    assert.equal(f.catalogReads(), 0);
  } finally { f.manager.destroy(); }
});

test('tampered/stale directories cannot replace a valid pin, and admission recounts local contents after eviction', async () => {
  const f = fixture();
  try {
    await f.manager.initialize();
    const changed = structuredClone(catalog); changed.files[0].sha256 = 'c'.repeat(64);
    await assert.rejects(f.manager.importCatalog(new Blob([JSON.stringify(changed)])), /ASSET_CACHE_BAD_CATALOG/);
    f.summary({ ...assetCacheSummary(catalog), version: 'd'.repeat(64) });
    await assert.rejects(f.manager.importCatalog(new Blob([JSON.stringify(catalog)])), /ASSET_CACHE_STALE_CATALOG/);
    assert.equal(await f.manager.admission(), null);
    assert.equal(f.messages.filter((m) => m.type === 'ASSET_CACHE_PIN').length, 1, 'failed imports preserve the existing pin');
    f.summary(assetCacheSummary(catalog)); f.ready(1);
    assert.equal((await f.manager.admission()).readyFiles, 1);
    f.ready(0);
    assert.equal((await f.manager.admission()).readyFiles, 0, 'a previous full progress display is not an admission credential');
    assert.equal(f.catalogReads(), 0);
  } finally { f.manager.destroy(); }
});

test('fast admission returns a complete local report before its background eviction check', async () => {
  const f = fixture();
  try {
    f.ready(1);
    await f.manager.initialize();
    const scansBefore = f.work.filter((job) => job.action === 'scan').length;
    const report = await f.manager.admission({ fast: true });
    assert.deepEqual(report, { schema: 1, version: catalog.version, readyFiles: 1, readyBytes: 3 });
    assert.equal(f.work.filter((job) => job.action === 'scan').length, scansBefore,
      'the room-create path does not wait for a second local scan');
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(f.work.filter((job) => job.action === 'scan').length, scansBefore + 1,
      'the complete report is rechecked in the background');
  } finally { f.manager.destroy(); }
});

test('fast admission sends an incomplete create to the server without waiting for a recount', async () => {
  const f = fixture();
  try {
    await f.manager.initialize();
    const scansBefore = f.work.filter((job) => job.action === 'scan').length;
    const started = Date.now();
    assert.equal(await f.manager.admission({ fast: true }), null);
    assert.ok(Date.now() - started < 100, 'an incomplete create does not wait for storage');
    assert.equal(f.work.filter((job) => job.action === 'scan').length, scansBefore,
      'the background recount is scheduled after the request path returns');
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(f.work.filter((job) => job.action === 'scan').length, scansBefore + 1);
  } finally { f.manager.destroy(); }
});

function upgradedCatalog() {
  const next = structuredClone(catalog);
  next.files.push({ url: '/assets/new.png', bytes: 5, sha256: 'c'.repeat(64), type: 'image/png', aliases: [] });
  next.totalFiles = 2; next.totalBytes = 8;
  next.version = createHash('sha256').update(JSON.stringify({ schema: 1, files: next.files })).digest('hex');
  return next;
}

async function outdatedFixture(options) {
  const f = fixture(options); f.ready(1);
  await f.manager.initialize();
  const next = upgradedCatalog(); f.summary(assetCacheSummary(next)); f.updateResponse(Response.json(next));
  return { ...f, next };
}

test('pausing, destruction or starting play during SW installation prevents activation and directory transfers', async () => {
  for (const action of ['pause', 'destroy', 'own-playing', 'other-playing']) {
    const f = await outdatedFixture();
    const old = f.environment.navigator.serviceWorker.controller;
    const send = old.postMessage;
    old.postMessage = (data, ports) => data.type === 'ASSET_CACHE_CAPABILITIES'
      ? ports[0].postMessage({ ok: false, error: 'ASSET_CACHE_BAD_MESSAGE' }) : send(data, ports);
    let started, finish, activations = 0;
    const installing = new Promise((resolve) => { started = resolve; });
    f.registration.update = () => {
      started();
      return new Promise((resolve) => { finish = () => {
        f.registration.waiting = { state: 'installed', postMessage: () => { activations++; } };
        resolve(f.registration);
      }; });
    };
    try {
      const updating = f.manager.updateCatalog();
      await installing;
      if (action === 'own-playing') await f.manager.setPlaying(true);
      else if (action === 'other-playing') f.externalPlaying(true);
      else f.manager[action]();
      finish();
      assert.equal((await updating).phase, 'paused', action);
      assert.equal(activations, 0, action);
      assert.equal(f.catalogReads(), 0); assert.equal(f.catalogUpdates.length, 0);
      assert.equal(f.metadata.get('https://game.test' + ASSET_CACHE_LATEST_KEY).version, catalog.version);
    } finally { f.manager.destroy(); }
  }
});

test('an unavailable SW upgrade reports the component error before downloading or replacing the catalog', async () => {
  const f = await outdatedFixture();
  const old = f.environment.navigator.serviceWorker.controller;
  const send = old.postMessage;
  old.postMessage = (data, ports) => data.type === 'ASSET_CACHE_CAPABILITIES'
    ? ports[0].postMessage({ ok: false, error: 'ASSET_CACHE_BAD_MESSAGE' }) : send(data, ports);
  f.registration.update = async () => { throw new Error('worker update offline'); };
  try {
    await assert.rejects(f.manager.updateCatalog(), /ASSET_CACHE_SW_UPDATE_REQUIRED/);
    assert.equal(f.manager.getState().error, 'ASSET_CACHE_SW_UPDATE_REQUIRED');
    assert.equal(f.manager.getState().catalogUpdateRetryAt, 0);
    assert.equal(f.catalogUpdates.length, 0); assert.equal(f.catalogReads(), 0);
    assert.equal(f.manager.getState().version, catalog.version);
  } finally { f.manager.destroy(); }
});

test('an empty or cleared old directory can be explicitly fetched online, while current directories are a no-op', async () => {
  for (const kind of ['cold', 'empty', 'cleared', 'current']) {
    const f = fixture({ persistedCatalog: kind !== 'cold' });
    try {
      const next = upgradedCatalog();
      f.catalogResponse(() => Response.json(next));
      if (kind === 'cleared') f.ready(1);
      await f.manager.initialize();
      if (kind === 'cleared') await f.manager.clear();
      if (kind !== 'current') f.summary(assetCacheSummary(next));
      await f.manager.updateCatalog();
      assert.equal(f.manager.getState().version, kind === 'current' ? catalog.version : next.version, kind);
      assert.equal(f.manager.getState().catalogCurrent, true, kind);
      assert.equal(f.manager.getState().readyFiles, 0, 'directory acquisition does not download missing files');
      assert.equal(f.catalogUpdates.length, 0, kind);
      assert.equal(f.catalogReads(), kind === 'current' ? 0 : 1, kind);
    } finally { f.manager.destroy(); }
  }
});

test('online filling explicitly refreshes stale directories and recovers after clearing their contents', async () => {
  for (const cleared of [false, true]) {
    const f = await outdatedFixture({ online: true });
    try {
      f.catalogResponse(() => Response.json(f.next));
      if (cleared) await f.manager.clear();
      await f.manager.scan(); await f.manager.initialize();
      assert.equal(f.catalogReads(), 0); assert.equal(f.catalogUpdates.length, 0, 'ordinary checks remain summary-only');
      await f.manager.downloadMissing();
      assert.equal(f.manager.getState().version, f.next.version);
      assert.equal(f.manager.getState().phase, 'ready');
      assert.equal(f.manager.getState().readyFiles, f.next.totalFiles);
      assert.equal(f.catalogReads(), cleared ? 1 : 0);
      assert.equal(f.catalogUpdates.length, cleared ? 0 : 1);
      assert.equal(f.work.filter((job) => job.action === 'download').length, 1);
    } finally { f.manager.destroy(); }
  }
});

test('only an explicit manual update downloads a verified directory and reuses old content without filling or pruning', async () => {
  const f = await outdatedFixture();
  try {
    await f.manager.initialize(); await f.manager.scan(); await f.manager.scan({ deep: true }).catch(() => {});
    assert.equal(await f.manager.admission(), null);
    assert.equal(f.catalogUpdates.length, 0, 'status checks and full verification do not download a directory');
    const phases = []; f.manager.subscribe((state) => phases.push(state.phase));
    const updated = await f.manager.updateCatalog();
    assert.equal(updated.version, f.next.version); assert.equal(updated.catalogCurrent, true);
    assert.equal(updated.readyFiles, 1); assert.equal(updated.missingFiles, 1); assert.equal(updated.readyBytes, 3);
    assert.equal(f.catalogUpdates.length, 1); assert.equal(f.catalogReads(), 0);
    const request = f.catalogUpdates[0], params = new URL(request.url, 'https://game.test').searchParams;
    assert.equal(request.options.headers['X-Asset-Cache-Update'], 'manual');
    assert.equal(params.get('from'), catalog.version); assert.equal(params.get('to'), f.next.version);
    assert.equal(params.get('readyFiles'), '1'); assert.equal(params.get('readyBytes'), '3');
    assert.ok(phases.includes('updating-catalog')); assert.equal(updated.catalogUpdateRetryAt, 0);
    assert.equal(f.work.some((job) => job.action === 'download'), false);
    assert.equal(f.messages.some((message) => message.type === 'ASSET_CACHE_PRUNE'), false);
    assert.equal(f.metadata.get('https://game.test' + ASSET_CACHE_LATEST_KEY).version, f.next.version);
    await f.manager.updateCatalog();
    assert.equal(f.catalogUpdates.length, 1, 'an already-current directory never downloads again');
  } finally { f.manager.destroy(); }
});

test('actual local scan selects cold acquisition after content eviction despite a stale nonzero display', async () => {
  const f = await outdatedFixture();
  try {
    assert.equal(f.manager.getState().readyFiles, 1);
    f.ready(0);
    f.catalogResponse(() => Response.json(f.next));
    await f.manager.updateCatalog();
    assert.equal(f.catalogUpdates.length, 0); assert.equal(f.catalogReads(), 1);
    assert.equal(f.manager.getState().readyFiles, 0); assert.equal(f.manager.getState().version, f.next.version);
  } finally { f.manager.destroy(); }
});

test('manual directory update is mutually exclusive and a failed request reports its error without an invented cooldown', async () => {
  const f = await outdatedFixture(); let finish, started;
  const pendingFetch = new Promise((resolve) => { started = resolve; });
  f.updateResponse(() => { started(); return new Promise((resolve) => { finish = resolve; }); });
  try {
    const first = f.manager.updateCatalog(); await pendingFetch;
    await assert.rejects(f.manager.updateCatalog(), /ASSET_CACHE_BUSY/);
    finish(Response.json({ error: 'ASSET_CACHE_CATALOG_UNAVAILABLE' }, { status: 500 }));
    await assert.rejects(first, /ASSET_CACHE_CATALOG_UNAVAILABLE/);
    assert.equal(f.catalogUpdates.length, 1); assert.equal(f.manager.getState().version, catalog.version);
    assert.equal(f.manager.getState().error, 'ASSET_CACHE_CATALOG_UNAVAILABLE');
    assert.equal(f.manager.getState().catalogUpdateRetryAt, 0, 'only a server 429 starts a cooldown');
    assert.equal(f.metadata.get('https://game.test' + ASSET_CACHE_LATEST_KEY).version, catalog.version);
    f.updateResponse(() => Response.json(f.next));
    await f.manager.updateCatalog();
    assert.equal(f.catalogUpdates.length, 2, 'another explicit click can recover without waiting');
    assert.equal(f.manager.getState().version, f.next.version);
  } finally { f.manager.destroy(); }
});

test('HTTP 429 uses the actual short or long Retry-After countdown and never retries automatically', async () => {
  for (const seconds of [3, 120]) {
    const f = await outdatedFixture();
    f.updateResponse(Response.json({ error: 'ASSET_CACHE_CATALOG_UPDATE_COOLDOWN' }, { status: 429,
      headers: { 'Retry-After': String(seconds) } }));
    try {
      const before = Date.now();
      await assert.rejects(f.manager.updateCatalog(), /ASSET_CACHE_CATALOG_UPDATE_RATE_LIMITED/);
      assert.ok(f.manager.getState().catalogUpdateRetryAt >= before + seconds * 1000);
      assert.ok(f.manager.getState().catalogUpdateRetryAt <= Date.now() + seconds * 1000);
      await assert.rejects(f.manager.updateCatalog(), /ASSET_CACHE_CATALOG_UPDATE_RATE_LIMITED/);
      assert.equal(f.catalogUpdates.length, 1); assert.equal(f.manager.getState().version, catalog.version);
    } finally { f.manager.destroy(); }
  }
});

test('HTTP 503 distinguishes an explicit owner-disabled error from bounded/unreadable catalogue failures', async () => {
  for (const kind of ['disabled', 'unavailable', 'invalid-json', 'oversized-header', 'oversized-body', 'no-body']) {
    const f = await outdatedFixture(); let signal;
    f.updateResponse((_url, options) => {
      signal = options.signal;
      if (kind === 'disabled') return Response.json({ error: 'ASSET_CACHE_ONLINE_DISABLED' }, { status: 503 });
      if (kind === 'unavailable') return Response.json({ error: 'ASSET_CACHE_CATALOG_UNAVAILABLE' }, { status: 503 });
      if (kind === 'invalid-json') return new Response('{', { status: 503 });
      if (kind === 'no-body') return new Response(null, { status: 503 });
      if (kind === 'oversized-header') return Response.json({ error: 'ASSET_CACHE_ONLINE_DISABLED' }, {
        status: 503, headers: { 'Content-Length': '4097' },
      });
      return Response.json({ error: 'ASSET_CACHE_ONLINE_DISABLED', padding: ' '.repeat(4096) }, {
        status: 503, headers: { 'Content-Length': '100' },
      });
    });
    try {
      await assert.rejects(f.manager.updateCatalog(), new RegExp(kind === 'disabled'
        ? 'ASSET_CACHE_ONLINE_DISABLED' : 'ASSET_CACHE_CATALOG_UNAVAILABLE'));
      assert.equal(signal.aborted, true, kind);
      assert.equal(f.manager.getState().version, catalog.version, kind);
    } finally { f.manager.destroy(); }
  }
});

test('early response rejection aborts HTTP transport even before a reader is acquired', async () => {
  for (const kind of ['header-limit', 'no-body']) {
    const f = await outdatedFixture(); let signal;
    f.updateResponse((_url, options) => {
      signal = options.signal;
      return kind === 'header-limit' ? new Response('{}', { headers: { 'Content-Length': String(MAX_MANIFEST_BYTES + 1) } })
        : new Response(null);
    });
    try {
      await assert.rejects(f.manager.updateCatalog(), /ASSET_CACHE_BAD_CATALOG/);
      assert.equal(signal.aborted, true, kind);
      assert.equal(f.manager.getState().version, catalog.version, kind);
    } finally { f.manager.destroy(); }
  }
});

test('directory transfer timeout aborts and cancels the stream while preserving the old pin', async () => {
  const f = await outdatedFixture({ fastUpdateTimeout: true }); let signal, cancelled = false;
  f.updateResponse((_url, options) => {
    signal = options.signal;
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode('{"schema":1,'));
    }, cancel() { cancelled = true; } }));
  });
  try {
    await assert.rejects(f.manager.updateCatalog(), /ASSET_CACHE_CATALOG_UNAVAILABLE/);
    assert.equal(signal.aborted, true); assert.equal(cancelled, true);
    assert.equal(f.manager.getState().version, catalog.version);
    assert.equal(f.manager.getState().phase, 'error');
    assert.equal(f.catalogUpdates.length, 1, 'timeout has no automatic retry');
  } finally { f.manager.destroy(); }
});

test('a directory Fetch or cancellation ignoring abort cannot keep the page operation busy', async () => {
  for (const kind of ['headers', 'body']) {
    const f = await outdatedFixture({ fastUpdateTimeout: true });
    f.updateResponse(() => kind === 'headers' ? new Promise(() => {}) : new Response(new ReadableStream({
      start(c) { c.enqueue(new TextEncoder().encode('{')); }, cancel: () => new Promise(() => {}),
    })));
    try {
      await assert.rejects(f.manager.updateCatalog(), /ASSET_CACHE_CATALOG_UNAVAILABLE/);
      assert.equal(f.manager.getState().version, catalog.version);
      // Another action can start without destroying the manager or refreshing its page.
      await f.manager.scan();
      assert.notEqual(f.manager.getState().error, 'ASSET_CACHE_BUSY');
    } finally { f.manager.destroy(); }
  }
});

test('corrupt, oversized and mismatched downloaded directories preserve the existing pin and cache', async () => {
  for (const kind of ['tampered', 'bad-json', 'header-limit', 'decoded-limit', 'wrong-version']) {
    const f = await outdatedFixture();
    try {
      const pins = f.messages.filter((message) => message.type === 'ASSET_CACHE_PIN').length;
      if (kind === 'tampered') {
        const next = structuredClone(f.next); next.files[0].bytes++;
        f.updateResponse(Response.json(next));
      } else if (kind === 'bad-json') f.updateResponse(new Response('{'));
      else if (kind === 'header-limit') f.updateResponse(new Response('{}', { headers: { 'Content-Length': String(MAX_MANIFEST_BYTES + 1) } }));
      else if (kind === 'decoded-limit') {
        const chunk = new Uint8Array(4 * 1024 * 1024);
        f.updateResponse(new Response(new ReadableStream({ start(controller) {
          for (let i = 0; i < 9; i++) controller.enqueue(chunk);
          controller.close();
        } }), { headers: { 'Content-Length': '100', 'Content-Encoding': 'gzip' } }));
      } else f.updateResponse(Response.json(catalog));
      await assert.rejects(f.manager.updateCatalog(), new RegExp(kind === 'wrong-version'
        ? 'ASSET_CACHE_STALE_CATALOG' : 'ASSET_CACHE_BAD_CATALOG'));
      assert.equal(f.manager.getState().version, catalog.version, kind);
      assert.equal(f.messages.filter((message) => message.type === 'ASSET_CACHE_PIN').length, pins, kind);
      assert.equal(f.manager.getState().readyFiles, 1, kind);
      assert.equal(f.messages.some((message) => ['ASSET_CACHE_CLEAR', 'ASSET_CACHE_PRUNE'].includes(message.type)), false, kind);
    } finally { f.manager.destroy(); }
  }
});

test('a server version change during transfer or HTTP 409 refreshes only the small summary and preserves the old directory', async () => {
  for (const kind of ['during-transfer', 'http-409']) {
    const f = await outdatedFixture();
    const newerSummary = { ...assetCacheSummary(f.next), version: 'd'.repeat(64) };
    f.updateResponse(() => {
      f.summary(newerSummary);
      return kind === 'http-409' ? Response.json({ error: 'ASSET_CACHE_CATALOG_VERSION_MISMATCH' }, { status: 409 }) : Response.json(f.next);
    });
    try {
      await assert.rejects(f.manager.updateCatalog(), /ASSET_CACHE_STALE_CATALOG/);
      assert.equal(f.catalogUpdates.length, 1); assert.equal(f.catalogReads(), 0);
      assert.equal(f.manager.getState().version, catalog.version);
      assert.equal(f.manager.getState().serverVersion, newerSummary.version);
    } finally { f.manager.destroy(); }
  }
});

test('own or another tab playing blocks manual directory update before any download', async () => {
  for (const anotherTab of [false, true]) {
    const f = await outdatedFixture();
    try {
      if (anotherTab) f.externalPlaying(true); else await f.manager.setPlaying(true);
      await assert.rejects(f.manager.updateCatalog(), /ASSET_CACHE_PLAYING/);
      assert.equal(f.catalogUpdates.length, 0); assert.equal(f.manager.getState().version, catalog.version);
    } finally { f.manager.destroy(); }
  }
});

test('pause, destruction and starting play abort an in-flight directory stream without adopting partial metadata', async () => {
  for (const action of ['pause', 'destroy', 'playing', 'other-tab', 'emergency']) {
    const f = await outdatedFixture(); let started, cancelled = false, signal;
    const fetching = new Promise((resolve) => { started = resolve; });
    f.updateResponse((_url, options) => {
      signal = options.signal;
      return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode('{"schema":1,')); started();
      }, cancel() { cancelled = true; } }));
    });
    try {
      const pending = f.manager.updateCatalog(); await fetching;
      if (action === 'playing') await f.manager.setPlaying(true);
      else if (action === 'other-tab') f.externalPlaying(true);
      else if (action === 'emergency') f.manager.setEmergency(true);
      else f.manager[action]();
      const result = await pending;
      assert.equal(signal.aborted, true, action); assert.equal(cancelled, true, action);
      assert.equal(result.phase, 'paused', action); assert.equal(result.error, null, action);
      assert.equal(result.version, catalog.version, action);
      assert.equal(f.metadata.get('https://game.test' + ASSET_CACHE_LATEST_KEY).version, catalog.version, action);
    } finally { f.manager.destroy(); }
  }
});

test('emergency blocks online requests locally and recovery never restarts a download automatically', async () => {
  const f = await outdatedFixture();
  try {
    f.manager.setEmergency(true);
    const reads = f.statusReads(), jobs = f.work.length;
    await assert.rejects(f.manager.updateCatalog(), /ASSET_CACHE_EMERGENCY/);
    await assert.rejects(f.manager.downloadMissing(), /ASSET_CACHE_EMERGENCY/);
    assert.equal(f.catalogUpdates.length, 0);
    assert.equal(f.statusReads(), reads);
    f.manager.setEmergency(false);
    assert.equal(f.work.length, jobs);
    assert.equal(f.manager.getState().emergency, false);
  } finally { f.manager.destroy(); }
});

test('an explicit emergency refusal is distinct from owner-disabled downloads and preserves the pin', async () => {
  for (const code of ['ASSET_CACHE_EMERGENCY', 'SERVER_EMERGENCY']) {
    const f = await outdatedFixture();
    f.updateResponse(Response.json({ error: code }, { status: 503, headers: { 'Content-Length': '100' } }));
    try {
      await assert.rejects(f.manager.updateCatalog(), /ASSET_CACHE_EMERGENCY/);
      assert.equal(f.manager.getState().version, catalog.version);
      assert.equal(f.catalogUpdates.length, 1);
    } finally { f.manager.destroy(); }
  }
});

test('persistence invokes the API during the click and reports the granted storage state', async () => {
  let granted = false, calls = 0;
  const f = fixture({ storage: { persist() { calls++; granted = true; return Promise.resolve(true); },
    persisted: async () => granted } });
  const changes = [];
  f.manager.subscribe((state) => changes.push(state.persistence));
  try {
    assert.equal(f.manager.getState().storage.persistenceSupported, true);
    const pending = f.manager.requestPersistence();
    assert.equal(calls, 1, 'persist() must run before requestPersistence() returns to retain user activation');
    assert.equal(f.manager.getState().persistence, 'requesting');
    assert.equal(await pending, true);
    assert.equal(f.manager.getState().persistence, 'granted');
    assert.equal(f.manager.getState().storage.persisted, true);
    assert.equal(f.manager.getState().storage.persistenceSupported, true, 'storage refresh keeps API availability');
    assert.deepEqual([changes[0], changes.at(-1)], ['requesting', 'granted']);
    assert.equal(f.catalogReads(), 0, 'requesting persistence does not start cache initialization');
    assert.equal(await f.manager.requestPersistence(), true);
    assert.equal(calls, 1, 'already persisted storage does not ask the browser again');
  } finally { f.manager.destroy(); }
});

test('browser refusal is visible, leaves cache operations usable, and allows a later request', async () => {
  let granted = false;
  const f = fixture({ storage: { persist: async () => granted, persisted: async () => granted } });
  try {
    assert.equal(await f.manager.requestPersistence(), false);
    assert.equal(f.manager.getState().persistence, 'denied');
    assert.equal(f.manager.getState().phase, 'idle');
    assert.equal(f.manager.getState().error, null);
    assert.equal(f.manager.getState().storage.persisted, false);
    granted = true;
    assert.equal(await f.manager.requestPersistence(), true);
    assert.equal(f.manager.getState().persistence, 'granted');
  } finally { f.manager.destroy(); }
});

test('missing persistence API is reported as unsupported, while cache support remains available', async () => {
  const f = fixture();
  try {
    assert.equal(f.manager.getState().supported, true);
    assert.equal(f.manager.getState().storage.persistenceSupported, false);
    assert.equal(await f.manager.requestPersistence(), false);
    assert.equal(f.manager.getState().persistence, 'unsupported');
    assert.equal((await f.manager.initialize()).phase, 'idle');
    assert.equal(f.manager.getState().storage.persistenceSupported, false);
  } finally { f.manager.destroy(); }
});

test('insecure context prevents invoking persistence even if the API exists', async () => {
  let calls = 0;
  const f = fixture({ secure: false, storage: { persist() { calls++; return true; } } });
  try {
    assert.equal(f.manager.getState().storage.persistenceSupported, false);
    assert.equal(await f.manager.requestPersistence(), false);
    assert.equal(f.manager.getState().persistence, 'unsupported');
    assert.equal(calls, 0);
  } finally { f.manager.destroy(); }
});

test('persistence exceptions are visible and a rejection does not poison the next request', async () => {
  for (const synchronous of [true, false]) {
    let fails = true;
    const f = fixture({ storage: { persist() {
      if (!fails) return false;
      if (synchronous) throw new Error('unavailable');
      return Promise.reject(new Error('unavailable'));
    } } });
    try {
      assert.equal(await f.manager.requestPersistence(), false);
      assert.equal(f.manager.getState().persistence, 'error');
      assert.equal(f.manager.getState().error, null);
      fails = false;
      assert.equal(await f.manager.requestPersistence(), false);
      assert.equal(f.manager.getState().persistence, 'denied');
    } finally { f.manager.destroy(); }
  }
});

test('concurrent persistence requests share one pending browser prompt', async () => {
  let finish, calls = 0;
  const f = fixture({ storage: { persist() { calls++; return new Promise((resolve) => { finish = resolve; }); } } });
  try {
    const first = f.manager.requestPersistence();
    const second = f.manager.requestPersistence();
    assert.equal(first, second);
    assert.equal(calls, 1);
    assert.equal(f.manager.getState().persistence, 'requesting');
    finish(false);
    assert.deepEqual(await Promise.all([first, second]), [false, false]);
    assert.equal(f.manager.getState().persistence, 'denied');
  } finally { f.manager.destroy(); }
});

test('quota inspection failure does not hide a granted persistence request', async () => {
  let persistedReads = 0;
  const f = fixture({ storage: { persist: async () => true,
    estimate: async () => { throw new Error('quota unavailable'); },
    persisted: async () => { persistedReads++; return true; } } });
  try {
    assert.equal(await f.manager.requestPersistence(), true);
    assert.equal(persistedReads, 1, 'persistence inspection still runs when quota inspection fails');
    assert.equal(f.manager.getState().persistence, 'granted');
    assert.equal(f.manager.getState().storage.persisted, true);
    assert.equal(f.manager.getState().storage.quota, 0);
  } finally { f.manager.destroy(); }
});

test('persist permission is retained without persisted inspection support', async () => {
  const f = fixture({ storage: { persist: async () => true, persisted: undefined } });
  try {
    assert.equal(await f.manager.requestPersistence(), true);
    assert.equal(f.manager.getState().persistence, 'granted');
    assert.equal(f.manager.getState().storage.persisted, true);
    assert.equal(f.manager.getState().storage.quota, 1000);
    await f.manager.initialize();
    assert.equal(f.manager.getState().storage.persisted, true, 'subsequent quota refresh cannot erase the granted permission');
  } finally { f.manager.destroy(); }
});

test('persistence inspection failure does not hide quota estimates or erase granted permission', async () => {
  const f = fixture({ storage: { persist: async () => true,
    persisted: async () => { throw new Error('inspection unavailable'); } } });
  try {
    assert.equal(await f.manager.requestPersistence(), true);
    assert.equal(f.manager.getState().storage.persisted, true);
    assert.equal(f.manager.getState().storage.quota, 1000);
    await f.manager.initialize();
    assert.equal(f.manager.getState().storage.persisted, true);
  } finally { f.manager.destroy(); }
});

test('a legacy controller is replaced by the waiting merged worker before the mutation guard', async () => {
  const f = fixture();
  try {
    await f.manager.initialize();
    const old = f.environment.navigator.serviceWorker.controller;
    old.postMessage = () => {}; // the classic /sw.js answers no messages: the old code waited 10 s and failed
    let activated = false;
    const waiting = {
      state: 'installed', _state: null, _controller: null,
      addEventListener(type, fn) { if (type === 'statechange') this._state = fn; },
      removeEventListener(type) { if (type === 'statechange') this._state = null; },
      postMessage(data, ports) {
        if (data.type === 'ASSET_CACHE_CAPABILITIES') ports[0].postMessage({ ok: true, protocol: ASSET_CACHE_SW_PROTOCOL, imported: true });
        else if (data.type === 'ASSET_CACHE_CAN_MUTATE') ports[0].postMessage({ ok: true, playing: false });
        else if (data.type === 'ASSET_CACHE_ACTIVATE') {
          activated = true;
          ports[0].postMessage({ ok: true });
          setTimeout(() => {
            this.state = 'activated';
            f.environment.navigator.serviceWorker.controller = waiting;
            f.environment.navigator.serviceWorker.removeEventListener('controllerchange');
            f._controllerListener?.();
            this._state?.();
          }, 0);
        } else ports[0].postMessage({ ok: true });
      },
    };
    f.registration.waiting = waiting;
    const originalAdd = f.environment.navigator.serviceWorker.addEventListener;
    f.environment.navigator.serviceWorker.addEventListener = (name, fn) => {
      if (name === 'controllerchange') f._controllerListener = fn;
      originalAdd(name, fn);
    };
    const result = await f.manager.clear();
    assert.equal(activated, true, 'the waiting merged worker is activated before the guard');
    assert.equal(result.phase, 'idle');
    assert.equal(f.manager.getState().error, null);
  } finally { f.manager.destroy(); }
});
