// Short merge regressions: opening rerolls replace every fixed pool without changing seat groups, and the
// subsequent parallel strategy clocks still run independently. No intervening battle rounds are simulated.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ERR, PHASE } from '../../shared/constants.js';
import { makeMatch, checkInvariants } from './harness.js';
import { encodeWire, decodeWire } from '../../shared/wireCodec.js';

function approveOpening(m) {
  const asker = m.humans().find((p) => p.playerId !== 'p_0');
  assert.deepEqual(m.askSetupReroll(asker.playerId, m.setupRevision), { ok: true });
  assert.deepEqual(m.publicView().rerollRequests, [{ playerId: asker.playerId }]);
  assert.deepEqual(decodeWire(encodeWire(m.publicView(), 's2c'), 's2c'), m.publicView(), 'nonempty requests survive compact-v1 extensions');
  assert.deepEqual(m.requestSetupReroll('p_0', m.setupRevision), { ok: true });
  assert.deepEqual(m.publicView().rerollRequests, [], 'the proposal clears requests for every fixed group');
  const voteId = m.setupVote.id;
  for (const ps of m.humans().slice(1)) {
    assert.deepEqual(m.handle(ps.playerId, { t: 'g.rerollVote', voteId, agree: true }), { ok: true });
  }
}

for (const [count, sizes] of [[6, [3, 3]], [9, [4, 5]], [13, [5, 4, 4]], [20, [4, 4, 4, 4, 4]]]) {
  test(`v0.2.3 opening reroll: ${count} seats keep fixed groups and replace all banned chess pools`, (t) => {
    const h = makeMatch({ humans: count, difficulty: 'HARD', seed: 123, fake: true }).start();
    const m = h.m;
    t.after(() => m.dispose());
    const groups = m.poolGroups;
    const membership = groups.map(({ id, playerIds, scale }) => ({ id, playerIds: [...playerIds], scale }));
    const stocks = m.order.map((ps) => ps.diyStock);
    const streams = [m.rngSetup, m.rngShop, m.rngDraft, m.rngWaves, m.rngBots, m.rngMeta].map((rng) => [rng, rng.state()]);
    approveOpening(m);
    assert.equal(m.setupRevision, 1);
    assert.equal(m.phase, PHASE.INFO_CHECK);
    assert.deepEqual(m.poolGroups.map((g) => g.playerIds.length), sizes);
    assert.deepEqual(m.poolGroups.map(({ id, playerIds, scale }) => ({ id, playerIds, scale })), membership);
    assert.equal(m.pool, m.poolGroups[0].pool);
    assert.equal(m.playerPools.size, count);
    for (const [i, group] of m.poolGroups.entries()) {
      assert.notEqual(group.pool, groups[i].pool);
      assert.deepEqual(group.pool.banned, [...m.bannedChess].sort());
      for (const id of m.gd.visibleChess) {
        assert.equal(group.pool.has(id), !m.bannedChess.includes(id));
        if (!group.pool.has(id)) continue;
        const scaled = m.gd.poolCopies(id) * group.scale;
        const expected = group.playerIds.length === 5 && m.gd.tierOf(id) === 3 ? Math.floor(scaled) : Math.ceil(scaled);
        assert.equal(group.pool.cap(id), expected);
        assert.equal(group.pool.left(id), expected);
      }
      for (const pid of group.playerIds) {
        assert.equal(m.players.get(pid).pool, group.pool, 'shop and return transactions use the new group pool');
        assert.equal(m.playerPools.get(pid), group.pool);
      }
    }
    for (const [i, ps] of m.order.entries()) assert.notEqual(ps.diyStock, stocks[i]);
    for (const [rng, state] of streams) assert.equal(rng.state(), state);
    checkInvariants(m);

    for (const ps of m.order) assert.deepEqual(m.handle(ps.playerId, { t: 'g.infoReady', setupRevision: 1 }), { ok: true });
    h.sched.advance(0);
    assert.equal(m.phase, PHASE.BAND_DRAFT);
    assert.deepEqual(m.draft.groups.map((g) => g.playerIds), membership.map((g) => g.playerIds));
    assert.ok(m.draft.groups.every((g) => g.turnSeconds === 50), 'the adopted upstream strategy turn is fifty seconds');
    const [a, b] = m.draft.groups;
    const otherClock = [b.timer, b.turnDeadline, b.order[b.idx]];
    h.sched.advance(1000);
    const bandId = m.gd.bandIds()[0];
    assert.deepEqual(m.handle(a.order[a.idx], { t: 'g.band', bandId, draftId: m.draft.id, groupId: a.id }), { ok: true });
    assert.deepEqual([b.timer, b.turnDeadline, b.order[b.idx]], otherClock);
    assert.deepEqual(m.handle(b.order[b.idx], { t: 'g.band', bandId, draftId: m.draft.id, groupId: b.id }), { ok: true },
      'the same strategy remains available to another group');
    assert.equal(m.errorCount, 0);
  });
}

test('v0.2.3 reroll after a departure retains the original five groups and their twenty opening seats', (t) => {
  const h = makeMatch({ humans: 20, difficulty: 'HARD', seed: 123, fake: true }).start();
  const m = h.m;
  t.after(() => m.dispose());
  const membership = m.poolGroups.map((g) => [...g.playerIds]);
  m.onLeave('p_19');
  approveOpening(m);
  assert.deepEqual(m.poolGroups.map((g) => g.playerIds), membership);
  assert.equal(m.poolGroups.length, 5);
  assert.equal(m.playerPools.size, 20);
  assert.ok(m.players.get('p_19').left);
  checkInvariants(m);
});

test('v0.2.3 failed last-seat stock preparation leaves every fixed pool, mapping and stock intact', (t) => {
  const h = makeMatch({ humans: 20, difficulty: 'HARD', seed: 123, fake: true }).start();
  const m = h.m;
  t.after(() => m.dispose());
  const groups = m.poolGroups, mapping = m.playerPools, pool = m.pool;
  const stocks = m.order.map((ps) => ps.diyStock);
  const setup = [m.stageId, m.stage, m.factions, m.bossId, m.hiddenBossId, m.bannedChess];
  assert.deepEqual(m.requestSetupReroll('p_0', 0), { ok: true });
  const voteId = m.setupVote.id;
  for (const ps of m.humans().slice(1, -1)) {
    assert.deepEqual(m.handle(ps.playerId, { t: 'g.rerollVote', voteId, agree: true }), { ok: true });
  }
  m.players.get('p_19').buildDiyStock = () => { throw Error('last-seat stock failed'); };
  assert.equal(m.handle('p_19', { t: 'g.rerollVote', voteId, agree: true }).error, ERR.INTERNAL);
  assert.equal(m.poolGroups, groups);
  assert.equal(m.playerPools, mapping);
  assert.equal(m.pool, pool);
  assert.deepEqual([m.stageId, m.stage, m.factions, m.bossId, m.hiddenBossId, m.bannedChess], setup);
  for (const [i, ps] of m.order.entries()) {
    assert.equal(ps.diyStock, stocks[i]);
    assert.equal(ps.pool, mapping.get(ps.playerId));
  }
  assert.equal(m.setupRevision, 0);
  assert.equal(m.setupVote, null);
  assert.equal(h.logs.error.length, 1);
  checkInvariants(m);
});
