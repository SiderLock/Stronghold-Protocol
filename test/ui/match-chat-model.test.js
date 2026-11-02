// RAM-only match chat: protocol ordering, match lifecycle and acknowledgement races without a browser/server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore, emptyMatch } from '../../public/js/store.js';
import { PHASE } from '../../shared/constants.js';
import { createMatchChatModel, emptyMatchChat, installMatchChat, selectChatUnread } from '../../public/js/matchChat.js';

const activeRoom = (matchId = 'chat_one') => ({ code: 'ABCDEF', inMatch: true, chatMatchId: matchId });
const entry = (seq, patch = {}) => ({
  seq, playerId: 'p1', name: '龙千尘', seat: 0, spectator: false, text: `消息 ${seq}`, at: 1000 + seq, ...patch,
});
const push = (seq, patch = {}) => ({ t: 'm.chat', matchId: 'chat_one', ...entry(seq, patch) });
const history = (seq, messages, matchId = 'chat_one') => ({ t: 'm.chatState', matchId, seq, messages });
const seqs = (model) => model.target.get().messages.map((message) => message.seq);

function readyModel(opts) {
  const model = createMatchChatModel(opts);
  model.syncRoom(activeRoom());
  return model;
}

function fakeNet() {
  const listeners = new Map();
  const calls = [];
  return {
    status: 'online', calls,
    on(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener);
      return () => listeners.get(type).delete(listener);
    },
    emit(type, message) { for (const listener of listeners.get(type) || []) listener(message); },
    listenerCount: () => [...listeners.values()].reduce((count, set) => count + set.size, 0),
    request(type, payload) { return new Promise((resolve, reject) => calls.push({ type, payload, resolve, reject })); },
  };
}

function connected(t) {
  const net = fakeNet();
  const appStore = createStore({ me: { playerId: 'p1' }, room: activeRoom(), match: emptyMatch(), connection: { status: 'online' } });
  const model = createMatchChatModel();
  const dispose = installMatchChat({ net, appStore, model });
  t.after(dispose);
  return { net, appStore, model, dispose };
}

test('empty chat arrays are independent and invalid history limits fail explicitly', () => {
  const first = emptyMatchChat();
  const second = emptyMatchChat();
  first.messages.push(entry(1));
  assert.deepEqual(second, { matchId: null, messages: [], seq: 0, open: false, lastReadSeq: 0, draft: '' });
  for (const historyLimit of [0, -1, 201, 1.5, NaN]) assert.throws(() => createMatchChatModel({ historyLimit }), RangeError);
});

test('room scope changes and end clear messages, drafts, unread state and the open panel', () => {
  const model = readyModel();
  model.receive(push(1));
  model.setDraft('还没有发送');
  model.setOpen(true);
  model.markRead(1);
  model.syncRoom({ ...activeRoom() });
  assert.equal(model.target.get().draft, '还没有发送', 'same match room snapshots preserve UI state');
  model.syncRoom(activeRoom('chat_two'));
  assert.deepEqual(model.target.get(), { ...emptyMatchChat(), matchId: 'chat_two' });
  assert.equal(model.receive(push(2)), false, 'a late old-match frame cannot repopulate the new match');
  model.syncRoom({ code: 'ABCDEF', inMatch: false, chatMatchId: null });
  model.setDraft('outside');
  model.setOpen(true);
  assert.deepEqual(model.target.get(), emptyMatchChat());
});

test('late snapshots fill gaps without erasing newer pushes or regressing the sequence', () => {
  const model = readyModel();
  model.receive(push(5));
  model.receiveState(history(4, [entry(2), entry(3), entry(4)]));
  assert.deepEqual(seqs(model), [2, 3, 4, 5]);
  assert.equal(model.target.get().seq, 5);
  model.receiveState(history(1, [entry(1)]));
  assert.deepEqual(seqs(model), [1, 2, 3, 4, 5]);
  assert.equal(model.target.get().seq, 5);
  model.receiveState(history(0, []));
  assert.deepEqual(seqs(model), [1, 2, 3, 4, 5], 'an old empty start snapshot cannot clear chat');
});

