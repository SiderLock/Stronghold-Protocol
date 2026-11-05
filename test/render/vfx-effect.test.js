// test/render/vfx-effect.test.js — official effect instances and their surroundings (render/vfx, DESIGN §33.4–§33.12):
// the lifecycle (delay to play, FxDelay, clips on m_IsActive, loops and stop, linger, max lifetime), direction helpers
// (`_rotationZ` replaced, `_rotationY` flips, mirrors), draw items, the material compiler (families, blend states,
// fallbacks, the light tier), the library (file list, Phase 1a fallback, built-in meshes, byte mesh colours), the tier
// setting and the event wiring (attack modes, generic hits, status loops, deaths, deploys).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { compileEffect, Effect, DIR_YAW } from '../../public/js/render/vfx/effect.js';
import { compileMaterial, familyOf, fallbackLog, BLEND } from '../../public/js/render/vfx/materials.js';
import { FxLibrary, builtinMesh, normalizeMesh } from '../../public/js/render/vfx/library.js';
import { FrameData, cameraBasis } from '../../public/js/render/vfx/geom.js';
import { resolveOfficialFx } from '../../public/js/render/vfx/tier.js';
import { FxWiring } from '../../public/js/render/vfx/wiring.js';
import { listHasEffects } from '../../public/js/render/vfx/available.js';
import { OfficialFx, LOOP_TTL, MAX_EFFECTS, MAX_PARTICLES } from '../../public/js/render/vfx/system.js';
import { quatEuler, quatRotate } from '../../public/js/render/vfx/math.js';
import { presetCamera } from '../../public/js/render/projection.js';

const MAT = {
  name: 'm', shader: 'Torappu/Particles/Additive', passes: [{ blend: ['SrcAlpha', 'One', 'Zero', 'OneMinusSrcAlpha'], blendOp: 'Add', zTest: 'Disabled', zWrite: false, cull: 'Off', colorMask: 15 }],
  queue: 'Transparent', keywords: [], floats: { _MainTexChannel: 0 }, colors: { _TintColor: [1, 1, 1, 1] }, textures: { _MainTex: { tex: 't', st: [1, 1, 0, 0] } },
};

/** A burst system node. */
const psNode = (id, parent, o = {}) => ({
  id, name: `ps${id}`, parent, children: [], active: o.active ?? true, pos: [0, 0, 0], rot: o.rot || [0, 0, 0, 1], scale: [1, 1, 1],
  particleSystem: { lengthInSec: o.len ?? 0.5, looping: !!o.loop, prewarm: false, startDelay: 0, playOnAwake: true, simulationSpeed: 1, moveWithTransform: 0, scalingMode: 1,
    InitialModule: { startLifetime: o.life ?? 0.3, startSpeed: 0, startSize: 1, startColor: [1, 1, 1, 1], maxNumParticles: 100 },
    EmissionModule: { rateOverTime: o.rate ?? 0, m_Bursts: o.rate ? [] : [{ time: 0, countCurve: 2, cycleCount: 1, repeatInterval: 0.01, probability: 1 }] } },
  particleSystemRenderer: { m_Enabled: true, renderMode: 'billboard', renderAlignment: 'view', materials: [0, null], m_SortingOrder: o.order ?? 0 },
  behaviours: o.behaviours || [],
});

function desc(nodes, extra = {}) {
  for (const n of nodes) if (n.parent != null) nodes[n.parent].children.push(n.id);
  return { format: 'fx-prefab', version: 1, key: 'test', nodes, materials: [MAT], clips: [], textures: ['t'], meshes: [], refs: [], stats: {}, ...extra };
}

const root = (behaviours = []) => ({ id: 0, name: 'root', parent: null, children: [], active: true, pos: [0, 0, 0], rot: [0, 0, 0, 1], scale: [1, 1, 1], behaviours });
const pe = (fields) => ({ class: 'ParticleEffect', enabled: true, fields: { _delayToPlay: 0, _delayToFinish: 0, _maxLifetime: -1, _isLoop: 0, _rotateType: 0, _spawnLocation: 2, _inactiveOnFinish: [], ...fields } });

function runUntil(fx, seconds, dt = 1 / 30) { for (let t = 0; t < seconds && !fx.done; t += dt) fx.update(dt); return fx; }

