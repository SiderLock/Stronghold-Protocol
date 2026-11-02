// Targeted browser checks: no game simulation or full 14-round run is involved.
// SP_E2E=1 node --test test/asset-cache.browser.test.js (CHROME_PATH can override Edge).
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { ZipWriter, Uint8ArrayWriter, Uint8ArrayReader } from '@zip.js/zip.js';
import { assetCacheSummary } from '../shared/assetCache.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EDGE = process.env.CHROME_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const enabled = process.env.SP_E2E === '1';
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const PAGE = `<!doctype html><title>Asset cache fixture</title><link rel="icon" href="data:,">
<script type="module">
import { createAssetCacheManager } from '/js/assetCache.js';
const manager = createAssetCacheManager();
if (location.search.includes('playing=1')) manager.setPlaying(true);
window.cacheFixture = { manager, ready: manager.initialize(), state: () => manager.getState() };
</script>`;

async function zipBytes(entries, options = {}) {
  const writer = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false });
  for (const [name, bytes] of entries) await writer.add(name, new Uint8ArrayReader(Buffer.from(bytes)),
    { useWebWorkers: false, ...options });
  return Buffer.from(await writer.close());
}

async function fixture(run, { legacy = false } = {}) {
  const contents = new Map([
    ['/assets/a.png', Buffer.from('image-one')],
    ['/assets/audio/中 文.mp3', Buffer.from('1234567890')],
    ['/assets/local/spine/token/foo.skel', Buffer.from('local-token')],
  ]);
  let slow = false, failSummary = false, hashedAliases = false, legacySW = legacy, fileDelay = 0;
  const downloads = [], ordinary = [], closed = [], catalogRequests = [], catalogUpdates = [], statusRequests = [];
  // in-flight /api/asset-cache/file responses: the download worker fills the server's per-client lease in parallel
  const inFlight = { n: 0, peak: 0 };
  const catalog = () => {
    const files = [...contents].map(([url, body]) => ({ url, bytes: body.length, sha256: hash(body),
      type: url.endsWith('.png') ? 'image/png' : url.endsWith('.mp3') ? 'audio/mpeg' : 'application/octet-stream',
      aliases: url.includes('/audio/') ? ['/media/中 文'] : [] }));
    if (hashedAliases) for (const file of files) {
      const prefix = file.sha256.slice(0, 16);
      file.aliases = [file.url.replace('/assets/', `/assets/~${prefix}/`)];
      if (file.url.includes('/audio/')) for (const extension of ['', '.mp3', '.m4a', '.aac', '.ogg', '.oga', '.opus', '.wav']) {
        file.aliases.push(`/media/中 文${extension}`, `/media/~${prefix}/中 文${extension}`);
      }
    }
    return { schema: 1, version: hash(JSON.stringify({ schema: 1, files })), app: 'fixture', files, totalFiles: files.length,
      totalBytes: files.reduce((sum, item) => sum + item.bytes, 0), complete: true, missing: [] };
  };
  const legacyCatalog = legacy && catalog();
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fixture');
    if (url.pathname === '/') { res.setHeader('Content-Type', 'text/html'); res.end(PAGE); return; }
    if (url.pathname === '/legacy-bootstrap') {
      res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Legacy cache fixture</title><link rel="icon" href="data:,">'); return;
    }
    if (url.pathname === '/api/asset-cache/catalog') {
      catalogRequests.push(req.url);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(catalog())); return;
    }
    if (url.pathname === '/api/asset-cache/catalog-update') {
      catalogUpdates.push(req.url);
      if (req.headers['x-asset-cache-update'] !== 'manual' || url.searchParams.get('to') !== catalog().version) {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'ASSET_CACHE_CATALOG_VERSION_MISMATCH' })); return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(catalog())); return;
    }
    if (url.pathname === '/api/asset-cache/status') {
      statusRequests.push(req.url);
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(failSummary ? {} : { ...assetCacheSummary(catalog()),
        policy: { enabled: true, totalBps: 1000000, clientBps: 500000 } })); return;
    }
    if (url.pathname === '/api/asset-cache/file') {
      const target = url.searchParams.get('url'); const bytes = contents.get(target);
      downloads.push(target);
      inFlight.n++; inFlight.peak = Math.max(inFlight.peak, inFlight.n);
      let settled = false;
      const done = () => { if (!settled) { settled = true; inFlight.n--; } };
      res.on('finish', done); res.on('close', done);
      if (!bytes || hash(bytes) !== url.searchParams.get('hash')) { res.writeHead(409); res.end(); return; }
      res.writeHead(200, { 'Content-Length': bytes.length, 'Content-Type': catalog().files.find((f) => f.url === target).type, 'Cache-Control': 'no-store' });
      if (slow) {
        res.write(bytes.subarray(0, 1));
        const timer = setTimeout(() => res.end(bytes.subarray(1)), 5000);
        res.on('close', () => { closed.push(target); clearTimeout(timer); });
      } else if (fileDelay > 0) setTimeout(() => res.end(bytes), fileDelay);
      else res.end(bytes);
      return;
    }
    const pathname = decodeURIComponent(url.pathname);
    const asset = catalog().files.find((file) => file.url === pathname || file.aliases.includes(pathname));
    if (asset) {
      ordinary.push(pathname); res.writeHead(200, { 'Content-Type': pathname.includes('media') ? 'audio/mpeg' : 'application/octet-stream' });
      res.end(contents.get(asset.url)); return;
    }
    if (pathname === '/api/private' || pathname === '/data/fixture.json') { ordinary.push(pathname); res.end('always-network'); return; }
    const files = new Map([
      ['/asset-cache-sw.js', 'public/asset-cache-sw.js'], ['/js/assetCache.js', 'public/js/assetCache.js'],
      ['/js/asset-cache-worker.js', 'public/js/asset-cache-worker.js'], ['/shared/assetCache.js', 'shared/assetCache.js'],
      ['/vendor/zip-native.min.js', 'public/vendor/zip-native.min.js'],
    ]);
    if (!files.has(pathname)) { res.writeHead(404); res.end('missing'); return; }
    let source = path.join(ROOT, files.get(pathname));
    if (pathname === '/asset-cache-sw.js' && legacySW) source = path.join(ROOT, 'test/fixtures/asset-cache-legacy-sw.js');
    // Optional isolated baseline source for a before/after regression probe. Normal tests only use
    // checked-in sources; no Git history is required by the regression fixture itself.
    if (pathname === '/js/assetCache.js' && process.env.SP_ASSET_CACHE_TEST_MANAGER) source = process.env.SP_ASSET_CACHE_TEST_MANAGER;
    try { res.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-cache' }); res.end(await fs.readFile(source)); }
    catch { res.destroy(); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    const puppeteer = (await import('puppeteer-core')).default;
    browser = await puppeteer.launch({ executablePath: EDGE, headless: true, args: ['--no-first-run', '--no-sandbox'] });
    const problems = [];
    const page = await browser.newPage();
    page.setDefaultTimeout(15000);
    page.on('pageerror', (error) => problems.push(error.message));
    const url = `http://127.0.0.1:${server.address().port}/`;
    if (legacy) {
      await page.goto(url + 'legacy-bootstrap');
      await page.evaluate(async () => {
        await navigator.serviceWorker.register('/asset-cache-sw.js', { scope: '/', type: 'module', updateViaCache: 'none' });
        await navigator.serviceWorker.ready;
      });
      await page.waitForFunction(() => navigator.serviceWorker.controller);
      await page.evaluate(async ({ catalog, contents }) => {
        const cache = await caches.open('sp-asset-cache-v1');
        for (const entry of catalog.files) {
          const bytes = Uint8Array.from(contents.find(([url]) => url === entry.url)[1]);
          const key = new Request(location.origin + '/__sp_asset_cache__/sha256/' + entry.sha256,
            { headers: { 'X-SP-Asset-SHA256': entry.sha256, 'X-SP-Asset-Bytes': String(entry.bytes) } });
          await cache.put(key, new Response(bytes, { headers: { 'Content-Type': entry.type,
            'Content-Length': String(entry.bytes), 'X-SP-Asset-SHA256': entry.sha256 } }));
        }
        await new Promise((resolve, reject) => {
          const channel = new MessageChannel();
          channel.port1.onmessage = ({ data }) => { channel.port1.close(); data.ok ? resolve() : reject(new Error(data.error)); };
          navigator.serviceWorker.controller.postMessage({ type: 'ASSET_CACHE_PIN', catalog, playing: false }, [channel.port2]);
        });
      }, { catalog: legacyCatalog, contents: [...contents].map(([url, body]) => [url, [...body]]) });
      legacySW = false; hashedAliases = true;
    }
    await page.goto(url);
    await page.waitForFunction(() => window.cacheFixture);
    await page.evaluate(() => window.cacheFixture.ready);
    await page.waitForFunction(() => navigator.serviceWorker.controller);
    if (legacy) await page.waitForFunction(async () => !!(await navigator.serviceWorker.getRegistration())?.waiting);
    await run({ page, browser, url, contents, downloads, ordinary, problems, closed, catalog, catalogRequests, catalogUpdates,
      statusRequests, legacyCatalog, inFlight,
      setSlow: (value) => { slow = value; }, setFail: (value) => { failSummary = value; },
      setFileDelay: (value) => { fileDelay = value; },
      upgrade: () => { contents.set('/assets/a.png', Buffer.from('image-two')); } });
  } finally {
    await browser?.close();
    await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
  }
}

