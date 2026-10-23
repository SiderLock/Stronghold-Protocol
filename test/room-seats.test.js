import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Lobby } from '../server/lobby.js';
import { SessionRegistry } from '../server/net.js';
import { SEAT_REQUEST_MS } from '../server/lobbySeats.js';
import { validateC2S } from '../shared/protocol.js';
import { encodeWire, decodeWire } from '../shared/wireCodec.js';

function harness(t) {
  const registry = new SessionRegistry();
  const lobby = new Lobby({ registry, getData: () => ({}), now: () => Date.now() });
  t.after(() => lobby.shutdown());
  const player = (name) => {
    const session = registry.create(name);
    session.connected = true;
    session.ws = { readyState: 1, bufferedAmount: 0, send() {} };
    return session;
  };
  const a = player('A'), b = player('B'), c = player('C');
  lobby.create(a, { mode: 'coop', difficulty: 'NORMAL', capacity: 20 });
  const room = lobby.getRoom(a.roomCode);
  for (const s of [b, c]) lobby.join(s, { code: room.code });
  const move = (s, seat, playerId = room.seats[seat]?.playerId ?? null) => lobby.onMessage(s, { t: 'room.requestSeat', seat, playerId });
  const answer = (s, request, accept) => lobby.onMessage(s, { t: 'room.answerSeat', requestId: request.id, accept });
  const consistent = () => room.seats.forEach((s, i) => { if (s) assert.equal(s.seat, i); });
  return { lobby, registry, room, a, b, c, player, move, answer, consistent };
}

test('seat messages validate target identity and roundtrip via JSON fallback and room extension', () => {
  for (const msg of [{ t: 'room.requestSeat', seat: 19, playerId: null },
    { t: 'room.requestSeat', seat: 1, playerId: 'p_1' }, { t: 'room.answerSeat', requestId: 'swap_1', accept: true }]) {
    assert.equal(validateC2S(msg), null);
    assert.deepEqual(decodeWire(encodeWire(msg, 'c2s'), 'c2s'), msg);
  }
  for (const msg of [{ t: 'room.requestSeat', seat: 20, playerId: null }, { t: 'room.requestSeat', seat: 1 },
    { t: 'room.answerSeat', requestId: 'swap_1', accept: 1 }]) assert.notEqual(validateC2S(msg), null);
  const state = { t: 'room.state', code: 'ABCDE', seatRequests: [{ id: 'swap_1', fromId: 'a', toId: 'b', fromSeat: 0, toSeat: 1, expiresAt: 30000 }] };
  assert.deepEqual(decodeWire(encodeWire(state, 's2c'), 's2c'), state);
});

test('any waiting human can swap with empty/AI seats; host and all personal state follow identity', (t) => {
  const { lobby, room, a, b, move, consistent } = harness(t);
  const own = room.seatOf(a.playerId), guest = room.seatOf(b.playerId);
  own.ready = true; own.ops = { retained: true }; own.consentCs = 'cs';
  assert.deepEqual(move(a, 19), { ok: true });
  assert.equal(room.seats[0], null); assert.equal(room.seats[19], own);
  assert.equal(room.hostId, a.playerId); assert.equal(own.ready, true); assert.equal(own.consentCs, 'cs');
  assert.deepEqual(own.ops, { retained: true });
  lobby.addBot(a); const bot = room.seats[0];
  assert.deepEqual(move(b, 0), { ok: true });
  assert.equal(room.seats[0], guest); assert.equal(room.seats[1], bot);
  assert.equal(room.hostId, a.playerId);
  consistent();
  assert.equal(lobby.setCapacity(a, { capacity: 8 }).error, 'BAD_TARGET', 'occupied high seat prevents resize');
  assert.equal(move(b, 19, null).error, 'BAD_TARGET', 'stale empty seat cannot displace a human');
});

test('human consent exchanges exactly the original participants and only the recipient can accept', (t) => {
  const { room, a, b, c, move, answer, consistent } = harness(t);
  const before = room.seats.slice();
  assert.deepEqual(move(a, 1), { ok: true });
  const request = room.seatRequests[0];
  assert.deepEqual(room.seats, before);
  assert.equal(answer(a, request, true).error, 'BAD_TARGET');
  assert.equal(answer(c, request, true).error, 'BAD_TARGET');
  assert.equal(move(c, 1).error, 'ALREADY', 'a participant cannot be flooded with competing requests');
  assert.deepEqual(answer(b, request, true), { ok: true });
  assert.equal(room.seats[1], before[0]); assert.equal(room.seats[0], before[1]);
  assert.equal(room.hostId, a.playerId); assert.equal(room.seatRequests.length, 0);
  assert.equal(answer(b, request, true).error, 'BAD_TARGET', 'a repeated acceptance never swaps back');
  consistent();
});