describe('effect lifecycle', () => {
  test('a one-shot finishes when its particles are gone, then lingers `_delayToFinish`', () => {
    const fx = new Effect(compileEffect(desc([root([pe({ _delayToFinish: 0.4 })]), psNode(1, 0)])), { seed: 1 });
    fx.update(1 / 30);
    assert.equal(fx.sys[1].count, 2);
    runUntil(fx, 0.5);
    assert.equal(fx.state, 'linger');
    runUntil(fx, 0.5);
    assert.ok(fx.done);
  });

  test('`_delayToPlay` holds everything back', () => {
    const fx = new Effect(compileEffect(desc([root([pe({ _delayToPlay: 0.3 })]), psNode(1, 0)])), { seed: 1 });
    runUntil(fx, 0.25);
    assert.equal(fx.sys[1].count, 0);
    runUntil(fx, 0.1);
    assert.equal(fx.sys[1].count, 2);
  });

  test('FxDelay activates its node (and plays its system) after its delay', () => {
    const fx = new Effect(compileEffect(desc([root([pe({})]), psNode(1, 0, { behaviours: [{ class: 'FxDelay', enabled: true, fields: { _delayTime: 0.2 } }] })])), { seed: 1 });
    runUntil(fx, 0.15);
    assert.equal(fx.hier[1], 0);
    assert.equal(fx.done, false, 'a pending FxDelay keeps the effect alive');
    runUntil(fx, 0.1);
    assert.equal(fx.hier[1], 1);
    assert.equal(fx.sys[1].count, 2);
  });

  test('a clip on m_IsActive switches a node (and its system plays when it turns on)', () => {
    const d = desc([root([pe({})]), psNode(1, 0, { active: false })], {
      clips: [{ name: 'c', length: 1, loop: false, curves: [{ node: 1, type: 'GameObject', property: 'm_IsActive', keys: [[0, 0, null, null], [0.5, 1, null, null]] }] }],
    });
    d.nodes[0].animator = { controller: 'c', clips: [0], default: 0, enabled: true };
    const fx = new Effect(compileEffect(d), { seed: 1 });
    runUntil(fx, 0.4);
    assert.equal(fx.sys[1].count, 0);
    runUntil(fx, 0.2);
    assert.equal(fx.sys[1].count, 2);
  });

  test('a looping effect runs until stop(), then fades out within STOP_FADE', () => {
    const fx = new Effect(compileEffect(desc([root([pe({ _isLoop: 1 })]), psNode(1, 0, { loop: true, rate: 20, life: 10 })])), { seed: 1 });
    runUntil(fx, 3);
    assert.equal(fx.done, false);
    fx.stop();
    assert.equal(fx.state, 'stopping');
    runUntil(fx, 0.4);
    assert.ok(fx.fade < 1 || fx.done, 'fading');
    runUntil(fx, 0.4);
    assert.ok(fx.done, 'long-lived particles do not outlive the stop');
  });

  test('`_maxLifetime` ends a looping effect; `stop({ hit })` hides `_inactiveOnHit` nodes', () => {
    const fx = new Effect(compileEffect(desc([root([pe({ _isLoop: 1, _maxLifetime: 0.5 })]), psNode(1, 0, { loop: true, rate: 10 })])), { seed: 1 });
    runUntil(fx, 1);
    assert.ok(fx.done);
    const d = desc([root([{ class: 'ProjectileEffect', enabled: true, fields: { _inactiveOnHit: [{ node: 1 }], _mainDir: 1 } }]), psNode(1, 0, { loop: true, rate: 10 }), psNode(2, 0, { loop: true, rate: 10 })]);
    const p = new Effect(compileEffect(d), { seed: 1 });
    runUntil(p, 0.5);
    p.stop({ hit: true });
    p.update(1 / 30);
    assert.equal(p.hier[1], 0);
    assert.equal(p.hier[2], 1);
  });

  test('a reset (pooled) instance plays like a new one', () => {
    const def = compileEffect(desc([root([pe({ _delayToFinish: 0.2 })]), psNode(1, 0, { behaviours: [{ class: 'FxDelay', enabled: true, fields: { _delayTime: 0.1 } }] })]));
    const a = new Effect(def, { seed: 5 });
    const trace = (fx) => { const out = []; for (let i = 0; i < 30; i++) { fx.update(1 / 30); out.push(`${fx.state}:${fx.sys[1].count}`); } return out.join(','); };
    const first = trace(a);
    assert.ok(a.done);
    a.reset(5);
    assert.equal(a.state, 'play');
    assert.equal(trace(a), first);
    assert.equal(trace(new Effect(def, { seed: 5 }).reset(5)), first);
  });

  test('onFinish runs once when the effect finishes (OnFinishEmitter chains)', () => {
    let n = 0;
    const fx = new Effect(compileEffect(desc([root([pe({})]), psNode(1, 0)])), { seed: 1 });
    fx.onFinish = () => n++;
    runUntil(fx, 2);
    assert.equal(n, 1);
  });
});

test('an unowned looping effect ends after LOOP_TTL; an OnPlayEmitter loop is owned and stopped with its parent', () => {
  const loopy = compileEffect(desc([root([pe({ _isLoop: 1 })]), psNode(1, 0, { loop: true, rate: 10 })], { key: 'loopy' }));
  const parent = compileEffect(desc([root([pe({}), { class: 'OnPlayEmitter', enabled: true, fields: { _effects: ['loopy'], _preDelay: 0 } }]), psNode(1, 0)], { key: 'parent' }));
  const defs = new Map([['loopy', loopy], ['parent', parent]]);
  const lib = { available: true, defs, has: (k) => defs.has(k), def: (k) => defs.get(k) || null, load: async (k) => defs.get(k) || null };
  const ofx = new OfficialFx({ P: { Container: class {} }, renderer: null, cam: () => null, lib, tier: 'full' });
  const h = ofx.spawn('loopy', { pos: [0, 0, 0] }, {});
  assert.equal(h.effect.ttl, LOOP_TTL, 'a cast loop the wiring forgot still ends');
  const p = ofx.spawn('parent', { pos: [0, 0, 0] }, { loop: true });
  const child = p.children[0];
  assert.equal(child?.key, 'loopy');
  assert.equal(child.effect.ttl, Infinity, 'owned like the effect that played it');
  p.stop();
  assert.ok(child.stopped, 'stopped with it');
});

