// The actual publishing process, including UTF-8 Chinese titles, strict arguments and restart persistence.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createAnnouncementStore } from '../server/announcements.js';
import { prepareAnnouncementConsole } from '../tools/announcements.mjs';

const TOOL = fileURLToPath(new URL('../tools/announcements.mjs', import.meta.url));
const ROOT = path.resolve(path.dirname(TOOL), '..');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-announcements-cli-'));
  t.after(() => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('sp-announcements-cli-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const dir = path.join(root, 'persistent');
  const file = path.join(root, '公告正文.md');
  fs.writeFileSync(file, '# 维护完成\n\n服务器已恢复。\n', 'utf8');
  const run = (...args) => spawnSync(process.execPath, [TOOL, ...args, '--dir', dir], {
    cwd: ROOT, env: { ...process.env, SP_ANNOUNCEMENTS_DIR: '' }, encoding: 'utf8', timeout: 10000,
  });
  return { root, dir, file, run };
}

test('Windows interactive output selects UTF-8 quietly; pipes/Linux skip it and failure never masks the command', () => {
  const calls = [];
  const run = (...args) => { calls.push(args); return { status: 1 }; };
  prepareAnnouncementConsole({ platform: 'linux', stdout: { isTTY: true }, stderr: { isTTY: true }, run });
  prepareAnnouncementConsole({ platform: 'win32', stdout: { isTTY: false }, stderr: { isTTY: false }, run });
  assert.deepEqual(calls, []);
  prepareAnnouncementConsole({ platform: 'win32', stdout: { isTTY: true }, stderr: { isTTY: false }, run });
  assert.deepEqual(calls, [['cmd.exe', ['/d', '/c', 'chcp', '65001'], { stdio: 'ignore', windowsHide: true, timeout: 1000 }]]);
  assert.doesNotThrow(() => prepareAnnouncementConsole({ platform: 'win32', stdout: { isTTY: false }, stderr: { isTTY: true }, run: () => { throw new Error('console unavailable'); } }));
});

test('CLI publish/list/pin/unpin persist across independent processes with clean UTF-8 output', (t) => {
  const { dir, file, run } = fixture(t);
  const empty = run('list', '--json');
  assert.equal(empty.status, 0, empty.stderr);
  assert.deepEqual(JSON.parse(empty.stdout), { revision: '', pinnedId: null, items: [] });
  const first = run('publish', '--id', 'maintenance', '--title', '服务器维护完成', '--file', file, '--pin');
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /已发布公告 maintenance，并设为唯一置顶/);
  const firstIndex = JSON.parse(run('list', '--json').stdout);
  assert.equal(firstIndex.pinnedId, 'maintenance');
  assert.equal(firstIndex.items[0].title, '服务器维护完成');
  assert.equal(createAnnouncementStore({ dir }).read('maintenance').markdown, '# 维护完成\n\n服务器已恢复。\n');
  const second = run('publish', '--id', 'update', '--title', '更新公告', '--file', file);
  assert.equal(second.status, 0, second.stderr);
  const newer = JSON.parse(run('list', '--json').stdout);
  assert.notEqual(newer.revision, firstIndex.revision);
  assert.equal(newer.pinnedId, 'maintenance');
  assert.deepEqual(newer.items.map((item) => item.id), ['update', 'maintenance'], 'JSON retains canonical publication order');
  assert.match(run('list').stdout.split('\n')[0], /^\[置顶\] maintenance\t/, 'ordinary CLI history puts the pin first');
  assert.equal(run('pin', 'update').status, 0);
  assert.equal(JSON.parse(run('list', '--json').stdout).pinnedId, 'update');
  assert.equal(run('unpin').status, 0);
  const unpinned = JSON.parse(run('list', '--json').stdout);
  assert.equal(unpinned.pinnedId, null);
  assert.equal(unpinned.revision, newer.revision);
  assert.match(run('list').stdout, /更新公告/);
  assert.match(run('list').stdout.split('\n')[0], /^update\t/, 'unpin restores canonical publication order');
});

test('CLI requires explicit Markdown input, rejects unknown/repeated arguments and never invents a publication', (t) => {
  const { dir, file, run } = fixture(t);
  for (const args of [
    ['publish', '--title', '标题'], ['publish', '--file', file], ['publish', '--title', '标题', '--file'],
    ['publish', '--title', '标题', '--title', '另一个', '--file', file],
    ['publish', '--title', '标题', '--file', file, '--typo'], ['list', '--pin'], ['pin'], ['unpin', 'maintenance'], ['unknown'],
  ]) {
    const result = run(...args);
    assert.equal(result.status, 2, `${args.join(' ')}: ${result.stderr}`);
  }
  assert.equal(fs.existsSync(dir), false);
  assert.equal(run('publish', '--title', '标题', '--id', '../private', '--file', file).status, 1);
  assert.equal(run('publish', '--title', '标题', '--file', path.join(path.dirname(file), 'missing.md')).status, 1);
  assert.equal(fs.existsSync(dir), false);
});

