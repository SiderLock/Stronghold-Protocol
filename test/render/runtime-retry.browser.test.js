import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const enabled = process.env.SP_E2E === '1' && existsSync(CHROME);

test('Three import retries retain the main page content version', { skip: !enabled, timeout: 30000 }, async () => {
  let srv, browser;
  try {
    const { startServer } = await import('../../server/index.js');
    srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true });
    const P = (await import('puppeteer-core')).default;
    browser = await P.launch({ executablePath: CHROME, headless: true, args: ['--no-first-run', '--no-sandbox'] });
    const page = await browser.newPage();
    const requests = [];
    await page.setRequestInterception(true);
    page.on('request', req => {
      const url = new URL(req.url());
      if (url.pathname !== '/vendor/three.module.js') { void req.continue(); return; }
      requests.push(url);
      if (requests.length === 1) void req.abort('failed');
      else void req.respond({ status: 200, contentType: 'text/javascript', body: 'export class WebGLRenderer {}' });
    });
    await page.goto(`http://127.0.0.1:${srv.port}/?board=2d`);
    const result = await page.evaluate(async () => {
      const imports = JSON.parse(document.querySelector('script[type="importmap"]').textContent).imports;
      const { loadThree, resetBoardPack } = await import('/js/render/board3d/load.js');
      resetBoardPack();
      return { pinned: imports['/vendor/three.module.js'], failed: await loadThree() === null,
        recovered: typeof (await loadThree())?.WebGLRenderer === 'function' };
    });
    assert.equal(result.failed, true);
    assert.equal(result.recovered, true);
    assert.equal(requests.length, 2);
    const hash = new URL(result.pinned, `http://127.0.0.1:${srv.port}`).searchParams.get('rv');
    assert.match(hash, /^[a-f0-9]{64}$/);
    assert.deepEqual(requests.map(url => url.searchParams.get('rv')), [hash, hash]);
    assert.deepEqual(requests.map(url => url.searchParams.get('sp-retry')), [null, '1']);
  } finally { await browser?.close(); await srv?.close(); }
});