test('seq deduplication and bounded newest history resist overlapping resyncs', () => {
  const model = readyModel({ historyLimit: 3 });
  for (let seq = 1; seq <= 5; seq++) model.receive(push(seq));
  model.receive(push(5, { text: '重复帧不能修改消息' }));
  model.receiveState(history(3, [entry(1), entry(2), entry(3)]));
  assert.deepEqual(seqs(model), [3, 4, 5]);
  assert.equal(model.target.get().messages.at(-1).text, '消息 5');
  assert.equal(selectChatUnread(model.target.get()), 3);
  model.markRead(4);
  assert.equal(selectChatUnread(model.target.get()), 1);
  model.markRead(2);
  assert.equal(model.target.get().lastReadSeq, 4, 'reading an old viewport never restores already-read badges');
  model.markRead(999);
  assert.equal(model.target.get().lastReadSeq, 5, 'read positions are bounded by known server sequence');
});

test('foreign match frames, malformed rows and transport fields cannot contaminate history', () => {
  const model = readyModel();
  assert.equal(model.receive({ ...push(1), matchId: 'foreign' }), false);
  assert.equal(model.receiveState(history(1, [entry(1)], 'foreign')), false);
  for (const patch of [{ seq: 0 }, { seq: 1.5 }, { text: '' }, { text: 'x'.repeat(201) }, { text: '\ud800' },
    { seat: 20 }, { seat: null }, { spectator: true }, { at: NaN }, { playerId: '' }, { name: '' }]) {
    assert.equal(model.receive(push(1, patch)), false);
  }
  const raw = push(1, { rid: 'transport', incidental: { value: 'do not retain' } });
  assert.equal(model.receive(raw), true);
  raw.text = 'changed foreign object';
  assert.equal(model.target.get().messages[0].text, '消息 1');
  assert.deepEqual(Object.keys(model.target.get().messages[0]), ['seq', 'playerId', 'name', 'seat', 'spectator', 'text', 'at']);
  assert.equal(model.receive(push(2, { spectator: true, seat: null })), true, 'spectators have no combat seat');
});

test('sending normalizes Unicode, uses the current match id and waits for the authoritative push', async () => {
  const model = readyModel();
  const net = fakeNet();
  model.setDraft(' e\u0301\n😀 ');
  const sent = model.send(model.target.get().draft, net);
  assert.deepEqual(net.calls[0].payload, { matchId: 'chat_one', text: 'é\n😀' });
  assert.equal(net.calls[0].type, 'room.chat');
  assert.deepEqual(model.target.get().messages, []);
  net.calls[0].resolve({ t: 'ok' });
  assert.equal(await sent, true);
  assert.equal(model.target.get().draft, '');
  assert.deepEqual(model.target.get().messages, [], 'acknowledgement never adds an optimistic duplicate');
  model.receive(push(1, { text: 'é\n😀' }));
  assert.equal(model.target.get().messages.length, 1);
});

test('failed sends preserve the draft; errors never include its content', async () => {
  const model = readyModel();
  const net = fakeNet();
  const draft = '失败也应该保留的草稿';
  model.setDraft(draft);
  const sent = model.send(draft, net);
  const error = Object.assign(new Error('RATE'), { code: 'RATE' });
  net.calls[0].reject(error);
  await assert.rejects(sent, (received) => received === error);
  assert.equal(model.target.get().draft, draft);
  net.status = 'reconnecting';
  await assert.rejects(model.send(draft, net), (received) => received.code === 'OFFLINE' && !received.message.includes(draft));
  net.status = 'online';
  await assert.rejects(model.send('x'.repeat(201), net), (received) => received.code === 'BAD_MSG');
  model.reset();
  await assert.rejects(model.send(draft, net), (received) => received.code === 'WRONG_PHASE');
  assert.equal(net.calls.length, 1, 'offline, invalid and ended sends never queue a request');
});

