// Short real Edge flow: cold/warm runtime, simulator module identity, 20 networked seats, JSON fallback and resync.
// No full 14-round playthrough. SP_E2E=1 node --test test/compact-wire.browser.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { startServer } from '../server/index.js';
import { TestClient } from './helpers/wsClient.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, '.cache', 'compact-wire', `edge-${Date.now()}`);
const EDGE = process.env.CHROME_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const runtimePath = (url) => /\/(js|css|shared|sim|data|vendor)\/|\/data\.js(?:\?|$)/.test(url);

async function monitor(page) {
  const cdp = await page.createCDPSession();
  await cdp.send('Network.enable');
  const files = new Map(); const cachedIds = new Set();
  const frames = { arrays: 0, objects: 0 };
  cdp.on('Network.requestServedFromCache', ({ requestId }) => { cachedIds.add(requestId); });
  cdp.on('Network.responseReceived', ({ requestId, response }) => {
    if (runtimePath(response.url)) files.set(requestId, { url: response.url, status: response.status,
      cache: response.fromDiskCache || cachedIds.has(requestId), encoding: response.headers['Content-Encoding'] || response.headers['content-encoding'], bytes: 0 });
  });
  cdp.on('Network.loadingFinished', ({ requestId, encodedDataLength }) => {
    const file = files.get(requestId); if (file) file.bytes = encodedDataLength;
  });
  cdp.on('Network.webSocketFrameReceived', ({ response }) => {
    try { Array.isArray(JSON.parse(response.payloadData)) ? frames.arrays++ : frames.objects++; } catch { /* control frames */ }
  });
  return { frames, result: () => {
    const records = [...files.values()];
    return { files: records.length, bytes: records.reduce((sum, file) => sum + file.bytes, 0),
      cached: records.filter((file) => file.cache || file.bytes === 0).length,
      brotli: records.filter((file) => file.encoding === 'br').length,
      failed: records.filter((file) => file.status >= 400).map((file) => ({ url: file.url, status: file.status })),
      unversioned: records.filter((file) => !new URL(file.url).searchParams.has('rv')).map((file) => file.url) };
  } };
}

async function loadRuntime(page, url, errors) {
  page.setDefaultTimeout(20_000);
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setViewport({ width: 1920, height: 1080 });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!globalThis.__SP__?.data);
  return page.evaluate(async () => {
    const { loadBrowserSim } = await import('/js/battle/runner.js');
    const sim = await loadBrowserSim();
    const shim = await import('/data.js');
    const injected = await import('/sim/simdata.js');
    // All paths must reach the SAME module instance, despite query versions and ../../ imports.
    return { injected: shim.getData() === injected.getSimData(),
      chessRecords: Object.keys(shim.getData().chess).length, spec: typeof sim.spec.createBattleFromSpec };
  });
}

