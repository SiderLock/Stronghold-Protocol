// server/http/assetViews.js — the installation's own outfits merged into the served asset manifest (docs/SKINS.md
// 「本机提取的官方时装」). The extractor (tools/local-extract/skins.py) writes the official outfits' models and pictures
// under public/assets/local/skins/ and one metadata sidecar, data/local-skins.json; the server merges it into the copy
// it serves at /data/assets.json, so the picker — which reads the composed manifest — offers them with no plugin
// installed. A cosmetic plugin's overlay is still applied later on the client, so a plugin's record wins.
//
// What is pinned here: the merge is additive (nothing else in the manifest moves), an outfit the committed manifest
// already describes is left alone, an operator this build does not have is skipped (a sidecar from a newer client), a
// record with nothing to show is dropped, and an invalid model only costs the model (the pictures still play).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { mergeLocalSkins } from '../server/http/assetViews.js';

const DOC = {
  chars: {
    char_003_kalts: { avatar: '/a/k.png', spine: { front: { skel: '/s/k/front.skel', atlas: '/s/k/front.atlas', textures: ['/s/k/front.png'] } } },
    char_102_texas: { avatar: '/a/t.png' },
  },
  tokens: { token_1: { avatar: '/a/tok.png' } },
};

const FRONT = { skel: '/assets/local/skins/char_003_kalts/x/front.skel', atlas: '/assets/local/skins/char_003_kalts/x/front.atlas', textures: ['/assets/local/skins/char_003_kalts/x/front.png'] };
const skirt = (o = {}) => ({ version: 1, skins: o });

describe('installation outfits: the served manifest', () => {
  test('an outfit is added under its operator without touching anything else', () => {
    const out = mergeLocalSkins(DOC, skirt({
      'char_003_kalts@x#1': { charId: 'char_003_kalts', name: '余烬', group: '遗尘漫步', portrait: '/assets/local/skins/char_003_kalts/x/portrait.png', spine: { front: FRONT } },
    }));
    assert.notEqual(out, DOC, 'a copy is returned');
    assert.equal(DOC.chars.char_003_kalts.skins, undefined, 'the input document is not changed');
    const rec = out.chars.char_003_kalts.skins['char_003_kalts@x#1'];
    assert.equal(rec.name, '余烬');
    assert.equal(rec.group, '遗尘漫步');
    assert.equal(rec.portrait, '/assets/local/skins/char_003_kalts/x/portrait.png');
    assert.deepEqual(rec.spine.front, FRONT);
    // the rest of the manifest is untouched
    assert.deepEqual(out.chars.char_102_texas, DOC.chars.char_102_texas);
    assert.deepEqual(out.tokens, DOC.tokens);
    assert.deepEqual(out.chars.char_003_kalts.spine, DOC.chars.char_003_kalts.spine);
  });

  test('an outfit the committed manifest already describes is left alone (a plugin still wins on the client)', () => {
    const doc = { chars: { ...DOC.chars, char_102_texas: { ...DOC.chars.char_102_texas, skins: { 'char_102_texas@x#1': { name: '官方自带' } } } } };
    const out = mergeLocalSkins(doc, skirt({
      'char_102_texas@x#1': { charId: 'char_102_texas', name: '本机提取', spine: { front: FRONT } },
    }));
    assert.equal(out, doc, 'nothing to add: the same document comes back');
    assert.equal(out.chars.char_102_texas.skins['char_102_texas@x#1'].name, '官方自带');
  });

  test('an operator this build does not have is skipped, and a record with nothing to show is dropped', () => {
    const out = mergeLocalSkins(DOC, skirt({
      'char_999_unknown@x#1': { charId: 'char_999_unknown', name: '来自更新的客户端', spine: { front: FRONT } },
      'char_003_kalts@empty#1': { charId: 'char_003_kalts', name: '只有名字' },
    }));
    assert.equal(out, DOC, 'neither could be shown');
  });

  test('a broken model costs the model only — the pictures still play', () => {
    const out = mergeLocalSkins(DOC, skirt({
      'char_003_kalts@pics#1': { charId: 'char_003_kalts', name: '只有图', portrait: '/assets/local/skins/char_003_kalts/p/portrait.png', spine: { front: { skel: 42 } } },
    }));
    const rec = out.chars.char_003_kalts.skins['char_003_kalts@pics#1'];
    assert.equal(rec.spine, undefined);
    assert.equal(rec.portrait, '/assets/local/skins/char_003_kalts/p/portrait.png');
  });

  test('the back model is kept, and an absent sidecar changes nothing', () => {
    const out = mergeLocalSkins(DOC, skirt({
      'char_003_kalts@both#1': { charId: 'char_003_kalts', name: '正背', spine: { front: FRONT, back: { ...FRONT, skel: '/assets/local/skins/char_003_kalts/b/back.skel' } } },
    }));
    assert.equal(out.chars.char_003_kalts.skins['char_003_kalts@both#1'].spine.back.skel, '/assets/local/skins/char_003_kalts/b/back.skel');
    assert.equal(mergeLocalSkins(DOC, null), DOC);
    assert.equal(mergeLocalSkins(DOC, {}), DOC);
    assert.equal(mergeLocalSkins(DOC, { version: 1 }), DOC);
  });
});
