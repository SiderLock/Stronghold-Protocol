import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateClientResult } from '../../server/match/fields.js';

function scenario(mods) {
  const spec = { kind: 'unite', timeLimit: 60, round: 10,
    players: [{ playerId: 'helper', units: [], bonds: {} }],
    spawns: mods.map((value, i) => ({ enemyKey: 'enemy_a', sourcePlayerId: `p_${i % 16}`, mods: value })) };
  const raw = { reason: 'timeout', time: 60, killed: 0, total: mods.length,
    perPlayer: { helper: { killed: 0, total: mods.length, coins: 0, perfect: false,
      leaked: spec.spawns.map(s => ({ enemyKey: s.enemyKey, sourcePlayerId: s.sourcePlayerId, mods: s.mods })),
      layerGains: {}, unitsEnd: [], unitStats: [] } } };
  return { spec, raw };
}

test('large multi-source results match spawn mods with bounded reads rather than rescanning per leak', () => {
  const mods = Array.from({ length: 4000 }, (_, i) => ({ hpMul: 1, rank: Math.floor(i / 250) }));
  const { spec, raw } = scenario(mods);
  let reads = 0;
  for (let i = 0; i < spec.spawns.length; i++) Object.defineProperty(spec.spawns[i], 'mods', {
    get() { reads++; return mods[i]; }, enumerable: true,
  });
  const result = validateClientResult(spec, raw);
  assert.ok(result.ok, result.reason);
  assert.deepEqual(result.result.perPlayer.helper.leaked.map(l => l.mods), mods);
  assert.ok(reads < mods.length * 15, `spawn mods read ${reads} times for ${mods.length} leaks`);
});

test('canonical mods preserve key order, omitted undefined values, zero and first matching fallback source', () => {
  const { spec, raw } = scenario([{ hpMul: 2, atkMul: 3, omitted: undefined }, { atkMul: 3, hpMul: 2 }, { v: -0 }]);
  raw.perPlayer.helper.leaked[0].mods = { atkMul: 3, hpMul: 2 };
  raw.perPlayer.helper.leaked[1].sourcePlayerId = null;
  raw.perPlayer.helper.leaked[2].mods = { v: 0 };
  // A missing source falls back to the first equal schedule entry; give that source another scheduled copy.
  spec.spawns[1].sourcePlayerId = 'p_0';
  const result = validateClientResult(spec, raw);
  assert.ok(result.ok, result.reason);
  const leaks = result.result.perPlayer.helper.leaked;
  assert.equal(leaks[1].sourcePlayerId, 'p_0');
  assert.deepEqual(leaks[0].mods, spec.spawns[0].mods);
  assert.ok(Object.is(leaks[2].mods.v, -0));
});

test('non-scalar mods retain shallow equality and parent fallback instead of JSON deep equality', () => {
  const shared = { value: 1 };
  const { spec, raw } = scenario([{ nested: shared }, { nested: { value: 1 } }, { hpMul: Infinity }]);
  const result = validateClientResult(spec, raw);
  assert.ok(result.ok, result.reason);
  assert.equal(result.result.perPlayer.helper.leaked[0].mods.nested, shared);
  assert.equal(result.result.perPlayer.helper.leaked[1].mods.nested, spec.spawns[1].mods.nested);
  assert.equal(result.result.perPlayer.helper.leaked[2].mods.hpMul, Infinity);
});

test('a derived enemy keeps matching parent mods from another enemy key and empty mods stay equivalent', () => {
  const { spec, raw } = scenario([{ hpMul: 2 }, { hpMul: 9 }, null, {}]);
  spec.spawns[1].enemyKey = 'enemy_b';
  raw.perPlayer.helper.leaked[1].enemyKey = 'enemy_b';
  raw.perPlayer.helper.leaked[0].mods = { hpMul: 9 };
  raw.perPlayer.helper.leaked[2].mods = {};
  const result = validateClientResult(spec, raw);
  assert.ok(result.ok, result.reason);
  assert.deepEqual(result.result.perPlayer.helper.leaked[0].mods, { hpMul: 9 });
  assert.equal(result.result.perPlayer.helper.leaked[2].mods, null);
});
