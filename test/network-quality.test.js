import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { RecentPeak } from '../shared/networkTiming.js';
import { ConnectionQuality } from '../public/js/connectionQuality.js';
import { Net } from '../public/js/net.js';
import { prepareMessage, sendPrepared, sendRaw, send, NET_DEFAULTS } from '../server/net.js';
import { startServer } from '../server/index.js';
import { TestClient } from './helpers/wsClient.js';

class Socket extends EventEmitter {
  constructor() { super(); this.readyState = 1; this.bufferedAmount = 0; this.sent = []; }
  send(data, cb) { this.sent.push(JSON.parse(data)); cb?.(); }
  terminate() { this.readyState = 3; this.emit('close'); }
}
const publicState = (n, fields = {}) => ({ t: 'm.public', phase: 'PREP', round: 1, deadline: 20000,
  paused: false, serverNow: n, players: [], fields: [], ...fields });

test('slow recipient retains only the newest adjacent full state and drains without further traffic', async () => {
  const slow = new Socket(), fast = new Socket();
  slow.bufferedAmount = 100000;
  try {
    for (let i = 0; i < 100; i++) {
      const prepared = prepareMessage(publicState(i));
      assert.equal(sendPrepared(slow, prepared), true);
      assert.equal(sendPrepared(fast, prepared), true);
    }
    assert.equal(slow.sent.length, 0);
    assert.equal(fast.sent.length, 100, 'one slow peer does not slow a healthy peer');
    slow.bufferedAmount = 0;
    await delay(90);
    assert.deepEqual(slow.sent, [publicState(99)], 'latest state is delivered even without a new broadcast');
  } finally { slow.terminate(); fast.terminate(); }
});

test('replies, combat events, phase/deadline/pause/revision changes and stored frames are ordering barriers', () => {
  for (const barrier of [
    { t: 'ok', rid: 1 }, { t: 'b.start', fieldId: 'f' }, { t: 'b.end', fieldId: 'f' }, { t: 'm.result' },
    publicState(5, { phase: 'COMBAT' }), publicState(5, { round: 2 }), publicState(5, { deadline: 40000 }),
    publicState(5, { paused: true }), publicState(5, { setupRevision: 2 }), publicState(5, { emergencyFrozen: true }),
  ]) {
    const ws = new Socket(); ws.bufferedAmount = 100000;
    try {
      send(ws, publicState(1)); send(ws, publicState(2)); send(ws, barrier);
      sendRaw(ws, JSON.stringify({ t: 'room.closed', reason: 'ended' }));
      assert.deepEqual(ws.sent, [publicState(2), barrier, { t: 'room.closed', reason: 'ended' }]);
    } finally { ws.terminate(); }
  }
});

test('closed recipients clear deferred state, and dropped snapshots avoid expensive serialization', async () => {
  const ws = new Socket(); ws.bufferedAmount = 100000;
  send(ws, publicState(1)); ws.terminate();
  await delay(70);
  assert.deepEqual(ws.sent, []);
  const full = new Socket(); full.bufferedAmount = NET_DEFAULTS.snapDropBytes + 1;
  let encoded = 0;
  assert.equal(send(full, { t: 'b.snap', get expensive() { encoded++; return 'x'; } }), false);
  assert.equal(encoded, 0);
  full.bufferedAmount = NET_DEFAULTS.hardBufferBytes + 1;
  assert.equal(send(full, { t: 'ok', rid: 2 }), false);
  assert.equal(full.readyState, 3);
});

test('recent peaks expire and storage stays bounded even during a sustained message flood', () => {
  let now = 10000;
  const peak = new RecentPeak(() => now);
  assert.equal(peak.read(), null);
  for (let i = 0; i < 20000; i++) peak.add(300);
  assert.equal(peak.buckets.size, 1);
  now += 9000;
  assert.equal(peak.read(), null);
});

test('quality requires sustained evidence, distinguishes page/server stalls, and keeps path attribution neutral', () => {
  const quality = new ConnectionQuality();
  assert.equal(quality.sample({ rtt: 400 }).cause, null);
  assert.equal(quality.sample({ rtt: 450 }).cause, 'connection');
  quality.sample({ rtt: 30 }); // recovery itself may have a large RTT delta
  quality.sample({ rtt: 30 });
  assert.equal(quality.sample({ rtt: 30 }).cause, null);
  for (const cause of ['device', 'server', 'connection']) {
    quality.reset();
    const sample = { rtt: 400, clientLag: cause === 'device' ? 300 : 0,
      server: cause === 'server' ? { loopMs: 200, loopAgeMs: 10, handlerMs: 0, queuedBytes: 0 } : null };
    quality.sample(sample);
    assert.equal(quality.sample(sample).cause, cause);
  }
  assert.equal(quality.sample({ rtt: 2000, clientLag: 1500, visible: false }), null);
  assert.equal(quality.sample({ rtt: 30 }).cause, null, 'returning from background starts fresh');
  quality.reset();
  const historical = { rtt: 400, server: { loopMs: 500, loopAgeMs: 3000 } };
  quality.sample(historical);
  assert.equal(quality.sample(historical).cause, 'connection', 'an old server stall does not explain this probe');
  quality.reset();
  const oldPage = { rtt: 400, clientLag: 500, clientLagAge: 3000 };
  quality.sample(oldPage);
  assert.equal(quality.sample(oldPage).cause, 'connection', 'an old page stall does not explain this probe');
});

test('Net exposes diagnostics, ignores invalid measurements and resets evidence on disconnect', () => {
  let now = 10000;
  const net = new Net({ now: () => now });
  net._lagDue = now + 250;
  const pong = (d) => {
    now += 40; net._lagDue = now + 250;
    net._onPong({ c: now - 40, s: now - 20, d });
  };
  pong({ loopMs: 200, loopAgeMs: 0, handlerMs: 0, queuedBytes: 0, sendMs: 1 });
  pong({ loopMs: 200, loopAgeMs: 0, handlerMs: 0, queuedBytes: 0, sendMs: 1 });
  assert.equal(net.snapshot().quality.cause, 'server');
  pong({ loopMs: -5, handlerMs: '200', queuedBytes: Infinity, sendMs: null });
  assert.deepEqual(net.snapshot().quality.server, { loopMs: null, loopAgeMs: null, handlerMs: null, handlerAgeMs: null,
    queuedBytes: null, sendMs: null });
  net.close(); assert.equal(net.snapshot().quality, null);
});

test('real legacy and compact pongs carry optional evidence and private health exposes aggregate metrics', async (t) => {
  const server = await startServer({ port: 0, host: '127.0.0.1', quiet: true });
  const clients = [];
  t.after(async () => { await Promise.all(clients.map(c => c.terminate())); await server.close(); });
  for (const wire of [false, true]) {
    const client = await TestClient.connect(`ws://127.0.0.1:${server.port}/ws`, { wire });
    clients.push(client); await client.hello(wire ? 'compact' : 'legacy');
    const pong = await client.request({ t: 'ping', c: Date.now() });
    assert.ok(Number.isFinite(pong.d.loopMs));
    assert.equal(pong.d.queuedBytes >= 0, true);
    assert.equal(pong.rid > 0, true);
  }
  const publicHealth = await (await fetch(`${server.url}/healthz`)).json();
  assert.equal(publicHealth.network, undefined);
  const health = await (await fetch(`${server.url}/healthz?traffic=1`)).json();
  assert.ok(Number.isFinite(health.network.loopMs));
  assert.equal(health.network.activeConnections, 0, 'lobby visitors do not corroborate match congestion');
});
