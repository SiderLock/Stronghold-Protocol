// Two isolated browser clients, real Worker/SW/cache and the actual shared HTTP limiter. No game or production data.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { CacheDownloadLimiter } from '../server/http/cacheLimiter.js';
import { assetCacheSummary } from '../shared/assetCache.js';

test('Edge: a stalled client cannot block another; timeout recovers the same page and leaves no shared slots', {
  skip: process.env.SP_E2E !== '1', timeout: 60000,
}, async t => {
  const out = await fs.mkdtemp(path.resolve('.cache/asset-transfer-edge-'));
  const contents = new Map([['/assets/a.png', Buffer.from('aa')], ['/assets/b.png', Buffer.from('bbb')], ['/assets/c.png', Buffer.from('cccc')]]);
  const files = [...contents].map(([url, body]) => ({ url, bytes: body.length,
    sha256: createHash('sha256').update(body).digest('hex'), type: 'image/png', aliases: [] }));
  const catalog = { schema: 1, version: createHash('sha256').update(JSON.stringify({ schema: 1, files })).digest('hex'),
    app: 'fixture', files, totalFiles: files.length, totalBytes: 9, complete: true, missing: [] };
  const limiter = new CacheDownloadLimiter({ maxDownloadsPerClient: 1 });
  const calls = [], requests = [], problems = []; let stalled = null, finishRead, broken = false;
  const hung = new Promise(resolve => { finishRead = resolve; });
  const sources = new Map([
    ['/js/assetCache.js', 'public/js/assetCache.js'], ['/js/asset-cache-worker.js', 'public/js/asset-cache-worker.js'],
    ['/asset-cache-sw.js', 'public/asset-cache-sw.js'], ['/shared/assetCache.js', 'shared/assetCache.js'],
    ['/vendor/zip-native.min.js', 'public/vendor/zip-native.min.js'],
  ]);
  const server = http.createServer(async (req, res) => {
    try {
      const u = new URL(req.url, 'http://fixture');
      if (u.pathname === '/') {
        res.setHeader('Content-Type', 'text/html');
        res.end(`<!doctype html><title>Asset transfer recovery</title><link rel="icon" href="data:"><script type="module">
          import {createAssetCacheManager} from '/js/assetCache.js';
          window.manager = createAssetCacheManager({workerURL:'/js/asset-cache-worker.js?client='+new URLSearchParams(location.search).get('client')});
          window.identity = crypto.randomUUID(); window.ready = manager.initialize();
          </script>`); return;
      }
      if (u.pathname === '/api/asset-cache/status') {
        res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ...assetCacheSummary(catalog), policy: limiter.policy() })); return;
      }
      if (u.pathname === '/api/asset-cache/file') {
        const client = String(req.headers['x-test-client']), target = u.searchParams.get('url'), body = contents.get(target);
        const lease = limiter.acquire(client, res);
        requests.push({ client, target, admitted: !!lease });
        if (!lease) { res.writeHead(429, { 'Retry-After': '1' }); res.end(); return; }
        calls.push({ client, target });
        res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': body.length });
        if (client === 'a' && target === '/assets/a.png' && (!stalled || broken)) {
          if (!stalled) stalled = res;
          lease.stream({ read: async buffer => { await hung; body.copy(buffer); return { bytesRead: body.length }; } }, res, body.length);
        } else lease.streamBuffer(body, res);
        return;
      }
      const file = sources.get(u.pathname);
      if (!file) { res.writeHead(404); res.end(); return; }
      let source = await fs.readFile(file, 'utf8');
      // Speed up only this fixture's 60-second client deadline; production defaults remain unchanged.
      if (u.pathname === '/shared/assetCache.js') source = source.replace('timeoutMs = 60000', 'timeoutMs = 1500');
      if (u.pathname === '/js/asset-cache-worker.js') source = `const nativeFetch = fetch;
        globalThis.fetch = (url, options = {}) => nativeFetch(url, {...options, headers: {...options.headers, 'X-Test-Client': ${JSON.stringify(u.searchParams.get('client'))}}});\n` + source;
      res.setHeader('Content-Type', 'application/javascript'); res.setHeader('Cache-Control', 'no-cache'); res.end(source);
    } catch (error) { problems.push(error.message); res.destroy(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const puppeteer = (await import('puppeteer-core')).default;
  let browser;
  try {
    browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
      headless: true, args: ['--no-first-run', '--no-sandbox'] });
    const pages = [];
    for (const client of ['a', 'b']) {
      const context = await browser.createBrowserContext(), page = await context.newPage();
      page.on('pageerror', e => problems.push(e.message)); await page.setExtraHTTPHeaders({ 'X-Test-Client': client });
      await page.goto(`http://127.0.0.1:${server.address().port}/?client=${client}`);
      await page.waitForFunction(() => window.ready); await page.evaluate(() => window.ready);
      await page.waitForFunction(() => !!navigator.serviceWorker.controller);
      await page.evaluate(c => window.manager.importCatalog(new File([JSON.stringify(c)], 'catalog.json', { type: 'application/json' })), catalog);
      pages.push(page);
    }
    const identity = await pages[0].evaluate(() => window.identity);
    await pages[0].evaluate(() => { window.download = window.manager.downloadMissing(); });
    for (let i = 0; i < 100 && !stalled; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(stalled, JSON.stringify(calls));
    await pages[1].evaluate(() => window.manager.downloadMissing());
    assert.equal((await pages[1].evaluate(() => window.manager.getState())).readyFiles, 3);
    assert.equal(stalled.destroyed, false, 'client B finishes before client A times out');
    await pages[0].evaluate(() => window.download);
    const state = await pages[0].evaluate(() => window.manager.getState());
    assert.equal(state.readyFiles, 3); assert.equal(state.phase, 'ready');
    assert.equal(await pages[0].evaluate(() => window.identity), identity, 'the page never reloaded');
    assert.equal(stalled.destroyed, true); assert.equal(limiter.policy().activeDownloads, 0);
    assert.deepEqual(calls.filter(x => x.client === 'a').map(x => x.target), ['/assets/a.png', '/assets/b.png', '/assets/c.png', '/assets/a.png']);
    broken = true;
    await pages[0].evaluate(() => window.manager.clear());
    const failure = await pages[0].evaluate(() => window.manager.downloadMissing().then(() => null, e => e.code));
    assert.equal(failure, 'ASSET_CACHE_DOWNLOAD_FAILED');
    assert.equal((await pages[0].evaluate(() => window.manager.getState())).readyFiles, 2);
    const beforeRetry = calls.length;
    broken = false;
    await pages[0].evaluate(() => window.manager.downloadMissing());
    assert.equal((await pages[0].evaluate(() => window.manager.getState())).readyFiles, 3);
    assert.equal(await pages[0].evaluate(() => window.identity), identity, 'manual retry also keeps the original page');
    assert.deepEqual(calls.slice(beforeRetry), [{ client: 'a', target: '/assets/a.png' }], 'retry keeps both healthy cached files');
    assert.equal(limiter.policy().activeDownloads, 0);
    assert.deepEqual(problems, []);
    finishRead(); await new Promise(resolve => setImmediate(resolve));
    await fs.writeFile(path.join(out, 'report.json'), JSON.stringify({ calls, requests, identityPreserved: true, partialRetryWithoutReload: true,
      activeDownloads: limiter.policy().activeDownloads, problems }, null, 2));
    t.diagnostic(out);
  } finally {
    finishRead(); await browser?.close(); limiter.close();
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  }
});
