// Real Edge + app/Worker/SW/WebSocket checks. Never runs a full 14-round game.
// SP_E2E=1 enables the tiny fixture; SP_REAL_ASSET_E2E=1 additionally imports a locally supplied full ZIP.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { ZipWriter, Uint8ArrayWriter, Uint8ArrayReader } from '@zip.js/zip.js';
import { startServer } from '../server/index.js';
import { StubMatch } from '../server/match/StubMatch.js';
import { writeServerSettings } from '../server/serverSettings.js';
import { TestClient } from './helpers/wsClient.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, '.cache', 'asset-cache-admission-ui');
const EDGE = process.env.CHROME_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const contents = new Map([['/assets/admission-fixture.png', Buffer.from('image')],
  ['/assets/audio/admission-fixture.mp3', Buffer.from('sound')]]);
const files = [...contents].map(([url, body]) => ({ url, bytes: body.length, sha256: hash(body),
  type: url.endsWith('.png') ? 'image/png' : 'audio/mpeg', aliases: url.endsWith('.mp3') ? ['/media/admission-fixture'] : [] }));
const catalog = { schema: 1, version: hash(JSON.stringify({ schema: 1, files })), app: 'browser fixture', files,
  totalFiles: files.length, totalBytes: files.reduce((sum, file) => sum + file.bytes, 0), complete: true, missing: [] };
const create = { t: 'room.create', mode: 'coop', difficulty: 'NORMAL', capacity: 20 };
const state = (page) => page.evaluate(() => window.admissionFixture.cache.getState());
const request = (page, { t: type, ...fields }) => page.evaluate(async (type, fields) => {
  try { return await window.admissionFixture.net.request(type, fields); }
  catch (error) { return { t: 'error', code: error.code, message: error.message }; }
}, type, fields);

