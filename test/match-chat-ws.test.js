import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { startServer } from '../server/index.js';
import { StubMatch } from '../server/match/StubMatch.js';
import { TestClient } from './helpers/wsClient.js';
import { ERR, PHASE } from '../shared/constants.js';
import { validateC2S } from '../shared/protocol.js';

/** Real WS/session/lobby plumbing without battle simulation or match timers. */
class HeldChatMatch extends StubMatch {
  start() {
    this.phase = PHASE.INFO_CHECK;
    this.broadcastFn(this.publicView());
    for (const p of this.players.values()) if (!p.isBot) this.sendFn(p.playerId, this.privateView(p));
  }
  addSpectator(playerId) { this.sendFn(playerId, this.publicView()); }
  removeSpectator() {}
}

async function fixture(t, opts = {}) {
  const logs = [];
  const log = Object.fromEntries(['info', 'warn', 'error', 'debug'].map((kind) => [kind, (...args) => logs.push(args.map(String).join(' '))]));
  const srv = await startServer({ port: 0, host: '127.0.0.1', MatchClass: HeldChatMatch, log,
    serverSettingsDir: path.resolve('.cache', `chat-ws-settings-${process.pid}-${Date.now()}`), ...opts });
  const clients = [];
  t.after(async () => { await Promise.all(clients.map((c) => c.terminate().catch(() => {}))); await srv.close(); });
  srv.lobby.setAiLimit(null);
  srv.lobby.setAssetCachePolicy({ required: false, getSummary: () => null });
  let now = Date.now();
  srv.lobby.now = () => now;
  const connect = async (name, wire = false, token = undefined) => {
    const c = await TestClient.connect(`ws://127.0.0.1:${srv.port}/ws`, { wire });
    clients.push(c);
    const welcome = await c.hello(name, token);
    c.id = welcome.playerId; c.token = welcome.token; c.welcome = welcome;
    return c;
  };
  const host = await connect('Host', true);
  assert.equal((await host.request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL', capacity: 8 })).t, 'ok');
  const roomState = await host.waitFor('room.state');
  const room = srv.lobby.getRoom(roomState.code);
  const guest = await connect('Guest', false);
  assert.equal((await guest.request({ t: 'room.join', code: room.code })).t, 'ok');
  assert.equal((await guest.request({ t: 'room.ready', ready: true })).t, 'ok');
  const start = async () => {
    assert.equal((await host.request({ t: 'room.start' })).t, 'ok');
    const snap = await host.waitFor('m.chatState');
    const other = await guest.waitFor('m.chatState');
    assert.deepEqual(snap, other);
    assert.equal(snap.matchId, room.toState().chatMatchId);
    return snap;
  };
  return { srv, room, host, guest, connect, start, logs, advance(ms = 2000) { now += ms; } };
}

const expectError = async (client, msg, code) => {
  const result = await client.request(msg);
  assert.equal(result.t, 'error');
  assert.equal(result.code, code);
};
const requestChat = (client, matchId, text, extra = {}) => client.request({ t: 'room.chat', matchId, text, ...extra });

test('real mixed-wire room chat authorizes players and mid-match spectators, keeps gameplay/public frames separate', async (t) => {
  const { srv, room, host, guest, connect, start, logs } = await fixture(t);
  const snap = await start();
  assert.deepEqual(snap.messages, []);
  const publicCount = host.log.filter((m) => m.t === 'm.public').length;
  assert.equal((await requestChat(host, snap.matchId, '  你好\n同盟😀 ', { name: 'spoof', playerId: guest.id, seat: 19 })).t, 'ok');
  const sent = await host.waitFor('m.chat');
  assert.deepEqual(await guest.waitFor('m.chat'), sent);
  assert.equal(sent.text, '你好\n同盟😀');
  assert.equal(sent.playerId, host.id);
  assert.equal(sent.name, 'Host');
  assert.equal(sent.seat, 0);
  assert.equal(host.log.filter((m) => m.t === 'm.public').length, publicCount);
  assert.ok(host.rawLog.some((m) => m.t === 'm.chat'), 'new types remain readable JSON on compact sockets');
  const viewer = await connect('Viewer', true);
  assert.equal((await viewer.request({ t: 'room.spectate', code: room.code })).t, 'ok');
  const viewerHistory = await viewer.waitFor('m.chatState');
  assert.equal(viewerHistory.messages[0].text, sent.text);
  assert.equal((await requestChat(viewer, snap.matchId, '<script>literal</script>')).t, 'ok');
  const viewed = await host.waitFor('m.chat', (m) => m.playerId === viewer.id);
  assert.equal(viewed.spectator, true);
  assert.equal(viewed.seat, null);
  assert.equal(viewed.text, '<script>literal</script>');
  assert.equal(JSON.stringify(logs).includes('<script>literal</script>'), false);
  assert.equal(JSON.stringify(logs).includes(sent.text), false);
  assert.equal(room.matchCtx.results.size, 0);
  assert.equal(room.replay, null);
  assert.equal(srv.registry.byId(host.id).roomCode, room.code);
});

test('chat rejects pre/post-match, outsiders, stale scopes, departed, offline and AI identities without echoing bodies', async (t) => {
  const { srv, room, host, guest, connect, start } = await fixture(t);
  await expectError(host, { t: 'room.chat', matchId: 'old', text: 'before' }, ERR.WRONG_PHASE);
  assert.equal((await host.request({ t: 'room.addBot' })).t, 'ok');
  const bot = room.seats.find((s) => s?.isBot);
  const snap = await start();
  const outsider = await connect('Outsider');
  await expectError(outsider, { t: 'room.chat', matchId: snap.matchId, text: 'private body' }, ERR.NOT_IN_ROOM);
  await expectError(host, { t: 'room.chat', matchId: 'stale', text: 'stale body' }, ERR.BAD_TARGET);
  for (const text of ['', '  \n ', '\u202e\u0000', '字'.repeat(201), '😀'.repeat(201), '\ud800', 8]) {
    await expectError(host, { t: 'room.chat', matchId: snap.matchId, text }, ERR.BAD_MSG);
  }
  assert.equal(validateC2S({ t: 'room.chat', matchId: snap.matchId, text: '😀'.repeat(200) }), null);
  assert.equal((await requestChat(host, snap.matchId, '😀'.repeat(200))).t, 'ok');
  const hostSession = srv.registry.byId(host.id);
  const hostSeat = room.seatOf(host.id);
  hostSeat.connected = false;
  assert.equal(srv.lobby.chat(hostSession, { matchId: snap.matchId, text: 'offline' }).error, ERR.NOT_IN_ROOM);
  hostSeat.connected = true;
  hostSession.connected = false;
  assert.equal(srv.lobby.chat(hostSession, { matchId: snap.matchId, text: 'offline session' }).error, ERR.NOT_IN_ROOM);
  hostSession.connected = true;
  assert.equal(srv.lobby.chat({ ...hostSession }, { matchId: snap.matchId, text: 'fake session' }).error, ERR.NOT_IN_ROOM);
  assert.equal(srv.lobby.chat({ playerId: bot.playerId, roomCode: room.code, connected: true },
    { matchId: snap.matchId, text: 'AI spoof' }).error, ERR.NOT_IN_ROOM);
  assert.equal((await guest.request({ t: 'room.leave' })).t, 'ok');
  await expectError(guest, { t: 'room.chat', matchId: snap.matchId, text: 'left' }, ERR.NOT_IN_ROOM);
  assert.equal(room.matchCtx.chat.snapshot().seq, 1);
});

test('same-player reconnect restores bounded history and retains chat rate budget; repeated hello history is coalesced', async (t) => {
  const { room, host, guest, connect, start, advance } = await fixture(t);
  const snap = await start();
  for (let n = 0; n < 3; n++) assert.equal((await requestChat(guest, snap.matchId, `msg${n}`)).t, 'ok');
  await expectError(guest, { t: 'room.chat', matchId: snap.matchId, text: 'fourth' }, ERR.RATE);
  await guest.terminate();
  const resumed = await connect('Guest', true, guest.token);
  assert.equal(resumed.welcome.resumed, true);
  assert.equal(resumed.id, guest.id);
  const history = await resumed.waitFor('m.chatState');
  assert.deepEqual(history.messages.map((m) => m.text), ['msg0', 'msg1', 'msg2']);
  await expectError(resumed, { t: 'room.chat', matchId: snap.matchId, text: 'no reset' }, ERR.RATE);
  const before = resumed.log.filter((m) => m.t === 'm.chatState').length;
  for (let n = 0; n < 4; n++) await resumed.hello('Guest', resumed.token);
  await resumed.expectNone('m.chatState', () => true, 100);
  assert.equal(resumed.log.filter((m) => m.t === 'm.chatState').length, before);
  advance(2000);
  assert.equal((await requestChat(resumed, snap.matchId, 'refilled')).t, 'ok');
  assert.equal((await host.waitFor('m.chat', (m) => m.text === 'refilled')).playerId, guest.id);
  assert.equal(room.matchCtx.chat.snapshot().seq, 4);
});

test('all running phases, eliminated and autoplay humans can chat; RESULT and end erase history and replay excludes bodies', async (t) => {
  const { room, host, guest, start, advance } = await fixture(t);
  const snap = await start();
  const match = room.match;
  const ctx = room.matchCtx;
  const player = match.players.get(guest.id);
  player.alive = false;
  player.autoplay = true;
  for (const phase of [PHASE.INFO_CHECK, PHASE.BAND_DRAFT, PHASE.PREP, PHASE.SP_DRAFT, PHASE.COMBAT, PHASE.UNITE,
    PHASE.FINAL_ASSAULT, PHASE.HIDDEN_CORE]) {
    match.phase = phase;
    assert.equal((await requestChat(guest, snap.matchId, `phase:${phase}`)).t, 'ok');
    advance();
  }
  match.phase = PHASE.RESULT;
  await expectError(guest, { t: 'room.chat', matchId: snap.matchId, text: 'RESULT blocked' }, ERR.WRONG_PHASE);
  match.phase = PHASE.INFO_CHECK;
  match.maybeFinish(true);
  await host.waitFor('m.result');
  await host.waitFor('room.state', (m) => m.inMatch === false);
  assert.equal(ctx.chat.closed, true);
  assert.equal(ctx.chat.snapshot(), null);
  assert.equal(ctx.chat.messages.length, 0);
  assert.equal(ctx.chat.players.size, 0);
  assert.equal(room.toState().chatMatchId, null);
  assert.equal(JSON.stringify(room.replay).includes('phase:'), false);
  await expectError(host, { t: 'room.chat', matchId: snap.matchId, text: 'after' }, ERR.WRONG_PHASE);
  assert.equal((await guest.request({ t: 'room.ready', ready: true })).t, 'ok');
  const next = await start();
  assert.notEqual(next.matchId, snap.matchId);
  assert.deepEqual(next.messages, []);
  await expectError(host, { t: 'room.chat', matchId: snap.matchId, text: 'old queued intent' }, ERR.BAD_TARGET);
});

test('RESULT broadcast closes chat before onEnd; failed start and last-human room disposal release chat', async (t) => {
  const { srv, room, host, guest, start } = await fixture(t);
  const snap = await start();
  const ctx = room.matchCtx;
  assert.equal((await requestChat(host, snap.matchId, 'release this body')).t, 'ok');
  room.match.phase = PHASE.RESULT;
  room.match.broadcastFn(room.match.publicView());
  assert.equal(ctx.chat.snapshot(), null);
  assert.equal(ctx.chat.messages.length, 0);
  room.match.phase = PHASE.INFO_CHECK;
  room.match.maybeFinish(true);
  let failedCtx;
  const dispose = srv.lobby.disposeMatchCtx.bind(srv.lobby);
  srv.lobby.disposeMatchCtx = (context) => { failedCtx = context; dispose(context); };
  class FailingMatch extends HeldChatMatch { start() { throw new Error('planned chat start failure'); } }
  srv.lobby.MatchClass = FailingMatch;
  assert.equal((await guest.request({ t: 'room.ready', ready: true })).t, 'ok');
  await expectError(host, { t: 'room.start' }, ERR.INTERNAL);
  assert.ok(failedCtx);
  assert.equal(failedCtx.chat.closed, true);
  assert.equal(room.toState().chatMatchId, null);
  srv.lobby.MatchClass = HeldChatMatch;
  const next = await start();
  const active = room.matchCtx;
  assert.equal((await requestChat(host, next.matchId, 'room destruction body')).t, 'ok');
  assert.equal((await guest.request({ t: 'room.leave' })).t, 'ok');
  assert.equal((await host.request({ t: 'room.leave' })).t, 'ok');
  assert.equal(srv.lobby.getRoom(room.code), null);
  assert.equal(active.chat.closed, true);
  assert.equal(active.chat.messages.length, 0);
  assert.equal(active.chat.players.size, 0);
});
