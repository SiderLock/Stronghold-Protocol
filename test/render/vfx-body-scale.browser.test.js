// RENDER_E2E=1 CHROME_PATH=<Edge> node --test test/render/vfx-body-scale.browser.test.js
// Real 3D field / Spine / sim, with SP filled locally to exercise casts without waiting through a match.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { startServer } from '../../server/index.js';
import { UNIT } from '../../public/js/render/style.js';

const EDGE = process.env.CHROME_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const ROOT = path.resolve(import.meta.dirname, '../..');
const SCALE = UNIT.modelScale / (0.27 * 0.01);

test('Magic S2/S3, default and outfit: attached FX align with model scale; ground FX retain tile size', {
  skip: process.env.RENDER_E2E !== '1', timeout: 180000,
}, async (t) => {
  const out = await fs.mkdtemp(path.join(ROOT, '.cache', 'skin-fx-battle-'));
  const report = { errors: [], cases: [] };
  let server, browser;
  try {
    server = await startServer({ port: 0, host: '127.0.0.1', quiet: true,
      announcementsDir: path.join(out, 'news'), serverSettingsDir: path.join(out, 'settings') });
    browser = await puppeteer.launch({ executablePath: EDGE, headless: true,
      args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });
    report.browser = await browser.version();
    for (const skill of [1, 2]) for (const skin of [null, 'char_4134_cetsyr@epoque#50']) {
      const page = await browser.newPage();
      page.on('pageerror', (e) => report.errors.push(e.message));
      await page.setViewport({ width: 1280, height: 800 });
      const msg = JSON.parse(await fs.readFile(path.join(ROOT, 'public/dev/perf/hard-normal-r13.json'), 'utf8'));
      msg.speed = 0.5;
      const p = msg.spec.players[0];
      p.units = [{ uid: 900, kind: 'chess', chessId: 'chess_char_4_25_b', row: 11, col: 4,
        dir: skill === 1 ? 'LEFT' : 'RIGHT', items: [], skillIndex: skill }];
      if (skill === 2) p.units.push({ uid: 901, kind: 'chess', chessId: 'chess_char_1_02_a', row: 10, col: 4,
        dir: 'RIGHT', items: [], skillIndex: 0 });
      p.bonds = []; p.playerEffects = [];
      await page.setRequestInterception(true);
      page.on('request', (r) => r.url().endsWith('/dev/perf/hard-normal-r13.json')
        ? void r.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(msg) }) : void r.continue());
      await page.goto(server.url + '/dev/battle-perf.html?spec=hard-normal-r13&quality=high&fx=full&board=3d&panel=0');
      await page.waitForFunction(() => window.__perf?.ready && window.__perf.view.debug.ofx.active
        && window.__perf.view.debug.wiring.idx && [...window.__perf.view.debug.views.values()].some((v) => v.info.spine === 'char_4134_cetsyr'));
      await page.evaluate((skin) => {
        const f = window.__perf, v = [...f.view.debug.views.values()].find((v) => v.info.spine === 'char_4134_cetsyr');
        f.runner.setPaused(true); window.__fxUnit = v.id;
        f.view.setMe(v.info.ownerId);
        f.view.setSkins([{ playerId: v.info.ownerId, skins: skin ? { char_4134_cetsyr: skin } : {} }]);
      }, skin);
      await page.waitForFunction(() => window.__perf.view.debug.views.get(window.__fxUnit)?.spineReady);
      await page.evaluate(async () => {
        const f = window.__perf, d = f.view.debug, v = d.views.get(window.__fxUnit);
        await d.ofx.lib.preload(d.wiring.keysFor([v]));
        const unit = [...f.runner._entries.values()][0].battle.allyUnits[0];
        const b = [...f.runner._entries.values()][0].battle;
        window.__redistFx = [];
        const original = b.fx.bind(b);
        b.fx = (kind, params) => { if (kind === 'redistribute' || kind === 'hpShare') window.__redistFx.push({ time: b.time, kind }); original(kind, params); };
        unit.skill.sp = unit.skill.spCost; f.runner.setPaused(false);
      });
      await page.waitForFunction(() => window.__perf.view.debug.views.get(window.__fxUnit)?.actor?.skillOn);
      // Let the cast's opening reach its loop while the real renderer advances particles and the skeleton together.
      await page.waitForFunction(() => /Loop/.test(window.__perf.view.debug.views.get(window.__fxUnit)?.actor?.spine.state.tracks[0]?.animation?.name || ''), { timeout: 15000 });
      if (skill === 2) {
        try {
          await page.waitForFunction(() => window.__perf.view.debug.ofx.effects.some((e) => e.def?.key?.startsWith('cetsyr_skill_03_burst_01')), { timeout: 10000 });
        } catch (e) {
          t.diagnostic(JSON.stringify(await page.evaluate(() => {
            const f = window.__perf, b = [...f.runner._entries.values()][0].battle;
            return { time: b.time, units: b.allyUnits.map((u) => ({ id: u.id, x: u.x, y: u.y, alive: u.alive,
              skill: u.skill?.def, active: u.skill?.active, redist: u.mem.redist, hp: u.hp, range: u.rangeKeys })),
            pool: b.alliesInGrid(b.allyUnits[0]).map((u) => ({ id: u.id, noHeal: u.s.flags.noHeal, profileNoHeal: u.profile.noHeal })),
            emitted: window.__redistFx, fx: f.view.debug.ofx.effects.map((e) => e.def?.key) };
          })));
          throw e;
        }
      }
      const state = await page.evaluate(() => {
        const f = window.__perf, d = f.view.debug, v = d.views.get(window.__fxUnit);
        f.runner.setPaused(true); d.app.ticker.stop(); d.app.renderer.render(d.app.stage);
        const effects = d.ofx.effects.filter((e) => e.owner?.id === v.id && e.def?.key?.startsWith('cetsyr'));
        return { skin: v.info.skin, skill: v.info.skillIndex, z: v.z, modelScale: v.effectScale,
          carriers: [...d.wiring.skills.skillAuras.values()].map((t) => ({ key: t.h.effect?.def?.key, target: t.v.id })),
          draws: [...d.ofx.items.ground, ...d.ofx.items.over].filter((e) => e.effect?.def?.key?.startsWith('cetsyr_skill_03_buff_01'))
            .map((e) => ({ key: e.effect.def.key, node: e.effect.def.nodes[e.node].name, order: e.order, ground: e.ground })),
          effects: effects.map((e) => ({ key: e.def.key, scale: e.scale, spawn: e.def.spawn,
            anchor: e.anchor.slice(), finite: e.world.every((m) => [...m].every(Number.isFinite)) })) };
      });
      assert.ok(state.z > 0, 'the case exercises a raised tile');
      assert.equal(state.modelScale, SCALE);
      if (skill === 2) assert.ok(state.effects.some((e) => e.spawn === 1), 'S3 draws its real body-attached prefab');
      if (skill === 2) {
        const suffix = skin ? '_epoque#50' : '';
        for (const key of ['cetsyr_skill_03_buff_02', 'cetsyr_skill_03_buff_range_01', 'cetsyr_skill_03_burst_01'])
          assert.ok(state.effects.some((e) => e.key === key + suffix), key + ' plays with the caster outfit');
        assert.ok(state.carriers.some((t) => t.key === 'cetsyr_buff_02' + suffix), 'the ally receives the caster outfit aura');
        if (!skin) assert.ok(state.draws.some((e) => e.node === 'beijing_01' && e.ground), 'nested black/red background is behind the model');
        assert.ok(state.draws.some((e) => e.order > 0 && !e.ground), 'foreground remains above the model');
      }
      assert.ok(state.effects.some((e) => e.spawn === 5), 'a real ground aura is drawn');
      for (const e of state.effects) {
        assert.equal(e.scale, e.spawn === 5 || e.spawn === 7 ? 1 : SCALE, e.key);
        assert.equal(e.finite, true, e.key);
        if (e.spawn === 5 || e.spawn === 7) assert.ok(Math.abs(e.anchor[2] + state.z) < 1e-5, e.key);
      }
      const name = `s${skill + 1}-${skin ? 'outfit' : 'default'}`;
      await page.screenshot({ path: path.join(out, name + '.png') });
      if (skill === 2) {
        await page.evaluate(() => {
          const f = window.__perf;
          [...f.runner._entries.values()][0].battle.allyUnits[0].skill.timeLeft = 0.05;
          f.view.debug.app.ticker.start(); f.runner.setPaused(false);
        });
        await page.waitForFunction(() => {
          const d = window.__perf.view.debug;
          return !d.views.get(window.__fxUnit)?.actor?.skillOn && !d.wiring.skills.skillAuras.size
            && !d.ofx.effects.some((e) => e.state === 'play' && e.def?.key?.startsWith('cetsyr_skill_03_buff'));
        }, { timeout: 10000 });
        await page.screenshot({ path: path.join(out, name + '-end.png') });
      }
      report.cases.push({ name, ...state });
      await page.close();
    }
    assert.deepEqual(report.errors, []);
  } finally {
    await browser?.close(); await server?.close();
    await fs.writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    t.diagnostic(`artifacts: ${out}`);
  }
});
