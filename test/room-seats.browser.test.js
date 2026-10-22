// SP_E2E=1 node --test test/room-seats.browser.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../server/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EDGE = process.env.CHROME_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const swap = (seat) => `[data-testid="seat-swap-${seat}"]`;

test('Edge: two humans exchange empty, AI and consenting human seats across 20-seat layouts', {
  skip: process.env.SP_E2E !== '1', timeout: 120000,
}, async (t) => {
  const out = await fs.mkdtemp(path.join(ROOT, '.cache', 'room-seats-'));
  const report = { errors: [], layouts: [], cleanup: {} };
  let server, browser;
  try {
    server = await startServer({ port: 0, host: '127.0.0.1', quiet: true,
      announcementsDir: path.join(out, 'announcements'), serverSettingsDir: path.join(out, 'settings') });
    const puppeteer = (await import('puppeteer-core')).default;
    browser = await puppeteer.launch({ executablePath: EDGE, headless: true, args: ['--no-first-run', '--no-sandbox'] });
    report.browser = await browser.version();
    const login = async (name) => {
      const context = await browser.createBrowserContext(), page = await context.newPage();
      page.on('pageerror', (e) => report.errors.push(e.message));
      await page.setViewport({ width: 1280, height: 720 });
      await page.goto(server.url, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => !!globalThis.__SP__);
      await page.type('.title-login input', name); await page.click('.title-login > .btn--primary');
      await page.waitForSelector('.lobby-screen');
      return page;
    };
    const host = await login('换座房主'), guest = await login('换座队友');
    const intent = (page, type, fields = {}) => page.evaluate((t, body) => globalThis.__SP__.net.request(t, body), type, fields);
    await intent(host, 'room.create', { mode: 'coop', difficulty: 'NORMAL', capacity: 20 });
    await host.waitForSelector('.room-screen');
    const code = await host.evaluate(() => globalThis.__SP__.store.get().room.code);
    await intent(guest, 'room.join', { code }); await guest.waitForSelector('.room-screen');
    const seat = (page, index) => page.waitForFunction((i) => globalThis.__SP__.store.get().room.seats[i]?.playerId === globalThis.__SP__.net.playerId, {}, index);
    const click = async (page, selector) => {
      await page.waitForFunction((s) => document.querySelector(s) && !document.querySelector(s).disabled, {}, selector);
      await page.$eval(selector, (e) => e.scrollIntoView({ block: 'center' }));
      await page.waitForFunction((s) => document.querySelector(s)?.closest('.seat')?.getAnimations().every((a) => a.playState === 'finished') ?? true, {}, selector);
      await page.click(selector);
    };
    await click(host, swap(19)); await seat(host, 19);
    assert.equal(await host.evaluate(() => globalThis.__SP__.store.get().room.hostId === globalThis.__SP__.net.playerId), true);
    await intent(host, 'room.addBot');
    await click(guest, swap(0)); await seat(guest, 0);
    assert.equal(server.lobby.getRoom(code).seats[1].isBot, true);
    await click(guest, swap(19)); await host.waitForSelector('[data-testid="seat-request"]');
    await click(host, '[data-testid="seat-decline"]');
    await guest.waitForFunction(() => !document.querySelector('[data-testid="seat-request"]'));
    await seat(host, 19); await seat(guest, 0);
    await click(guest, swap(19)); await host.waitForSelector('[data-testid="seat-request"]');
    for (const viewport of [{ width: 1920, height: 1080 }, { width: 1280, height: 720 }, { width: 844, height: 390 }]) {
      await host.setViewport(viewport);
      await host.$eval('[data-testid="seat-accept"]', (e) => e.scrollIntoView({ block: 'center' }));
      const layout = await host.evaluate(() => {
        const button = document.querySelector('[data-testid="seat-accept"]'), r = button.getBoundingClientRect();
        const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        const swapButtons = [...document.querySelectorAll('.seat__swap')];
        return { width: innerWidth, overflow: document.documentElement.scrollWidth > innerWidth,
          acceptClickable: hit === button || button.contains(hit),
          swapsWithinCards: swapButtons.every((b) => { const r = b.getBoundingClientRect(), c = b.closest('.seat').getBoundingClientRect(); return r.left >= c.left - 1 && r.right <= c.right + 1; }) };
      });
      assert.equal(layout.overflow, false); assert.equal(layout.acceptClickable, true); assert.equal(layout.swapsWithinCards, true);
      report.layouts.push(layout);
      await host.screenshot({ path: path.join(out, `request-${viewport.width}.png`) });
    }
    await click(host, '[data-testid="seat-accept"]'); await seat(host, 0); await seat(guest, 19);
    await click(host, swap(19)); await host.waitForSelector('[data-testid="seat-request"]');
    await click(host, '[data-testid="seat-decline"]');
    await guest.waitForFunction(() => !document.querySelector('[data-testid="seat-request"]'));
    await seat(host, 0); await seat(guest, 19);
    assert.deepEqual(report.errors, []);
    report.result = { emptySwap: true, aiSwap: true, decline: true, accept: true, cancel: true, hostRetained: true };
  } finally {
    if (browser) { await browser.close(); report.cleanup.browserClosed = true; }
    if (server) { await server.close(); report.cleanup.serverClosed = true; }
    await fs.writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    t.diagnostic(`Evidence: ${out}`);
  }
});
