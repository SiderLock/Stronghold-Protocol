// Lobby directory lifecycle and reply ordering; no server, browser or match simulation is required.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLobbyDiscovery, emptyLobbyDiscovery } from '../../public/js/lobbyDiscovery.js';

const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
const state = (patch = {}) => ({
  t: 'lobby.state', online: 24, roomCount: 4, matchCount: 1, playingCount: 7, joinableCount: 2, ...patch,
});
const room = (code) => ({ roomId: `id-${code}`, code, mode: 'coop', capacity: 8, used: 3, status: 'waiting' });
const directory = (page, code, patch = {}) => state({ page, totalPages: 3, pageSize: 50, rooms: [room(code)], ...patch });

function fakeNet(status = 'online') {
  const listeners = new Map();
  const calls = [];
  const net = {
    status, calls,
    on(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener);
      return () => listeners.get(type).delete(listener);
    },
    emit(type, message) { for (const listener of listeners.get(type) || []) listener(message); },
    setStatus(next) { net.status = next; net.emit('status', { status: next }); },
    listenerCount() { return [...listeners.values()].reduce((n, set) => n + set.size, 0); },
    request(type, payload) {
      return new Promise((resolve, reject) => calls.push({ type, payload, resolve, reject }));
    },
    reply(index, message) { calls[index].resolve(message); },
  };
  return net;
}

function fixture(t, status = 'online') {
  const net = fakeNet(status);
  const controller = createLobbyDiscovery({ net });
  t.after(async () => { controller.dispose(); await flush(); });
  return { net, controller, target: controller.target };
}

async function started(t) {
  const f = fixture(t);
  f.controller.start();
  await flush();
  f.net.reply(0, state({ rid: 'summary' }));
  await flush();
  return f;
}

test('empty directory states have independent lists and unknown counts until a reply arrives', () => {
  const first = emptyLobbyDiscovery();
  const second = emptyLobbyDiscovery();
  first.rooms.push(room('ABCDEF'));
  assert.deepEqual(second.rooms, []);
  for (const key of ['online', 'roomCount', 'matchCount', 'playingCount', 'joinableCount']) assert.equal(second[key], null);
  assert.equal(second.ready, false);
  assert.equal(second.open, false);
});

test('lobby mount subscribes to summary only; repeated mount and welcome do not request lists', async (t) => {
  const f = fixture(t);
  f.controller.start();
  f.controller.start();
  f.net.emit('welcome', {});
  await flush();
  assert.equal(f.net.calls.length, 1);
  assert.equal(f.net.calls[0].type, 'lobby.watch');
  assert.deepEqual(f.net.calls[0].payload, { on: true, list: false, page: 0 });
  f.net.reply(0, directory(0, 'ABCDEF', { rid: 'summary' }));
  await flush();
  assert.equal(f.target.get().online, 24);
  assert.equal(f.target.get().ready, true);
  assert.equal(f.target.get().loading, false);
  assert.deepEqual(f.target.get().rooms, [], 'the closed browser does not retain directory rows');
});

test('opening and changing pages requests only each distinct view', async (t) => {
  const f = await started(t);
  f.controller.show();
  f.controller.show();
  await flush();
  assert.equal(f.net.calls.length, 2);
  assert.deepEqual(f.net.calls[1].payload, { on: true, list: true, page: 0 });
  assert.equal(f.target.get().open, true);
  f.net.reply(1, directory(0, 'ABCDEF'));
  await flush();
  f.controller.show();
  await flush();
  assert.equal(f.net.calls.length, 2);
  assert.deepEqual(f.target.get().rooms, [room('ABCDEF')], 'opening an already visible first page preserves its loaded rows');
  f.controller.page(1);
  f.controller.page(1);
  await flush();
  assert.equal(f.net.calls.length, 3);
  assert.deepEqual(f.net.calls[2].payload, { on: true, list: true, page: 1 });
  assert.deepEqual(f.target.get().rooms, [], 'old rows disappear while a new page loads');
});

