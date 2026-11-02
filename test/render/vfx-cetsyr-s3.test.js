import test from 'node:test';
import assert from 'node:assert/strict';
import { skillPlan, modeAuraUses, planKeys } from '../../public/js/render/vfx/skills.js';
import { SkillFx } from '../../public/js/render/vfx/skillfx.js';
import { compileEffect, Effect } from '../../public/js/render/vfx/effect.js';
import { cameraBasis } from '../../public/js/render/vfx/geom.js';

const CHAR = 'char_4134_cetsyr', SKILL = 'skchr_cetsyr_3';
const BODY = 'cetsyr_skill_03_buff_01', COLLECT = 'cetsyr_skill_03_buff_02';
const RANGE = 'cetsyr_skill_03_buff_range_01', HEAL = 'cetsyr_buff_02', BURST = 'cetsyr_skill_03_burst_01';
function fixture() {
  const mode = { name: 'S3', attack: { class: 'AuraAbility', node: 'Modes/S3/Body/AuraHeal' } };
  const idx = { prefabs: Object.fromEntries([BODY, COLLECT, RANGE, HEAL, BURST].map((k) => [k, { looping: k !== BURST }])),
    units: { [CHAR]: { modes: [mode], skills: { [SKILL]: { mode: 0, uses: [
      { role: 'loop', keys: [BODY], from: 'AuraAbility._passiveBuffs', node: 'Encourage', on: 'owner' },
    ] } } } }, projectiles: {} };
  const rec = { charId: CHAR, skill: { skillId: SKILL, index: 2, duration: 30, rangeGrid: [[0, 0], [0, 1]] } };
  const handles = [];
  const w = { idx, opts: { record: () => rec }, unitKeyOf: (v) => idx.units[v.info.spine] ? v.info.spine : null,
    ofx: { active: true, tier: 'full', time: 0, lib: { has: (k) => !!idx.prefabs[k] } },
    skinFxKey: (k, skin) => skin ? `${k}_skin` : k, outfitOf: (v) => v.info.skin,
    playOn(key, v, opts) { const h = { key, v, opts, alive: true, stop() { this.alive = false; } }; handles.push(h); return h; },
    statusShows: () => false,
  };
  const s = new SkillFx(w);
  const view = (id, x, more = {}) => ({ id, x, y: 5, z: 0, alive: true, flags: 16, dir: 'RIGHT',
    info: { id, kind: 'chess', side: 'ally', spine: CHAR, ownerId: 1, skillIndex: 2 }, ...more });
  const live = (key) => handles.filter((h) => h.key === key && h.alive);
  return { idx, mode, rec, w, s, view, handles, live };
}

test('old index restores owner / range and carrier FX; new metadata wins; other operators are untouched', () => {
  const { idx, mode, rec } = fixture();
  const p = skillPlan(idx, CHAR, SKILL, { rec: rec.skill });
  assert.deepEqual(new Set(p.loop.map((e) => e.key)), new Set([BODY, COLLECT, RANGE]));
  assert.deepEqual(p.targets.map((e) => e.key), [HEAL]);
  assert.ok([COLLECT, RANGE, HEAL].every((k) => planKeys(p).includes(k)), 'all restored effects preload');
  mode.attack.buffUses = modeAuraUses(mode, CHAR, SKILL);
  assert.equal(skillPlan(idx, CHAR, SKILL).loop.length, 3, 'new export is not doubled by fallback');
  mode.attack.buffUses = [];
  assert.equal(skillPlan(idx, CHAR, SKILL).loop.length, 1, 'explicit empty metadata is respected');
  delete mode.attack.buffUses;
  assert.deepEqual(modeAuraUses(mode, 'char_other', SKILL), []);
  assert.deepEqual(modeAuraUses(mode, CHAR, 'skchr_cetsyr_2'), []);
  delete idx.prefabs[RANGE];
  assert.ok(!planKeys(skillPlan(idx, CHAR, SKILL)).includes(RANGE), 'missing optional assets are not invented');
});

test('carrier aura follows skill grid / side, includes unite partners, and cleans up / rebuilds from snapshot', () => {
  const { s, w, view, live } = fixture();
  const src = view(1, 5), target = view(2, 6, { flags: 0 });
  target.info = { ...target.info, spine: 'char_other' };
  const outsider = view(3, 7), otherOwner = view(4, 6), enemy = view(5, 6);
  outsider.info.spine = otherOwner.info.spine = enemy.info.spine = 'char_other';
  otherOwner.info.ownerId = 2; enemy.info.side = 'enemy';
  const sync = () => s.sync([src, target, outsider, otherOwner, enemy]);
  const onTarget = () => live(HEAL).filter((h) => h.v === target);
  sync(); sync();
  assert.deepEqual(new Set(live(HEAL).map((h) => h.v)), new Set([target, otherOwner]), 'alliesInGrid includes other owners on the same field');
  assert.equal(live(RANGE).length, 1); assert.equal(live(COLLECT).length, 1);
  target.x = 7; sync(); assert.equal(onTarget().length, 0);
  target.x = 6; sync(); assert.equal(onTarget().length, 1);
  src.flags = 0; sync(); assert.equal(live(HEAL).length, 0); assert.equal(live(RANGE).length, 0);
  src.flags = 16; sync(); assert.equal(onTarget().length, 1);
  target.down = true; sync(); assert.equal(onTarget().length, 0);
  target.down = false; src.dir = 'LEFT'; sync(); assert.equal(live(HEAL).length, 0);
  src.dir = 'RIGHT'; sync(); assert.equal(onTarget().length, 1);
  w.ofx.tier = 'light'; sync(); assert.equal(onTarget().length, 1, 'tier rebuild creates one loop per ally');
  s.clear(); assert.equal(live(HEAL).length, 0);
});