async function fixture(t, real = false, reportName = 'report.json') {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sp-admission-edge-'));
  const report = { browser: '', directoryRequests: 0, manualDirectoryRequests: 0, fillRequests: 0, statusRequests: 0, ordinaryRequests: 0, layouts: [], cleanup: {} };
  let server, browser, page;
  const clients = [], errors = [];
  t.after(async () => {
    if (page && !page.isClosed()) {
      report.screen = await page.evaluate(async () => {
        const { store } = await import('/js/store.js');
        const { net } = await import('/js/net.js');
        return { entered: store.get().session.entered, connection: net.status, body: document.body.innerText.slice(0, 1200) };
      }).catch((error) => ({ error: error.message }));
    }
    await Promise.all(clients.map((client) => client.terminate()));
    if (browser) { await browser.close(); report.cleanup.browserClosed = true; }
    if (server) { await server.close(); report.cleanup.serverClosed = !server.server.listening; }
    report.errors = errors;
    await fs.mkdir(OUT, { recursive: true });
    await fs.writeFile(path.join(OUT, real ? 'real-pack-report.json' : reportName), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    assert.equal(path.dirname(dir), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith('sp-admission-edge-'));
    await fs.rm(dir, { recursive: true, force: true });
  });
  await fs.mkdir(OUT, { recursive: true });
  writeServerSettings(dir, { maxAiPerRoom: null, requireAssetCache: true });
  server = await startServer({ port: 0, host: '127.0.0.1', quiet: true, MatchClass: StubMatch,
    serverSettingsDir: dir, announcementsDir: path.join(dir, 'announcements'),
    ...(real ? {} : { assetCacheBuildCatalog: async () => catalog }) });
  server.server.on('request', (req) => {
    if (req.url.split('?')[0] === '/api/asset-cache/catalog') report.directoryRequests++;
    if (req.url.split('?')[0] === '/api/asset-cache/catalog-update') report.manualDirectoryRequests++;
    if (req.url.startsWith('/api/asset-cache/file')) report.fillRequests++;
    if (req.url.startsWith('/api/asset-cache/status')) report.statusRequests++;
    if (/^\/(?:assets|fonts|media)\//.test(req.url)) report.ordinaryRequests++;
  });
  const puppeteer = (await import('puppeteer-core')).default;
  browser = await puppeteer.launch({ executablePath: EDGE, headless: true, args: ['--no-first-run', '--no-sandbox'] });
  report.browser = await browser.version();
  page = await browser.newPage();
  page.setDefaultTimeout(15000);
  page.setDefaultNavigationTimeout(30000);
  await page.setViewport({ width: 1920, height: 1080 });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(server.url, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.title-login input');
  await page.type('.title-login input', '预缓存验证博士');
  await page.waitForFunction(() => !document.querySelector('.title-login > .btn--primary').disabled);
  await page.click('.title-login > .btn--primary');
  await page.waitForSelector('.lobby-screen');
  await page.evaluate(async () => {
    const { Net } = await import('/js/net.js');
    const { assetCache } = await import('/js/assetCache.js');
    await assetCache.initialize();
    let token = null;
    const net = new Net({ getToken: () => token,
      getAssetCacheReadiness: () => assetCache.getState().supported ? assetCache.admission() : null });
    window.admissionFixture = { cache: assetCache, net, welcome: null };
    net.on('welcome', (message) => { token = message.token; window.admissionFixture.welcome = message; });
    net.setName('准入连接验证');
  });
  await page.waitForFunction(() => window.admissionFixture.net.status === 'online' && navigator.serviceWorker.controller);
  const policy = (required) => {
    writeServerSettings(dir, { requireAssetCache: required });
    server.serverSettings.poll();
  };
  const connect = async (name) => {
    const client = await TestClient.connect(`ws://127.0.0.1:${server.port}/ws`, { wire: true });
    clients.push(client);
    await client.hello(name);
    return client;
  };
  return { dir, page, server, report, errors, policy, connect };
}

test('Edge strict admission follows actual imported contents, eviction, hot policy and resume; no online directory', {
  skip: process.env.SP_E2E === '1' ? false : 'set SP_E2E=1 (uses Edge)', timeout: 90000,
}, async (t) => {
  const { dir, page, server, report, errors, policy, connect } = await fixture(t);
  const host = await connect('Target');
  const ready = { schema: 1, version: catalog.version, readyFiles: catalog.totalFiles, readyBytes: catalog.totalBytes };
  assert.equal((await host.request({ ...create, assetCache: ready })).t, 'ok');
  const room = await host.waitFor('room.state');
  const intents = [create, { t: 'room.join', code: room.code }, { t: 'lobby.quickMatch', capacity: 20 },
    { t: 'room.spectate', code: room.code }];
  for (const intent of intents) assert.equal((await request(page, intent)).code, 'ASSET_CACHE_REQUIRED');
  await page.click('[data-testid="asset-cache-open"]');
  await page.waitForSelector('.asset-cache-dialog');
  assert.match(await page.$eval('.asset-cache-dialog', (el) => el.innerText), /服主要求完整预缓存/);
  assert.match(await page.$eval('.asset-cache-dialog', (el) => el.innerText), /完整的资源包将包含目录 JSON，无需单独导入/);
  assert.equal(await page.$eval('[data-testid="asset-cache-download"]', (el) => el.innerText), '在线补齐缺项（限速）');
  assert.equal(await page.$('[data-testid="asset-cache-catalog-update"]'), null, 'a cold browser cannot update a directory online');
  assert.equal(await page.$eval('[data-testid="asset-cache-catalog-status"]', (el) => el.innerText), '本地目录：未导入');
  assert.equal(await page.$('[data-testid="asset-cache-local-version"]'), null);
  assert.equal(await page.$eval('[data-testid="asset-cache-server-version"]', (el) => el.innerText), catalog.version);
  for (const viewport of [{ width: 1920, height: 1080 }, { width: 1280, height: 720 }]) {
    await page.setViewport(viewport);
    const bounds = await page.$eval('.asset-cache-dialog', (el) => {
      const box = el.getBoundingClientRect(), body = el.querySelector('.modal__body');
      return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, overflow: body.scrollWidth > body.clientWidth + 2 };
    });
    assert.ok(bounds.left >= 0 && bounds.right <= viewport.width && bounds.top >= 0 && bounds.bottom <= viewport.height);
    assert.equal(bounds.overflow, false);
    report.layouts.push({ ...viewport, ...bounds });
    await page.screenshot({ path: path.join(OUT, `strict-${viewport.width}.png`) });
  }
  const jsonFile = path.join(dir, 'catalog.json');
  await fs.writeFile(jsonFile, JSON.stringify(catalog), 'utf8');
  await (await page.$('[data-testid="asset-cache-catalog-file"]')).uploadFile(jsonFile);
  await page.waitForFunction(() => window.admissionFixture.cache.getState().hasCatalog);
  assert.equal((await state(page)).readyFiles, 0);
  await page.waitForFunction(() => document.querySelector('[data-testid="asset-cache-catalog-status"]')?.innerText.includes('已匹配服务器'));
  assert.equal(await page.$eval('[data-testid="asset-cache-local-version"]', (el) => el.innerText), catalog.version);
  assert.equal(await page.$eval('[data-testid="asset-cache-server-version"]', (el) => el.innerText), catalog.version);
  for (const viewport of [{ width: 1280, height: 720 }, { width: 844, height: 390 }, { width: 640, height: 360 }]) {
    await page.setViewport(viewport);
    const bounds = await page.$eval('.asset-cache-dialog', (el) => {
      const box = el.getBoundingClientRect(), body = el.querySelector('.modal__body');
      const versions = [...el.querySelectorAll('.asset-cache__catalog code')].map((code) => {
        const rect = code.getBoundingClientRect(); return { left: rect.left, right: rect.right };
      });
      return { left: box.left, right: box.right, overflow: body.scrollWidth > body.clientWidth + 2, versions,
        rotateHint: getComputedStyle(document.querySelector('.rotate-hint')).display !== 'none' };
    });
    assert.equal(bounds.overflow, false, 'full catalog hashes wrap on a narrow screen');
    assert.equal(bounds.rotateHint, false, 'test the supported landscape layout without a portrait blocker');
    for (const version of bounds.versions) {
      assert.ok(version.left >= bounds.left && version.right <= bounds.right);
    }
    report.layouts.push({ screen: 'catalog-versions', ...viewport, ...bounds });
    await page.screenshot({ path: path.join(OUT, `catalog-${viewport.width}.png`) });
  }
  await page.setViewport({ width: 1280, height: 720 });
  for (const intent of intents) assert.equal((await request(page, intent)).code, 'ASSET_CACHE_REQUIRED', 'directory alone grants no admission');
  const writer = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false });
  await writer.add('manifest.json', new Uint8ArrayReader(Buffer.from(JSON.stringify(catalog))), { useWebWorkers: false });
  for (const [url, bytes] of contents) await writer.add(url.slice(1), new Uint8ArrayReader(bytes), { useWebWorkers: false });
  const zipFile = path.join(dir, 'assets.zip');
  await fs.writeFile(zipFile, await writer.close());
  await (await page.$('input[type="file"][accept^=".zip"]')).uploadFile(zipFile);
  await page.waitForFunction((total) => {
    const cached = window.admissionFixture.cache.getState();
    return cached.readyFiles === total && cached.phase === 'ready';
  }, {}, catalog.totalFiles);
  for (const intent of intents) {
    assert.equal((await request(page, intent)).t, 'ok', intent.t);
    assert.equal((await request(page, { t: 'room.leave' })).t, 'ok');
  }
  const summaryCount = report.statusRequests;
  for (let index = 0; index < 5; index++) {
    await page.keyboard.press('Escape');
    await page.waitForSelector('.asset-cache-dialog', { hidden: true });
    await page.click('[data-testid="asset-cache-open"]');
    await page.waitForSelector('.asset-cache-dialog');
  }
  for (let index = 0; index < 15; index++) {
    await page.evaluate(() => window.admissionFixture.cache.initialize());
  }
  assert.equal(report.statusRequests, summaryCount, 'reopening management does not re-request even the tiny summary');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.lobby-screen');
  const persisted = await page.evaluate(async () => {
    const { assetCache } = await import('/js/assetCache.js');
    await assetCache.initialize();
    return assetCache.admission();
  });
  assert.deepEqual(persisted, ready, 'local directory and actual cache survive reload');
  await page.evaluate(async () => {
    const { Net } = await import('/js/net.js');
    const { assetCache } = await import('/js/assetCache.js');
    const net = new Net({ getAssetCacheReadiness: () => assetCache.admission() });
    window.admissionFixture = { cache: assetCache, net, welcome: null };
    let token = null;
    net.getToken = () => token;
    net.on('welcome', (message) => { token = message.token; window.admissionFixture.welcome = message; });
    net.setName('准入刷新验证');
  });
  await page.waitForFunction(() => window.admissionFixture.net.status === 'online');
  await page.evaluate(() => window.admissionFixture.cache.clear());
  await page.click('[data-testid="asset-cache-open"]');
  await page.waitForSelector('.asset-cache-dialog');
  assert.equal(await page.$eval('[data-testid="asset-cache-catalog-status"]', (el) => el.innerText), '本地目录：已导入，已匹配服务器');
  assert.equal(await page.$eval('[data-testid="asset-cache-local-version"]', (el) => el.innerText), catalog.version);
  assert.equal((await state(page)).readyFiles, 0, 'clearing assets preserves the directory without claiming readiness');
  await page.keyboard.press('Escape');
  await page.waitForSelector('.asset-cache-dialog', { hidden: true });
  assert.equal((await request(page, create)).code, 'ASSET_CACHE_REQUIRED', 'eviction is rechecked before entering');
  policy(false);
  assert.equal((await request(page, create)).t, 'ok');
  assert.equal((await request(page, { t: 'room.start' })).t, 'ok');
  const before = await page.evaluate(() => window.admissionFixture.welcome.playerId);
  policy(true);
  await page.evaluate(() => window.admissionFixture.net.reconnectNow());
  await page.waitForFunction(() => window.admissionFixture.welcome?.resumed === true);
  const resumed = await page.evaluate(() => window.admissionFixture.welcome);
  assert.equal(resumed.playerId, before);
  assert.equal(resumed.requireAssetCache, true);
  assert.ok(server.lobby.roomOf(server.registry.byId(before)).match);
  assert.equal(report.directoryRequests, 0);
  assert.equal(report.manualDirectoryRequests, 0, 'scan, import, verify and reopening never request an online catalog');
  assert.equal(report.fillRequests, 0, 'local ZIP import does not secretly trigger online fills');
  assert.deepEqual(errors, []);
  report.result = 'passed';
});

