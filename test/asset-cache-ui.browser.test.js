// Targeted real-app layout and persistence feedback checks; no combat or bulk downloads.
// SP_E2E=1 node --test test/asset-cache-ui.browser.test.js (Edge by default).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../server/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, '.cache', 'asset-cache-ui');
const EDGE = process.env.CHROME_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

test('Edge title icons retain their shape; cache controls are visible and persistence outcomes are explicit', {
  skip: process.env.SP_E2E === '1' ? false : 'set SP_E2E=1 (uses Edge)', timeout: 90000,
}, async () => {
  let server, browser;
  const errors = [], report = { layouts: [], persistence: [], cleanup: {} };
  const open = '[data-testid="asset-cache-open"]';
  const persist = '[data-testid="asset-cache-persist"]';
  const status = '[data-testid="asset-cache-persistence-status"]';
  try {
    await fs.mkdir(OUT, { recursive: true });
    server = await startServer({ port: 0, host: '127.0.0.1', quiet: true, announcementsDir: path.join(OUT, 'announcements') });
    report.port = server.port;
    const puppeteer = (await import('puppeteer-core')).default;
    browser = await puppeteer.launch({ executablePath: EDGE, headless: true, args: ['--no-first-run', '--no-sandbox'] });
    report.browser = await browser.version();
    const page = await browser.newPage();
    page.setDefaultTimeout(10000);
    page.setDefaultNavigationTimeout(30000);
    page.on('pageerror', (error) => errors.push(error.message));
    await page.evaluateOnNewDocument(() => {
      // Permission policy is the browser's decision. Inject all outcomes to exercise the UI deterministically.
      window.uiPersistence = { mode: 'denied', granted: false, calls: 0, finish: null };
      Object.defineProperty(navigator.storage, 'persisted', { configurable: true, value: async () => window.uiPersistence.granted });
      Object.defineProperty(navigator.storage, 'persist', { configurable: true, value: () => {
        const state = window.uiPersistence; state.calls++;
        if (state.mode === 'error') return Promise.reject(new Error('storage disabled'));
        if (state.mode === 'pending') return new Promise((resolve) => { state.finish = resolve; });
        state.granted = state.mode === 'granted';
        return Promise.resolve(state.granted);
      } });
    });
    await page.setViewport({ width: 1920, height: 1080 });
    // The background summary scan may still hash deployed assets; UI readiness is asserted below.
    await page.goto(server.url, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.title-login');
    // A fresh browser has no callsign yet and cannot handshake; reproduce the user's populated status row.
    await page.evaluate(async () => {
      const { store } = await import('/js/store.js');
      store.set((state) => ({ connection: { ...state.connection, status: 'online', ping: 1 } }));
    });
    await page.waitForFunction(() => document.querySelector('.title-conn .ping'));
    assert.equal(await page.$(open), null, 'the callsign screen must not expose the cache entry');
    const dimensions = [{ width: 3828, height: 1931 }, { width: 1920, height: 1080 }, { width: 1280, height: 720 }];
    for (const viewport of dimensions) {
      await page.setViewport(viewport);
      const bounds = await page.evaluate(() => {
        const row = document.querySelector('.title-conn').getBoundingClientRect();
        const icons = [...document.querySelectorAll('.title-settings, .title-fs')].map((el) => {
          const r = el.getBoundingClientRect(); return { width: r.width, height: r.height, left: r.left, right: r.right, top: r.top };
        });
        return { icons, row: { left: row.left, right: row.right }, items: [...document.querySelector('.title-conn').children].map((el) => ({ text: el.innerText, width: el.getBoundingClientRect().width, top: el.getBoundingClientRect().top })), tops: [...document.querySelector('.title-conn').children].map((el) => el.getBoundingClientRect().top),
          statusHeight: document.querySelector('.title-conn__status').getBoundingClientRect().height };
      });
      report.layouts.push({ screen: 'title', ...viewport, ...bounds });
      assert.equal(bounds.icons.length, 2);
      for (const icon of bounds.icons) {
        assert.ok(Math.abs(icon.width - icon.height) < 1, 'settings and fullscreen must stay square');
        assert.ok(icon.left >= bounds.row.left - 1 && icon.right <= bounds.row.right + 1);
      }
      assert.ok(Math.max(...bounds.tops) - Math.min(...bounds.tops) < bounds.icons[0].height, 'Chinese status controls fit on one row');
    }
    await page.setViewport({ width: 1920, height: 1080 });
    await page.screenshot({ path: path.join(OUT, 'title-1920.png') });
    await page.type('.title-login input', 'UI验证博士');
    await page.click('.title-login > .btn--primary');
    await page.waitForSelector('.lobby-screen');
    for (const viewport of dimensions.slice(1)) {
      await page.setViewport(viewport);
      const entry = await page.$eval(open, (el) => {
        const r = el.getBoundingClientRect(), css = getComputedStyle(el);
        const title = document.querySelector('.topbar__center').getBoundingClientRect();
        return { left: r.left, right: r.right, width: r.width, color: css.color, background: css.backgroundColor,
          border: css.borderColor, titleLeft: title.left, text: el.innerText.trim() };
      });
      assert.match(entry.text, /预缓存/);
      assert.notEqual(entry.background, 'rgba(0, 0, 0, 0)');
      assert.notEqual(entry.border, 'rgba(0, 0, 0, 0)');
      assert.ok(entry.left >= 0 && entry.right < entry.titleLeft, 'cache entry does not cover the centered heading');
      report.layouts.push({ screen: 'lobby', ...viewport, ...entry });
      await page.screenshot({ path: path.join(OUT, `lobby-${viewport.width}.png`) });
    }
    await page.click(open);
    try {
      await page.waitForFunction(async () => {
        const state = (await import('/js/assetCache.js')).assetCache.getState();
        return state.serverVersion && !['initializing', 'checking'].includes(state.phase);
      });
    } catch (error) {
      report.cacheInitialization = await page.evaluate(async () => ({
        state: (await import('/js/assetCache.js')).assetCache.getState(),
        dialog: document.querySelector('.asset-cache-dialog')?.innerText,
        controller: navigator.serviceWorker.controller?.scriptURL,
        imports: document.querySelector('script[type="importmap"]')?.textContent,
      }));
      throw error;
    }
    assert.equal(await page.$eval('[data-testid="asset-cache-download"]', (el) => el.disabled), false,
      'an explicit cold fill may obtain the current directory first');
    assert.ok(await page.$('[data-testid="asset-cache-catalog-download"]'), 'cold online directory acquisition is visible');
    await page.evaluate(async () => {
      const { assetCache } = await import('/js/assetCache.js');
      window.realAssetCacheState = assetCache.getState;
      const state = assetCache.getState();
      assetCache.getState = () => ({ ...state, phase: 'catalog-stale', hasCatalog: true, catalogCurrent: false,
        version: '0'.repeat(64), readyFiles: 0, readyBytes: 0 });
      await assetCache.initialize();
    });
    await page.waitForFunction(() => document.querySelector('[data-testid="asset-cache-local-version"]')?.textContent === '0'.repeat(64));
    assert.ok(await page.$('[data-testid="asset-cache-catalog-download"]'), 'empty old directories retain online acquisition');
    assert.equal(await page.$('[data-testid="asset-cache-catalog-update"]'), null, 'an empty cache uses cold acquisition');
    assert.equal(await page.$eval('[data-testid="asset-cache-download"]', (el) => el.disabled), false,
      'an empty old directory cannot strand the fill button');
    await page.evaluate(async () => {
      const { assetCache } = await import('/js/assetCache.js');
      assetCache.getState = window.realAssetCacheState;
      await assetCache.initialize();
    });
    assert.ok(await page.$('[data-testid="asset-cache-catalog-import"]'), 'standalone catalog import is visible');
    assert.match(await page.$eval('[data-testid="asset-cache-import"]', (el) => el.innerText), /强烈推荐/);
    assert.notEqual(await page.$eval(persist, (el) => getComputedStyle(el).backgroundColor), 'rgba(0, 0, 0, 0)');
    await page.click(persist);
    await page.waitForFunction((selector) => document.querySelector(selector).innerText.includes('未授予'), {}, status);
    report.persistence.push(await page.$eval(status, (el) => el.innerText));
    assert.equal(await page.$eval(persist, (el) => el.disabled), false, 'browser denial remains retryable');

    await page.evaluate(() => { window.uiPersistence.mode = 'pending'; });
    await page.click(persist);
    await page.waitForFunction((selector) => document.querySelector(selector).innerText.includes('正在申请'), {}, status);
    assert.equal(await page.$eval(persist, (el) => el.disabled), true);
    await page.evaluate(() => window.uiPersistence.finish(false));
    await page.waitForFunction((selector) => !document.querySelector(selector).disabled, {}, persist);
    assert.equal(await page.evaluate(() => window.uiPersistence.calls), 2);

    await page.evaluate(() => { window.uiPersistence.mode = 'error'; });
    await page.click(persist);
    await page.waitForFunction((selector) => document.querySelector(selector).innerText.includes('申请失败'), {}, status);
    report.persistence.push(await page.$eval(status, (el) => el.innerText));
    await page.evaluate(() => { window.uiPersistence.mode = 'granted'; });
    await page.click(persist);
    await page.waitForFunction((selector) => document.querySelector(selector).innerText.includes('已允许'), {}, status);
    assert.equal(await page.$eval(persist, (el) => el.disabled), true);
    report.persistence.push(await page.$eval(status, (el) => el.innerText));
    for (const viewport of dimensions.slice(1)) {
      await page.setViewport(viewport);
      const layout = await page.$eval('.asset-cache-dialog', (el) => {
        const r = el.getBoundingClientRect(), body = el.querySelector('.modal__body');
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, overflow: body.scrollWidth > body.clientWidth + 2 };
      });
      assert.ok(layout.left >= 0 && layout.right <= viewport.width && layout.top >= 0 && layout.bottom <= viewport.height);
      assert.equal(layout.overflow, false);
      report.layouts.push({ screen: 'cache-dialog', ...viewport, ...layout });
      await page.screenshot({ path: path.join(OUT, `cache-dialog-${viewport.width}.png`) });
    }
    // Lack of the optional persistence API must explain the disabled button without hiding cache controls.
    const unsupported = await browser.newPage();
    await unsupported.setViewport({ width: 1280, height: 720 });
    unsupported.on('pageerror', (error) => errors.push(error.message));
    await unsupported.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator.storage, 'persist', { configurable: true, value: undefined });
    });
    await unsupported.goto(server.url, { waitUntil: 'networkidle0' });
    await unsupported.click('.title-login > .btn--primary');
    await unsupported.waitForSelector(open); await unsupported.click(open);
    await unsupported.waitForSelector(persist);
    assert.equal(await unsupported.$eval(persist, (el) => el.disabled), true);
    assert.match(await unsupported.$eval(status, (el) => el.innerText), /不支持申请/);
    report.persistence.push(await unsupported.$eval(status, (el) => el.innerText));
    await unsupported.close();
    assert.deepEqual(errors, []);
  } finally {
    if (browser) { await browser.close(); report.cleanup.browserClosed = true; }
    if (server) { await server.close(); report.cleanup.serverClosed = true; }
    await fs.mkdir(OUT, { recursive: true });
    await fs.writeFile(path.join(OUT, 'report.json'), JSON.stringify({ ...report, errors }, null, 2) + '\n');
  }
});
