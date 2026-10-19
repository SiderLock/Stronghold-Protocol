// test/render/skin-preview.browser.test.js — 小人预览 (docs/SKINS.md 小人预览) in headless Chrome, on the real art:
// public/js/ui/skinPreview.js is lazy (PIXI via render/app/pixi.js, models via assets.spine.acquire), so the ONLY place
// that can prove a model really comes up is a real browser with the downloaded assets. The dev page
// (public/dev/skin-preview.html) mounts the real `SkinModelPreview` on `/data/assets.json`, so this test asserts what a
// player would see and nothing mock:
//   * a model really starts: a canvas appears in `[data-testid=skin-preview]`, the static-art layer is hidden (that
//     layer is hidden only at status 'ready'), the caption is 小人预览 and the model is in the Spine LRU;
//   * the canvas is NOT rebuilt by a clip button: picking 攻击 re-points the running skeleton at another animation;
//   * it keeps playing: the frame's pixels change between two screenshots (a skeleton with autoUpdate=false and no
//     ticker would draw one static frame and look right in a DOM-only assertion);
//   * switching operator drops the old canvas, unmounting drops the canvas, and a mount after an unmount still works;
//   * an operator without a model degrades to 模型不可用 with no canvas, and never throws.
//
// Opt-in (starts Chrome): RENDER_E2E=1 CHROME_PATH=/usr/bin/google-chrome node --test test/render/skin-preview.browser.test.js
// Chrome: $CHROME_PATH or the platform default. Needs the downloaded assets (public/assets). Screenshots → test/e2e/out/.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gpuArgs } from '../../tools/perfbench.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(ROOT, 'test/e2e/out');
const CHROME = process.env.CHROME_PATH || {
  win32: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  darwin: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  linux: '/usr/bin/google-chrome',
}[process.platform];
const enabled = process.env.RENDER_E2E === '1' && !!CHROME && existsSync(CHROME) && existsSync(path.join(ROOT, 'public/assets'));
const skip = enabled ? false : 'set RENDER_E2E=1 (needs Chrome and the downloaded assets under public/assets)';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The operator the docs use (front + back on disk) and one more, so the switch test has a second real model. */
const CHAR = 'char_498_inside';
const OTHER = 'char_003_kalts';

/** Responses a dev page may legitimately miss (no favicon, no generated pack index). */
const ignoredResponse = (url) => /\/favicon\.ico$|\/packs\/index\.json$/.test(url);

