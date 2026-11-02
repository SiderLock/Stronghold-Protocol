import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../server/index.js';
import { Net } from '../public/js/net.js';
import { encodeWire, decodeWire } from '../shared/wireCodec.js';
import { TestClient } from './helpers/wsClient.js';
import { makeMatch } from './match/harness.js';

async function serverFixture(t, opts = {}) {
  const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, ...opts });
  const clients = [];
  t.after(async () => { await Promise.all(clients.map((c) => c.terminate().catch(() => {}))); await srv.close(); });
  const connect = async (name, wire = false, token = undefined) => {
    const c = await TestClient.connect(`ws://127.0.0.1:${srv.port}/ws`, { wire });
    clients.push(c);
    c.welcome = await c.hello(name, token);
    c.id = c.welcome.playerId; c.token = c.welcome.token;
    return c;
  };
  return { srv, clients, connect };
}

test('20 physical clients + spectator: mixed wire formats, compression, broadcast and reconnect', { timeout: 20_000 }, async (t) => {
  const { srv, connect } = await serverFixture(t, { seedFn: () => 123 });
  const players = [];
  for (let i = 0; i < 20; i++) players.push(await connect(`P${i + 1}`, i % 2 === 0));
  const a = players[0];
  assert.equal((await a.request({ t: 'room.create', mode: 'coop', difficulty: 'HARD', capacity: 20 })).t, 'ok');
  const roomState = await a.waitFor('room.state');
  for (const c of players.slice(1)) {
    assert.equal((await c.request({ t: 'room.join', code: roomState.code })).t, 'ok');
    assert.equal((await c.request({ t: 'room.ready', ready: true })).t, 'ok');
  }
  const viewer = await connect('Viewer', true);
  assert.equal((await viewer.request({ t: 'room.spectate', code: roomState.code })).t, 'ok');
  assert.equal((await a.request({ t: 'room.start' })).t, 'ok');
  const clients = [...players, viewer];
  await Promise.all(clients.map((c) => c.waitFor('m.public', (m) => m.phase === 'INFO_CHECK')));
  for (const [i, c] of players.entries()) {
    assert.equal(c.ws.extensions, 'permessage-deflate');
    assert.equal(c.wireVersion, i % 2 === 0 ? 1 : 0);
    assert.equal(c.rawLog.some((m) => Array.isArray(m)), i % 2 === 0);
  }
  assert.equal(viewer.log.some((m) => m.t === 'm.private'), false, 'spectator never receives private data');

  // Representative full public views on real sockets. Transmission is deliberately unpaced to stress compression;
  // Production 8 Hz scheduling is checked independently below. This is not a twenty-human gameplay simulation.
  const room = srv.lobby.getRoom(roomState.code);
  const base = room.match.publicView();
  base.players = base.players.map((p) => ({ ...p, bonds: Array.from({ length: 18 }, (_, n) =>
    ({ bondId: `bond_${n}`, count: n % 6 + 1, active: n % 2 === 0, tier: n % 3, layers: n * 11 })) }));
  base.fields = base.players.map((p) => ({ fieldId: `n:${p.playerId}`, kind: 'normal', players: [p.playerId], live: true,
    progress: { killed: 0, resolved: 0, total: 100, done: false } }));
  const before = clients.map((c) => c.ws._socket.bytesRead);
  let originalBytes = 0;
  const stamp = Date.now() + 1000;
  for (let i = 0; i < 40; i++) {
    base.serverNow = stamp + i;
    base.fields[i % 20].progress.killed++;
    base.fields[i % 20].progress.resolved++;
    originalBytes += Buffer.byteLength(JSON.stringify(base)) * clients.length;
    srv.lobby.matchBroadcast(room, room.matchCtx, base);
  }
  await Promise.all(clients.map((c) => c.waitFor('m.public', (m) => m.serverNow === stamp + 39, 10_000)));
  const wireBytes = clients.reduce((n, c, i) => n + c.ws._socket.bytesRead - before[i], 0);
  assert.ok(wireBytes < originalBytes * 0.1, `${wireBytes}/${originalBytes} must save at least 90% on the repeated full views`);
  t.diagnostic(`mixed 20 + viewer: original JSON ${originalBytes} B, actual compressed WebSocket ${wireBytes} B`);
  for (const c of clients) assert.equal((await c.request({ t: 'ping', c: Date.now() })).t, 'pong');

  const prior = players[1]; // Its replacement changes from legacy JSON to compact; capability is not session state.
  await prior.terminate();
  const replacement = await connect('P2', true, prior.token);
  assert.equal(replacement.welcome.resumed, true);
  assert.equal(replacement.id, prior.id);
  assert.equal(replacement.wireVersion, 1);
  const resync = await replacement.waitFor('m.public');
  assert.equal(resync.players.length, 20);
  assert.equal(resync.phase, 'INFO_CHECK');
  await replacement.waitFor('m.private');
  assert.ok(srv.lobby.getRoom(roomState.code), 'reconnect preserves the room');
});

