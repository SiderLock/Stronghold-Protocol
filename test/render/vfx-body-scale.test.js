// Original fixtures: body-relative FX and static / live mounts must use the displayed skeleton's tile scale.
import test from 'node:test';
import assert from 'node:assert/strict';
import { compileEffect, Effect } from '../../public/js/render/vfx/effect.js';
import { FxWiring } from '../../public/js/render/vfx/wiring.js';
import { unitPoint } from '../../public/js/render/vfx/mounts.js';

const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-5, `${a} != ${b}`);
const node = (id, parent, more = {}) => ({ id, parent, name: `n${id}`, children: [], active: true,
  pos: [0, 0, 0], rot: [0, 0, 0, 1], scale: [1, 1, 1], ...more });
const desc = (spawn, nodes = []) => ({ key: 'body', root: 0, materials: [], clips: [], nodes: [node(0, null, {
  children: nodes.map((n) => n.id), behaviours: [{ class: 'ParticleEffect', enabled: true,
    fields: { _spawnLocation: spawn, _isLoop: 1 } }],
}), ...nodes] });
const view = (effectScale = 2) => ({ x: 12, y: 10, z: 0.42, effectScale,
  info: { id: 1, spine: 'char_x', skin: 'char_x@test#1' } });

function fixture() {
  const defs = new Map([['body', compileEffect(desc(4))], ['ground', compileEffect(desc(5))]]);
  const spawned = [];
  const ofx = { lib: { has: (k) => defs.has(k), def: (k) => defs.get(k) },
    spawn(key, place, opts) { const fx = new Effect(defs.get(key)).place(place); spawned.push({ key, fx, opts }); return fx; } };
  const wiring = new FxWiring(ofx);
  wiring.idx = { units: { char_x: { skin: 'char_x' } }, skins: { char_x: {
    points: { HeadPoint: { all: { pos: [0, 0.5, -0.25] } } },
  } } };
  return { wiring, defs, spawned };
}

test('static head / muzzle positions follow model scale; live bones already carry it', () => {
  const { wiring } = fixture(), v = view();
  const p = wiring.pose(v), skin = wiring.skinOf(wiring.unitOf(v));
  const head = unitPoint(skin, 'head', p);
  near(head[1], v.y - 9 + 1); near(head[2], -v.z - 0.5);
  skin.points.HeadPoint.all.bone = 'head';
  v.boneOffset = () => ({ x: 0.4, up: 0.6, angle: 0, flip: 1 });
  const live = unitPoint(skin, 'head', wiring.pose(v));
  near(live[0], v.x - 10 + 0.4);
  near(live[1], v.y - 9 + 0.6 * Math.cos(Math.PI / 6));
});

test('body effects scale about the placed mount; ground effects keep their tile size and height', () => {
  const { wiring, spawned } = fixture(), v = view();
  wiring.playOn('body', v);
  wiring.playOn('ground', v);
  assert.equal(spawned[0].fx.scale, 2); assert.equal(spawned[1].fx.scale, 1);
  near(spawned[0].fx.anchor[1], v.y - 9 + 1);
  near(spawned[1].fx.anchor[2], -v.z);
  const tile = { x: 12, y: 10, z: 0.42, effectScale: 10 };
  wiring.playOn('body', tile);
  assert.equal(spawned[2].fx.scale, 1, 'a map point is not a displayed model');
});

test('a FollowMountPoint on GROUND stays in tile units even if the prefab spawn is HEAD', () => {
  const { wiring, defs, spawned } = fixture();
  defs.get('body').follow = { mount: 7, keepRot: true };
  wiring.playOn('body', view());
  assert.equal(spawned[0].fx.scale, 1);
});

