import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { startServer } from '../server/index.js';
import { latencyProxy } from './helpers/latencyProxy.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EDGE = process.env.CHROME_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

test('Edge: separate uplink/downlink delays, page stalls and server stalls produce bounded, nonblocking notices', {
  skip: process.env.SP_E2E !== '1', timeout: 120000,
}, async (t) => {
  const out = await fs.mkdtemp(path.join(ROOT, '.cache', 'network-quality-browser-'));
  t.diagnostic(`Evidence (verification pending): ${out}`);
  const report = { errors: [], cases: {}, cleanup: {} };
  let server, proxy, browser;
  try {
    server = await startServer({ port: 0, host: '127.0.0.1', quiet: true,
      announcementsDir: path.join(out, 'announcements'), serverSettingsDir: path.join(out, 'settings') });
    proxy = await latencyProxy(server.port);
    const puppeteer = (await import('puppeteer-core')).default;
    browser = await puppeteer.launch({ executablePath: EDGE, headless: true, args: ['--no-first-run', '--no-sandbox'] });
    report.browser = await browser.version();
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 720 });
    page.on('pageerror', error => report.errors.push(error.message));
    await page.goto(`http://127.0.0.1:${proxy.port}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!globalThis.__SP__);
    await page.type('.title-login input', '连接诊断测试');
    await page.click('.title-login > .btn--primary');
    await page.waitForSelector('.lobby-screen');
    await page.evaluate(() => globalThis.__SP__.net.request('room.create', { mode: 'coop', difficulty: 'HARD', capacity: 20 }));
    await page.waitForSelector('.room-screen');
    // Let cold page/server initialization leave the eight-second evidence window before isolating link delay.
    await delay(9000);
    const probe = async () => {
      await page.evaluate(() => globalThis.__SP__.net.probe());
      await delay(700);
    };
    const snapshot = () => page.evaluate(() => ({ quality: globalThis.__SP__.net.quality,
      text: document.querySelector('.conn-banner--quality')?.textContent.trim() || null }));

    for (const direction of ['upload', 'download']) {
      proxy.delay(direction === 'upload' ? 350 : 0, direction === 'download' ? 350 : 0);
      for (let i = 0; i < 4; i++) await probe();
      const sample = await snapshot();
      report.cases[direction] = sample;
      assert.equal(sample.quality.cause, 'connection');
      assert.ok(sample.quality.rttMs >= 300);
      assert.match(sample.text, /连接延迟较高/);
    }
    for (const viewport of [{ width: 1280, height: 720 }, { width: 390, height: 844 }]) {
      await page.setViewport(viewport);
      const bounds = await page.$eval('.conn-banner--quality', el => {
        const box = el.getBoundingClientRect();
        return { left: box.left, right: box.right, width: innerWidth, pointerEvents: getComputedStyle(el).pointerEvents,
          fontSize: parseFloat(getComputedStyle(el).fontSize) };
      });
      assert.ok(bounds.left >= 0 && bounds.right <= bounds.width);
      assert.equal(bounds.pointerEvents, 'none');
      assert.ok(bounds.fontSize >= 12, 'the reminder stays readable when the game scales down');
      await page.screenshot({ path: path.join(out, `connection-${viewport.width}.png`) });
    }
    proxy.delay(0, 0);
    for (let i = 0; i < 5; i++) await probe();
    assert.equal((await snapshot()).quality.cause, null);
    for (let i = 0; i < 3; i++) {
      await page.evaluate(() => {
        globalThis.__SP__.net.probe();
        const until = performance.now() + 550;
        while (performance.now() < until) { /* deliberate renderer stall */ }
      });
      await delay(200);
    }
    report.cases.device = await snapshot();
    assert.equal(report.cases.device.quality.cause, 'device');
    assert.match(report.cases.device.text, /页面运行较慢/);
    // Stall the actual inbound-frame task, rather than racing a pong already sent before evaluate resolves.
    const ordinaryOnFrame = server.network.onFrame.bind(server.network);
    server.network.onFrame = (...args) => {
      const until = performance.now() + 450;
      while (performance.now() < until) { /* deliberate server event-loop stall */ }
      return ordinaryOnFrame(...args);
    };
    try { for (let i = 0; i < 3; i++) await probe(); }
    finally { server.network.onFrame = ordinaryOnFrame; }
    report.cases.server = await snapshot();
    assert.equal(report.cases.server.quality.cause, 'server');
    assert.match(report.cases.server.text, /服务器处理较慢/);
    const background = await browser.newPage();
    await background.bringToFront();
    await page.waitForFunction(() => document.visibilityState === 'hidden');
    assert.equal((await snapshot()).quality, null, 'background throttling clears the notice');
    await page.bringToFront();
    await background.close();
    const answer = await page.evaluate(() => globalThis.__SP__.net.request('room.ready', { ready: true }));
    assert.equal(answer.t, 'ok');
    assert.deepEqual(report.errors, []);
    report.requestAfterChecks = 'ok';
    report.limits = ['local Edge and synthetic TCP delay, not a production attribution or real mobile hardware'];
  } finally {
    if (browser) { await browser.close(); report.cleanup.browserClosed = true; }
    if (proxy) { await proxy.close(); report.cleanup.proxyClosed = true; }
    if (server) { await server.close(); report.cleanup.serverClosed = true; }
    await fs.writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  }
});
