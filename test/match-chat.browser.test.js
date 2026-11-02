// Short Edge + real WebSocket chat regression. The controllable stub changes views without simulating battles.
// SP_E2E=1 node --test test/match-chat.browser.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../server/index.js';
import { StubMatch } from '../server/match/StubMatch.js';
import { PHASE } from '../shared/constants.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, '.cache', 'match-chat-ui', `run-${Date.now()}`);
const EDGE = process.env.CHROME_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const TOGGLE = '[data-match-chat-toggle]';
const PANEL = '[data-testid="match-chat-panel"]';
const INPUT = '[data-testid="match-chat-input"]';
const SEND = '[data-testid="match-chat-send"]';

/** Real lobby/session/wire transport, held screens and no combat/automatic end timers. */
class ControlledChatMatch extends StubMatch {
  constructor(opts) {
    super(opts);
    this.stageId = Object.keys(opts.data?.stages || {})[0] || null;
    this.bandId = Object.keys(opts.data?.bands || {})[0] || null;
    this.spectators = new Set(opts.spectators || []);
  }
  start() { this.show(PHASE.INFO_CHECK); }
  show(phase) {
    this.phase = phase;
    this.deadline = this.now() + 600000;
    this.broadcastFn(this.publicView());
    for (const p of this.players.values()) if (!p.isBot && !p.left) this.sendFn(p.playerId, this.privateView(p));
  }
  publicView() {
    const view = super.publicView();
    view.stageId = this.stageId;
    view.round = this.phase === PHASE.INFO_CHECK || this.phase === PHASE.BAND_DRAFT ? 0 : 1;
    view.players = view.players.map((p) => ({ ...p, lp: 17, bandId: this.bandId,
      alive: this.players.get(p.playerId).alive !== false, autoplay: !!this.players.get(p.playerId).autoplay }));
    const playerIds = view.players.map((p) => p.playerId);
    view.poolGroups = [{ id: 1, playerIds: playerIds.slice(0, 4) }, { id: 2, playerIds: playerIds.slice(4) }];
    return view;
  }
  privateView(p) {
    return { ...super.privateView(p), lp: 17, alive: p.alive !== false, bandId: this.bandId, ready: false };
  }
  addSpectator(playerId) { this.spectators.add(playerId); this.sendFn(playerId, this.publicView()); }
  removeSpectator(playerId) { this.spectators.delete(playerId); }
}

function intent(page, t, fields = {}) {
  return page.evaluate(async (type, payload) => {
    try { return await globalThis.__SP__.net.request(type, payload); }
    catch (error) { return { t: 'error', code: error.code, message: error.message }; }
  }, t, fields);
}

const overlap = (a, b) => a.left < b.right - 1 && a.right > b.left + 1 && a.top < b.bottom - 1 && a.bottom > b.top + 1;

async function chatState(page) {
  return page.evaluate(async () => (await import('/js/matchChat.js')).chatStore.get());
}

async function closeChat(page) {
  if (await page.$(PANEL)) {
    await page.keyboard.press('Escape');
    await page.waitForFunction((selector) => !document.querySelector(selector), {}, PANEL);
  }
}

