// Upstream's aiPicksLast protocol is accepted for compatibility. Co-op always preserves D004/D012:
// online manual players pick first within each fixed pool group; autoplay, disconnected and AI seats share
// one automatic category in their drawn order. Solo is unchanged. No setting consumes another random draw.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ERR, PHASE } from '../../shared/constants.js';
import { makeMatch } from './harness.js';

const isAi = (pid) => pid.startsWith('ai_');
const seatsOf = (ids) => ids.map((playerId, seat) => ({ seat, playerId, name: playerId, isBot: isAi(playerId), connected: true }));
const drawsOf = (m) => Object.fromEntries(['rngDraft', 'rngShop', 'rngBots', 'rngMeta', 'rngWaves'].map((k) => [k, m[k]()]));
const manual = (m, pid) => {
  const ps = m.players.get(pid);
  return ps.alive && !ps.left && !ps.isBot && ps.connected && !ps.autoplay;
};

function toBandDraft(o, before) {
  const h = makeMatch({ mode: 'coop', fake: true, ...o }).start();
  if (before) before(h.m);
  for (const ps of h.m.players.values()) if (!ps.isBot && !ps.left) h.m.handle(ps.playerId, { t: 'g.infoReady' });
  h.run(() => h.m.phase !== PHASE.INFO_CHECK);
  assert.equal(h.m.phase, PHASE.BAND_DRAFT);
  return h;
}

// Enter one draft directly: exercise ordering without playing preceding battles.
function toSpDraft(o, before) {
  const h = makeMatch({ mode: 'coop', fake: true, ...o });
  if (before) before(h.m);
  h.m.round = 3;
  h.m.enterSpDraft();
  assert.equal(h.m.phase, PHASE.SP_DRAFT);
  return h;
}

function snapshot(enter, o, before) {
  const h = enter(o, before);
  try {
    const stage = h.m.phase === PHASE.BAND_DRAFT ? h.m.draft : h.m.sp;
    return { groups: stage.groups.map((g) => ({ id: g.id, order: g.order.slice(), cards: g.cards })), draws: drawsOf(h.m) };
  } finally { h.m.dispose(); }
}

function assertManualFirst(m, stage) {
  for (const g of stage.groups) {
    const pending = g.order.slice(g.idx);
    const manualCount = pending.filter((pid) => manual(m, pid)).length;
    assert.ok(pending.slice(0, manualCount).every((pid) => manual(m, pid)), `group ${g.id}: ${pending}`);
    assert.ok(pending.slice(manualCount).every((pid) => !manual(m, pid)), `group ${g.id}: ${pending}`);
    assert.ok(g.order.every((pid) => g.playerIds.includes(pid)), 'no turn moves into another fixed group');
  }
}

test('aiPicksLast compatibility: co-op always enables manual priority; solo always disables the setting', () => {
  for (const mode of ['coop', 'solo']) for (const aiPicksLast of [undefined, false, true, 'yes']) {
    const h = makeMatch({ mode, humans: 1, bots: 3, aiPicksLast });
    try { assert.equal(h.m.aiPicksLast, mode === 'coop'); } finally { h.m.dispose(); }
  }
});

