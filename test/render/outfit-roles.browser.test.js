import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { startServer } from '../../server/index.js';

test('real outfit models: Utage S1 rests and S2 attacks; Ifrit extra Skill never replaces normal attacks', {
  skip: process.env.RENDER_E2E !== '1', timeout: 120000,
}, async t => {
  const out = await fs.mkdtemp(path.resolve('.cache/outfit-roles-'));
  const srv = await startServer({ host: '127.0.0.1', port: 0, quiet: true,
    announcementsDir: path.join(out, 'news'), serverSettingsDir: path.join(out, 'settings') });
  let browser;
  try {
    browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
      headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });
    const page = await browser.newPage(), errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.setViewport({ width: 1200, height: 900 });
    await page.goto(srv.url + '/dev/skin-preview.html?char=char_337_utage');
    await page.waitForFunction(() => window.__skinPreview?.ready && globalThis.PIXI?.spine);
    const report = await page.evaluate(async () => {
      const { assets } = await import('/js/assets.js');
      const { SpineActor } = await import('/js/render/spine.js');
      const manifest = await (await fetch('/data/assets.json')).json();
      const P = globalThis.PIXI;
      const app = new P.Application({ width: 1200, height: 900, backgroundColor: 0x263038, autoStart: false, preserveDrawingBuffer: true });
      document.body.replaceChildren(app.view);
      const rows = [], actors = [], releases = [];
      const act = (a, seconds) => { for (let i = 0; i < seconds * 60; i++) a.update(1 / 60); };
      const pairs = [['char_337_utage', 'char_337_utage@epoque#15'], ['char_337_utage', 'char_337_utage@summer#4'], ['char_134_ifrit', 'char_134_ifrit@rilakkuma#1']];
      try {
        for (const [char, skin] of pairs) for (const face of ['front', 'back']) {
          const rec = manifest.chars[char].skins[skin], entry = rec.spine[face];
          const data = await assets.spine.acquire(entry); releases.push(entry);
          const a = new SpineActor(data, entry); actors.push(a);
          a.setSkillIndex(char === 'char_337_utage' ? 1 : 0); a.setSkill(true); act(a, 0.7);
          const start = a.spine.state.tracks[0]?.animation?.name;
          a.attack(1.2); act(a, 0.3);
          const attack = a.spine.state.tracks[0]?.animation?.name;
          a.spine.scale.set(0.65); a.spine.position.set(200 + (rows.length % 3) * 400, 400 + Math.floor(rows.length / 3) * 450);
          app.stage.addChild(a.spine);
          const label = new P.Text(`${rec.name} ${face}\n${start} → ${attack}`, { fill: 0xffffff, fontSize: 15 });
          label.position.set(a.spine.x - 130, a.spine.y + 12); app.stage.addChild(label);
          rows.push({ skin, face, start, attack });
        }
        app.renderer.render(app.stage);
        const pixels = app.renderer.extract.pixels(app.stage);
        const ink = pixels.filter((v, i) => i % 4 !== 3 && v > 100).length;
        window.__outfitImage = app.view.toDataURL('image/png');
        for (let i = 0; i < 4; i++) {
          const a = actors[i]; a.setSkill(false); act(a, 1); a.setSkillIndex(0); a.setSkill(true); act(a, 1);
          rows[i].s1 = a.spine.state.tracks[0]?.animation?.name;
        }
        return { rows, ink };
      } finally {
        app.destroy(true, { children: true, texture: false, baseTexture: false });
        for (const entry of releases) assets.spine.release(entry);
      }
    });
    for (const r of report.rows) {
      assert.equal(r.start, 'Idle', JSON.stringify(r)); assert.equal(r.attack, 'Attack', JSON.stringify(r));
      if (r.skin.includes('utage')) assert.equal(r.s1, 'Skill_Loop', JSON.stringify(r));
    }
    assert.ok(report.ink > 10000); assert.deepEqual(errors, []);
    const png = await page.evaluate(() => window.__outfitImage);
    await fs.writeFile(path.join(out, 'outfit-actions.png'), Buffer.from(png.split(',')[1], 'base64'));
    await fs.writeFile(path.join(out, 'report.json'), JSON.stringify({ ...report, errors }, null, 2));
    t.diagnostic(out);
  } finally { await browser?.close(); await srv.close(); }
});
