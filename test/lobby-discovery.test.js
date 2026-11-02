import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../server/index.js';
import { StubMatch } from '../server/match/StubMatch.js';
import { TestClient } from './helpers/wsClient.js';
import { ERR, ROOM_CAPACITIES } from '../shared/constants.js';
import { validateC2S } from '../shared/protocol.js';
import { LobbyDiscovery, compareRoomSummaries, roomSummary } from '../server/lobbyDiscovery.js';
import { Lobby, Room } from '../server/lobby.js';
import { SessionRegistry } from '../server/net.js';
import { LOBBY_PAGE_SIZE, LOBBY_UPDATE_MS } from '../shared/lobbyDiscovery.js';

/** Direct lobby harness: real seats and registry, controllable directory timer, no sockets/servers. */
function harness(t, chooseIndex = () => 0) {
  let at = 0;
  let nextTimer = 0;
  const pending = new Map();
  const timers = {
    setTimeout(fn, ms) { const id = ++nextTimer; pending.set(id, { fn, ms }); return id; },
    clearTimeout(id) { pending.delete(id); },
  };
  const registry = new SessionRegistry();
  const lobby = new Lobby({ registry, now: () => ++at, getData: () => ({}) });
  lobby.discovery.close();
  lobby.discovery = new LobbyDiscovery(lobby, { timers, chooseIndex });
  t.after(() => lobby.shutdown());
  const player = (name, connected = true) => {
    const session = registry.create(name);
    session.connected = connected;
    session.frames = [];
    session.ws = { readyState: 1, bufferedAmount: 0, send(frame) { session.frames.push(JSON.parse(frame)); } };
    lobby.onHello(session, { resumed: false, repeat: false });
    return session;
  };
  const room = (host, capacity = 4, mode = 'coop') => {
    assert.deepEqual(lobby.create(host, { mode, difficulty: 'NORMAL', capacity }), { ok: true });
    return lobby.getRoom(host.roomCode);
  };
  const flush = () => {
    const work = [...pending.values()];
    pending.clear();
    for (const { fn, ms } of work) { assert.equal(ms, LOBBY_UPDATE_MS); fn(); }
  };
  return { lobby, registry, player, room, pending, flush };
}

test('lobby discovery messages validate shared capacities and bounded pages', () => {
  assert.equal(validateC2S({ t: 'lobby.watch', on: true }), null);
  assert.equal(validateC2S({ t: 'lobby.watch', on: true, list: true, page: 0 }), null);
  assert.equal(validateC2S({ t: 'lobby.watch', on: false }), null);
  for (const capacity of ROOM_CAPACITIES) assert.equal(validateC2S({ t: 'lobby.quickMatch', capacity }), null);
  assert.equal(validateC2S({ t: 'lobby.quickMatch' }), null);
  assert.notEqual(validateC2S({ t: 'lobby.watch', on: true, page: -1 }), null);
  assert.notEqual(validateC2S({ t: 'lobby.quickMatch', capacity: 6 }), null);
  assert.equal(LOBBY_PAGE_SIZE, 50);
});

test('directory reports unique connected players and sends unchanged views only once', async () => {
  const clients = [];
  const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, MatchClass: StubMatch });
  try {
    const player = async (name) => {
      const c = await TestClient.connect(`ws://127.0.0.1:${srv.port}/ws`);
      clients.push(c);
      c.welcome = await c.hello(name);
      return c;
    };
    const watcher = await player('Watcher');
    const host = await player('Host');
    const first = await watcher.request({ t: 'lobby.watch', on: true, list: true });
    assert.equal(first.t, 'lobby.state');
    const duplicate = await watcher.request({ t: 'lobby.watch', on: true, list: true });
    assert.equal(duplicate.t, 'ok', 'same view is acknowledged without replaying the state');
    assert.equal(first.online, 2);
    assert.equal(first.roomCount, 0);
    assert.equal(first.rooms.length, 0);
    await host.request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL', capacity: 8 });
    const changed = await watcher.waitFor('lobby.state', (state) => state.roomCount === 1, 3500);
    assert.equal(changed.online, 2);
    assert.equal(changed.rooms[0].capacity, 8);
    assert.equal(changed.rooms[0].joinable, true);
    assert.equal(changed.rooms[0].hostOnline, true);
    await watcher.expectNone('lobby.state', () => true, 2200);
  } finally {
    await Promise.all(clients.map((c) => c.terminate()));
    await srv.close();
  }
});

