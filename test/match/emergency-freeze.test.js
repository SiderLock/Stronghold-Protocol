import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeMatch } from './harness.js';
import { ERR, PHASE } from '../../shared/constants.js';
import { BOSS_SILENCE_MS, RESULT_GRACE_MS } from '../../server/match/fields.js';

const HOLD = 120000;
const setup = (t, opts = {}) => {
  const h = makeMatch({ humans: 2, fake: true, instant: false, ...opts }).start();
  t.after(() => h.m.dispose());
  return h;
};
const freeze = (h) => h.m.setEmergencyFreeze(true, { reason: 'bandwidth', since: h.sched.now() - 1000 });
const resume = (h) => h.m.setEmergencyFreeze(false);

test('INFO emergency holds phase timeout, rejects gameplay and publishes frozen state immediately', (t) => {
  const h = setup(t);
  const m = h.m;
  assert.equal(Object.hasOwn(m.publicView(), 'emergencyFrozen'), false, 'normal snapshots omit emergency payload');
  h.sched.advance(1000);
  const remaining = m.deadline - h.sched.now();
  const frozenAt = h.sched.now();
  freeze(h);
  assert.equal(h.lastBc('m.public').emergencyFrozen, true);
  assert.equal(h.lastBc('m.public').emergencyFrozenAt, frozenAt);
  assert.equal(m.emergencyFrozenAt, frozenAt, 'never retroactively freezes at an older global sample');
  assert.equal(m.paused, false, 'co-op remains separate from the solo pause');
  assert.equal(m.handle('p_0', { t: 'g.infoReady' }).error, ERR.SERVER_EMERGENCY);
  assert.equal(m.requestSetupReroll('p_0', 0).error, ERR.SERVER_EMERGENCY);
  assert.equal(m.setLoadout('p_0', null).error, ERR.SERVER_EMERGENCY);
  h.sched.advance(HOLD);
  assert.equal(m.phase, PHASE.INFO_CHECK);
  resume(h);
  for (const key of ['emergencyFrozen', 'emergencyFrozenAt', 'emergencyReason']) {
    assert.equal(Object.hasOwn(h.lastBc('m.public'), key), false, `recovery snapshot omits ${key}`);
  }
  assert.equal(m.deadline - h.sched.now(), remaining);
  h.sched.advance(remaining - 1);
  assert.equal(m.phase, PHASE.INFO_CHECK);
  h.sched.advance(1);
  assert.equal(m.phase, PHASE.BAND_DRAFT);
  assert.equal(m.emergencyFrozenMs, HOLD);
});

test('parallel BAND and SP groups retain individual turn deadlines and pending choices', (t) => {
  const h = setup(t, { humans: 8 });
  const m = h.m;
  h.runToPhase(PHASE.BAND_DRAFT);
  for (const kind of ['draft', 'sp']) {
    if (kind === 'sp') {
      m.round = m.gd.spRounds()[0];
      m.enterSpDraft();
      assert.equal(m.phase, PHASE.SP_DRAFT);
    }
    h.sched.advance(1000);
    const stage = m[kind];
    const before = stage.groups.map((g) => ({ idx: g.idx, picks: { ...g.picks }, remaining: g.turnDeadline - h.sched.now() }));
    freeze(h);
    h.sched.advance(HOLD);
    assert.deepEqual(stage.groups.map((g) => ({ idx: g.idx, picks: g.picks })), before.map(({ idx, picks }) => ({ idx, picks })));
    resume(h);
    assert.deepEqual(stage.groups.map((g) => g.turnDeadline - h.sched.now()), before.map((g) => g.remaining));
    const next = Math.min(...before.map((g) => g.remaining));
    h.sched.advance(next - 1);
    assert.ok(stage.groups.every((g, i) => g.idx === before[i].idx));
    h.sched.advance(1);
    assert.ok(stage.groups.some((g, i) => g.idx > before[i].idx));
    if (kind === 'draft') for (const g of stage.groups) m.clearDraftGroupTimer(g);
  }
});

test('PREP holds the deadline and queued AI work; no ready or purchases advance it', (t) => {
  const h = setup(t, { bots: 1 });
  const m = h.m;
  h.toPrep();
  const remaining = m.deadline - h.sched.now();
  const bot = h.ps('ai_0');
  const before = JSON.stringify(bot.privateView());
  freeze(h);
  assert.equal(m.handle('p_0', { t: 'g.ready', ready: true }).error, ERR.SERVER_EMERGENCY);
  assert.equal(m.handle('p_0', { t: 'g.buy', slot: 0 }).error, ERR.SERVER_EMERGENCY);
  h.sched.advance(HOLD);
  assert.equal(m.phase, PHASE.PREP);
  assert.equal(JSON.stringify(bot.privateView()), before);
  resume(h);
  assert.equal(m.deadline - h.sched.now(), remaining);
  h.sched.advance(remaining);
  assert.equal(m.phase, PHASE.COMBAT);
});

