// SP_E2E=1 CHROME_PATH=… node --test test/briefing-loading.browser.test.js
// Hold image responses across three isolated clients: briefing actions must still work, and resources for
// later phases must wait. No assertions on wall-clock image completion (network scheduling varies by browser).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../server/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EDGE = process.env.CHROME_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const boot = (url) => /\/ui\/(battleReady\/|settle\/common_logo|roundStartDialog\/round_emoji_head)/.test(url);
const sim = (url) => /\/sim\/(spec\.js|simdata\.js|content\/support\/index\.js)/.test(url);

test('three clients: pending briefing images do not block reroll/ready; boot and sim downloads wait', {
  skip: process.env.SP_E2E !== '1', timeout: 120000,
}, async (t) => {
  const out = await fs.mkdtemp(path.join(ROOT, '.cache', 'briefing-loading-'));
  const errors = [], clients = [];
  let server, browser;
  try {
    server = await startServer({ port: 0, host: '127.0.0.1', quiet: true, seedFn: () => 123,
      announcementsDir: path.join(out, 'announcements'), serverSettingsDir: path.join(out, 'settings') });
    const puppeteer = (await import('puppeteer-core')).default;
    browser = await puppeteer.launch({ executablePath: EDGE, headless: true, args: ['--no-first-run', '--no-sandbox'] });
    const request = (page, type, fields = {}) => page.evaluate((type, fields) => globalThis.__SP__.net.request(type, fields), type, fields);
    for (let i = 0; i < 3; i++) {
      const context = await browser.createBrowserContext(), page = await context.newPage();
      page.on('pageerror', (e) => errors.push(e.message));
      await page.evaluateOnNewDocument(() => performance.setResourceTimingBufferSize(5000));
      await page.setViewport({ width: 1280, height: 720 });
      await page.goto(server.url, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.title-login input');
      await page.type('.title-login input', `图片加载${i + 1}`);
      await page.click('.title-login > .btn--primary');
      await page.waitForSelector('.lobby-screen');
      const playerId = await page.evaluate(() => globalThis.__SP__.store.get().me.playerId);
      clients.push({ page, playerId, requests: [], held: [], holding: true });
    }
    const host = clients[0].page;
    await request(host, 'room.create', { mode: 'coop', difficulty: 'HARD', capacity: 4 });
    const code = await host.evaluate(() => globalThis.__SP__.store.get().room.code);
    for (const { page } of clients.slice(1)) {
      await request(page, 'room.join', { code });
      await request(page, 'room.ready', { ready: true });
    }
    for (const client of clients) {
      const { page } = client;
      // Isolate image scheduling from the initial JSON download, as in the measured slow-network reproduction.
      await page.waitForFunction(async () => {
        const { GAME_FILES } = await import('/js/ui/gameComponents.js');
        return GAME_FILES.every((f) => !['idle', 'loading'].includes(globalThis.__SP__.data.status(f)));
      });
      await page.setRequestInterception(true);
      page.on('request', (r) => {
        client.requests.push(r.url());
        if (client.holding && r.resourceType() === 'image' && r.url().includes('/assets/')) client.held.push(r);
        else void r.continue();
      });
    }
    await request(host, 'room.start');
    await Promise.all(clients.map(({ page }) => page.waitForSelector('.brief-banned__grid img')));
    for (const client of clients) {
      assert.ok(client.held.length > 0, 'real image requests are pending');
      assert.equal(client.requests.some(boot), false, 'no boot art competes with briefing images');
      assert.equal(client.requests.some(sim), false, 'no simulation prewarm during INFO_CHECK');
    }
    // A teammate requests; the host proposes; both teammates consent, with images still pending throughout.
    await clients[1].page.click('.brief-reroll__actions .btn');
    await host.waitForFunction(() => globalThis.__SP__.store.get().match.public.rerollRequests?.length === 1);
    await host.click('.brief-reroll__actions .btn');
    for (const { page } of clients.slice(1)) {
      await page.waitForSelector('.brief-reroll__actions .btn--primary:not(:disabled)');
      await page.click('.brief-reroll__actions .btn--primary');
    }
    await Promise.all(clients.map(({ page }) => page.waitForFunction(() => globalThis.__SP__.store.get().match.public.setupRevision === 1)));
    await host.screenshot({ path: path.join(out, 'pending-images.png') });
    for (const { page } of clients) await page.click('.brief__foot > .btn--primary');
    await Promise.all(clients.map(({ page }) => page.waitForSelector('.screen.draft')));
    for (const client of clients) {
      await client.page.waitForFunction(() => document.querySelector('.screen.draft'));
      assert.equal(client.requests.some(sim), false, 'draft still leaves simulation idle');
      client.holding = false;
      await Promise.all(client.held.map((r) => r.continue()));
    }
    await host.waitForFunction(() => performance.getEntriesByType('resource').some((e) => /battleReady\/rhodes\.png/.test(e.name)));
    for (let i = 0; i < 3; i++) {
      const draft = await host.evaluate(() => globalThis.__SP__.store.get().match.public.draft);
      const client = clients.find((c) => c.playerId === draft.turn);
      assert.ok(client, 'a human has the next strategy turn');
      await client.page.waitForSelector('.draft-detail__btns .btn--primary:not(:disabled)');
      await client.page.click('.dband:not(.is-taken)');
      await client.page.click('.draft-detail__btns .btn--primary');
      await host.waitForFunction((turn) => globalThis.__SP__.store.get().match.public.draft?.turn !== turn, {}, draft.turn);
    }
    await host.waitForSelector('.gm__hud');
    await Promise.all(clients.map(({ page }) => page.waitForFunction(() =>
      performance.getEntriesByType('resource').some((e) => /\/sim\/spec\.js/.test(e.name)))));
    assert.deepEqual(errors, []);
    await fs.writeFile(path.join(out, 'report.json'), JSON.stringify({ browser: await browser.version(), errors,
      clients: clients.map((c) => ({ pendingImages: c.held.length, bootRequested: c.requests.some(boot), simRequested: c.requests.some(sim) })) }, null, 2));
  } finally {
    await browser?.close();
    await server?.close();
    t.diagnostic(`artifacts: ${out}`);
  }
});
