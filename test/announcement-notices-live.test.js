import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startServer } from '../server/index.js';
import { createAnnouncementStore } from '../server/announcements.js';
import { StubMatch } from '../server/match/StubMatch.js';
import { TestClient } from './helpers/wsClient.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const command = (dir, id) => execFileSync(process.execPath, ['tools/announcements.mjs', 'notify', id, '--dir', dir], { cwd: ROOT, encoding: 'utf8', windowsHide: true });

test('only explicit owner CLI notifies game, spectator, lobby and pre-hello sockets; restart does not replay', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'sp-notice-live-'));
  let srv;
  const clients = [];
  try {
    const initial = createAnnouncementStore({ dir });
    initial.publish({ id: 'old', title: '旧命令', markdown: '启动前的通知' });
    command(dir, 'old');
    srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, announcementsDir: dir, MatchClass: StubMatch });
    const connect = async (name) => {
      const client = await TestClient.connect(`ws://127.0.0.1:${srv.port}/ws`);
      clients.push(client); if (name) await client.hello(name); return client;
    };
    const host = await connect('房主');
    assert.equal((await host.request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL' })).t, 'ok');
    const { code } = await host.waitFor('room.state');
    const spectator = await connect('观战');
    assert.equal((await spectator.request({ t: 'room.spectate', code })).t, 'ok');
    assert.equal((await host.request({ t: 'room.start' })).t, 'ok');
    await host.waitFor('m.public', (msg) => msg.phase === 'INFO_CHECK');
    const lobby = await connect('大厅');
    const anonymous = await connect();
    srv.announcements.publish({ id: 'maintenance', title: '维护通知', markdown: '正在游玩也能收到，但仅显式发送', pin: true });
    await delay(1100);
    for (const client of clients) assert.equal(client.log.filter((msg) => msg.t === 'announcement.notice').length, 0, 'publish/pin/old command cannot send');
    assert.match(command(dir, 'maintenance'), /发送命令|通知/);
    const notices = await Promise.all([host, spectator, lobby, anonymous].map((client) => client.waitFor('announcement.notice', () => true, 3500)));
    assert.equal(new Set(notices.map((msg) => msg.msgid)).size, 1);
    for (const msg of notices) {
      assert.equal(msg.id, 'maintenance'); assert.equal(msg.t, 'announcement.notice');
      assert.equal(Object.hasOwn(msg, 'markdown'), false);
      assert.ok(JSON.stringify(msg).length < 400);
    }
    const rejected = await host.request({ t: 'announcement.notice', id: 'maintenance' });
    assert.equal(rejected.code, 'BAD_MSG', 'players cannot invoke an owner command');
    assert.equal((await host.request({ t: 'g.infoReady' })).t, 'ok', 'game can still accept the next action');
    await Promise.all(clients.map((client) => client.terminate()));
    await srv.close();
    srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, announcementsDir: dir });
    const afterRestart = await connect('重启后');
    await delay(1100);
    assert.equal(afterRestart.log.filter((msg) => msg.t === 'announcement.notice').length, 0);
    command(dir, 'maintenance');
    assert.equal((await afterRestart.waitFor('announcement.notice', () => true, 3500)).id, 'maintenance');
  } finally {
    await Promise.all(clients.map((client) => client.terminate()));
    await srv?.close(); rmSync(dir, { recursive: true, force: true });
  }
});
