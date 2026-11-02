// test/render/vfx-skinfx.test.js — 官方时装特效 (docs/SKINS.md): the runtime half.
//
// An outfit may replace its operator's effects. The client keeps those pairs in a per-outfit `CharacterSkinHooker`
// (`tools/local-extract/skinfx.py` reads them into index.json's `skinFx`), and this file pins how the runtime applies
// them (render/vfx/wiring.js):
//   * the replacement is looked up by the OUTFiT the view wears (`info.skin`) — not by `skinOf`, which is the Spine
//     model's own skin name used for the mount points;
//   * a replacement the set does not hold falls back to the base key: a skin whose variant was not extracted plays what
//     it always did, never nothing;
//   * an effect an attack puts on SOMEBODY ELSE (a projectile's hit rows) resolves with the ATTACKER's outfit — the
//     hooker belongs to the attacker, not to the target;
//   * preloading (keysFor) includes the variants of the outfits in the battle, so the first cast does not wait on a
//     fetch.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { FxWiring } from '../../public/js/render/vfx/wiring.js';

const OUTFIT = 'char_x@skin#1';

/** A wiring over a synthetic index whose library holds `keys`; every spawn is recorded by its key. */
function setup({ keys = [], skinFx = null, units = { char_x: { modes: [] } } } = {}) {
  const index = { prefabs: Object.fromEntries(keys.map((k) => [k, {}])), units, skinFx };
  const spawned = [];
  const ofx = {
    active: true, time: 0, lite: false, tier: 'full', timers: [], ctx: {},
    lib: {
      has: (k) => !!index.prefabs[k],
      def: (k) => (index.prefabs[k] ? { isLoop: false, spawn: 2 } : null),
      index: async () => index, preload: async (ks) => ks.length, defs: new Map(),
    },
    spawn(key, place, opts) {
      const h = { key, place, opts, alive: true, stop() { this.alive = false; }, kill() { this.alive = false; } };
      spawned.push(h);
      return h;
    },
  };
  const views = new Map();
  const w = new FxWiring(ofx, { speed: () => 10, record: () => null, view: (id) => views.get(id) || null });
  w.idx = index;
  const view = (id, extra = {}) => {
    const v = {
      id, x: 1, y: 2, z: 0, visFacing: 1, isEnemy: false, alive: true, flags: 0, sp: 0, spMax: 10, dir: 'RIGHT',
      info: { id, spine: 'char_x', defId: 'char_x', side: 'ally', kind: 'op', skillIndex: 0, ...extra },
    };
    views.set(id, v);
    return v;
  };
  return { w, index, spawned, view };
}

describe('官方时装特效: the key lookup', () => {
  test('an outfit replaces a key it has a pair for, and only that outfit does', () => {
    const { w } = setup({ keys: ['base_hit', 'base_hit_skin'], skinFx: { [OUTFIT]: { replace: { base_hit: 'base_hit_skin' } } } });
    assert.equal(w.skinFxKey('base_hit', OUTFIT), 'base_hit_skin');
    assert.equal(w.skinFxKey('base_hit', 'char_x@other#2'), 'base_hit', 'another outfit keeps the base effect');
    assert.equal(w.skinFxKey('base_hit', null), 'base_hit', 'no outfit (a tile, a map-position effect): the base key');
    assert.equal(w.skinFxKey('not_replaced', OUTFIT), 'not_replaced', 'a key the outfit does not name is untouched');
  });

  test('a replacement the set does not hold falls back to the base key instead of dropping the effect', () => {
    const { w } = setup({ keys: ['base_hit'], skinFx: { [OUTFIT]: { replace: { base_hit: 'base_hit_skin' } } } });
    assert.equal(w.skinFxKey('base_hit', OUTFIT), 'base_hit', 'the variant was not extracted: play what we have');
  });

  test('an index without skinFx (an older extraction) plays the base effects', () => {
    const { w } = setup({ keys: ['base_hit'] });
    assert.equal(w.skinFxKey('base_hit', OUTFIT), 'base_hit');
  });
});

describe('官方时装特效: playing', () => {
  test('playOn plays the outfit\'s variant on its own view', () => {
    const { w, view, spawned } = setup({
      keys: ['base_hit', 'base_hit_skin'],
      skinFx: { [OUTFIT]: { replace: { base_hit: 'base_hit_skin' } } },
    });
    const v = view(1, { skin: OUTFIT });
    w.playOn('base_hit', v, {});
    assert.deepEqual(spawned.map((h) => h.key), ['base_hit_skin']);
    // the same view in its default appearance plays the base effect
    const plain = view(2, {});
    w.playOn('base_hit', plain, {});
    assert.deepEqual(spawned.map((h) => h.key), ['base_hit_skin', 'base_hit']);
  });

  test('an effect an attack puts on someone else uses the ATTACKER\'s outfit (o.skinFrom)', () => {
    const { w, view, spawned } = setup({
      keys: ['base_hit', 'base_hit_skin'],
      skinFx: { [OUTFIT]: { replace: { base_hit: 'base_hit_skin' } } },
    });
    const src = view(1, { skin: OUTFIT });
    const tgt = view(2, {});                    // the target wears the default appearance
    w.playOn('base_hit', tgt, { skinFrom: src });
    assert.deepEqual(spawned.map((h) => h.key), ['base_hit_skin'], 'the hit variant is the attacker\'s, not the target\'s');
    // without a source the target's own outfit decides (a burning tile, a self-buff)
    w.playOn('base_hit', tgt, {});
    assert.deepEqual(spawned.map((h) => h.key), ['base_hit_skin', 'base_hit']);
  });
});

describe('官方时装特效: preloading', () => {
  test('keysFor includes the variants of the outfits in the battle', () => {
    const { w, view } = setup({
      keys: ['base_hit', 'base_hit_skin', 'base_birth', 'base_birth_skin'],
      skinFx: { [OUTFIT]: { replace: { base_hit: 'base_hit_skin', base_birth: 'base_birth_skin' } } },
    });
    const keys = w.keysFor([view(1, { skin: OUTFIT })], false);
    assert.ok(keys.includes('base_hit_skin') && keys.includes('base_birth_skin'), 'the outfit\'s variants are preloaded');
    // and a view in its default appearance preloads none of them
    const plain = w.keysFor([view(2, {})], false);
    assert.equal(plain.includes('base_hit_skin'), false);
  });
});
