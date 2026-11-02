import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Lobby } from '../server/lobby.js';
import { SessionRegistry } from '../server/net.js';
import { validateC2S } from '../shared/protocol.js';
import { ERR, MAX_SEATS } from '../shared/constants.js';

/** Keep a running roster observable without timers or battle simulation. */
class HeldMatch {
  constructor(opts) { this.opts = opts; this.originalSeats = structuredClone(opts.seats); }
  start() {}
  onLeave() {}
  dispose() { this.disposed = true; }
  end() { this.opts.onEnd({ reason: 'test' }); }
}

function harness(t) {
  const registry = new SessionRegistry();
  const lobby = new Lobby({ registry, MatchClass: HeldMatch, getData: () => ({}), seedFn: () => 1 });
  t.after(() => lobby.shutdown());
  const player = (name) => {
    const s = registry.create(name);
    s.connected = true;
    s.frames = [];
    s.ws = { readyState: 1, bufferedAmount: 0, send(frame) { s.frames.push(JSON.parse(frame)); } };
    return s;
  };
  const room = (host, capacity = 8) => {
    assert.deepEqual(lobby.create(host, { mode: 'coop', difficulty: 'NORMAL', capacity }), { ok: true });
    return lobby.getRoom(host.roomCode);
  };
  const join = (room, guest) => assert.deepEqual(lobby.join(guest, { code: room.code }), { ok: true });
  const bot = (room, host) => {
    assert.deepEqual(lobby.addBot(host), { ok: true });
    return room.seats.filter((s) => s?.isBot).at(-1);
  };
  return { lobby, registry, player, room, join, bot };
}

const error = (reply, code) => assert.equal(reply.error, code, JSON.stringify(reply));
const consistentSeats = (room) => room.seats.forEach((s, i) => { if (s) assert.equal(s.seat, i); });

test('host transfer and guarded AI removal validate identity fields and twentieth-seat bounds', () => {
  assert.equal(validateC2S({ t: 'room.transferHost', playerId: 'p_123' }), null);
  for (const playerId of ['', null, 3, 'bad id', 'x'.repeat(65)]) {
    assert.notEqual(validateC2S({ t: 'room.transferHost', playerId }), null);
  }
  assert.notEqual(validateC2S({ t: 'room.transferHost', seat: 1 }), null);
  assert.equal(validateC2S({ t: 'room.removeBot', seat: MAX_SEATS - 1, playerId: 'ai_123' }), null);
  assert.equal(validateC2S({ t: 'room.removeBot', seat: 1 }), null, 'legacy clients remain compatible');
  assert.notEqual(validateC2S({ t: 'room.removeBot', seat: MAX_SEATS, playerId: 'ai_123' }), null);
});

test('transfer preserves waiting seats, readiness and complete player settings', (t) => {
  const { lobby, player, room, join } = harness(t);
  const host = player('Host');
  const guest = player('Guest');
  const r = room(host, 20);
  join(r, guest);
  const originalHost = r.seatOf(host.playerId);
  const originalGuest = r.seatOf(guest.playerId);
  originalHost.loadout = { host: 1 };
  originalGuest.loadout = { guest: 1 };
  originalGuest.ops = { guest: 2 };
  originalGuest.notOwned = ['guest'];
  originalGuest.diy = { slot: 'guest' };
  originalGuest.ready = true;
  assert.deepEqual(lobby.transferHost(host, { playerId: guest.playerId }), { ok: true });
  assert.equal(r.hostId, guest.playerId);
  assert.equal(r.seats[0], originalHost);
  assert.equal(r.seats[1], originalGuest);
  assert.equal(originalHost.ready, false, 'former host must ready before the new host starts');
  assert.equal(originalGuest.ready, true);
  assert.deepEqual(originalGuest.ops, { guest: 2 });
  assert.deepEqual(originalGuest.notOwned, ['guest']);
  assert.deepEqual(originalGuest.diy, { slot: 'guest' });
  assert.deepEqual(originalHost.loadout, { host: 1 });
  consistentSeats(r);
  error(lobby.addBot(host), ERR.NOT_HOST);
  error(lobby.start(guest), ERR.NOT_READY);
  assert.deepEqual(lobby.ready(host, { ready: true }), { ok: true });
  assert.deepEqual(lobby.start(guest), { ok: true });
  assert.equal(r.match.originalSeats[1].playerId, guest.playerId);
});

test('transfer refuses non-hosts, AI, observers, offline humans, self, absent and stale identities', (t) => {
  const { lobby, player, room, join, bot } = harness(t);
  const host = player('Host'); const guest = player('Guest'); const outsider = player('Outsider');
  const spec = player('Spec');
  const r = room(host); join(r, guest);
  const ai = bot(r, host);
  assert.deepEqual(lobby.spectate(spec, { code: r.code }), { ok: true });
  error(lobby.transferHost(outsider, { playerId: guest.playerId }), ERR.NOT_IN_ROOM);
  error(lobby.transferHost(guest, { playerId: host.playerId }), ERR.NOT_HOST);
  for (const playerId of [host.playerId, ai.playerId, spec.playerId, outsider.playerId, 'p_absent']) {
    error(lobby.transferHost(host, { playerId }), ERR.BAD_TARGET);
  }
  guest.connected = false;
  error(lobby.transferHost(host, { playerId: guest.playerId }), ERR.BAD_TARGET);
  guest.connected = true; r.seatOf(guest.playerId).connected = false;
  error(lobby.transferHost(host, { playerId: guest.playerId }), ERR.BAD_TARGET);
  r.seatOf(guest.playerId).connected = true;
  lobby.removeMember(r, guest.playerId);
  const replacement = player('Replacement'); join(r, replacement);
  error(lobby.transferHost(host, { playerId: guest.playerId }), ERR.BAD_TARGET);
  assert.equal(r.hostId, host.playerId);
  assert.deepEqual(lobby.transferHost(host, { playerId: replacement.playerId }), { ok: true });
  error(lobby.transferHost(host, { playerId: replacement.playerId }), ERR.NOT_HOST);
});

