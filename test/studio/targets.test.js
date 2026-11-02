// server/studio/targets.js — what the studio's target picker (and `node tools/plugin.mjs new --target <名字>`) searches.
//
// This suite exists because the picker is the one place an author meets an internal key: they type 德克萨斯 and the page
// hands them `char_102_texas`. A skin key is the case that cannot be typed at all (`@` `#` `+` `.`, e.g.
// `char_102_texas@winter#1`), so since P7 (docs/SKINS.md) the manifest's skins are targets of their own: searchable by
// the outfit's name, its series and its operator, and copyable as `skin:<key>`.
//
// What is pinned: the target's CONTAINER path is `chars.<charId>.skins` (the studio reads and writes an overlay at
// `[...container, key]`, so a wrong path edits the wrong record), the icon falls back to the operator's picture, an
// installation with no skins lists none (the committed manifest has none), and a key that no `isAssetKey` accepts still
// round-trips through `targetSpec` / `targetOf`.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { buildTargets, searchTargets, targetOf, targetSpec, TARGET_KINDS } from '../../server/studio/targets.js';

const TEXAS = 'char_102_texas';
const WINTER = 'char_102_texas@winter#1';
const EPOQUE = 'char_102_texas_epoque_7';

const DATA = {
  chess: {
    visible: { charId: TEXAS, name: '德克萨斯', appellation: '企鹅物流' },
    // the same operator's elite record: not a second operator target (buildTargets skips isGolden)
    golden: { charId: TEXAS, name: '德克萨斯', isGolden: true },
  },
  tokens: { token_1: { tokenId: 'token_1', name: '香槟炸弹' } },
  enemies: null, items: null, bonds: null, bands: null, backups: null,
};

const MANIFEST = {
  chars: {
    [TEXAS]: {
      avatar: '/a/texas.png',
      skins: {
        [WINTER]: { name: '寒冬', group: '寒武纪' },
        [EPOQUE]: { name: '拾荒者', portrait: '/p/epoque.png' },
      },
    },
  },
  tokens: { token_1: { avatar: '/a/token.png' } },
};

describe('studio targets: 皮肤 (P7)', () => {
  test('a skin is a target of its own, under its operator\'s record, with its name and picture', () => {
    assert.ok(Object.hasOwn(TARGET_KINDS, 'skin'), 'the picker offers the kind');
    const list = buildTargets(DATA, MANIFEST);
    const skins = list.filter((t) => t.kind === 'skin');
    assert.deepEqual(skins.map((t) => t.name), ['寒冬', '拾荒者']);
    assert.deepEqual(skins.map((t) => t.key), [WINTER, EPOQUE]);
    // the container is where the studio reads/writes the overlay entry: chars.<charId>.skins, then the key
    for (const s of skins) assert.deepEqual(s.container, ['chars', TEXAS, 'skins']);
    assert.equal(skins[0].icon, '/a/texas.png', 'a skin with no picture of its own shows the operator\'s');
    assert.equal(skins[1].icon, '/p/epoque.png', 'a skin\'s own picture wins');
    // the operator itself is still one target, not two (the golden record is not indexed)
    assert.equal(list.filter((t) => t.kind === 'operator').length, 1);
  });

  test('search reaches a skin by its name, its series and its operator — and the operator ranks first', () => {
    const list = buildTargets(DATA, MANIFEST);
    assert.deepEqual(searchTargets(list, '寒冬').map((t) => t.key), [WINTER]);
    assert.deepEqual(searchTargets(list, '寒武纪').map((t) => t.key), [WINTER], 'the series is another word');
    const texas = searchTargets(list, '德克萨斯').map((t) => t.key);
    assert.equal(texas[0], TEXAS, 'the operator an author probably means comes first');
    assert.deepEqual(texas.slice(1), [WINTER, EPOQUE], '… and its outfits follow');
  });

  test('`skin:<key>` reads back as the same target, though the key carries @ # + .', () => {
    const list = buildTargets(DATA, MANIFEST);
    const winter = list.find((t) => t.key === WINTER);
    const spec = targetSpec(winter);
    assert.equal(spec, `skin:${WINTER}`);
    assert.equal(targetOf(list, spec).key, WINTER);
    // the bare key works too (a copied id), and a kind-qualified id of another kind does not poach a skin
    assert.equal(targetOf(list, WINTER).key, WINTER);
    assert.equal(targetOf(list, `operator:${WINTER}`), null);
  });

  test('an installation with no skins lists none — the committed manifest has none (docs/SKINS.md)', () => {
    const bare = buildTargets(DATA, { chars: { [TEXAS]: { avatar: '/a/texas.png' } }, tokens: { token_1: { avatar: '/a/token.png' } } });
    assert.equal(bare.filter((t) => t.kind === 'skin').length, 0);
    // the other kinds are untouched by this feature
    assert.ok(bare.some((t) => t.kind === 'operator' && t.key === TEXAS));
    assert.ok(bare.some((t) => t.kind === 'token' && t.key === 'token_1'));
  });
});
