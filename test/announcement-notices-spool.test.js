// Explicit notices are immutable UUID commands, not publications: safe cleanup, concurrent CLI and wire metadata.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createAnnouncementStore } from '../server/announcements.js';
import { enqueueAnnouncementNotice, ANNOUNCEMENT_NOTICE_COMMAND_DIR } from '../server/announcementNotices.js';
import {
  ANNOUNCEMENT_NOTICE_TYPE, ANNOUNCEMENT_NOTICE_TTL_MS, isAnnouncementNoticeId,
  readAnnouncementNoticeCommand, readAnnouncementNoticeFrame,
} from '../shared/announcementNotices.js';

const TOOL = fileURLToPath(new URL('../tools/announcements.mjs', import.meta.url));
const ROOT = path.resolve(path.dirname(TOOL), '..');
const TIME = Date.parse('2026-10-09T04:00:00.000Z');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-announcement-notices-spool-'));
  t.after(() => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('sp-announcement-notices-spool-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const dir = path.join(root, 'announcements');
  const warnings = [];
  const store = createAnnouncementStore({ dir, log: { warn: (line) => warnings.push(line) } });
  const first = store.publish({ id: 'first', title: '维护提示', markdown: '# 维护\n请稍候。\n' });
  const commands = path.join(dir, ANNOUNCEMENT_NOTICE_COMMAND_DIR);
  const commandFiles = () => fs.existsSync(commands) ? fs.readdirSync(commands).filter((name) => name.endsWith('.json')) : [];
  const read = (msgid) => JSON.parse(fs.readFileSync(path.join(commands, `${msgid}.json`), 'utf8'));
  return { root, dir, store, first, commands, commandFiles, read, warnings };
}

test('ordinary publishing/pinning creates no notice; notify references the selected item, never the newest global revision', async (t) => {
  const { store, first, commands, commandFiles, read } = fixture(t);
  const latest = store.publish({ id: 'latest', title: '新公告', markdown: '# 新内容\n' });
  store.pin(first.id); store.unpin();
  assert.equal(fs.existsSync(commands), false);
  const before = store.list();
  const notice = await enqueueAnnouncementNotice({ store, id: first.id, now: () => TIME });
  assert.equal(notice.revision, first.revision);
  assert.notEqual(notice.revision, latest.revision);
  assert.equal(notice.createdAt, TIME);
  assert.equal(notice.expiresAt, TIME + ANNOUNCEMENT_NOTICE_TTL_MS);
  assert.equal(isAnnouncementNoticeId(notice.msgid), true);
  assert.deepEqual(read(notice.msgid), notice);
  assert.deepEqual(commandFiles(), [`${notice.msgid}.json`]);
  assert.deepEqual(store.list(), before, 'notify neither publishes nor changes pin/suppression');
});

test('concurrent notify calls append separate atomic commands, even at the same timestamp', async (t) => {
  const { store, commands, commandFiles, read } = fixture(t);
  const [first, second] = await Promise.all([
    enqueueAnnouncementNotice({ store, id: 'first', now: () => TIME }),
    enqueueAnnouncementNotice({ store, id: 'first', now: () => TIME }),
  ]);
  assert.notEqual(first.msgid, second.msgid);
  assert.equal(commandFiles().length, 2);
  assert.deepEqual(read(first.msgid), first);
  assert.deepEqual(read(second.msgid), second);
  assert.equal(fs.readdirSync(commands).some((name) => name.startsWith('.') && name !== '.keep'), false);
});

test('enqueue prunes only expired matching-UUID regular commands and retains every still-valid command', async (t) => {
  const { store, commands, commandFiles } = fixture(t);
  const expired = await enqueueAnnouncementNotice({ store, id: 'first', now: () => TIME });
  const live = await enqueueAnnouncementNotice({ store, id: 'first', now: () => TIME + ANNOUNCEMENT_NOTICE_TTL_MS - 1 });
  fs.writeFileSync(path.join(commands, 'notes.json'), '{ operator data }', 'utf8');
  const broken = randomUUID();
  fs.writeFileSync(path.join(commands, `${broken}.json`), '{ malformed', 'utf8');
  const mismatched = randomUUID();
  fs.writeFileSync(path.join(commands, `${mismatched}.json`), JSON.stringify(expired), 'utf8');
  const folder = randomUUID();
  fs.mkdirSync(path.join(commands, `${folder}.json`));
  const newest = await enqueueAnnouncementNotice({ store, id: 'first', now: () => TIME + ANNOUNCEMENT_NOTICE_TTL_MS });
  assert.equal(fs.existsSync(path.join(commands, `${expired.msgid}.json`)), false);
  for (const name of [`${live.msgid}.json`, `${newest.msgid}.json`, `${broken}.json`, `${mismatched}.json`, `${folder}.json`, 'notes.json']) {
    assert.equal(commandFiles().includes(name), true, name);
  }
});

test('invalid IDs, unavailable Markdown and invalid timestamps never produce a notice', async (t) => {
  const { dir, store, commands, commandFiles } = fixture(t);
  await assert.rejects(enqueueAnnouncementNotice({ store, id: '../private' }), /ID 无效/);
  await assert.rejects(enqueueAnnouncementNotice({ store, id: 'missing' }), /不存在或正文不可读取/);
  assert.equal(fs.existsSync(commands), false);
  await assert.rejects(enqueueAnnouncementNotice({ store, id: 'first', now: () => Number.NaN }), /通知时间无效/);
  assert.deepEqual(commandFiles(), []);
  fs.writeFileSync(path.join(dir, 'first.md'), '# corrupted', 'utf8');
  const fresh = createAnnouncementStore({ dir, log: { warn() {} } });
  await assert.rejects(enqueueAnnouncementNotice({ store: fresh, id: 'first' }), /不存在或正文不可读取/);
  assert.deepEqual(commandFiles(), []);
});

test('command rename failure leaves no malformed final file or publisher lock', async (t) => {
  const { store, commands, commandFiles } = fixture(t);
  const rename = fs.renameSync;
  fs.renameSync = () => { throw new Error('simulated notice disk failure'); };
  try { await assert.rejects(enqueueAnnouncementNotice({ store, id: 'first', now: () => TIME }), /simulated notice disk failure/); }
  finally { fs.renameSync = rename; }
  assert.deepEqual(commandFiles(), []);
  assert.deepEqual(fs.readdirSync(commands), []);
});

test('cleanup never follows command symlinks or writes through a symlinked command directory', async (t) => {
  const { root, store, commands } = fixture(t);
  const expired = await enqueueAnnouncementNotice({ store, id: 'first', now: () => TIME });
  const outside = path.join(root, 'operator-private.json');
  fs.writeFileSync(outside, JSON.stringify(expired), 'utf8');
  fs.unlinkSync(path.join(commands, `${expired.msgid}.json`));
  try { fs.symlinkSync(outside, path.join(commands, `${expired.msgid}.json`)); }
  catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) { t.skip('当前 Windows 会话没有创建文件符号链接权限'); return; }
    throw error;
  }
  await enqueueAnnouncementNotice({ store, id: 'first', now: () => TIME + ANNOUNCEMENT_NOTICE_TTL_MS });
  assert.equal(fs.lstatSync(path.join(commands, `${expired.msgid}.json`)).isSymbolicLink(), true);
  assert.equal(fs.existsSync(outside), true);
  const saved = path.join(root, 'saved-commands');
  fs.renameSync(commands, saved);
  fs.symlinkSync(saved, commands, 'junction');
  await assert.rejects(enqueueAnnouncementNotice({ store, id: 'first' }), /真实目录/);
});

