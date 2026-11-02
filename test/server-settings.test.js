import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  createServerSettings, parseAiLimit, parseAssetCacheRequirement, parseAssetCacheRate, readServerSettings, serverSettingsDirectory, writeServerSettings,
  SERVER_SETTINGS_FILE,
} from '../server/serverSettings.js';
import { MAX_SEATS } from '../shared/constants.js';
import { prepareServerSettingsConsole } from '../tools/server-settings.mjs';
import { startServer } from '../server/index.js';
import { StubMatch } from '../server/match/StubMatch.js';
import { TestClient } from './helpers/wsClient.js';

const TOOL = fileURLToPath(new URL('../tools/server-settings.mjs', import.meta.url));
const ROOT = path.resolve(path.dirname(TOOL), '..');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-server-settings-'));
  t.after(() => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('sp-server-settings-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const dir = path.join(root, 'persistent');
  const file = path.join(dir, SERVER_SETTINGS_FILE);
  const run = (...args) => spawnSync(process.execPath, [TOOL, ...args, '--dir', dir], {
    cwd: ROOT, env: { ...process.env, SP_SERVER_SETTINGS_DIR: '', SP_MAX_AI_PER_ROOM: '', SP_REQUIRE_ASSET_CACHE: '' }, encoding: 'utf8', timeout: 10000,
  });
  return { root, dir, file, run };
}

test('AI limits reject coercion and out-of-range input; directories resolve independently of CLI working directory', () => {
  assert.equal(parseAiLimit('unlimited'), null);
  assert.equal(parseAiLimit(' 0 '), 0);
  for (let n = 0; n < MAX_SEATS; n++) assert.equal(parseAiLimit(String(n)), n);
  for (const value of ['', null, undefined, true, -1, MAX_SEATS, '1.5', '1e1', '0x10', '01', 'Infinity']) {
    assert.throws(() => parseAiLimit(value), /AI 上限/);
  }
  const root = path.resolve('test-root');
  assert.equal(serverSettingsDirectory({ root, env: {} }), path.join(root, 'runtime'));
  assert.equal(serverSettingsDirectory({ root, env: { SP_SERVER_SETTINGS_DIR: 'local' } }), path.join(root, 'local'));
  assert.equal(serverSettingsDirectory({ root, dir: 'explicit', env: { SP_SERVER_SETTINGS_DIR: 'local' } }), path.join(root, 'explicit'));
});

test('unconfigured startup keeps unrestricted AI, does not create private storage, and validates initial environment', (t) => {
  const { dir } = fixture(t);
  const controller = createServerSettings({ dir, env: {}, pollMs: 0 });
  t.after(() => controller.close());
  assert.deepEqual(controller.get(), { maxAiPerRoom: null, requireAssetCache: false, assetCacheLimits: null });
  assert.equal(fs.existsSync(dir), false);
  assert.equal(controller.poll(), false);
  assert.equal(controller.start(), controller);
  assert.equal(fs.existsSync(dir), false);
  for (const value of ['0', '3', '19', 'unlimited']) {
    const other = createServerSettings({ dir, env: { SP_MAX_AI_PER_ROOM: value }, pollMs: 0 });
    assert.equal(other.get().maxAiPerRoom, parseAiLimit(value));
    other.close();
  }
  assert.throws(() => createServerSettings({ dir, env: { SP_MAX_AI_PER_ROOM: '20' } }), /AI 上限/);
  assert.throws(() => createServerSettings({ dir, env: {}, pollMs: -1 }), /检查间隔/);
});

test('precache admission defaults to optional, accepts explicit environment values, and rejects coercion', (t) => {
  const { dir } = fixture(t);
  for (const [input, expected] of [['required', true], ['1', true], ['optional', false], ['0', false]]) {
    assert.equal(parseAssetCacheRequirement(input), expected);
    const controller = createServerSettings({ dir, env: { SP_REQUIRE_ASSET_CACHE: input }, pollMs: 0 });
    assert.equal(controller.get().requireAssetCache, expected);
    controller.close();
  }
  for (const input of [null, undefined, '', true, false, 'true', 'false', 'yes', '2']) {
    assert.throws(() => parseAssetCacheRequirement(input), /预缓存准入/);
  }
  assert.throws(() => createServerSettings({ dir, env: { SP_REQUIRE_ASSET_CACHE: 'yes' } }), /预缓存准入/);
});

test('version-1 AI-only files remain compatible and updates preserve the other policy', (t) => {
  const { dir, file } = fixture(t);
  fs.mkdirSync(dir);
  fs.writeFileSync(file, JSON.stringify({ version: 1, maxAiPerRoom: 2 }));
  const controller = createServerSettings({ dir, env: { SP_REQUIRE_ASSET_CACHE: '1' }, pollMs: 0 });
  t.after(() => controller.close());
  assert.deepEqual(controller.get(), { maxAiPerRoom: 2, requireAssetCache: false, assetCacheLimits: null });
  writeServerSettings(dir, { requireAssetCache: true });
  assert.equal(controller.poll(), true);
  assert.deepEqual(controller.get(), { maxAiPerRoom: 2, requireAssetCache: true, assetCacheLimits: null });
  writeServerSettings(dir, 0);
  assert.equal(controller.poll(), true);
  assert.deepEqual(controller.get(), { maxAiPerRoom: 0, requireAssetCache: true, assetCacheLimits: null });
  writeServerSettings(dir, { requireAssetCache: false });
  assert.equal(controller.poll(), true);
  assert.deepEqual(controller.get(), { maxAiPerRoom: 0, requireAssetCache: false, assetCacheLimits: null });
  fs.unlinkSync(file);
  assert.equal(controller.poll(), true);
  assert.deepEqual(controller.get(), { maxAiPerRoom: null, requireAssetCache: true, assetCacheLimits: null }, 'deletion restores the startup fallback');
});

test('corrupt settings cannot be partially overwritten to silently remove strict admission', (t) => {
  const { dir, file } = fixture(t);
  writeServerSettings(dir, { maxAiPerRoom: 2, requireAssetCache: true });
  for (const invalid of [null, 'true', 1, {}, []]) {
    assert.throws(() => writeServerSettings(dir, { requireAssetCache: invalid }), /配置字段/);
  }
  fs.writeFileSync(file, '{broken');
  for (const patch of [0, { maxAiPerRoom: 0 }, { requireAssetCache: false }]) {
    assert.throws(() => writeServerSettings(dir, patch));
    assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
  }
  writeServerSettings(dir, { maxAiPerRoom: null, requireAssetCache: true });
  assert.deepEqual(readServerSettings(dir), { maxAiPerRoom: null, requireAssetCache: true, assetCacheLimits: null });
});

test('persisted zero and unlimited override the environment across process restarts; writes leave no temporary files', (t) => {
  const { dir } = fixture(t);
  for (const limit of [0, 3, null, 19]) {
    writeServerSettings(dir, limit);
    const controller = createServerSettings({ dir, env: { SP_MAX_AI_PER_ROOM: '1' }, pollMs: 0 });
    assert.deepEqual(controller.get(), { maxAiPerRoom: limit, requireAssetCache: false, assetCacheLimits: null });
    assert.ok(Object.isFrozen(controller.get()));
    controller.close();
    assert.deepEqual(readServerSettings(dir), { maxAiPerRoom: limit, requireAssetCache: false, assetCacheLimits: null });
    assert.deepEqual(fs.readdirSync(dir), [SERVER_SETTINGS_FILE]);
  }
});

test('runtime updates notify only changed valid policies, broken files keep the previous value, deletion restores fallback', (t) => {
  const { dir, file } = fixture(t);
  writeServerSettings(dir, 3);
  const changes = [];
  const warnings = [];
  const controller = createServerSettings({ dir, env: { SP_MAX_AI_PER_ROOM: '1' }, pollMs: 0,
    onChange: (next, previous) => changes.push([next.maxAiPerRoom, previous.maxAiPerRoom]),
    log: { warn: (line) => warnings.push(line) } });
  t.after(() => controller.close());
  assert.deepEqual(changes, [], 'constructing the controller does not call a not-yet-wired lobby');
  assert.equal(controller.poll(), false);
  writeServerSettings(dir, 3);
  assert.equal(controller.poll(), false, 'identical policy never causes a room broadcast');
  writeServerSettings(dir, 0);
  assert.equal(controller.poll(), true);
  fs.writeFileSync(file, '{bad', 'utf8');
  assert.equal(controller.poll(), false);
  assert.equal(controller.poll(), false);
  assert.equal(controller.get().maxAiPerRoom, 0, 'a broken edit cannot silently lift the restriction');
  assert.equal(warnings.length, 1, 'unchanged failures are logged once');
  writeServerSettings(dir, { maxAiPerRoom: null, requireAssetCache: false });
  assert.equal(controller.poll(), true);
  fs.unlinkSync(file);
  assert.equal(controller.poll(), true);
  assert.deepEqual(changes, [[0, 3], [null, 0], [1, null]]);
  controller.close();
  writeServerSettings(dir, 4);
  assert.equal(controller.poll(), false, 'closed controllers never deliver callbacks');
  assert.equal(controller.get().maxAiPerRoom, 1);
});

test('real scheduled polling applies changes and close releases the polling timer', async (t) => {
  const { dir } = fixture(t);
  let changed;
  const observed = new Promise((resolve) => { changed = resolve; });
  const controller = createServerSettings({ dir, env: {}, pollMs: 10, onChange: changed });
  t.after(() => controller.close());
  controller.start(); controller.start();
  writeServerSettings(dir, 2);
  let deadline;
  try {
    const state = await Promise.race([observed, new Promise((_, reject) => {
      deadline = setTimeout(() => reject(new Error('settings poll did not run')), 2000);
    })]);
    assert.deepEqual(state, { maxAiPerRoom: 2, requireAssetCache: false, assetCacheLimits: null });
  } finally { clearTimeout(deadline); controller.close(); }
});

test('read/write reject invalid schema, oversize, non-UTF8 and non-file targets without losing valid data', (t) => {
  const { dir, file } = fixture(t);
  writeServerSettings(dir, 2);
  const before = fs.readFileSync(file);
  for (const invalid of [-1, 20, 1.5, '3', undefined, true]) assert.throws(() => writeServerSettings(dir, invalid), /AI 上限/);
  assert.deepEqual(fs.readFileSync(file), before);
  for (const contents of ['{}', '[]', '{"version":2,"maxAiPerRoom":3}', '{"version":1,"maxAiPerRoom":"3"}',
    '{"version":1,"maxAiPerRoom":3,"extra":true}', '{"version":1,"maxAiPerRoom":3,"requireAssetCache":1}',
    'x'.repeat(4097), Buffer.from([0xff])]) {
    fs.writeFileSync(file, contents);
    assert.throws(() => readServerSettings(dir));
    assert.throws(() => createServerSettings({ dir, env: {}, pollMs: 0 }), undefined,
      'startup has no last-good value and must never silently boot unrestricted');
  }
  fs.unlinkSync(file);
  fs.mkdirSync(file);
  assert.throws(() => readServerSettings(dir), /普通文件/);
  assert.throws(() => writeServerSettings(dir, 3), /普通文件/);
  assert.deepEqual(fs.readdirSync(dir), [SERVER_SETTINGS_FILE]);
});

test('Windows interactive administration chooses UTF-8; redirected and Linux output require no shell command', () => {
  const calls = [];
  const run = (...args) => { calls.push(args); return { status: 1 }; };
  prepareServerSettingsConsole({ platform: 'linux', stdout: { isTTY: true }, stderr: { isTTY: true }, run });
  prepareServerSettingsConsole({ platform: 'win32', stdout: { isTTY: false }, stderr: { isTTY: false }, run });
  assert.deepEqual(calls, []);
  prepareServerSettingsConsole({ platform: 'win32', stdout: { isTTY: true }, stderr: { isTTY: false }, run });
  assert.deepEqual(calls, [['cmd.exe', ['/d', '/c', 'chcp', '65001'], { stdio: 'ignore', windowsHide: true, timeout: 1000 }]]);
  assert.doesNotThrow(() => prepareServerSettingsConsole({ platform: 'win32', stdout: { isTTY: true },
    stderr: { isTTY: false }, run: () => { throw new Error('no console'); } }));
});

test('CLI shows without writes, persists valid limit and unlimited, rejects invalid arguments before filesystem writes', (t) => {
  const { dir, file, run } = fixture(t);
  const shown = run('show', '--json');
  assert.equal(shown.status, 0, shown.stderr);
  assert.deepEqual(JSON.parse(shown.stdout), { maxAiPerRoom: null, requireAssetCache: false, assetCacheLimits: null });
  assert.equal(fs.existsSync(dir), false);
  for (const args of [['ai-limit'], ['ai-limit', '20'], ['ai-limit', '-1'], ['ai-limit', '1.2'], ['show', '--oops'],
    ['show', '3'], ['ai-limit', '1', '2'], ['ai-limit', '1', '--json'], ['show', '--dir', dir, '--dir', dir]]) {
    assert.equal(run(...args).status, 2, args.join(' '));
  }
  assert.equal(fs.existsSync(dir), false);
  for (const value of ['0', '3', 'unlimited', '19']) {
    const saved = run('ai-limit', value);
    assert.equal(saved.status, 0, saved.stderr);
    assert.match(saved.stdout, /已保存每房 AI 上限/);
    assert.deepEqual(JSON.parse(run('show', '--json').stdout), { maxAiPerRoom: parseAiLimit(value), requireAssetCache: false, assetCacheLimits: null });
  }
  fs.writeFileSync(file, '{bad', 'utf8');
  assert.equal(run('show').status, 1, 'show must not misreport the fallback as the running server last-good policy');
});

test('asset-cache-limit persists Mbps budgets, defaults the client to total, and restores unlimited', (t) => {
  const { dir, run } = fixture(t);
  assert.equal(parseAssetCacheRate('8'), 1_000_000);
  assert.equal(parseAssetCacheRate('0.5'), 62_500);
  assert.equal(parseAssetCacheRate('unlimited'), null);
  for (const args of [['asset-cache-limit'], ['asset-cache-limit', '8', '4', 'extra'], ['asset-cache-limit', '-1'],
    ['asset-cache-limit', '8', '--json']]) {
    assert.equal(run(...args).status, 2, args.join(' '));
  }
  assert.equal(run('asset-cache-limit', '8', '0').status, 1, 'a positive total cannot have a zero client budget');
  assert.equal(run('asset-cache-limit', '8').status, 0);
  assert.deepEqual(JSON.parse(run('show', '--json').stdout), {
    maxAiPerRoom: null, requireAssetCache: false,
    assetCacheLimits: { totalBps: 1_000_000, clientBps: 1_000_000 },
  });
  assert.equal(run('asset-cache-limit', '8', '4').status, 0);
  assert.deepEqual(readServerSettings(dir).assetCacheLimits, { totalBps: 1_000_000, clientBps: 500_000 });
  assert.equal(run('asset-cache-limit', 'unlimited', 'unlimited').status, 0);
  assert.deepEqual(readServerSettings(dir).assetCacheLimits, { totalBps: null, clientBps: null });
});

test('CLI and server share environment-selected storage and persisted values win over the initial limit', (t) => {
  const { dir } = fixture(t);
  const run = (...args) => spawnSync(process.execPath, [TOOL, ...args], {
    cwd: path.dirname(ROOT), env: { ...process.env, SP_SERVER_SETTINGS_DIR: dir, SP_MAX_AI_PER_ROOM: '2' },
    encoding: 'utf8', timeout: 10000,
  });
  assert.deepEqual(JSON.parse(run('show', '--json').stdout), { maxAiPerRoom: 2, requireAssetCache: false, assetCacheLimits: null });
  assert.equal(run('ai-limit', '4').status, 0);
  assert.deepEqual(JSON.parse(run('show', '--json').stdout), { maxAiPerRoom: 4, requireAssetCache: false, assetCacheLimits: null });
  const controller = createServerSettings({ env: { SP_SERVER_SETTINGS_DIR: dir, SP_MAX_AI_PER_ROOM: '2' }, pollMs: 0 });
  assert.equal(controller.get().maxAiPerRoom, 4); assert.equal(controller.get().assetCacheLimits, null);
  controller.close();
});

test('owner CLI toggles strict admission without erasing the AI ceiling and validates before writing', (t) => {
  const { dir, run } = fixture(t);
  for (const args of [['asset-cache'], ['asset-cache', 'yes'], ['asset-cache', 'true'], ['asset-cache', 'required', '--json']]) {
    assert.equal(run(...args).status, 2);
  }
  assert.equal(fs.existsSync(dir), false);
  assert.equal(run('ai-limit', '3').status, 0);
  const enabled = run('asset-cache', 'required');
  assert.equal(enabled.status, 0, enabled.stderr);
  assert.match(enabled.stdout, /严格，要求完整预缓存/);
  assert.deepEqual(JSON.parse(run('show', '--json').stdout), { maxAiPerRoom: 3, requireAssetCache: true, assetCacheLimits: null });
  assert.equal(run('ai-limit', '0').status, 0);
  assert.deepEqual(JSON.parse(run('show', '--json').stdout), { maxAiPerRoom: 0, requireAssetCache: true, assetCacheLimits: null });
  assert.equal(run('asset-cache', 'optional').status, 0);
  assert.deepEqual(JSON.parse(run('show', '--json').stdout), { maxAiPerRoom: 0, requireAssetCache: false, assetCacheLimits: null });
});

test('owner CLI toggles bandwidth emergency detection and the running controller follows it', async (t) => {
  const { dir, run } = fixture(t);
  for (const args of [['bandwidth-emergency'], ['bandwidth-emergency', 'yes'], ['bandwidth-emergency', 'on', '--json']]) {
    assert.equal(run(...args).status, 2, args.join(' '));
  }
  assert.equal(run('bandwidth-emergency', 'on').status, 0);
  assert.deepEqual(JSON.parse(run('show', '--json').stdout), { maxAiPerRoom: null, requireAssetCache: false,
    assetCacheLimits: null, bandwidthEmergencyEnabled: true });
  const server = await startServer({ port: 0, host: '127.0.0.1', quiet: true, serverSettingsDir: dir,
    bandwidthEmergency: { pollMs: 0, sampleEgress: async () => ({ txBytes: 0, interfaceName: 'test0' }) } });
  t.after(() => server.close());
  assert.equal(server.bandwidthEmergency.status().enabled, true);
  assert.equal(run('bandwidth-emergency', 'off').status, 0);
  assert.equal(server.serverSettings.poll(), true);
  assert.equal(server.bandwidthEmergency.status().enabled, false);
  assert.equal(run('bandwidth-emergency', 'on').status, 0);
  assert.equal(server.serverSettings.poll(), true);
  assert.equal(server.bandwidthEmergency.status().enabled, true);
  await server.close();
});

test('server startup applies private policy, CLI updates reach live waiting rooms, and closing stops reads', async (t) => {
  const { dir, run } = fixture(t);
  writeServerSettings(dir, 2);
  const server = await startServer({ port: 0, host: '127.0.0.1', quiet: true, MatchClass: StubMatch, serverSettingsDir: dir });
  const clients = [];
  try {
    const connect = async (name) => {
      const client = await TestClient.connect(`ws://127.0.0.1:${server.port}/ws`);
      clients.push(client);
      await client.hello(name);
      return client;
    };
    const host = await connect('Host');
    assert.equal((await host.request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL', capacity: 20 })).t, 'ok');
    let state = await host.waitFor('room.state');
    assert.equal(state.maxAiPerRoom, 2);
    for (let count = 0; count < 2; count++) assert.equal((await host.request({ t: 'room.addBot' })).t, 'ok');
    assert.equal((await host.request({ t: 'room.addBot' })).code, 'AI_LIMIT');
    const guest = await connect('Guest');
    assert.equal((await guest.request({ t: 'room.join', code: state.code })).t, 'ok', 'limits affect AI only, never human joining');
    assert.equal(run('ai-limit', '0').status, 0);
    state = await host.waitFor('room.state', (value) => value.maxAiPerRoom === 0);
    assert.equal(state.seats.filter((seat) => seat?.isBot).length, 0, 'runtime polling trims only surplus AI');
    assert.equal(state.seats.filter((seat) => seat && !seat.isBot).length, 2);
    const controller = server.serverSettings;
    await server.close();
    writeServerSettings(dir, 4);
    assert.equal(controller.poll(), false);
    assert.equal(controller.get().maxAiPerRoom, 0, 'shutdown closes the owned timer and change callback');
  } finally {
    await Promise.all(clients.map((client) => client.terminate()));
    await server.close();
  }
});

test('invalid persistent settings fail server startup before listening', async (t) => {
  const { dir, file } = fixture(t);
  writeServerSettings(dir, 2);
  fs.writeFileSync(file, '{bad', 'utf8');
  await assert.rejects(startServer({ port: 0, host: '127.0.0.1', quiet: true, serverSettingsDir: dir }));
});
