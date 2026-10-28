import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server/index.js';
import { StubMatch } from '../server/match/StubMatch.js';
import { Lobby, BOT_NAMES } from '../server/lobby.js';
import { SessionRegistry } from '../server/net.js';
import { TestClient } from './helpers/wsClient.js';
import { ROOM_CAPACITIES, DEFAULT_SEATS, MAX_SEATS, MAX_DRAFT_CARDS } from '../shared/constants.js';
import { validateC2S } from '../shared/protocol.js';
import { writeServerSettings } from '../server/serverSettings.js';

test('the AI name pool covers all twenty seats without duplicates', () => {
  assert.equal(BOT_NAMES.length, 20);
  assert.equal(new Set(BOT_NAMES).size, 20);
  assert.ok(BOT_NAMES.every(name => name.startsWith('AI·')));
});

async function capacityServer(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-capacity-'));
  t.after(() => {
    assert.equal(path.dirname(dir), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith('sp-capacity-'));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  writeServerSettings(dir, { maxAiPerRoom: null, requireAssetCache: false });
  return startServer({ port: 0, host: '127.0.0.1', quiet: true, MatchClass: StubMatch, serverSettingsDir: dir });
}

test('capacity and high seat/card indexes are bounded at the protocol boundary', () => {
  for (const capacity of ROOM_CAPACITIES) {
    assert.equal(validateC2S({ t: 'room.create', mode: 'coop', difficulty: 'HARD', capacity }), null);
    assert.equal(validateC2S({ t: 'room.setCapacity', capacity }), null);
  }
  for (const capacity of [0, 3, 21, 100, '20']) assert.notEqual(validateC2S({ t: 'room.setCapacity', capacity }), null);
  assert.equal(validateC2S({ t: 'room.removeBot', seat: MAX_SEATS - 1 }), null);
  assert.notEqual(validateC2S({ t: 'room.removeBot', seat: MAX_SEATS }), null);
  assert.equal(validateC2S({ t: 'g.choice', idx: MAX_DRAFT_CARDS - 1 }), null);
  assert.notEqual(validateC2S({ t: 'g.choice', idx: MAX_DRAFT_CARDS }), null);
});

test('group draft requests validate optional stage and group guards while preserving legacy shapes', () => {
  for (const msg of [{ t: 'g.band', bandId: 'band_sarkazb' }, { t: 'g.bandSkip' },
    { t: 'g.bandFocus', bandId: null }, { t: 'g.choice', idx: 5 }]) {
    assert.equal(validateC2S(msg), null);
    assert.equal(validateC2S({ ...msg, draftId: 'sp:m_123:3:2', groupId: 5 }), null);
    for (const groupId of [0, 6, 1.5, '1', null]) assert.notEqual(validateC2S({ ...msg, groupId }), null);
    for (const draftId of ['', 'bad id', 'a'.repeat(65), 1, null]) assert.notEqual(validateC2S({ ...msg, draftId }), null);
  }
  assert.notEqual(validateC2S({ t: 'g.choice', idx: 6, groupId: 1 }), null);
});

test('default eight seats, host resizing, occupied trailing seats and a full twenty-seat room', async (t) => {
  const clients = [];
  const srv = await capacityServer(t);
  try {
    const player = async (name) => {
      const c = await TestClient.connect(`ws://127.0.0.1:${srv.port}/ws`);
      clients.push(c);
      c.id = (await c.hello(name)).playerId;
      return c;
    };
    const host = await player('Host');
    assert.equal((await host.request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL' })).t, 'ok');
    let state = await host.waitFor('room.state');
    assert.equal(state.capacity, DEFAULT_SEATS);
    assert.equal(state.seats.length, DEFAULT_SEATS);
    const guest = await player('Guest');
    assert.equal((await guest.request({ t: 'room.join', code: state.code })).t, 'ok');
    assert.equal((await guest.request({ t: 'room.setCapacity', capacity: 20 })).code, 'NOT_HOST');
    assert.equal((await guest.request({ t: 'room.ready', ready: true })).t, 'ok');
    assert.equal((await host.request({ t: 'room.setCapacity', capacity: 20 })).t, 'ok');
    state = await host.waitFor('room.state', (s) => s.capacity === 20);
    assert.equal(state.seats[1].ready, true, 'capacity growth retains the guest readiness');
    for (let i = 2; i < MAX_SEATS; i++) assert.equal((await host.request({ t: 'room.addBot' })).t, 'ok');
    state = await host.waitFor('room.state', (s) => s.seats.every(Boolean));
    assert.equal(state.seats[19].isBot, true);
    assert.equal((await host.request({ t: 'room.addBot' })).code, 'ROOM_FULL');
    assert.equal((await host.request({ t: 'room.setCapacity', capacity: 16 })).code, 'BAD_TARGET');
    assert.equal((await host.request({ t: 'room.removeBot', seat: 19 })).t, 'ok');
    assert.equal((await host.request({ t: 'room.removeBot', seat: 18 })).t, 'ok');
    assert.equal((await host.request({ t: 'room.removeBot', seat: 17 })).t, 'ok');
    assert.equal((await host.request({ t: 'room.removeBot', seat: 16 })).t, 'ok');
    assert.equal((await host.request({ t: 'room.setCapacity', capacity: 16 })).t, 'ok');
    state = await host.waitFor('room.state', (s) => s.capacity === 16);
    assert.equal(state.seats.length, 16);
    assert.equal(state.seats[1].playerId, guest.id, 'seats never compact during resize');
    assert.equal(state.seats[1].ready, true, 'capacity shrink retains the guest readiness');
    assert.equal((await host.request({ t: 'room.start' })).t, 'ok', 'ready members can start without preparing again');
    assert.equal((await host.request({ t: 'room.setCapacity', capacity: 20 })).code, 'ROOM_STARTED');
  } finally {
    await Promise.all(clients.map((c) => c.terminate()));
    await srv.close();
  }
});

test('resizing preserves full seat identity and mixed ready states after host transfer, including offline humans and spectators', (t) => {
  const registry = new SessionRegistry();
  class HeldMatch {
    constructor(opts) { this.seats = opts.seats; }
    start() {}
    dispose() {}
  }
  const lobby = new Lobby({ registry, MatchClass: HeldMatch, getData: () => ({}), seedFn: () => 1 });
  t.after(() => lobby.shutdown());
  const player = (name) => {
    const session = registry.create(name);
    session.connected = true;
    session.ws = { readyState: 1, bufferedAmount: 0, send() {} };
    return session;
  };
  const ok = (reply) => assert.deepEqual(reply, { ok: true });
  const oldHost = player('Original Host');
  const newHost = player('New Host');
  const offline = player('Offline Guest');
  const spectator = player('Watcher');
  ok(lobby.create(oldHost, { mode: 'coop', difficulty: 'NORMAL', capacity: 4 }));
  const room = lobby.getRoom(oldHost.roomCode);
  ok(lobby.join(newHost, { code: room.code }));
  ok(lobby.join(offline, { code: room.code }));
  ok(lobby.addBot(oldHost));
  ok(lobby.spectate(spectator, { code: room.code }));
  ok(lobby.ready(newHost, { ready: true }));
  ok(lobby.ready(offline, { ready: true }));
  ok(lobby.transferHost(oldHost, { playerId: newHost.playerId }));
  offline.connected = false;
  lobby.onDisconnect(offline);
  const originalSeats = room.seats.slice();
  const oldHostSeat = room.seatOf(oldHost.playerId);
  oldHostSeat.loadout = Object.freeze({ test_chess: 1 });
  oldHostSeat.ops = Object.freeze({ test_char: { potential: 1 } });
  oldHostSeat.notOwned = Object.freeze(['test_owned']);
  oldHostSeat.diy = Object.freeze({ test_slot: 'test_char' });
  const seatSnapshot = structuredClone(originalSeats);
  const spectatorSnapshot = structuredClone(room.spectators);
  assert.equal(room.seats[1].playerId, newHost.playerId);
  assert.equal(oldHostSeat.ready, false, 'an unready former host must stay unready');
  assert.equal(room.seatOf(offline.playerId).ready, true);
  for (const capacity of [8, 20, 8, 4]) {
    ok(lobby.setCapacity(newHost, { capacity }));
    assert.equal(room.capacity, capacity);
    assert.equal(room.seats.length, capacity);
    assert.deepEqual(room.seats.slice(0, 4), seatSnapshot, `all existing seat properties survive resize to ${capacity}`);
    for (let i = 0; i < 4; i++) assert.equal(room.seats[i], originalSeats[i], 'players keep their complete seat object');
    assert.ok(room.seats.slice(4).every((seat) => seat === null), 'new seats are empty');
    assert.deepEqual(room.spectators, spectatorSnapshot);
    assert.equal(room.hostId, newHost.playerId);
  }
  for (const request of [{ capacity: 4 }, { capacity: 3 }, { capacity: 21 }]) {
    const reply = lobby.setCapacity(newHost, request);
    assert.equal(reply.error ?? null, request.capacity === 4 ? null : 'BAD_MSG');
    assert.deepEqual(room.seats, seatSnapshot, 'same or invalid capacity cannot alter readiness or seat settings');
  }
  assert.equal(lobby.start(newHost).error, 'NOT_READY', 'resize must not mark unready or offline players ready');
  offline.connected = true;
  lobby.onHello(offline, { resumed: true, repeat: false });
  ok(lobby.ready(oldHost, { ready: true }));
  ok(lobby.setDifficulty(newHost, { difficulty: 'NORMAL' }));
  assert.equal(oldHostSeat.ready, true, 'unchanged difficulty retains readiness');
  ok(lobby.setDifficulty(newHost, { difficulty: 'HARD' }));
  assert.equal(oldHostSeat.ready, false, 'changing difficulty still resets non-host readiness');
  assert.equal(room.seatOf(offline.playerId).ready, false);
  ok(lobby.ready(oldHost, { ready: true }));
  ok(lobby.ready(offline, { ready: true }));
  ok(lobby.setCapacity(newHost, { capacity: 20 }));
  ok(lobby.setCapacity(newHost, { capacity: 4 }));
  ok(lobby.start(newHost));
  assert.deepEqual(room.match.seats.map((seat) => seat.playerId), originalSeats.map((seat) => seat.playerId));
  const matchSeats = structuredClone(room.seats);
  assert.equal(lobby.setCapacity(newHost, { capacity: 8 }).error, 'ROOM_STARTED');
  assert.equal(room.capacity, 4);
  assert.deepEqual(room.seats, matchSeats);
});

test('twenty real WebSocket players can join and start the same co-op room', async (t) => {
  const clients = [];
  const srv = await capacityServer(t);
  try {
    const player = async (name) => {
      const c = await TestClient.connect(`ws://127.0.0.1:${srv.port}/ws`);
      clients.push(c);
      c.id = (await c.hello(name)).playerId;
      return c;
    };
    const host = await player('Host');
    assert.equal((await host.request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL', capacity: 20 })).t, 'ok');
    const code = (await host.waitFor('room.state')).code;
    for (let i = 1; i < MAX_SEATS; i++) {
      const guest = await player(`Guest ${i}`);
      assert.equal((await guest.request({ t: 'room.join', code })).t, 'ok');
      assert.equal((await guest.request({ t: 'room.ready', ready: true })).t, 'ok');
    }
    const room = await host.waitFor('room.state', (s) => s.seats.every((seat) => seat && (seat.seat === 0 || seat.ready)));
    assert.equal(room.seats.length, MAX_SEATS);
    assert.equal(new Set(room.seats.map((seat) => seat.playerId)).size, MAX_SEATS);
    assert.equal((await host.request({ t: 'room.start' })).t, 'ok');
    const views = await Promise.all(clients.map((client) => client.waitFor('m.public', (pub) => pub.players?.length === MAX_SEATS)));
    for (const pub of views) assert.equal(new Set(pub.players.map((p) => p.playerId)).size, MAX_SEATS);
  } finally {
    await Promise.all(clients.map((c) => c.terminate()));
    await srv.close();
  }
});
