// Short Edge + real WebSocket/owner CLI regression. No combat or full-round simulation.
// SP_E2E=1 node --test test/room-management.browser.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startServer } from '../server/index.js';
import { StubMatch } from '../server/match/StubMatch.js';
import { TestClient } from './helpers/wsClient.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, '.cache', 'room-management-ui', `run-${Date.now()}`);
const EDGE = process.env.CHROME_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const TRANSFER = '[aria-label="转让房主给该博士"]';
const KICK = '[aria-label="移出该博士"]';
const SELECTOR = (name) => `[data-testid="lobby-${name}"]`;

// Preserve directory state long enough to test without playing battles or the 25-second stub timeout.
class DirectoryMatch extends StubMatch {
  constructor(opts) { super(opts); this.infoCheckMs = 180000; }
}

function configure(dir, value) {
  const command = spawnSync(process.execPath, ['tools/server-settings.mjs', 'ai-limit', value, '--dir', dir], {
    cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout: 10000,
  });
  assert.equal(command.status, 0, `${command.error?.message || ''}${command.stderr}`);
  return command.stdout.trim();
}

function intent(page, t, fields = {}) {
  return page.evaluate(async (type, payload) => {
    try { return await globalThis.__SP__.net.request(type, payload); }
    catch (error) { return { t: 'error', code: error.code, message: error.message }; }
  }, t, fields);
}

async function idleCards(page) {
  await page.waitForFunction(() => [...document.querySelectorAll('.seat')]
    .every((seat) => seat.getAnimations().every((animation) => animation.playState === 'finished')));
}