const opts = { skip: enabled ? false : 'set SP_E2E=1 (uses Edge)', timeout: 90000 };
const state = (page) => page.evaluate(() => window.cacheFixture.state());
const download = (page) => page.evaluate(() => window.cacheFixture.manager.downloadMissing());
async function importBytes(page, bytes) {
  return page.evaluate((data) => window.cacheFixture.manager.importZip(new File([Uint8Array.from(data)], 'assets.zip')),
    [...bytes]);
}
const importCatalog = (page, value) => page.evaluate((catalog) => window.cacheFixture.manager.importCatalog(
  new File([JSON.stringify(catalog)], 'catalog.json', { type: 'application/json' })), value);

const swCapabilities = (page) => page.evaluate(() => new Promise((resolve, reject) => {
  const channel = new MessageChannel();
  const timer = setTimeout(() => { channel.port1.close(); reject(new Error('capability probe timed out')); }, 5000);
  channel.port1.onmessage = ({ data }) => { clearTimeout(timer); channel.port1.close(); resolve(data); };
  navigator.serviceWorker.controller.postMessage({ type: 'ASSET_CACHE_CAPABILITIES' }, [channel.port2]);
}));

const cacheSnapshot = (page) => page.evaluate(async () => {
  const meta = await caches.open('sp-asset-cache-meta-v1');
  const metadata = {};
  for (const key of await meta.keys()) metadata[new URL(key.url).pathname] = await (await meta.match(key)).json();
  const content = await caches.open('sp-asset-cache-v1');
  const bodies = {};
  for (const key of await content.keys()) bodies[new URL(key.url).pathname] = await (await content.match(key)).text();
  return { metadata, bodies };
});

