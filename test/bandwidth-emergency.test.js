import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BANDWIDTH_EMERGENCY_DEFAULTS, bandwidthEmergencyOptions, createBandwidthEmergencyController,
  createProcEgressSampler, defaultEgressInterface, interfaceTxBytes } from '../server/bandwidthEmergency.js';

function fixture(opts = {}) {
  let time = 0, txBytes = 0;
  let metrics = { activeDownloads: 2, demandClients: 2, remainingBytes: 100_000_000,
    blockedDownloads: 2, expectedBps: 1_000_000 };
  let congestion = false;
  const changes = [];
  const controller = createBandwidthEmergencyController({ env: {}, enabled: true, pollMs: 0, windowMs: 1_000, triggerMs: 3_000,
    now: () => time, getMetrics: () => metrics, getCongestion: () => congestion,
    sampleEgress: async () => ({ txBytes, interfaceName: 'eth0' }), onChange: (state) => changes.push(state), ...opts });
  return { controller, changes,
    setMetrics(next) { metrics = { ...metrics, ...next }; },
    setCongestion(next) { congestion = next; },
    async tick(bytesPerSecond = 250_000, ms = 1_000) {
      time += ms; txBytes += bytesPerSecond * ms / 1000; return controller.poll();
    },
    async initial() { return controller.poll(); },
  };
}

test('sustained low egress with independent blocked downloads trips after the full evidence duration', async () => {
  const f = fixture();
  try {
    await f.initial();
    await f.tick(); await f.tick(); await f.tick();
    assert.equal(f.controller.status().active, false);
    const state = await f.tick();
    assert.equal(state.active, true);
    assert.equal(state.source, 'automatic');
    assert.equal(state.detection.txBps, null, 'new emergency discards stale measurement evidence');
    assert.equal(f.changes.length, 1);
    assert.equal(f.changes[0].detection.txBps, 250_000);
    assert.equal(f.changes[0].detection.badForMs, 3_000);
    assert.equal(f.changes[0].metrics.remainingBytes, 100_000_000);
    assert.equal(state.retryAt, 64_000);
  } finally { f.controller.close(); }
});

test('default guard needs a five-second measured window plus fifteen seconds of sustained evidence', async () => {
  const f = fixture({ windowMs: BANDWIDTH_EMERGENCY_DEFAULTS.windowMs, triggerMs: BANDWIDTH_EMERGENCY_DEFAULTS.triggerMs });
  try {
    await f.initial();
    for (let i = 0; i < 19; i++) await f.tick();
    assert.equal(f.controller.status().active, false);
    await f.tick();
    assert.equal(f.controller.status().active, true);
  } finally { f.controller.close(); }
});

test('last trigger retains independent aggregate evidence through demand cleanup and resume without leaking identities', async () => {
  const f = fixture();
  try {
    assert.equal(f.controller.status().lastTrigger, null);
    f.setMetrics({ ip: '2001:db8::private', bytesWritten: 1_000_000 });
    f.setCongestion({ activeNetworks: 3, impairedNetworks: 0, maxBufferedBytes: 32_000, sessionIds: ['private-player'] });
    await f.initial();
    for (let i = 0; i < 4; i++) await f.tick();
    const expected = f.controller.status().lastTrigger;
    assert.equal(expected.at, 4_000);
    assert.equal(expected.source, 'automatic');
    assert.equal(expected.rule, 'cache-demand');
    assert.equal(expected.txBps, 250_000);
    assert.equal(expected.expectedBps, 1_000_000);
    assert.equal(expected.badForMs, 3_000);
    assert.equal(expected.metrics.bytesWritten, 1_000_000);
    assert.equal('ip' in expected.metrics, false);
    assert.equal('sessionIds' in expected.congestion, false);
    f.setMetrics({ activeDownloads: 0, expectedBps: 0, remainingBytes: 0 }); await f.tick();
    assert.equal(f.controller.status().metrics.activeDownloads, 0);
    assert.equal(f.controller.status().detection.rule, '');
    assert.deepEqual(f.controller.status().lastTrigger, expected);
    const exposed = f.controller.status().lastTrigger;
    exposed.txBps = 0; exposed.metrics.remainingBytes = 0; exposed.congestion.activeNetworks = 999;
    f.changes[0].lastTrigger.badForMs = 0;
    assert.deepEqual(f.controller.status().lastTrigger, expected, 'status and callback mutation cannot alter saved evidence');
    f.controller.resume();
    assert.deepEqual(f.controller.status().lastTrigger, expected, 'resume retains the previous trigger');
    f.controller.trip('new-manual-emergency');
    assert.equal(f.controller.status().lastTrigger.at, 5_000);
    assert.equal(f.controller.status().lastTrigger.source, 'manual');
    assert.equal(f.controller.status().lastTrigger.metrics.activeDownloads, 0);
  } finally { f.controller.close(); }
});