for (const [name, enter] of [['band', toBandDraft], ['机变', toSpDraft]]) {
  test(`${name}: legacy option values leave fixed-group orders, cards and every random stream unchanged`, () => {
    const ids = Array.from({ length: 20 }, (_, i) => i % 4 === 3 ? `ai_${i}` : `p_${i}`);
    for (const seed of [1, 5, 14]) {
      const o = { seats: seatsOf(ids), seed };
      const expected = snapshot(enter, o);
      for (const aiPicksLast of [false, true, 'yes']) assert.deepEqual(snapshot(enter, { ...o, aiPicksLast }), expected, `seed ${seed}, ${aiPicksLast}`);
    }
  });

  test(`${name}: online manual humans lead; autoplay and disconnected humans keep the same drawn order as AI seats`, () => {
    const ids = ['p_0', 'p_1', 'p_2', 'ai_0'];
    const makeAutomatic = (m) => {
      m.players.get('p_0').autoplay = true;
      m.players.get('p_1').autoplay = true;
      m.players.get('p_2').connected = false;
    };
    let aiBeforeAutomaticHuman = false;
    for (let seed = 1; seed <= 12; seed++) {
      const o = { seats: seatsOf(ids), seed };
      const allAutomatic = snapshot(enter, o, makeAutomatic);
      const h = enter(o, (m) => { makeAutomatic(m); m.players.get('p_0').autoplay = false; });
      try {
        const stage = h.m.phase === PHASE.BAND_DRAFT ? h.m.draft : h.m.sp;
        const expected = ['p_0', ...allAutomatic.groups[0].order.filter((pid) => pid !== 'p_0')];
        assert.deepEqual(stage.groups[0].order, expected, `seed ${seed}: one stable manual/automatic partition`);
        assertManualFirst(h.m, stage);
        assert.deepEqual(drawsOf(h.m), allAutomatic.draws, `seed ${seed}: statuses draw no extra randomness`);
        if (expected.indexOf('ai_0') < expected.indexOf('p_1')) aiBeforeAutomaticHuman = true;
      } finally { h.m.dispose(); }
    }
    assert.ok(aiBeforeAutomaticHuman, 'automatic human seats receive no extra priority over AI');
  });

  test(`${name}: twenty seats reprioritize only the affected group after disconnect, reconnect and autoplay`, () => {
    const ids = Array.from({ length: 20 }, (_, i) => i % 4 === 3 ? `ai_${i}` : `p_${i}`);
    const h = enter({ seats: seatsOf(ids), seed: 38 });
    const m = h.m;
    try {
      const stage = m.phase === PHASE.BAND_DRAFT ? m.draft : m.sp;
      assert.equal(stage.groups.length, 5);
      assert.deepEqual(stage.groups.map((g) => g.playerIds), m.poolGroups.map((g) => g.playerIds));
      assertManualFirst(m, stage);
      const [group, ...others] = stage.groups;
      const untouched = others.map((g) => ({ order: g.order.slice(), deadline: g.turnDeadline, timer: g.timer, token: g.token }));
      const [first, second] = group.order;
      m.onDisconnect(first);
      assert.equal(group.order[group.idx], second);
      assertManualFirst(m, stage);
      m.onReconnect(first);
      assert.equal(group.order[group.idx], second, 'a returning player waits behind the current manual picker');
      assertManualFirst(m, stage);
      assert.deepEqual(m.handle(second, { t: 'g.autoplay', on: true }), { ok: true });
      assert.notEqual(group.order[group.idx], second);
      assertManualFirst(m, stage);
      assert.deepEqual(m.handle(second, { t: 'g.autoplay', on: false }), { ok: true });
      assertManualFirst(m, stage);
      assert.deepEqual(others.map((g) => ({ order: g.order.slice(), deadline: g.turnDeadline, timer: g.timer, token: g.token })), untouched);
    } finally { m.dispose(); }
  });

  test(`${name}: a departed pending seat cannot prevent the remaining manual player from choosing`, () => {
    const h = enter({ seats: seatsOf(['p_0', 'p_1', 'p_2', 'ai_0']), seed: 5 });
    const m = h.m;
    try {
      const stage = m.phase === PHASE.BAND_DRAFT ? m.draft : m.sp;
      const group = stage.groups[0];
      const [departing, next] = group.order;
      m.onLeave(departing);
      assert.equal(group.order[group.idx], next);
      assertManualFirst(m, stage);
      assert.equal(m.players.get(departing).alive, false);
    } finally { m.dispose(); }
  });
}

test('band skip remains in its fixed group, passes only to another manual picker and preserves automatic order', () => {
  const ids = ['p_0', 'p_1', 'ai_0', 'p_2', 'p_3', 'ai_1'];
  const h = toBandDraft({ seats: seatsOf(ids), seed: 3, aiPicksLast: false });
  const m = h.m;
  try {
    const [group, other] = m.draft.groups;
    const [first, second, ai] = group.order;
    const untouched = { order: other.order.slice(), deadline: other.turnDeadline, timer: other.timer };
    assert.deepEqual(m.handle(first, { t: 'g.bandSkip' }), { ok: true });
    assert.deepEqual(group.order, [second, first, ai]);
    assert.deepEqual(m.handle(second, { t: 'g.bandSkip' }), { ok: true });
    assert.deepEqual(group.order, [first, second, ai]);
    assert.deepEqual(m.handle(first, { t: 'g.band', bandId: 'band_amiya' }), { ok: true });
    assert.equal(m.draftTurn(second), second);
    assert.equal(m.handle(second, { t: 'g.bandSkip' }).error, ERR.ALREADY, 'each manual player has only one skip');
    assert.deepEqual({ order: other.order.slice(), deadline: other.turnDeadline, timer: other.timer }, untouched);
  } finally { m.dispose(); }

  const alone = toBandDraft({ seats: seatsOf(['p_0', 'ai_0', 'ai_1', 'ai_2']), seed: 3 });
  try {
    const order = alone.m.draft.order.slice();
    assert.equal(order[0], 'p_0');
    assert.equal(alone.m.handle('p_0', { t: 'g.bandSkip' }).error, ERR.BAD_TARGET, 'automatic seats do not make a manual skip meaningful');
    assert.deepEqual(alone.m.draft.order, order);
  } finally { alone.m.dispose(); }
});

test('solo: legacy option values change neither strategy order nor random streams', () => {
  const expected = snapshot(toBandDraft, { mode: 'solo', humans: 1, seed: 7 });
  for (const aiPicksLast of [false, true]) assert.deepEqual(snapshot(toBandDraft, { mode: 'solo', humans: 1, seed: 7, aiPicksLast }), expected);
});