test('Edge retained directory, host handover and live owner AI limits remain usable across room layouts', {
  skip: process.env.SP_E2E === '1' ? false : 'set SP_E2E=1 (uses Edge)', timeout: 120000,
}, async () => {
  let server, browser;
  const clients = [], errors = [], report = { layouts: [], commands: [], cleanup: {}, scenes: [] };
  const settingsDir = path.join(OUT, 'server-settings');
  try {
    await fs.mkdir(OUT, { recursive: true });
    report.commands.push(configure(settingsDir, 'unlimited'));
    server = await startServer({ port: 0, host: '127.0.0.1', quiet: true, MatchClass: DirectoryMatch,
      announcementsDir: path.join(OUT, 'announcements'), serverSettingsDir: settingsDir });
    report.port = server.port;
    const connect = async (name) => {
      const client = await TestClient.connect(`ws://127.0.0.1:${server.port}/ws`);
      clients.push(client);
      const welcome = await client.hello(name);
      return { client, ...welcome };
    };

    // Create the disconnected retained run first: ordering must be independent of insertion order.
    const retained = await connect('断线独立博士');
    assert.equal((await retained.client.request({ t: 'room.create', mode: 'solo', difficulty: 'NORMAL' })).t, 'ok');
    retained.code = (await retained.client.waitFor('room.state')).code;
    assert.equal((await retained.client.request({ t: 'room.start' })).t, 'ok');
    await retained.client.terminate();

    const offlineHost = await connect('临时离线房主');
    assert.equal((await offlineHost.client.request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL', capacity: 8 })).t, 'ok');
    offlineHost.code = (await offlineHost.client.waitFor('room.state')).code;
    const remainingHuman = await connect('仍然在线博士');
    assert.equal((await remainingHuman.client.request({ t: 'room.join', code: offlineHost.code })).t, 'ok');
    await offlineHost.client.terminate();

    const puppeteer = (await import('puppeteer-core')).default;
    browser = await puppeteer.launch({ executablePath: EDGE, headless: true, args: ['--no-first-run', '--no-sandbox'] });
    report.browser = await browser.version();
    const login = async (name) => {
      // Separate storage avoids reconnect-token sharing between test identities.
      const context = await browser.createBrowserContext();
      const page = await context.newPage();
      page.setDefaultTimeout(10000);
      page.setDefaultNavigationTimeout(30000);
      page.on('pageerror', (error) => errors.push(`${name}: ${error.message}`));
      await page.setViewport({ width: 1920, height: 1080 });
      await page.goto(server.url, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => !!globalThis.__SP__);
      await page.type('.title-login input', name);
      await page.click('.title-login > .btn--primary');
      await page.waitForSelector('.lobby-screen');
      return page;
    };
    const hostPage = await login('转让原房主');
    assert.equal((await intent(hostPage, 'room.create', { mode: 'coop', difficulty: 'NORMAL', capacity: 4 })).t, 'ok');
    await hostPage.waitForSelector('.room-screen');
    const code = await hostPage.evaluate(() => globalThis.__SP__.store.get().room.code);
    const hostId = await hostPage.evaluate(() => globalThis.__SP__.store.get().me.playerId);
    const guestPage = await login('转让新房主');
    assert.equal((await intent(guestPage, 'room.join', { code })).t, 'ok');
    await guestPage.waitForSelector('.room-screen');
    const guestId = await guestPage.evaluate(() => globalThis.__SP__.store.get().me.playerId);
    const directoryPage = await login('房间列表博士');
    await directoryPage.waitForFunction((selector) => document.querySelector(selector)?.textContent === '3', {}, SELECTOR('room-count'));
    assert.equal(await directoryPage.$eval(SELECTOR('match-count'), (el) => el.textContent), '1', 'retained match remains in totals');
    await directoryPage.click(SELECTOR('directory-open'));
    await directoryPage.waitForSelector(`[data-room-code="${retained.code}"].is-retained`);
    assert.match(await directoryPage.$eval(`[data-room-code="${retained.code}"] .lobby-directory__status`, (el) => el.textContent), /进行中/);
    assert.match(await directoryPage.$eval(`[data-room-code="${retained.code}"] .lobby-directory__offline`, (el) => el.textContent), /断线保留/);
    assert.equal(await directoryPage.$$eval('.lobby-directory__room', (rows) => rows.at(-1).dataset.roomCode), retained.code);
    assert.equal(await directoryPage.$(`[data-room-code="${offlineHost.code}"].is-retained`), null);
    assert.match(await directoryPage.$eval(`[data-room-code="${offlineHost.code}"] .lobby-directory__offline`, (el) => el.textContent), /房主离线/);
    assert.equal(await directoryPage.$eval(`[data-room-code="${retained.code}"] .lobby-directory__offline`, (el) => el.textContent.includes('房主离线')), false, 'retention indicator replaces misleading host-offline label');
    await directoryPage.mouse.move(1916, 4);
    await directoryPage.waitForFunction(() => document.querySelector('.modal')?.getAnimations({ subtree: true })
      .every((animation) => animation.playState === 'finished'));
    await directoryPage.screenshot({ path: path.join(OUT, 'retained-directory-1920.png') });
    report.scenes.push({ screen: 'directory', viewport: { width: 1920, height: 1080 }, roomCount: 3, matchCount: 1, retainedSolo: retained.code, hostOfflineWithHuman: offlineHost.code });
    const restored = await TestClient.connect(`ws://127.0.0.1:${server.port}/ws`);
    clients.push(restored);
    const restoredIdentity = await restored.hello('断线独立博士', retained.token);
    assert.equal(restoredIdentity.playerId, retained.playerId);
    assert.equal(restoredIdentity.resumed, true);
    await restored.waitFor('m.public');
    await directoryPage.waitForFunction((roomCode) => !document.querySelector(`[data-room-code="${roomCode}"]`)?.classList.contains('is-retained'), {}, retained.code);
    assert.ok(server.lobby.rooms.get(retained.code).match, 'directory labeling does not destroy the recoverable match');
    report.scenes.push({ screen: 'resume', code: retained.code, originalIdentity: true, matchPreserved: true });
    await directoryPage.keyboard.press('Escape');

    // Real server state for nine layouts, not synthetic store rendering. All contain two connected humans.
    for (const capacity of [4, 8, 20]) {
      assert.equal((await intent(hostPage, 'room.setCapacity', { capacity })).t, 'ok');
      await hostPage.waitForFunction((expected) => globalThis.__SP__.store.get().room.capacity === expected, {}, capacity);
      for (const viewport of [{ width: 1920, height: 1080 }, { width: 1280, height: 720 }, { width: 844, height: 390 }]) {
        await hostPage.setViewport(viewport);
        await hostPage.waitForSelector(TRANSFER);
        await idleCards(hostPage);
        await hostPage.$eval(TRANSFER, (el) => el.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
        await hostPage.mouse.move(viewport.width - 4, 4);
        const layout = await hostPage.evaluate((transferSelector, kickSelector) => {
          const rect = (el) => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
          const transfer = document.querySelector(transferSelector), seat = transfer.closest('.seat');
          const kick = seat.querySelector(kickSelector), state = seat.querySelector('.seat__state');
          const hit = (el) => { const r = el.getBoundingClientRect(); const target = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return { matched: target === el || el.contains(target), target: target?.outerHTML.slice(0, 400) }; };
          const transferHit = hit(transfer), kickHit = hit(kick);
          const before = (el) => { const s = getComputedStyle(el, '::before'); return { content: s.content, width: s.width, height: s.height, left: s.left, transform: s.transform, pointerEvents: s.pointerEvents }; };
          return { transfer: rect(transfer), kick: rect(kick), state: rect(state), seat: rect(seat),
            transferHit: transferHit.matched, kickHit: kickHit.matched, hitTargets: { transfer: transferHit.target, kick: kickHit.target }, hitAreas: { transfer: before(transfer), kick: before(kick), htmlClass: document.documentElement.className }, rootScrollWidth: document.documentElement.scrollWidth,
            viewportWidth: innerWidth, seatCount: document.querySelectorAll('.seat').length, humanCount: globalThis.__SP__.store.get().room.seats.filter((s) => s && !s.isBot).length };
        }, TRANSFER, KICK);
        report.layouts.push({ capacity, ...viewport, ...layout });
        await hostPage.screenshot({ path: path.join(OUT, `room-${capacity}-${viewport.width}.png`) });
        assert.equal(layout.seatCount, capacity);
        assert.equal(layout.humanCount, 2);
        assert.ok(layout.transfer.right <= layout.kick.left + 1, `transfer/kick overlap at ${capacity} seats ${viewport.width}px`);
        assert.ok(layout.state.right <= layout.transfer.left + 1, `status/actions overlap at ${capacity} seats ${viewport.width}px`);
        assert.ok(layout.transfer.left >= layout.seat.left && layout.kick.right <= layout.seat.right, 'actions stay in their seat card');
        assert.ok(layout.transferHit && layout.kickHit, `both buttons have unobstructed click targets at ${capacity} seats ${viewport.width}px`);
        assert.ok(layout.rootScrollWidth <= layout.viewportWidth + 2, 'room does not introduce document horizontal overflow');
      }
    }

    await hostPage.setViewport({ width: 1920, height: 1080 });
    await guestPage.setViewport({ width: 1920, height: 1080 });
    // Verify cancellation does not alter authority, then complete the actual UI handover.
    await hostPage.click(TRANSFER);
    await hostPage.waitForFunction(() => document.querySelector('.modal__text')?.textContent.includes('双方座位保持不变'));
    await hostPage.keyboard.press('Escape');
    await hostPage.waitForFunction(() => !document.querySelector('.modal'));
    assert.equal(await hostPage.evaluate(() => globalThis.__SP__.store.get().room.hostId), hostId);
    await hostPage.click(TRANSFER);
    await hostPage.waitForSelector('.modal [data-autofocus]');
    await hostPage.click('.modal [data-autofocus]');
    await guestPage.waitForFunction((id) => globalThis.__SP__.store.get().room.hostId === id, {}, guestId);
    const swapped = await guestPage.evaluate(() => globalThis.__SP__.store.get().room);
    assert.equal(swapped.seats[0].playerId, hostId);
    assert.equal(swapped.seats[0].seat, 0);
    assert.equal(swapped.seats[1].playerId, guestId);
    assert.equal(swapped.seats[1].seat, 1);
    await hostPage.waitForFunction(() => !document.querySelector('[aria-label="转让房主给该博士"]'));
    assert.equal((await intent(hostPage, 'room.addBot')).code, 'NOT_HOST', 'server also revokes old host authority');
    await guestPage.waitForSelector(TRANSFER);
    assert.equal(await guestPage.$eval('.room-bar__right .btn--xl', (el) => el.disabled), true, 'new host waits for original host readiness');
    await hostPage.click('.room-bar__right .btn--xl');
    await guestPage.waitForFunction(() => !document.querySelector('.room-bar__right .btn--xl')?.disabled);
    for (let i = 0; i < 5; i++) assert.equal((await intent(guestPage, 'room.addBot')).t, 'ok');
    await guestPage.waitForFunction(() => globalThis.__SP__.store.get().room.seats.filter((s) => s?.isBot).length === 5);
    assert.equal(await guestPage.$('.room-ai-limit'), null, 'unrestricted rooms have no invented limit badge');

    const apply = async (value, expectedBots) => {
      const began = Date.now();
      report.commands.push(configure(settingsDir, value));
      const expectedLimit = value === 'unlimited' ? null : Number(value);
      await guestPage.waitForFunction((limit, bots) => {
        const room = globalThis.__SP__.store.get().room;
        return room?.maxAiPerRoom === limit && room.seats.filter((s) => s?.isBot).length === bots;
      }, {}, expectedLimit, expectedBots);
      report.scenes.push({ screen: 'live-ai-limit', capacity: 20, humans: 2, bots: expectedBots, maxAiPerRoom: expectedLimit, elapsedMs: Date.now() - began });
    };
    await apply('2', 2);
    assert.match(await guestPage.$eval('.room-ai-limit', (el) => el.textContent), /AI 队友 2 \/ 2/);
    assert.equal(await guestPage.$$eval('.seat--empty .seat__foot button', (buttons) => buttons.length > 0 && buttons.every((button) => button.disabled)), true);
    assert.equal(await guestPage.$$eval('.seat--empty .seat__swap', (buttons) => buttons.length > 0 && buttons.every((button) => !button.disabled)), true, 'AI ceiling does not block moving to an empty seat');
    assert.equal((await intent(guestPage, 'room.addBot')).code, 'AI_LIMIT');
    await idleCards(guestPage);
    await guestPage.mouse.move(1916, 4);
    await guestPage.screenshot({ path: path.join(OUT, 'ai-limit-2-host-p2-1920.png') });
    await apply('0', 0);
    assert.match(await guestPage.$eval('.room-ai-limit', (el) => el.textContent), /AI 队友 0 \/ 0/);
    assert.equal((await intent(guestPage, 'room.addBot')).code, 'AI_LIMIT');
    await apply('unlimited', 0);
    await guestPage.waitForFunction(() => !document.querySelector('.room-ai-limit'));
    assert.equal((await intent(guestPage, 'room.addBot')).t, 'ok');
    await guestPage.waitForFunction(() => globalThis.__SP__.store.get().room.seats.filter((s) => s?.isBot).length === 1);
    assert.equal((await intent(hostPage, 'room.transferHost', { playerId: guestId })).code, 'NOT_HOST');
    report.handover = { code, oldHost: hostId, newHost: guestId, newHostSeat: 1, oldHostSeat: 0, readinessVerified: true };

    // Persisted policy is server-private; HTTP clients cannot read its path or operator command.
    assert.equal((await fetch(`${server.url}/runtime/server-settings.json`)).status, 404);
    assert.equal((await fetch(`${server.url}/tools/server-settings.mjs`)).status, 404);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(settingsDir, 'server-settings.json'), 'utf8')),
      { version: 1, maxAiPerRoom: null, requireAssetCache: false, assetCacheLimits: null });
    assert.deepEqual(errors, []);
  } finally {
    if (browser) { await browser.close(); report.cleanup.browserClosed = true; }
    await Promise.all(clients.map((client) => client.terminate()));
    report.cleanup.clientsClosed = true;
    if (server) {
      const port = server.port;
      await server.close();
      report.cleanup.serverClosed = true;
      report.cleanup.portClosed = await fetch(`http://127.0.0.1:${port}/health`).then(() => false, () => true);
    }
    await fs.mkdir(OUT, { recursive: true });
    await fs.writeFile(path.join(OUT, 'report.json'), `${JSON.stringify({ ...report, errors }, null, 2)}\n`, 'utf8');
  }
});