async function openChat(page) {
  if (!(await page.$(PANEL))) {
    await page.waitForSelector(TOGGLE, { visible: true });
    await page.$eval(TOGGLE, (el) => el.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
    await page.click(TOGGLE);
    await page.waitForSelector(INPUT, { visible: true });
  }
}

async function setDraft(page, text) {
  await page.$eval(INPUT, (el, value) => { el.value = value; el.dispatchEvent(new Event('input', { bubbles: true })); }, text);
  await page.waitForFunction(async (value) => (await import('/js/matchChat.js')).chatStore.get().draft === value, {}, text);
}

async function waitMessage(page, text) {
  await page.waitForFunction(async (value) => (await import('/js/matchChat.js')).chatStore.get().messages.some((m) => m.text === value), {}, text);
}

async function geometry(page) {
  return page.evaluate((toggle, panel, input, send) => {
    const rect = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
    };
    const hit = (el) => {
      const r = el.getBoundingClientRect();
      const target = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return target === el || el.contains(target);
    };
    const controls = [...document.querySelectorAll('.gm__corner button')].map((el) => ({
      label: el.textContent.trim() || el.getAttribute('aria-label'), class: el.className, ...rect(el), hit: hit(el),
    }));
    const container = document.querySelector(panel);
    return { toggle: rect(document.querySelector(toggle)), panel: rect(container),
      input: rect(document.querySelector(input)), send: rect(document.querySelector(send)),
      sendHit: container ? hit(document.querySelector(send)) : null,
      closeHit: container ? hit(container.querySelector('.mchat-panel__close')) : null,
      controls, team: rect(document.querySelector('.team--many')), shop: rect(document.querySelector('.shopbar')),
      scrollWidth: document.documentElement.scrollWidth, width: innerWidth, height: innerHeight,
      coarse: document.documentElement.classList.contains('sp-coarse'),
      players: globalThis.__SP__.store.get().match.public.players.length };
  }, TOGGLE, PANEL, INPUT, SEND);
}