test('Edge caches full assets, audio aliases/ranges, reload persistence and only changed files after upgrade', opts, async () => {
  await fixture(async ({ page, contents, downloads, ordinary, upgrade, problems, catalog, catalogUpdates, catalogRequests }) => {
    assert.equal((await state(page)).supported, true); assert.equal((await state(page)).readyFiles, 0);
    assert.equal((await state(page)).phase, 'catalog-required');
    await importCatalog(page, catalog());
    assert.equal((await state(page)).readyFiles, 0, 'standalone directory import is not full precaching');
    await download(page);
    assert.equal((await state(page)).readyFiles, 3); assert.equal(downloads.length, 3);
    const bodies = await page.evaluate(async () => {
      const image = await fetch('/assets/a.png?version=something', { cache: 'no-store' });
      const sound = await fetch('/media/%E4%B8%AD%20%E6%96%87', { headers: { Range: 'bytes=2-5' }, cache: 'no-store' });
      const wrong = await fetch('/media/%E4%B8%AD%20%E6%96%87', { headers: { Range: 'bytes=30-' } });
      await fetch('/api/private'); await fetch('/data/fixture.json');
      return { image: await image.text(), sound: await sound.text(), status: sound.status,
        type: sound.headers.get('content-type'), range: sound.headers.get('content-range'), wrong: wrong.status };
    });
    assert.deepEqual(bodies, { image: 'image-one', sound: '3456', status: 206, type: 'audio/mpeg', range: 'bytes 2-5/10', wrong: 416 });
    assert.deepEqual(ordinary, ['/api/private', '/data/fixture.json']);
    await page.reload(); await page.waitForFunction(() => window.cacheFixture);
    await page.evaluate(() => window.cacheFixture.ready);
    assert.equal((await state(page)).readyFiles, 3); assert.equal(downloads.length, 3);
    upgrade();
    await page.evaluate(() => window.cacheFixture.manager.scan());
    assert.equal((await state(page)).phase, 'catalog-stale');
    assert.equal(catalogUpdates.length, 0, 'ordinary checking never fetches a stale directory');
    await download(page);
    assert.equal((await state(page)).catalogCurrent, true);
    assert.equal((await state(page)).version, catalog().version);
    assert.equal((await state(page)).readyFiles, 3);
    assert.equal(catalogUpdates.length, 1, 'explicit online filling updates the old directory first');
    assert.equal(catalogRequests.length, 0);
    assert.equal(downloads.length, 4);
    assert.equal(downloads.at(-1), '/assets/a.png');
    assert.equal(await page.evaluate(async () => (await fetch('/assets/a.png')).text()), contents.get('/assets/a.png').toString());
    assert.deepEqual(problems, []);
  });
});