test('Edge displays a restored stale local catalog and distinguishes a failed server check', {
  skip: process.env.SP_E2E === '1' ? false : 'set SP_E2E=1 (uses Edge)', timeout: 60000,
}, async (t) => {
  const { page, report, errors } = await fixture(t, false, 'catalog-status-report.json');
  const oldFiles = files.map((file, index) => index ? file : { ...file, sha256: hash('old image'), bytes: 9 });
  const oldCatalog = { ...catalog, files: oldFiles,
    version: hash(JSON.stringify({ schema: 1, files: oldFiles })), totalBytes: 14 };
  // Simulate a directory persisted by the previous deployment, rather than importing a currently rejected version.
  await page.evaluate(async (local) => {
    const meta = await caches.open('sp-asset-cache-meta-v1');
    await meta.put('/__sp_asset_cache__/latest', new Response(JSON.stringify({ version: local.version })));
    await meta.put(`/__sp_asset_cache__/catalog/${local.version}`, new Response(JSON.stringify(local)));
  }, oldCatalog);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.lobby-screen');
  await page.click('[data-testid="asset-cache-open"]');
  await page.waitForFunction(() => document.querySelector('[data-testid="asset-cache-catalog-status"]')?.innerText.includes('与服务器版本不符'));
  assert.equal(await page.$eval('[data-testid="asset-cache-local-version"]', (el) => el.innerText), oldCatalog.version);
  assert.equal(await page.$eval('[data-testid="asset-cache-server-version"]', (el) => el.innerText), catalog.version);
  assert.equal(await page.$('[data-testid="asset-cache-catalog-update"]'), null, 'a persisted directory without cached assets cannot update online');
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    if (new URL(req.url()).pathname === '/api/asset-cache/status') return req.respond({ status: 503, body: 'offline' });
    return req.continue();
  });
  await page.evaluate(async () => {
    const { assetCache } = await import('/js/assetCache.js');
    await assetCache.scan({ deep: false }).catch(() => {});
  });
  await page.waitForFunction(() => document.querySelector('[data-testid="asset-cache-catalog-status"]')?.innerText.includes('等待服务器校验'));
  assert.equal(await page.$eval('[data-testid="asset-cache-local-version"]', (el) => el.innerText), oldCatalog.version);
  assert.equal(report.directoryRequests, 0);
  assert.equal(report.fillRequests, 0);
  assert.deepEqual(errors, []);
  report.result = 'passed';
});

