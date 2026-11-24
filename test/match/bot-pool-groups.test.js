import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getVersionData, setData } from '../../server/data.js';
import { makeMatch } from './harness.js';
import { bondReach } from '../../server/match/bot.js';

const DATA = getVersionData('act3autochess@V3_1');
setData(DATA);
test('a bot reads its own fixed group pool for bond availability (D010)', () => {
  const h = makeMatch({ mode: 'coop', difficulty: 'NORMAL', humans: 4, bots: 2, seed: 21, fake: true, data: DATA }).start();
  try {
    const m = h.m;
    assert.deepEqual(m.poolGroups.map((g) => g.playerIds.length), [3, 3]);
    const bot = m.order.find((ps) => ps.isBot && ps.pool !== m.pool);
    assert.ok(bot, 'a bot in the second group');
    const first = m.order.find((ps) => ps.pool === m.pool);
    const bond = [...m.pool.entries.keys()]
      .map((id) => m.gd.chess(id)?.bonds?.[0])
      .find((b) => b && [...bot.pool.entries.keys()].some((id) => (m.gd.chess(id)?.bonds || []).includes(b)));
    assert.ok(bond, 'a bond with members in both groups');
    const members = (pool) => [...pool.entries.keys()].filter((id) => pool.left(id) > 0 && (m.gd.chess(id)?.bonds || []).includes(bond));
    for (const id of members(bot.pool)) bot.pool.take(id, bot.pool.left(id));
    assert.ok(members(m.pool).length > 0, 'the first group still has members');
    assert.equal(bondReach(m, bot, bond), 0);
    assert.ok(bondReach(m, first, bond) > 0);
  } finally { h.m.dispose(); }
});