test('client COMBAT holds field clocks and authority watchdogs, rejects late reports, permits resync', (t) => {
  const h = setup(t, { clientCombat: true, clients: false });
  const m = h.m;
  assert.ok(h.drive(() => m.phase === PHASE.COMBAT));
  const field = m.fields[0];
  h.sched.advance(2000);
  const elapsed = m._fieldElapsed(field);
  const remaining = field.startAt + field.spec.timeLimit / m.gameSpeed * 1000 + RESULT_GRACE_MS - h.sched.now();
  freeze(h);
  for (const type of ['b.progress', 'b.result', 'b.yield']) {
    assert.equal(m.handle('p_0', { t: type, battleId: field.battleId }).error, ERR.SERVER_EMERGENCY);
  }
  h.sched.advance(HOLD);
  assert.equal(field.mode, 'client');
  assert.equal(m._fieldElapsed(field), elapsed);
  m.onReconnect('p_0');
  assert.equal(h.lastTo('p_0', 'm.public').emergencyFrozen, true);
  assert.equal(h.lastTo('p_0', 'b.start').elapsed, elapsed);
  resume(h);
  assert.equal(m._fieldElapsed(field), elapsed);
  h.sched.advance(remaining - 1);
  assert.equal(field.mode, 'client');
  h.sched.advance(1);
  assert.equal(field.mode, 'server');
});

test('server COMBAT interval resumes without catch-up ticks or skipped battle phases', (t) => {
  const h = setup(t, { script: () => ({ duration: 60 }) });
  const m = h.m;
  assert.ok(h.drive(() => m.phase === PHASE.COMBAT));
  h.sched.advance(1000);
  const battle = m.fields[0].battle;
  const before = battle.time;
  freeze(h);
  h.sched.advance(HOLD);
  assert.equal(battle.time, before);
  assert.equal(m.phase, PHASE.COMBAT);
  resume(h);
  h.sched.advance(1000);
  assert.ok(battle.time > before + 1.5 && battle.time < before + 2.5, `${before} -> ${battle.time}`);
  assert.equal(m.phase, PHASE.COMBAT);
});

test('disconnect cancels setup vote during freeze and restores exactly its saved INFO time', (t) => {
  const h = setup(t);
  const m = h.m;
  h.sched.advance(1000);
  m.requestSetupReroll('p_0', 0);
  const remaining = m.setupVote.remainingMs;
  freeze(h);
  h.sched.advance(30000);
  m.onDisconnect('p_1');
  assert.equal(m.setupVote, null, 'disconnect still cancels the unanimous vote');
  h.sched.advance(90000);
  assert.equal(m.phase, PHASE.INFO_CHECK);
  resume(h);
  assert.equal(m.deadline - h.sched.now(), remaining, 'timer created during freeze does not get extra protection time');
});

test('leave and disconnect retain frozen phase, apply gameplay consequences once upon recovery', (t) => {
  const h = setup(t, { clientCombat: true, clients: false });
  const m = h.m;
  assert.ok(h.drive(() => m.phase === PHASE.COMBAT));
  const a = m.fields.find((f) => f.authority === 'p_0');
  const b = m.fields.find((f) => f.authority === 'p_1');
  freeze(h);
  m.onDisconnect('p_0');
  assert.equal(a.mode, 'client', 'no takeover in emergency');
  m.onReconnect('p_0');
  m.onLeave('p_1');
  assert.equal(b.done, false, 'no battle completed by a leave during protection');
  assert.equal(h.ps('p_1').left, true, 'platform leave state is immediate');
  h.sched.advance(HOLD);
  assert.equal(m.phase, PHASE.COMBAT);
  resume(h);
  assert.equal(a.mode, 'client', 'reconnected authority is preserved');
  assert.equal(b.done, true);
  assert.equal(h.ps('p_1').alive, false);
  assert.equal(m._emergencyLeaves.size, 0);
});

test('emergency and solo pause overlap without double-shifting clocks or double-counting solo pause', (t) => {
  const h = setup(t, { mode: 'solo', humans: 1, difficulty: 'FUNNY', clientCombat: true, clients: false });
  const m = h.m;
  assert.ok(h.drive(() => m.phase === PHASE.COMBAT));
  const field = m.fields[0];
  const deadline = m.deadline;
  h.sched.advance(1000);
  m.handle('p_0', { t: 'g.pause', on: true });
  const elapsed = m._fieldElapsed(field);
  h.sched.advance(2000);
  freeze(h);
  h.sched.advance(HOLD);
  resume(h);
  assert.equal(m.paused, true);
  assert.equal(m._fieldElapsed(field), elapsed);
  h.sched.advance(3000);
  m.handle('p_0', { t: 'g.pause', on: false });
  assert.equal(m.pausedMs, 5000);
  assert.equal(m.deadline, deadline + 5000 + HOLD);
  assert.equal(m._fieldElapsed(field), elapsed);
});