test('Edge imports partial/old ZIP locally, refuses traversal, and deep verification repairs corrupt cache', opts, async () => {
  await fixture(async ({ page, contents, downloads, ordinary, problems, catalog }) => {
    await importCatalog(page, catalog());
    const entries = [...contents].map(([url, bytes]) => [url.slice(1), bytes]);
    const partial = await zipBytes([entries[0], [entries[1][0], 'wrong-data'], ['assets/obsolete.png', 'old'], ['manifest.json', '{}']]);
    await importBytes(page, partial);
    assert.equal((await state(page)).readyFiles, 1); assert.equal((await state(page)).importStats.invalid, 1);
    assert.equal(downloads.length, 0); assert.deepEqual(ordinary, []);
    const full = await zipBytes(entries);
    await importBytes(page, full);
    assert.equal((await state(page)).readyFiles, 3); assert.equal((await state(page)).importStats.reused, 1);
    assert.equal(downloads.length, 0);
    const result = await importBytes(page, await zipBytes([['assets/../attack.png', 'x']])).catch((error) => error.message);
    assert.match(result, /ASSET_CACHE_ZIP_(?:UNSAFE|INVALID)/);
    await page.evaluate(async () => {
      const cache = await caches.open('sp-asset-cache-v1');
      const key = (await cache.keys())[0]; const response = await cache.match(key);
      await cache.put(key, new Response('corrupted', { headers: response.headers }));
      await window.cacheFixture.manager.scan({ deep: true });
    });
    assert.equal((await state(page)).readyFiles, 2); assert.equal((await state(page)).scanStats.invalid, 1);
    await download(page); assert.equal((await state(page)).readyFiles, 3); assert.equal(downloads.length, 1);
    assert.deepEqual(problems, []);
  });
});

test('Edge fills the catalog with several parallel downloads (the server lease), not one file at a time', opts, async () => {
  await fixture(async ({ page, downloads, inFlight, setFileDelay }) => {
    // a real transfer has latency: give every file 150 ms so two requests can genuinely overlap
    setFileDelay(150);
    await download(page);
    assert.equal((await state(page)).readyFiles, 3);
    assert.ok(inFlight.peak >= 2, `peak in-flight downloads ${inFlight.peak} (expected the lease to be used)`);
    assert.equal(downloads.length, 3);
  });
});

test('Edge cross-tab playing guard pauses online filling, preserves files, releases locks and allows retries', opts, async () => {
  await fixture(async ({ page, browser, url, downloads, setSlow, closed, problems, catalog }) => {
    await importCatalog(page, catalog());
    const second = await browser.newPage(); await second.goto(url);
    await second.waitForFunction(() => window.cacheFixture); await second.evaluate(() => window.cacheFixture.ready);
    await second.evaluate(() => window.cacheFixture.manager.setPlaying(true));
    assert.match(await download(page).catch((error) => error.message), /ASSET_CACHE_PLAYING/);
    await second.evaluate(() => window.cacheFixture.manager.setPlaying(false));
    setSlow(true);
    const pending = download(page);
    await page.waitForFunction(() => window.cacheFixture.state().phase === 'downloading');
    assert.match(await download(second).catch((error) => error.message), /ASSET_CACHE_BUSY/);
    await second.evaluate(() => window.cacheFixture.manager.setPlaying(true));
    await pending;
    assert.equal((await state(page)).phase, 'paused');
    assert.equal((await state(page)).readyFiles, 0);
    await second.close();
    await page.evaluate(() => window.cacheFixture.manager.initialize());
    assert.equal((await state(page)).playing, false, 'closing the other playing tab releases the dialog guard');
    setSlow(false);
    await download(page);
    assert.equal((await state(page)).readyFiles, 3);
    // Pausing aborts the in-flight requests. Downloads run in parallel now (bounded by the server's per-client lease,
    // 2 here: the mock's status carries no maxDownloadsPerClient), so up to that many connections may be cut.
    assert.ok(downloads.length >= 3); assert.ok(closed.length <= 2, `closed ${closed.length} connections on pause`);
    assert.deepEqual(problems, []);
  });
});

