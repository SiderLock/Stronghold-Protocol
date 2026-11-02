import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ERR, PHASE } from '../../shared/constants.js';
import { validateC2S } from '../../shared/protocol.js';
import { makeMatch } from './harness.js';
import { FakeBattle } from './fakeBattle.js';

const voteMsg = { t: 'g.uniteSkipVote' };
function voteMatch({ humans = 3, bots = 8 - humans, clientCombat = false, beforeCombat = () => {} } = {}) {
  const h = makeMatch({ humans, bots, clientCombat, fake: true, seed: 707, spectators: ['viewer'],
    script: (b) => b.kind === 'normal' ? { leaks: { p_0: 6 } }
      : b.kind === 'unite' ? { survivors: { p_0: 3 }, coins: { [b.players[0]]: 5 } } : {},
  }).start();
  h.toPrep(1);
  beforeCombat(h);
  assert.ok(h.drive(() => h.m.phase === PHASE.UNITE && h.m.unitePlan.round === 1));
  return h;
}

test('the skip vote is a validated game intent', () => {
  assert.equal(validateC2S(voteMsg), null);
  assert.equal(validateC2S({ ...voteMsg, voteId: 'unite:match-1:1:3' }), null);
  for (const voteId of ['', 'bad id', 'a'.repeat(65), null, 3]) {
    assert.notEqual(validateC2S({ ...voteMsg, voteId }), null);
  }
});

for (const clientCombat of [false, true]) {
  for (const humans of [1, 2, 3, 4, 5, 8]) {
    test(`${clientCombat ? 'client' : 'server'} unite: ${humans} humans require strictly more than half to skip`, () => {
      const h = voteMatch({ humans, clientCombat });
      const m = h.m;
      const needed = Math.floor(humans / 2) + 1;
      assert.equal(m.publicView().unite.skipVote.needed, needed);
      assert.equal(m.publicView().unite.skipVote.eligible.length, humans);
      for (let i = 0; i < needed; i++) {
        assert.deepEqual(m.handle(`p_${i}`, voteMsg), { ok: true });
        assert.equal(m.unitePlan.skipRemaining, i + 1 === needed);
        m.handle(`p_${i}`, voteMsg);
        assert.equal(m.publicView().unite.skipVote.voters.length, i + 1, 'duplicate vote does not add a ballot');
      }
      assert.equal(m.phase, PHASE.UNITE, 'approval never interrupts the first wave');
      h.drive(() => m.phase === PHASE.SETTLE);
      assert.equal(new Set(FakeBattle.instances.filter((b) => b.kind === 'unite').map((b) => b.opts.seed)).size, 1);
      assert.equal(h.ps('p_0').stats.lpLost, 3, 'first-wave survivors still cost LP');
      const firstHelper = m.unitePlan.helpers[0].playerId;
      assert.equal(h.ps(firstHelper).pendingFunds, 5, 'first-wave rewards survive the skip');
      h.invariants();
      m.dispose();
    });
  }
}

test('eliminated humans vote; AI, spectators, offline and autoplay seats cannot', () => {
  const h = voteMatch({ humans: 4, bots: 7, beforeCombat: (h) => {
    const ps = h.ps('p_3'); ps.lp = 0; ps.eliminate(1);
    h.m.onDisconnect('p_1');
    h.m.handle('p_2', { t: 'g.autoplay', on: true });
  } });
  const m = h.m;
  assert.deepEqual(m.publicView().unite.skipVote.eligible, ['p_0', 'p_3']);
  assert.equal(m.handle('ai_0', voteMsg).error, ERR.NOT_IN_ROOM);
  assert.equal(m.handle('viewer', voteMsg).error, ERR.SPECTATOR);
  for (const pid of ['p_1', 'p_2']) assert.equal(m.handle(pid, voteMsg).error, ERR.BAD_TARGET);
  assert.deepEqual(m.handle('p_3', voteMsg), { ok: true });
  assert.equal(m.unitePlan.skipRemaining, false);
  m.handle('p_0', voteMsg);
  assert.equal(m.unitePlan.skipRemaining, true);
  m.dispose();
});

test('disconnect, autoplay and leaving discard ineligible votes; reconnecting does not restore a vote', () => {
  const h = voteMatch({ humans: 4, bots: 6 });
  const m = h.m;
  m.handle('p_0', voteMsg);
  m.onDisconnect('p_0');
  assert.deepEqual(m.publicView().unite.skipVote.voters, []);
  m.onReconnect('p_0');
  assert.deepEqual(m.publicView().unite.skipVote.voters, []);
  m.handle('p_0', voteMsg);
  m.handle('p_0', { t: 'g.autoplay', on: true });
  assert.deepEqual(m.publicView().unite.skipVote.voters, []);
  m.handle('p_0', { t: 'g.autoplay', on: false });
  m.handle('p_0', voteMsg);
  m.onLeave('p_0');
  assert.deepEqual(m.publicView().unite.skipVote.voters, []);
  assert.deepEqual(m.publicView().unite.skipVote.eligible, ['p_1', 'p_2', 'p_3']);
  assert.equal(m.publicView().unite.skipVote.needed, 2);
  m.dispose();
});

test('a smaller electorate can approve existing votes; approval stays latched after reconnect', () => {
  const h = voteMatch({ humans: 4 });
  const m = h.m;
  m.handle('p_0', voteMsg); m.handle('p_1', voteMsg);
  assert.equal(m.unitePlan.skipRemaining, false);
  m.onDisconnect('p_2');
  assert.equal(m.unitePlan.skipRemaining, true, 'two of the three eligible humans agree');
  m.onReconnect('p_2');
  assert.equal(m.unitePlan.skipRemaining, true);
  m.dispose();
});

