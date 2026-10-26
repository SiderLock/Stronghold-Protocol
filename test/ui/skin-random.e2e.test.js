// Production random-skin controls in a real browser; synthetic outfit metadata needs no installed game art.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../../server/index.js';
import { CHROME, hasChrome } from '../e2e/client.mjs';

test('random outfit controls persist fixed choices and per-match mode, with usable phone and desktop layouts',
  { skip: process.env.SP_E2E !== '1' || !hasChrome(), timeout: 60000 }, async () => {
    const server = await startServer({ port: 0, host: '127.0.0.1', quiet: true, assetIndex: false });
    const puppeteer = (await import('puppeteer-core')).default;
    let browser;
    try {
      browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
      const page = await browser.newPage(), errors = [];
      page.on('pageerror', e => errors.push(e.message));
      await page.setRequestInterception(true);
      page.on('request', req => {
        if (new URL(req.url()).pathname === '/skin-random-test') void req.respond({ status: 200, contentType: 'text/html', body:
          '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/css/theme.css"><link rel="stylesheet" href="/css/components.css"><link rel="stylesheet" href="/css/screens/loadout.css"><body><div id="test"></div></body></html>' });
        else void req.continue();
      });
      const mount = () => page.evaluate(async () => {
        const { data } = await import('/js/data.js');
        await data.load('assets');
        data.setContent({ id: 'b'.repeat(64), values: { assets: { chars: {
          char_498_inside: { skins: { first: { avatar: '/one.png' }, second: { portrait: '/two.png' } } },
          char_003_kalts: { skins: { outfit: { avatar: '/three.png' } } },
          char_002_amiya: {},
        } } } });
        const { render } = await import('/vendor/preact.module.js');
        const { html } = await import('/js/ui/components.js');
        const { SkinRandomControls } = await import('/js/ui/skinRandom.js');
        render(html`<div class="lo"><header class="lo-top"><div class="lo-top__left"><${SkinRandomControls} /></div></header></div>`, document.querySelector('#test'));
      });
      await page.goto(`${server.url}/skin-random-test`);
      await mount();
      await page.click('[data-testid="skin-random"]');
      await page.waitForSelector('[data-testid="skin-random-roll"]:not(:disabled)');
      await page.click('[data-testid="skin-random-roll"]');
      const read = () => page.evaluate(async () => (await import('/js/ui/skins.js')).skinsStore.get());
      const fixed = await read();
      assert.equal(fixed.skinRandomMode, 'fixed');
      assert.deepEqual(Object.keys(fixed.skins).sort(), ['char_003_kalts', 'char_498_inside']);
      assert.ok(['first', 'second'].includes(fixed.skins.char_498_inside));
      assert.equal(fixed.skins.char_003_kalts, 'outfit');
      for (const [width, height] of [[1920, 1080], [390, 844], [844, 390]]) {
        await page.setViewport({ width, height });
        assert.ok(await page.$eval('[data-testid="skin-random-options"]', el => {
          const box = el.closest('[role="dialog"]').getBoundingClientRect();
          return box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight;
        }), `dialog fits ${width}×${height}`);
        assert.ok(await page.$eval('input[value="match"]', el => el.getBoundingClientRect().width > 0));
      }
      await page.reload();
      await mount();
      assert.deepEqual((await read()).skins, fixed.skins, 'fixed selection survives reload');
      await page.click('[data-testid="skin-random"]');
      await page.click('input[value="match"]');
      assert.equal((await read()).skinRandomMode, 'match');
      assert.deepEqual((await read()).skins, fixed.skins, 'selecting auto does not reroll this match');
      await page.reload();
      await mount();
      assert.equal((await read()).skinRandomMode, 'match', 'auto mode survives reload');
      await page.evaluate(async () => { (await import('/js/ui/skins.js')).setSkin('char_498_inside', 'first'); });
      assert.equal((await read()).skinRandomMode, 'fixed', 'manual picker edits leave auto mode');
      assert.deepEqual(errors, []);
    } finally { await browser?.close(); await server.close(); }
  });