test('statistics count unique connected sessions, omit private data and coalesce unchanged pushes', (t) => {
  const { lobby, player, room, pending, flush } = harness(t);
  const host = player('Host');
  const watcher = player('Watcher');
  player('Disconnected', false);
  const waiting = room(host);
  lobby.addBot(host);
  lobby.discovery.watch(watcher, { on: true });
  const initial = watcher.frames.at(-1);
  assert.deepEqual(initial, { t: 'lobby.state', online: 2, roomCount: 1, matchCount: 0, playingCount: 0, joinableCount: 1, requireAssetCache: false });
  assert.equal(Object.hasOwn(initial, 'rooms'), false, 'closed directory receives counts only');
  lobby.discovery.watch(watcher, { on: true });
  assert.equal(watcher.frames.length, 1, 'same subscription produces no repeated payload');
  lobby.onHello(watcher, { resumed: false, repeat: true });
  lobby.broadcastState(waiting);
  assert.equal(pending.size, 1, 'presence and seat events share one merge timer');
  flush();
  assert.equal(watcher.frames.length, 1, 'unchanged public counts are suppressed');
  player('New arrival');
  flush();
  assert.equal(watcher.frames.at(-1).online, 3);
  assert.equal(watcher.frames.length, 2);
});

test('paged directory clamps pages and contains only the declared public summary fields', (t) => {
  const { lobby, player } = harness(t);
  for (let i = 0; i < 115; i++) {
    const code = `R${String.fromCharCode(65 + Math.floor(i / 26))}${String.fromCharCode(65 + i % 26)}A`;
    const r = new Room(code, 'coop', 'NORMAL', i, 4);
    const host = player(`Host ${i}`);
    r.hostId = host.playerId;
    r.seats[0] = lobby.humanSeat(0, host);
    host.roomCode = code;
    lobby.rooms.set(code, r);
  }
  const watcher = player('Watcher');
  lobby.discovery.watch(watcher, { on: true, list: true, page: 0 });
  const first = watcher.frames.at(-1);
  assert.equal(first.rooms.length, 50);
  assert.equal(first.roomCount, 115);
  assert.equal(first.totalPages, 3);
  assert.deepEqual(Object.keys(first.rooms[0]), [
    'code', 'roomId', 'allowMatchmaking', 'mode', 'difficulty', 'capacity', 'playerCount', 'humanCount', 'botCount',
    'inMatch', 'joinable', 'spectatorCount', 'spectatable', 'hostOnline', 'disconnectedRetained', 'createdAt',
  ]);
  lobby.discovery.watch(watcher, { on: true, list: true, page: 1 });
  const middle = watcher.frames.at(-1);
  assert.equal(middle.rooms.length, 50);
  assert.equal(middle.rooms[0].createdAt, 50);
  lobby.discovery.watch(watcher, { on: true, list: true, page: 999 });
  const last = watcher.frames.at(-1);
  assert.equal(last.page, 2);
  assert.equal(lobby.discovery.watchers.get(watcher.playerId).page, 2);
  assert.equal(last.rooms.length, 15);
  assert.equal(last.rooms[0].createdAt, 100);
  assert.equal(new Set([...first.rooms, ...middle.rooms, ...last.rooms].map((r) => r.code)).size, 115);
});

test('clamped subscriptions stay on the acknowledged page when rooms shrink then grow again', (t) => {
  const { lobby, player, room, flush } = harness(t);
  const rooms = [];
  for (let i = 0; i < 51; i++) rooms.push(room(player(`Host ${i}`)));
  const watchers = [player('Watcher A'), player('Watcher B')];
  for (const watcher of watchers) {
    lobby.discovery.watch(watcher, { on: true, list: true, page: 1 });
    assert.equal(watcher.frames.at(-1).page, 1);
    assert.equal(watcher.frames.at(-1).rooms.length, 1);
  }
  lobby.disposeRoom(rooms[0], 'empty');
  flush();
  for (const watcher of watchers) {
    const state = watcher.frames.at(-1);
    assert.equal(state.page, 0);
    assert.equal(state.roomCount, 50);
    assert.equal(state.rooms.length, 50);
    assert.equal(lobby.discovery.watchers.get(watcher.playerId).page, 0, 'every cached-view subscriber normalizes');
  }
  const added = room(player('New host'));
  flush();
  for (const watcher of watchers) {
    const state = watcher.frames.at(-1);
    assert.equal(state.page, 0, 'a new last page must not silently restore an obsolete requested page');
    assert.equal(state.roomCount, 51);
    assert.equal(state.totalPages, 2);
    assert.deepEqual(state.rooms.map((r) => r.code), rooms.slice(1).map((r) => r.code));
    assert.ok(!state.rooms.some((r) => r.code === added.code), 'new room is correctly on the unselected last page');
  }
});

