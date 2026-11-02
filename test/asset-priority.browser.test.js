// SP_E2E=1 CHROME_PATH=<Edge> node --test test/asset-priority.browser.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { startServer } from '../server/index.js';
import { gpuArgs } from '../tools/perfbench.mjs';

const edge = process.env.CHROME_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
test('Edge: consent, first-round warmup, next-document disk reuse and separate cleanup', {
  skip: process.env.SP_E2E === '1' && existsSync(edge) && existsSync('data/local-assets.json') ? false : 'needs SP_E2E, Edge and art', timeout: 120000,
}, async () => {
  let browser, server;
  const errors = [], requests = [];
  try {
    server = await startServer({ host: '127.0.0.1', port: 0, quiet: true });
    server.server.on('request', (req) => { if (req.url.startsWith('/assets/')) requests.push(req.url); });
    const puppeteer = (await import('puppeteer-core')).default;
    browser = await puppeteer.launch({ executablePath: edge, headless: true, args: gpuArgs() });
    const page = await browser.newPage();
    page.on('pageerror', (err) => errors.push(err.message));
    page.setDefaultTimeout(20000);
    await page.setViewport({ width: 1600, height: 900 });
    await page.evaluateOnNewDocument(() => {
      localStorage.setItem('sp.name', 'CacheTester'); sessionStorage.setItem('sp.entered', '1');
    });
    const base = `http://127.0.0.1:${server.port}`;
    await page.goto(base);
    await page.waitForFunction(() => window.__SP__?.store.get().connection.status === 'online');
    await page.waitForSelector('.lobby-screen [data-testid="settings-btn"]');
    await page.evaluate(async () => { await navigator.serviceWorker.ready; });
    await page.waitForFunction(() => !!navigator.serviceWorker.controller);
    await page.click('.lobby-screen [data-testid="settings-btn"]');
    const toggle = '[data-testid="render-cache-toggle"]';
    await page.waitForSelector(toggle);
    assert.equal(await page.$eval(toggle, (el) => el.getAttribute('aria-checked')), 'false');
    const target = await page.evaluate(async () => {
      const mf = await (await fetch('/data/assets.json')).json();
      return Object.values(mf.chars).find((r) => /\/assets\/~/.test(r.avatar))?.avatar;
    });
    assert.ok(target, 'server exposes immutable art URLs');
    const has = () => page.evaluate(async (url) => !!await (await caches.open('sp-render-assets-v1')).match(url), target);
    await page.evaluate(async (url) => { await (await fetch(url, { cache: 'reload' })).arrayBuffer(); }, target);
    assert.equal(await has(), false, 'no render-cache writes before consent');
    await page.click(toggle);
    await page.waitForFunction(async () => (await import('/js/assetCache.js')).assetCache.getState().renderCacheReady);
    await page.evaluate(async (url) => { await (await fetch(url, { cache: 'reload' })).arrayBuffer(); }, target);
    await page.waitForFunction(async (url) => !!await (await caches.open('sp-render-assets-v1')).match(url), {}, target);
    await page.screenshot({ path: await (async () => { mkdirSync('.cache/asset-priority-edge', { recursive: true }); return '.cache/asset-priority-edge/consent.png'; })() });
    await page.keyboard.press('Escape');
    const send = (type, args = {}) => page.evaluate(async (t, a) => (await import('/js/net.js')).net.request(t, a), type, args);
    await send('room.create', { mode: 'solo', difficulty: 'FUNNY' });
    await send('room.start');
    await page.waitForFunction(() => window.__SP__.store.get().match.public?.phase === 'INFO_CHECK');
    await send('g.infoReady', { setupRevision: 0 });
    await page.waitForFunction(() => window.__SP__.store.get().match.public?.phase === 'BAND_DRAFT');
    await send('g.band', { bandId: 'band_bldsk' });
    await page.waitForFunction(() => window.__SP__.store.get().match.public?.phase === 'PREP');
    await page.waitForFunction(() => window.__SP_VIEW__?.kind === 'engine');
    const slot = await page.evaluate(() => window.__SP__.store.get().match.private.shop.slots.findIndex((s) => s && !s.sold && s.kind !== 'item'));
    assert.ok(slot >= 0);
    await send('g.buy', { slot });
    await page.waitForFunction(() => window.__SP__.store.get().match.private.hand.some((p) => p?.kind === 'chess'));
    await page.waitForFunction(async () => {
      const s = (await import('/js/assetPreload.js')).assetPreloadStatus();
      return s.enabled && !s.full && s.required === 0 && s.remaining > 20000;
    }, { timeout: 60000 });
    const warmed = await page.evaluate(async () => (await import('/js/assetPreload.js')).assetPreloadStatus().completed);
    await page.waitForFunction(async (n) => (await import('/js/assetPreload.js')).assetPreloadStatus().completed > n + 1,
      { timeout: 20000 }, warmed); // at least one remaining visual file, beyond the shared list, actually completes
    const prep = await page.evaluate(async () => ({
      phase: window.__SP__.store.get().match.public.phase,
      preload: (await import('/js/assetPreload.js')).assetPreloadStatus(),
      demand: (await import('/js/assetPriority.js')).assetDemand.active,
      own: window.__SP__.store.get().match.private.board.length,
      hand: window.__SP__.store.get().match.private.hand.filter(Boolean).length,
      renderCache: (await import('/js/assetCache.js')).assetCache.getState().renderCacheFull,
      policy: (await import('/js/assetCache.js')).assetCache.getState().policy,
    }));
    await page.evaluate(async () => (await import('/js/ui/matchChrome.js')).quitMatch());
    await page.waitForFunction(() => !window.__SP__.store.get().match.public);
    const next = await browser.newPage();
    next.on('pageerror', (err) => errors.push(err.message));
    await next.goto(base);
    await next.waitForFunction(async () => (await import('/js/assetCache.js')).assetCache.getState().renderCacheReady);
    const cdp = await next.createCDPSession();
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true }); // rule out the ordinary HTTP cache
    const before = requests.filter((u) => u === target).length;
    const reused = await next.evaluate(async (url) => {
      const r = await fetch(url); return { source: r.headers.get('x-sp-render-cache'), bytes: (await r.arrayBuffer()).byteLength };
    }, target);
    assert.equal(reused.source, '1'); assert.ok(reused.bytes > 0);
    assert.equal(requests.filter((u) => u === target).length, before, 'new document reads disk without server traffic');
    // Mount the actual settlement component with a spectator result to check its storage shortcut.
    await next.evaluate(async () => {
      const { render, h } = await import('/vendor/preact.module.js');
      const { SettleFlow } = await import('/js/screens/settle.js');
      const root = document.createElement('div'); root.style.cssText = 'position:fixed;inset:0;z-index:9999';
      document.body.append(root);
      render(h(SettleFlow, { res: { players: [], victory: false }, onBack: () => {} }), root);
    });
    await next.waitForSelector('[data-testid="settle-storage"]', { visible: true });
    await next.setViewport({ width: 844, height: 390 });
    assert.equal(await next.$eval('[data-testid="settle-storage"]', (el) => {
      const r = el.getBoundingClientRect(); return r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight;
    }), true, 'settlement storage shortcut fits a small landscape screen');
    await next.click('[data-testid="settle-storage"]');
    await next.waitForSelector('[data-testid="render-cache-clear"]');
    await next.click('[data-testid="render-cache-clear"]');
    await next.waitForFunction(async () => !((await import('/js/ui/settingsStore.js')).settingsStore.get().renderCache)
      && (await (await caches.open('sp-render-assets-v1')).keys()).length === 0);
    await next.waitForFunction(() => document.querySelector('[data-testid="render-cache-clear-note"]')?.textContent.includes('已关闭并清理'));
    await page.waitForFunction(async () => !((await import('/js/ui/settingsStore.js')).settingsStore.get().renderCache)
      && !(await import('/js/assetCache.js')).assetCache.getState().renderCacheReady);
    await next.screenshot({ path: '.cache/asset-priority-edge/settlement-storage.png' });
    assert.deepEqual(errors, []);
    const report = { browser: await browser.version(), viewport: '1600x900', target, prep, reused, errors };
    writeFileSync('.cache/asset-priority-edge/report.json', JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
  } finally { await browser?.close(); await server?.close(); }
});