test('waiting migration selects a connected human without moving any remaining seat', (t) => {
  const { lobby, player, room, join, bot } = harness(t);
  const host = player('Host'); const a = player('Offline'); const b = player('Online');
  const r = room(host); join(r, a); join(r, b);
  a.connected = false; r.seatOf(a.playerId).connected = false;
  lobby.removeMember(r, host.playerId);
  assert.equal(r.hostId, b.playerId);
  assert.equal(r.seats[0], null);
  assert.equal(r.seats[2]?.playerId, b.playerId);
  const ai = bot(r, b);
  assert.equal(r.seats[0], ai, 'an AI can occupy P1 while the host remains at P3');
  assert.equal(r.seats[2]?.playerId, b.playerId);
  consistentSeats(r);
});

test('twentieth-seat transfer preserves every other member and guarded stale AI request cannot remove another bot', (t) => {
  const { lobby, player, room, join, bot } = harness(t);
  const host = player('Host'); const r = room(host, 20);
  for (let i = 1; i < 19; i++) bot(r, host);
  const target = player('Last'); join(r, target);
  const before = r.seats.slice();
  assert.deepEqual(lobby.transferHost(host, { playerId: target.playerId }), { ok: true });
  assert.equal(r.seats[0]?.playerId, host.playerId);
  assert.equal(r.seats[19]?.playerId, target.playerId);
  for (let i = 1; i < 19; i++) assert.equal(r.seats[i], before[i]);
  consistentSeats(r);
  error(lobby.removeBot(target, { seat: 1, playerId: before[2].playerId }), ERR.BAD_TARGET);
  assert.equal(r.seats[1], before[1]);
  assert.deepEqual(lobby.removeBot(target, { seat: 1, playerId: before[1].playerId }), { ok: true });
  assert.deepEqual(lobby.removeBot(target, { seat: 2 }), { ok: true });
});

test('running migration and match end retain seats while applying the latest AI limit', (t) => {
  const { lobby, player, room, join, bot } = harness(t);
  const host = player('Host'); const guest = player('Guest'); const r = room(host, 20);
  join(r, guest);
  for (let i = 0; i < 6; i++) bot(r, host);
  assert.deepEqual(lobby.ready(guest, { ready: true }), { ok: true });
  assert.deepEqual(lobby.start(host), { ok: true });
  const match = r.match; const before = structuredClone(match.originalSeats);
  error(lobby.transferHost(host, { playerId: guest.playerId }), ERR.ROOM_STARTED);
  lobby.setAiLimit(2);
  assert.equal(r.seats.filter((s) => s?.isBot).length, 6, 'live roster is never trimmed');
  assert.equal(r.toState().maxAiPerRoom, 2);
  lobby.removeMember(r, host.playerId);
  assert.equal(r.hostId, guest.playerId);
  assert.equal(r.seatOf(guest.playerId).seat, 1, 'live seat remains fixed');
  assert.deepEqual(match.originalSeats, before, 'fixed grouping input never changes mid-match');
  match.end();
  assert.equal(r.match, null);
  assert.equal(r.seats[0], null);
  assert.equal(r.seats[1]?.playerId, guest.playerId);
  assert.equal(r.seats.filter((s) => s?.isBot).length, 2);
  consistentSeats(r);
});

test('runtime AI policy defaults unlimited, trims only trailing AI, broadcasts and permits humans at the ceiling', (t) => {
  const { lobby, player, room, join, bot } = harness(t);
  const host = player('Host'); const r = room(host, 20);
  const first = bot(r, host); const second = bot(r, host);
  const human = player('Human'); join(r, human);
  const last = bot(r, host);
  assert.equal(r.toState().maxAiPerRoom, null);
  lobby.setAiLimit(2);
  assert.equal(r.seats[first.seat], first);
  assert.equal(r.seats[second.seat], second);
  assert.equal(r.seats[last.seat], null);
  assert.equal(r.seatOf(human.playerId).seat, 3);
  assert.equal(host.frames.at(-1).maxAiPerRoom, 2);
  error(lobby.addBot(host), ERR.AI_LIMIT);
  const human2 = player('Human 2'); join(r, human2);
  const later = room(player('Later'), 4);
  assert.equal(later.toState().maxAiPerRoom, 2, 'new rooms inherit the latest setting');
  lobby.setAiLimit(0);
  assert.equal(r.seats.filter((s) => s?.isBot).length, 0);
  assert.equal(r.activeHumans().length, 3);
  error(lobby.addBot(host), ERR.AI_LIMIT);
  lobby.setAiLimit(null);
  for (let i = 0; i < 17; i++) bot(r, host);
  assert.equal(r.seats.filter(Boolean).length, 20);
  error(lobby.addBot(host), ERR.ROOM_FULL);
  for (const limit of [-1, 20, 1.5, undefined, '3']) assert.throws(() => lobby.setAiLimit(limit), RangeError);
});

test('start validates current AI ceiling even if an invalid roster bypassed addBot', (t) => {
  const { lobby, player, room, bot } = harness(t);
  const host = player('Host'); const r = room(host);
  const ai = bot(r, host);
  lobby.setAiLimit(0);
  r.seats[1] = ai;
  error(lobby.start(host), ERR.AI_LIMIT);
  assert.equal(r.match, null);
});