test('wire parser exposes exactly the declared reference/timestamps and rejects expired, future and malformed notices', () => {
  const command = { version: 1, id: 'first', revision: 'pub-test', msgid: randomUUID(), createdAt: TIME, expiresAt: TIME + ANNOUNCEMENT_NOTICE_TTL_MS };
  const frame = { t: ANNOUNCEMENT_NOTICE_TYPE, ...command, title: 'private title', markdown: 'not a wire body' };
  assert.deepEqual(readAnnouncementNoticeCommand(command), command);
  assert.deepEqual(readAnnouncementNoticeFrame(frame, TIME), {
    t: ANNOUNCEMENT_NOTICE_TYPE, id: command.id, revision: command.revision, msgid: command.msgid, createdAt: command.createdAt, expiresAt: command.expiresAt,
  });
  assert.ok(readAnnouncementNoticeFrame(frame, command.expiresAt - 1));
  assert.equal(readAnnouncementNoticeFrame(frame, command.expiresAt), null);
  assert.equal(readAnnouncementNoticeFrame(frame, TIME - 1), null);
  for (const extra of [
    { t: 'm.toast' }, { id: '../private' }, { revision: '' }, { msgid: '../private' },
    { createdAt: '2026-10-09' }, { createdAt: -1 }, { expiresAt: command.expiresAt + 1 }, { expiresAt: Infinity },
  ]) assert.equal(readAnnouncementNoticeFrame({ ...frame, ...extra }, TIME), null, JSON.stringify(extra));
  assert.equal(readAnnouncementNoticeCommand({ ...command, version: 2 }), null);
  assert.equal(readAnnouncementNoticeFrame(null, TIME), null);
});

