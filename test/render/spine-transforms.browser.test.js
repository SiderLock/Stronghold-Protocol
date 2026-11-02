import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { gpuArgs } from '../../tools/perfbench.mjs';
const CHROME = process.env.CHROME_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const skip = process.env.RENDER_E2E !== '1' || !existsSync(CHROME);

test('native and optimized Spine transforms render identical pixels through poses, repeat passes, tint and scaling', { skip, timeout: 120000 }, async () => {
  const { startServer } = await import('../../server/index.js');
  const puppeteer = (await import('puppeteer-core')).default;
  const srv = await startServer({ host: '127.0.0.1', port: 0, quiet: true });
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: gpuArgs() });
  try {
    const page = await browser.newPage(), errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${srv.port}/dev/render-demo.html?scene=normal-m01&t=18&paused=1&panel=0`);
    await page.waitForFunction(() => window.__demo?.ready && [...window.__demo.view.debug.views.values()].filter(v => v.actor?.spine?.skeleton?.slots.some(s => s.currentMesh)).length >= 3, { timeout: 60000 });
    const result = await page.evaluate(async () => {
      const { optimizeSpineTransforms } = await import('/js/render/spineTransforms.js');
      const { app, views } = window.__demo.view.debug;
      app.stop();
      const sources = [...new Set([...views.values()].filter(v => v.actor?.spine?.skeleton?.slots.some(s => s.currentMesh)).map(v => v.actor.spine.spineData))].slice(0, 6);
      let comparisons = 0, nativeMeshUpdates = 0, ink = 0;
      const rt = PIXI.RenderTexture.create({ width: 512, height: 512 });
      const draw = sp => { app.renderer.render(sp, { renderTexture: rt, clear: true }); return app.renderer.extract.pixels(rt); };
      const ids = sp => sp.skeleton.slots.flatMap(s => Object.values(s.meshes || {})).reduce((n,m) => n + m.geometry.getBuffer('aVertexPosition')._updateID, 0);
      for (const data of sources) {
        const a = new PIXI.spine.Spine(data), b = new PIXI.spine.Spine(data);
        a.autoUpdate = b.autoUpdate = false;
        optimizeSpineTransforms(b);
        for (const sp of [a,b]) { sp.scale.set(0.6); sp.position.set(256, 470); }
        const names = data.animations.map(x => x.name);
        const clips = [...new Set([names.find(n => /idle/i.test(n)), names.find(n => /attack/i.test(n)), names.find(n => /die/i.test(n)), ...names.slice(0,2)].filter(Boolean))];
        for (const clip of clips) {
          a.state.setAnimation(0, clip, false); b.state.setAnimation(0, clip, false);
          for (const dt of [0, 0.05, 0.15, 0.4, 1]) {
            a.update(dt); b.update(dt);
            const x = draw(a), y = draw(b);
            if (x.length !== y.length || x.some((v,i) => v !== y[i])) throw new Error(`pose mismatch: ${clip} ${dt}`);
            ink += y.reduce((n,v,i) => n + (i % 4 === 3 && v > 0 ? 1 : 0), 0);
            comparisons++;
            const ia = ids(a), ib = ids(b);
            for (let k=0; k<3; k++) { draw(a); draw(b); }
            nativeMeshUpdates += ids(a) - ia;
            if (ids(b) - ib !== ids(a) - ia) throw new Error('native mesh updates changed');
          }
        }
        a.tint = b.tint = 0x9fd4ff; a.update(0); b.update(0);
        for (const sp of [a,b]) { sp.scale.set(-0.4,0.4); sp.position.x = 320; }
        const x = draw(a), y = draw(b);
        if (x.some((v,i) => v !== y[i])) throw new Error('tint/transform mismatch');
        comparisons++;
        a.destroy({ children: true, texture: false, baseTexture: false });
        b.destroy({ children: true, texture: false, baseTexture: false });
      }
      rt.destroy(true);
      return { sources: sources.length, comparisons, nativeMeshUpdates, ink };
    });
    assert.ok(result.sources >= 3, JSON.stringify(result));
    assert.ok(result.comparisons >= 30, JSON.stringify(result));
    assert.ok(result.nativeMeshUpdates > 0, JSON.stringify(result));
    assert.ok(result.ink > 0, JSON.stringify(result));
    assert.deepEqual(errors, []);
    console.log('transform pixel equivalence', JSON.stringify(result));
  } finally { await browser.close(); await srv.close(); }
});