test('decline, sender cancellation, moving and offline/left targets invalidate pending consent', (t) => {
  const { lobby, room, a, b, c, move, answer, player } = harness(t);
  move(a, 1); let request = room.seatRequests[0];
  assert.equal(answer(c, request, false).error, 'BAD_TARGET');
  assert.deepEqual(answer(b, request, false), { ok: true });
  move(a, 1); request = room.seatRequests[0];
  assert.deepEqual(answer(a, request, false), { ok: true });
  move(a, 1); request = room.seatRequests[0];
  move(b, 4);
  assert.equal(answer(b, request, true).error, 'BAD_TARGET');
  move(a, 4); request = room.seatRequests[0];
  b.connected = false; lobby.onDisconnect(b);
  assert.equal(room.seatRequests.length, 0);
  assert.equal(move(a, 4).error, 'BAD_TARGET');
  b.connected = true; lobby.onHello(b, { resumed: true });
  assert.equal(answer(b, request, true).error, 'BAD_TARGET');
  move(a, 4); request = room.seatRequests[0];
  lobby.leave(b);
  const replacement = player('Replacement'); lobby.join(replacement, { code: room.code });
  assert.equal(answer(replacement, request, true).error, 'BAD_TARGET');
  assert.equal(room.seatOf(a.playerId).seat, 0);
});

test('expiry broadcasts removal, permits a new request, and shutdown cancels the timer', (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100000 });
  const { lobby, room, a, b, move, answer } = harness(t);
  move(a, 1); const request = room.seatRequests[0];
  t.mock.timers.tick(SEAT_REQUEST_MS - 1);
  assert.equal(room.seatRequests.length, 1);
  t.mock.timers.tick(1);
  assert.equal(room.seatRequests.length, 0);
  assert.equal(answer(b, request, true).error, 'BAD_TARGET');
  assert.deepEqual(move(a, 1), { ok: true });
  lobby.shutdown();
  assert.equal(room.seatRequestTimer, null);
});

test('an old-room acceptance cannot approve a new-room request between the same humans', (t) => {
  const { lobby, room, a, b, move, answer } = harness(t);
  move(a, 1); const old = room.seatRequests[0];
  lobby.leave(a); lobby.leave(b);
  lobby.create(b, { mode: 'coop', difficulty: 'NORMAL', capacity: 4 });
  const next = lobby.getRoom(b.roomCode);
  lobby.join(a, { code: next.code });
  lobby.onMessage(a, { t: 'room.requestSeat', seat: 0, playerId: b.playerId });
  const current = next.seatRequests[0];
  assert.notEqual(current.id, old.id);
  assert.equal(answer(b, old, true).error, 'BAD_TARGET');
  assert.deepEqual(answer(b, current, true), { ok: true });
});

test('spectators, solo rooms and running matches cannot exchange seats', (t) => {
  const { lobby, room, a, b, player, move, answer } = harness(t);
  const spectator = player('Observer'); lobby.spectate(spectator, { code: room.code });
  assert.equal(move(spectator, 3).error, 'SPECTATOR');
  assert.equal(move(a, 0).error, 'BAD_TARGET');
  move(a, 1); const request = room.seatRequests[0];
  room.match = { dispose() {} }; lobby.broadcastState(room);
  assert.equal(room.seatRequests.length, 0);
  assert.equal(move(a, 3).error, 'ROOM_STARTED');
  assert.equal(answer(b, request, true).error, 'ROOM_STARTED');
  room.match = null;
  const solo = player('Solo'); lobby.create(solo, { mode: 'solo', difficulty: 'NORMAL' });
  assert.equal(lobby.onMessage(solo, { t: 'room.requestSeat', seat: 0, playerId: solo.playerId }).error, 'BAD_TARGET');
});

test('match start uses the final seat order and clears outstanding consent', (t) => {
  const { lobby, room, a, b, c, move } = harness(t);
  lobby.MatchClass = class {
    constructor(opts) { this.opts = opts; }
    start() {}
    dispose() {}
  };
  move(a, 19);
  move(b, 2);
  lobby.ready(b, { ready: true }); lobby.ready(c, { ready: true });
  assert.equal(room.seatRequests.length, 1);
  assert.deepEqual(lobby.start(a), { ok: true });
  assert.equal(room.seatRequests.length, 0);
  const seats = room.match.opts.seats;
  assert.equal(seats.at(-1).playerId, a.playerId);
  assert.equal(seats.at(-1).seat, 19);
  assert.equal(room.hostId, a.playerId);
  assert.equal(move(a, 0).error, 'ROOM_STARTED');
});
