// Four 20-seat rooms + four spectators: real sockets, synthetic full public views, capped outbound test link.
// Concurrent cold HTTP downloads exercise the compression pool too. No 80-human gameplay or round-14 run.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { startServer } from '../server/index.js';
import { TestClient } from './helpers/wsClient.js';
import { bandwidthProxy } from './helpers/bandwidthProxy.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Optional transitional stress run; uses the same publisher/limiter and the same latency criterion.
const MIXED = process.env.SP_WIRE_PRESSURE_MIXED === '1';
const OUT = path.join(ROOT, '.cache', 'compact-wire', MIXED ? 'pressure-mixed-report.json' : 'pressure-report.json');
const quantile = (values, q) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * q))];

test(`84 ${MIXED ? 'mixed' : 'compact'} sockets in four rooms retain control/resync at 0.8 Mbps application budget plus cold HTTP`, { timeout: 60_000 }, async (t) => {
  const server = await startServer({ port: 0, host: '127.0.0.1', quiet: true, seedFn: () => 123 });
  const proxy = await bandwidthProxy(server.port);
  const clients = []; const rooms = []; const rtt = []; const errors = []; const report = {}; const pings = [];
  const intentionalCloses = new Set();
  const loop = monitorEventLoopDelay({ resolution: 10 });
  try {
    const connect = async (name, wire, token) => {
      // ws uses a process-global limiter, initialized by its first client OR server instance.
      // Match the production bound when test clients live in this server process too.
      const client = await TestClient.connect(`ws://127.0.0.1:${proxy.port}/ws`, {
        wire, timeout: 8000, wsOptions: { perMessageDeflate: { concurrencyLimit: 4 } },
      });
      clients.push(client); const hello = await client.hello(name, token);
      client.id = hello.playerId; client.token = hello.token; return client;
    };
    for (let n = 0; n < 4; n++) {
      const players = [];
      for (let i = 0; i < 20; i++) players.push(await connect(`R${n + 1}P${i + 1}`, !MIXED || i % 2 === 0));
      const host = players[0];
      assert.equal((await host.request({ t: 'room.create', mode: 'coop', difficulty: 'HARD', capacity: 20 })).t, 'ok');
      const state = await host.waitFor('room.state');
      for (const player of players.slice(1)) {
        assert.equal((await player.request({ t: 'room.join', code: state.code })).t, 'ok');
        assert.equal((await player.request({ t: 'room.ready', ready: true })).t, 'ok');
      }
      const spectator = await connect(`R${n + 1}Viewer`, true);
      assert.equal((await spectator.request({ t: 'room.spectate', code: state.code })).t, 'ok');
      assert.equal((await host.request({ t: 'room.start' })).t, 'ok');
      await Promise.all([...players, spectator].map((c) => c.waitFor('m.public', (m) => m.phase === 'INFO_CHECK')));
      const room = server.lobby.getRoom(state.code); const view = room.match.publicView();
      view.phase = 'COMBAT';
      view.players = view.players.map((p) => ({ ...p, status: 'combat', bonds: Array.from({ length: 18 }, (_, i) =>
        ({ bondId: `bond_${i}`, count: i % 5, active: i % 2 === 0, tier: i % 3, layers: i * 7, off: false, thresholds: [2, 4, 6] })) }));
      view.fields = view.players.map((p) => ({ fieldId: `n:${p.playerId}`, kind: 'normal', players: [p.playerId], live: true,
        progress: { killed: 0, resolved: 0, total: 100, done: false } }));
      rooms.push({ room, view, players, spectator });
    }
    for (const client of clients) {
      assert.equal(client.wireVersion, client.wantWire ? 1 : 0); assert.equal(client.ws.extensions, 'permessage-deflate');
    }
    for (const client of clients) { client.log.length = client.rawLog.length = client.inbox.length = 0; }
    const initialBytes = clients.map((c) => c.ws._socket.bytesRead);
    const started = performance.now(); let originalBytes = 0;
    proxy.limit(100_000); // 0.8 Mbps of application bytes; leave nominal 1 Mbps room for framing/packet overhead.
    loop.enable();
    // Four cold large-JSON downloads share exactly the same limiter as the 84 WebSockets.
    const downloads = Promise.all(['chess', 'backups', 'assets', 'enemies'].map(async (file) => {
      const response = await fetch(`http://127.0.0.1:${proxy.port}/data/${file}.json`, {
        headers: { 'Accept-Encoding': 'br', Connection: 'close' }, signal: AbortSignal.timeout(45_000),
      });
      assert.equal(response.status, 200); assert.equal(response.headers.get('content-encoding'), 'br');
      const body = await response.arrayBuffer(); return { file, decodedBytes: body.byteLength };
    }));
    // Attach a handler immediately so a download failure cannot become an unhandled rejection during the loop.
    downloads.catch((error) => errors.push(error.message));
    const stamp = Date.now();
    for (let tick = 0; tick < 40; tick++) {
      const target = started + tick * 200;
      if (performance.now() < target) await delay(target - performance.now());
      for (const { room, view } of rooms) {
        view.serverNow = stamp + tick;
        const field = view.fields[tick % 20]; field.progress.killed++; field.progress.resolved++;
        originalBytes += Buffer.byteLength(JSON.stringify(view)) * 21;
        server.lobby.matchBroadcast(room, room.matchCtx, view);
      }
      if (tick % 5 === 0) {
        const probe = Promise.all(clients.map(async (client) => {
          const before = performance.now();
          assert.equal((await client.request({ t: 'ping', c: Date.now() }, 8000)).t, 'pong');
          rtt.push(performance.now() - before);
        }));
        // Probes must not delay the 5 Hz publisher and then create artificial catch-up bursts.
        probe.catch((error) => errors.push(error.message)); pings.push(probe);
      }
      if (tick !== 39) for (const client of clients) { client.log.length = client.rawLog.length = client.inbox.length = 0; }
    }
    await Promise.all(clients.map((c) => c.waitFor('m.public', (m) => m.serverNow === stamp + 39, 8000)));
    await Promise.all(pings);
    const wsBytes = clients.reduce((sum, client, i) => sum + client.ws._socket.bytesRead - initialBytes[i], 0);
    report.downloads = await downloads;
    assert.deepEqual(errors, []); assert.equal(clients.every((c) => c.isOpen), true, 'no client drops during the bottleneck');
    report.unexpectedDrops = 0;
    const prior = rooms[0].players[1]; intentionalCloses.add(prior); await prior.terminate();
    const resumed = await connect('R1P2', true, prior.token);
    assert.equal(resumed.id, prior.id);
    const sync = await resumed.waitFor('m.public', (m) => m.players.length === 20, 8000);
    assert.equal(sync.t, 'm.public'); await resumed.waitFor('m.private', () => true, 8000);
    for (const { room } of rooms) assert.equal(room.seats.filter(Boolean).length, 20);
    Object.assign(report, { rooms: 4, playerSockets: 80, spectators: 4, mixedWire: MIXED, allCompact: !MIXED, rawJsonBytes: originalBytes,
      actualWsBytes: wsBytes, pingSamples: rtt.length, rttP50Ms: quantile(rtt, 0.5), rttP95Ms: quantile(rtt, 0.95), rttMaxMs: Math.max(...rtt),
      eventLoopP99Ms: loop.percentile(99) / 1e6, elapsedSeconds: (performance.now() - started) / 1000,
      link: proxy.stats(), reconnectSameIdentity: true, limits: ['synthetic changing public views, not 80-human gameplay',
        'proxy shares application bytes fairly; not the cloud scheduler and not measured TLS/TCP/IP traffic',
        'Node clients and server share this local test process'] });
    assert.ok(quantile(rtt, 0.95) < 2000, `p95 control RTT ${quantile(rtt, 0.95)} ms`);
    assert.ok(wsBytes < originalBytes * 0.05, `WS ${wsBytes} / raw JSON ${originalBytes}`);
    t.diagnostic(`84 sockets: JSON ${originalBytes} B -> WS ${wsBytes} B; p95 ping ${report.rttP95Ms.toFixed(1)} ms under shared 0.8 Mbps`);
  } catch (error) {
    Object.assign(report, { failed: true, error: error.message, mixedWire: MIXED, allCompact: !MIXED, pingSamples: rtt.length,
      rttP95Ms: rtt.length ? quantile(rtt, 0.95) : null, rttMaxMs: rtt.length ? Math.max(...rtt) : null });
    throw error;
  } finally {
    loop.disable();
    report.completedPingSamples = rtt.length;
    report.linkBeforeCleanup = proxy.stats();
    report.intentionalReconnectDisconnects = intentionalCloses.size;
    report.unexpectedCloseInfo = clients.filter((c) => c.closeInfo && !intentionalCloses.has(c)).map((c) => c.closeInfo);
    await Promise.all(clients.map((c) => c.terminate().catch(() => {})));
    await proxy.close(); await server.close();
    assert.equal(server.server.listening, false);
    report.cleanup = { clients: clients.every((c) => c.closeInfo), proxy: true, server: true, serverPortReleased: true };
    await fs.mkdir(path.dirname(OUT), { recursive: true });
    await fs.writeFile(OUT, JSON.stringify(report, null, 2) + '\n', 'utf8');
  }
});