test('subscriptions are released on joins, creation, spectating, disconnect and shutdown', (t) => {
  const { lobby, player, room, pending } = harness(t);
  const host = player('Host');
  const target = room(host, 8);
  const subscribe = (name) => {
    const session = player(name);
    lobby.discovery.watch(session, { on: true, list: true });
    assert.ok(lobby.discovery.watchers.has(session.playerId));
    return session;
  };
  const joiner = subscribe('Joiner');
  lobby.join(joiner, { code: target.code });
  assert.equal(lobby.discovery.watchers.has(joiner.playerId), false);
  const creator = subscribe('Creator');
  room(creator);
  assert.equal(lobby.discovery.watchers.has(creator.playerId), false);
  const spectator = subscribe('Spectator');
  lobby.spectate(spectator, { code: target.code });
  assert.equal(lobby.discovery.watchers.has(spectator.playerId), false);
  const disconnected = subscribe('Disconnect');
  disconnected.connected = false;
  lobby.onDisconnect(disconnected);
  assert.equal(lobby.discovery.watchers.has(disconnected.playerId), false);
  assert.equal(pending.size, 0);
  const last = subscribe('Last');
  lobby.discovery.changed();
  assert.equal(pending.size, 1);
  lobby.discovery.watch(last, { on: false });
  assert.equal(pending.size, 0, 'last unsubscribe stops the pending timer');
  lobby.discovery.watch(last, { on: true });
  lobby.discovery.changed();
  lobby.shutdown();
  assert.equal(lobby.discovery.watchers.size, 0);
  assert.equal(pending.size, 0);
});

test('capacity preference wins before vacancy ranking, then ties use the injected random choice', (t) => {
  let tieSize = 0;
  const { lobby, player, room } = harness(t, (size) => { tieSize = size; return size - 1; });
  const first = room(player('First'), 4);
  const second = room(player('Second'), 4);
  const preferred = room(player('Preferred'), 20);
  const a = player('A');
  assert.deepEqual(lobby.discovery.quickMatch(a, { capacity: 20 }), { ok: true });
  assert.equal(a.roomCode, preferred.code, 'capacity preference takes priority over fastest vacancy count');
  const b = player('B');
  assert.deepEqual(lobby.discovery.quickMatch(b, { capacity: 16 }), { ok: true });
  assert.equal(b.roomCode, second.code);
  assert.notEqual(b.roomCode, first.code);
  assert.equal(tieSize, 2, 'equal vacancy candidates are randomized together');
});

test('AI and disconnected humans occupy seats; solo, full and running rooms never enter quick matching', (t) => {
  const { lobby, player, room } = harness(t);
  const host = player('Host');
  const target = room(host, 4);
  const offline = player('Offline guest');
  lobby.join(offline, { code: target.code });
  offline.connected = false;
  lobby.onDisconnect(offline);
  lobby.addBot(host);
  const solo = room(player('Solo'), 4, 'solo');
  const fullHost = player('Full');
  const full = room(fullHost);
  for (let i = 0; i < 3; i++) lobby.addBot(fullHost);
  const playing = room(player('Playing'));
  playing.match = {};
  const joiner = player('Joiner');
  assert.deepEqual(lobby.discovery.quickMatch(joiner), { ok: true });
  assert.equal(joiner.roomCode, target.code);
  assert.equal(target.seats[1].playerId, offline.playerId);
  assert.equal(target.seats[2].isBot, true);
  const another = player('Another');
  assert.equal(lobby.discovery.quickMatch(another).error, ERR.ROOM_NOT_FOUND);
  assert.ok([solo, full, playing].every((r) => r.code !== another.roomCode));
});