describe('placement and direction', () => {
  test('the anchor moves the root; mirror reflects x about the anchor', () => {
    const d = desc([root([pe({})]), { ...psNode(1, 0), pos: [0.5, 0, 0] }]);
    const fx = new Effect(compileEffect(d), { seed: 1 }).place({ pos: [2, 3, -1] });
    fx.update(1 / 30);
    assert.deepEqual([fx.world[1][12], fx.world[1][13], fx.world[1][14]], [2.5, 3, -1]);
    fx.place({ mirror: true });
    fx.update(1 / 30);
    assert.equal(fx.world[1][12], 1.5);
  });

  test("a `_rotationZ` helper's authored rotation is replaced by the direction, relative to `_mainDir`", () => {
    const helper = { ...psNode(1, 0), rot: [0, 0, Math.SQRT1_2, Math.SQRT1_2] }; // a leftover 90° in the prefab
    const d = desc([root([pe({ _rotateType: 2, _mainDir: 1, _rotationZ: { node: 1 } })]), helper, { ...psNode(2, 1), pos: [1, 0, 0] }]);
    const fx = new Effect(compileEffect(d), { seed: 1 }).place({ pos: [0, 0, 0], yaw: 0 });
    fx.update(1 / 30);
    assert.ok(Math.abs(fx.world[2][12] - 1) < 1e-6 && Math.abs(fx.world[2][13]) < 1e-6, 'yaw 0 faces +x (RIGHT)');
    fx.place({ yaw: Math.PI / 2 });
    fx.update(1 / 30);
    assert.ok(Math.abs(fx.world[2][13] - 1) < 1e-6, 'yaw 90° faces +y (UP)');
    const up = new Effect(compileEffect(desc([root([pe({ _rotateType: 4, _mainDir: 0, _rotationZ: { node: 1 } })]), { ...psNode(1, 0) }, { ...psNode(2, 1), pos: [0, 1, 0] }])), { seed: 1 }).place({ yaw: 0 });
    up.update(1 / 30);
    assert.ok(Math.abs(up.world[2][12] - 1) < 1e-6, 'art made facing UP turned to the right');
    assert.equal(DIR_YAW[1], 0);
  });

  test('FLIP_TWO_SIDE with a `_rotationY` helper turns it 180° about Y', () => {
    const d = desc([root([pe({ _rotateType: 1, _rotationY: { node: 1 } })]), psNode(1, 0), { ...psNode(2, 1), pos: [1, 0, 0.5] }]);
    const fx = new Effect(compileEffect(d), { seed: 1 }).place({ flipY: true });
    fx.update(1 / 30);
    assert.ok(Math.abs(fx.world[2][12] + 1) < 1e-6 && Math.abs(fx.world[2][14] + 0.5) < 1e-6);
  });

  test('collect: one quad item per visible system with its material and sort keys', () => {
    const fx = new Effect(compileEffect(desc([root([pe({})]), psNode(1, 0, { order: 7 })])), { seed: 1 });
    fx.update(1 / 30);
    const fd = new FrameData();
    const items = [];
    fx.collect(cameraBasis(30, [0, -5, -8], 720, 0.7), fd, (it) => items.push(it), 1);
    assert.equal(items.length, 1);
    assert.equal(items[0].kind, 'quad');
    assert.equal(items[0].count, 2);
    assert.equal(items[0].order, 7);
    assert.equal(items[0].mat.family, 'basic');
    assert.equal(fd.nq, 2);
    // a view billboard's axes lie in the camera plane: x = right, y = camera up
    const b = fd.quad;
    const ax = [b[3], b[4], b[5]], ay = [b[6], b[7], b[8]];
    assert.ok(Math.abs(ax[1] * Math.sin(Math.PI / 6) + ax[2] * Math.cos(Math.PI / 6)) < 1e-6);
    assert.ok(Math.abs(ay[0]) < 1e-6);
  });
});

describe('materials', () => {
  test('equivalent draw state has one batch key while material labels and records stay distinct', () => {
    const source = { ...MAT, floats: { _MainTexChannel: 0, _Opacity: 0.5 },
      textures: { ...MAT.textures, _Mask: { default: 'white', st: [1, 1, 0, 0] } } };
    const a = compileMaterial(source);
    const b = compileMaterial({ ...source, name: 'another label',
      floats: { _Opacity: 0.5, _MainTexChannel: 0 },
      textures: Object.fromEntries(Object.entries(source.textures).reverse()) });
    assert.equal(a.batchKey, b.batchKey);
    assert.notEqual(a, b);
    assert.equal(a.name, 'm');
    assert.equal(b.name, 'another label');
  });

  test('batch keys distinguish uniforms, signed zero, textures, shader variants and every pass state', () => {
    const key = compileMaterial(MAT).batchKey;
    const changes = [
      m => { m.floats._MainTexChannel = 1; },
      m => { m.floats._MainTexChannel = -0; },
      m => { m.colors._TintColor[0] = 0.5; },
      m => { m.textures._MainTex.tex = 'other'; },
      m => { m.textures._MainTex.st[0] = 2; },
      m => { m.textures._MainTex.default = 'black'; },
      m => { m.keywords = ['_HGCUSTOMVERTEXSTREAM_ON']; },
      m => { m.keywords = ['_WEIGHT_ON']; },
      m => { m.passes[0].blend[0] = 'One'; },
      m => { m.passes[0].blend[1] = 'Zero'; },
      m => { m.passes[0].blend[2] = 'One'; },
      m => { m.passes[0].blend[3] = 'One'; },
      m => { m.passes[0].blendOp = 'Sub'; },
      m => { m.passes[0].zTest = 'Less'; },
      m => { m.passes[0].zWrite = true; },
      m => { m.passes[0].cull = 'Back'; },
      m => { m.passes[0].colorMask = 7; },
    ];
    for (const change of changes) {
      const material = structuredClone(MAT);
      change(material);
      assert.notEqual(compileMaterial(material).batchKey, key, String(change));
    }
    assert.notEqual(compileMaterial(MAT, { lite: true }).batchKey, key);
    assert.equal(compileMaterial({ ...MAT, queue: NaN }).batchKey, key, 'queue is ordering metadata');
  });

  test('families by shader name; an unknown shader falls back and is logged', () => {
    assert.equal(familyOf('Torappu/Particles/Ram/Disturb(CustomData)').family, 'ramDisturbCd');
    assert.equal(familyOf('Torappu/Particles/Dissolve/Dissolve AB UVTween').family, 'dissolveTween');
    assert.equal(familyOf('Legacy Shaders/Particles/Alpha Blended Premultiply').family, 'legacyPremul');
    const f = familyOf('Torappu/Particles/Disturb/Disturb GrabPass');
    assert.ok(f.fallback && f.family === 'basic');
    assert.ok(fallbackLog().some(([n]) => n === 'Torappu/Particles/Disturb/Disturb GrabPass'));
  });

  test('the pass state, keywords and ST vectors are compiled; the light tier drops Rim and distortion', () => {
    const m = compileMaterial({ ...MAT, shader: 'Torappu/Particles/Disturb/Disturb(CustomData)', keywords: ['_HGCUSTOMVERTEXSTREAM_ON'],
      passes: [{ blend: ['SrcAlpha', 'OneMinusSrcAlpha', 'Zero', 'OneMinusSrcAlpha'], blendOp: 'Add', zTest: 'LessEqual', zWrite: false, cull: 'Back', colorMask: 15 }],
      textures: { _MainTex: { tex: 'a', st: [2, 1, 0.5, 0] }, _DisturbTex: { tex: null, st: [1, 1, 0, 0], default: 'black' } } });
    assert.equal(m.family, 'disturbCd');
    assert.ok(m.defs.cvs);
    assert.deepEqual(m.vecs._MainTex_ST, [2, 1, 0.5, 0]);
    assert.equal(m.state.src, BLEND.SrcAlpha); assert.equal(m.state.dst, BLEND.OneMinusSrcAlpha);
    assert.equal(m.state.zTest, 'lequal'); assert.equal(m.state.cull, 'Back');
    assert.deepEqual(m.textures.find((t) => t.name === '_DisturbTex'), { name: '_DisturbTex', key: null, def: 'black' });
    assert.equal(compileMaterial(MAT).state.zTest, null, 'ZTest Disabled = no depth test');
    const lite = compileMaterial({ ...MAT, shader: 'Torappu/Particles/Rim/Rim Tint (Add)' }, { lite: true });
    assert.equal(lite.family, 'basic');
    assert.ok(compileMaterial({ ...MAT, shader: 'Torappu/Particles/Disturb/Disturb Origin' }, { lite: true }).defs.lite);
  });
});