function runCli(dir, ...args) {
  return spawnSync(process.execPath, [TOOL, ...args, '--dir', dir], { cwd: ROOT, env: { ...process.env, SP_ANNOUNCEMENTS_DIR: '' }, encoding: 'utf8', timeout: 10000 });
}

function runCliAsync(dir, ...args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [TOOL, ...args, '--dir', dir], { cwd: ROOT, env: { ...process.env, SP_ANNOUNCEMENTS_DIR: '' }, windowsHide: true });
    let stdout = ''; let stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; }); child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject); child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

test('CLI notify explicitly queues a reference with UTF-8 confirmation; usage failures create nothing', (t) => {
  const { dir, commands, commandFiles, first } = fixture(t);
  const missing = runCli(dir, 'notify');
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /发送通知需要指定公告 ID/);
  assert.equal(fs.existsSync(commands), false);
  assert.equal(runCli(dir, 'notify', 'missing').status, 1);
  assert.equal(runCli(dir, 'notify', 'first', '--pin').status, 2);
  assert.equal(runCli(dir, 'notify', 'first', 'extra').status, 2);
  assert.equal(fs.existsSync(commands), false);
  const result = runCli(dir, 'notify', 'first');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /已提交发送命令，运行中的服务器将在约1秒内通知在线玩家/);
  const command = JSON.parse(fs.readFileSync(path.join(commands, commandFiles()[0]), 'utf8'));
  assert.equal(command.id, first.id); assert.equal(command.revision, first.revision);
  assert.equal(command.expiresAt - command.createdAt, ANNOUNCEMENT_NOTICE_TTL_MS);
  assert.equal('markdown' in command, false);
});

test('two simultaneous CLI processes both succeed and retain two independent notices', async (t) => {
  const { dir, commands, commandFiles } = fixture(t);
  const results = await Promise.all([runCliAsync(dir, 'notify', 'first'), runCliAsync(dir, 'notify', 'first')]);
  for (const result of results) assert.equal(result.status, 0, result.stderr);
  assert.equal(commandFiles().length, 2);
  const ids = commandFiles().map((name) => JSON.parse(fs.readFileSync(path.join(commands, name), 'utf8')).msgid);
  assert.notEqual(ids[0], ids[1]);
  assert.equal(fs.existsSync(path.join(commands, '.notice.write.lock')), false);
});
