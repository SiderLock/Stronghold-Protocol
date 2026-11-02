// Admission, public directory privacy, and observation stop at the lobby/match boundary; no full game is run.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';
import { Lobby, Room } from '../server/lobby.js';
import { roomSummary } from '../server/lobbyDiscovery.js';
import { SessionRegistry, HEAVY_TYPES } from '../server/net.js';
import { startServer } from '../server/index.js';
import { Net } from '../public/js/net.js';
import { TestClient } from './helpers/wsClient.js';
import { validateC2S } from '../shared/protocol.js';
import { ERR, MAX_SPECTATORS } from '../shared/constants.js';

/** Preserve the match boundary and spectator hooks without combat or timers. */
class HeldMatch {
  constructor(opts) { this.opts = opts; this.spectators = new Set(opts.spectators); }
  start() {}
  onDisconnect() {}
  onLeave() {}
  addSpectator(playerId) { this.spectators.add(playerId); }
  removeSpectator(playerId) { this.spectators.delete(playerId); }
  dispose() { this.disposed = true; }
  end() { this.opts.onEnd({ reason: 'test' }); }
}

const summary = { schema: 1, version: 'a'.repeat(64), totalFiles: 1, totalBytes: 7, complete: true, missingFiles: 0 };
const report = { schema: 1, version: summary.version, readyFiles: 1, readyBytes: 7 };
const error = (reply, code) => assert.equal(reply.error, code, JSON.stringify(reply));

function harness(t) {
  const registry = new SessionRegistry();
  const lobby = new Lobby({ registry, MatchClass: HeldMatch, getData: () => ({}), seedFn: () => 1 });
  t.after(() => lobby.shutdown());
  const player = (name) => {
    const session = registry.create(name);
    session.connected = true;
    session.frames = [];
    session.ws = { readyState: 1, bufferedAmount: 0, send(frame) { session.frames.push(JSON.parse(frame)); } };
    return session;
  };
  const room = (host, mode = 'coop', capacity = 8) => {
    assert.deepEqual(lobby.create(host, { mode, difficulty: 'NORMAL', capacity }), { ok: true });
    return lobby.getRoom(host.roomCode);
  };
  const join = (r, guest) => assert.deepEqual(lobby.join(guest, { code: r.code }), { ok: true });
  const access = (session, r, spectate = false, assetCache) => lobby.onMessage(session, {
    t: spectate ? 'lobby.spectate' : 'lobby.join', roomId: r.directoryId, ...(assetCache ? { assetCache } : {}),
  });
  const policy = (host, allowed) => lobby.onMessage(host, { t: 'room.setMatchmaking', allowed });
  return { lobby, registry, player, room, join, access, policy };
}

test('new lobby routes require an opaque UUID and matchmaking policy requires a boolean', (t) => {
  const { player, room } = harness(t);
  const r = room(player('Host'));
  assert.notEqual(r.directoryId, r.code);
  for (const type of ['lobby.join', 'lobby.spectate']) {
    assert.equal(validateC2S({ t: type, roomId: r.directoryId }), null);
    assert.equal(validateC2S({ t: type, roomId: r.directoryId, assetCache: report }), null);
    for (const roomId of [undefined, '', r.code, null, 3, {}, r.directoryId.toUpperCase(), 'a'.repeat(1000)]) {
      assert.notEqual(validateC2S({ t: type, roomId }), null);
    }
    assert.notEqual(validateC2S({ t: type, roomId: r.directoryId, assetCache: { ready: true } }), null);
  }
  for (const allowed of [true, false]) assert.equal(validateC2S({ t: 'room.setMatchmaking', allowed }), null);
  for (const allowed of [undefined, 0, 1, 'false', null]) {
    assert.notEqual(validateC2S({ t: 'room.setMatchmaking', allowed }), null);
  }
  assert.equal(HEAVY_TYPES.has('lobby.spectate'), true, 'public observation uses the existing expensive request budget');
});

