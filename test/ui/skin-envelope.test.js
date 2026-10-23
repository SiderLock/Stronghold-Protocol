// 导出 / 导入 携带时装 (docs/SKINS.md 导出 / 导入) — the two envelopes' skin companion, at the model layer.
//
// The skins are the same per-OPERATOR map the picker writes (`sp.pref.skins`, `room.skins`): the roster envelope carries
// it whole, the 自选编队 envelope carries only the operators its picks field (a slot wears its pick's skin — the slot id
// never appears here). Absent means "this payload says nothing about appearances", which is what keeps an older export
// from clearing choices the importing browser already has; the screen merges whatever it gets (screens/loadout.js
// applySkinChoices), it never replaces the map.
//
// What is pinned here is the WIRE rule, not the UI: a pair that would make `room.skins` BAD_MSG (a non-charId key, a
// non-string or empty skin id, more pairs than `SKIN_LIMITS.entries`) must never reach the store from a file.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { exportPayload, parseImport, cleanSkins } from '../../public/js/ui/loadoutModel.js';
import { exportDiy, parseDiyImport } from '../../public/js/ui/diyModel.js';
import { SKIN_LIMITS } from '../../shared/protocol.js';

const OP = 'char_498_inside';
const OP2 = 'char_003_kalts';
const OP3 = 'char_010_chen';
const SKIN = 'char_498_inside@kitchen#2';
const SKIN2 = 'char_003_kalts@boc#6';
const SKIN3 = 'char_010_chen@nian#2';

describe('时装 in the 干员调配 envelope', () => {
  test('export carries the map; a payload without skins keeps no key (an older export leaves choices alone)', () => {
    const withSkins = exportPayload({ chess_a: { skill: 1 } }, { ops: {}, skins: { [OP]: SKIN }, now: 0 });
    assert.deepEqual(withSkins.skins, { [OP]: SKIN });
    const without = exportPayload({ chess_a: { skill: 1 } }, { ops: {}, skins: {}, now: 0 });
    assert.equal('skins' in without, false, 'no cosmetic layer: the payload is exactly what it was');
    const old = exportPayload({ chess_a: { skill: 1 } }, { ops: {}, now: 0 });
    assert.equal('skins' in old, false);
  });

  test('import returns the map and drops pairs the wire would refuse', () => {
    const res = parseImport({ v: 1, kind: 'stronghold.loadout', entries: { chess_a: { skill: 1 } }, skins: {
      [OP]: SKIN,
      [OP2]: SKIN2,
      notacharid: SKIN3,          // a key that is not a charId: `room.skins` would refuse the whole map
      [OP3]: '',                  // an empty skin id: the same
      num: 42,                    // not a string
    } });
    assert.equal(res.ok, true);
    assert.deepEqual(res.skins, { [OP]: SKIN, [OP2]: SKIN2 });
    const bare = parseImport({ v: 1, kind: 'stronghold.loadout', entries: { chess_a: { skill: 1 } } });
    assert.equal('skins' in bare, false, 'no `skins` field: nothing is imported over the current choices');
  });

  test('cleanSkins caps the map at the wire limit, keeping insertion order', () => {
    const many = {};
    const ids = [];
    for (let i = 0; i < SKIN_LIMITS.entries + 5; i++) {
      const id = `char_${1000 + i}_op`;
      ids.push(id);
      many[id] = `${id}@x#1`;
    }
    const out = cleanSkins(many);
    assert.equal(Object.keys(out).length, SKIN_LIMITS.entries, 'never more pairs than the wire accepts');
    assert.deepEqual(Object.keys(out), ids.slice(0, SKIN_LIMITS.entries), 'the first pairs are the ones kept');
  });
});

describe('时装 in the 自选编队 envelope', () => {
  test('export carries only the operators its picks field; import returns the same shape', () => {
    const picks = { slot_5_1: { charId: OP }, slot_6_1: { charId: OP2 } };
    const env = exportDiy(picks, { skins: { [OP]: SKIN, [OP2]: SKIN2, [OP3]: SKIN3 }, now: 0 });
    assert.deepEqual(env.skins, { [OP]: SKIN, [OP2]: SKIN2 }, 'an operator this roster does not field is not in this file');
    const back = parseDiyImport(env);
    assert.deepEqual(back.skins, { [OP]: SKIN, [OP2]: SKIN2 });
  });

  test('a file with no picks or no skins says nothing about appearances', () => {
    assert.equal('skins' in exportDiy({}, { skins: { [OP]: SKIN }, now: 0 }), false, 'no slots: nothing to dress');
    assert.equal('skins' in exportDiy({ slot_5_1: { charId: OP } }, { now: 0 }), false);
    assert.equal('skins' in parseDiyImport({ v: 1, kind: 'stronghold.diy', picks: { slot_5_1: { charId: OP } } }), false);
    // and a file that names an operator this build does not have still imports its other choices untouched
    const ok = parseDiyImport({ v: 1, kind: 'stronghold.diy', picks: { slot_5_1: { charId: OP } }, skins: { notacharid: SKIN } });
    assert.equal(ok.ok, true);
    assert.equal('skins' in ok, false);
  });
});
