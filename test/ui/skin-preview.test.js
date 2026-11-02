// test/ui/skin-preview.test.js — P4 小人预览的纯逻辑 (docs/SKINS.md 小人预览): the model a 皮肤 row previews
// (`previewEntry`) and the buttons its clip set offers (`clipsOf`), from `public/js/ui/skinPreview.js`.
//
// The module is hook-free at these two functions (the live PIXI frame is `SkinModelPreview`, covered by the browser
// suite only), so the whole contract can be pinned here against a plain composed manifest: no data store, no canvas.
//
// What each case exists to keep true, because each is silent when it breaks:
//   * the row previews the SKIN's own Front when it has one, and the OPERATOR's own when the skin is picture-only —
//     a wrong pick shows a model the outfit will never wear (or nothing, for the picture-only case that must fall back);
//   * 待机 has a fallback to a clip literally named `Idle` for a skeleton whose manifest entry has no `anims` roles: the
//     first button of the frame must not disappear (this case currently FAILS: see the note and the report);
//   * only 部署 plays once; every other button loops, and every clip the skeleton ships is reachable — either through a
//     primary role or its own `raw:<clip>` button, never twice, in the manifest's own key order.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { previewEntry, clipsOf } from '../../public/js/ui/skinPreview.js';

const OPERATOR = 'char_498_inside';
const OTHER = 'char_003_kalts';
const SKIN = 'char_498_inside@kitchen#2';
const SKIN_PICTURE_ONLY = 'char_498_inside@art#9';
const SKIN_BACK_ONLY = 'char_498_inside@back#3';
const SKIN_BROKEN = 'char_498_inside@broken#4';

/** A Spine entry as the composed manifest carries it (docs/ASSETS.md): the Front model with its roles and clip list. */
const model = (stem, anims, animations) => ({
  skel: `/s/${stem}/front.skel`, atlas: `/s/${stem}/front.atlas`, textures: [`/s/${stem}/front.png`], anims, animations,
});

/** The operator's own model: the fallback every case here compares against. */
const OWN = model('inside', { idle: 'Idle', deploy: 'Start', attack: { loop: 'Attack' } }, { Idle: 1, Start: 1, Attack: 1 });

const MANIFEST = {
  chars: {
    [OPERATOR]: {
      avatar: '/a/inside.png', portrait: '/p/inside_1.png',
      spine: { front: OWN },
      skins: {
        // a real battle model of its own
        [SKIN]: { name: '厨房', spine: { front: model('kitchen', { idle: 'Idle', deploy: 'Start', attack: { loop: 'Attack' } }, { Idle: 1, Start: 1, Attack: 1 }) } },
        // a picture-only outfit (B6): wearable, battle uses the operator's model
        [SKIN_PICTURE_ONLY]: { name: '只有画', avatar: '/a/art.png', portrait: '/p/art.png' },
        // a skin whose spine has only a Back: `previewEntry` asks for `front` (the row previews the Front model)
        [SKIN_BACK_ONLY]: { name: '只有背', spine: { back: model('back', { idle: 'Idle' }, { Idle: 1 }) } },
        // a model record without its skeleton: present, so it is not silently replaced by the operator's
        [SKIN_BROKEN]: { name: '坏模型', spine: { front: { atlas: '/s/broken/front.atlas' } } },
      },
    },
    // an operator the plugin gave no model at all
    [OTHER]: { avatar: '/a/kalts.png' },
  },
};