test('only waiting co-op hosts may change public admission; ready state and transferred authority are preserved', (t) => {
  const { lobby, player, room, join, access, policy } = harness(t);
  const host = player('Host'), guest = player('Guest'), observer = player('Observer'), outsider = player('Outsider');
  const r = room(host);
  assert.equal(r.allowMatchmaking, true);
  assert.equal(r.toState().allowMatchmaking, true);
  join(r, guest);
  assert.deepEqual(access(observer, r, true), { ok: true });
  assert.deepEqual(lobby.ready(guest, { ready: true }), { ok: true });
  error(policy(outsider, false), ERR.NOT_IN_ROOM);
  error(policy(guest, false), ERR.NOT_HOST);
  error(policy(observer, false), ERR.NOT_HOST);
  error(policy(host, 'false'), ERR.BAD_MSG);
  assert.deepEqual(policy(host, false), { ok: true });
  assert.equal(r.toState().allowMatchmaking, false);
  assert.equal(guest.frames.at(-1).allowMatchmaking, false);
  assert.equal(r.seatOf(guest.playerId).ready, true);
  const frameCount = host.frames.length;
  assert.deepEqual(policy(host, false), { ok: true });
  assert.equal(host.frames.length, frameCount, 'repeated policy does not rebroadcast');
  assert.deepEqual(lobby.transferHost(host, { playerId: guest.playerId }), { ok: true });
  error(policy(host, true), ERR.NOT_HOST);
  assert.deepEqual(policy(guest, true), { ok: true });
  assert.deepEqual(lobby.ready(host, { ready: true }), { ok: true });
  assert.deepEqual(lobby.start(guest), { ok: true });
  error(policy(guest, false), ERR.ROOM_STARTED);
  const soloHost = player('Solo');
  room(soloHost, 'solo');
  error(policy(soloHost, false), ERR.BAD_TARGET);
});

test('closed admission hides public invitation codes, excludes quick matching and rejects stale public joins', (t) => {
  const { lobby, player, room, access, policy } = harness(t);
  const host = player('Host'), visitor = player('Visitor'), watcher = player('Watcher');
  const privateRoom = room(host, 'coop', 4);
  const stale = roomSummary(privateRoom);
  assert.equal(stale.code, privateRoom.code);
  assert.deepEqual(policy(host, false), { ok: true });
  const publicView = roomSummary(privateRoom);
  assert.equal(publicView.code, null);
  assert.equal(publicView.roomId, stale.roomId, 'policy changes retain the same non-secret public identity');
  assert.equal(publicView.allowMatchmaking, false);
  assert.equal(publicView.joinable, false);
  assert.equal(publicView.spectatable, true);
  assert.equal(JSON.stringify(publicView).includes(privateRoom.code), false);
  lobby.discovery.watch(watcher, { on: true, list: true });
  assert.equal(watcher.frames.at(-1).rooms[0].code, null);
  assert.equal(lobby.discovery.projection().joinableCount, 0);
  error(access(visitor, privateRoom), ERR.BAD_TARGET);
  error(lobby.discovery.quickMatch(visitor, { capacity: 4 }), ERR.ROOM_NOT_FOUND);
  const fallback = room(player('Public host'), 'coop', 8);
  assert.deepEqual(lobby.discovery.quickMatch(visitor, { capacity: 4 }), { ok: true });
  assert.equal(visitor.roomCode, fallback.code, 'closed preferred capacity never prevents public fallback');
  const invited = player('Invited');
  assert.deepEqual(lobby.join(invited, { code: privateRoom.code }), { ok: true }, 'known invitations remain valid');
  assert.deepEqual(access(player('Observer'), privateRoom, true), { ok: true }, 'closed public admission still permits observation');
  assert.deepEqual(policy(host, true), { ok: true });
  assert.equal(roomSummary(privateRoom).code, privateRoom.code);
  assert.deepEqual(access(player('New public guest'), privateRoom), { ok: true });
});