test('rid replies update through request resolution, while the push listener ignores them', async (t) => {
  const f = await started(t);
  f.controller.show();
  await flush();
  const reply = directory(0, 'R12345', { rid: 'request-1', online: 31 });
  f.net.emit('lobby.state', reply);
  assert.equal(f.target.get().online, 24, 'correlated replies are not applied without their request guard');
  assert.deepEqual(f.target.get().rooms, []);
  f.net.reply(1, reply);
  await flush();
  assert.equal(f.target.get().online, 31);
  assert.deepEqual(f.target.get().rooms, [room('R12345')]);
  assert.equal(f.target.get().loading, false);
});

test('uncorrelated pushes update counts and the current directory page', async (t) => {
  const f = await started(t);
  f.controller.show();
  await flush();
  f.net.reply(1, directory(0, 'BEFORE'));
  await flush();
  f.net.emit('lobby.state', directory(0, 'AFTER1', { online: 25, roomCount: 5 }));
  assert.equal(f.target.get().online, 25);
  assert.equal(f.target.get().roomCount, 5);
  assert.deepEqual(f.target.get().rooms, [room('AFTER1')]);
});

test('late page replies cannot replace the new page or its counts', async (t) => {
  const f = await started(t);
  f.controller.show();
  await flush();
  f.controller.page(1);
  await flush();
  f.net.reply(2, directory(1, 'LATEST', { rid: 'new', online: 35 }));
  await flush();
  const latest = f.target.get();
  f.net.reply(1, directory(0, 'OLD001', { rid: 'old', online: 99 }));
  await flush();
  assert.deepEqual(f.target.get(), latest);
  f.net.emit('lobby.state', directory(0, 'OLD001', { online: 36 }));
  assert.equal(f.target.get().online, 36, 'an uncorrelated old-page push still has a useful summary');
  assert.equal(f.target.get().page, 1);
  assert.deepEqual(f.target.get().rooms, [room('LATEST')]);
});

test('closing the browser switches to summary and discards in-flight directory replies', async (t) => {
  const f = await started(t);
  f.controller.show();
  await flush();
  f.controller.close();
  await flush();
  assert.deepEqual(f.net.calls[2].payload, { on: true, list: false, page: 0 });
  f.net.reply(2, state({ online: 28 }));
  await flush();
  const closed = f.target.get();
  f.net.reply(1, directory(0, 'CLOSED', { rid: 'late', online: 100 }));
  await flush();
  assert.deepEqual(f.target.get(), closed);
  assert.equal(f.target.get().open, false);
  assert.deepEqual(f.target.get().rooms, []);
  const before = f.net.calls.length;
  f.controller.page(2);
  await flush();
  assert.equal(f.net.calls.length, before, 'a closed browser cannot subscribe to another page');
});

test('disconnect clears old counts and rows; reconnect restores exactly one current-page watch', async (t) => {
  const f = await started(t);
  f.controller.show();
  await flush();
  f.controller.page(2);
  await flush();
  f.net.reply(2, directory(2, 'PAGE02'));
  await flush();
  f.net.setStatus('reconnecting');
  assert.equal(f.target.get().ready, false);
  assert.equal(f.target.get().open, true);
  assert.equal(f.target.get().page, 2);
  assert.equal(f.target.get().online, null);
  assert.equal(f.target.get().roomCount, null);
  assert.equal(f.target.get().playingCount, null);
  assert.deepEqual(f.target.get().rooms, []);
  f.net.reply(1, directory(0, 'STALE1', { online: 99 }));
  f.net.emit('lobby.state', state({ online: 100 }));
  await flush();
  assert.equal(f.target.get().online, null);
  f.net.setStatus('online');
  f.net.emit('welcome', {});
  await flush();
  assert.equal(f.net.calls.length, 4);
  assert.deepEqual(f.net.calls[3].payload, { on: true, list: true, page: 2 });
  f.net.reply(3, directory(2, 'FRESH2', { online: 30 }));
  await flush();
  assert.equal(f.target.get().online, 30);
  assert.equal(f.target.get().playingCount, 7);
  assert.deepEqual(f.target.get().rooms, [room('FRESH2')]);
});

