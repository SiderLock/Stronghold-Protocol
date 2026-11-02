import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHAT_LIMITS, chatTextLength, isChatTextInput, normalizeChatText } from '../shared/matchChat.js';
import { MatchChat } from '../server/matchChat.js';
import { ERR } from '../shared/constants.js';

const sender = (playerId = 'p_a', seat = 0) => ({ playerId, name: '龙千尘', seat, spectator: false });

test('chat input counts Unicode points, rejects oversize and malformed strings, normalizes plain text', () => {
  assert.equal(chatTextLength('你好😀'), 3);
  assert.equal(isChatTextInput('😀'.repeat(CHAT_LIMITS.text)), true);
  assert.equal(normalizeChatText('😀'.repeat(CHAT_LIMITS.text)), '😀'.repeat(CHAT_LIMITS.text));
  for (const input of [null, 1, {}, '', ' '.repeat(201), '字'.repeat(201), '😀'.repeat(201), '\ud800', '\udfff']) {
    assert.equal(isChatTextInput(input), false);
    assert.equal(normalizeChatText(input), null);
  }
  assert.equal(normalizeChatText(' \t  \n '), null);
  assert.equal(normalizeChatText('\u0000\u202e\u2067'), null);
  assert.equal(normalizeChatText('  你\t好\r\n同盟 \u202e\u0000 '), '你 好\n同盟');
  assert.equal(normalizeChatText('一 \r\n \n\n \r 二'), '一\n\n二');
  assert.equal(normalizeChatText('e\u0301'), 'é');
  assert.equal(normalizeChatText('👨‍👩‍👧'), '👨‍👩‍👧');
  assert.equal(normalizeChatText('<img src=x onerror=alert(1)>'), '<img src=x onerror=alert(1)>');
});

test('chat scopes are unique and sender metadata comes only from supplied authoritative fields', () => {
  const chat = new MatchChat({ now: () => 100 });
  const other = new MatchChat({ now: () => 100 });
  assert.notEqual(chat.matchId, other.matchId);
  assert.match(chat.matchId, /^chat_[0-9a-f]{24}$/);
  const result = chat.append({ ...sender(), text: 'spoof', seq: 8, at: 99 }, '你好');
  assert.deepEqual(result.message, { t: 'm.chat', matchId: chat.matchId, seq: 1, playerId: 'p_a', name: '龙千尘',
    seat: 0, spectator: false, text: '你好', at: 100 });
  const snapshot = chat.snapshot();
  snapshot.messages.length = 0;
  assert.equal(chat.snapshot().messages.length, 1);
  assert.throws(() => { chat.snapshot().messages[0].text = 'tampered'; }, TypeError);
  assert.equal(chat.append({ playerId: 's', name: '观战', seat: null, spectator: true }, '旁观').message.spectator, true);
  assert.ok(chat.append({ ...sender('p_emoji', 1), name: '😀'.repeat(12) }, 'emoji name').message);
  for (const bad of [null, { ...sender(), seat: -1 }, { ...sender(), seat: 20 },
    { ...sender(), playerId: '' }, { ...sender(), name: '' }, { ...sender(), spectator: true }]) {
    assert.equal(chat.append(bad, 'invalid sender').error, ERR.BAD_TARGET);
  }
});

test('sender rate budget survives callers reconnecting, room budget bounds simultaneous broadcasts', () => {
  let now = 0;
  const chat = new MatchChat({ now: () => now });
  for (let n = 0; n < 3; n++) assert.ok(chat.append(sender(), `msg${n}`).message);
  assert.equal(chat.append(sender(), 'repeat').error, ERR.RATE);
  now = 1999;
  assert.equal(chat.append({ ...sender() }, 'new sender object').error, ERR.RATE);
  now = 2000;
  assert.ok(chat.append(sender(), 'refilled').message);
  const room = new MatchChat({ now: () => now });
  for (let n = 0; n < 20; n++) assert.ok(room.append(sender(`p_${n}`, n), 'simultaneous').message);
  assert.equal(room.append({ playerId: 'spectator', name: '观战', seat: null, spectator: true }, 'over total').error, ERR.RATE);
  now += 100;
  assert.ok(room.append({ playerId: 'spectator', name: '观战', seat: null, spectator: true }, 'refilled total').message);
});

test('history is bounded but sequence remains monotonic, invalid messages do not consume the budget', () => {
  let now = 0;
  const chat = new MatchChat({ now: () => now, historyLimit: 2 });
  assert.equal(chat.append(sender(), ' ').error, ERR.BAD_MSG);
  for (let n = 0; n < 5; n++) {
    const result = chat.append(sender(), `${n}`);
    assert.equal(result.message.seq, n + 1);
    now += 2000;
  }
  assert.deepEqual(chat.snapshot().messages.map((m) => m.text), ['3', '4']);
  assert.equal(chat.snapshot().seq, 5);
  for (const historyLimit of [0, -1, 201, Infinity, 1.1]) assert.throws(() => new MatchChat({ historyLimit }), RangeError);
});

test('clear releases history and rate maps permanently; permanent departure can release its sender budget', () => {
  const chat = new MatchChat({ now: () => 10 });
  chat.append(sender(), 'secret match body');
  assert.equal(chat.players.size, 1);
  chat.forgetPlayer('p_a');
  assert.equal(chat.players.size, 0);
  chat.clear();
  chat.clear();
  assert.equal(chat.messages.length, 0);
  assert.equal(chat.players.size, 0);
  assert.equal(chat.snapshot(), null);
  assert.equal(chat.append(sender(), 'after end').error, ERR.WRONG_PHASE);
  assert.equal(new MatchChat({ now: () => 10 }).snapshot().messages.length, 0);
});