test('public room identities persist through resizing and rounds but never identify a replacement room', (t) => {
  const { lobby, player, room, access, policy } = harness(t);
  const host = player('Host'), visitor = player('Visitor');
  const r = room(host);
  const roomId = r.directoryId;
  assert.deepEqual(policy(host, false), { ok: true });
  assert.deepEqual(lobby.setCapacity(host, { capacity: 20 }), { ok: true });
  assert.equal(r.directoryId, roomId);
  assert.deepEqual(lobby.start(host), { ok: true });
  r.match.end();
  assert.equal(r.directoryId, roomId);
  assert.equal(r.allowMatchmaking, false, 'policy survives returning from a match');
  assert.deepEqual(lobby.leave(host), { ok: true });
  assert.equal(lobby.getRoom(r.code), null);
  const replacement = new Room(r.code, 'coop', 'NORMAL', 0, 4);
  lobby.rooms.set(replacement.code, replacement);
  assert.notEqual(replacement.directoryId, roomId, 'even a reused invitation code cannot reuse the old public identity');
  error(access(visitor, r), ERR.ROOM_NOT_FOUND);
  assert.equal(visitor.roomCode, null);
});

test('playing statistics count connected present humans in matches, including eliminated/autoplay, across both modes', (t) => {
  const { lobby, player, room, join, access } = harness(t);
  const host = player('Host'), eliminated = player('Eliminated'), autoplay = player('Autoplay');
  const offline = player('Offline'), departed = player('Departed'), observer = player('Observer');
  const r = room(host);
  for (const guest of [eliminated, autoplay, offline, departed]) {
    join(r, guest);
    assert.deepEqual(lobby.ready(guest, { ready: true }), { ok: true });
  }
  assert.deepEqual(lobby.addBot(host), { ok: true });
  assert.deepEqual(access(observer, r, true), { ok: true });
  room(player('Waiting human'));
  assert.equal(lobby.discovery.projection().playingCount, 0);
  assert.deepEqual(lobby.start(host), { ok: true });
  r.seatOf(eliminated.playerId).alive = false;
  r.seatOf(autoplay.playerId).autoplay = true;
  offline.connected = false;
  lobby.onDisconnect(offline);
  assert.deepEqual(lobby.leave(departed), { ok: true });
  const solo = player('Solo');
  const soloRoom = room(solo, 'solo');
  assert.deepEqual(lobby.start(solo), { ok: true });
  const view = lobby.discovery.projection();
  assert.equal(view.matchCount, 2);
  assert.equal(view.roomCount, 3);
  assert.equal(view.playingCount, 4, 'host + eliminated + autoplay + solo, never bots, observers, offline or departed');
  r.match.end();
  assert.equal(lobby.discovery.projection().playingCount, 1);
  soloRoom.match.end();
  assert.equal(lobby.discovery.projection().playingCount, 0);
});

test('directory observation works before and during matches and preserves the two-slot reservation limit', (t) => {
  const { lobby, player, room, access, policy } = harness(t);
  const host = player('Host'), before = player('Before'), during = player('During'), third = player('Third');
  const r = room(host, 'coop', 4);
  policy(host, false);
  assert.deepEqual(access(before, r, true), { ok: true });
  assert.equal(roomSummary(r).spectatorCount, 1);
  assert.deepEqual(lobby.start(host), { ok: true });
  assert.equal(r.match.spectators.has(before.playerId), true);
  assert.deepEqual(access(during, r, true), { ok: true });
  assert.equal(r.match.spectators.has(during.playerId), true);
  assert.equal(r.seats.filter(Boolean).length, 1, 'observers never take a player seat');
  assert.equal(roomSummary(r).spectatorCount, MAX_SPECTATORS);
  assert.equal(roomSummary(r).spectatable, false);
  before.connected = false;
  lobby.onDisconnect(before);
  error(access(third, r, true), ERR.ROOM_FULL);
  error(access(host, r, true), ERR.ALREADY, 'players cannot change into observers in place');
  assert.deepEqual(lobby.removeSpectator(host, { playerId: before.playerId }), { ok: true });
  assert.equal(r.match.spectators.has(before.playerId), false);
  assert.equal(roomSummary(r).spectatable, true);
  assert.deepEqual(access(third, r, true), { ok: true });
  const soloRoom = room(player('Solo'), 'solo');
  assert.equal(roomSummary(soloRoom).spectatable, false);
  error(access(player('Solo watcher'), soloRoom, true), ERR.ROOM_FULL);
});