test('playing count accepts nonnegative integers, ignores malformed updates, and survives old-page pushes', async (t) => {
  const f = await started(t);
  assert.equal(f.target.get().playingCount, 7);
  for (const playingCount of [-1, 1.5, '4', null, undefined]) {
    f.net.emit('lobby.state', state({ playingCount }));
    assert.equal(f.target.get().playingCount, 7);
  }
  f.net.emit('lobby.state', state({ playingCount: 0 }));
  assert.equal(f.target.get().playingCount, 0);
  f.controller.show();
  await flush();
  f.controller.page(1);
  await flush();
  f.net.reply(2, directory(1, 'CURRENT', { playingCount: 20 }));
  await flush();
  f.net.reply(1, directory(0, 'LATE00', { playingCount: 99 }));
  await flush();
  assert.equal(f.target.get().playingCount, 20);
  f.net.emit('lobby.state', directory(0, 'OLD001', { playingCount: 21 }));
  assert.equal(f.target.get().playingCount, 21);
  assert.equal(f.target.get().page, 1);
  assert.deepEqual(f.target.get().rooms, [room('CURRENT')]);
});

test('offline mount waits for online status rather than requesting an unavailable directory', async (t) => {
  const f = fixture(t, 'connected');
  f.controller.start();
  f.controller.show();
  await flush();
  assert.deepEqual(f.net.calls, []);
  f.net.setStatus('online');
  await flush();
  assert.equal(f.net.calls.length, 1);
  assert.deepEqual(f.net.calls[0].payload, { on: true, list: true, page: 0 });
});

test('dispose removes all listeners, sends one unwatch and ignores queued replies', async (t) => {
  const f = fixture(t);
  f.controller.start();
  await flush();
  assert.equal(f.net.listenerCount(), 3);
  f.controller.dispose();
  f.controller.dispose();
  await flush();
  assert.equal(f.net.listenerCount(), 0);
  assert.equal(f.net.calls.length, 2);
  assert.deepEqual(f.net.calls[1].payload, { on: false });
  const disposed = f.target.get();
  f.net.reply(0, state({ online: 999 }));
  f.net.emit('lobby.state', state({ online: 998 }));
  f.net.setStatus('online');
  f.net.emit('welcome', {});
  await flush();
  assert.deepEqual(f.target.get(), disposed);
  assert.equal(f.net.calls.length, 2);
});

test('force refresh of an unchanged view finishes on an ok acknowledgement without removing rows', async (t) => {
  const f = await started(t);
  f.controller.show();
  await flush();
  f.net.reply(1, directory(0, 'KEEP01'));
  await flush();
  f.controller.refresh();
  assert.equal(f.target.get().loading, true);
  await flush();
  assert.deepEqual(f.net.calls[2].payload, { on: true, list: true, page: 0 });
  f.net.reply(2, { t: 'ok', rid: 'refresh' });
  await flush();
  assert.equal(f.target.get().loading, false);
  assert.equal(f.target.get().error, false);
  assert.deepEqual(f.target.get().rooms, [room('KEEP01')]);
});

test('directory shrink accepts the server-clamped last page and refresh uses that page', async (t) => {
  const f = await started(t);
  f.controller.show();
  await flush();
  f.net.reply(1, directory(0, 'FIRST0'));
  await flush();
  f.controller.page(2);
  await flush();
  f.net.reply(2, directory(2, 'LAST02'));
  await flush();
  f.net.emit('lobby.state', directory(0, 'ONLY00', { totalPages: 1, roomCount: 1 }));
  assert.equal(f.target.get().page, 0);
  assert.equal(f.target.get().totalPages, 1);
  assert.deepEqual(f.target.get().rooms, [room('ONLY00')]);
  const before = f.net.calls.length;
  f.controller.page(0);
  await flush();
  assert.equal(f.net.calls.length, before, 'the accepted page is now the current view');
  f.controller.refresh();
  await flush();
  assert.deepEqual(f.net.calls.at(-1).payload, { on: true, list: true, page: 0 });
});

test('failed watch exposes an error and explicit refresh can retry the same view', async (t) => {
  const f = fixture(t);
  f.controller.start();
  await flush();
  f.net.calls[0].reject(new Error('unavailable'));
  await flush();
  assert.equal(f.target.get().loading, false);
  assert.equal(f.target.get().error, true);
  f.controller.refresh();
  await flush();
  assert.equal(f.net.calls.length, 2);
  f.net.reply(1, state({ online: 12 }));
  await flush();
  assert.equal(f.target.get().error, false);
  assert.equal(f.target.get().online, 12);
});
