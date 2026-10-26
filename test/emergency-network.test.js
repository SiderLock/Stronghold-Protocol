import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server/index.js';
import { createRequestHandler } from '../server/http/routes.js';
import { Network, SessionRegistry } from '../server/net.js';
import { TestClient } from './helpers/wsClient.js';

const log = { info() {}, warn() {}, error() {}, debug() {} };

test('emergency cuts website traffic and new identities while preserving a real match and authenticated resume', async (t) => {
  const server = await startServer({ port: 0, host: '127.0.0.1', quiet: true, bandwidthEmergency: false });
  const clients = [];
  t.after(async () => {
    await Promise.all(clients.map((client) => client.terminate()));
    await server.close();
    assert.equal(server.server.listening, false);
    assert.equal(server.bandwidthEmergency.status().closed, true);
  });
  const open = async () => {
    const client = await TestClient.connect(`ws://127.0.0.1:${server.port}/ws`, { wire: true });
    clients.push(client); return client;
  };
  const host = await open(); const guest = await open();
  const identity = await host.hello('host'); await guest.hello('guest');
  assert.equal((await host.request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL', capacity: 20 })).t, 'ok');
  const room = await host.waitFor('room.state');
  assert.equal((await guest.request({ t: 'room.join', code: room.code })).t, 'ok');
  await guest.request({ t: 'room.ready', ready: true });
  assert.equal((await host.request({ t: 'room.start' })).t, 'ok');
  await host.waitFor('m.public', (msg) => msg.phase === 'INFO_CHECK');
  const match = server.lobby.getRoom(room.code).match;
  const originalDeadline = match.deadline;

  assert.equal(server.bandwidthEmergency.trip('test-congestion'), true);
  const notice = await host.waitFor('m.emergency', (msg) => msg.active);
  assert.ok(JSON.stringify(notice).length < 200);
  // DEV-20261012-03: auto-resume default is 60s (was 120s).
  assert.equal(notice.retryAt - notice.since, 60000);
  await host.waitFor('m.public', (msg) => msg.emergencyFrozen);
  assert.equal(match.emergencyFrozen, true);
  assert.equal((await host.request({ t: 'g.infoReady' })).code, 'SERVER_EMERGENCY');
  assert.equal((await host.request({ t: 'room.start' })).code, 'SERVER_EMERGENCY');
  assert.equal((await host.request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL' })).code, 'SERVER_EMERGENCY');
  assert.equal((await host.request({ t: 'lobby.quickMatch' })).code, 'SERVER_EMERGENCY');
  assert.equal((await host.request({ t: 'room.join', code: room.code })).t, 'ok', 'same membership resync remains valid');
  assert.equal((await host.request({ t: 'ping', c: 1 })).t, 'pong');
  // Runtime shell stays up so an open/reloading match can still load the render engine (routes.js isEmergencyShellPath).
  for (const path of ['/', '/js/main.js', '/vendor/pixi.min.js', '/data/chess.json']) {
    const response = await fetch(`${server.url}${path}`);
    assert.equal(response.status, 200, path);
  }
  // Bulk art and the asset-cache fill API stay gated — that is what the emergency is for.
  for (const path of ['/assets/cold.png', '/fonts/cold.woff2', '/api/asset-cache/status', '/api/asset-cache/catalog']) {
    const response = await fetch(`${server.url}${path}`);
    assert.equal(response.status, 503, path);
    assert.equal(response.headers.get('connection'), 'close');
    assert.ok(Number(response.headers.get('retry-after')) <= 120);
    assert.ok((await response.text()).length < 250);
  }
  const health = await (await fetch(`${server.url}/healthz`)).json();
  assert.equal(health.bandwidthEmergency.active, true);
  assert.equal(health.matches, 1);
  const size = server.registry.size;
  const visitor = await open();
  const refused = await visitor.request({ t: 'hello', name: 'cold visitor', version: 1 });
  assert.equal(refused.code, 'SERVER_EMERGENCY');
  assert.equal(server.registry.size, size, 'no new session is allocated');

  await host.close();
  const resumed = await open();
  const welcome = await resumed.hello('host', identity.token);
  assert.equal(welcome.resumed, true);
  assert.equal(welcome.emergency.active, true);
  await resumed.waitFor('m.public', (msg) => msg.emergencyFrozen);
  assert.equal(server.lobby.getRoom(room.code).match, match);
  assert.equal(match.phase, 'INFO_CHECK');
  server.bandwidthEmergency.resume();
  await resumed.waitFor('m.emergency', (msg) => !msg.active);
  await resumed.waitFor('m.public', (msg) => !msg.emergencyFrozen);
  assert.ok(match.deadline >= originalDeadline);
  assert.equal((await fetch(`${server.url}/`)).status, 200);
});

test('HTTP protection cancels an ordinary response already streaming before the gate closes', async (t) => {
  let active = false;
  const listener = createRequestHandler({ log, emergency: () => ({ active }), serveStatic: async (_req, res) => {
    res.writeHead(200); res.write('partial ordinary asset');
  } });
  const server = http.createServer(listener);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  await new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: server.address().port, path: '/assets/large.png' }, (res) => {
      res.once('data', () => { active = true; listener.abortPublicRequests(); });
      res.once('aborted', resolve); res.once('error', () => {});
      res.once('end', () => reject(new Error('ordinary transfer unexpectedly completed')));
    });
    req.once('error', reject);
  });
});