test('array opt-out, unnegotiated input, wrong direction and invalid layout retain session safety', async (t) => {
  const { connect } = await serverFixture(t);
  const c = await connect('Test');
  c.sendRaw(JSON.stringify(encodeWire({ t: 'ping', c: 1, rid: 555 }, 'c2s')));
  assert.equal((await c.waitFor('error')).code, 'BAD_MSG');
  const w = await c.hello('Test', c.token, { wire: 1 });
  assert.equal(w.wire, 1);
  for (const frame of [[2, 33, '0'], encodeWire({ t: 'm.public' }, 's2c'), [1, 33, '3', 1]]) {
    c.sendRaw(JSON.stringify(frame));
    assert.equal((await c.waitFor('error')).code, 'BAD_MSG');
    assert.equal((await c.request({ t: 'ping', c: 2 })).t, 'pong');
  }
  const legacy = await c.hello('Test', c.token, { wire: 0 });
  assert.equal(legacy.wire, undefined);
  assert.equal((await c.request({ t: 'ping', c: 3 })).t, 'pong');
  assert.ok(!Array.isArray(c.rawLog.at(-1)));
});

test('server compact rollback keeps new clients on original JSON', async (t) => {
  const { connect } = await serverFixture(t, { compactWire: false });
  const c = await connect('Rollback', true);
  assert.equal(c.wireVersion, 0);
  assert.equal(c.welcome.wire, undefined);
  assert.equal((await c.request({ t: 'ping', c: 1 })).t, 'pong');
  assert.equal(c.rawLog.some(Array.isArray), false);
});

test('RATE replies preserve rid in compact requests', async (t) => {
  const { connect } = await serverFixture(t, { ratePerSec: 1, rateBurst: 2 });
  const c = await connect('Limited', true);
  assert.equal((await c.request({ t: 'ping', c: 1 })).t, 'pong');
  const reply = await c.request({ t: 'ping', c: 2 });
  assert.equal(reply.t, 'error');
  assert.equal(reply.code, 'RATE');
});

test('64 KiB inbound cap applies after permessage-deflate inflation', async (t) => {
  const { connect } = await serverFixture(t);
  const c = await connect('Payload', true);
  assert.equal(c.ws.extensions, 'permessage-deflate');
  c.sendRaw(JSON.stringify({ t: 'ping', c: 1, pad: 'a'.repeat(90 * 1024) }));
  let timer;
  let closed;
  try {
    closed = await Promise.race([c.closed, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('oversize socket remained open')), 2000); timer.unref();
    })]);
  } finally { clearTimeout(timer); }
  assert.equal(closed.code, 1009);
});