test('insufficient votes keep the second wave and votes never carry into another round', () => {
  const h = voteMatch({ humans: 2 });
  const m = h.m;
  m.handle('p_0', voteMsg);
  h.drive(() => m.phase === PHASE.UNITE && m.unitePlan.round === 2);
  assert.equal(m.publicView().unite.skipVote, null);
  assert.equal(m.handle('p_1', voteMsg).error, ERR.WRONG_PHASE);
  h.toPrep(2);
  assert.equal(m.handle('p_0', voteMsg).error, ERR.WRONG_PHASE);
  h.drive(() => m.phase === PHASE.UNITE && m.unitePlan.round === 1);
  assert.deepEqual(m.publicView().unite.skipVote.voters, []);
  assert.equal(m.unitePlan.skipRemaining, false);
  m.dispose();
});

test('a one-wave plan and a completed first wave reject votes', () => {
  const h = voteMatch({ humans: 3 });
  const m = h.m;
  m.unitePlan.roundsMax = 1;
  assert.equal(m.publicView().unite.skipVote, null);
  assert.equal(m.handle('p_0', voteMsg).error, ERR.WRONG_PHASE);
  m.unitePlan.roundsMax = 2;
  h.drive(() => !m.fields[0].live);
  assert.equal(m.publicView().unite.skipVote.open, false);
  assert.equal(m.handle('p_0', voteMsg).error, ERR.WRONG_PHASE);
  m.dispose();
});

test('zero eligible humans never approve a skip automatically', () => {
  const h = voteMatch({ humans: 1 });
  const m = h.m;
  m.handle('p_0', { t: 'g.autoplay', on: true });
  assert.deepEqual(m.publicView().unite.skipVote.eligible, []);
  assert.equal(m.unitePlan.skipRemaining, false);
  m.handle('p_0', { t: 'g.autoplay', on: false });
  assert.equal(m.publicView().unite.skipVote.needed, 1);
  m.handle('p_0', voteMsg);
  assert.equal(m.unitePlan.skipRemaining, true);
  m.dispose();
});

for (const clientCombat of [false, true]) {
  for (const skipAt of [2, 4]) {
    test(`${clientCombat ? 'client' : 'server'} five-wave plan: fresh ballots can skip all later waves after wave ${skipAt}`, () => {
      const h = voteMatch({ humans: 3, bots: 17, clientCombat });
      const m = h.m;
      try {
        assert.equal(m.unitePlan.roundsMax, 5);
        const oldId = m.publicView().unite.skipVote.id;
        assert.deepEqual(m.handle('p_0', { ...voteMsg, voteId: oldId }), { ok: true });
        assert.equal(m.unitePlan.skipRemaining, false);
        assert.ok(h.drive(() => m.phase === PHASE.UNITE && m.unitePlan.round === skipAt));
        const vote = m.publicView().unite.skipVote;
        assert.notEqual(vote.id, oldId);
        assert.deepEqual(vote.voters, [], 'votes reset rather than accumulating over waves');
        assert.equal(m.handle('p_1', { ...voteMsg, voteId: oldId }).error, ERR.WRONG_PHASE);
        assert.deepEqual(m.publicView().unite.skipVote.voters, [], 'a delayed request cannot vote in a later wave');
        assert.deepEqual(m.handle('p_0', { ...voteMsg, voteId: vote.id }), { ok: true });
        assert.equal(m.unitePlan.skipRemaining, false);
        assert.deepEqual(m.handle('p_1', { ...voteMsg, voteId: vote.id }), { ok: true });
        assert.equal(m.unitePlan.skipRemaining, true);
        assert.equal(m.phase, PHASE.UNITE);
        assert.equal(m.fields[0].live, true, 'approval does not interrupt the current battle');
        assert.ok(h.drive(() => m.phase === PHASE.SETTLE));
        assert.equal(m.unitePlan.round, skipAt);
        assert.equal(new Set(FakeBattle.instances.filter((b) => b.kind === 'unite').map((b) => b.opts.seed)).size, skipAt);
        assert.equal(h.ps('p_0').stats.lpLost, 3);
        const helpers = m.publicView().uniteResult.helpers;
        assert.equal(helpers.length, 2 * skipAt);
        for (const pid of helpers.filter((_, i) => i % 2 === 0)) assert.equal(h.ps(pid).pendingFunds, 5);
        assert.match(h.bc.filter((entry) => entry.t === 'm.ticker').map((entry) => entry.text).join('\n'),
          /本轮结束后跳过后续全部联防/);
        h.invariants();
      } finally { m.dispose(); }
    });
  }
}

test('no eligible reserve helpers means no remaining-wave vote; a later game round has a new vote identity', () => {
  const h = voteMatch({ humans: 3, bots: 17 });
  const m = h.m;
  try {
    const oldId = m.publicView().unite.skipVote.id;
    h.toPrep(2);
    assert.ok(h.drive(() => m.phase === PHASE.UNITE && m.unitePlan.round === 1));
    assert.notEqual(m.publicView().unite.skipVote.id, oldId);
    assert.equal(m.handle('p_0', { ...voteMsg, voteId: oldId }).error, ERR.WRONG_PHASE);
    for (const ps of m.unitePlan.reserveHelpers) ps.left = true;
    assert.equal(m.publicView().unite.skipVote, null);
    assert.equal(m.handle('p_0', voteMsg).error, ERR.WRONG_PHASE);
  } finally { m.dispose(); }
});