test('a late-loaded descriptor selects its own ground placement, without keeping the temporary body scale', () => {
  const { wiring, defs, spawned } = fixture(), v = view();
  const def = defs.get('ground'); defs.set('ground', null);
  wiring.idx.prefabs = { ground: { spawn: 4 } };
  wiring.ofx.lib.has = () => true;
  wiring.ofx.spawn = (key, place, opts) => { spawned.push({ key, place, opts }); return {}; };
  wiring.playOn('ground', v);
  assert.equal(spawned[0].place.scale, 2);
  defs.set('ground', def);
  const fx = { anchor: [0, 0, 0], def, scale: 2 };
  spawned[0].opts.track(fx);
  assert.equal(fx.scale, 1);
});

test('a finishing body effect does not enlarge a ground child, and a ground parent does not shrink a body child', () => {
  for (const [parent, child, scale] of [['body', 'ground', 1], ['ground', 'body', 2]]) {
    const { wiring, defs, spawned } = fixture();
    defs.get(parent).onFinish = [child];
    wiring.playOn(parent, view());
    const fx = new Effect(defs.get(child));
    spawned[0].opts.track(fx);
    assert.equal(fx.scale, scale);
  }
});

for (const mode of [0, 1, 2]) test(`whole-effect conversion includes particle scalingMode ${mode}, without changing authored scales`, () => {
  const child = node(1, 0, { pos: [1, 0, 0], scale: [3, 3, 3],
    particleSystem: { lengthInSec: 1, looping: true, playOnAwake: true, scalingMode: mode,
      InitialModule: { startLifetime: 1, startSpeed: 0, startSize: 1, maxNumParticles: 4 } } });
  const fx = new Effect(compileEffect(desc(1, [child])), { seed: 1 });
  fx.place({ pos: [5, 4, -0.42], scale: 2 }); fx.update(0);
  near(fx.world[1][12], 7); near(fx.world[1][0], 6);
  const frame = fx._frame(1);
  near(frame.m[0], mode === 2 ? 2 : 6);
  near(fx.loc[17], 3);
  fx.loc[0] = 0.25; fx._matrices();
  near(fx.world[0][12], 5.5, 'an animated root offset uses the same conversion');
  fx.reset(2); fx.update(0);
  assert.equal(fx.scale, 1, 'a pooled effect must not retain its previous owner scale');
  near(fx.world[1][0], 3);
});

for (const mode of [0, 1, 2]) for (const space of [0, 1]) test(`particle positions and sizes convert once: mode ${mode}, space ${space}`, () => {
  const make = (scale) => {
    const child = node(1, 0, { pos: [1, 0, 0], scale: [3, 3, 3], particleSystem: {
      lengthInSec: 1, looping: true, playOnAwake: true, scalingMode: mode, moveWithTransform: space,
      InitialModule: { startLifetime: 2, startSpeed: 1, startSize: 1, maxNumParticles: 4 },
      ShapeModule: { enabled: true, type: 0, radius: 0.5 },
      EmissionModule: { m_Bursts: [{ time: 0, countCurve: 1, cycleCount: 1, repeatInterval: 0.01, probability: 1 }] },
    } });
    const fx = new Effect(compileEffect(desc(1, [child])), { seed: 1 });
    fx.place({ pos: [5, 4, -0.42], scale }); fx.update(0.01); return fx;
  };
  const base = make(1), scaled = make(2);
  for (const dt of [0, 0.25]) {
    if (dt) { base.update(dt); scaled.update(dt); }
    const a = base.sys[1], b = scaled.sys[1];
    assert.equal(a.count, 1); assert.equal(b.count, 1);
    const p = a.worldPos(0, [0, 0, 0]), q = b.worldPos(0, [0, 0, 0]);
    for (let k = 0; k < 3; k++) near(q[k] - scaled.anchor[k], (p[k] - base.anchor[k]) * 2);
    near(b.sx[0] * b.sizeScale(0), a.sx[0] * a.sizeScale(0) * 2);
    near(b._inheritOf(0, 2).size, a._inheritOf(0, 2).size);
  }
});
