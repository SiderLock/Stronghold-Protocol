// Real HTTP/WebSocket admission tests. Match checks stop during briefing; no full game is run.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import WebSocket from 'ws';
import { startServer } from '../server/index.js';
import { StubMatch } from '../server/match/StubMatch.js';
import { Match } from '../server/match/Match.js';
import { writeServerSettings } from '../server/serverSettings.js';
import { TestClient } from './helpers/wsClient.js';
import { Net } from '../public/js/net.js';
import { validateC2S } from '../shared/protocol.js';
import { encodeWire, decodeWire } from '../shared/wireCodec.js';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const files = [{ url: '/assets/admission.png', bytes: 7, sha256: hash('fixture'), type: 'image/png', aliases: [] }];
const catalog = { schema: 1, version: hash(JSON.stringify({ schema: 1, files })), app: 'admission fixture', files,
  totalFiles: 1, totalBytes: 7, complete: true, missing: [] };
const report = { schema: 1, version: catalog.version, readyFiles: 1, readyBytes: 7 };
const create = { t: 'room.create', mode: 'coop', difficulty: 'NORMAL', capacity: 20 };
const intents = (code, roomId) => [create, { t: 'room.join', code }, { t: 'lobby.quickMatch', capacity: 20 },
  { t: 'room.spectate', code }, ...(roomId ? [{ t: 'lobby.join', roomId }, { t: 'lobby.spectate', roomId }] : [])];

async function fixture(t, { required = false, buildCatalog = async () => catalog, MatchClass = StubMatch } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-admission-'));
  const clients = [], nets = [];
  let server;
  t.after(async () => {
    for (const net of nets) net.close();
    await Promise.all(clients.map((client) => client.terminate()));
    await server?.close();
    assert.equal(path.dirname(dir), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith('sp-admission-'));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  writeServerSettings(dir, { maxAiPerRoom: null, requireAssetCache: required });
  server = await startServer({ port: 0, host: '127.0.0.1', quiet: true, MatchClass,
    serverSettingsDir: dir, assetCacheBuildCatalog: buildCatalog, maxConnectionsPerAddr: 100,
    maxRoomsPerAddr: 100, maxMatchesPerAddr: 100, heavyPerSec: 100, heavyBurst: 100 });
  const url = `ws://127.0.0.1:${server.port}/ws`;
  const connect = async (name, wire = false, token) => {
    const client = await TestClient.connect(url, { wire });
    clients.push(client);
    client.welcome = await client.hello(name, token);
    return client;
  };
  const policy = (value) => {
    writeServerSettings(dir, { requireAssetCache: value });
    server.serverSettings.poll();
  };
  const browserNet = async (getAssetCacheReadiness) => {
    const net = new Net({ url, WebSocket, getAssetCacheReadiness });
    nets.push(net);
    let timer, stop;
    try {
      await new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('browser Net handshake timed out')), 3000);
        stop = net.on('status', ({ status }) => { if (status === 'online') resolve(); });
        net.setName('Browser');
      });
    } finally { clearTimeout(timer); stop?.(); }
    return net;
  };
  return { server, connect, policy, browserNet };
}

test('optional admission allows all six entry routes and never builds the full directory for these requests', async (t) => {
  let builds = 0;
  const { server, connect } = await fixture(t, { buildCatalog: async () => { builds++; return catalog; } });
  const host = await connect('Host');
  assert.equal(host.welcome.requireAssetCache, false);
  assert.equal((await host.request(create)).t, 'ok');
  const room = await host.waitFor('room.state');
  for (const [index, intent] of intents(room.code, server.lobby.getRoom(room.code).directoryId).entries()) {
    const guest = await connect(`Guest ${index}`, index % 2 === 0);
    assert.equal((await guest.request(intent)).t, 'ok', intent.t);
  }
  assert.equal(builds, 0, 'ordinary entry never obtains a directory');
  assert.equal(server.lobby.rooms.size, 2);
});

