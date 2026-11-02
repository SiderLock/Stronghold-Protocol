// test/plugins/pack-token.test.js — P1 召唤物换装, the pack-time half: which rules a model's animation roles are
// resolved with.
//
// A skin may carry a summon variant (`chars.<c>.skins.<k>.tokens.<t>.spine` — the overlay record, shared/plugins/
// visual.js), whose skeleton is a TOKEN skeleton: it has the token's clips (`Skill_1`, `Attack`, `Idle`…), not an
// operator's. The pack builder classified a model by `op.at[0]`, so that variant — hanging under `chars` — was
// resolved with the operator's rules (`skillIndices [0,1,2]`, the `Skill_1/2/3` family) instead of the token's `[0]`
// (tools/assets/plan.mjs:544,549 is what the install pipeline gives a token model). The result is a lock whose clip
// data names the wrong skills; it only shows up as a wrong animation at runtime.
//
// `opContainer` reads the whole path (`tokens` anywhere is a token model), and `roleOptions` — exported so this
// classification is testable without a skeleton binary — is what `skeletonClipData` feeds to `resolveRoles`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { opContainer, roleOptions } from '../../server/plugins/pack.js';
import { resolveRoles } from '../../tools/assets/anim-roles.mjs';

const at = (...path) => ({ at: path });

test('a skin\'s summon variant is a TOKEN model, an operator/other entry keeps its top-level container', () => {
  // the P1 record: a token model under an operator's skin
  assert.equal(opContainer(at('chars', 'char_498_inside', 'skins', 'char_498_inside@kitchen#2', 'tokens', 'token_10006_vodfox_doll', 'spine', 'front')), 'tokens');
  // …while the same skin's own operator model stays an operator
  assert.equal(opContainer(at('chars', 'char_498_inside', 'skins', 'char_498_inside@kitchen#2', 'spine', 'front')), 'chars');
  assert.equal(opContainer(at('chars', 'char_498_inside', 'spine', 'front')), 'chars');
  // a top-level summon and an enemy are unchanged
  assert.equal(opContainer(at('tokens', 'token_10006_vodfox_doll', 'spine')), 'tokens');
  assert.equal(opContainer(at('enemies', 'enemy_1305_mhslim', 'spine', 'front')), 'enemies');
  // a segment, not a substring: a skin KEY that merely spells "tokens" is still an operator's skin
  assert.equal(opContainer(at('chars', 'char_x', 'skins', 'char_x@tokens#1', 'spine', 'front')), 'chars');
  // an unknown/absent path never claims to be a token
  assert.equal(opContainer(at('ui', 'hudPanel/icon_hp')), 'ui');
  assert.equal(opContainer({}), undefined);
});

test('token rules resolve one skill slot, operator rules the pool\'s three', () => {
  // one skeleton that has the operator skill family (Skill_1 / Skill_2 / Skill_3): the shape of a dressed summon model
  const names = ['Idle', 'Start', 'Attack', 'Skill_1', 'Skill_2_Loop', 'Skill_3_Begin', 'Skill_3_Loop', 'Skill_3_End', 'Die'];
  const token = resolveRoles(names, roleOptions(new Set(['tokens'])));
  const operator = resolveRoles(names, roleOptions(new Set(['chars'])));
  // a token model: skill indices [0] only — exactly what tools/assets/plan.mjs passes for `token:<id>` models
  assert.deepEqual(roleOptions(new Set(['tokens'])), { skillIndices: [0], numberedSkills: false });
  assert.equal(token.skill.loop, 'Skill_1');
  assert.equal(token.skills, undefined, 'a single skill slot, no per-index map');
  // an operator model: [0,1,2] (and only then does resolveRoles publish the per-index map)
  assert.deepEqual(roleOptions(new Set(['chars'])), { skillIndices: [0, 1, 2], numberedSkills: false });
  assert.deepEqual(Object.keys(operator.skills), ['0', '1', '2']);
  assert.equal(operator.skills['2'].loop, 'Skill_3_Loop');
  // an enemy keeps its numbered clips
  assert.deepEqual(roleOptions(new Set(['enemies'])), { skillIndices: [0], numberedSkills: true });
});
