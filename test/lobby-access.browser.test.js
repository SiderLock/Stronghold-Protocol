// Short Edge + real WebSocket directory admission regression; no battle or full-round simulation.
// SP_E2E=1 node --test test/lobby-access.browser.test.js
// Add SP_E2E_PANEL_ONLY=1 to recheck only the responsive statistics after a local CSS adjustment.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../server/index.js';
import { StubMatch } from '../server/match/StubMatch.js';
import { TestClient } from './helpers/wsClient.js';
import { PHASE } from '../shared/constants.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, '.cache', 'lobby-access-ui', `run-${Date.now()}`);
const EDGE = process.env.CHROME_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const SELECTOR = (name) => `[data-testid="lobby-${name}"]`;
const SWITCH = '[data-testid="room-matchmaking"]';
const PANEL_ONLY = process.env.SP_E2E_PANEL_ONLY === '1';
const row = (id) => `[data-room-id="${id}"]`;

/** Hold the initial public view and implement the production spectator resync interface. */
class AccessMatch extends StubMatch {
  constructor(opts) { super(opts); this.infoCheckMs = 180000; }
  addSpectator(playerId) { this.sendFn(playerId, this.publicView()); }
  removeSpectator() {}
  publicView() {
    const view = super.publicView();
    view.players = view.players.map((p) => ({ ...p, alive: this.players.get(p.playerId).alive !== false,
      autoplay: !!this.players.get(p.playerId).autoplay }));
    return view;
  }
}

function intent(page, type, payload = {}) {
  return page.evaluate(async (t, fields) => {
    try { return await globalThis.__SP__.net.request(t, fields); }
    catch (error) { return { t: 'error', code: error.code, message: error.message }; }
  }, type, payload);
}