test('new public routes enforce complete asset readiness before membership changes and keep same-role resyncs', (t) => {
  const { lobby, player, room, access } = harness(t);
  const target = room(player('Target'));
  const guest = player('Guest');
  const original = room(guest);
  lobby.setAssetCachePolicy({ required: true, getSummary: () => summary });
  for (const spectate of [false, true]) {
    for (const invalid of [undefined, { ...report, readyFiles: 0 }, { ...report, readyBytes: 6 }, { ...report, version: 'b'.repeat(64) }]) {
      error(access(guest, target, spectate, invalid), ERR.ASSET_CACHE_REQUIRED);
      assert.equal(guest.roomCode, original.code);
      assert.equal(original.hostId, guest.playerId);
      assert.equal(target.seatOf(guest.playerId), null);
      assert.equal(target.spectatorOf(guest.playerId), null);
    }
  }
  assert.deepEqual(access(guest, target, true, report), { ok: true });
  assert.deepEqual(access(guest, target, true), { ok: true }, 'same-role resync does not need a fresh report');
  error(access(guest, target), ERR.ASSET_CACHE_REQUIRED, 'spectator-to-player is a new admission');
  assert.ok(target.spectatorOf(guest.playerId));
  assert.deepEqual(access(guest, target, false, report), { ok: true });
  assert.equal(target.spectatorOf(guest.playerId), null);
  assert.deepEqual(access(guest, target), { ok: true }, 'same player role resync remains possible');
});

test('bandwidth emergency rejects new directory entry while existing role resyncs and invitations retain original semantics', (t) => {
  const { lobby, player, room, access } = harness(t);
  const host = player('Host'), observer = player('Observer'), visitor = player('Visitor');
  const target = room(host);
  assert.deepEqual(access(observer, target, true), { ok: true });
  lobby.setEmergency({ active: true, startedAt: 1 });
  for (const spectate of [false, true]) {
    error(access(visitor, target, spectate), ERR.SERVER_EMERGENCY);
    assert.equal(visitor.roomCode, null);
  }
  assert.deepEqual(access(host, target), { ok: true });
  assert.deepEqual(access(observer, target, true), { ok: true });
});

async function socketFixture(t, opts = {}) {
  // Keep temporary owner settings isolated from the local server's live settings.
  fs.mkdirSync(path.resolve('.cache'), { recursive: true });
  const dir = fs.mkdtempSync(path.resolve('.cache', 'lobby-access-test-'));
  const clients = [], nets = [];
  let server;
  t.after(async () => {
    for (const net of nets) net.close();
    await Promise.all(clients.map((client) => client.terminate()));
    await server?.close();
    assert.equal(path.dirname(dir), path.resolve('.cache'));
    assert.ok(path.basename(dir).startsWith('lobby-access-test-'));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  server = await startServer({ port: 0, host: '127.0.0.1', quiet: true, MatchClass: HeldMatch,
    serverSettingsDir: dir, ...opts });
  const url = `ws://127.0.0.1:${server.port}/ws`;
  const connect = async (name, wire = false) => {
    const client = await TestClient.connect(url, { wire });
    clients.push(client);
    client.welcome = await client.hello(name);
    return client;
  };
  const browserNet = async (getAssetCacheReadiness) => {
    const net = new Net({ url, WebSocket, getAssetCacheReadiness });
    nets.push(net);
    let timer, stop;
    try {
      await new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Net handshake timed out')), 3000);
        stop = net.on('status', ({ status }) => { if (status === 'online') resolve(); });
        net.setName('Browser');
      });
    } finally { clearTimeout(timer); stop?.(); }
    return net;
  };
  return { server, connect, browserNet };
}