test('Edge: immutable warm cache, native compression, mixed 20-seat UI and reconnect fallback', {
  skip: process.env.SP_E2E === '1' ? false : 'set SP_E2E=1 (uses Edge)', timeout: 120_000,
}, async (t) => {
  const errors = []; const clients = []; const report = { cleanup: {} };
  let browser; let server;
  try {
    await fs.access(EDGE);
    await fs.mkdir(OUT, { recursive: true });
    server = await startServer({ port: 0, host: '127.0.0.1', quiet: true, seedFn: () => 123,
      announcementsDir: path.join(OUT, 'announcements'), serverSettingsDir: path.join(OUT, 'settings') });
    const puppeteer = (await import('puppeteer-core')).default;
    browser = await puppeteer.launch({ executablePath: EDGE, headless: true,
      args: ['--no-first-run', '--no-sandbox', '--host-resolver-rules=MAP fonts.googleapis.com ~NOTFOUND, MAP fonts.gstatic.com ~NOTFOUND'] });
    report.browser = await browser.version();
    const context = await browser.createBrowserContext();
    const cold = await context.newPage(); const coldNet = await monitor(cold);
    report.simCold = await loadRuntime(cold, server.url, errors);
    assert.equal(report.simCold.injected, true); assert.equal(report.simCold.spec, 'function');
    assert.ok(report.simCold.chessRecords > 0);
    await delay(250); report.cold = coldNet.result(); await cold.close();
    const page = await context.newPage(); const live = await monitor(page);
    report.simWarm = await loadRuntime(page, server.url, errors);
    await delay(250); report.warm = live.result();
    assert.equal(report.warm.failed.length, 0); assert.equal(report.cold.failed.length, 0);
    assert.ok(report.cold.brotli > 0, 'Edge negotiates Brotli for actual page modules/data');
    assert.ok(report.warm.bytes < report.cold.bytes * 0.15, `${report.warm.bytes}/${report.cold.bytes}: warm runtime saves at least 85%`);
    assert.equal(report.warm.unversioned.length, 0, 'full runtime graph and game data carry content versions');

    await page.type('.title-login input', '带宽架构 Edge');
    await page.click('.title-login > .btn--primary'); await page.waitForSelector('.lobby-screen');
    const hostId = await page.evaluate(() => globalThis.__SP__.net.playerId);
    const request = (type, fields = {}) => page.evaluate(async (t, payload) => {
      try { return await globalThis.__SP__.net.request(t, payload); }
      catch (error) { return { t: 'error', code: error.code, message: error.message }; }
    }, type, fields);
    assert.equal((await request('room.create', { mode: 'coop', difficulty: 'HARD', capacity: 20 })).t, 'ok');
    await page.waitForSelector('.room-screen');
    const code = await page.evaluate(() => globalThis.__SP__.store.get().room.code);
    const byId = new Map([[hostId, { request: (msg) => { const { t, ...fields } = msg; return request(t, fields); } }]]);
    for (let i = 1; i < 20; i++) {
      const c = await TestClient.connect(`ws://127.0.0.1:${server.port}/ws`, { wire: i % 2 === 0 }); clients.push(c);
      const welcome = await c.hello(`WS${i + 1}`); byId.set(welcome.playerId, c);
      assert.equal((await c.request({ t: 'room.join', code })).t, 'ok');
      assert.equal((await c.request({ t: 'room.ready', ready: true })).t, 'ok');
    }
    assert.equal((await request('room.start')).t, 'ok');
    await page.waitForFunction(() => globalThis.__SP__.store.get().match.public?.phase === 'INFO_CHECK');
    assert.equal(await page.evaluate(() => globalThis.__SP__.net.wireVersion), 1);
    assert.equal(await page.evaluate(() => globalThis.__SP__.store.get().match.public.players.length), 20);
    for (const c of byId.values()) assert.equal((await c.request({ t: 'g.infoReady' })).t, 'ok');
    const match = server.lobby.getRoom(code).match;
    const stopAt = Date.now() + 20_000;
    while (match.phase !== 'PREP' && Date.now() < stopAt) {
      if (match.phase === 'BAND_DRAFT') {
        for (const ps of match.order) if (match.draftTurn(ps.playerId) === ps.playerId) {
          assert.equal((await byId.get(ps.playerId).request({ t: 'g.band', bandId: match.defaultBand(ps.playerId) })).t, 'ok');
        }
      } else if (match.phase === 'SP_DRAFT') {
        for (const ps of match.order) if (match.spTurn(ps.playerId) === ps.playerId) {
          const group = match.spGroup(ps.playerId); const idx = group.cards.find((card) => group.taken[card.idx] == null).idx;
          assert.equal((await byId.get(ps.playerId).request({ t: 'g.choice', idx })).t, 'ok');
        }
      }
      await delay(40);
    }
    assert.equal(match.phase, 'PREP');
    await page.waitForFunction(() => globalThis.__SP__.store.get().match.public?.phase === 'PREP');
    await page.waitForSelector('.gm__field canvas');
    await page.screenshot({ path: path.join(OUT, 'prep-1920.png') });
    await page.setViewport({ width: 1280, height: 720 });
    await page.screenshot({ path: path.join(OUT, 'prep-1280.png') });
    assert.ok(live.frames.arrays > 0, 'the real browser receives compact arrays on /ws');
    report.frames = { ...live.frames }; report.phase = match.phase;
    const resumed = await page.evaluate(async () => {
      const net = globalThis.__SP__.net; const id = net.playerId;
      net._wireDisabled = true; net.reconnectNow();
      await new Promise((resolve) => { const off = net.on('welcome', () => { off(); resolve(); }); });
      return { sameId: net.playerId === id, wire: net.wireVersion, status: net.status };
    });
    assert.deepEqual(resumed, { sameId: true, wire: 0, status: 'online' });
    await page.waitForFunction(() => globalThis.__SP__.store.get().match.public?.players.length === 20
      && globalThis.__SP__.store.get().match.private?.playerId === globalThis.__SP__.net.playerId);
    assert.equal((await request('ping', { c: Date.now() })).t, 'pong');
    report.resumed = resumed; assert.deepEqual(errors, []);
    t.diagnostic(`Edge runtime cold ${report.cold.bytes} B, warm ${report.warm.bytes} B; compact frames ${report.frames.arrays}`);
  } finally {
    if (browser) { await browser.close(); report.cleanup.browserClosed = true; }
    await Promise.all(clients.map((c) => c.terminate().catch(() => {}))); report.cleanup.clientsClosed = true;
    if (server) {
      const port = server.port; await server.close(); report.cleanup.serverClosed = true;
      report.cleanup.portClosed = await fetch(`http://127.0.0.1:${port}/healthz`).then(() => false, () => true);
    }
    await fs.mkdir(OUT, { recursive: true });
    await fs.writeFile(path.join(OUT, 'report.json'), JSON.stringify({ ...report, errors }, null, 2) + '\n', 'utf8');
  }
});
