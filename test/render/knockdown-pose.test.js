import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { installFakePixi, fakeViewCtx } from './fakepixi.js';
import { presetCamera } from '../../public/js/render/projection.js';
import { clipPoseVisible, SpineActor } from '../../public/js/render/spine.js';
import { UnitView } from '../../public/js/render/units.js';

let fake;
before(() => { fake = installFakePixi(); });
after(() => fake.restore());
const tick = () => new Promise(resolve => setImmediate(resolve));
const cam = () => presetCamera('normal', { width: 1280, height: 720 });
const region = { type: 0, width: 20, height: 30, scaleX: 1, scaleY: 1, rotation: 0, x: 0, y: 0, color: { a: 1 } };

class Skeleton {
  constructor(data) {
    this.data = data;
    const slot = { bone: { active: true, matrix: { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 } }, color: { a: 1 },
      attachment: region, getAttachment() { return this.attachment; } };
    this.drawOrder = this.slots = [slot];
  }
  setToSetupPose() { this.slots[0].attachment = region; this.slots[0].color.a = 1; }
  updateWorldTransform() {}
}

function model({ visibleDie = false, stun = true } = {}) {
  let reads = 0;
  const animations = ['Idle', 'Die', ...(stun ? ['Stun'] : [])].map(name => ({ name, duration: 1,
    apply(skel, last, time) { reads++; skel.slots[0].attachment = name === 'Die' && time >= 1 && !visibleDie ? null : region; },
  }));
  const data = { animations, findAnimation: name => animations.find(a => a.name === name) };
  const entry = { skel: '/outfit.skel', atlas: '/outfit.atlas', textures: ['/outfit.png'],
    anims: { idle: 'Idle', die: 'Die', ...(stun ? { stun: { loop: 'Stun' } } : {}) }, animations: { Idle: 1, Die: 1, Stun: 1 } };
  return { data, entry, reads: () => reads };
}

function actor(m) {
  const a = new SpineActor(m.data, m.entry);
  a.spine.skeleton = new Skeleton(a.spine.spineData);
  return a;
}

test('clip visibility uses real attachment poses and caches by skeleton/clip without borrowing a sampled pose', () => {
  const m = model();
  assert.equal(clipPoseVisible(m.data, Skeleton, 'Die', true), false);
  const reads = m.reads();
  assert.equal(clipPoseVisible(m.data, Skeleton, 'Die', true), false);
  assert.equal(m.reads(), reads, 'shared skeleton data is measured once');
  assert.equal(clipPoseVisible(m.data, Skeleton, 'Stun'), true);
  assert.equal(clipPoseVisible(m.data, Skeleton, 'missing'), null);
});

test('only a knocked-down invisible Die end selects a frozen own-model Stun/Idle; revival restores normal clips', () => {
  for (const stun of [true, false]) {
    const a = actor(model({ stun }));
    a.die();
    assert.equal(a.current, 'Die', 'ordinary final death keeps its animation');
    assert.equal(a.holdDeathPose(), true);
    assert.equal(a.current, stun ? 'Stun' : 'Idle');
    assert.equal(a.spine.state.tracks[0].timeScale, 0);
    assert.equal(a.holdDeathPose(), false, 'later snapshots do not restart the held pose');
    a.revive();
    assert.equal(a.current, 'Idle');
    assert.equal(a.spine.state.tracks[0].timeScale, 1);
    a.die();
    assert.equal(a.current, 'Die');
    a.destroy();
  }
  const normal = actor(model({ visibleDie: true }));
  normal.die();
  assert.equal(normal.holdDeathPose(), false);
  assert.equal(normal.current, 'Die', 'an existing fallen body keeps the real death clip');
  normal.destroy();
});

test('a transformed body with no own Stun holds its current-form idle instead of reverting to the base body', () => {
  const m = model();
  m.data.animations.push({ ...m.data.findAnimation('Idle'), name: 'Doll_Idle' });
  m.entry.animations.Doll_Idle = 1;
  const a = actor(m);
  a.setForm({ idle: 'Doll_Idle', die: 'Die' });
  a.die();
  assert.equal(a.holdDeathPose(), true);
  assert.equal(a.current, 'Doll_Idle');
  a.destroy();
});

test('UnitView preserves a knocked-down outfit, including a model loaded after the unit was already down', async () => {
  const Base = fake.P.spine.Spine;
  fake.P.spine.Spine = class extends Base {
    constructor(data) { super(data); this.skeleton = new Skeleton(this.spineData); }
  };
  try {
    for (const late of [false, true]) {
      const m = model();
      let resolve;
      const pending = new Promise(r => { resolve = r; });
      const assets = { picture: () => null, image: async () => null, spineEntry: () => m.entry,
        spine: { acquire: () => late ? pending : Promise.resolve(m.data), release() {} } };
      const v = new UnitView(fakeViewCtx(fake.P, { assets, cam }), { id: 7, side: 'ally', kind: 'chess',
        defId: 'char_4134_cetsyr', skin: 'char_4134_cetsyr@epoque#50', x: 5, y: 10, maxHp: 1000, dir: 'RIGHT' });
      if (!late) { await tick(); await tick(); }
      v.setDown([7, 30, 30, 0, 10, 5], 0, late);
      if (late) { resolve(m.data); await tick(); await tick(); }
      assert.equal(v.actor.current, 'Stun', late ? 'late-loaded body' : 'live body');
      v.update(2, cam(), 2);
      assert.ok(v.alpha > 0.8 && !v.remove && v.down);
      assert.equal(v.actor.spine.state.tracks[0].timeScale, 0);
      v.revive();
      assert.equal(v.actor.current, 'Idle');
      assert.equal(v.down, null);
      v.destroy();
    }
  } finally { fake.P.spine.Spine = Base; }
});