test('offline host status is displayed without altering vacancy-based quick matching', (t) => {
  const { lobby, player, room } = harness(t);
  const host = player('Host');
  const target = room(host);
  lobby.addBot(host);
  lobby.addBot(host);
  const active = room(player('Active host'));
  host.connected = false;
  lobby.onDisconnect(host);
  const watcher = player('Watcher');
  lobby.discovery.watch(watcher, { on: true, list: true });
  const rows = watcher.frames.at(-1).rooms;
  assert.deepEqual(rows.map((row) => row.code), [active.code, target.code], 'retained room is listed last');
  assert.equal(rows[1].hostOnline, false);
  assert.equal(rows[1].disconnectedRetained, true);
  assert.equal(rows[1].joinable, true);
  assert.deepEqual(lobby.discovery.quickMatch(watcher), { ok: true });
  assert.equal(watcher.roomCode, target.code, 'fewest vacancies still wins despite directory placement');
});

test('disconnected retention considers only present human seats, not bots or spectators', (t) => {
  const { lobby, player, room } = harness(t);
  const host = player('Host');
  const target = room(host, 8);
  const guest = player('Guest');
  assert.deepEqual(lobby.join(guest, { code: target.code }), { ok: true });
  assert.deepEqual(lobby.addBot(host), { ok: true });
  const spectator = player('Spectator');
  assert.deepEqual(lobby.spectate(spectator, { code: target.code }), { ok: true });
  host.connected = false;
  lobby.onDisconnect(host);
  assert.equal(roomSummary(target).hostOnline, false);
  assert.equal(roomSummary(target).disconnectedRetained, false, 'another connected human keeps the room active');
  guest.connected = false;
  lobby.onDisconnect(guest);
  const retained = roomSummary(target);
  assert.equal(retained.disconnectedRetained, true, 'online AI and spectator do not prevent retention status');
  assert.equal(retained.humanCount, 2);
  assert.equal(retained.botCount, 1);
  assert.equal(retained.playerCount, 3);
  target.seats[3] = { playerId: 'departed', seat: 3, isBot: false, left: true, connected: true };
  assert.equal(roomSummary(target).disconnectedRetained, true, 'departed humans are ignored');
  assert.equal(roomSummary(target).humanCount, 2);
  const empty = new Room('ZZZZ', 'coop', 'NORMAL', 0, 4);
  assert.equal(roomSummary(empty).disconnectedRetained, false, 'no-human transient room is not a retained run');
});

test('retained rooms are sorted after active rooms before pagination without changing totals', (t) => {
  const { lobby, player, room } = harness(t);
  const retained = [];
  for (let i = 0; i < 12; i++) retained.push(room(player(`Offline host ${i}`, false)));
  retained.at(-1).match = {};
  const active = [];
  for (let i = 0; i < 53; i++) active.push(room(player(`Online host ${i}`)));
  const watcher = player('Watcher');
  lobby.discovery.watch(watcher, { on: true, list: true });
  const first = watcher.frames.at(-1);
  assert.equal(first.roomCount, 65);
  assert.equal(first.matchCount, 1, 'offline running room remains in match count');
  assert.equal(first.joinableCount, 64, 'offline waiting rooms remain joinable');
  assert.equal(first.online, 54);
  assert.equal(first.totalPages, 2);
  assert.deepEqual(first.rooms.map((row) => row.code), active.slice(0, 50).map((r) => r.code));
  lobby.discovery.watch(watcher, { on: true, list: true, page: 1 });
  const second = watcher.frames.at(-1);
  assert.deepEqual(second.rooms.map((row) => row.code), [...active.slice(50), ...retained].map((r) => r.code));
  assert.equal(second.rooms.slice(3).every((row) => row.disconnectedRetained), true);
  assert.equal(second.roomCount, first.roomCount);
  assert.equal(second.matchCount, first.matchCount);
  assert.equal(second.joinableCount, first.joinableCount);
});

