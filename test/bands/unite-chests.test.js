// D013 多轮联防: every wave's battle receipt decides the command chests (宝箱) it touched. Only the last wave used to
// reach settle()'s battle-result hook, so a chest destroyed in an earlier wave was rebuilt for the next wave and could
// come back in the next round. The match reconciles each wave where it arrives (_afterUniteWave).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeMatch } from '../match/harness.js';
import { createRegistry } from '../../server/match/effectsMeta.js';
import { getVersionData } from '../../server/data.js';
import { setGameData } from '../../server/sim/content/support/index.js';
import { PHASE } from '../../shared/constants.js';

const QUIET = { warn() {}, error() {}, info() {} };
const RAW = getVersionData('act3autochess@V3_1', { log: QUIET });
const REG = createRegistry({ log: QUIET });

const mark = (id) => ({ id, persistent: true, enemyId: 'enemy_9038_achest', row: 9, col: 2, round: 1 });

function setup(t) {
  setGameData(RAW);
  const h = makeMatch({ mode: 'coop', difficulty: 'NORMAL', humans: 2, bots: 0, seed: 137, registry: REG, fake: true, data: RAW }).start();
  t.after(() => { assert.equal(h.m.errorCount, 0); h.m.dispose(); setGameData(null); });
  h.toPrep(1);
  return h;
}

test('a 宝箱 destroyed in an earlier 联防 wave is reconciled before the next wave', (t) => {
  const h = setup(t);
  const ps = h.ps('p_0');
  ps.commandMarks = [mark(41), mark(42)];
  h.m.phase = PHASE.UNITE;
  const plan = { round: 1, roundsMax: 3, helpers: [ps] };
  h.m.unitePlan = plan;
  h.m._reconcileUniteChests({ perPlayer: {
    [ps.playerId]: { commandChests: [{ id: 41, alive: false }, { id: 42, alive: true }] },
  } });
  assert.equal(ps.commandMarks.some((m) => m.id === 41), false, 'the touched chest is gone');
  assert.equal(ps.commandMarks.some((m) => m.id === 42), true, 'the standing chest stays');
});

test('the wave receipt is applied before the wave decides next or settle', (t) => {
  const h = setup(t);
  const ps = h.ps('p_0');
  ps.commandMarks = [mark(43)];
  h.m.phase = PHASE.UNITE;
  const plan = { round: 1, roundsMax: 1, helpers: [ps] };
  h.m.unitePlan = plan;
  const calls = [];
  h.m.startUnite = (p) => calls.push(['unite', p]);
  h.m.settle = (p, r) => calls.push(['settle', r]);
  const result = { perPlayer: { [ps.playerId]: { commandChests: [{ id: 43, alive: false }] } }, synthetic: true };
  h.m._afterUniteWave(plan, result);
  assert.deepEqual(calls.map((c) => c[0]), ['settle'], 'the last wave settles');
  assert.equal(ps.commandMarks.some((m) => m.id === 43), false, 'its receipt was applied first');
});