test('a slow single downloader is insufficient; a congested game connection corroborates it', async () => {
  const f = fixture();
  try {
    f.setMetrics({ activeDownloads: 2, demandClients: 1, expectedBps: 500_000 });
    await f.initial();
    for (let i = 0; i < 6; i++) await f.tick(100_000);
    assert.equal(f.controller.status().active, false, 'two files behind one IP are not independent demand');
    f.setCongestion({ congestedConnections: 1, maxBufferedBytes: 65_536, delayedHeartbeats: 0 });
    for (let i = 0; i < 4; i++) await f.tick(100_000);
    assert.equal(f.controller.status().active, true);
  } finally { f.controller.close(); }
});

test('multiple downloader IPv6 addresses from the same network need game corroboration', async () => {
  const f = fixture();
  try {
    f.setMetrics({ demandClients: 2, demandNetworks: 1 });
    await f.initial();
    for (let i = 0; i < 6; i++) await f.tick();
    assert.equal(f.controller.status().active, false);
  } finally { f.controller.close(); }
});

test('low demand, preparing leases and write queues without backpressure do not trigger', async () => {
  for (const metrics of [
    { expectedBps: 0, remainingBytes: 0 },
    { remainingBytes: 99 },
    { activeDownloads: 0 },
    { blockedDownloads: 0 },
  ]) {
    const f = fixture();
    try {
      f.setMetrics(metrics); await f.initial();
      for (let i = 0; i < 6; i++) await f.tick(1);
      assert.equal(f.controller.status().active, false, JSON.stringify(metrics));
    } finally { f.controller.close(); }
  }
});

test('short write/drain cycles between samples retain backpressure evidence without retaining stale history', async () => {
  const f = fixture();
  try {
    f.setMetrics({ blockedDownloads: 0, backpressureEvents: 100 });
    await f.initial();
    for (let i = 0; i < 6; i++) await f.tick();
    assert.equal(f.controller.status().active, false, 'old pressure events do not prove current congestion');
    for (let i = 1; i <= 4; i++) {
      f.setMetrics({ backpressureEvents: 100 + i }); await f.tick();
    }
    assert.equal(f.controller.status().active, true);
  } finally { f.controller.close(); }
});

test('a continuous series of small replacement downloads can trip without five seconds of one large file queued', async () => {
  const f = fixture({ windowMs: 5_000, triggerMs: 15_000 });
  try {
    f.setMetrics({ blockedDownloads: 0, remainingBytes: 80_000, backpressureEvents: 0 });
    await f.initial();
    for (let second = 1; second <= 19; second++) {
      // Previous files completed and new short files replaced them. Demand stays pending at each sample.
      f.setMetrics({ remainingBytes: second % 2 ? 90_000 : 80_000, backpressureEvents: second });
      await f.tick();
    }
    assert.equal(f.controller.status().active, false);
    f.setMetrics({ remainingBytes: 85_000, backpressureEvents: 20 }); await f.tick();
    assert.equal(f.controller.status().active, true);
    assert.equal(f.changes.at(-1).detection.rule, 'cache-demand');
    assert.equal(f.changes.at(-1).metrics.remainingBytes, 85_000);
    assert.equal(f.changes.at(-1).detection.badForMs, 15_000);
  } finally { f.controller.close(); }
});

test('a sampled demand gap between small files breaks the sustained congestion streak', async () => {
  const f = fixture();
  try {
    f.setMetrics({ remainingBytes: 80_000 }); await f.initial();
    await f.tick(); await f.tick();
    f.setMetrics({ activeDownloads: 0, expectedBps: 0, remainingBytes: 0 }); await f.tick();
    assert.equal(f.controller.status().detection.badForMs, 0);
    f.setMetrics({ activeDownloads: 2, expectedBps: 1_000_000, remainingBytes: 80_000 });
    for (let i = 0; i < 3; i++) await f.tick();
    assert.equal(f.controller.status().active, false);
    await f.tick();
    assert.equal(f.controller.status().active, true);
  } finally { f.controller.close(); }
});