test('reconnecting human clears retention and returns the room to its original ordering group', (t) => {
  const { lobby, player, room, flush } = harness(t);
  const host = player('Returning host');
  const retained = room(host);
  const running = room(player('Playing host'));
  running.match = {};
  host.connected = false;
  lobby.onDisconnect(host);
  const watcher = player('Watcher');
  lobby.discovery.watch(watcher, { on: true, list: true });
  assert.deepEqual(watcher.frames.at(-1).rooms.map((row) => row.code), [running.code, retained.code]);
  host.connected = true;
  lobby.onHello(host, { resumed: true, repeat: false });
  flush();
  const state = watcher.frames.at(-1);
  assert.deepEqual(state.rooms.map((row) => row.code), [retained.code, running.code]);
  assert.equal(state.rooms[0].disconnectedRetained, false);
  assert.equal(state.rooms[0].hostOnline, true);
});

test('roomless disconnect updates online count and a spectator cannot subscribe', (t) => {
  const { lobby, player, room, flush } = harness(t);
  const watcher = player('Watcher');
  const other = player('Roomless');
  lobby.discovery.watch(watcher, { on: true });
  assert.equal(watcher.frames.at(-1).online, 2);
  other.connected = false;
  lobby.onDisconnect(other);
  flush();
  assert.equal(watcher.frames.at(-1).online, 1, 'early return without a room still changes presence');
  const host = player('Host');
  const target = room(host);
  const spectator = player('Spectator');
  assert.deepEqual(lobby.spectate(spectator, { code: target.code }), { ok: true });
  assert.equal(lobby.discovery.watch(spectator, { on: true }).error, ERR.BAD_TARGET);
});

test('quick matching never leaves or switches an already running match', (t) => {
  const { lobby, player, room } = harness(t);
  const host = player('Host');
  const running = room(host);
  running.match = {};
  room(player('Other'));
  assert.equal(lobby.discovery.quickMatch(host).error, ERR.ROOM_STARTED);
  assert.equal(host.roomCode, running.code);
});

test('two concurrent WebSocket quick matches cannot both take the final vacant seat', async () => {
  const clients = [];
  const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, MatchClass: StubMatch });
  try {
    const player = async (name) => {
      const c = await TestClient.connect(`ws://127.0.0.1:${srv.port}/ws`);
      clients.push(c);
      await c.hello(name);
      return c;
    };
    const host = await player('Host');
    await host.request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL', capacity: 4 });
    const created = await host.waitFor('room.state');
    await host.request({ t: 'room.addBot' });
    await host.request({ t: 'room.addBot' });
    const a = await player('A');
    const b = await player('B');
    const replies = await Promise.all([a.request({ t: 'lobby.quickMatch' }), b.request({ t: 'lobby.quickMatch' })]);
    assert.equal(replies.filter((reply) => reply.t === 'ok').length, 1);
    assert.equal(replies.filter((reply) => reply.code === ERR.ROOM_NOT_FOUND).length, 1);
    const full = await host.waitFor('room.state', (state) => state.seats.every(Boolean));
    assert.equal(full.code, created.code);
    assert.equal(full.seats.filter((seat) => seat.isBot).length, 2);
  } finally {
    await Promise.all(clients.map((c) => c.terminate()));
    await srv.close();
  }
});

test('directory requests have exactly one reply each and repeated refreshes use the heavy rate bucket', async () => {
  const clients = [];
  const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, MatchClass: StubMatch });
  try {
    const c = await TestClient.connect(`ws://127.0.0.1:${srv.port}/ws`);
    clients.push(c);
    const welcome = await c.hello('Watcher');
    const replies = await Promise.all(Array.from({ length: 12 }, (_, page) => c.request({ t: 'lobby.watch', on: true, list: true, page })));
    assert.ok(replies.some((reply) => reply.code === ERR.RATE), 'directory refreshes share the heavy limiter');
    assert.equal(replies.filter((reply) => reply.t === 'lobby.state').length, 1, 'clamped identical empty pages are not replayed');
    const ids = new Set(replies.map((reply) => reply.rid));
    assert.equal(c.log.filter((frame) => ids.has(frame.rid)).length, 12, 'no extra ok follows a direct lobby.state reply');
    assert.equal((await c.request({ t: 'lobby.watch', on: true, list: false })).t, 'lobby.state', 'closing a list is allowed when the heavy bucket is exhausted');
    assert.equal(srv.lobby.discovery.watchers.get(welcome.playerId).list, false);
    assert.equal((await c.request({ t: 'lobby.watch', on: false })).t, 'ok', 'cleanup does not require a heavy token');
    assert.equal(srv.lobby.discovery.watchers.has(welcome.playerId), false);
  } finally {
    await Promise.all(clients.map((c) => c.terminate()));
    await srv.close();
  }
});

