import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PHASE } from '../../shared/constants.js';
import { VERSIONS } from '../../shared/versions.js';
import { getData, getVersionData, setData } from '../../server/data.js';
import { setGameData } from '../../server/sim/content/support/index.js';
import { createRegistry } from '../../server/match/effectsMeta.js';
import { makeMatch, checkInvariants } from './harness.js';

for (const { id } of VERSIONS) {
  test(`${id}: twenty seats retain five independent stocks and parallel drafts through R1 prep`, t => {
    const current = getData(), data = getVersionData(id);
    setData(data);
    setGameData(data);
    t.after(() => { setData(current); setGameData(current); });
    const h = makeMatch({ humans: 20, fake: true, data, registry: createRegistry(), seed: 33 }).start();
    t.after(() => h.m.dispose());
    const m = h.m;
    for (const ps of m.order) m.handle(ps.playerId, { t: 'g.infoReady' });
    h.sched.advance(1);
    assert.equal(m.phase, PHASE.BAND_DRAFT);
    assert.deepEqual(m.poolGroups.map(g => g.playerIds.length), [4, 4, 4, 4, 4]);
    assert.equal(new Set(m.order.map(ps => ps.pool)).size, 5);
    assert.equal(m.draft.groups.length, 5);
    assert.equal(new Set(m.draft.groups.map(g => m.draftTurn(g.playerIds[0]))).size, 5);
    h.toPrep(1);
    for (const g of m.poolGroups) {
      const ps = m.players.get(g.playerIds[0]);
      assert.equal(new Set(g.playerIds.map(pid => m.itemPoolFor(m.players.get(pid)))).size, 1);
      assert.ok(ps.shop.slots.length > 0);
      assert.ok(ps.shop.slots.some(s => s?.id && ps.gd.chess(s.id)), 'shop uses this version data');
    }
    assert.equal(new Set(m.poolGroups.map(g => m.itemPoolFor(m.players.get(g.playerIds[0])))).size, 5);
    assert.equal(m.errorCount, 0);
    checkInvariants(m);
  });
}

test('deferred AI strategy decisions follow their own group token across parallel turns', t => {
  const h = makeMatch({ humans: 20, fake: true, seed: 33 }).start();
  t.after(() => h.m.dispose());
  const m = h.m;
  for (const ps of m.order) m.handle(ps.playerId, { t: 'g.infoReady' });
  h.sched.advance(1);
  const jobs = [];
  m.bot = { ...m.bot, decide: (_m, ps, job) => { jobs.push({ ps, ...job }); return true; } };
  const [a, b] = m.draft.groups;
  for (const g of [a, b]) {
    m.players.get(g.order[g.idx]).autoplay = true;
    m.scheduleBandBot(g);
  }
  h.sched.advance(1);
  assert.equal(jobs.length, 2);
  assert.ok(jobs.every(j => j.valid() && !j.complete()));
  jobs[0].fallback();
  assert.ok(!jobs[0].valid() && jobs[0].complete(), 'a completed turn expires its own decision');
  assert.ok(jobs[1].valid() && !jobs[1].complete(), 'another group stays valid');
  jobs[1].fallback();
  assert.equal(m.draft.picks[jobs[0].ps.playerId], jobs[0].ps.bandId);
  assert.equal(m.draft.picks[jobs[1].ps.playerId], jobs[1].ps.bandId);
});
