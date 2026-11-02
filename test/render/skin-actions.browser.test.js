// Real battle → public metadata/events → production field renderer, with optional locally installed outfit art.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../../server/index.js';
import { buildBattleSpec } from '../../server/sim/spec.js';
import { CHROME, hasChrome, OUT } from '../e2e/client.mjs';

const skin = 'char_4134_cetsyr@epoque#50';
const root = fileURLToPath(new URL('../../', import.meta.url));
const installed = existsSync(path.join(root, 'public/assets/local/skins/char_4134_cetsyr/char_4134_cetsyr_epoque_50/front/char_4134_cetsyr_epoque_50.skel'));
const enabled = process.env.RENDER_E2E === '1' && hasChrome() && installed;
const SPEC = buildBattleSpec({ battleId: 'skin-actions', fieldId: 'skin-actions', kind: 'normal', seed: 17,
  modeId: 'mode_multi_normal', round: 10, stageId: 'act2autochess_m01', timeLimit: 300,
  flags: { layerGainsEnabled: false },
  players: [{ playerId: 'P', seat: 0, side: 'L', colOffset: 0, bonds: {}, playerEffects: [], units: [
    { uid: 1, kind: 'chess', chessId: 'chess_char_4_25_a', row: 10, col: 6, dir: 'RIGHT', skin, carryState: { down: true } },
    { uid: 2, kind: 'chess', chessId: 'chess_char_3_16_a', row: 9, col: 8, dir: 'RIGHT' },
  ] }],
  spawns: [{ time: 0, enemyKey: 'enemy_10116_ymgtop', routeIndex: 0, mods: { hpMul: 100, atkMul: 0.001 } }],
  routes: [{ motion: 'WALK', start: [9, 10], end: [9, 2], checkpoints: [] }],
});