for (const wire of [false, true]) {
  test(`strict admission validates all six routes on ${wire ? 'compact v1' : 'legacy JSON'} sockets`, async (t) => {
    const { server, connect } = await fixture(t, { required: true });
    const host = await connect('Host', wire);
    assert.equal(host.welcome.requireAssetCache, true);
    assert.equal((await host.request({ ...create, assetCache: report })).t, 'ok');
    const room = await host.waitFor('room.state');
    const guest = await connect('Guest', wire);
    for (const intent of intents(room.code, server.lobby.getRoom(room.code).directoryId)) {
      for (const invalid of [undefined, { ...report, readyFiles: 0 }, { ...report, readyBytes: 6 },
        { ...report, version: 'f'.repeat(64) }]) {
        const reply = await guest.request({ ...intent, ...(invalid ? { assetCache: invalid } : {}) });
        assert.equal(reply.code, 'ASSET_CACHE_REQUIRED', intent.t);
        assert.doesNotMatch(reply.detail, /version/i, 'cache errors must not turn into the generic client-update warning');
        assert.equal(server.registry.byId(guest.welcome.playerId).roomCode, null);
        assert.equal(server.lobby.rooms.size, 1, 'denial must not create an empty room');
      }
      assert.equal((await guest.request({ ...intent, assetCache: report })).t, 'ok', intent.t);
      assert.equal((await guest.request({ t: 'room.leave' })).t, 'ok');
    }
    assert.equal((await guest.request({ ...create, assetCache: { ready: true } })).code, 'BAD_MSG');
  });
}

test('denied switching preserves the original room, seat, host and spectators', async (t) => {
  const { server, connect } = await fixture(t, { required: true });
  const guest = await connect('Original');
  const host = await connect('Target');
  for (const client of [guest, host]) assert.equal((await client.request({ ...create, assetCache: report })).t, 'ok');
  const old = server.lobby.getRoom(server.registry.byId(guest.welcome.playerId).roomCode);
  const target = server.lobby.getRoom(server.registry.byId(host.welcome.playerId).roomCode);
  for (const intent of intents(target.code, target.directoryId)) {
    assert.equal((await guest.request(intent)).code, 'ASSET_CACHE_REQUIRED');
    assert.equal(server.registry.byId(guest.welcome.playerId).roomCode, old.code);
    assert.equal(old.hostId, guest.welcome.playerId);
    assert.equal(old.seats[0].playerId, guest.welcome.playerId);
    assert.equal(target.spectators.length, 0);
    assert.equal(server.lobby.rooms.size, 2);
  }
  assert.equal((await guest.request({ t: 'room.join', code: old.code })).t, 'ok', 'same-room resync is not new admission');
  assert.equal((await guest.request({ t: 'room.spectate', code: target.code, assetCache: report })).t, 'ok');
  assert.equal((await guest.request({ t: 'room.spectate', code: target.code })).t, 'ok', 'same-role spectator resync is preserved');
  assert.equal((await guest.request({ t: 'room.join', code: target.code })).code, 'ASSET_CACHE_REQUIRED', 'spectator-to-player is new admission');
  assert.ok(target.spectatorOf(guest.welcome.playerId));
  assert.equal(target.seatOf(guest.welcome.playerId), null);
  assert.equal((await guest.request({ t: 'room.join', code: target.code, assetCache: report })).t, 'ok');
  assert.equal(target.spectatorOf(guest.welcome.playerId), null);
});

test('dynamic enabling is fail-closed while the summary warms, never applies an earlier denied intent, and can be disabled', async (t) => {
  let release, builds = 0;
  const pending = new Promise((resolve) => { release = resolve; });
  const { server, connect, policy } = await fixture(t, { buildCatalog: () => { builds++; return pending; } });
  const watcher = await connect('Watcher', true);
  assert.equal((await watcher.request({ t: 'lobby.watch', on: true })).requireAssetCache, false);
  policy(true);
  assert.equal(server.lobby.requireAssetCache, true);
  assert.equal((await watcher.request({ ...create, assetCache: report })).code, 'ASSET_CACHE_REQUIRED');
  await watcher.waitFor('lobby.state', (value) => value.requireAssetCache === true, 3500);
  assert.equal(server.lobby.rooms.size, 0);
  release(catalog);
  const summary = await (await fetch(`${server.url}/api/asset-cache/status`)).json();
  assert.equal(summary.requireAssetCache, true);
  assert.equal(builds, 1);
  assert.equal(server.lobby.rooms.size, 0, 'asynchronous warming cannot execute a denied intent later');
  assert.equal((await watcher.request({ ...create, assetCache: report })).t, 'ok');
  policy(false);
  const newcomer = await connect('Newcomer');
  assert.equal(newcomer.welcome.requireAssetCache, false);
  assert.equal((await newcomer.request(create)).t, 'ok');
});

for (const [name, buildCatalog] of [
  ['missing server files', async () => ({ ...catalog, complete: false, missing: ['/assets/missing.png'] })],
  ['inconsistent completeness', async () => ({ ...catalog, missing: ['/assets/missing.png'] })],
  ['unavailable directory', async () => { throw new Error('fixture storage unavailable'); }],
]) {
  test(`strict admission rejects even a count-matching report when there are ${name}`, async (t) => {
    const { server, connect } = await fixture(t, { required: true, buildCatalog });
    const client = await connect('Guest');
    assert.equal((await client.request({ ...create, assetCache: report })).code, 'ASSET_CACHE_REQUIRED');
    assert.equal(server.lobby.rooms.size, 0);
  });
}

