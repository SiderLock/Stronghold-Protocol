// Merge regression: the v0.2.2 personal Art choice and cultivation settings coexist with the fixed twenty-player
// groups. Jump from the opening PREP straight to a boss round; this never drives the intervening fourteen-round game.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ERR, PHASE } from '../../shared/constants.js';
import { DATA, makeMatch, give, giveItem, legalTileFor, checkInvariants } from './harness.js';

const WHIP = 'chess_item_6_03_m';
const OP = 'chess_char_1_06_a';

for (const clientCombat of [false, true]) for (const hidden of [false, true]) {
  test(`twenty-player ${clientCombat ? 'client' : 'server'} ${hidden ? 'hidden' : 'leader'}: personal training choices and cultivation survive fixed groups`, (t) => {
    const seats = Array.from({ length: 20 }, (_, seat) => ({
      seat, playerId: `p_${seat}`, name: `P${seat}`, isBot: false, connected: true,
      ...(seat === 19 ? { ops: { [DATA.chess[OP].charId]: { potential: 1, cultivate: 0 } } } : {}),
    }));
    const h = makeMatch({ mode: 'coop', difficulty: 'NORMAL', seats, spectators: ['watcher'], seed: 22620,
      fake: true, clientCombat, instant: false, script: () => ({ bossDps: 1e9 }) }).start();
    const m = h.m;
    t.after(() => m.dispose());
    h.toPrep(1);
    const round = hidden ? 15 : 14;
    const phase = hidden ? PHASE.HIDDEN_CORE : PHASE.FINAL_ASSAULT;
    m.bossId = 'boss_1';
    m.hiddenBossId = 'boss_9';
    m.teamLp = m.alivePlayers().reduce((n, ps) => n + ps.lp, 0);
    m.startRound(round);
    h.runToPhase(PHASE.PREP, round);
    assert.equal(m.poolGroups.length, 5);
    const owner = h.ps('p_19');
    const tile = legalTileFor(m, owner, OP);
    assert.ok(tile, 'the boss half has a legal deployment tile');
    give(m, owner, OP, 'board', tile);
    const choosers = [h.ps('p_0'), owner];
    const cards = new Map();
    for (const ps of choosers) {
      const art = giveItem(m, ps, WHIP);
      assert.deepEqual(ps.useArt(art.uid, tile[0], tile[1]), { ok: true });
      const pending = ps.privateView().personalChoice;
      assert.equal(pending.cards.length, 3);
      assert.equal(ps.setReady(true).error, ERR.BAD_TARGET);
      assert.ok(!JSON.stringify(m.publicView()).includes(pending.id));
      assert.ok(!JSON.stringify(m.prepFieldMeta(ps)).includes(pending.id));
      cards.set(ps.playerId, { id: pending.id, card: ps.personalChoice.cards[1], funds: ps.pendingFunds });
    }
    assert.notEqual(cards.get('p_0').id, cards.get('p_19').id);
    assert.equal(m.handle('p_0', { t: 'g.choice', idx: 1, choiceId: cards.get('p_19').id }).error, ERR.BAD_TARGET);
    for (const ps of choosers) {
      assert.deepEqual(m.handle(ps.playerId, { t: 'g.choice', idx: 1, choiceId: cards.get(ps.playerId).id }), { ok: true });
      assert.equal(ps.personalChoice, null);
    }
    assert.ok(!h.allTo('watcher', 'm.private').length);
    h.drive(() => m.phase === phase);
    assert.equal(m.fields.length, 10, 'twenty living seats still make ten independent pairs');
    assert.equal(m.bossPool.maxHp, m.gd.boss(hidden ? m.hiddenBossId : m.bossId).bloodPoint.NORMAL * 20);
    const ownerField = m.fields.find((f) => f.players.includes(owner.playerId));
    const input = clientCombat ? ownerField.spec : ownerField.battle.opts;
    const unit = input.players.find((ps) => ps.playerId === owner.playerId).units.find((u) => u.chessId === OP);
    assert.deepEqual([unit.potential, unit.cultivate], [1, 0]);
    for (const ps of choosers) {
      const f = m.fields.find((field) => field.players.includes(ps.playerId));
      const spawns = clientCombat ? f.spec.spawns : f.battle.opts.spawns;
      assert.ok(spawns.some((s) => s.tag === 'bounty' && s.ownerPlayerId === ps.playerId && s.enemyKey === cards.get(ps.playerId).card.enemyKey));
    }
    assert.ok(h.run(() => m.lastResults.size === 20), 'only this selected boss battle settles for all twenty seats');
    for (const ps of choosers) {
      const chosen = cards.get(ps.playerId);
      assert.equal(ps.pendingFunds, chosen.funds + chosen.card.coin, 'the chosen perfect-training card pays once');
    }
    assert.equal(m.errorCount, 0);
    checkInvariants(m);
  });
}