test('魔王 追悼 stays visible while down/reloading and revives; 水遁忍者 spins and exits on 失衡',
  { skip: !enabled && 'set RENDER_E2E=1 with Chrome and locally extracted 追悼 art', timeout: 90000 }, async () => {
    mkdirSync(OUT, { recursive: true });
    const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, assetIndex: false });
    const puppeteer = (await import('puppeteer-core')).default;
    let browser;
    try {
      browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });
      const page = await browser.newPage(), errors = [];
      page.on('pageerror', e => errors.push(e.message));
      await page.setViewport({ width: 1280, height: 720 });
      await page.setRequestInterception(true);
      page.on('request', r => {
        if (new URL(r.url()).pathname === '/skin-actions-test') void r.respond({ status: 200, contentType: 'text/html', body:
          '<!doctype html><html><meta charset="utf-8"><style>body{margin:0;background:#14201b}#field{width:100vw;height:100vh}</style><div id="field"></div></html>' });
        else void r.continue();
      });
      await page.goto(`${srv.url}/skin-actions-test`);
      await page.evaluate(async spec => {
        const { loadBrowserSim } = await import('/js/battle/runner.js');
        const { data } = await import('/js/data.js');
        const { assets } = await import('/js/assets.js');
        const { createFieldView } = await import('/js/render/app.js');
        const { spec: S, ds } = await loadBrowserSim();
        await data.loadAll('chess', 'backups', 'enemies', 'tokens', 'stages', 'items', 'bonds', 'config');
        const b = S.createBattleFromSpec(spec, ds, { quiet: true });
        let view;
        const frame = () => {
          const ev = b.drainEvents();
          if (ev.length) view.pushEvents({ t: 'b.ev', fieldId: spec.fieldId, gt: b.time, ev });
          const { t, ...snap } = b.snapshot();
          view.pushSnapshot({ ...snap, t: 'b.snap', fieldId: spec.fieldId, gt: t });
        };
        const raf = () => new Promise(resolve => requestAnimationFrame(resolve));
        const reset = async () => {
          view?.destroy();
          view = await createFieldView(document.querySelector('#field'), { data, assets, board: '2d',
            playbackTime: () => b.time, settings: { quality: 'high', officialFx: 'off', damageNumbers: false } });
          view.setStage(data.lookup('stages', spec.stageId));
          view.enterBattle({ ...b.fieldMeta(), fieldId: spec.fieldId, kind: 'normal', rect: spec.rect, stageId: spec.stageId });
          view.setCamera('normal', { rect: spec.rect, side: 'L', instant: true });
          view.setLocalFeed({ on: true, speed: 2 });
          frame();
        };
        const read = () => {
          const out = { t: b.time, units: [], simForm: b.enemies.find(e => e.defId === 'enemy_10116_ymgtop')?.form };
          for (const [id, v] of view.debug.views) out.units.push({ id, defId: v.info.defId, spine: v.info.spine, skin: v.info.skin,
            alive: v.alive, down: !!v.down, ring: !!v._downRing?.root?.visible, clip: v.actor?.current, form: v.form,
            alpha: v.alpha, ready: v.spineReady,
            visibleSlots: v.actor?.spine.skeleton.drawOrder.filter(s => { const a = s.getAttachment();
              return a && (s.color?.a ?? 1) * (a.color?.a ?? 1) > .004; }).length || 0 });
          return out;
        };
        await reset();
        window.__actions = { b, frame, reset, read, destroy: () => view.destroy(),
          async advance(frames, ticks = 1) { const out = []; for (let i = 0; i < frames; i++) {
            for (let j = 0; j < ticks; j++) b.step(); frame(); await raf(); out.push(read());
          } return out; },
        };
      }, SPEC);
      const advance = (n, ticks = 1) => page.evaluate((n, ticks) => window.__actions.advance(n, ticks), n, ticks);
      const read = () => page.evaluate(() => window.__actions.read());
      await advance(15);
      await page.waitForFunction(() => window.__actions.read().units.filter(u => u.ready).length >= 3, { timeout: 20000 });
      await advance(10);
      const down = (await read()).units.find(u => u.spine === 'char_4134_cetsyr');
      assert.ok(down.down && down.ring && down.alpha > .8 && down.visibleSlots > 10, JSON.stringify(down));
      assert.equal(down.skin, skin);
      assert.equal(down.clip, 'Stun');
      await page.screenshot({ path: path.join(OUT, 'skin-actions-down.png') });

      while ((await read()).t < 9.7) await advance(10);
      const entering = await advance(36);
      const ninja = row => row.units.find(u => u.defId === 'enemy_10116_ymgtop');
      assert.ok(entering.some(row => ninja(row)?.clip === 'Skill_Begin'), `opening form event reaches the real field: ${JSON.stringify(entering.filter((_, i) => i % 5 === 0).map(row => ({ t: row.t, clip: ninja(row)?.clip, form: ninja(row)?.form, sim: row.simForm })))}`);
      assert.ok(entering.some(row => ninja(row)?.clip === 'Skill_Loop'), 'rotating body follows the opening clip');
      await page.screenshot({ path: path.join(OUT, 'skin-actions-spin.png') });
      await page.evaluate(() => window.__actions.reset());
      await advance(15);
      await page.waitForFunction(() => window.__actions.read().units.some(u => u.form === 'spin' && u.ready), { timeout: 10000 });
      const loaded = await read();
      assert.equal(ninja(loaded).clip, 'Skill_Loop', 'a field entered during the spin reconstructs it from UnitInfo');
      assert.ok(loaded.units.find(u => u.spine === 'char_4134_cetsyr').visibleSlots > 10, 'a down outfit also survives field reconstruction');

      await page.evaluate(() => { const { b } = window.__actions;
        b.displace(b.enemies.find(e => e.defId === 'enemy_10116_ymgtop'), { x: -1, y: 0 }, .2, { force: 3 });
      });
      const exiting = await advance(30);
      assert.ok(exiting.some(row => ninja(row)?.clip === 'Skill_End'), '失衡 plays the closing clip');
      assert.ok(exiting.slice(-5).every(row => !/^Skill_/.test(ninja(row)?.clip || '')), 'normal motion/attack resumes');
      await page.evaluate(() => { const { b } = window.__actions;
        b.getPlayer('P').dp = 100;
        b.allyUnits.find(u => u.uid === 1).respawnAt = b.time + .1;
      });
      await advance(60);
      const revived = (await read()).units.find(u => u.spine === 'char_4134_cetsyr');
      assert.ok(revived.alive && !revived.down && !revived.ring && revived.visibleSlots > 10, JSON.stringify(revived));
      assert.notEqual(revived.clip, 'Stun');
      await page.setViewport({ width: 844, height: 390 });
      await advance(5);
      await page.screenshot({ path: path.join(OUT, 'skin-actions-revived-mobile.png') });
      assert.deepEqual(errors, []);
      await page.evaluate(() => window.__actions.destroy());
    } finally { await browser?.close(); await srv.close(); }
  });