function browserFixture(t) {
  const sockets = [];
  class Socket {
    constructor() { this.readyState = 0; this.sent = []; sockets.push(this); }
    send(s) { this.sent.push(JSON.parse(s)); }
    close(code) { this.readyState = 3; this.code = code; }
    open() { this.readyState = 1; this.onopen?.(); }
    recv(m) { this.onmessage?.({ data: JSON.stringify(m) }); }
  }
  let token = 'initial';
  const net = new Net({ WebSocket: Socket, getToken: () => token });
  net.on('welcome', (m) => { token = m.token; });
  t.after(() => net.close());
  net.setName('Browser');
  sockets[0].open();
  const welcome = (wire, ws = sockets.at(-1)) => ws.recv({ t: 'welcome', wire, token: 'resumable', playerId: 'p_1',
    rid: ws.sent.find((m) => m.t === 'hello').rid, name: 'Browser', version: 1, serverNow: Date.now() });
  return { net, sockets, welcome };
}

test('real browser Net decodes pushes and replies into original objects and encodes requests', async (t) => {
  const { net, sockets, welcome } = browserFixture(t);
  const ws = sockets[0];
  assert.equal(ws.sent[0].wire, 1);
  welcome(1);
  const promise = net.request('room.ready', { ready: true });
  const wire = ws.sent.at(-1);
  assert.ok(Array.isArray(wire));
  const request = decodeWire(wire, 'c2s');
  assert.equal(request.t, 'room.ready');
  ws.recv(encodeWire({ t: 'ok', rid: request.rid }));
  assert.equal((await promise).t, 'ok');
  let publicView;
  net.on('m.public', (m) => { publicView = m; });
  const view = { t: 'm.public', phase: 'COMBAT', players: [{ playerId: '中文', bonds: [] }], fields: [] };
  ws.recv(encodeWire(view));
  assert.deepEqual(publicView, view);
});

test('decode failure reconnects with the same identity and disables arrays for this page', async (t) => {
  const { net, sockets, welcome } = browserFixture(t);
  welcome(1);
  const pending = net.request('g.refresh');
  const rejected = assert.rejects(pending, (e) => e.code === 'DISCONNECTED');
  const warn = t.mock.method(console, 'warn', () => {});
  sockets[0].recv([99, 8, '0']);
  await rejected;
  assert.equal(warn.mock.callCount(), 1);
  assert.equal(sockets[0].code, 4000);
  assert.equal(net.wireVersion, 0);
  assert.equal(sockets.length, 2);
  sockets[1].open();
  const hello = sockets[1].sent.find((m) => m.t === 'hello');
  assert.equal(hello.token, 'resumable');
  assert.equal(hello.wire, undefined);
  welcome(undefined);
  assert.equal(net.status, 'online');
  const promise = net.request('g.ready', { ready: true });
  const message = sockets[1].sent.at(-1);
  assert.equal(message.t, 'g.ready');
  sockets[1].recv({ t: 'ok', rid: message.rid });
  await promise;
});

test('public changes coalesce to 8 Hz, deduplicate and retain immediate forced resync', () => {
  const h = makeMatch({ humans: 2, fake: true }).start();
  const m = h.m;
  try {
    const initial = h.bc.filter((v) => v.t === 'm.public').length;
    for (let i = 1; i <= 100; i++) {
      h.ps('p_0').lp = i;
      m.markPublic(); m.flush(); h.sched.advance(10);
    }
    const updates = h.bc.filter((v) => v.t === 'm.public').slice(initial);
    assert.equal(updates.length, 8);
    for (let i = 1; i < updates.length; i++) assert.equal(updates[i].serverNow - updates[i - 1].serverNow, 125);
    assert.equal(updates.at(-1).players[0].lp, 100);
    h.sched.advance(125); m.markPublic(); m.flush();
    assert.equal(h.bc.filter((v) => v.t === 'm.public').length, initial + 8, 'identical view is not resent');
    h.sched.advance(1); m.flush(true);
    assert.equal(h.bc.filter((v) => v.t === 'm.public').length, initial + 9);
    assert.equal(h.bc.at(-1).serverNow, h.sched.now());
  } finally { m.dispose(); }
});
