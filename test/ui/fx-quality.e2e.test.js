// SP_E2E=1 CHROME_PATH=<Edge> node --test test/ui/fx-quality.e2e.test.js
// Actual settings modal, legacy profiles, saved choices and four controls across languages / viewport sizes.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { seedReleaseRead } from '../helpers/releaseNotes.js';

const ROOT = path.resolve(import.meta.dirname, '../..');
const EDGE = process.env.CHROME_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const enabled = process.env.SP_E2E === '1' && existsSync(EDGE) && existsSync(path.join(ROOT, 'public/assets/local/fx/index.json'));
const labels = lang => {
  const pack = lang === 'zh' ? {} : JSON.parse(readFileSync(path.join(ROOT, `public/i18n/${lang}.json`), 'utf8'));
  return ['关', '低', '中', '高'].map(key => pack[key] || key);
};

describe('official FX quality in settings', { skip: !enabled && 'set SP_E2E=1 with Edge and local FX assets' }, () => {
  let server, browser;
  const errors = [];
  before(async () => {
    const { startServer } = await import('../../server/index.js');
    const puppeteer = (await import('puppeteer-core')).default;
    server = await startServer({ port: 0, host: '127.0.0.1', quiet: true });
    browser = await puppeteer.launch({ executablePath: EDGE, headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });
  });
  after(async () => { await browser?.close(); await server?.close(); });

  async function open(profile, viewport = { width: 844, height: 390 }, lang = 'zh') {
    const page = await browser.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.setViewport(viewport);
    await seedReleaseRead(page);
    await page.evaluateOnNewDocument(value => {
      if (sessionStorage.getItem('fx-quality-seeded')) return;
      localStorage.setItem('sp.pref.settings', JSON.stringify(value));
      sessionStorage.setItem('fx-quality-seeded', '1');
    }, profile);
    await page.goto(`${server.url}/dev/game-mock.html?shot=1&phase=PREP&variant=settings&lang=${lang}`);
    await page.waitForSelector('[data-testid="official-fx"] button', { timeout: 60000 });
    // The game mock does not run main.js's language boot. Load the real pack and re-render through settings.
    await page.evaluate(async language => {
      const i18n = await import('/js/ui/lang.js');
      await i18n.initLang(); await i18n.switchLang(language);
      (await import('/js/ui/settings.js')).updateSettings({});
    }, lang);
    await page.waitForFunction(expected => JSON.stringify([...document.querySelectorAll('[data-testid="official-fx"] button')]
      .map(button => button.textContent.trim())) === JSON.stringify(expected), {}, labels(lang));
    return page;
  }

  test('legacy choices keep their profiles, new choices persist, and FX quality is independent', async () => {
    for (const [value, label, touch] of [['full', '高'], ['lite', '中'], ['auto', '高'], ['auto', '中', true]]) {
      const page = await open({ officialFx: value, quality: 'medium', frameLimit: 30 },
        touch ? { width: 375, height: 812, isMobile: true, hasTouch: true } : undefined);
      try {
        assert.equal(await page.$eval('[data-testid="official-fx"] button[aria-checked="true"]', el => el.textContent.trim()), label);
        assert.equal((await page.$$('[data-testid="official-fx"] button')).length, 4);
        for (const [index, tier] of [[1, 'low'], [2, 'lite'], [3, 'full'], [0, 'off'], [1, 'low']]) {
          await page.click(`[data-testid="official-fx"] button:nth-of-type(${index + 1})`);
          const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('sp.pref.settings')));
          assert.equal(saved.officialFx, tier);
          assert.equal(saved.quality, 'medium'); assert.equal(saved.frameLimit, 30);
        }
        await page.reload();
        await page.waitForSelector('[data-testid="official-fx"] button[aria-checked="true"]');
        assert.equal(await page.$eval('[data-testid="official-fx"] button[aria-checked="true"]', el => el.textContent.trim()), '低');
      } finally { await page.close(); }
    }
  });

  test('four quality controls fit five languages at desktop, portrait and landscape sizes', { timeout: 180000 }, async () => {
    for (const viewport of [{ width: 1280, height: 720 }, { width: 375, height: 812 }, { width: 844, height: 390 }]) {
      for (const lang of ['zh', 'en', 'ja', 'ko', 'zh-TW']) {
        const page = await open({ officialFx: 'low', quality: 'high', textSize: 'xl' }, viewport, lang);
        try {
          const layout = await page.evaluate(() => {
            const row = document.querySelector('[data-testid="official-fx"]');
            row.scrollIntoView({ block: 'center' });
            const box = row.closest('.modal__box').getBoundingClientRect();
            const buttons = [...row.querySelectorAll('button')];
            return { count: buttons.length, checked: buttons.filter(button => button.getAttribute('aria-checked') === 'true').length,
              fits: buttons.every(button => {
                const rect = button.getBoundingClientRect();
                return rect.width > 0 && rect.height > 0 && rect.left >= box.left - 1 && rect.right <= box.right + 1
                  && button.scrollWidth <= button.clientWidth + 1;
              }) };
          });
          assert.deepEqual(layout, { count: 4, checked: 1, fits: true }, `${lang} ${viewport.width}×${viewport.height}`);
        } finally { await page.close(); }
      }
    }
    assert.deepEqual(errors, []);
  });
});