test('Edge cold browser can fetch the online directory and fill assets, then reload without repeated scans', opts, async () => {
  await fixture(async ({ page, url, downloads, ordinary, catalogRequests, statusRequests, problems }) => {
    await download(page);
    assert.equal((await state(page)).phase, 'ready'); assert.equal((await state(page)).readyFiles, 3);
    assert.equal(catalogRequests.length, 1, 'cold online fill fetches the directory explicitly');
    assert.equal(downloads.length, 3); assert.deepEqual(ordinary, []);
    const before = statusRequests.length;
    await page.evaluate(async () => { for (let i = 0; i < 20; i++) await window.cacheFixture.manager.initialize(); });
    assert.equal(statusRequests.length, before, 'reopening sends only local SW messages');
    await page.goto(url + '?playing=1');
    await page.waitForFunction(() => window.cacheFixture); await page.evaluate(() => window.cacheFixture.ready);
    assert.equal((await state(page)).readyFiles, 3); assert.equal((await state(page)).playing, true);
    assert.equal(await page.evaluate(async () => (await fetch('/assets/a.png')).text()), 'image-one');
    assert.deepEqual(ordinary, []); assert.deepEqual(problems, []);
  });
});

test('Edge invalid, stale and missing ZIP directories cannot bootstrap or write assets; a summary failure can be retried locally', opts, async () => {
  await fixture(async ({ page, contents, catalog, setFail, downloads, ordinary }) => {
    const entry = [...contents].map(([url, bytes]) => [url.slice(1), bytes])[0];
    assert.match(await importBytes(page, await zipBytes([entry])).catch((error) => error.message), /ASSET_CACHE_CATALOG_REQUIRED/);
    const changed = catalog(); changed.files[0].sha256 = '0'.repeat(64);
    assert.match(await importCatalog(page, changed).catch((error) => error.message), /ASSET_CACHE_BAD_CATALOG/);
    const stale = catalog(); stale.files[0].url = '/assets/other.png';
    stale.version = hash(JSON.stringify({ schema: stale.schema, files: stale.files }));
    assert.match(await importBytes(page, await zipBytes([entry, ['manifest.json', JSON.stringify(stale)]])).catch((error) => error.message), /ASSET_CACHE_STALE_CATALOG/);
    assert.equal((await state(page)).hasCatalog, false);
    assert.equal(await page.evaluate(async () => (await (await caches.open('sp-asset-cache-v1')).keys()).length), 0);
    setFail(true);
    assert.match(await importCatalog(page, catalog()).catch((error) => error.message), /ASSET_CACHE_CATALOG_UNAVAILABLE/);
    setFail(false); await importCatalog(page, catalog());
    assert.equal((await state(page)).catalogCurrent, true); assert.equal((await state(page)).readyFiles, 0);
    assert.deepEqual(downloads, []); assert.deepEqual(ordinary, []);
  });
});