test('two casters share a carrier loop, retain it when one dies, and use the caster skin', () => {
  const { s, w, idx, view, live } = fixture();
  const a = view(1, 5), b = view(2, 5), target = view(3, 6, { flags: 0 });
  b.info.ownerId = 2;
  target.info.spine = 'char_other';
  const onTarget = (key) => live(key).filter((h) => h.v === target);
  s.sync([a, b, target]); assert.equal(onTarget(HEAL).length, 1);
  a.alive = false; s.release(a); assert.equal(onTarget(HEAL).length, 1);
  b.alive = false; s.release(b); assert.equal(onTarget(HEAL).length, 0);
  a.alive = true; a.info.skin = 'outfit'; idx.prefabs[HEAL + '_skin'] = { looping: true };
  s.sync([a, target]);
  assert.equal(live(HEAL + '_skin').length, 1);
  assert.equal(live(HEAL + '_skin')[0].opts.skinFrom, a);
  w.ofx.active = false; s.sync([a, target]); assert.equal(live(HEAL + '_skin').length, 0);
});

test('redistribution uses the official burst only on the existing sim event, while S3 is on', () => {
  const { s, w, view, live, idx } = fixture();
  const src = view(1, 5); w.view = () => src;
  s.sync([src]); assert.equal(live(BURST).length, 0);
  assert.equal(s.simFx('redistribute', 5, 5, { id: 1 }), true);
  assert.equal(live(BURST).length, 1);
  assert.equal(s.simFx('hpShare', 5, 5, { id: 1 }), true, 'the hidden tier uses its existing hpShare event');
  src.flags = 0; s.sync([src]);
  assert.equal(s.simFx('redistribute', 5, 5, { id: 1 }), false);
  delete idx.prefabs[BURST]; src.flags = 16; s.sync([src]);
  assert.equal(s.simFx('redistribute', 5, 5, { id: 1 }), false, 'procedural fallback remains when the asset is absent');
  src.info.skin = 'outfit'; idx.prefabs[BURST + '_skin'] = {};
  assert.equal(s.simFx('redistribute', 5, 5, { id: 1 }), true, 'installed outfit variants work even if the base asset is absent');
});

test('body children behind the skeleton sort below it; foreground / positive orders stay above', () => {
  const n = (id, parent, pos, more = {}) => ({ id, parent, name: `n${id}`, children: [], active: true,
    pos, rot: [0, 0, 0, 1], scale: [1, 1, 1], ...more });
  const mat = { name: 'm', shader: 'Torappu/Particles/Additive', passes: [{ blend: ['SrcAlpha', 'One', 'Zero', 'OneMinusSrcAlpha'],
    blendOp: 'Add', zTest: 'Disabled', zWrite: false, cull: 'Off', colorMask: 15 }], queue: 'Transparent', keywords: [],
    floats: {}, colors: {}, textures: {} };
  const mesh = { positions: [0, 0, 0, 1, 0, 1, -1, 0, 1], submeshes: [[0, 1, 2]] };
  const mr = (order) => ({ meshFilter: 'cone', meshRenderer: { m_Enabled: true, materials: [0], m_SortingOrder: order, m_SortingLayer: 0 } });
  const d = { key: 'aura', nodes: [n(0, null, [0, 0, 0]), n(1, 0, [0, 0, 0]), n(2, 1, [0, 0, 0.104]),
    n(3, 2, [0, 0.816, 0], mr(0)), n(4, 1, [0, 0.816, -0.2], mr(0)), n(5, 2, [0, 0.816, 0], mr(3))],
  materials: [mat], clips: [], stats: {} };
  for (const mirror of [false, true]) {
    const fx = new Effect(compileEffect(d), { lib: { mesh: () => mesh } });
    fx.place({ pos: [3, 4, -0.42], rootRot: [Math.sin(Math.PI / 12), 0, 0, Math.cos(Math.PI / 12)], scale: 1.1574, mirror });
    fx.update(1 / 30);
    const entries = []; fx.gather(cameraBasis(30, [0, -5, -8], 720, 0.7), (e) => entries.push(e));
    assert.deepEqual(entries.map((e) => [e.node, e.ground]), [[3, true], [4, false], [5, false]]);
  }
});
