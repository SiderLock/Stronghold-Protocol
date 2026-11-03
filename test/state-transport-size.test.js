import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffState, StateReceiver } from '../shared/stateDelta.js';
import { negotiateStateDelta, prepareStateFrame, resetStateDelta } from '../server/stateTransport.js';

test('shared UTF-8 lengths preserve the exact full/delta choice for differently sequenced recipients', () => {
  const sockets = Array.from({ length: 20 }, () => ({}));
  const receivers = sockets.map(() => new StateReceiver());
  const previous = sockets.map(() => null);
  sockets.forEach(ws => negotiateStateDelta(ws, 1));
  const skins = Object.fromEntries(Array.from({ length: 180 }, (_, i) => [`char_${i}`, `时装_${i}🌟`]));
  let expectedSeq = sockets.map(() => 0);
  for (let tick = 0; tick < 110; tick++) {
    const msg = { t: 'm.public', phase: 'PREP', round: 1, serverNow: tick,
      players: Array.from({ length: tick % 19 === 0 ? 1 : 20 }, (_, i) => ({ playerId: `p${i}`, name: '中文🌟', hp: tick + i, skins })) };
    const encoded = JSON.stringify(msg);
    for (let i = 0; i < sockets.length; i++) {
      if (tick % (i + 1)) continue;
      if (tick === 100) { resetStateDelta(sockets[i]); previous[i] = null; }
      const seq = ++expectedSeq[i], prev = previous[i];
      const full = JSON.stringify({ t: 'm.state', kind: 'm.public', seq, full: msg });
      const ops = prev && diffState(prev.msg, msg);
      const delta = ops && JSON.stringify({ t: 'm.state', kind: 'm.public', seq, base: prev.seq, patch: ops });
      const expected = delta && Buffer.byteLength(delta) < Buffer.byteLength(full) ? delta : full;
      const frame = prepareStateFrame(sockets[i], msg, encoded);
      assert.equal(frame.data, expected, `socket ${i}, tick ${tick}`);
      frame.commit();
      assert.deepEqual(receivers[i].receive(JSON.parse(frame.data)).message, msg);
      previous[i] = { msg, seq };
    }
  }
});