test('CLI environment-selected persistent storage and explicitly selected storage use the same format', (t) => {
  const { dir, file } = fixture(t);
  const env = { ...process.env, SP_ANNOUNCEMENTS_DIR: dir };
  const published = spawnSync(process.execPath, [TOOL, 'publish', '--title', '环境目录公告', '--file', file, '--id', 'environment'], {
    cwd: ROOT, env, encoding: 'utf8', timeout: 10000,
  });
  assert.equal(published.status, 0, published.stderr);
  assert.equal(createAnnouncementStore({ dir }).list().items[0].title, '环境目录公告');
  const duplicate = spawnSync(process.execPath, [TOOL, 'publish', '--title', '重复公告', '--file', file, '--id', 'environment'], {
    cwd: ROOT, env, encoding: 'utf8', timeout: 10000,
  });
  assert.equal(duplicate.status, 1);
  assert.match(duplicate.stderr, /已存在/);
  assert.equal(createAnnouncementStore({ dir }).list().items.length, 1);
});

test('CLI deletion persists, preserves suppression revision and leaves original drafts and shared assets untouched', (t) => {
  const { dir, file, run } = fixture(t);
  assert.equal(run('publish', '--id', 'older', '--title', '旧公告', '--file', file, '--pin').status, 0);
  assert.equal(run('publish', '--id', 'newest', '--title', '新公告', '--file', file).status, 0);
  const revision = JSON.parse(run('list', '--json').stdout).revision;
  const original = fs.readFileSync(file);
  const assets = path.join(dir, 'assets');
  fs.mkdirSync(assets);
  const image = path.join(assets, 'shared.png');
  fs.writeFileSync(image, Buffer.from([1, 2, 3]));
  const deleted = run('delete', 'newest');
  assert.equal(deleted.status, 0, deleted.stderr);
  assert.match(deleted.stdout, /已删除公告 newest/);
  assert.equal(deleted.stderr, '');
  const remaining = JSON.parse(run('list', '--json').stdout);
  assert.equal(remaining.revision, revision);
  assert.equal(remaining.pinnedId, 'older');
  assert.deepEqual(remaining.items.map((item) => item.id), ['older']);
  assert.equal(createAnnouncementStore({ dir }).read('newest'), null);
  assert.equal(fs.existsSync(path.join(dir, 'newest.md')), false);
  const notify = run('notify', 'newest');
  assert.equal(notify.status, 1);
  assert.match(notify.stderr, /不存在或正文不可读取/);
  assert.equal(fs.existsSync(path.join(dir, 'commands')), false, 'a removed target cannot enqueue a new notice');
  assert.equal(run('delete', 'older').status, 0);
  assert.deepEqual(JSON.parse(run('list', '--json').stdout), { revision, pinnedId: null, items: [] });
  assert.match(run('list').stdout, /当前没有公告/);
  assert.equal(fs.existsSync(path.join(dir, 'older.md')), false);
  assert.deepEqual(fs.readFileSync(file), original);
  assert.deepEqual(fs.readFileSync(image), Buffer.from([1, 2, 3]));
  assert.equal(fs.existsSync(path.join(dir, '.write.lock')), false);
});

test('CLI delete rejects missing arguments, unsafe or nonexistent IDs and locked updates with accurate exit status', (t) => {
  const { dir, file, run } = fixture(t);
  for (const args of [['delete'], ['delete', 'one', 'extra'], ['delete', 'one', '--pin'], ['delete', '--id', 'one']]) {
    const result = run(...args);
    assert.equal(result.status, 2, `${args.join(' ')}: ${result.stderr}`);
  }
  assert.equal(fs.existsSync(dir), false);
  assert.equal(run('publish', '--id', 'one', '--title', '公告', '--file', file).status, 0);
  const before = fs.readFileSync(path.join(dir, 'index.json'), 'utf8');
  for (const id of ['../private', 'one.md', 'con', 'missing']) {
    const result = run('delete', id);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, id === 'missing' ? /找不到公告/ : /ID 无效/);
  }
  fs.writeFileSync(path.join(dir, '.write.lock'), 'another writer', 'utf8');
  const locked = run('delete', 'one');
  assert.equal(locked.status, 1);
  assert.match(locked.stderr, /正在更新/);
  assert.equal(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'), before);
  assert.equal(fs.existsSync(path.join(dir, 'one.md')), true);
  assert.equal(fs.readFileSync(path.join(dir, '.write.lock'), 'utf8'), 'another writer');
});