async function animationsDone(page) {
  await page.waitForFunction(() => [...document.querySelectorAll('.modal, .seat')].every((el) =>
    el.getAnimations({ subtree: true }).every((animation) => animation.playState === 'finished'
      || animation.effect?.getTiming().iterations === Infinity)));
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function openDirectory(page, id) {
  if (!(await page.$('.lobby-directory'))) await page.click(SELECTOR('directory-open'));
  await page.waitForSelector(row(id));
  await animationsDone(page);
}

async function closeDirectory(page) {
  if (await page.$('.lobby-directory')) {
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.lobby-directory'));
  }
}

async function waitPlaying(page, count) {
  await page.waitForFunction((selector, value) => document.querySelector(selector)?.textContent === String(value),
    {}, SELECTOR('playing-count'), count);
}

async function receivedSummary(page, id) {
  return page.evaluate((roomId) => globalThis.__lobbyQA.findLast((frame) => frame.rooms?.some((r) => r.roomId === roomId))
    ?.rooms.find((r) => r.roomId === roomId), id);
}

/** Check only the new panel/actions; existing mobile seat scrolling is an independent layout. */
async function geometry(page, containerSelector, controlSelectors) {
  return page.evaluate((containerName, selectors) => {
    const rect = (el) => {
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
    };
    const controls = selectors.map((selector) => {
      const el = document.querySelector(selector);
      const r = rect(el);
      const center = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      // Touch-target pseudo-elements enlarge scrollWidth; measure the actual label instead.
      const content = document.createRange();
      content.selectNodeContents(el.querySelector('.btn__label') || el);
      const text = content.getBoundingClientRect();
      return { selector, ...r, disabled: !!el.disabled, hit: center === el || el.contains(center),
        overflow: text.left < r.left - 1 || text.right > r.right + 1, text: el.textContent.trim() };
    });
    const container = document.querySelector(containerName);
    return { viewport: { width: innerWidth, height: innerHeight }, container: rect(container),
      overflow: container.scrollWidth > container.clientWidth + 2, controls,
      coarse: document.documentElement.classList.contains('sp-coarse') };
  }, containerSelector, controlSelectors);
}

function assertLayout(layout, scene) {
  assert.ok(layout.container.left >= -1 && layout.container.right <= layout.viewport.width + 1,
    `${scene}: new controls remain within the horizontal viewport`);
  assert.equal(layout.overflow, false, `${scene}: new container has no horizontal overflow`);
  for (const control of layout.controls) {
    assert.ok(control.width > 0 && control.height > 0, `${scene}: ${control.selector} has a visible frame`);
    assert.equal(control.overflow, false, `${scene}: ${control.selector} label fits its frame`);
    if (!control.disabled) assert.equal(control.hit, true, `${scene}: ${control.selector} center reaches its button`);
  }
}

test('Edge private matching, opaque directory access, spectator seats and live human counts work together', {
  skip: process.env.SP_E2E === '1' ? false : 'set SP_E2E=1 (uses Edge)', timeout: 120000,
}, async (t) => {
  let server, browser;
  const clients = [], errors = [], report = { scenes: [], layouts: [], screenshots: [], cleanup: {} };
  const screenshot = async (page, filename) => {
    const target = path.join(OUT, filename);
    await page.mouse.move(2, 2);
    await page.screenshot({ path: target });
    report.screenshots.push(target);
  };
  try {
    await fs.mkdir(OUT, { recursive: true });
    server = await startServer({ port: 0, host: '127.0.0.1', quiet: true, MatchClass: AccessMatch,
      announcementsDir: path.join(OUT, 'announcements'), serverSettingsDir: path.join(OUT, 'server-settings') });
    report.port = server.port;
    const connect = async (name, token) => {
      const client = await TestClient.connect(`ws://127.0.0.1:${server.port}/ws`);
      clients.push(client);
      return { client, ...await client.hello(name, token) };
    };
    const publicHost = await connect('公开八人房主');
    assert.equal((await publicHost.client.request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL', capacity: 8 })).t, 'ok');
    const publicCode = (await publicHost.client.waitFor('room.state')).code;
    const soloHost = await connect('独立游玩博士');
    assert.equal((await soloHost.client.request({ t: 'room.create', mode: 'solo', difficulty: 'NORMAL' })).t, 'ok');
    const soloCode = (await soloHost.client.waitFor('room.state')).code;
    assert.equal((await soloHost.client.request({ t: 'room.start' })).t, 'ok');

    const puppeteer = (await import('puppeteer-core')).default;
    browser = await puppeteer.launch({ executablePath: EDGE, headless: true, args: ['--no-first-run', '--no-sandbox'] });
    report.browser = await browser.version();
    const browserProcess = browser.process();
    report.browserPid = browserProcess?.pid;
    const login = async (name) => {
      const context = await browser.createBrowserContext();
      const page = await context.newPage();
      page.setDefaultTimeout(10000);
      page.on('pageerror', (error) => errors.push(`${name}: ${error.message}`));
      await page.setViewport({ width: 1920, height: 1080 });
      await page.goto(server.url, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.title-login input');
      await page.type('.title-login input', name);
      await page.click('.title-login > .btn--primary');
      await page.waitForSelector('.lobby-screen');
      await page.evaluate(() => {
        globalThis.__lobbyQA = [];
        globalThis.__SP__.net.on('lobby.state', (message) => globalThis.__lobbyQA.push(message));
      });
      return page;
    };
    const host = await login('私人同盟长名字房主');
    assert.equal((await intent(host, 'room.create', { mode: 'coop', difficulty: 'NORMAL', capacity: 4 })).t, 'ok');
    await host.waitForSelector(SWITCH);
    const hiddenCode = await host.evaluate(() => globalThis.__SP__.store.get().room.code);
    const hiddenId = server.lobby.rooms.get(hiddenCode).directoryId;
    const soloId = server.lobby.rooms.get(soloCode).directoryId;
    assert.match(hiddenId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    assert.equal((await intent(host, 'room.addBot')).t, 'ok');
    assert.equal((await intent(host, 'room.addBot')).t, 'ok');
    const directory = await login('目录与匹配博士');
    await waitPlaying(directory, 1);
    await openDirectory(directory, hiddenId);
    assert.equal((await receivedSummary(directory, hiddenId)).code, hiddenCode);
    assert.equal(await directory.$(`${row(soloId)} button`), null, 'solo offers no spectator or join action');

    // The real switch must update both room state and the subscribed public projection.
    await host.click(SWITCH);
    await host.waitForFunction((selector) => document.querySelector(selector)?.getAttribute('aria-checked') === 'false', {}, SWITCH);
    await directory.waitForFunction((selector) => document.querySelector(`${selector} .lobby-directory__join`)?.disabled
      && !document.querySelector(selector)?.hasAttribute('data-room-code'), {}, row(hiddenId));
    const privateSummary = await receivedSummary(directory, hiddenId);
    assert.equal(privateSummary.roomId, hiddenId);
    assert.equal(privateSummary.code, null);
    assert.equal(privateSummary.allowMatchmaking, false);
    assert.equal(privateSummary.spectatable, true);
    assert.equal(privateSummary.spectatorCount, 0);
    assert.equal(await directory.$eval('.lobby-directory', (el, code) => el.outerHTML.includes(code), hiddenCode), false,
      'public directory does not disclose the private invite code in text or attributes');
    assert.equal((await intent(directory, 'lobby.join', { roomId: hiddenId })).code, 'BAD_TARGET', 'stale directory requests cannot join a private room');
    await host.click(SWITCH);
    await directory.waitForSelector(`${row(hiddenId)}[data-room-code="${hiddenCode}"]`);
    await host.click(SWITCH);
    await directory.waitForSelector(`${row(hiddenId)} .lobby-directory__hidden-code`);
    assert.equal((await receivedSummary(directory, hiddenId)).roomId, hiddenId, 'toggling never changes the public identity');
    await closeDirectory(directory);
    await directory.click(SELECTOR('quick-match'));
    await directory.waitForSelector('.room-screen');
    assert.equal(await directory.evaluate(() => globalThis.__SP__.store.get().room.code), publicCode,
      'quick matching skips the closer private four-seat room');
    await directory.click('.room-screen [aria-label="离开同盟"]');
    await directory.waitForSelector('.lobby-screen');
    // Use the actual code input, rather than an opaque directory identity, to exercise intentional invitation access.
    await directory.type('.join-panel input', hiddenCode);
    await directory.click('.join-row > .btn--amber');
    await directory.waitForSelector('.room-screen');
    assert.equal(await directory.evaluate(() => globalThis.__SP__.store.get().room.code), hiddenCode);
    assert.equal(await directory.$(SWITCH), null, 'non-host does not get the policy switch');
    assert.equal(await directory.$eval('[data-testid="room-matchmaking-state"]', (el) => el.textContent.includes('禁止匹配')), true);
    assert.equal((await intent(directory, 'room.setMatchmaking', { allowed: true })).code, 'NOT_HOST');
    await directory.click('.room-screen [aria-label="离开同盟"]');
    await directory.waitForSelector('.lobby-screen');
    await openDirectory(directory, hiddenId);
    const inspectPanel = async (scene, filename) => {
      await closeDirectory(directory);
      await directory.$eval(SELECTOR('discovery'), (el) => el.scrollIntoView({ block: 'nearest' }));
      await animationsDone(directory);
      const layout = await geometry(directory, '.lobby-discovery', [SELECTOR('directory-open'), SELECTOR('quick-match')]);
      const overview = await directory.evaluate(() => {
        const heading = document.querySelector('.lobby-discovery__heading strong').getBoundingClientRect();
        const stats = document.querySelector('.lobby-discovery__stats').getBoundingClientRect();
        // Flex boxes can shrink while nowrap text still paints outside them.
        const textRects = (el) => {
          const nodes = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
          const rects = [];
          for (let node = nodes.nextNode(); node; node = nodes.nextNode()) {
            if (!node.textContent.trim()) continue;
            const range = document.createRange();
            range.selectNodeContents(node);
            rects.push(...[...range.getClientRects()].map((r) => ({ left: r.left, right: r.right, top: r.top, bottom: r.bottom })));
          }
          return rects;
        };
        return { headingRight: heading.right, statsLeft: stats.left, statsRight: stats.right,
          headingText: textRects(document.querySelector('.lobby-discovery__heading')),
          statisticText: [...document.querySelectorAll('.lobby-discovery__stats > span')].map(textRects) };
      });
      report.layouts.push({ screen: 'discovery', scene, ...layout, ...overview });
      assertLayout(layout, scene);
      assert.ok(overview.headingRight <= overview.statsLeft + 1, `${scene}: heading never overlaps the four statistics`);
      const overlaps = (a, b) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1
        && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1;
      for (const [index, label] of overview.statisticText.entries()) {
        assert.equal(label.some((r) => overview.headingText.some((h) => overlaps(r, h))), false,
          `${scene}: statistic ${index + 1} never overlaps painted heading or micro-label text`);
        for (const other of overview.statisticText.slice(index + 1)) {
          assert.equal(label.some((r) => other.some((o) => overlaps(r, o))), false,
            `${scene}: four statistics never overlap each other`);
        }
      }
      assert.ok(overview.statsRight <= layout.container.right + 1, `${scene}: four statistics fit the panel`);
      if (filename) await screenshot(directory, filename);
      await openDirectory(directory, hiddenId);
    };

    for (const viewport of [{ width: 1920, height: 1080 }, { width: 1280, height: 720 }, { width: 844, height: 390 }]) {
      await host.setViewport(viewport);
      await directory.setViewport(viewport);
      await animationsDone(host); await animationsDone(directory);
      if (!PANEL_ONLY) {
        const hostLayout = await geometry(host, '.room-capacity', [SWITCH]);
        const directoryLayout = await geometry(directory, '.lobby-directory', [`${row(hiddenId)} .lobby-directory__join`, `${row(hiddenId)} .lobby-directory__spectate`]);
        report.layouts.push({ screen: 'room-policy', ...hostLayout }, { screen: 'directory', ...directoryLayout });
        assertLayout(hostLayout, `room ${viewport.width}`);
        assertLayout(directoryLayout, `directory ${viewport.width}`);
        await screenshot(host, `policy-${viewport.width}.png`);
        await screenshot(directory, `directory-${viewport.width}.png`);
      }
      await inspectPanel(`panel ${viewport.width}`, `lobby-${viewport.width}.png`);
    }
    // Long translations at XL text are cheap to test while the held lobby view receives real server updates.
    for (const viewport of [{ width: 1280, height: 720 }, { width: 844, height: 390 }]) {
      await host.setViewport(viewport); await directory.setViewport(viewport);
      for (const locale of ['zh-CN', 'en', 'ja', 'ko', 'zh-TW']) {
        for (const page of [host, directory]) await page.evaluate(async (language) => {
          await (await import('/js/ui/lang.js')).switchLang(language);
          (await import('/js/ui/settings.js')).updateSettings({ textSize: 'xl' });
        }, locale);
        await animationsDone(host); await animationsDone(directory);
        if (!PANEL_ONLY) {
          const hostLayout = await geometry(host, '.room-capacity', [SWITCH]);
          const directoryLayout = await geometry(directory, '.lobby-directory', [`${row(hiddenId)} .lobby-directory__join`, `${row(hiddenId)} .lobby-directory__spectate`]);
          report.layouts.push({ screen: 'room-policy', locale, textSize: 'xl', ...hostLayout },
            { screen: 'directory', locale, textSize: 'xl', ...directoryLayout });
          assertLayout(hostLayout, `room ${locale} XL ${viewport.width}`);
          assertLayout(directoryLayout, `directory ${locale} XL ${viewport.width}`);
          if (locale === 'en') {
            await screenshot(host, `policy-${viewport.width}-en-xl.png`);
            await screenshot(directory, `directory-${viewport.width}-en-xl.png`);
          }
        }
        await inspectPanel(`panel ${locale} XL ${viewport.width}`, locale === 'en' ? `lobby-${viewport.width}-en-xl.png` : null);
      }
    }
    if (PANEL_ONLY) {
      report.panelOnly = true;
      assert.deepEqual(errors, []);
      t.diagnostic(`${report.browser}; statistics panel at three normal sizes and five languages XL at two sizes`);
      return;
    }
    for (const page of [host, directory]) {
      await page.evaluate(async () => {
        await (await import('/js/ui/lang.js')).switchLang('zh-CN');
        (await import('/js/ui/settings.js')).updateSettings({ textSize: 'sm' });
      });
      await page.setViewport({ width: 1920, height: 1080 });
    }

    const spectator = await login('等候阶段观战博士');
    await openDirectory(spectator, hiddenId);
    await spectator.click(`${row(hiddenId)} .lobby-directory__spectate`);
    await spectator.waitForSelector('.room-screen .specbar');
    assert.equal(await spectator.evaluate(() => globalThis.__SP__.store.get().room.spectators
      .some((s) => s.playerId === globalThis.__SP__.store.get().me.playerId)), true);
    assert.equal(await spectator.$(SWITCH), null);
    assert.equal(await spectator.$eval('.room-bar__right .btn--xl', (el) => el.disabled), true, 'waiting spectator cannot ready as a player');
    await directory.waitForFunction((selector) => document.querySelector(`${selector} .lobby-directory__spectate`)?.title.includes('1 / 2'), {}, row(hiddenId));
    await waitPlaying(directory, 1);
    const player = await connect('在线作战博士');
    assert.equal((await player.client.request({ t: 'room.join', code: hiddenCode })).t, 'ok');
    assert.equal((await player.client.request({ t: 'room.ready', ready: true })).t, 'ok');
    await host.waitForFunction(() => document.querySelector('.room-bar__right .btn--xl')?.disabled === false);
    await host.click('.room-bar__right .btn--xl');
    await spectator.waitForFunction(() => globalThis.__SP__.store.get().match.public?.phase === 'INFO_CHECK');
    await waitPlaying(directory, 3); // two connected co-op humans + one independent human, not the two AI or spectator.
    const lateSpectator = await login('运行阶段观战博士');
    await openDirectory(lateSpectator, hiddenId);
    await lateSpectator.click(`${row(hiddenId)} .lobby-directory__spectate`);
    await lateSpectator.waitForFunction(() => globalThis.__SP__.store.get().match.public?.phase === 'INFO_CHECK');
    await directory.waitForFunction((selector) => document.querySelector(`${selector} .lobby-directory__spectate`)?.disabled
      && document.querySelector(`${selector} .lobby-directory__spectate`)?.textContent.includes('观战席已满'), {}, row(hiddenId));
    assert.equal((await receivedSummary(directory, hiddenId)).code, null, 'running hidden room keeps its invite code private');
    assert.equal((await receivedSummary(directory, hiddenId)).spectatorCount, 2);
    assert.equal((await receivedSummary(directory, hiddenId)).spectatable, false);
    assert.equal(await directory.$(`${row(hiddenId)} .lobby-directory__join`), null);
    assert.equal((await intent(directory, 'lobby.spectate', { roomId: hiddenId })).code, 'ROOM_FULL');
    await waitPlaying(directory, 3);
    await screenshot(directory, 'directory-running-spectators-full.png');
    await screenshot(spectator, 'spectator-running.png');
    report.scenes.push({ phase: PHASE.INFO_CHECK, coopHumans: 2, ai: 2, spectators: 2, soloHumans: 1, playingCount: 3,
      privateInviteCodeHidden: true, waitingAndRunningSpectate: true });

    const match = server.lobby.rooms.get(hiddenCode).match;
    match.players.get(player.playerId).alive = false;
    match.players.get(player.playerId).autoplay = true;
    match.broadcastFn(match.publicView());
    assert.equal(server.lobby.discovery.projection(false).playingCount, 3, 'online eliminated/autoplay humans still count');
    await player.client.terminate();
    await waitPlaying(directory, 2);
    const resumed = await connect('在线作战博士', player.token);
    assert.equal(resumed.playerId, player.playerId);
    await waitPlaying(directory, 3);
    assert.equal((await resumed.client.request({ t: 'g.leave' })).t, 'ok');
    await waitPlaying(directory, 2);
    report.scenes.push({ humansDisconnectReconnectLeave: [3, 2, 3, 2], eliminatedAndAutoplayIncluded: true });
    const ids = await Promise.all([host, directory, spectator, lateSpectator].map((page) => page.evaluate(() => globalThis.__SP__.store.get().me.playerId)));
    assert.equal(new Set(ids).size, 4, 'independent browser contexts keep four identities and tokens separate');
    assert.deepEqual(errors, []);
    t.diagnostic(`${report.browser}; three viewports, five languages XL at two sizes, 2 co-op humans + 2 AI + 2 spectators + solo; no combat`);
  } catch (error) {
    report.failure = { name: error.name, message: error.message };
    if (browser) for (const [i, page] of (await browser.pages()).entries()) {
      if (page.url().startsWith(server?.url)) await screenshot(page, `failure-${i}.png`).catch(() => {});
    }
    throw error;
  } finally {
    if (browser) {
      const browserProcess = browser.process();
      await browser.close(); report.cleanup.browserClosed = true;
      report.cleanup.browserProcessExited = !browserProcess || browserProcess.exitCode !== null || browserProcess.signalCode !== null;
    }
    await Promise.all(clients.map((client) => client.terminate()));
    report.cleanup.clientsClosed = true;
    if (server) {
      await server.close(); report.cleanup.serverClosed = true;
      report.cleanup.portClosed = await fetch(`${server.url}/healthz`).then(() => false, () => true);
    }
    await fs.mkdir(OUT, { recursive: true });
    await fs.writeFile(path.join(OUT, 'report.json'), JSON.stringify({ ...report, errors }, null, 2) + '\n');
    assert.equal(report.cleanup.portClosed, true, 'owned HTTP listener was released');
    if (browser) assert.equal(report.cleanup.browserProcessExited, true, 'owned Edge child exited');
  }
});
