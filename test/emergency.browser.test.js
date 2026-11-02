// Short Edge smoke check: 20 seats, INFO_CHECK / PREP, emergency notice and frozen clocks. No combat run.
// SP_E2E=1 node --test test/emergency.browser.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../server/index.js';
import { writeServerSettings } from '../server/serverSettings.js';
import { TestClient } from './helpers/wsClient.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, '.cache', 'emergency-ui');
const EDGE = process.env.CHROME_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

test('Edge 20-seat emergency freezes INFO_CHECK and PREP clocks; notice survives overlays and disappears on resume', {
  skip: process.env.SP_E2E === '1' ? false : 'set SP_E2E=1 (uses Edge)', timeout: 60000,
}, async () => {
  let server, browser, peer;
  const errors = [], report = { browser: '', phases: [], layouts: [], cleanup: {} };
  try {
    await fs.mkdir(OUT, { recursive: true });
    const settingsDir = path.join(OUT, 'runtime');
    writeServerSettings(settingsDir, { maxAiPerRoom: null, requireAssetCache: false });
    server = await startServer({ port: 0, host: '127.0.0.1', quiet: true,
      serverSettingsDir: settingsDir, announcementsDir: path.join(OUT, 'announcements'),
      bandwidthEmergency: { enabled: false, autoResumeMs: 0 } });
    report.port = server.port;
    const puppeteer = (await import('puppeteer-core')).default;
    browser = await puppeteer.launch({ executablePath: EDGE, headless: true, args: ['--no-first-run', '--no-sandbox'] });
    report.browser = await browser.version();
    const page = await browser.newPage();
    page.setDefaultTimeout(15000);
    page.on('pageerror', (error) => errors.push(error.message));
    await page.setViewport({ width: 1920, height: 1080 });
    await page.goto(server.url, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.title-login input');
    await page.type('.title-login input', '紧急保护验证博士');
    await page.waitForFunction(() => !document.querySelector('.title-login > .btn--primary').disabled);
    await page.click('.title-login > .btn--primary');
    await page.waitForSelector('.lobby-screen');
    // This fixture bypasses local admission scanning only; the real server policy is explicitly optional above.
    await page.evaluate(() => { globalThis.__SP__.net.getAssetCacheReadiness = () => null; });
    const request = (type, fields = {}) => page.evaluate((type, fields) => globalThis.__SP__.net.request(type, fields), type, fields);
    await request('room.create', { mode: 'coop', difficulty: 'NORMAL', capacity: 20 });
    const { code, hostId } = await page.evaluate(() => globalThis.__SP__.store.get().room);
    peer = await TestClient.connect(`ws://127.0.0.1:${server.port}/ws`, { wire: true });
    await peer.hello('第二位验证博士');
    assert.equal((await peer.request({ t: 'room.join', code })).t, 'ok');
    const host = server.registry.byId(hostId);
    for (let i = 0; i < 18; i++) assert.deepEqual(server.lobby.addBot(host), { ok: true });
    assert.equal((await peer.request({ t: 'room.ready', ready: true })).t, 'ok');
    await request('room.start');
    await page.waitForSelector('.screen.brief');
    await page.waitForFunction(() => globalThis.__SP__.store.get().match.public?.players?.length === 20);
    const room = server.lobby.roomOf(host);

    for (const phase of ['INFO_CHECK', 'PREP']) {
      if (phase === 'PREP') {
        // Jump only the fixture's setup presentation to round-1 PREP; no battle is executed.
        room.match.enterBandDraft();
        room.match.finishBandDraft(true);
        room.match.startRound(1);
        room.match.afterRoundStart();
        room.match.flush(true);
        await page.waitForSelector('.screen.gm');
      }
      await page.waitForFunction((phase) => globalThis.__SP__.store.get().match.public?.phase === phase, {}, phase);
      const oldDeadline = await page.evaluate(() => globalThis.__SP__.store.get().match.public.deadline);
      server.bandwidthEmergency.trip('browser-fixture');
      await page.waitForSelector('[data-testid="server-emergency"]');
      await page.waitForFunction(() => globalThis.__SP__.store.get().match.public?.emergencyFrozen === true);
      const clock = phase === 'PREP' ? '.gtop__clock .countdown' : '.stephead__right .countdown';
      const label = await page.$eval(clock, (el) => el.getAttribute('aria-label'));
      // Simulate a resumed welcome + small room push, with its full match push delayed beyond the normal 1.5s grace.
      await page.evaluate(() => {
        const { net, store } = globalThis.__SP__, s = store.get();
        net._emit('welcome', { ...s.me, emergency: s.emergency });
        net._emit('room.state', { t: 'room.state', ...s.room });
      });
      await new Promise((resolve) => setTimeout(resolve, 1800));
      assert.equal(await page.$eval(clock, (el) => el.getAttribute('aria-label')), label, `${phase}: countdown frozen`);
      assert.equal(await page.evaluate(() => globalThis.__SP__.store.get().ui.restoring), true, 'emergency does not discard the delayed match restore');
      assert.equal(room.match.phase, phase);
      const protectedResponse = await fetch(server.url);
      assert.equal(protectedResponse.status, 503, 'new public HTTP access is blocked');
      report.phases.push({ phase, players: 20, label, frozen: true, httpStatus: protectedResponse.status });
      for (const viewport of [{ width: 1920, height: 1080 }, { width: 1280, height: 720 }]) {
        await page.setViewport(viewport);
        const layout = await page.evaluate(() => {
          const notice = document.querySelector('.emergency-banner');
          const rect = notice.getBoundingClientRect();
          const header = document.querySelector('.gtop') || document.querySelector('.stephead');
          const h = header.getBoundingClientRect();
          const controls = [...document.querySelectorAll('.screen button, .screen .countdown, .screen [role="button"]')].map((el) => {
            const r = el.getBoundingClientRect();
            return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
          });
          return { text: notice.textContent.trim(), notice: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom },
            header: { left: h.left, right: h.right, top: h.top, bottom: h.bottom }, controls, zIndex: Number(getComputedStyle(notice).zIndex) };
        });
        report.layouts.push({ phase, ...viewport, ...layout });
        await page.screenshot({ path: path.join(OUT, `${phase.toLowerCase()}-${viewport.width}.png`) });
        assert.match(layout.text, /对局已冻结/);
        assert.ok(layout.notice.left >= 0 && layout.notice.right <= viewport.width, 'banner within viewport');
        assert.ok(layout.controls.every((r) => r.right <= layout.notice.left || r.left >= layout.notice.right
          || r.bottom <= layout.notice.top || r.top >= layout.notice.bottom), 'banner never covers screen controls');
        assert.ok(layout.zIndex > 80, 'notice remains above ordinary modals and AI-away overlay');
      }
      server.bandwidthEmergency.resume();
      await page.waitForFunction(() => !document.querySelector('[data-testid="server-emergency"]')
        && !!globalThis.__SP__.store.get().match.public && globalThis.__SP__.store.get().match.public.emergencyFrozen !== true);
      assert.ok(room.match.deadline > oldDeadline, 'resume preserves the remaining countdown');
      assert.equal(await page.$('[data-testid="paused"]'), null, 'emergency never becomes solo pause');
      await page.setViewport({ width: 1920, height: 1080 });
    }
    assert.deepEqual(errors, []);
    assert.equal(room.match.errorCount, 0);
  } finally {
    if (peer) { peer.ws.terminate(); await peer.closed; }
    if (browser) { await browser.close(); report.cleanup.browserClosed = !browser.connected; }
    if (server) { await server.close(); report.cleanup.serverClosed = !server.server.listening; }
    report.errors = errors;
    await fs.writeFile(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
  }
});
