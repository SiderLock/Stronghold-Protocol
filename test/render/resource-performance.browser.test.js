import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { gpuArgs } from '../../tools/perfbench.mjs';

const CHROME = process.env.CHROME_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const enabled = process.env.RENDER_E2E === '1' && existsSync(CHROME);
describe('mobile resource and resolution controls', { skip: !enabled && 'set RENDER_E2E=1 with Edge/Chrome and local assets' }, () => {
  let srv, browser, base;
  before(async () => {
    const { startServer } = await import('../../server/index.js');
    const puppeteer = (await import('puppeteer-core')).default;
    srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true });
    base = `http://127.0.0.1:${srv.port}`;
    browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: gpuArgs() });
  });
  after(async () => { await browser?.close(); await srv?.close(); });

  test('the mobile settings switch is touch-operable and keeps explicit off after a reload', async () => {
    const page = await browser.newPage(), errors = [];
    page.on('pageerror', e => errors.push(e.message));
    try {
      await page.setViewport({ width: 844, height: 390, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
      await page.goto(base, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.title-settings', { timeout: 60000 });
      await page.tap('.title-settings');
      const selector = '[role="switch"][aria-label="自动调整渲染分辨率"]';
      await page.waitForSelector(selector);
      assert.equal(await page.$eval(selector, e => e.getAttribute('aria-checked')), 'true');
      await page.tap(selector);
      await page.waitForFunction(() => JSON.parse(localStorage.getItem('sp.pref.settings')).adaptiveResolution === false);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.title-settings');
      await page.tap('.title-settings');
      await page.waitForSelector(selector);
      assert.equal(await page.$eval(selector, e => e.getAttribute('aria-checked')), 'false');
      await page.tap(selector);
      await page.waitForFunction(() => JSON.parse(localStorage.getItem('sp.pref.settings')).adaptiveResolution === true);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });

  test('sustained mobile load lowers canvas pixels; disabling restores sharpness without moving touch targets', async () => {
    const page = await browser.newPage(), errors = [];
    page.on('pageerror', e => errors.push(e.message));
    try {
      await page.setViewport({ width: 844, height: 390, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
      await page.goto(`${base}/dev/battle-perf.html?spec=hard-unite-r13&quality=high&fx=auto&panel=0`);
      await page.waitForFunction('window.__perf?.ready || window.__perf?.error', { timeout: 90000 });
      assert.equal(await page.evaluate(() => window.__perf.error), null);
      const cdp = await page.createCDPSession();
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
      await page.waitForFunction('window.__perf.view.stats().lod > 0', { timeout: 45000 });
      const result = await page.evaluate(() => {
        const v = window.__perf.view;
        const shape = () => ({ resolution: v.stats().resolution, tile: v.tileScreen(10, 3),
          canvasWidth: v.debug.app.view.width, cssWidth: v.debug.app.view.getBoundingClientRect().width });
        const adaptive = shape();
        v.setSettings({ adaptiveResolution: false });
        const fixed = shape();
        v.setSettings({ adaptiveResolution: true });
        return { adaptive, fixed, restored: shape() };
      });
      assert.ok(result.adaptive.resolution.units < 2);
      assert.equal(result.fixed.resolution.units, 2);
      assert.equal(result.fixed.resolution.board, 2);
      assert.ok(result.fixed.canvasWidth > result.adaptive.canvasWidth);
      assert.equal(result.fixed.cssWidth, result.adaptive.cssWidth);
      assert.deepEqual(result.fixed.tile, result.adaptive.tile);
      assert.deepEqual(result.restored, result.adaptive);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });
});
