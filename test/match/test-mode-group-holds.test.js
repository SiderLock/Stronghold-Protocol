import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeMatch } from './harness.js';
import { PHASE } from '../../shared/constants.js';

test('test timers off hold every parallel group draft turn (multi-slot _testDraftHolds)', () => {
  const h = makeMatch({ humans: 8, bots: 0, fake: true, test: true, seed: 3 });
  h.start();
  assert.ok(h.run(() => h.m.phase === PHASE.SP_DRAFT || h.m.phase === PHASE.BAND_DRAFT || h.m.phase === PHASE.PREP),
    'reaches a draft or prep');
  // Prefer a multi-group SP draft when the schedule has one; otherwise band draft groups.
  if (h.m.phase !== PHASE.SP_DRAFT && h.m.phase !== PHASE.BAND_DRAFT) {
    // Force a later SP draft if R1 had none.
    assert.ok(h.run(() => h.m.phase === PHASE.SP_DRAFT), 'reaches SP_DRAFT');
  }
  const stage = h.m.phase === PHASE.SP_DRAFT ? h.m.sp : h.m.draft;
  assert.ok(stage && stage.groups.length >= 2, `multi-group stage (got ${stage?.groups?.length})`);
  assert.equal(h.m.testTimers, true);
  h.m.handle('p_0', { t: 'g.test', cmd: 'timers', args: { on: false } });
  assert.equal(h.m.testTimers, false);
  assert.ok(h.m._testDraftHolds.size >= 1, 'each live group turn is held');
  for (const g of stage.groups) assert.equal(g.timer, null, 'no live group timer while held');
  const before = stage.groups.map((g) => g.idx);
  const adv = h.m.handle('p_0', { t: 'g.test', cmd: 'phase', args: { name: 'advance' } });
  assert.ok(adv.ok, `advance fires one held turn (${JSON.stringify(adv)})`);
  const after = stage.groups.map((g) => g.idx);
  assert.ok(after.some((v, i) => v !== before[i] || stage.groups[i].done), 'one group progressed');
  h.m.handle('p_0', { t: 'g.test', cmd: 'timers', args: { on: true } });
  assert.equal(h.m.testTimers, true);
  h.m.dispose();
});