describe('小人预览: the model a row previews (previewEntry)', () => {
  test('a skin with a model previews ITS Front, not the operator\'s', () => {
    const entry = previewEntry(MANIFEST, OPERATOR, SKIN);
    assert.equal(entry.skel, '/s/kitchen/front.skel');
    assert.notEqual(entry.skel, OWN.skel);
  });

  test('a picture-only skin falls back to the operator\'s own model', () => {
    assert.equal(previewEntry(MANIFEST, OPERATOR, SKIN_PICTURE_ONLY).skel, '/s/inside/front.skel');
  });

  test('a skin whose spine is Back-only also falls back: the row previews Front', () => {
    assert.equal(previewEntry(MANIFEST, OPERATOR, SKIN_BACK_ONLY).skel, '/s/inside/front.skel');
  });

  test('the 默认 row (no skinId) previews the operator\'s own model', () => {
    assert.equal(previewEntry(MANIFEST, OPERATOR, null).skel, '/s/inside/front.skel');
    assert.equal(previewEntry(MANIFEST, OPERATOR, '').skel, '/s/inside/front.skel');
  });

  test('an operator the manifest does not hold, or one with no model, previews nothing (the static art stays)', () => {
    assert.equal(previewEntry(MANIFEST, OTHER, null), null);
    assert.equal(previewEntry(MANIFEST, 'char_999_absent', SKIN), null);
    assert.equal(previewEntry(null, OPERATOR, SKIN), null);
    assert.equal(previewEntry({}, OPERATOR, SKIN), null);
  });

  test('an unusable Front is not replaced by the operator\'s model (the picker never offers such a skin: skinHasModel)', () => {
    // observed boundary of the implementation: a skin.spine.front object OUT of its skel returns null instead of
    // falling through to chars[charId].spine — the fallback above is for a skin that ships NO model.
    assert.equal(previewEntry(MANIFEST, OPERATOR, SKIN_BROKEN), null);
  });
});