test('official FX batches adjacent equivalent materials and preserves order, pass and override boundaries', () => {
  const mat = () => compileMaterial(MAT);
  function prepare(rows) {
    const renderer = { screen: { width: 960, height: 540 } };
    const cam = presetCamera('normal', renderer.screen);
    const ofx = new OfficialFx({ P: { Container: class {} }, renderer, cam: () => cam, lib: { available: true }, tier: 'full' });
    ofx.glr = { upload() {} };
    ofx.effects = rows.map(row => ({
      gather(_cam, sink) { sink({ mat: row.mat, ov: row.ov || null, ground: !!row.ground,
        layer: 0, order: 0, queue: row.mat.queue ?? 3000, dist: 0, meshKey: null, submesh: 0, effect: this }); },
      build(_entry, _cam, fd) { return { kind: 'quad', first: fd.quads(1), count: 1 }; },
    }));
    ofx._prepare(renderer);
    return ofx.items;
  }
  const a = mat(), b = mat();
  assert.deepEqual(prepare([{ mat: a }, { mat: b }]).over.map(item => item.count), [2]);
  const other = compileMaterial({ ...MAT, floats: { _MainTexChannel: 1 } });
  assert.deepEqual(prepare([{ mat: a }, { mat: other }, { mat: b }]).over.map(item => item.mat), [a, other, b]);
  assert.equal(prepare([{ mat: a, ov: { _Opacity: 0.5 } }, { mat: b }]).over.length, 2);
  const split = prepare([{ mat: a, ground: true }, { mat: b }]);
  assert.equal(split.ground.length, 1);
  assert.equal(split.over.length, 1);
  const earlier = compileMaterial({ ...MAT, queue: 2900 });
  const ordered = prepare([{ mat: a }, { mat: earlier }]).over;
  assert.equal(ordered.length, 1);
  assert.equal(ordered[0].mat, earlier, 'queue sorting precedes adjacent batching');
  assert.equal(ordered[0].count, 2);
  assert.equal(prepare([{ mat: { state: {} } }, { mat: { state: {} } }]).over.length, 2, 'custom material records without keys remain separate');
});

test('static UV rotations reuse per-instance arrays through clips and pooled resets', () => {
  const uv = { class: 'FxUVRotation', enabled: true, fields: {
    _rotateTex1: true, _rotateTex2: false, _rotateTex3: true, _rotateTex4: true,
    angle1: 30, _angle2: 45, _angle3: 60, _angle4: 90,
  } };
  const def = compileEffect(desc([root([pe({ _isLoop: 1 }), uv])]));
  const a = new Effect(def, { seed: 1 }), b = new Effect(def, { seed: 2 });
  a.update(1 / 60); b.update(1 / 60);
  const matrices = Array.from({ length: 4 }, (_, k) => a.matOv.get(0)['_Rotation' + k]);
  for (let k = 0; k < 4; k++) {
    assert.deepEqual(matrices[k], def.uvRot[0].rotations[k]);
    assert.notEqual(matrices[k], def.uvRot[0].rotations[k]);
    assert.notEqual(matrices[k], b.matOv.get(0)['_Rotation' + k]);
  }
  matrices[0][0] = 999;
  a.matOv.get(0)._Rotation1 = 12;
  a.update(1 / 60);
  assert.equal(a.matOv.get(0)._Rotation0, matrices[0]);
  assert.deepEqual(a.matOv.get(0)._Rotation0, def.uvRot[0].rotations[0]);
  assert.deepEqual(a.matOv.get(0)._Rotation1, def.uvRot[0].rotations[1]);
  assert.deepEqual(b.matOv.get(0)._Rotation0, def.uvRot[0].rotations[0]);
  a.reset(1); a.update(1 / 60);
  assert.deepEqual(a.matOv.get(0)._Rotation0, def.uvRot[0].rotations[0]);
  assert.equal(a.matOv.get(0)._HG_UV_ROTATION, 1);
});