test('pending send acknowledgements cannot delete edited or next-match drafts', async () => {
  const model = readyModel();
  const net = fakeNet();
  model.setDraft('first');
  const first = model.send('first', net);
  model.setDraft('second');
  net.calls[0].resolve({ t: 'ok' });
  assert.equal(await first, true);
  assert.equal(model.target.get().draft, 'second');
  const second = model.send('second', net);
  model.syncRoom(activeRoom('chat_two'));
  model.setDraft('next match');
  net.calls[1].resolve({ t: 'ok' });
  assert.equal(await second, false);
  assert.equal(model.target.get().draft, 'next match');
  assert.deepEqual(model.target.get().messages, []);
});

test('installer keeps chat through disconnect and accepts one reconnect snapshot without requesting history', (t) => {
  const { net, appStore, model } = connected(t);
  net.emit('m.chat', push(2));
  model.setDraft('临时断网');
  model.setOpen(true);
  net.status = 'reconnecting';
  appStore.patch('connection', { status: 'reconnecting' });
  net.emit('status', { status: 'reconnecting' });
  assert.deepEqual(seqs(model), [2]);
  assert.equal(model.target.get().draft, '临时断网');
  assert.equal(model.target.get().open, true);
  net.status = 'online';
  appStore.patch('connection', { status: 'online' });
  appStore.set({ room: { ...activeRoom() } });
  net.emit('m.chatState', history(3, [entry(1), entry(2), entry(3)]));
  assert.deepEqual(seqs(model), [1, 2, 3]);
  assert.deepEqual(net.calls, [], 'main hello/resync owns the single bounded snapshot; no repeated client request');
});

test('installer clears on result, room exit, identity reset and close, and ignores old-match pushes', (t) => {
  const { net, appStore, model } = connected(t);
  net.emit('m.chat', push(1));
  appStore.patch('match', { public: { phase: PHASE.RESULT } });
  assert.deepEqual(model.target.get(), emptyMatchChat());
  net.emit('m.chat', push(2));
  assert.deepEqual(model.target.get(), emptyMatchChat());
  appStore.set({ room: { inMatch: false, chatMatchId: null }, match: emptyMatch() });
  appStore.set({ room: activeRoom() });
  net.emit('m.chat', push(3));
  appStore.patch('match', { result: { id: 'result' } });
  assert.deepEqual(model.target.get(), emptyMatchChat());
  appStore.set({ room: null, match: emptyMatch() });
  net.emit('m.chatState', history(3, [entry(3)]));
  assert.deepEqual(model.target.get(), emptyMatchChat());
  appStore.set({ room: activeRoom() });
  net.emit('m.chat', push(4));
  appStore.set({ me: { playerId: 'new_identity' } });
  assert.deepEqual(model.target.get(), emptyMatchChat());
  appStore.patch('match', { public: { phase: PHASE.PREP } });
  net.emit('m.chat', push(5));
  assert.deepEqual(model.target.get(), emptyMatchChat(), 'a stale match update during welcome cannot re-adopt the old identity room');
  appStore.set({ room: activeRoom('chat_new') });
  net.emit('m.chat', { ...push(1), matchId: 'chat_new' });
  assert.deepEqual(seqs(model), [1]);
  net.emit('room.closed', {});
  assert.deepEqual(model.target.get(), emptyMatchChat());
});

test('all active phases retain one conversation and disposal removes listeners and releases RAM', (t) => {
  const { net, appStore, model, dispose } = connected(t);
  for (const phase of [PHASE.INFO_CHECK, PHASE.BAND_DRAFT, PHASE.PREP, PHASE.SP_DRAFT, PHASE.COMBAT]) {
    appStore.patch('match', { public: { phase } });
    assert.equal(model.target.get().matchId, 'chat_one');
  }
  net.emit('m.chat', push(1));
  model.setDraft('清理');
  model.setOpen(true);
  assert.equal(net.listenerCount(), 4);
  dispose();
  dispose();
  assert.equal(net.listenerCount(), 0);
  assert.deepEqual(model.target.get(), emptyMatchChat());
  appStore.set({ room: activeRoom('after_dispose') });
  net.emit('m.chat', push(1));
  assert.deepEqual(model.target.get(), emptyMatchChat());
});
