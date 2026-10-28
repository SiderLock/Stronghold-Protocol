// Responsive room cards and the in-match team list. SP_E2E=1 CHROME_PATH=<Edge> node --test this file.
// Room mutations use a real local server; the 20-member match display uses the existing game mock.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const CACHE = path.resolve(ROOT, '.cache');
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ENABLED = process.env.SP_E2E === '1' && existsSync(CHROME);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const viewport = (width, height, touch) => ({ width, height, isMobile: touch, hasTouch: touch, deviceScaleFactor: 1 });

describe('responsive room and team layout', { skip: !ENABLED && 'set SP_E2E=1 and CHROME_PATH to a browser' }, () => {
  let server, browser, base, announcementsDir;
  before(async () => {
    const { startServer } = await import('../../server/index.js');
    const puppeteer = (await import('puppeteer-core')).default;
    mkdirSync(CACHE, { recursive: true });
    announcementsDir = mkdtempSync(path.join(CACHE, 'responsive-room-announcements-'));
    server = await startServer({ port: 0, host: '127.0.0.1', quiet: true, announcementsDir });
    base = `http://127.0.0.1:${server.port}`;
    browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--mute-audio'] });
  });
  after(async () => {
    try { await browser?.close(); } finally {
      try { await server?.close(); } finally {
        if (announcementsDir) {
          assert.equal(path.dirname(announcementsDir), CACHE);
          rmSync(announcementsDir, { recursive: true, force: true });
        }
      }
    }
  });

  async function openRoom(ctx, size, name) {
    const page = await ctx.newPage();
    await page.setViewport(viewport(...size));
    await page.evaluateOnNewDocument((n) => { localStorage.setItem('sp.name', n); sessionStorage.setItem('sp.entered', '1'); }, name);
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => globalThis.__SP__?.store.get().connection.status === 'online' && !!document.querySelector('.lobby-screen'), { timeout: 30000 });
    return page;
  }
  const request = (page, type, body = {}) => page.evaluate((t, b) => globalThis.__SP__.net.request(t, b), type, body);

  test('4–20 seat cards contain their art and labels, scroll, and retain touch exchange', { timeout: 180000 }, async () => {
    const ctx = await browser.createBrowserContext();
    const guestCtx = await browser.createBrowserContext();
    try {
      const host = await openRoom(ctx, [844, 390, true], '特别长的博士名字');
      const guest = await openRoom(guestCtx, [844, 390, true], '访问者');
      await request(host, 'room.create', { mode: 'coop', difficulty: 'NORMAL', capacity: 4 });
      const code = await host.evaluate(() => globalThis.__SP__.store.get().room.code);
      await request(guest, 'room.join', { code });
      await request(host, 'room.addBot');
      await host.waitForFunction(() => document.querySelectorAll('.rseat:not(.rseat--empty)').length === 3);
      for (const capacity of [4, 8, 10, 16, 20]) {
        if (capacity !== 4) {
          const options = await host.$$('.room-capacity__opt');
          await options[[4, 8, 10, 16, 20].indexOf(capacity)].tap();
        }
        await host.waitForFunction((n) => document.querySelectorAll('.rseat').length === n, {}, capacity);
        for (const [w, h, inset] of [[390, 844, 0], [430, 932, 0], [640, 360, 0], [756, 366, 0], [844, 390, 47], [932, 430, 0], [768, 1024, 0]]) {
          await host.setViewport(viewport(w, h, true));
          await host.evaluate((n) => {
            document.documentElement.style.setProperty('--sa-l', `${n}px`);
            document.documentElement.style.setProperty('--sa-r', `${n}px`);
          }, inset);
          for (const textSize of ['sm', 'xl']) {
            await host.evaluate(async (v) => (await import('/js/ui/settings.js')).updateSettings({ textSize: v }), textSize);
            await delay(100);
            await host.waitForFunction(() => !document.getAnimations().some((a) => /^(rs|tr|rseat)-/.test(String(a.animationName))
              && a.playState === 'running' && a.effect?.getTiming().iterations !== Infinity), { timeout: 8000 });
            const problems = await host.evaluate(() => {
              const out = [];
              const cards = [...document.querySelectorAll('.rs-seats .rseat')];
              const box = (e) => e.getBoundingClientRect();
              for (let i = 0; i < cards.length; i++) {
                const card = cards[i], cr = box(card), art = card.querySelector('.rseat__art'), ar = box(art), plate = box(card.querySelector('.rseat__plate'));
                if (plate.bottom > cr.bottom + 1 || ar.bottom > plate.top + 1) out.push(`card ${i + 1}: art or plate exceeds the card`);
                for (const sel of ['.rseat__top', '.rseat__low', '.rseat__invite', '.rseat__add']) {
                  const e = art.querySelector(sel);
                  if (!e || getComputedStyle(e).display === 'none') continue;
                  const r = box(e);
                  if (r.top < ar.top - 1 || r.bottom > ar.bottom + 1 || r.left < ar.left - 1 || r.right > ar.right + 1) out.push(`card ${i + 1}: ${sel} outside art`);
                }
                for (const next of cards.slice(i + 1)) {
                  const nr = box(next);
                  if (nr.top > cr.top + 1 && nr.left < cr.right - 1 && nr.right > cr.left + 1 && nr.top < cr.bottom - 1) out.push(`card ${i + 1}: next row overlaps`);
                }
              }
              const name = document.querySelector('.rseat .seat__name');
              if (parseFloat(getComputedStyle(name).fontSize) < 10) out.push('name below 10 px');
              const multi = document.querySelector('.rs-seats:is(.seats--expanded, .seats--dense)');
              if (multi) for (const sel of ['.rseat__strip > .num', '.seat__swap']) {
                const el = multi.querySelector(sel);
                if (!el || parseFloat(getComputedStyle(el).fontSize) < 10) out.push(`${sel} below 10 px`);
              }
              for (const button of document.querySelectorAll('.room-capacity__opt')) {
                const r = box(button), range = document.createRange();
                range.selectNodeContents(button);
                const text = range.getBoundingClientRect();
                if (r.width < 32 || r.height < 32 || parseFloat(getComputedStyle(button).fontSize) < 10 || text.top < r.top - 1 || text.bottom > r.bottom + 1) out.push('capacity control is too small or clips its label');
              }
              return out;
            });
            assert.deepEqual(problems, [], `${capacity} seats ${w}×${h} ${textSize}: ${problems.join('; ')}`);
          }
        }
      }
      await host.setViewport(viewport(844, 390, true));
      await host.evaluate(() => { document.documentElement.style.setProperty('--sa-l', '0px'); document.documentElement.style.setProperty('--sa-r', '0px'); });
      await host.evaluate(async () => (await import('/js/ui/settings.js')).updateSettings({ textSize: 'sm' }));
      const swap = await host.$('[data-testid="seat-swap-19"]');
      await swap.evaluate((el) => el.scrollIntoView({ block: 'center' }));
      await swap.tap();
      await host.waitForFunction(() => { const s = globalThis.__SP__.store.get(); return s.room.seats[19]?.playerId === s.me.playerId; }, { timeout: 5000 });
      assert.equal(await host.$eval('.rs-seats', (el) => el.scrollTop > 0), true, 'the last seat is reached by scrolling');
    } finally { await guestCtx.close(); await ctx.close(); }
  });

  test('phone team list remains readable and scrollable for six and twenty players', { timeout: 90000 }, async () => {
    const ctx = await browser.createBrowserContext();
    try {
      const page = await ctx.newPage();
      await page.setViewport(viewport(844, 390, true));
      await page.goto(`${base}/dev/game-mock.html?shot=1&phase=PREP`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => !!globalThis.__MOCK__ && !!globalThis.__SP_VIEW__, { timeout: 30000 });
      await page.evaluate(() => {
        const pub = globalThis.__MOCK__.S().pub;
        const players = pub.players;
        for (let i = players.length; i < 20; i++) players.push({ ...players[1], playerId: `bot_${i}`, seat: i, name: `AI · 成员${i + 1}`, isBot: true, connected: true });
        globalThis.__layoutPlayers = players.slice();
      });
      for (const [w, h] of [[640, 360], [756, 366], [844, 390], [932, 430]]) {
        await page.setViewport(viewport(w, h, true));
        for (const count of [6, 20]) {
          await page.evaluate((n) => {
            const mock = globalThis.__MOCK__, pub = mock.S().pub;
            pub.players = globalThis.__layoutPlayers.slice(0, n);
            pub.poolGroups = Array.from({ length: Math.ceil(n / 4) }, (_, i) => ({ id: i + 1, playerIds: pub.players.slice(i * 4, i * 4 + 4).map((p) => p.playerId) }));
            mock.pushPublic();
          }, count);
          await page.waitForFunction((n) => document.querySelectorAll('.team__row').length === n, {}, count);
          await page.evaluate(() => { document.querySelector('.team__list').scrollTop = 0; });
          const metrics = await page.evaluate(() => {
            const list = document.querySelector('.team__list'), rows = [...list.querySelectorAll('.team__row')];
            const avatar = rows[0].querySelector('.pavatar').getBoundingClientRect();
            const corner = document.querySelector('.gm__corner').getBoundingClientRect();
            const bounds = list.getBoundingClientRect();
            return { nameFont: parseFloat(getComputedStyle(rows[0].querySelector('.team__name')).fontSize), avatar: avatar.width,
              rowGap: rows[1].querySelector('.team__btn').getBoundingClientRect().top - rows[0].querySelector('.team__btn').getBoundingClientRect().top,
              listBottom: bounds.bottom, cornerTop: corner.top, scrollable: list.scrollHeight > list.clientHeight };
          });
          assert.ok(metrics.nameFont >= 10 && metrics.avatar >= 32, `${w}×${h}, ${count}: ${JSON.stringify(metrics)}`);
          assert.ok(metrics.rowGap >= 44, `touch targets overlap: ${JSON.stringify(metrics)}`);
          assert.ok(metrics.listBottom <= metrics.cornerTop + 1, `team overlaps corner: ${JSON.stringify(metrics)}`);
          if (count === 20 || w <= 756) assert.ok(metrics.scrollable, `${w}×${h}: ${count} members should remain scrollable`);
          if (w === 844) {
            await page.evaluate(() => {
              const mock = globalThis.__MOCK__, playerId = mock.S().pub.players.at(-1).playerId;
              mock.store.set({ emotes: [{ seq: Date.now(), playerId, id: 'autochess_battle_nice_cooperate', at: Date.now() }] });
            });
            await page.waitForSelector('.team__emote-feed', { visible: true });
            const feed = await page.$eval('.team__feed-name', (el) => ({ name: el.textContent, size: parseFloat(getComputedStyle(el).fontSize) }));
            assert.ok(feed.name && feed.size >= 10, `emote sender remains readable: ${JSON.stringify(feed)}`);
          }
          await page.evaluate(() => { const list = document.querySelector('.team__list'); list.scrollTop = list.scrollHeight; });
          const buttons = await page.$$('.team__row .team__btn');
          const lastButton = buttons.at(-1);
          assert.ok(lastButton);
          const reachable = await lastButton.evaluate((el) => {
            const r = el.getBoundingClientRect(), hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
            return !!hit && el.contains(hit);
          });
          assert.equal(reachable, true, `${w}×${h}, ${count}: last avatar is reachable after scrolling`);
          await lastButton.evaluate((el) => { globalThis.__avatarTapped = false; el.addEventListener('click', () => { globalThis.__avatarTapped = true; }, { once: true }); });
          await lastButton.tap();
          assert.equal(await page.evaluate(() => globalThis.__avatarTapped), true, 'the last avatar receives a real tap');
          if (w === 640 && count === 6) {
            await page.evaluate(async () => (await import('/js/ui/screenFit.js')).updateFit({ ui: 75 }));
            const small = await page.evaluate(() => {
              const rows = [...document.querySelectorAll('.team__row')], list = document.querySelector('.team__list');
              return { avatar: rows[0].querySelector('.pavatar').getBoundingClientRect().width,
                rowGap: rows[1].querySelector('.team__btn').getBoundingClientRect().top - rows[0].querySelector('.team__btn').getBoundingClientRect().top,
                listBottom: list.getBoundingClientRect().bottom, cornerTop: document.querySelector('.gm__corner').getBoundingClientRect().top };
            });
            assert.ok(small.avatar >= 32 && small.rowGap >= 44 && small.listBottom <= small.cornerTop + 1, `75% UI: ${JSON.stringify(small)}`);
            await page.evaluate(async () => (await import('/js/ui/screenFit.js')).updateFit({ ui: 100 }));
          }
        }
      }
    } finally { await ctx.close(); }
  });

  test('team identities and touch targets remain usable across tablet, desktop and ultrawide views', { timeout: 150000 }, async () => {
    const cases = [
      [800, 600, false], [800, 600, true], [1024, 600, true], [1024, 768, true],
      [1180, 820, true], [1366, 1024, true], [1366, 768, false], [1920, 1080, false], [3440, 1440, false],
    ];
    for (const [w, h, touch] of cases) {
      const ctx = await browser.createBrowserContext();
      try {
        const page = await ctx.newPage();
        const errors = [];
        page.on('pageerror', (error) => errors.push(error.message));
        await page.setViewport(viewport(w, h, touch));
        await page.goto(`${base}/dev/game-mock.html?shot=1&phase=PREP`, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => !!globalThis.__MOCK__ && !!globalThis.__SP_VIEW__, { timeout: 30000 });
        await page.evaluate(() => {
          const players = globalThis.__MOCK__.S().pub.players;
          for (let i = players.length; i < 20; i++) players.push({ ...players[1], playerId: `matrix_${i}`, seat: i, name: `画面测试成员${i + 1}`, isBot: true, connected: true });
          globalThis.__matrixPlayers = players.slice();
        });
        for (const count of [4, 6, 20]) {
          await page.evaluate((n) => {
            const mock = globalThis.__MOCK__, pub = mock.S().pub;
            pub.players = globalThis.__matrixPlayers.slice(0, n);
            pub.poolGroups = Array.from({ length: Math.ceil(n / 4) }, (_, i) => ({ id: i + 1, playerIds: pub.players.slice(i * 4, i * 4 + 4).map((p) => p.playerId) }));
            mock.pushPublic();
          }, count);
          await page.waitForFunction((n) => document.querySelectorAll('.team__row').length === n, {}, count);
          const metrics = await page.evaluate(() => {
            const list = document.querySelector('.team__list'), rows = [...list.querySelectorAll('.team__row')];
            const buttons = rows.map((row) => row.querySelector('.team__btn').getBoundingClientRect());
            return { font: parseFloat(getComputedStyle(rows[0].querySelector('.team__name')).fontSize),
              avatar: rows[0].querySelector('.pavatar').getBoundingClientRect().width,
              lpFont: parseFloat(getComputedStyle(rows[0].querySelector('.lp--sm')).fontSize),
              pitch: buttons[1].top + buttons[1].height / 2 - buttons[0].top - buttons[0].height / 2,
              listBottom: list.getBoundingClientRect().bottom, cornerTop: document.querySelector('.gm__corner').getBoundingClientRect().top,
              scrollable: list.scrollHeight > list.clientHeight };
          });
          const label = `${w}×${h} ${touch ? 'touch' : 'mouse'}, ${count}: ${JSON.stringify(metrics)}`;
          assert.ok(metrics.font >= 10 && metrics.lpFont >= 10 && metrics.avatar >= 32, `identities are too small: ${label}`);
          assert.ok(metrics.listBottom <= metrics.cornerTop + 1, `team obscures the corner controls: ${label}`);
          if (count === 20) assert.ok(metrics.scrollable, `the full team must remain scrollable: ${label}`);
          if (touch) {
            assert.ok(metrics.pitch >= 44, `adjacent touch targets overlap: ${label}`);
            const last = (await page.$$('.team__row .team__btn')).at(-1);
            await last.evaluate((el) => el.scrollIntoView({ block: 'center', inline: 'nearest' }));
            const hit = await last.evaluate((el) => {
              const r = el.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2;
              return [[0, 0], [0, -20], [0, 20], [-20, 0], [20, 0]].every(([dx, dy]) => el.contains(document.elementFromPoint(x + dx, y + dy)));
            });
            assert.equal(hit, true, `last avatar has a reachable touch area: ${label}`);
            await last.evaluate((el) => { globalThis.__matrixTapped = false; el.addEventListener('click', () => { globalThis.__matrixTapped = true; }, { once: true }); });
            await last.tap();
            assert.equal(await page.evaluate(() => globalThis.__matrixTapped), true, `last avatar receives a tap: ${label}`);
          }
          if (touch && count === 20 && (w === 800 || w === 1024)) {
            for (const [textSize, ui] of [['sm', 75], ['xl', 100]]) {
              await page.evaluate(async ({ textSize: size, ui: scale }) => {
                (await import('/js/ui/settings.js')).updateSettings({ textSize: size });
                (await import('/js/ui/screenFit.js')).updateFit({ ui: scale });
              }, { textSize, ui });
              const adjusted = await page.evaluate(() => {
                const rows = [...document.querySelectorAll('.team__row')], list = document.querySelector('.team__list');
                const a = rows[0].querySelector('.team__btn').getBoundingClientRect(), b = rows[1].querySelector('.team__btn').getBoundingClientRect();
                return { font: parseFloat(getComputedStyle(rows[0].querySelector('.team__name')).fontSize),
                  avatar: rows[0].querySelector('.pavatar').getBoundingClientRect().width,
                  pitch: b.top + b.height / 2 - a.top - a.height / 2,
                  listBottom: list.getBoundingClientRect().bottom, cornerTop: document.querySelector('.gm__corner').getBoundingClientRect().top };
              });
              assert.ok(adjusted.font >= 10 && adjusted.avatar >= 32 && adjusted.pitch >= 44 && adjusted.listBottom <= adjusted.cornerTop + 1,
                `${label}, text ${textSize}, UI ${ui}%: ${JSON.stringify(adjusted)}`);
              if (textSize === 'xl') assert.ok(adjusted.font > 10, `large text applies to identities: ${JSON.stringify(adjusted)}`);
              const last = (await page.$$('.team__row .team__btn')).at(-1);
              await last.evaluate((el) => el.scrollIntoView({ block: 'center', inline: 'nearest' }));
              assert.equal(await last.evaluate((el) => {
                const r = el.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2;
                return [[0, -20], [0, 20], [-20, 0], [20, 0]].every(([dx, dy]) => el.contains(document.elementFromPoint(x + dx, y + dy)));
              }), true, `${label}: touch area at text ${textSize}, UI ${ui}%`);
            }
            await page.evaluate(async () => (await import('/js/ui/settings.js')).updateSettings({ textSize: 'sm' }));
          }
        }
        assert.deepEqual(errors, [], `${w}×${h}: browser errors`);
      } finally { await ctx.close(); }
    }
  });
});