test('frozen match token remains usable beyond its reconnect window; roomless token does not', () => {
  let now = 1000;
  const registry = new SessionRegistry({ now: () => now, reconnectWindowMs: 10 });
  const original = registry.create('original'); const roomless = registry.create('visitor');
  original.disconnectedAt = roomless.disconnectedAt = now;
  const network = new Network({ registry, now: () => now, log,
    handler: { onMessage() {}, allowEmergencyResume: (session) => session === original } });
  try {
    network.setEmergency({ active: true, startedAt: now });
    now += 100;
    network.sweep();
    assert.equal(registry.byId(original.playerId), original);
    assert.equal(registry.byId(roomless.playerId), null);
    const frames = [];
    const socket = new EventEmitter();
    Object.assign(socket, { readyState: 1, bufferedAmount: 0, send: (raw) => frames.push(JSON.parse(raw)), close() {} });
    network.handleConnection(socket);
    socket.emit('message', Buffer.from(JSON.stringify({ t: 'hello', name: 'original', token: original.token, version: 1 })), false);
    assert.equal(frames.find((msg) => msg.t === 'welcome')?.resumed, true);
    assert.equal(frames.find((msg) => msg.t === 'welcome')?.emergency.active, true);
    assert.equal(registry.size, 1);
  } finally { network.close(); }
});

test('trip closes finished ordinary HTTP sockets without closing the match WebSocket', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sp-emergency-http-'));
  const server = await startServer({ port: 0, host: '127.0.0.1', quiet: true, publicDir: root, bandwidthEmergency: false });
  const agent = new http.Agent({ keepAlive: true });
  const client = await TestClient.connect(`ws://127.0.0.1:${server.port}/ws`);
  t.after(async () => {
    agent.destroy(); await client.terminate(); await server.close();
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('sp-emergency-http-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  await client.hello('existing');
  await client.request({ t: 'room.create', mode: 'solo', difficulty: 'NORMAL' });
  await client.request({ t: 'room.start' });
  await fs.writeFile(path.join(root, 'large.png'), Buffer.alloc(262144));
  let ordinarySocket;
  const finished = new Promise((resolve) => server.server.on('request', (req, res) => {
    if (req.url === '/large.png') { ordinarySocket = req.socket; res.once('finish', resolve); }
  }));
  await new Promise((resolve, reject) => {
    const req = http.get(`${server.url}/large.png`, { agent }, (res) => {
      res.pause(); res.on('error', () => {}); resolve();
    });
    req.on('error', reject);
  });
  await finished;
  assert.equal(ordinarySocket.destroyed, false);
  server.bandwidthEmergency.trip('test-finished-queue');
  assert.equal(ordinarySocket.destroyed, true);
  assert.equal((await client.request({ t: 'ping', c: 3 })).t, 'pong');
});

test('an already saturated original match socket is retained without appending more emergency frames', () => {
  const registry = new SessionRegistry();
  const session = registry.create('original');
  const frames = []; let terminated = 0;
  const socket = new EventEmitter();
  Object.assign(socket, { readyState: 1, bufferedAmount: 20 * 1024 * 1024,
    send: (raw) => frames.push(JSON.parse(raw)), close() {}, terminate: () => { terminated++; } });
  const network = new Network({ registry, log, handler: { onMessage() {}, allowEmergencyResume: (s) => s === session } });
  try {
    network.handleConnection(socket);
    network.conns.get(socket).session = session;
    session.ws = socket; session.connected = true;
    network.setEmergency({ active: true, startedAt: Date.now() });
    assert.equal(terminated, 0);
    assert.equal(frames.length, 0, 'the old queue is not enlarged');
    socket.bufferedAmount = 0;
    network.setEmergency({ active: false });
    assert.equal(frames.at(-1).active, false);
  } finally { network.close(); }
});

test('repeated protected heartbeats keep the oldest unanswered ping as recovery evidence', async () => {
  let now = 1000;
  const registry = new SessionRegistry({ now: () => now });
  const session = registry.create('original');
  let pings = 0; let terminated = 0;
  const socket = new EventEmitter();
  Object.assign(socket, { readyState: 1, bufferedAmount: 0, send() {}, close() {},
    ping: () => { pings++; }, terminate: () => { terminated++; } });
  const network = new Network({ registry, now: () => now, log, handler: {
    onMessage() {}, allowEmergencyResume: (s) => s === session, roomOf: () => ({ match: {} }),
  } });
  try {
    network.handleConnection(socket);
    const conn = network.conns.get(socket);
    conn.session = session; session.ws = socket; session.connected = true;
    network.setEmergency({ active: true, startedAt: now });
    network.heartbeat();
    await new Promise(resolve => setImmediate(resolve));
    now += 30000;
    assert.equal(network.congestion().delayedHeartbeats, 1);
    network.heartbeat();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(pings, 2);
    assert.equal(terminated, 0);
    assert.equal(conn.pendingPingAt, 1000);
    assert.equal(network.congestion().impairedNetworks, 1, 'a new ping cannot erase the old delay');
    socket.emit('pong');
    assert.equal(network.congestion().delayedHeartbeats, 0);
    assert.equal(conn.pendingPingAt, null);
    network.heartbeat();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(conn.pendingPingAt, now);
    now += 3001;
    assert.equal(network.congestion().delayedHeartbeats, 1);
  } finally { network.close(); }
});