describe('library', () => {
  test('mesh colours written as bytes are read as 0…1', () => {
    const m = normalizeMesh({ positions: [0, 0, 0], colors: [255, 128, 0, 255] });
    assert.deepEqual(m.colors.map((x) => Math.round(x * 100) / 100), [1, 0.5, 0, 1]);
    assert.deepEqual(normalizeMesh({ positions: [0, 0, 0], colors: [1, 0.5, 0, 1] }).colors, [1, 0.5, 0, 1]);
  });

  test("Unity's built-in quad: (±0.5, ±0.5, 0), UV (0, 0) at (−0.5, −0.5)", () => {
    const q = builtinMesh('Quad');
    assert.deepEqual(q.positions.slice(0, 3), [-0.5, -0.5, 0]);
    assert.deepEqual(q.uv0.slice(0, 2), [0, 0]);
    assert.equal(q.submeshes[0].length, 6);
    for (const k of ['Plane', 'Cube', 'Sphere']) assert.ok(builtinMesh(k).positions.length > 9, k);
  });

  test('the file list names the URLs; without it the Phase 1a fx groups of the local-art manifest serve', async () => {
    const list = { groups: { fx: { index: { path: '/i.json' } }, 'fx/prefabs': { a_key: { path: '/p/a.json' } }, 'fx/tex': {}, 'fx/mesh': {} } };
    const lib = new FxLibrary({ list, fetch: async () => ({ ok: false }) });
    assert.equal(await lib.init(), true);
    assert.ok(lib.has('A_KEY'), 'keys are case-insensitive');
    assert.equal(lib.url('fx/prefabs', 'a_key'), '/p/a.json');
    const none = new FxLibrary({ fetch: async () => ({ ok: true, json: async () => ({ groups: {} }) }), listUrl: '/x.json', assets: { local: async () => ({ groups: list.groups }) } });
    assert.equal(await none.init(), true);
    const empty = new FxLibrary({ fetch: async () => ({ ok: false, status: 404 }), listUrl: '/x.json' });
    assert.equal(await empty.init(), false);
    assert.equal(listHasEffects({ groups: {} }), false);
  });
});

test('官方特效: auto is 完整 on a desktop and 精简 on touch; nothing without effects', () => {
  assert.equal(resolveOfficialFx('auto', true, false), 'full');
  assert.equal(resolveOfficialFx('auto', true, true), 'lite');
  assert.equal(resolveOfficialFx('lite', true, false), 'lite');
  assert.equal(resolveOfficialFx('low', true, false), 'low');
  assert.equal(resolveOfficialFx('low', false, true), 'off');
  assert.equal(resolveOfficialFx('off', true, false), 'off');
  assert.equal(resolveOfficialFx('full', false, false), 'off');
});

describe('official FX quality profiles', () => {
  function fixture(tier, burst = 40) {
    const n = psNode(1, 0, { life: 10 });
    n.particleSystem.EmissionModule.m_Bursts[0].countCurve = burst;
    const def = compileEffect(desc([root([pe({})]), n]));
    const lib = { available: true, has: key => key === 'test', def: () => def };
    const ofx = new OfficialFx({ P: { Container: class {} }, cam: () => null, lib, tier });
    return { ofx, def };
  }

  test('high and legacy medium retain their profiles; low reduces actual emitted particles', () => {
    for (const [tier, scale, count, lite] of [['full', 1, 40, false], ['lite', 0.5, 20, true], ['low', 0.25, 10, true]]) {
      const { ofx } = fixture(tier);
      const h = ofx.spawn('test', {}, { seed: 7 });
      ofx.update(1 / 60);
      assert.equal(h.effect.sys[1].emissionScale, scale, tier);
      assert.equal(h.effect.sys[1].count, count, tier);
      assert.equal(ofx.lite, lite);
      assert.equal(h.effect.def.material(0, ofx.lite).defs.lite, lite);
      assert.equal(ofx.stats().particles, count);
    }
    const { ofx } = fixture('low', 1);
    const h = ofx.spawn('test'); ofx.update(1 / 60);
    assert.equal(h.effect.sys[1].count, 1, 'a one-particle cue survives low quality');
  });

  test('pooling reuses each profile and switching low / medium / high discards old emission parameters', () => {
    const { ofx } = fixture('full');
    let previous = null;
    for (const tier of ['full', 'lite', 'low', 'lite', 'off', 'full']) {
      ofx.setTier(tier);
      assert.equal(ofx.pool.size, 0, `pool cleared on switching to ${tier}`);
      if (tier === 'off') { assert.equal(ofx.spawn('test'), null); continue; }
      const h = ofx.spawn('test');
      assert.notEqual(h.effect, previous);
      const count = tier === 'full' ? 40 : tier === 'lite' ? 20 : 10;
      ofx.update(1 / 60); assert.equal(h.effect.sys[1].count, count);
      const initial = h.effect;
      h.kill(); ofx.update(0);
      assert.equal(ofx.pool.get(initial.def).length, 1);
      ofx.setTier(tier);
      const reused = ofx.spawn('test');
      assert.equal(reused.effect, initial, 'selecting the same tier keeps its pool');
      ofx.update(1 / 60); assert.equal(reused.effect.sys[1].count, count);
      previous = reused.effect;
    }
  });

  test('each tier uses its soft admission budgets while important effects can still start', () => {
    for (const tier of ['low', 'lite', 'full']) {
      const { ofx } = fixture(tier);
      for (let i = 0; i < MAX_EFFECTS[tier]; i++) assert.ok(ofx.spawn('test'));
      assert.equal(ofx.spawn('test'), null, `${tier}: effect admission budget`);
      assert.ok(ofx.spawn('test', {}, { important: true }));
      ofx.clear(); ofx.particles = MAX_PARTICLES[tier];
      assert.equal(ofx.spawn('test'), null, `${tier}: particle admission budget`);
      assert.ok(ofx.spawn('test', {}, { loop: true }), 'persistent cues retain the existing exemption');
    }
  });
});

