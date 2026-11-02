// test/sim/skins-token.test.js — P1 召唤物换装: a token wears the outfit its summoner wears.
//
// The rule is one field on `Unit.skin` (display only — no rule reads it and Battle.result() does not carry it), and it
// has three ways in:
//   * a board token listed AFTER its owner: `_makeAlly` gets `ownerUnit` in `extra` and inherits at creation;
//   * a board token listed BEFORE its owner (the board is top→bottom): the `late` link in `_addPlayer` fills it in;
//   * a skill summon: `Battle.spawnToken` goes through the same `_makeAlly(..., { ownerUnit })`.
// What each test pins is the silent failure — a token that keeps `skin: null` draws the default model on every client
// while the owner draws the outfit, and nothing throws.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeBattle } from '../helpers/battleHarness.js';

const OWNER = 'chess_char_2_02_a';          // 赫默
const TOKEN = 'token_10000_silent_healrb';  // 医疗探机 (its talent/typical summon)
const SKIN = 'char_108_silent@sweep#1';

const tokenOf = (h) => h.b.allyUnits.find((u) => u.kind === 'token' && u.defId === TOKEN);
const infoOf = (h, uid) => h.b.fieldMeta().units.find((u) => u.uid === uid);

test('a board token created after its owner inherits the owner\'s skin', () => {
  const h = makeBattle({
    timeLimit: 1, autoFinish: true, content: 'none',
    units: [
      { uid: 1, chessId: OWNER, row: 10, col: 4, skin: SKIN },
      { uid: 2, kind: 'token', tokenId: TOKEN, ownerUid: 1, row: 11, col: 4 },
    ],
  });
  h.step();
  const owner = h.unit(1);
  const tok = tokenOf(h);
  assert.equal(owner.skin, SKIN, 'the operator keeps its own choice');
  assert.equal(tok.ownerUnit, owner);
  assert.equal(tok.skin, SKIN, 'the token wears the same outfit');
  assert.equal(infoOf(h, 2).skin, SKIN, 'and it reaches the snapshot every client reads');
});

test('a board token listed before its owner (top→bottom order) inherits it once the owner exists', () => {
  const h = makeBattle({
    timeLimit: 1, autoFinish: true, content: 'none',
    // the token's tile is ABOVE the owner's: the board lists it first, so it cannot know its owner at creation
    units: [
      { uid: 2, kind: 'token', tokenId: TOKEN, ownerUid: 1, row: 9, col: 4 },
      { uid: 1, chessId: OWNER, row: 10, col: 4, skin: SKIN },
    ],
  });
  h.step();
  const owner = h.unit(1);
  const tok = tokenOf(h);
  assert.equal(tok.ownerUnit, owner, 'linked after every piece was built');
  assert.equal(tok.skin, SKIN, 'the late link carries the outfit');
  assert.equal(infoOf(h, 2).skin, SKIN);
});

test('a skill summon (Battle.spawnToken) inherits the summoner\'s skin', () => {
  const h = makeBattle({
    timeLimit: 3, autoFinish: false, content: 'generic',
    units: [{ uid: 1, chessId: OWNER, row: 10, col: 4, skin: SKIN }],
  });
  h.step();
  const owner = h.unit(1);
  // the path every skill / talent summon takes (server/sim/battle/summons.js): no token piece on the board
  const tok = h.b.spawnToken(owner, TOKEN, 11, 4);
  assert.ok(tok && tok.alive);
  assert.equal(tok.ownerUnit, owner);
  assert.equal(tok.skin, SKIN);
  assert.equal(h.b.fieldMeta().units.find((u) => u.uid == null && u.defId === TOKEN).skin, SKIN);
});

test('without an outfit the token stays on the default model and the wire has no skin key at all', () => {
  const h = makeBattle({
    timeLimit: 1, autoFinish: true, content: 'none',
    units: [
      { uid: 1, chessId: OWNER, row: 10, col: 4 },
      { uid: 2, kind: 'token', tokenId: TOKEN, ownerUid: 1, row: 11, col: 4 },
    ],
  });
  h.step();
  assert.equal(tokenOf(h).skin, null, 'the internal field is null, never a stale value');
  const info = infoOf(h, 2);
  // `undefined`, not null: JSON.stringify drops it, so a match without skins is byte-identical to before the feature
  assert.equal(info.skin, undefined);
  assert.ok(!('skin' in JSON.parse(JSON.stringify(info))), 'no skin key on the wire at all');
  assert.ok(!JSON.stringify(h.b.fieldMeta()).includes('"skin"'), 'nor on any other unit of the field');
});

test('the same seeded battle with a dressed token ends the same twice, and the result never carries the skin', () => {
  const spec = {
    seed: 498, timeLimit: 2, autoFinish: true, content: 'none',
    units: [
      { uid: 1, chessId: OWNER, row: 10, col: 4, skin: SKIN },
      { uid: 2, kind: 'token', tokenId: TOKEN, ownerUid: 1, row: 11, col: 4 },
    ],
  };
  const first = makeBattle(spec);
  const second = makeBattle(spec);
  assert.equal(first.unit(2).skin, SKIN);
  assert.equal(second.unit(2).skin, SKIN);
  const a = first.runToEnd();
  const b = second.runToEnd();
  assert.deepEqual(b, a, 'deterministic: the outfit is display only');
  assert.ok(!JSON.stringify(a).includes(SKIN), 'Battle.result() does not carry the skin');
});