test('the threshold uses the configured expected demand and a healthy interval breaks the streak', async () => {
  const f = fixture();
  try {
    await f.initial();
    for (let i = 0; i < 6; i++) await f.tick(600_000);
    assert.equal(f.controller.status().active, false, 'equal to the 0.6 threshold is not lower');
    await f.tick(250_000); await f.tick(250_000);
    await f.tick(800_000);
    assert.equal(f.controller.status().detection.badForMs, 0);
    for (let i = 0; i < 3; i++) await f.tick(250_000);
    assert.equal(f.controller.status().active, false);
    await f.tick(250_000);
    assert.equal(f.controller.status().active, true);
  } finally { f.controller.close(); }
});

test('a delayed game heartbeat can corroborate one client without cache response backpressure', async () => {
  const f = fixture();
  try {
    f.setMetrics({ activeDownloads: 1, demandClients: 1, blockedDownloads: 0, expectedBps: 500_000 });
    f.setCongestion({ congestedConnections: 0, delayedHeartbeats: 1 });
    await f.initial();
    for (let i = 0; i < 4; i++) await f.tick(100_000);
    assert.equal(f.controller.status().active, true);
  } finally { f.controller.close(); }
});

test('automatic retry is an attempt at 60 seconds, and continued congestion can trip again', async () => {
  const f = fixture();
  try {
    assert.equal(f.controller.trip('owner-freeze'), true);
    assert.equal(f.controller.trip('ignored'), false);
    await f.tick(0, 59_000);
    assert.equal(f.controller.status().active, true);
    await f.tick(0, 1_000);
    assert.equal(f.controller.status().active, false);
    assert.equal(f.changes.length, 2);
    assert.equal(f.changes[1].source, 'automatic-retry');
    assert.equal(f.changes[1].action, 'retry');
    assert.equal(f.changes[1].retryAt, 0);
    for (let i = 0; i < 4; i++) await f.tick();
    assert.equal(f.controller.status().active, true);
    assert.equal(f.controller.status().retryAt, 124_000);
  } finally { f.controller.close(); }
});

test('known game congestion delays retry, then game-only evidence can protect again without download workers', async () => {
  const f = fixture();
  try {
    f.setMetrics({ activeDownloads: 0, demandClients: 0, blockedDownloads: 0, remainingBytes: 0, expectedBps: 0 });
    f.setCongestion({ activeConnections: 8, activeNetworks: 6, congestedConnections: 3,
      congestedNetworks: 2, delayedNetworks: 2, impairedNetworks: 3 });
    f.controller.trip('previous-emergency');
    await f.tick(0, 60_000);
    assert.equal(f.controller.status().active, true, 'known bad game sockets are not blindly thawed');
    assert.equal(f.controller.status().retryAt, 120_000);
    assert.equal(f.changes.at(-1).action, 'retry-delayed');
    f.setCongestion({}); await f.tick(0, 60_000);
    assert.equal(f.controller.status().active, false);
    f.setCongestion({ activeNetworks: 6, impairedNetworks: 3, congestedConnections: 3 });
    for (let i = 0; i < 4; i++) await f.tick();
    assert.equal(f.controller.status().active, true);
    assert.equal(f.changes.at(-1).detection.rule, 'game-congestion');
    assert.equal(f.changes.at(-1).detection.expectedBps, 500_000);
    assert.equal(f.changes.at(-1).metrics.activeDownloads, 0);
  } finally { f.controller.close(); }
});

test('an external automatic-resume gate keeps disconnected matches frozen but manual resume overrides it', async () => {
  let humanConnected = false;
  const f = fixture({ canResume: () => humanConnected });
  try {
    f.controller.trip('offline-players'); await f.tick(0, 60_000);
    assert.equal(f.controller.status().active, true);
    assert.equal(f.controller.status().retryAt, 120_000);
    assert.equal(f.changes.at(-1).action, 'retry-delayed');
    assert.equal(f.controller.resume(), true, 'manual owner action may force resume');
    f.controller.trip(); humanConnected = true; await f.tick(0, 60_000);
    assert.equal(f.controller.status().active, false);
    assert.equal(f.changes.at(-1).action, 'retry');
  } finally { f.controller.close(); }
});