test('Edge explicitly updates an old directory once, reuses assets and admits only after a current delta import', {
  skip: process.env.SP_E2E === '1' ? false : 'set SP_E2E=1 (uses Edge)', timeout: 90000,
}, async (t) => {
  const { dir, page, report, errors } = await fixture(t, false, 'manual-catalog-report.json');
  const oldFiles = files.map((file, index) => index ? file : { ...file, sha256: hash('old image'), bytes: 9 });
  const oldCatalog = { ...catalog, files: oldFiles,
    version: hash(JSON.stringify({ schema: 1, files: oldFiles })), totalBytes: 14 };
  // This is a real previous-install state: its complete directory and old, hash-addressed contents.
  await page.evaluate(async (local) => {
    const { assetContentKey, validatedCacheHeaders } = await import('/shared/assetCache.js');
    const meta = await caches.open('sp-asset-cache-meta-v1');
    await meta.put('/__sp_asset_cache__/latest', new Response(JSON.stringify({ version: local.version })));
    await meta.put(`/__sp_asset_cache__/catalog/${local.version}`, new Response(JSON.stringify(local)));
    const assets = await caches.open('sp-asset-cache-v1');
    for (const [index, body] of ['old image', 'sound'].entries()) {
      const entry = local.files[index];
      const key = new Request(location.origin + assetContentKey(entry.sha256), { headers: {
        'X-SP-Asset-SHA256': entry.sha256, 'X-SP-Asset-Bytes': String(entry.bytes),
      } });
      await assets.put(key, new Response(body, { headers: validatedCacheHeaders(entry) }));
    }
  }, oldCatalog);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.lobby-screen');
  await page.evaluate(async () => {
    const { assetCache } = await import('/js/assetCache.js');
    const { net } = await import('/js/net.js');
    await assetCache.initialize();
    window.admissionFixture = { cache: assetCache, net };
  });
  assert.equal((await request(page, create)).code, 'ASSET_CACHE_REQUIRED', 'old full contents still fail strict admission');
  await page.click('[data-testid="asset-cache-open"]');
  await page.waitForSelector('[data-testid="asset-cache-catalog-update"]');
  for (const deep of [false, true]) {
    await page.evaluate((deep) => window.admissionFixture.cache.scan({ deep }).catch((error) => error.code), deep);
  }
  assert.equal(report.manualDirectoryRequests, 0, 'checking and deep verification do not silently update the catalog');
  for (const viewport of [{ width: 1280, height: 720 }, { width: 844, height: 390 }]) {
    await page.setViewport(viewport);
    const bounds = await page.$eval('.asset-cache-dialog', (el) => {
      const body = el.querySelector('.modal__body');
      return { overflow: body.scrollWidth > body.clientWidth + 2 };
    });
    assert.equal(bounds.overflow, false);
    report.layouts.push({ screen: 'manual-catalog-update', ...viewport, ...bounds });
    await page.screenshot({ path: path.join(OUT, `manual-catalog-${viewport.width}.png`) });
  }
  await page.setViewport({ width: 1280, height: 720 });
  await page.click('[data-testid="asset-cache-catalog-update"]');
  await page.waitForFunction(() => {
    const cache = window.admissionFixture.cache.getState();
    return cache.catalogCurrent && !['checking', 'updating-catalog'].includes(cache.phase);
  });
  assert.equal(report.manualDirectoryRequests, 1);
  assert.equal((await state(page)).version, catalog.version);
  assert.equal((await state(page)).readyFiles, 1, 'the unchanged audio content was reused');
  assert.equal((await request(page, create)).code, 'ASSET_CACHE_REQUIRED', 'updating only the directory grants no admission');
  assert.equal(await page.$('[data-testid="asset-cache-catalog-update"]'), null, 'an up-to-date catalog cannot be downloaded again');
  const writer = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false });
  await writer.add('manifest.json', new Uint8ArrayReader(Buffer.from(JSON.stringify(catalog))), { useWebWorkers: false });
  await writer.add(files[0].url.slice(1), new Uint8ArrayReader(contents.get(files[0].url)), { useWebWorkers: false });
  const delta = path.join(dir, 'current-delta.zip');
  await fs.writeFile(delta, await writer.close());
  await (await page.$('input[type="file"][accept^=".zip"]')).uploadFile(delta);
  await page.waitForFunction(() => window.admissionFixture.cache.getState().phase === 'ready');
  assert.equal((await state(page)).readyFiles, catalog.totalFiles);
  assert.equal((await request(page, create)).t, 'ok');
  assert.equal((await request(page, { t: 'room.leave' })).t, 'ok');
  assert.equal(report.directoryRequests, 0, 'the old unrestricted directory route stays unused');
  assert.equal(report.manualDirectoryRequests, 1, 'delta import never downloads its already embedded directory');
  assert.equal(report.fillRequests, 0, 'no automatic online asset repair');
  assert.deepEqual(errors, []);
  report.result = 'passed';
});

