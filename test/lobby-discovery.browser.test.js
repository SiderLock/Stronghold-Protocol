// Short real-browser lobby workflow; no combat, bulk downloads, or full-round simulation.
// SP_E2E=1 node --test test/lobby-discovery.browser.test.js (Edge by default).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../server/index.js';
import { StubMatch } from '../server/match/StubMatch.js';
import { TestClient } from './helpers/wsClient.js';
import { ROOM_CAPACITIES } from '../shared/constants.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Keep prior previews readable while another run writes its own screenshots (Windows image viewers may lock files).
const OUT = path.join(ROOT, '.cache', 'lobby-discovery-ui', `run-${Date.now()}`);
const EDGE = process.env.CHROME_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const selector = (name) => `[data-testid="lobby-${name}"]`;
// Keep a directory's ongoing-match entry stable without playing any rounds.
class DirectoryMatch extends StubMatch {
  constructor(opts) { super(opts); this.infoCheckMs = 120000; }
}

test('Edge lobby counts, directory join, capacity fallback and no-room feedback work with real WebSockets', {
  skip: process.env.SP_E2E === '1' ? false : 'set SP_E2E=1 (uses Edge)', timeout: 90000,
}, async () => {
  let server, browser;
  const clients = [], errors = [], report = { layouts: [], cleanup: {} };
  try {
    await fs.mkdir(OUT, { recursive: true });
    server = await startServer({ port: 0, host: '127.0.0.1', quiet: true, MatchClass: DirectoryMatch,
      announcementsDir: path.join(OUT, 'announcements'), serverSettingsDir: path.join(OUT, 'server-settings') });
    report.port = server.port;
    const makeRoom = async (name, capacity, bots = 0, mode = 'coop') => {
      const client = await TestClient.connect(`ws://127.0.0.1:${server.port}/ws`);
      clients.push(client);
      const identity = await client.hello(name);
      assert.equal((await client.request({ t: 'room.create', mode, difficulty: 'NORMAL', ...(mode === 'coop' ? { capacity } : {}) })).t, 'ok');
      const room = await client.waitFor('room.state');
      for (let i = 0; i < bots; i++) assert.equal((await client.request({ t: 'room.addBot' })).t, 'ok');
      return { client, code: room.code, playerId: identity.playerId };
    };
    const nearest = await makeRoom('空余一席', 4, 2);
    const other = await makeRoom('八人同盟', 8);
    const full = await makeRoom('二十人满员', 20, 19);
    const running = await makeRoom('模拟进行中', 10);
    assert.equal((await running.client.request({ t: 'room.start' })).t, 'ok');
    const solo = await makeRoom('独立模拟', 1, 0, 'solo');
    const puppeteer = (await import('puppeteer-core')).default;
    browser = await puppeteer.launch({ executablePath: EDGE, headless: true, args: ['--no-first-run', '--no-sandbox'] });
    report.browser = await browser.version();
    report.browserPid = browser.process()?.pid;
    const page = await browser.newPage();
    page.setDefaultTimeout(10000);
    page.on('pageerror', (error) => errors.push(error.message));
    await page.setViewport({ width: 1920, height: 1080 });
    await page.goto(server.url, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.title-login input');
    await page.type('.title-login input', '联机验证博士');
    await page.click('.title-login > .btn--primary');
    await page.waitForFunction((s) => document.querySelector(s)?.textContent === '5', {}, selector('room-count'));
    assert.match(await page.$eval(selector('online'), (el) => el.textContent), /在线 6/);
    assert.equal(await page.$eval(selector('match-count'), (el) => el.textContent), '1');
    assert.equal(await page.$eval(selector('joinable-count'), (el) => el.textContent), '2');
    assert.deepEqual(await page.$$eval(`${selector('match-capacity')} option`, (options) => options.map((el) => el.value)), ['', ...ROOM_CAPACITIES.map(String)]);
    for (const viewport of [{ width: 1920, height: 1080 }, { width: 1280, height: 720 }]) {
      await page.setViewport(viewport);
      await page.mouse.move(viewport.width - 4, 4); // keep lingering tooltips out of the preview
      const layout = await page.evaluate(() => {
        const bounds = (el) => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
        const panel = document.querySelector('[data-testid="lobby-discovery"]');
        const body = document.querySelector('.lobby-body');
        const bodyScroll = body.scrollHeight - body.clientHeight;
        // Compare the original card spacing without discovery; a small pre-existing right-column scroll
        // is allowed, but the new panel must not make the screen longer.
        const original = document.createElement('style');
        original.textContent = '.lobby-discovery{display:none!important}.lobby-screen .mode-cards{margin-bottom:.34rem}.lobby-screen .mode-card{min-height:4.3rem;gap:.22rem;padding-top:.34rem;padding-bottom:.3rem}.lobby-screen .mode-card__icon{width:.88rem;height:.88rem}.lobby-screen .mode-card__icon .icon{width:.44rem;height:.44rem}';
        document.head.append(original);
        const baselineScroll = body.scrollHeight - body.clientHeight;
        original.remove();
        return { online: bounds(document.querySelector('[data-testid="lobby-online"]')), cache: bounds(document.querySelector('[data-testid="asset-cache-open"]')),
          heading: bounds(document.querySelector('.topbar__center')), panel: bounds(panel), panelOverflow: panel.scrollWidth > panel.clientWidth + 2,
          rootPx: parseFloat(getComputedStyle(document.documentElement).fontSize), bodyScroll, baselineScroll,
          create: bounds(document.querySelector('.create-box .btn--xl')) };
      });
      assert.ok(layout.online.right <= layout.cache.left + 1 && layout.cache.right < layout.heading.left, 'left controls never overlap cache or heading');
      assert.ok(layout.panel.height <= layout.rootPx * 1.5, 'discovery stays a compact two-row panel');
      assert.equal(layout.panelOverflow, false);
      report.layouts.push({ screen: 'lobby', ...viewport, ...layout });
      assert.ok(layout.create.bottom <= viewport.height, `create button fits; extra scroll ${layout.bodyScroll}px`);
      assert.ok(layout.bodyScroll <= layout.baselineScroll + 2, 'new discovery preserves the original page scroll range');
      await page.screenshot({ path: path.join(OUT, `lobby-${viewport.width}.png`) });
      await page.click(selector('directory-open'));
      await page.waitForSelector(`[data-room-code="${nearest.code}"]`);
      await page.waitForFunction(() => document.querySelector('.modal')?.getAnimations({ subtree: true }).every((animation) => animation.playState === 'finished'));
      assert.equal(await page.$$eval('.lobby-directory [data-room-code]', (rows) => rows.length), 5);
      assert.equal(await page.$(`[data-room-code="${running.code}"] .lobby-directory__join`), null, 'running match has no player join entry');
      assert.equal(await page.$eval(`[data-room-code="${running.code}"] .lobby-directory__spectate`, (el) => el.disabled), false,
        'running co-op match offers available spectator seats');
      assert.equal(await page.$(`[data-room-code="${solo.code}"] button`), null, 'solo is read only');
      assert.equal(await page.$eval(`[data-room-code="${full.code}"] .lobby-directory__join`, (el) => el.disabled), true);
      const dialog = await page.$eval('.lobby-directory', (el) => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, overflow: el.scrollWidth > el.clientWidth + 2 }; });
      assert.ok(dialog.left >= 0 && dialog.right <= viewport.width && dialog.top >= 0 && dialog.bottom <= viewport.height);
      assert.equal(dialog.overflow, false);
      report.layouts.push({ screen: 'directory', ...viewport, ...dialog });
      await page.screenshot({ path: path.join(OUT, `directory-${viewport.width}.png`) });
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.querySelector('.lobby-directory'));
    }
    await page.click(selector('directory-open'));
    await page.waitForSelector(`[data-room-code="${other.code}"] .lobby-directory__join`);
    await page.click(`[data-room-code="${other.code}"] .lobby-directory__join`);
    await page.waitForSelector('.room-screen');
    assert.equal(await page.evaluate(() => globalThis.__SP__.store.get().room.code), other.code);
    const playerId = await page.evaluate(() => globalThis.__SP__.store.get().me.playerId);
    assert.equal(server.lobby.discovery.watchers.has(playerId), false);
    await page.click('.room-screen [aria-label="离开同盟"]');
    await page.waitForSelector(selector('quick-match'));
    await page.select(selector('match-capacity'), '20');
    await page.click(selector('quick-match'));
    await page.waitForSelector('.room-screen');
    assert.equal(await page.evaluate(() => globalThis.__SP__.store.get().room.code), nearest.code, 'full preferred room falls back to nearest eligible room');
    assert.equal(server.lobby.discovery.watchers.has(playerId), false);
    report.joined = { directory: other.code, fallback: nearest.code };
    await page.click('.room-screen [aria-label="离开同盟"]');
    await page.waitForSelector(selector('quick-match'));
    for (const client of clients) assert.equal((await client.request({ t: 'room.leave' })).t, 'ok');
    await page.waitForFunction((s) => document.querySelector(s)?.textContent === '0', {}, selector('room-count'));
    await page.click(selector('quick-match'));
    await page.waitForFunction(() => document.body.textContent.includes('暂无可加入的房间，请稍后重试或创建同盟。'));
    assert.ok(await page.$('.lobby-screen'), 'no-room matching does not auto-create a room');
    await page.click('.topbar__left > button');
    await page.waitForSelector('.title-login');
    assert.equal(server.lobby.discovery.watchers.has(playerId), false, 'returning to title unsubscribes');
    assert.deepEqual(errors, []);
  } finally {
    if (browser) {
      const browserProcess = browser.process();
      await browser.close(); report.cleanup.browserClosed = true;
      report.cleanup.browserProcessExited = !browserProcess || browserProcess.exitCode !== null || browserProcess.signalCode !== null;
      assert.equal(report.cleanup.browserProcessExited, true, 'owned Edge child exited');
    }
    await Promise.all(clients.map((client) => client.terminate()));
    report.cleanup.clientsClosed = true;
    if (server) {
      await server.close(); report.cleanup.serverClosed = true;
      report.cleanup.portClosed = await fetch(`${server.url}/healthz`).then(() => false, () => true);
      assert.equal(report.cleanup.portClosed, true, 'owned HTTP listener was released');
    }
    await fs.mkdir(OUT, { recursive: true });
    await fs.writeFile(path.join(OUT, 'report.json'), JSON.stringify({ ...report, errors }, null, 2) + '\n');
  }
});