test('quick match falls back from an unavailable preferred capacity and joins the room with fewest vacancies', async () => {
  const clients = [];
  const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, MatchClass: StubMatch });
  try {
    const player = async (name) => {
      const c = await TestClient.connect(`ws://127.0.0.1:${srv.port}/ws`);
      clients.push(c);
      c.welcome = await c.hello(name);
      return c;
    };
    const a = await player('A');
    await a.request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL', capacity: 8 });
    const aState = await a.waitFor('room.state');
    const b = await player('B');
    await b.request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL', capacity: 4 });
    const bState = await b.waitFor('room.state');
    const joiner = await player('Joiner');
    const result = await joiner.request({ t: 'lobby.quickMatch', capacity: 16 });
    assert.equal(result.t, 'ok');
    const joined = await joiner.waitFor('room.state');
    assert.equal(joined.code, bState.code, 'fewest vacancy room wins after preferred capacity fallback');
    assert.notEqual(joined.code, aState.code);
  } finally {
    await Promise.all(clients.map((c) => c.terminate()));
    await srv.close();
  }
});

test('quick match keeps AI seats occupied and does not replace them', async () => {
  const clients = [];
  const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, MatchClass: StubMatch });
  try {
    const host = await TestClient.connect(`ws://127.0.0.1:${srv.port}/ws`);
    clients.push(host);
    await host.hello('Host');
    await host.request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL', capacity: 4 });
    const state = await host.waitFor('room.state');
    await host.request({ t: 'room.addBot' });
    await host.waitFor('room.state', (s) => s.seats.filter(Boolean).length === 2);
    const joiner = await TestClient.connect(`ws://127.0.0.1:${srv.port}/ws`);
    clients.push(joiner);
    await joiner.hello('Joiner');
    await joiner.request({ t: 'lobby.quickMatch', capacity: 4 });
    const joined = await joiner.waitFor('room.state');
    assert.equal(joined.code, state.code);
    assert.equal(joined.seats.filter((seat) => seat?.isBot).length, 1);
  } finally {
    await Promise.all(clients.map((c) => c.terminate()));
    await srv.close();
  }
});

test('room summary ordering keeps joinable waiting rooms before running rooms', () => {
  const waiting = { code: 'BBBB', joinable: true, inMatch: false, createdAt: 2 };
  const full = { code: 'AAAA', joinable: false, inMatch: false, createdAt: 1 };
  const running = { code: 'CCCC', joinable: false, inMatch: true, createdAt: 0 };
  assert.ok(compareRoomSummaries(waiting, full) < 0);
  assert.ok(compareRoomSummaries(full, running) < 0);
  const retainedWaiting = { ...waiting, disconnectedRetained: true };
  const retainedFull = { ...full, disconnectedRetained: true };
  const retainedRunning = { ...running, disconnectedRetained: true };
  assert.ok(compareRoomSummaries(running, retainedWaiting) < 0, 'any active group precedes every retained group');
  assert.ok(compareRoomSummaries(retainedWaiting, retainedFull) < 0, 'retained section preserves waiting order');
  assert.ok(compareRoomSummaries(retainedFull, retainedRunning) < 0);
});

test('directory rejects subscription while in a room and quick match has no candidate error', async () => {
  const clients = [];
  const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, MatchClass: StubMatch });
  try {
    const c = await TestClient.connect(`ws://127.0.0.1:${srv.port}/ws`);
    clients.push(c);
    await c.hello('Host');
    await c.request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL', capacity: 4 });
    await c.waitFor('room.state');
    const watch = await c.request({ t: 'lobby.watch', on: true });
    assert.equal(watch.t, 'error');
    assert.equal(watch.code, ERR.BAD_TARGET);
    await c.request({ t: 'room.leave' });
    const noMatch = await c.request({ t: 'lobby.quickMatch', capacity: 20 });
    assert.equal(noMatch.t, 'error');
    assert.equal(noMatch.code, ERR.ROOM_NOT_FOUND);
  } finally {
    await Promise.all(clients.map((c) => c.terminate()));
    await srv.close();
  }
});