test('Edge imports an existing real full ZIP locally and reuses its directory and all files after reload', {
  skip: process.env.SP_REAL_ASSET_E2E === '1' ? false : 'set SP_REAL_ASSET_E2E=1 and SP_ASSET_E2E_PACK', timeout: 300000,
}, async (t) => {
  assert.ok(process.env.SP_ASSET_E2E_PACK, 'supply the existing ZIP; this test does not download or repack it');
  const pack = path.resolve(process.env.SP_ASSET_E2E_PACK);
  const { page, server, report, errors } = await fixture(t, true);
  const expected = await (await fetch(`${server.url}/api/asset-cache/status`)).json();
  assert.equal(expected.complete, true);
  assert.equal(expected.missingFiles, 0);
  const started = Date.now();
  await page.click('[data-testid="asset-cache-open"]');
  await page.waitForSelector('.asset-cache-dialog');
  await (await page.$('input[type="file"][accept^=".zip"]')).uploadFile(pack);
  const progress = setInterval(() => {
    state(page).then((value) => console.info(`[asset-cache-real-pack] ${value.readyFiles}/${value.totalFiles} files`)).catch(() => {});
  }, 10000);
  try {
    await page.waitForFunction((total) => {
      const cached = window.admissionFixture.cache.getState();
      return cached.readyFiles === total && cached.phase === 'ready';
    },
      { timeout: 240000 }, expected.totalFiles);
  } finally { clearInterval(progress); }
  const imported = await state(page);
  assert.equal(imported.readyBytes, expected.totalBytes);
  assert.equal(imported.catalogCurrent, true);
  assert.equal(imported.importStats.invalid, 0);
  const ready = { schema: expected.schema, version: expected.version, readyFiles: expected.totalFiles, readyBytes: expected.totalBytes };
  assert.deepEqual(await page.evaluate(() => window.admissionFixture.cache.admission()), ready);
  report.import = { pack: path.basename(pack), elapsedMs: Date.now() - started, ...ready, stats: imported.importStats };
  const ordinaryBefore = report.ordinaryRequests;
  report.sampledFiles = await page.evaluate(async () => {
    const meta = await caches.open('sp-asset-cache-meta-v1');
    const latest = await (await meta.match('/__sp_asset_cache__/latest')).json();
    const local = await (await meta.match(`/__sp_asset_cache__/catalog/${latest.version}`)).json();
    for (let index = 0; index < 20; index++) {
      const file = local.files[Math.floor(index * local.files.length / 20)];
      const response = await fetch(file.url, { cache: 'no-store' });
      const bytes = await response.arrayBuffer();
      const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
        .map((value) => value.toString(16).padStart(2, '0')).join('');
      if (response.status !== 200 || bytes.byteLength !== file.bytes || digest !== file.sha256) throw new Error(`bad cached sample ${file.url}`);
    }
    return 20;
  });
  assert.equal(report.ordinaryRequests, ordinaryBefore, 'the sampled real assets never reach the origin server');
  assert.equal((await request(page, create)).t, 'ok');
  await request(page, { t: 'room.leave' });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.lobby-screen');
  assert.deepEqual(await page.evaluate(async () => {
    const { assetCache } = await import('/js/assetCache.js');
    await assetCache.initialize();
    return assetCache.admission();
  }), ready);
  assert.equal(report.directoryRequests, 0);
  assert.equal(report.fillRequests, 0);
  assert.deepEqual(errors, []);
  report.result = 'passed';
  t.diagnostic(`real local ZIP: ${ready.readyFiles} files / ${ready.readyBytes} bytes; ${report.import.elapsedMs} ms`);
});