describe('wiring', () => {
  const index = {
    units: {
      char_x: { kind: 'char', skin: 'char_x', modes: [
        { name: 'Default', attack: { class: 'MeleeAttack', cast: [{ effects: ['x_start'], oneshot: 1, directionType: 0 }], hit: [{ effects: ['x_hit'], directionType: 0 }] } },
        { name: 'S2', attack: { class: 'RangedAttack', projectileKey: 'proj_x', cast: [] } },
      ], deadEffect: null, startEffect: null },
      enemy_y: { kind: 'enemy', modes: [{ name: 'Default', attack: { class: 'MeleeAttack', cast: [], hit: [] } }] },
      char_c: { kind: 'char', modes: [{ name: 'Default', attack: { class: 'RangedAttack', cast: [
        { effects: ['c_start'], oneshot: 0, startEvent: 2, endEvent: 3, directionType: 0 },
        { effects: ['c_spell'], oneshot: 1, startEvent: 4, endEvent: 3, directionType: 0 },
        { effects: [], oneshot: 1, startEvent: 4, endEvent: 3, directionType: 0, hookEffectAfterFirstAttack: 'c_hook' },
      ], inputTarget: [{ effects: ['c_target'], oneshot: 1, startEvent: 4, endEvent: 3, directionType: 0, useInputPos: 1 }], hit: [] } }] },
    },
    projectiles: { proj_x: { main: 'x_trail', onHit: ['x_phit'], effects: ['x_trail', 'x_phit'], movement: { class: 'AdvancedMovement' } } },
    skins: { char_x: { points: { HitPoint: { all: { pos: [0, 0.2, -0.25] } }, Muzzle: { all: { pos: [0.3, 0.3, -0.3] } } } } },
    generic: { hit: { phys: 'g_hit', arts: 'g_arts', enemy: 'g_enemy', heal: 'g_heal' }, die: { char: 'g_die_c', enemy: 'g_die_e' }, birth: { char: 'g_birth' }, status: { stun: 'g_stun' } },
  };
  function fakeOfx() {
    const spawned = [];
    const handles = [];
    const ofx = {
      active: true, time: 0, lite: false,
      lib: { has: () => true, def: () => null, index: async () => index, preload: async (keys) => keys.length },
      spawn(key, place, opts) {
        const h = { key, place, opts, stopped: false, alive: true, stop() { this.stopped = true; this.alive = false; } };
        spawned.push(key); handles.push(h);
        return h;
      },
    };
    return { ofx, spawned, handles };
  }
  const view = (id, key, x, enemy = false) => ({ id, x, y: 10, z: 0, visFacing: enemy ? -1 : 1, isEnemy: enemy, alive: true, flags: 0, info: { id, spine: key, defId: key, side: enemy ? 'enemy' : 'ally', kind: enemy ? 'enemy' : 'op', skillIndex: 1 } });

  test('a melee attack casts at the attacker and plays its hits when the damage lands', async () => {
    const { ofx, spawned } = fakeOfx();
    const w = new FxWiring(ofx, { speed: () => 10 });
    await w.ready();
    const a = view(1, 'char_x', 5), t = view(2, 'enemy_y', 6, true);
    assert.equal(w.attack(a, t, 'none', 0), true);
    assert.deepEqual(spawned, ['x_start']);
    assert.equal(w.damage(t, 'phys', a, 0.1), true);
    assert.deepEqual(spawned, ['x_start', 'x_hit']);
    assert.equal(w.damage(t, 'phys', a, 0.2), false, 'one blow, one hit');
  });

  test('the skill mode flies its projectile; an enemy melee without hits plays the generic enemy hit', async () => {
    const { ofx, spawned } = fakeOfx();
    const w = new FxWiring(ofx, { speed: () => 10 });
    await w.ready();
    const a = view(1, 'char_x', 5), t = view(2, 'enemy_y', 7, true);
    a.flags = 16; // skill on (UF.SKILL), skillIndex 1 → mode S2
    assert.equal(w.attack(a, t, 'arrow', 0), true);
    assert.deepEqual(spawned, ['x_trail']);
    const b = view(3, 'char_x', 8);
    w.attack(t, b, 'none', 0);
    w.damage(b, 'phys', t, 0.05);
    assert.equal(spawned.at(-1), 'g_enemy');
  });

  test('status loops start and stop; a death stops them and plays the generic death', async () => {
    const { ofx, spawned, handles } = fakeOfx();
    const w = new FxWiring(ofx, { speed: () => 10 });
    await w.ready();
    const u = view(4, 'char_x', 5);
    assert.equal(w.status(u, 'stun', true), true);
    assert.equal(w.status(u, 'stun', true), true, 'an active loop is kept');
    assert.equal(spawned.filter((k) => k === 'g_stun').length, 1);
    assert.equal(w.status(u, 'unknown', true), false);
    w.status(u, 'stun', false);
    assert.ok(handles[0].stopped);
    w.status(u, 'stun', true);
    assert.equal(w.death(u), true);
    assert.ok(handles.at(-1).stopped || handles.find((h) => h.key === 'g_stun' && h !== handles[0]).stopped);
    assert.equal(spawned.at(-1), 'g_die_c');
    assert.equal(w.deploy(u), true);
    assert.equal(spawned.at(-1), 'g_birth');
    assert.equal(w.deploy(view(5, 'enemy_y', 3, true)), false, 'enemies have no deploy effect');
  });

  test('emitter rows: NONE plays its first slot, a directional row its slot for the facing; hooks and onlyOnce count attacks', async () => {
    const { ofx } = fakeOfx();
    const w = new FxWiring(ofx, {});
    await w.ready();
    const right = { ...view(1, 'char_x', 5), dir: 'RIGHT' }, left = { ...view(2, 'char_x', 5), dir: 'LEFT', visFacing: -1 }, up = { ...view(3, 'char_x', 5), dir: 'UP' };
    assert.deepEqual(w._rowKeys({ directionType: 0, effects: ['a', 'leftover'] }, right, 0), ['a']);
    const lr = { directionType: 1, effects: ['r', 'l'], slots: [null, 'r', null, 'l'] };
    assert.deepEqual(w._rowKeys(lr, right, 0), ['r']);
    assert.deepEqual(w._rowKeys(lr, left, 0), ['l']);
    const four = { directionType: 3, effects: ['u', 's'], slots: ['u', 's', null, 's'] };
    assert.deepEqual(w._rowKeys(four, up, 0), ['u']);
    assert.deepEqual(w._rowKeys(four, { ...right, dir: 'DOWN' }, 0), [], 'a null slot plays nothing');
    const ud = { directionType: 2, effects: ['b'], slots: ['b'] };
    assert.deepEqual(w._rowKeys(ud, up, 0), ['b'], 'U_OR_D: the up (back) view');
    assert.deepEqual(w._rowKeys(ud, right, 0), [], 'U_OR_D: the front view has no slot here');
    assert.deepEqual(w._rowKeys({ directionType: 3, effects: ['first'] }, right, 0), ['first'], 'no slots: the first key');
    const hook = { directionType: 0, effects: [], hookEffectAfterFirstAttack: 'h' };
    assert.deepEqual(w._rowKeys(hook, right, 0), []);
    assert.deepEqual(w._rowKeys(hook, right, 1), ['h']);
    assert.deepEqual(w._rowKeys({ directionType: 0, effects: ['o'], onlyOnce: 1 }, right, 0), ['o']);
    assert.deepEqual(w._rowKeys({ directionType: 0, effects: ['o'], onlyOnce: 1 }, right, 2), []);
  });

  test('cast rows by ability event: ON_CAST_START with the wind-up, ON_SPELL_ON (and the target rows) at the strike', async () => {
    const { ofx, spawned, handles } = fakeOfx();
    const w = new FxWiring(ofx, {});
    await w.ready();
    const a = view(1, 'char_c', 5), t = view(2, 'enemy_y', 8, true);
    assert.equal(w.castStart(a, t, 'arrow', { skip: 0.1, left: 0.5 }), true);
    assert.deepEqual(spawned, ['c_start']);
    assert.equal(handles[0].opts.skip, 0.1, 'started as far in as the clip');
    w.attack(a, t, 'arrow', 0.2, true);
    assert.deepEqual(spawned, ['c_start', 'c_spell', 'c_target'], 'the wound-up start row is not played twice');
    assert.equal(handles[2].place.pos[0], t.x - 10, 'an inputTarget row plays on the target');
    ofx.time = 0.6; w.tick();
    assert.ok(handles[0].stopped, 'the looping cast stops when the attack clip ends');
    // the second attack, nobody wound up: every row at the strike, and the hook row joins in
    w.attack(a, t, 'arrow', 1, false);
    assert.deepEqual(spawned.slice(3), ['c_start', 'c_spell', 'c_hook', 'c_target']);
    assert.equal(w.castStart(a, t, 'chain', {}), false, 'a chain bounce is no attack of its own');
  });

  test('a looping prefab on a one-shot cast row stops at the cast end too (it would never end)', async () => {
    const { ofx, handles } = fakeOfx();
    ofx.lib.def = (k) => (k === 'x_start' ? { isLoop: true } : null);
    const w = new FxWiring(ofx, {});
    await w.ready();
    w.attack(view(1, 'char_x', 5), view(2, 'enemy_y', 6, true), 'none', 0);
    assert.equal(handles[0].key, 'x_start');
    ofx.time = 0.7; w.tick();
    assert.ok(handles[0].stopped);
  });

  test('PauseEffectIf: each check is a CheckType (1 pause while it holds, 2 while not); conditions no view shows never pause', async () => {
    const { ofx } = fakeOfx();
    const w = new FxWiring(ofx, {});
    const pauseOf = (fields) => compileEffect(desc([root([pe({}), { class: 'PauseEffectIf', enabled: true, fields }])])).pause;
    const u = { ...view(1, 'char_x', 5) };
    const pose = (v) => w.pose(v);
    // buff_stun: immune to STUNNED (check 1, not visible) or not stunned (not-in check 1, value 0)
    const stun = pauseOf({ _checkAbnormalImmune: 1, _pauseWhenAbnormalImmune: 0, _checkNotInAbnormalFlag: 1, _pauseWhenNotInAbnormalFlag: 0, _checkAbnormalFlag: 0, _pauseWhenAbnormalFlag: 16, _requireAllConditions: 0 });
    assert.equal(w._paused(stun, u, pose(u)), true, 'not stunned: paused');
    u.flags = 2; // UF.STUNNED
    assert.equal(w._paused(stun, u, pose(u)), false, 'stunned: shown');
    // buff_cold: paused while FROZEN (flag check 1, value 16)
    const cold = pauseOf({ _checkAbnormalFlag: 1, _pauseWhenAbnormalFlag: 16, _checkNotInAbnormalFlag: 0, _pauseWhenNotInAbnormalFlag: 41 });
    u.flags = 128; // COLD
    assert.equal(w._paused(cold, u, pose(u)), false);
    u.flags = 128 | 4; // + FROZEN
    assert.equal(w._paused(cold, u, pose(u)), true);
    // buff_sleep: paused while not SLEEPING (combo check 2, value 0)
    const sleep = pauseOf({ _checkAbnormalCombo: 2, _pauseWhenAbnormalCombo: 0 });
    u.flags = 0;
    assert.equal(w._paused(sleep, u, pose(u)), true);
    u.flags = 256; // UF.SLEEP
    assert.equal(w._paused(sleep, u, pose(u)), false);
    // facing: CHECK_NO on the right side pauses a unit facing left; an invisible condition fails "require all"
    const face = pauseOf({ _checkFaceToRight: 2 });
    assert.equal(w._paused(face, { ...u, visFacing: -1 }, pose({ ...u, visFacing: -1 })), true);
    assert.equal(w._paused(face, u, pose(u)), false);
    const both = pauseOf({ _checkFaceToRight: 1, _checkContainBuff: 1, _requireAllConditions: 1 });
    assert.equal(w._paused(both, u, pose(u)), false);
    assert.equal(pauseOf({ _checkAbnormalFlag: 0, _pauseWhenAbnormalFlag: 16 }), null, 'no check, no pause');
  });

  test('keysFor lists the battle units’ attack, projectile and generic keys', async () => {
    const { ofx } = fakeOfx();
    const w = new FxWiring(ofx, {});
    await w.ready();
    const keys = w.keysFor([view(1, 'char_x', 5)]);
    for (const k of ['x_start', 'x_hit', 'x_trail', 'x_phit', 'g_hit', 'g_stun', 'g_birth']) assert.ok(keys.includes(k), k);
  });
});