test('Final Assault freezes overtime, silence handover and AI pacer; resumes the same budget', (t) => {
  const h = setup(t, { bots: 2, clientCombat: true, clients: false });
  const m = h.m;
  h.toPrep();
  // Target-state fixture: directly enter the boss round, without simulating all preceding rounds.
  m.startRound(m.gd.bossRound);
  h.runToPhase(PHASE.PREP, m.gd.bossRound);
  // Force one client field (the two humans) and one server-run bot field — pairing is otherwise
  // seeded shuffle and may put a human on both sides, leaving no mode==='server' field for the pacer.
  m.bossPairs = [['p_0', 'p_1'], ['ai_0', 'ai_1']];
  assert.ok(h.drive(() => m.phase === PHASE.FINAL_ASSAULT));
  h.sched.advance(1000);
  const field = m.fields.find((f) => f.mode === 'client');
  const authority = field.authority;
  const botField = m.fields.find((f) => f.mode === 'server');
  const botTime = botField.battle.time;
  const lp = m.teamLp;
  const overtime = m.overtimeAt;
  const elapsed = m._fieldElapsed(field);
  freeze(h);
  h.sched.advance(HOLD * 3);
  assert.equal(m.teamLp, lp);
  assert.equal(field.mode, 'client');
  assert.equal(botField.battle.time, botTime);
  assert.equal(m._fieldElapsed(field), elapsed);
  resume(h);
  assert.equal(m.overtimeAt, overtime + HOLD * 3);
  h.sched.advance(1000);
  assert.ok(botField.battle.time > botTime + 1.5 && botField.battle.time < botTime + 2.5);
  assert.equal(field.mode, 'client');
  h.sched.advance(BOSS_SILENCE_MS);
  assert.notEqual(field.authority, authority, 'watchdog resumes and hands authority to its connected partner');
});

test('solo disconnect during protection clears solo pause without shortening the held authority deadline', (t) => {
  const h = setup(t, { mode: 'solo', humans: 1, difficulty: 'FUNNY', clientCombat: true, clients: false });
  const m = h.m;
  assert.ok(h.drive(() => m.phase === PHASE.COMBAT));
  const field = m.fields[0];
  h.sched.advance(1000);
  m.handle('p_0', { t: 'g.pause', on: true });
  const elapsed = m._fieldElapsed(field);
  h.sched.advance(2000);
  freeze(h);
  h.sched.advance(30000);
  m.onDisconnect('p_0');
  m.onReconnect('p_0');
  assert.equal(m.paused, false);
  assert.equal(m.pausedMs, 2000, 'solo duration excludes emergency time');
  assert.equal(m._fieldElapsed(field), elapsed);
  h.sched.advance(90000);
  resume(h);
  assert.equal(m._fieldElapsed(field), elapsed);
  const remaining = field.startAt + field.spec.timeLimit / m.gameSpeed * 1000 + RESULT_GRACE_MS - h.sched.now();
  h.sched.advance(remaining - 1);
  assert.equal(field.mode, 'client');
  h.sched.advance(1);
  assert.equal(field.mode, 'server');
});

test('UNITE protection holds the running wave and defers majority changes from disconnected voters', (t) => {
  const h = setup(t, { humans: 8, script: (battle) => battle.kind === 'normal' ? { leaks: { p_0: 3 } } : { duration: 20 } });
  const m = h.m;
  assert.ok(h.drive(() => m.phase === PHASE.UNITE));
  const plan = m.unitePlan;
  assert.equal(plan.round, 1);
  assert.ok(m.uniteSkipVoteView());
  for (const playerId of ['p_0', 'p_1', 'p_2']) {
    assert.deepEqual(m.handle(playerId, { t: 'g.uniteSkipVote' }), { ok: true });
  }
  assert.equal(plan.skipRemaining, false, '3 of 8 is below the original majority');
  const before = m.fields[0].battle.time;
  freeze(h);
  for (const playerId of ['p_5', 'p_6', 'p_7']) m.onDisconnect(playerId);
  assert.equal(plan.skipRemaining, false, 'disconnects do not pass a gameplay vote during protection');
  h.sched.advance(HOLD);
  assert.equal(m.phase, PHASE.UNITE);
  assert.equal(m.fields[0].battle.time, before);
  resume(h);
  assert.equal(plan.skipRemaining, true, 'normal current-human majority is evaluated after recovery');
  assert.equal(m.fields[0].battle.time, before);
});