for (const wire of [false, true]) {
  test(`public directory routes on ${wire ? 'compact v1' : 'legacy JSON'} sockets guard changed policies and the final free seat`, async (t) => {
    const { server, connect } = await socketFixture(t);
    const host = await connect('Host', wire);
    assert.equal((await host.request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL', capacity: 4 })).t, 'ok');
    const r = server.lobby.getRoom(server.registry.byId(host.welcome.playerId).roomCode);
    const roomId = r.directoryId;
    const a = await connect('A', wire), b = await connect('B', wire);
    const before = await a.request({ t: 'lobby.watch', on: true, list: true });
    assert.equal(before.rooms[0].roomId, roomId);
    assert.equal((await host.request({ t: 'room.setMatchmaking', allowed: false })).t, 'ok');
    assert.equal((await a.request({ t: 'lobby.join', roomId })).code, ERR.BAD_TARGET, 'a stale enabled summary grants no admission');
    const after = await a.request({ t: 'lobby.watch', on: true, list: false });
    assert.equal(after.joinableCount, 0);
    const hidden = await a.request({ t: 'lobby.watch', on: true, list: true });
    assert.equal(hidden.rooms[0].code, null);
    assert.equal(hidden.rooms[0].spectatable, true);
    assert.equal((await b.request({ t: 'lobby.spectate', roomId })).t, 'ok');
    assert.equal((await b.request({ t: 'room.leave' })).t, 'ok');
    assert.equal((await host.request({ t: 'room.setMatchmaking', allowed: true })).t, 'ok');
    for (let i = 0; i < 2; i++) assert.equal((await host.request({ t: 'room.addBot' })).t, 'ok');
    const replies = await Promise.all([a, b].map((client) => client.request({ t: 'lobby.join', roomId })));
    assert.equal(replies.filter((reply) => reply.t === 'ok').length, 1);
    assert.equal(replies.filter((reply) => reply.code === ERR.ROOM_FULL).length, 1);
    assert.equal(r.seats.filter(Boolean).length, 4);
  });
}

test('client Net attaches readiness to both new public routes and neither bypasses server strict admission', async (t) => {
  const { server, connect, browserNet } = await socketFixture(t);
  const host = await connect('Host');
  await host.request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL', capacity: 8 });
  const r = server.lobby.getRoom(server.registry.byId(host.welcome.playerId).roomCode);
  server.lobby.setAssetCachePolicy({ required: true, getSummary: () => summary });
  const denied = await connect('Denied', true);
  for (const type of ['lobby.join', 'lobby.spectate']) {
    assert.equal((await denied.request({ t: type, roomId: r.directoryId })).code, ERR.ASSET_CACHE_REQUIRED);
    assert.equal(server.registry.byId(denied.welcome.playerId).roomCode, null);
  }
  const requests = [];
  const net = await browserNet((type) => { requests.push(type); return report; });
  for (const type of ['lobby.join', 'lobby.spectate']) {
    assert.equal((await net.request(type, { roomId: r.directoryId })).t, 'ok');
    assert.equal(server.registry.byId(net.playerId).roomCode, r.code);
    await net.request('room.leave');
  }
  assert.deepEqual(requests, ['lobby.join', 'lobby.spectate']);
});

test('public observation uses the same heavy-request quota as invitation observation', async (t) => {
  const { server, connect } = await socketFixture(t, { heavyPerSec: 0, heavyBurst: 2 });
  const host = await connect('Host');
  await host.request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL', capacity: 4 });
  const r = server.lobby.getRoom(server.registry.byId(host.welcome.playerId).roomCode);
  await host.request({ t: 'room.start' });
  const observer = await connect('Observer', true);
  assert.equal((await observer.request({ t: 'lobby.spectate', roomId: r.directoryId })).t, 'ok');
  assert.equal((await observer.request({ t: 'room.spectate', code: r.code })).t, 'ok');
  assert.equal((await observer.request({ t: 'lobby.spectate', roomId: r.directoryId })).code, ERR.RATE);
  assert.equal(r.spectators.length, 1, 'heavy rate rejection cannot allocate a new observer seat');
});