describe('小人预览: the clip buttons (clipsOf)', () => {
  /** A complete entry: deploy / idle / a three-part attack / a looping skill, plus four clips no role uses. */
  const FULL = model('full', {
    deploy: 'Start', idle: 'Idle',
    attack: { loop: 'Attack_Loop', begin: 'Attack_Begin', end: 'Attack_End' },
    attackDown: 'Attack_Down',
    skill: { loop: 'Skill_Loop' },
  }, {
    Start: 1, Idle: 1, Attack_Begin: 1, Attack_Loop: 1, Attack_End: 1, Attack_Down: 1, Skill_Loop: 1,
    Default: 1, Skill_2_B: 1, Skill_Down_2: 1, Attack_Idle: 1,
  });

  test('a complete role set gives four primary buttons in order, each on its first clip', () => {
    const { primary } = clipsOf(FULL);
    assert.deepEqual(primary.map((b) => b.key), ['deploy', 'idle', 'attack', 'skill']);
    assert.deepEqual(primary.map((b) => b.label), ['部署', '待机', '攻击', '技能']);
    assert.equal(primary.find((b) => b.key === 'deploy').clip, 'Start');
    assert.equal(primary.find((b) => b.key === 'idle').clip, 'Idle');
    // the attack button plays its LOOP first, and carries begin → end after it (names = every clip it uses)
    assert.equal(primary.find((b) => b.key === 'attack').clip, 'Attack_Loop');
    assert.deepEqual(primary.find((b) => b.key === 'attack').names,
      ['Attack_Loop', 'Attack_Begin', 'Attack_End', 'Attack_Down']);
    assert.equal(primary.find((b) => b.key === 'skill').clip, 'Skill_Loop');
  });

  test('only 部署 is one-shot; every other button loops', () => {
    const { primary } = clipsOf(FULL);
    assert.deepEqual(primary.filter((b) => b.loop === false).map((b) => b.key), ['deploy']);
    assert.ok(primary.filter((b) => b.key !== 'deploy').every((b) => b.loop === true));
  });

  test('every clip no primary role uses gets its own raw button, in the animations\' key order, never repeated', () => {
    const { primary, extra } = clipsOf(FULL);
    assert.deepEqual(extra.map((b) => b.key), ['raw:Default', 'raw:Skill_2_B', 'raw:Skill_Down_2', 'raw:Attack_Idle']);
    assert.deepEqual(extra.map((b) => b.label), ['Default', 'Skill_2_B', 'Skill_Down_2', 'Attack_Idle']);
    assert.ok(extra.every((b) => b.clip === b.label && b.loop === true && b.names.length === 1));
    // no clip appears in both groups — the roles' whole `names` lists count as used
    const used = new Set(primary.flatMap((b) => b.names));
    assert.ok(extra.every((b) => !used.has(b.clip)));
  });

  test('the attack button falls back to begin / end → attackDown when the roles have no loop', () => {
    const beginOnly = clipsOf(model('b', { attack: { begin: 'Attack_Begin', end: 'Attack_End' } }, { Attack_Begin: 1, Attack_End: 1 }));
    assert.equal(beginOnly.primary.find((b) => b.key === 'attack').clip, 'Attack_Begin');
    assert.deepEqual(beginOnly.primary.find((b) => b.key === 'attack').names, ['Attack_Begin', 'Attack_End']);
    const downOnly = clipsOf(model('d', { attackDown: 'Attack_Down' }, { Attack_Down: 1 }));
    assert.equal(downOnly.primary.find((b) => b.key === 'attack').clip, 'Attack_Down');
  });

  test('a role given as a bare string (legacy entries) is that one clip', () => {
    const bare = clipsOf(model('bare', { deploy: 'Start', idle: 'Idle', attack: 'Attack', skill: 'Skill' }, { Start: 1, Idle: 1, Attack: 1, Skill: 1 }));
    assert.deepEqual(bare.primary.map((b) => b.clip), ['Start', 'Idle', 'Attack', 'Skill']);
    assert.deepEqual(bare.extra, []);
  });

  test('duplicate names inside one role are deduplicated (a one-clip attack is one name)', () => {
    const same = clipsOf(model('same', { attack: { loop: 'Attack', begin: 'Attack', end: 'Attack' } }, { Attack: 1 }));
    assert.deepEqual(same.primary.find((b) => b.key === 'attack').names, ['Attack']);
  });

  test('no `anims` at all: the clip list still gives its Idle a 待机 button (spec)', () => {
    // The spec for P4: 待机 = `anims.idle`, else a clip name matching /^idle$/i. This case caught a real bug in the
    // first implementation — `button('idle', '待机', [roles.idle] || clips.filter(…))` never ran the fallback because
    // `[undefined]` is truthy, leaving `primary` EMPTY for a skeleton that ships `Idle` but no roles. Fixed in
    // public/js/ui/skinPreview.js (roles.idle ? [roles.idle] : …).
    const { primary, extra } = clipsOf({ animations: { Idle: 1, Start: 1 } });
    assert.ok(primary.length >= 1, 'primary holds at least the 待机 button from the clip list');
    assert.equal(primary.find((b) => b.key === 'idle')?.clip, 'Idle');
    // and the clip it claimed is not ALSO a raw button: primary and extra never offer the same clip (the same rule the
    // dedupe test above pins), so Start is the only leftover
    assert.deepEqual(extra.map((b) => b.label), ['Start'], 'the raw buttons list what the primary buttons did not claim');
    const all = [...primary, ...extra];
    const names = all.flatMap((b) => b.names);
    assert.equal(new Set(names).size, names.length, 'no clip is offered twice');
  });

  test('empty / null input never throws (the caller may hold a manifest without a model)', () => {
    assert.deepEqual(clipsOf(null), { primary: [], extra: [] });
    assert.deepEqual(clipsOf(undefined), { primary: [], extra: [] });
    assert.deepEqual(clipsOf({}), { primary: [], extra: [] });
    assert.deepEqual(clipsOf({ anims: null, animations: null }), { primary: [], extra: [] });
  });

  test('an entry with roles but no `animations` map gives the primary buttons and no extras', () => {
    const { primary, extra } = clipsOf({ anims: { deploy: 'Start', idle: 'Idle', attack: { loop: 'Attack' } } });
    assert.deepEqual(primary.map((b) => b.clip), ['Start', 'Idle', 'Attack']);
    assert.deepEqual(extra, []);
  });
});