test('Edge match-only chat remains separate, readable and usable for players/spectators across short phases', {
  skip: process.env.SP_E2E === '1' ? false : 'set SP_E2E=1 (uses Edge)', timeout: 120000,
}, async (t) => {
  let server, browser;
  const errors = [], contexts = [];
  const report = { layouts: [], scenes: [], cleanup: {} };
  const settingsDir = path.join(OUT, 'server-settings');
  try {
    await fs.mkdir(settingsDir, { recursive: true });
    await fs.writeFile(path.join(settingsDir, 'server-settings.json'),
      `${JSON.stringify({ version: 1, maxAiPerRoom: null, requireAssetCache: false })}\n`, 'utf8');
    server = await startServer({ port: 0, host: '127.0.0.1', quiet: true, MatchClass: ControlledChatMatch,
      announcementsDir: path.join(OUT, 'announcements'), serverSettingsDir: settingsDir });
    report.port = server.port;
    // Advancing only the chat/lobby clock avoids sleeps for chat throttling; no simulator runs in this fixture.
    let chatNow = Date.now();
    server.lobby.now = () => chatNow;
    const tick = () => { chatNow += 2000; };
    const puppeteer = (await import('puppeteer-core')).default;
    browser = await puppeteer.launch({ executablePath: EDGE, headless: true, args: ['--no-first-run', '--no-sandbox'] });
    report.browser = await browser.version();
    const login = async (name) => {
      const context = await browser.createBrowserContext(); contexts.push(context);
      const page = await context.newPage();
      page.setDefaultTimeout(15000);
      page.on('pageerror', (error) => errors.push(`${name}: ${error.message}`));
      await page.setViewport({ width: 1920, height: 1080 });
      await page.goto(server.url, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.title-login input');
      await page.type('.title-login input', name);
      await page.click('.title-login > .btn--primary');
      await page.waitForSelector('.lobby-screen');
      return page;
    };
    const host = await login('聊天房主'), guest = await login('聊天队友'), viewer = await login('聊天观战');
    assert.equal((await intent(host, 'room.create', { mode: 'coop', difficulty: 'NORMAL', capacity: 20 })).t, 'ok');
    await host.waitForSelector('.room-screen');
    const code = await host.evaluate(() => globalThis.__SP__.store.get().room.code);
    assert.equal((await intent(guest, 'room.join', { code })).t, 'ok');
    assert.equal((await intent(guest, 'room.ready', { ready: true })).t, 'ok');
    for (let i = 0; i < 18; i++) assert.equal((await intent(host, 'room.addBot')).t, 'ok');
    assert.equal((await intent(host, 'room.start')).t, 'ok');
    const room = server.lobby.getRoom(code), match = room.match, initialCtx = room.matchCtx;
    for (const page of [host, guest]) await page.waitForSelector('.mchat-brief-entry');
    await openChat(host);
    await setDraft(host, '开局确认消息😀');
    await host.keyboard.press('Enter');
    for (const page of [host, guest]) await waitMessage(page, '开局确认消息😀');
    assert.equal((await chatState(host)).draft, '');
    await host.waitForSelector('.mchat-line__avatar');
    assert.equal(await host.$eval('.mchat-line:first-child .mchat-line__group', (el) => el.textContent), 'A');
    assert.equal(await host.$eval('.mchat-line:first-child .mchat-line__seat', (el) => el.textContent), 'P1');
    assert.equal(await host.$eval('.mchat-line:first-child .mchat-line__who > b', (el) => el.textContent), '聊天房主');
    assert.ok(await host.$('.mchat-line:first-child .mchat-line__avatar .pavatar__img'));
    assert.equal(await host.$('.mchat-panel__note'), null, '本局保留提示行已移除');
    await guest.waitForSelector('.mchat-toggle__badge');
    assert.equal(await guest.$eval('.mchat-toggle__badge', (el) => el.textContent), '1');
    await openChat(guest);
    await guest.waitForFunction(() => !document.querySelector('.mchat-toggle__badge'));
    assert.equal((await intent(viewer, 'room.spectate', { code })).t, 'ok');
    await viewer.waitForSelector(TOGGLE);
    await waitMessage(viewer, '开局确认消息😀');
    await openChat(viewer);
    const literal = '<img src=x onerror="globalThis.chatInjected=1"> & <script>alert(1)</script>';
    await setDraft(viewer, literal); tick();
    await viewer.click(SEND);
    for (const page of [host, guest, viewer]) await waitMessage(page, literal);
    assert.equal(await host.$eval('.mchat-panel__messages', (el) => el.querySelector('.mchat-line > p img, .mchat-line > p script') !== null), false);
    assert.equal(await host.evaluate(() => globalThis.chatInjected), undefined);
    assert.equal((await chatState(host)).messages.at(-1).spectator, true);
    assert.equal((await chatState(host)).messages.at(-1).seat, null);
    report.scenes.push({ phase: PHASE.INFO_CHECK, humans: 2, ai: 18, spectators: 1, unread: true, literalMarkup: true });

    // IME confirmation and Shift+Enter never send; regular Enter sends once and Escape closes only chat.
    const beforeIME = initialCtx.chat.seq;
    await setDraft(host, '中文输入法候选');
    await host.$eval(INPUT, (el) => {
      el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, isComposing: true, bubbles: true, cancelable: true }));
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true }));
    });
    await host.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(initialCtx.chat.seq, beforeIME);
    assert.equal((await chatState(host)).draft, '中文输入法候选');
    await host.$eval(INPUT, (el) => el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })));
    tick(); await host.keyboard.press('Enter');
    await waitMessage(guest, '中文输入法候选');
    assert.equal(initialCtx.chat.seq, beforeIME + 1);
    await setDraft(host, '😀'.repeat(201));
    assert.equal(await host.$eval(SEND, (el) => el.disabled), true, '201 Unicode code points cannot be sent');
    await setDraft(host, '😀'.repeat(200));
    assert.equal(await host.$eval(SEND, (el) => el.disabled), false, '200 supplementary characters remain usable');
    tick(); await host.click(SEND); await waitMessage(guest, '😀'.repeat(200));
    await closeChat(host);
    assert.equal(await host.$('.exit-modal,.modal'), null, 'Escape does not request leaving the match');

    // These are held UI/network phases, not battle simulations or a fourteen-round playthrough.
    for (const [phase, selector] of [[PHASE.BAND_DRAFT, '.mchat-draft-entry'], [PHASE.PREP, '.gm__chat'],
      [PHASE.SP_DRAFT, '.gm__chat'], [PHASE.COMBAT, '.gm__chat']]) {
      match.show(phase);
      await host.waitForFunction((expected) => globalThis.__SP__.store.get().match.public?.phase === expected, {}, phase);
      await host.waitForSelector(selector);
      await openChat(host);
      const text = `${phase}阶段消息`; tick();
      await setDraft(host, text); await host.click(SEND);
      for (const page of [host, guest, viewer]) await waitMessage(page, text);
      assert.equal((await chatState(host)).matchId, initialCtx.chat.matchId);
      await closeChat(host);
      report.scenes.push({ phase, sharedHistory: true, receivedBySpectator: true });
    }

    match.show(PHASE.PREP);
    await host.waitForFunction(() => globalThis.__SP__.store.get().match.public?.phase === 'PREP');
    await host.waitForFunction(() => !document.querySelector('.pbanner'));
    for (const viewport of [{ width: 1920, height: 1080 }, { width: 1280, height: 720 },
      { width: 844, height: 390, hasTouch: true }, { width: 756, height: 366, hasTouch: true },
      { width: 390, height: 844, hasTouch: true }]) {
      await host.setViewport(viewport);
      await host.waitForSelector('.gm__chat');
      await host.mouse.move(viewport.width - 4, 4);
      const closed = await geometry(host);
      if (viewport.width < viewport.height) {
        const rotateHint = await host.$eval('.rotate-hint', (el) => ({ display: getComputedStyle(el).display, text: el.textContent.trim() }));
        assert.equal(rotateHint.display, 'grid', 'the existing portrait guard continues to request landscape');
        assert.match(rotateHint.text, /横屏/);
        await host.screenshot({ path: path.join(OUT, `portrait-guard-${viewport.width}.png`) });
        report.layouts.push({ ...viewport, closed, rotateHint, chatNotInteractive: 'existing landscape-only game policy' });
        continue;
      }
      assert.equal(closed.players, 20);
      assert.ok(closed.controls.length >= 5, 'independent chat plus the original four controls');
      for (const control of closed.controls) {
        assert.ok(control.hit, `${viewport.width}: ${control.class} unobstructed`);
        assert.ok(control.left >= -1 && control.right <= viewport.width + 1 && control.top >= 0 && control.bottom <= viewport.height + 1,
          `${viewport.width}: ${control.class} inside viewport`);
      }
      for (let a = 0; a < closed.controls.length; a++) for (let b = a + 1; b < closed.controls.length; b++) {
        assert.equal(overlap(closed.controls[a], closed.controls[b]), false, `${viewport.width}: corner controls remain separate`);
      }
      assert.ok(!closed.team || !overlap(closed.team, closed.toggle), `${viewport.width}: scrolling team does not cover chat`);
      assert.ok(closed.shop && !overlap(closed.shop, closed.toggle), `${viewport.width}: shop does not cover chat`);
      await openChat(host);
      const opened = await geometry(host);
      assert.ok(opened.panel.left >= 0 && opened.panel.right <= viewport.width + 1 && opened.panel.top >= 0 && opened.panel.bottom <= viewport.height + 1,
        `${viewport.width}: full chat panel inside viewport`);
      assert.ok(opened.sendHit && opened.closeHit, `${viewport.width}: send and close can be clicked`);
      assert.ok(opened.input.top >= opened.panel.top && opened.input.bottom <= opened.panel.bottom + 1, 'editor stays within panel');
      assert.ok(opened.panel.width >= Math.min(viewport.width - 24, 360) - 1, `${viewport.width}: chat panel keeps the wider layout`);
      assert.ok(opened.input.height <= Math.max(40, viewport.width / 1920 * 58) + 2,
        `${viewport.width}: input height stays compact`);
      assert.equal(overlap(opened.panel, opened.toggle), false, 'panel sits above its button');
      await host.screenshot({ path: path.join(OUT, `chat-prep-${viewport.width}.png`) });
      report.layouts.push({ ...viewport, closed, opened });
      await closeChat(host);
      await host.click('.ewheel__btn');
      await host.waitForSelector('.ewheel__panel');
      assert.equal(await host.$(PANEL), null);
      const withEmotes = await geometry(host);
      report.layouts.at(-1).withEmotes = withEmotes;
      await host.screenshot({ path: path.join(OUT, `emotes-prep-${viewport.width}.png`) });
      assert.ok(withEmotes.controls.find((control) => control.class.includes('gm__chat')).hit,
        `${viewport.width}: open emotes do not cover the independent chat button`);
      await host.click('.gm__chat');
      await host.waitForSelector(PANEL);
      await host.waitForFunction(() => !document.querySelector('.ewheel__panel'));
      await closeChat(host);
      if (viewport.width === 844) {
        for (const lang of ['zh-CN', 'en', 'ja', 'ko', 'zh-TW']) {
          await host.evaluate(async (locale) => {
            await (await import('/js/ui/lang.js')).switchLang(locale);
            (await import('/js/ui/settings.js')).updateSettings({ textSize: 'xl' });
          }, lang);
          await openChat(host);
          const localized = await geometry(host);
          assert.ok(localized.panel.left >= 0 && localized.panel.right <= viewport.width + 1
            && localized.panel.top >= 0 && localized.panel.bottom <= viewport.height + 1, `${lang} XL: panel fits`);
          assert.ok(localized.sendHit && localized.closeHit, `${lang} XL: send and close remain accessible`);
          const textOverflow = await host.$eval('.gm__chat', (el) => el.scrollWidth - el.clientWidth);
          assert.ok(textOverflow <= 1, `${lang} XL: independent button label fits its frame`);
          await host.screenshot({ path: path.join(OUT, `chat-prep-${viewport.width}-${lang}-xl.png`) });
          report.scenes.push({ phase: PHASE.PREP, lang, textSize: 'xl', width: viewport.width, height: viewport.height,
            panel: localized.panel, sendHit: localized.sendHit, closeHit: localized.closeHit });
          await closeChat(host);
        }
        await host.evaluate(async () => {
          await (await import('/js/ui/lang.js')).switchLang('zh-CN');
          (await import('/js/ui/settings.js')).updateSettings({ textSize: 'sm' });
        });
      }
      if (viewport.width === 756) {
        await host.waitForFunction(() => !!globalThis.__SP_VIEW__?.tileScreen(3, 3)?.s);
        await host.evaluate(() => new Promise((resolve) => setTimeout(resolve, 350)));
        const beforeFold = await host.evaluate(() => globalThis.__SP_VIEW__.tileScreen(3, 3).s);
        await host.click('.funds__collapse'); await host.waitForSelector('.gm.is-collapsed');
        await host.waitForFunction((previous) => globalThis.__SP_VIEW__?.tileScreen(3, 3)?.s > previous * 1.01,
          { timeout: 3000 }, beforeFold);
        const folded = await geometry(host);
        assert.ok(folded.controls.every((control) => control.hit), 'narrow folded corner controls remain clickable');
        const foldedScale = await host.evaluate(() => globalThis.__SP_VIEW__.tileScreen(3, 3).s);
        await openChat(host);
        const foldedChat = await geometry(host);
        assert.ok(foldedChat.sendHit && foldedChat.closeHit, 'narrow folded chat remains accessible');
        await host.screenshot({ path: path.join(OUT, 'chat-folded-756.png') });
        report.scenes.push({ width: 756, height: 366, folded: true, beforeFold, foldedScale, cornerUsable: true });
        await closeChat(host); await host.click('.shopbar-tab__btn');
        await host.waitForFunction(() => !document.querySelector('.gm.is-collapsed'));
      }
    }

    // Eliminated and supervised human seats keep an accessible chat entrance.
    await host.setViewport({ width: 844, height: 390, hasTouch: true });
    const hostId = await host.evaluate(() => globalThis.__SP__.store.get().me.playerId);
    const controlled = match.players.get(hostId);
    controlled.alive = false; controlled.autoplay = true; match.show(PHASE.PREP);
    await host.waitForSelector('.mchat-away-entry');
    await host.click('.mchat-away-entry'); await host.waitForSelector(INPUT);
    tick(); await setDraft(host, '托管淘汰仍可聊天'); await host.click(SEND);
    await waitMessage(guest, '托管淘汰仍可聊天');
    await closeChat(host);
    controlled.alive = true; controlled.autoplay = false; match.show(PHASE.PREP);
    await host.waitForFunction(() => !document.querySelector('.mchat-away-entry'));
    report.scenes.push({ eliminatedAndAutoplay: true });

    // Same document and identity reconnect retain RAM draft/history, then receive the server snapshot.
    await host.setViewport({ width: 1280, height: 720, hasTouch: true });
    await openChat(host); await setDraft(host, '重连未发送草稿');
    const beforeReconnect = await chatState(host);
    const resumed = await host.evaluate(async () => {
      const net = globalThis.__SP__.net, id = net.playerId;
      const welcome = new Promise((resolve) => { const off = net.on('welcome', () => { off(); resolve(); }); });
      net.reconnectNow(); await welcome;
      return { sameId: net.playerId === id, status: net.status };
    });
    assert.deepEqual(resumed, { sameId: true, status: 'online' });
    await host.waitForFunction(async (seq) => (await import('/js/matchChat.js')).chatStore.get().seq === seq, {}, beforeReconnect.seq);
    const afterReconnect = await chatState(host);
    assert.equal(afterReconnect.draft, beforeReconnect.draft);
    assert.deepEqual(afterReconnect.messages, beforeReconnect.messages);
    report.scenes.push({ reconnect: true, retainedDraft: true, retainedHistory: true });

    match.maybeFinish(true);
    for (const page of [host, guest, viewer]) {
      await page.waitForFunction(async () => (await import('/js/matchChat.js')).chatStore.get().matchId === null);
      const cleared = await chatState(page);
      assert.deepEqual(cleared.messages, []); assert.equal(cleared.draft, ''); assert.equal(cleared.open, false);
      assert.equal(await page.$(TOGGLE), null); assert.equal(await page.$(PANEL), null);
      const persisted = await page.evaluate(() => {
        const stores = [localStorage, sessionStorage];
        return stores.some((storage) => Object.keys(storage).some((key) => String(storage.getItem(key)).includes('重连未发送草稿')));
      });
      assert.equal(persisted, false, 'chat draft never enters browser persistence');
    }
    assert.equal(initialCtx.chat.messages.length, 0); assert.equal(initialCtx.chat.closed, true);
    assert.equal(JSON.stringify(room.replay).includes('阶段消息'), false);
    report.scenes.push({ resultCleared: true, replayExcludesChat: true, browserStorageExcludesChat: true });
    assert.deepEqual(errors, []);
    t.diagnostic(`${report.browser}; 2 humans + 18 AI + 1 spectator, five layouts and five languages XL, no battle simulation`);
  } finally {
    await Promise.all(contexts.map((context) => context.close().catch(() => {})));
    if (browser) { await browser.close(); report.cleanup.browserClosed = true; }
    if (server) {
      const port = server.port; await server.close(); report.cleanup.serverClosed = true;
      report.cleanup.portClosed = await fetch(`http://127.0.0.1:${port}/healthz`).then(() => false, () => true);
    }
    await fs.mkdir(OUT, { recursive: true });
    await fs.writeFile(path.join(OUT, 'report.json'), `${JSON.stringify({ ...report, errors }, null, 2)}\n`, 'utf8');
  }
});