test('Edge legacy cache SW migrates a 17-alias directory without closing tabs or redownloading unchanged contents', opts, async () => {
  await fixture(async ({ page, browser, url, downloads, ordinary, problems, catalog, legacyCatalog, catalogUpdates, catalogRequests }) => {
    assert.equal((await state(page)).readyFiles, 3);
    assert.equal((await state(page)).catalogCurrent, false);
    assert.equal(catalog().files.find((entry) => entry.url.includes('/audio/')).aliases.length, 17);
    assert.deepEqual(await swCapabilities(page), { ok: false, error: 'ASSET_CACHE_BAD_MESSAGE' });
    const second = await browser.newPage();
    await second.goto(url); await second.waitForFunction(() => window.cacheFixture);
    await second.evaluate(() => window.cacheFixture.ready);
    const before = await cacheSnapshot(page);
    await page.evaluate(() => window.cacheFixture.manager.updateCatalog());
    const next = await state(page);
    assert.equal(next.version, catalog().version); assert.equal(next.catalogCurrent, true);
    assert.equal(next.readyFiles, 3); assert.equal(next.missingFiles, 0);
    const capabilities = await swCapabilities(page);
    assert.equal(capabilities.ok, true); assert.equal(capabilities.protocol, 1); assert.equal(capabilities.imported, true);
    assert.equal(await second.evaluate(() => window.cacheFixture.state().version), legacyCatalog.version,
      'activation must preserve the other page\'s pinned catalog');
    const after = await cacheSnapshot(page);
    assert.deepEqual(after.bodies, before.bodies, 'SW replacement and catalog adoption retain verified bytes');
    assert.deepEqual(Object.keys(after.metadata).sort(), [...Object.keys(before.metadata),
      '/__sp_asset_cache__/catalog/' + catalog().version].sort(), 'old catalogs and all page pins survive activation');
    const pins = Object.entries(after.metadata).filter(([url]) => url.startsWith('/__sp_asset_cache__/pin/'));
    assert.equal(pins.filter(([, pin]) => pin.version === catalog().version).length, 1);
    assert.equal(pins.filter(([, pin]) => pin.version === legacyCatalog.version).length, pins.length - 1);
    const audio = catalog().files.find((entry) => entry.url.includes('/audio/'));
    const hashed = audio.aliases.find((url) => url.startsWith('/media/~') && url.endsWith('.mp3'));
    assert.equal(await page.evaluate(async (url) => (await fetch(url, { cache: 'no-store' })).text(), hashed), '1234567890');
    assert.equal(catalogUpdates.length, 1); assert.equal(catalogRequests.length, 0);
    assert.deepEqual(downloads, []); assert.deepEqual(ordinary, []); assert.deepEqual(problems, []);
    await second.close();
  }, { legacy: true });
});

test('Edge legacy SW upgrade is blocked by a playing tab without changing catalog pins or fetching a directory', opts, async () => {
  await fixture(async ({ page, browser, url, downloads, problems, catalogRequests, catalogUpdates }) => {
    const second = await browser.newPage();
    await second.goto(url); await second.waitForFunction(() => window.cacheFixture);
    await second.evaluate(() => window.cacheFixture.ready);
    await second.evaluate(() => window.cacheFixture.manager.setPlaying(true));
    const before = await cacheSnapshot(page);
    assert.match(await page.evaluate(() => window.cacheFixture.manager.updateCatalog()).catch((error) => error.message), /ASSET_CACHE_PLAYING/);
    assert.deepEqual(await cacheSnapshot(page), before);
    const refused = await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration();
      return new Promise((resolve, reject) => {
        const channel = new MessageChannel();
        const timer = setTimeout(() => { channel.port1.close(); reject(new Error('activation probe timed out')); }, 5000);
        channel.port1.onmessage = ({ data }) => { clearTimeout(timer); channel.port1.close(); resolve(data); };
        registration.waiting.postMessage({ type: 'ASSET_CACHE_ACTIVATE' }, [channel.port2]);
      });
    });
    assert.deepEqual(refused, { ok: false, error: 'ASSET_CACHE_PLAYING' });
    assert.deepEqual(await swCapabilities(page), { ok: false, error: 'ASSET_CACHE_BAD_MESSAGE' });
    assert.deepEqual(await cacheSnapshot(page), before);
    assert.equal(catalogRequests.length, 0); assert.equal(catalogUpdates.length, 0);
    assert.deepEqual(downloads, []); assert.deepEqual(problems, []);
    await second.evaluate(() => window.cacheFixture.manager.setPlaying(false));
    await second.close();
  }, { legacy: true });
});

test('Edge cleared old cache can explicitly acquire the current directory or refill without requiring old contents', opts, async () => {
  for (const action of ['downloadCatalog', 'downloadMissing']) {
    await fixture(async ({ page, catalog, catalogRequests, catalogUpdates, downloads, problems }) => {
      await page.evaluate(() => window.cacheFixture.manager.clear());
      assert.equal((await state(page)).readyFiles, 0);
      assert.equal((await state(page)).catalogCurrent, false);
      await page.evaluate((action) => window.cacheFixture.manager[action](), action);
      assert.equal((await state(page)).version, catalog().version);
      assert.equal((await state(page)).catalogCurrent, true);
      assert.equal(catalogRequests.length, 1, 'empty old contents use the explicit full-catalog acquisition route');
      assert.equal(catalogUpdates.length, 0, 'empty reports never enter the stale-update route');
      if (action === 'downloadCatalog') {
        assert.equal((await state(page)).readyFiles, 0, 'directory acquisition does not download art');
        assert.deepEqual(downloads, []);
        await download(page);
      }
      assert.equal((await state(page)).readyFiles, 3);
      assert.equal(downloads.length, 3); assert.deepEqual(problems, []);
    }, { legacy: true });
  }
});