test('enabling strict mode preserves an ongoing match and reconnects without any cache report', async (t) => {
  const { server, connect, policy } = await fixture(t, { MatchClass: Match });
  const host = await connect('Host');
  assert.equal((await host.request(create)).t, 'ok');
  const room = await host.waitFor('room.state');
  const viewer = await connect('Viewer');
  assert.equal((await viewer.request({ t: 'room.spectate', code: room.code })).t, 'ok');
  assert.equal((await host.request({ t: 'room.start' })).t, 'ok');
  await host.waitFor('m.public');
  const match = server.lobby.getRoom(room.code).match;
  policy(true);
  for (const client of [host, viewer]) {
    await client.terminate();
    const resumed = await connect(client.welcome.name, true, client.welcome.token);
    assert.equal(resumed.welcome.resumed, true);
    assert.equal(resumed.welcome.playerId, client.welcome.playerId);
    assert.equal(resumed.welcome.requireAssetCache, true);
    await resumed.waitFor('m.public');
    assert.equal(server.registry.byId(resumed.welcome.playerId).roomCode, room.code);
    assert.equal(server.lobby.getRoom(room.code).match, match);
  }
});

test('readiness and policy extensions preserve compact-v1 layouts and restore standard JSON', () => {
  for (const intent of intents('ABCD', '93b479b7-ff62-4f3b-a06a-5f0ac230dc9e')) {
    const message = { ...intent, assetCache: report, rid: 3 };
    assert.equal(validateC2S(message), null);
    assert.deepEqual(decodeWire(encodeWire(message, 'c2s'), 'c2s'), message);
  }
  for (const message of [
    { t: 'welcome', playerId: 'p_1', token: 't', name: 'Guest', serverNow: 1, requireAssetCache: true },
    { t: 'lobby.state', online: 3, roomCount: 1, matchCount: 0, playingCount: 0, joinableCount: 1, requireAssetCache: true },
    { t: 'error', code: 'ASSET_CACHE_REQUIRED', msg: 'precache required', detail: 'precache-missing', rid: 3 },
  ]) assert.deepEqual(decodeWire(encodeWire(message, 's2c'), 's2c'), message);
});

test('browser Net obtains readiness only for new membership and sends it through compact real sockets', async (t) => {
  const { server, connect, browserNet } = await fixture(t, { required: true });
  const host = await connect('Host');
  assert.equal((await host.request({ ...create, assetCache: report })).t, 'ok');
  const room = await host.waitFor('room.state');
  let scans = 0;
  const net = await browserNet(async () => { scans++; return report; });
  assert.equal(scans, 0, 'hello and resume must not wait for storage');
  assert.equal(net.wireVersion, 1);
  for (const intent of intents(room.code, server.lobby.getRoom(room.code).directoryId)) {
    const { t: type, ...fields } = intent;
    assert.equal((await net.request(type, fields)).t, 'ok');
    assert.equal((await net.request('room.leave')).t, 'ok');
  }
  assert.equal(scans, 6);
  assert.equal(server.lobby.rooms.size, 1);
  await assert.rejects(net.request('room.create', { mode: 'invalid', difficulty: 'NORMAL' }), (error) => error.code === 'BAD_MSG');
  assert.equal(scans, 6, 'local validation occurs before a disk scan');
});

test('browser Net waits for local readiness before sending, and an unavailable cache stays usable only in optional mode', async (t) => {
  const { server, policy, browserNet } = await fixture(t, { required: true });
  let release;
  const readiness = new Promise((resolve) => { release = resolve; });
  const net = await browserNet(() => readiness);
  const pending = net.request('room.create', { mode: 'coop', difficulty: 'NORMAL', capacity: 20 });
  assert.equal(server.lobby.rooms.size, 0);
  assert.equal(net.pendingCount, 0, 'a wire timeout does not start during the storage scan');
  release(report);
  assert.equal((await pending).t, 'ok');
  await net.request('room.leave');
  for (const getReadiness of [() => null, () => { throw new Error('storage blocked'); },
    () => Promise.reject(new Error('storage failed'))]) {
    net.getAssetCacheReadiness = getReadiness;
    await assert.rejects(net.request('room.create', { mode: 'coop', difficulty: 'NORMAL' }), (error) =>
      error.code === 'ASSET_CACHE_REQUIRED' && error.message.includes('预缓存'));
    policy(false);
    assert.equal((await net.request('room.create', { mode: 'coop', difficulty: 'NORMAL' })).t, 'ok');
    await net.request('room.leave');
    policy(true);
  }
});