describe('小人预览 in headless Chrome', { skip }, () => {
  let srv; let browser; let page;
  /** Problems this page reported: a page error, a console error, or a failed request of the page's own code/art. */
  let problems = [];

  before(async () => {
    mkdirSync(OUT, { recursive: true });
    const puppeteer = (await import('puppeteer-core')).default;
    const { startServer } = await import('../../server/index.js');
    srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true });
    // --no-sandbox: this host's Chrome refuses its setuid sandbox (the CI-style containers run as a plain user).
    // --enable-unsafe-swiftshader: Chrome 137+ gates its software WebGL fallback behind that flag; headless Chrome here
    // has no usable GPU context without it, PIXI would fail and the page would (correctly) show 模型不可用 — a harness
    // limitation, not a preview bug. gpuArgs() keeps the repo's GPU flags (--enable-gpu, --ignore-gpu-blocklist, angle).
    browser = await puppeteer.launch({
      executablePath: CHROME, headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader', ...gpuArgs()],
    });
    page = await browser.newPage();
    await page.setViewport({ width: 900, height: 820, deviceScaleFactor: 1 });
    page.setDefaultTimeout(60_000);
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });
    page.on('response', (r) => {
      const url = r.url();
      if (r.status() < 400 || ignoredResponse(url) || !/\/(assets|data|dev|vendor|js)\//.test(url)) return;
      problems.push(`HTTP ${r.status()} ${url}`);
    });
  });

  after(async () => {
    try { await browser?.close(); } catch { /* gone */ }
    try { await srv?.close(); } catch { /* gone */ }
  });

  /** Open the dev page on `charId`, wait for the manifest, and return the first state. */
  async function open(charId = CHAR, query = '') {
    problems = [];
    const url = `http://127.0.0.1:${srv.port}/dev/skin-preview.html?char=${encodeURIComponent(charId)}${query}`;
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => globalThis.__skinPreview && (globalThis.__skinPreview.ready || globalThis.__skinPreview.error));
    const err = await page.evaluate(() => globalThis.__skinPreview.error);
    assert.equal(err, null, `the dev page failed to start: ${err}`);
    return page.evaluate(() => globalThis.__skinPreview.state());
  }

  /** Wait until the preview holds a canvas (the model came up) and return the state then. */
  async function waitCanvas(timeout = 60_000) {
    await page.waitForFunction(() => !!document.querySelector('[data-testid="skin-preview"] canvas'), { timeout });
    return page.evaluate(() => globalThis.__skinPreview.state());
  }

  test('the model really comes up: canvas, ready caption, Spine in the LRU, and it keeps playing', async () => {
    await open(CHAR);
    await page.waitForSelector('[data-testid="skin-preview"]');
    const s = await waitCanvas();

    // A canvas with real geometry, holding the class/aria-label the module sets (not some other canvas on the page).
    assert.ok(s.canvas, 'no canvas in the preview');
    assert.match(s.canvas.cls, /lo-spine__canvas/);
    assert.equal(s.canvas.label, '小人预览');
    assert.ok(s.canvas.w > 0 && s.canvas.h > 0, `canvas is ${s.canvas.w}×${s.canvas.h}`);
    assert.equal(s.canvases, 1, `exactly one canvas, got ${s.canvases}`);

    // status 'ready' is what hides the static-art layer; 模型不可用 is the only other caption this component shows.
    assert.equal(s.artHidden, true, 'the static-art layer is still shown: status is not ready');
    assert.equal(s.note, '小人预览', `caption: ${s.note}`);
    assert.notEqual(s.note, '模型不可用');

    // The module's promise is `assets.spine.acquire`; the data is in the same LRU the battlefield uses.
    const spine = await page.evaluate(async (charId) => {
      const api = globalThis.__skinPreview;
      const mod = await import('/js/assets.js');
      const entry = api.entry;
      const v = entry ? mod.assets.spine.peek(entry) : null;
      return { charId: api.charId, expected: charId, hasEntry: !!entry, skel: entry?.skel || null, loaded: v != null && v !== undefined };
    }, CHAR);
    assert.equal(spine.charId, CHAR);
    assert.ok(spine.hasEntry && /\/assets\/spine\/op\//.test(spine.skel || ''), `entry: ${JSON.stringify(spine)}`);
    assert.ok(spine.loaded, 'the Spine data is not in the asset cache: acquire did not complete');

    // Buttons come from the manifest, not a list: 待机 is selected and 攻击 exists on this model.
    assert.ok(s.buttons.includes('待机'), `buttons: ${JSON.stringify(s.buttons)}`);
    assert.ok(s.buttons.includes('攻击'), `buttons: ${JSON.stringify(s.buttons)}`);
    assert.deepEqual(s.on, ['待机'], `selected at rest: ${JSON.stringify(s.on)}`);

    await page.screenshot({ path: path.join(OUT, 'skin-preview-ready.png') });
    assert.deepEqual(problems, []);
  });

  test('picking another clip re-points the running skeleton — the canvas is NOT rebuilt', async () => {
    await open(CHAR);                               // independent of the other tests' page state
    await waitCanvas();
    const marked = await page.evaluate(() => {
      window.__cv0 = document.querySelector('[data-testid="skin-preview"] canvas');
      return !!window.__cv0;
    });
    assert.ok(marked, 'no canvas to mark');
    await page.evaluate(() => {
      const b = [...document.querySelectorAll('.lo-spine__btn')].find((x) => x.textContent.trim() === '攻击');
      if (!b) throw new Error('no 攻击 button');
      b.click();
    });
    // The button turns on (the component marks the selected clip)…
    await page.waitForFunction(() => [...document.querySelectorAll('.lo-spine__btn.is-on')].some((b) => b.textContent.trim() === '攻击'));
    // …on the SAME canvas: a rebuilt one would be a new node.
    const after = await page.evaluate(() => {
      const c = document.querySelector('[data-testid="skin-preview"] canvas');
      return { same: c === window.__cv0, oldConnected: window.__cv0?.isConnected ?? false, canvases: document.querySelectorAll('[data-testid="skin-preview"] canvas').length };
    });
    assert.deepEqual(after, { same: true, oldConnected: true, canvases: 1 });

    // And the frame is really animated: two screenshots of the frame a moment apart differ (an autoUpdate=false
    // skeleton with no ticker would draw one frozen frame and pass every DOM assertion above).
    const box = await (await page.$('[data-testid="skin-preview"] .lo-spine__frame')).boundingBox();
    assert.ok(box && box.width > 0, 'no frame box');
    const clip = { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) };
    const one = await page.screenshot({ clip });
    await sleep(700);
    const two = await page.screenshot({ clip });
    assert.ok(!one.equals(two), 'the preview is not animating: two frames 700 ms apart are pixel-identical');
    await page.screenshot({ path: path.join(OUT, 'skin-preview-attack.png') });
    assert.deepEqual(problems, []);
  });

  test('switching operator drops the old canvas and draws the new model', async () => {
    await open(CHAR);
    await waitCanvas();
    const before = await page.evaluate(() => { window.__cvOld = document.querySelector('[data-testid="skin-preview"] canvas'); return window.__cvOld?.isConnected; });
    assert.equal(before, true);
    const s = await page.evaluate((id) => { globalThis.__skinPreview.show(id); return true; }, OTHER);
    assert.ok(s);
    // The old app is destroyed by the effect's cleanup, so the OLD canvas must leave the DOM, and a NEW one appears.
    await page.waitForFunction(() => {
      const c = document.querySelector('[data-testid="skin-preview"] canvas');
      return !!c && c !== window.__cvOld;
    });
    const after = await page.evaluate(() => ({
      oldConnected: window.__cvOld?.isConnected ?? false,
      canvases: document.querySelectorAll('[data-testid="skin-preview"] canvas').length,
      charId: globalThis.__skinPreview.charId,
      state: globalThis.__skinPreview.state(),
    }));
    assert.equal(after.oldConnected, false, 'the previous canvas is still in the DOM');
    assert.equal(after.canvases, 1, `more than one canvas after the switch: ${after.canvases}`);
    assert.equal(after.charId, OTHER);
    assert.equal(after.state.note, '小人预览');
    assert.equal(after.state.artHidden, true);
    assert.deepEqual(problems, []);
  });

  test('unmounting removes the canvas, and a later mount still works', async () => {
    await open(CHAR);
    await waitCanvas();
    await page.evaluate(() => { window.__cvGone = document.querySelector('[data-testid="skin-preview"] canvas'); globalThis.__skinPreview.clear(); });
    await page.waitForFunction(() => !document.querySelector('[data-testid="skin-preview"]'));
    const gone = await page.evaluate(() => ({
      mounted: globalThis.__skinPreview.state().mounted,
      canvases: document.querySelectorAll('canvas').length,
      oldConnected: window.__cvGone?.isConnected ?? false,
    }));
    assert.deepEqual(gone, { mounted: false, canvases: 0, oldConnected: false });

    // A mount after an unmount: no leftover canvas, no stale app.
    await page.evaluate((id) => globalThis.__skinPreview.show(id), CHAR);
    const s = await waitCanvas();
    assert.equal(s.mounted, true);
    assert.equal(s.canvases, 1);
    assert.equal(s.note, '小人预览');
    assert.deepEqual(problems, []);
  });

  test('a rapid switch leaves no canvas behind and no stale model', async () => {
    // The module's own header: "an async load that resolves after the modal closed must never attach its canvas to a
    // node that is gone". Two choices in one task make the first model's load resolve after its effect was cancelled.
    await open(CHAR);
    await waitCanvas();
    await page.evaluate((ids) => { globalThis.__skinPreview.show(ids[0]); globalThis.__skinPreview.show(ids[1]); }, [OTHER, CHAR]);
    await page.waitForFunction(() => {
      const root = document.querySelector('[data-testid="skin-preview"]');
      return !!root && !!root.querySelector('canvas') && root.querySelector('.lo-spine__art')?.hidden === true;
    });
    await sleep(600);                                // give a late second canvas the chance to appear
    const s = await page.evaluate(() => ({ ...globalThis.__skinPreview.state(), charId: globalThis.__skinPreview.charId }));
    assert.equal(s.canvases, 1, `a cancelled load attached a second canvas (${s.canvases})`);
    assert.equal(s.charId, CHAR, 'the last choice must win');
    assert.equal(s.note, '小人预览');
    assert.deepEqual(problems, []);
  });

  test('an operator without a model degrades to 模型不可用 and never throws', async () => {
    await open(CHAR);
    await page.evaluate(() => globalThis.__skinPreview.show('char_not_a_real_operator'));
    await page.waitForFunction(() => document.querySelector('[data-testid="skin-preview"] .lo-spine__note')?.textContent.trim() === '模型不可用');
    const s = await page.evaluate(() => globalThis.__skinPreview.state());
    assert.equal(s.mounted, true, 'the section must stay (the picker keeps its static art)');
    assert.equal(s.canvases, 0, 'no canvas for a model that cannot load');
    assert.equal(s.buttons.length, 0);
    await page.screenshot({ path: path.join(OUT, 'skin-preview-unavailable.png') });
    assert.deepEqual(problems, []);
  });
});