test('a −30° Graphic tilt and the +30° effect tilt cancel (the pre-tilted content of §33.2)', () => {
  const v = quatRotate([0.258819, 0, 0, 0.965926], quatRotate([-0.258819, 0, 0, 0.965926], [0, 1, 0]));
  assert.ok(Math.abs(v[1] - 1) < 1e-5);
});

describe('shared static local matrices', () => {
  const node = (id, parent, more = {}) => ({ ...root(), id, parent, ...more });

  test('all Transform clip targets and direction helpers remain dynamic, including unused clips', () => {
    const nodes = [root([pe({ _rotationY: { node: 1 }, _rotationZ: { node: 2 } })]),
      ...Array.from({ length: 7 }, (_, i) => node(i + 1, 0)), node(8, null)];
    const def = compileEffect(desc(nodes, { clips: [{ curves: [
      ...['localPosition.x', 'localRotation.w', 'localEulerAnglesBaked.z', 'localScale.y'].map((property, i) =>
        ({ node: i + 3, type: 'Transform', property, keys: [[0, 1, 0, 0]] })),
      { node: 7, type: 'MeshRenderer', property: 'material._Color.r', keys: [[0, 1, 0, 0]] },
      { node: 7, type: 'Transform', property: 'localPosition.x', keys: [] },
    ] }] }));
    assert.equal(def.animators.length, 0);
    for (const i of [0, 1, 2, 3, 4, 5, 6, 8]) assert.equal(def.localMatrices[i], null, `dynamic / root ${i}`);
    assert.ok(def.localMatrices[7], 'material-only animation does not change local TRS');
    const a = new Effect(def), b = new Effect(def), saved = new Float32Array(def.localMatrices[7]);
    assert.notEqual(a.localMatrices, b.localMatrices);
    assert.equal(a.localMatrices[7], b.localMatrices[7], 'instances share the immutable local matrix');
    a.place({ pos: [3, -2, 4], scale: 2, yaw: 1, mirror: true, flipY: true }).update(0);
    assert.deepEqual(def.localMatrices[7], saved, 'placement and mirror never write into the shared local');
  });

  test('animated parents, root rotations and reflections produce the uncached world matrices bit for bit', () => {
    for (const helpers of [false, true]) for (const projectile of [false, true]) for (const lite of [false, true]) {
      const fields = { _isLoop: 1, _rotationY: helpers ? { node: 1 } : null, _rotationZ: helpers ? { node: 2 } : null };
      const nodes = [root([pe(fields), ...(projectile ? [{ class: 'ProjectileEffect', fields: { _rotate180Y: 1 } }] : [])]),
        node(1, 0, { rot: quatEuler(20, -35, 15), scale: [-1, 0.7, 2] }),
        node(2, 1, { pos: [0.21, -0.5, 1], rot: quatEuler(-15, 25, 30) }),
        node(3, 2, { pos: [-0, 1.2, -0.3], scale: [0.9, 1.7, 0] }),
        node(4, 3, { pos: [0.75, -0.3, 2], rot: quatEuler(45, 10, -60), scale: [-1.2, 0.6, 1.5] }),
        node(5, 4, { pos: [-0.4, 1.1, 0.8], scale: [0.5, -2, 0.25] })];
      nodes[0].animator = { enabled: true, default: 0 };
      const def = compileEffect(desc(nodes, { clips: [{ length: 1, loop: true, curves: [
        { node: 2, type: 'Transform', property: 'localPosition.y', keys: [[0, -1, 0, 0], [1, 2, 0, 0]] },
        { node: 2, type: 'Transform', property: 'localEulerAnglesRaw.z', keys: [[0, 20, 0, 0], [1, 80, 0, 0]] },
        { node: 2, type: 'Transform', property: 'localScale.x', keys: [[0, -1, 0, 0], [1, 1, 0, 0]] },
      ] }] }));
      const cached = new Effect(def, { seed: 123, lite }), plain = new Effect(def, { seed: 123, lite });
      plain.localMatrices.fill(null);
      for (let step = 0; step < 45; step++) {
        const place = { pos: [step * 0.1 - 2, -1.25, 0.42], scale: 0.25 + (step % 7) / 3,
          yaw: step * 0.2, pitch: step * -0.03, roll: step * 0.01, mirror: step % 2 === 0, flipY: step % 3 === 0,
          rootRot: step % 4 === 0 ? quatEuler(30, -20, 10) : null,
          mountRot: step % 5 === 0 ? quatEuler(-10, 25, 35) : null };
        cached.place(place).update(1 / 30); plain.place(place).update(1 / 30);
        for (let i = 0; i < def.n; i++) assert.deepEqual(new Uint32Array(cached.world[i].buffer),
          new Uint32Array(plain.world[i].buffer), `helpers=${helpers} projectile=${projectile} lite=${lite} step=${step} node=${i}`);
      }
    }
  });

  test('a transform sink write invalidates only its instance, and pooling restores the compiled locals', () => {
    const def = compileEffect(desc([root([pe({ _isLoop: 1 })]), node(1, 0, { pos: [1, 2, 3] }), node(2, 1, { pos: [4, 0, 0] })]));
    const changed = new Effect(def), other = new Effect(def);
    changed.update(0); other.update(0);
    const original = other.world.map(matrix => new Float32Array(matrix));
    changed._sink().transform(1, [8, NaN, NaN], null, [2, NaN, NaN], null);
    changed.update(0);
    assert.equal(changed.localMatrices[1], null);
    assert.equal(changed.localMatrices[2], def.localMatrices[2]);
    assert.equal(changed.world[1][12], 8); assert.equal(changed.world[2][12], 16);
    other.update(0);
    assert.deepEqual(other.world, original, 'another instance keeps the authored local transform');
    changed.reset(123).update(0);
    assert.equal(changed.localMatrices[1], def.localMatrices[1]);
    assert.deepEqual(changed.world, original, 'a pooled instance does not retain the prior transform write');
  });
});
