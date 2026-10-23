// SP_E2E=1 node --test test/weak-network.browser.test.js (real Edge, local server).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../server/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EDGE = process.env.CHROME_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

test('Edge: offline recovery retains the same identity and 20-seat room', {
  skip: process.env.SP_E2E !== '1', timeout: 120000,
}, async (t) => {
  const out = await fs.mkdtemp(path.join(ROOT, '.cache', 'weak-network-'));
  const report = { errors: [], cleanup: {} };
  let server, browser;
  try {
    server = await startServer({ port: 0, host: '127.0.0.1', quiet: true,
      announcementsDir: path.join(out, 'announcements'), serverSettingsDir: path.join(out, 'settings') });
    const puppeteer = (await import('puppeteer-core')).default;
    browser = await puppeteer.launch({ executablePath: EDGE, headless: true,
      args: ['--no-first-run', '--no-sandbox'] });
    report.browser = await browser.version();
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 720 });
    page.on('pageerror', (error) => report.errors.push(error.message));
    await page.goto(server.url, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!globalThis.__SP__, { timeout: 30000 });
    // Warm page first: isolate gameplay recovery from cold-code download costs.
    await page.emulateNetworkConditions({ download: 64 * 1024, upload: 16 * 1024, latency: 300 });
    await page.type('.title-login input', '弱网恢复测试');
    await page.click('.title-login > .btn--primary');
    await page.waitForSelector('.lobby-screen');
    const request = (type, fields) => page.evaluate((t, body) => globalThis.__SP__.net.request(t, body), type, fields);
    assert.equal((await request('room.create', { mode: 'coop', difficulty: 'HARD', capacity: 20 })).t, 'ok');
    await page.waitForSelector('.room-screen');
    const before = await page.evaluate(() => ({ id: globalThis.__SP__.net.playerId, code: globalThis.__SP__.store.get().room.code }));
    const session = server.registry.byId(before.id);
    const previousSocket = session.ws;
    await page.setOfflineMode(true);
    session.ws?.terminate();
    await page.waitForFunction(() => globalThis.__SP__.net.status === 'reconnecting');
    await page.setOfflineMode(false);
    await page.waitForFunction((id) => globalThis.__SP__.net.status === 'online'
      && globalThis.__SP__.net.playerId === id, {}, before.id);
    await page.waitForFunction((code) => globalThis.__SP__.store.get().room?.code === code, {}, before.code);
    assert.equal((await request('room.ready', { ready: true })).t, 'ok');
    const after = await page.evaluate(() => ({ id: globalThis.__SP__.net.playerId, code: globalThis.__SP__.store.get().room.code,
      capacity: globalThis.__SP__.store.get().room.capacity, status: globalThis.__SP__.net.status }));
    assert.equal(after.id, before.id);
    assert.equal(after.code, before.code);
    assert.equal(after.capacity, 20);
    assert.equal(server.registry.byId(before.id), session, 'server resumes the same session object');
    assert.notEqual(session.ws, previousSocket, 'recovery established a new transport');
    assert.deepEqual(report.errors, []);
    report.result = { ...after, identityRetained: true, roomRetained: true, requestAfterResume: 'ok' };
    await page.screenshot({ path: path.join(out, 'recovered.png') });
  } finally {
    if (browser) { await browser.close(); report.cleanup.browserClosed = true; }
    if (server) { await server.close(); report.cleanup.serverClosed = true; }
    await fs.writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    t.diagnostic(`Evidence: ${out}`);
  }
});