test('game-only evidence excludes one slow network or fewer than half of the active networks', async () => {
  for (const congestion of [
    { activeNetworks: 1, impairedNetworks: 1, congestedConnections: 20 },
    { activeNetworks: 4, impairedNetworks: 1, delayedHeartbeats: 20 },
    { activeNetworks: 8, impairedNetworks: 3, congestedConnections: 3 },
    // Separate counts are not blindly added: these could be the same network.
    { activeNetworks: 4, congestedNetworks: 1, delayedNetworks: 1, delayedHeartbeats: 2 },
  ]) {
    const f = fixture();
    try {
      f.setMetrics({ activeDownloads: 0, expectedBps: 0, remainingBytes: 0 });
      f.setCongestion(congestion); await f.initial();
      for (let i = 0; i < 6; i++) await f.tick(1);
      assert.equal(f.controller.status().active, false, JSON.stringify(congestion));
    } finally { f.controller.close(); }
  }
});

test('disabled detection performs no reads or timers and can be enabled at runtime', async () => {
  let samples = 0;
  let metricsReads = 0, congestionReads = 0;
  const f = fixture({ enabled: false, getMetrics: () => { metricsReads++; return {}; },
    getCongestion: () => { congestionReads++; return false; }, sampleEgress: () => { samples++; return { txBytes: 0 }; } });
  try {
    f.controller.start();
    await f.initial();
    for (let i = 0; i < 5; i++) await f.tick();
    assert.equal(f.controller.status().active, false);
    assert.equal(f.controller.status().enabled, false);
    assert.equal(samples, 0);
    assert.equal(metricsReads, 0);
    assert.equal(congestionReads, 0);
    assert.equal(f.controller.setEnabled(true), true);
    await f.tick();
    assert.equal(samples, 1);
    assert.equal(f.controller.status().enabled, true);
    assert.equal(f.controller.setEnabled(false), true);
    await f.tick();
    assert.equal(samples, 1);
  } finally { f.controller.close(); }
});

test('manual hold and permanent close never automatically release an emergency', async () => {
  const f = fixture({ autoResumeMs: 0 });
  f.controller.trip();
  await f.tick(0, 1_000_000);
  assert.equal(f.controller.status().active, true);
  assert.equal(f.controller.status().retryAt, 0);
  assert.equal(f.controller.resume(), true);
  assert.equal(f.controller.resume(), false);
  f.controller.trip(); f.controller.close(); f.controller.close();
  await f.tick(0, 1_000_000);
  assert.equal(f.controller.status().closed, true);
  assert.equal(f.controller.status().active, true);
  assert.equal(f.controller.resume(), false);
});

test('sampler outages, interface changes, counter reset and unobserved gaps reset the streak', async () => {
  let time = 0, bytes = 0, name = 'eth0', fail = false;
  const controller = createBandwidthEmergencyController({ env: {}, enabled: true, pollMs: 0, windowMs: 1_000, triggerMs: 3_000,
    now: () => time, getMetrics: () => ({ activeDownloads: 2, demandClients: 2, remainingBytes: 100_000_000,
      expectedBps: 1_000_000, blockedDownloads: 2 }), sampleEgress: async () => {
      if (fail) throw new Error('proc unavailable'); return { txBytes: bytes, interfaceName: name };
    } });
  const step = async (ms = 1_000) => { time += ms; bytes += 10; return controller.poll(); };
  try {
    await controller.poll(); await step(); await step();
    fail = true; const unavailable = await step();
    assert.equal(unavailable.detection.available, false);
    assert.equal(unavailable.detection.badForMs, 0);
    fail = false; await step(); await step();
    name = 'ens3'; await step();
    assert.equal(controller.status().detection.badForMs, 0);
    await step(); await step();
    bytes = 0; await controller.poll();
    assert.equal(controller.status().detection.badForMs, 0);
    await step(); await step(); await step(2_000);
    assert.equal(controller.status().detection.badForMs, 0);
    assert.equal(controller.status().active, false);
  } finally { controller.close(); }
});

const ROUTES = 'Iface Destination Gateway Flags RefCnt Use Metric Mask MTU Window IRTT\n' +
  'down0 00000000 00000000 0000 0 0 0 00000000 0 0 0\n' +
  'eth1 00000000 0100000A 0003 0 0 100 00000000 0 0 0\n' +
  'eth0 00000000 0100000A 0003 0 0 10 00000000 0 0 0\n';
