import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { skel } from './helpers/pluginFixtures.js';
import { metaOf } from '../tools/local-extract/skin-meta.mjs';
import { roleAnimationNames } from '../tools/assets/anim-roles.mjs';

function model(t, names) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skin-meta-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'model.skel');
  fs.writeFileSync(file, skel({ animations: Object.fromEntries(names.map(n => [n, [['OnStart', 1]]])) }));
  return file;
}
const UTAGE = ['Idle', 'Start', 'Attack', 'Skill_Start', 'Skill_Loop', 'Skill_End'];

test('outfit metadata keeps Utage S1 resting but S2 attacking, for either model face', t => {
  for (const names of [UTAGE, [...UTAGE, 'Die']]) {
    const file = model(t, names);
    const m = metaOf(file, null, { charId: 'char_337_utage' });
    assert.equal(m.anims.skills['0'].loop, 'Skill_Loop');
    assert.deepEqual(m.anims.skills['1'], { begin: null, loop: 'Attack', end: null, via: 'attack', index: 1, idle: null });
    assert.equal(m.anims.skill.index, 1);
    assert.equal(m.anims.skill.via, 'attack');
    assert.ok(roleAnimationNames(m.anims).every(n => Object.hasOwn(m.animations, n)));
    assert.equal(metaOf(file).anims.skills['1'].loop, 'Skill_Loop', 'unidentified art retains the generic mapping');
    assert.equal(metaOf(file, null, { charId: 'char_other' }).anims.skills['1'].loop, 'Skill_Loop');
  }
});

test('outfit-specific clip names cannot acquire nonexistent default-model clips through nested skill fixes', t => {
  const file = model(t, ['Idle', 'Start', 'Attack_A', 'Skill_1_Loop', 'Skill_2_Loop']);
  const warnings = [];
  const m = metaOf(file, null, { charId: 'char_337_utage', onRoleWarning: r => warnings.push(r) });
  assert.deepEqual(warnings.sort(), ['skill', 'skills.0', 'skills.1']);
  assert.equal(m.anims.skills['0'].loop, 'Skill_1_Loop');
  assert.equal(m.anims.skills['1'].loop, 'Skill_2_Loop');
  assert.ok(roleAnimationNames(m.anims).every(n => Object.hasOwn(m.animations, n)));
});

test('Ifrit 轻松旅途 does not assign unbound extra Skill clips to every skill; other outfits stay independent', t => {
  const file = model(t, ['Idle', 'Attack', 'Skill', 'Skill_2_Begin', 'Skill_2_Loop', 'Skill_2_End']);
  const m = metaOf(file, null, { charId: 'char_134_ifrit', skinId: 'char_134_ifrit@rilakkuma#1' });
  assert.equal(m.anims.skills['0'].via, 'attack');
  assert.equal(m.anims.skills['2'].via, 'attack');
  assert.equal(m.anims.skills['1'].loop, 'Skill_2_Loop');
  assert.equal(m.anims.skills['1'].begin, 'Skill_2_Begin');
  assert.equal(m.anims.skill.loop, 'Attack');
  assert.equal(metaOf(file, null, { charId: 'char_134_ifrit', skinId: 'char_134_ifrit@another#1' }).anims.skills['0'].loop, 'Skill');
  assert.equal(metaOf(file, null, { charId: 'char_other', skinId: 'char_134_ifrit@rilakkuma#1' }).anims.skills['0'].loop, 'Skill');
});