const DEV = 'Inter-| Receive | Transmit\n face |bytes packets errs drop fifo frame compressed multicast|' +
  'bytes packets errs drop fifo colls carrier compressed\n' +
  'lo: 1000 1 0 0 0 0 0 0 1000 1 0 0 0 0 0 0\n' +
  'eth0: 2000 1 0 0 0 0 0 0 250000 1 0 0 0 0 0 0\n' +
  'eth1: 2000 1 0 0 0 0 0 0 9000000 1 0 0 0 0 0 0\n';

test('proc sampling follows the lowest-metric default route and supports an explicit interface', async () => {
  assert.equal(defaultEgressInterface(ROUTES), 'eth0');
  assert.equal(interfaceTxBytes(DEV, 'eth0'), 250_000);
  assert.equal(interfaceTxBytes(DEV, 'missing'), null);
  const paths = [];
  const read = async (file) => { paths.push(file); return file.endsWith('/route') ? ROUTES : DEV; };
  assert.deepEqual(await createProcEgressSampler({ platform: 'linux', read })(), { txBytes: 250_000, interfaceName: 'eth0' });
  assert.deepEqual(paths, ['/proc/net/route', '/proc/net/dev']);
  paths.length = 0;
  assert.deepEqual(await createProcEgressSampler({ platform: 'linux', read, interfaceName: 'eth1' })(),
    { txBytes: 9_000_000, interfaceName: 'eth1' });
  assert.deepEqual(paths, ['/proc/net/dev']);
});

test('Windows and missing default route do not invent an egress measurement; manual control remains available', async () => {
  let reads = 0;
  const read = async () => { reads++; return 'header only'; };
  assert.equal(await createProcEgressSampler({ platform: 'win32', read })(), null);
  assert.equal(reads, 0);
  assert.equal(await createProcEgressSampler({ platform: 'linux', read })(), null);
  assert.equal(reads, 1);
  const controller = createBandwidthEmergencyController({ env: {}, enabled: true, platform: 'win32', pollMs: 0 });
  try {
    controller.start(); await controller.poll();
    assert.equal(controller.status().detection.supported, false);
    assert.equal(controller.status().detection.available, false);
    assert.equal(controller.trip('manual-test'), true);
    assert.equal(controller.resume(), true);
  } finally { controller.close(); }
});

test('close during pending sample prevents late automatic state transitions', async () => {
  let finish;
  const sample = new Promise((resolve) => { finish = resolve; });
  const changes = [];
  const controller = createBandwidthEmergencyController({ env: {}, enabled: true, pollMs: 0, sampleEgress: () => sample,
    onChange: (next) => changes.push(next) });
  const polling = controller.poll();
  controller.close(); finish({ txBytes: 1000 }); await polling;
  assert.equal(controller.status().closed, true);
  assert.equal(controller.status().detection.available, false);
  assert.equal(changes.length, 0);
});

test('configuration exposes byte-demand detection knobs and rejects invalid thresholds', () => {
  assert.deepEqual(bandwidthEmergencyOptions({}, {}), BANDWIDTH_EMERGENCY_DEFAULTS);
  const custom = bandwidthEmergencyOptions({}, { SP_BANDWIDTH_EMERGENCY_ENABLED: '0', SP_BANDWIDTH_POLL_MS: '2000',
    SP_BANDWIDTH_WINDOW_MS: '10000', SP_BANDWIDTH_TRIGGER_MS: '30000', SP_BANDWIDTH_RATIO: '0.5',
    SP_BANDWIDTH_MIN_CLIENTS: '3', SP_BANDWIDTH_INTERFACE: 'ens3', SP_BANDWIDTH_AUTO_RESUME_MS: '0',
    SP_BANDWIDTH_GAME_BPS: '400000', SP_BANDWIDTH_MIN_PENDING_BYTES: '32768' });
  assert.deepEqual(custom, { enabled: false, pollMs: 2000, windowMs: 10000, triggerMs: 30000, ratio: 0.5,
    minClients: 3, interfaceName: 'ens3', autoResumeMs: 0, gameBudgetBps: 400_000, minPendingBytes: 32768 });
  for (const opts of [{ ratio: 1 }, { ratio: 0 }, { pollMs: -1 }, { triggerMs: 0 }, { windowMs: 0 },
    { minClients: 1 }, { autoResumeMs: -1 }, { gameBudgetBps: 0 }, { minPendingBytes: 0 },
    { interfaceName: '../eth0' }, { enabled: 'yes' }]) {
    assert.throws(() => bandwidthEmergencyOptions(opts, {}), RangeError);
  }
});
