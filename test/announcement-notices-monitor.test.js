// Explicit announcement notices: immutable commands, per-process fan-out, bounded retries and no restart replay.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ANNOUNCEMENT_INDEX_FILE } from '../shared/announcements.js';
import {
  ANNOUNCEMENT_NOTICE_TYPE, ANNOUNCEMENT_NOTICE_TTL_MS, ANNOUNCEMENT_NOTICE_POLL_MS,
  ANNOUNCEMENT_NOTICE_MAX_COMMAND_BYTES, readAnnouncementNoticeFrame,
} from '../shared/announcementNotices.js';
import { createAnnouncementStore } from '../server/announcements.js';
import {
  ANNOUNCEMENT_NOTICE_COMMAND_DIR, enqueueAnnouncementNotice, createAnnouncementNoticeMonitor,
} from '../server/announcementNotices.js';

const START = Date.parse('2026-10-09T04:00:00.000Z');
const publish = (store, id) => store.publish({ id, title: `公告 ${id}`, markdown: `# ${id}\n\n中文正文。\n` });
const frameOf = ({ id, revision, msgid, createdAt, expiresAt }) => ({
  t: ANNOUNCEMENT_NOTICE_TYPE, id, revision, msgid, createdAt, expiresAt,
});

function socket({ readyState = 1, bufferedAmount = 0, sendError = false } = {}) {
  return {
    readyState, bufferedAmount, frames: [], terminated: 0,
    send(text, done) {
      if (sendError) throw new Error('simulated socket write failure');
      this.frames.push(JSON.parse(text));
      done?.();
    },
    terminate() { this.terminated++; },
  };
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-announcement-notices-'));
  const dir = path.join(root, 'announcements');
  const warnings = [];
  const log = { warn: (line) => warnings.push(line) };
  const store = createAnnouncementStore({ dir, log });
  const network = { conns: new Map(), closed: false };
  const monitors = [];
  let time = START;
  const now = () => time;
  t.after(() => {
    for (const monitor of monitors) monitor.close();
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('sp-announcement-notices-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    root, dir, store, network, warnings, now,
    setTime(value) { time = value; },
    connect(options = {}, connection = { closing: false }) {
      const ws = socket(options); network.conns.set(ws, connection); return ws;
    },
    monitor({ store: reader = store, network: peers = network, start = true } = {}) {
      const monitor = createAnnouncementNoticeMonitor({ store: reader, network: peers, log, now, pollMs: 0 });
      monitors.push(monitor);
      if (start) monitor.start();
      return monitor;
    },
    enqueue(id) { return enqueueAnnouncementNotice({ store, id, now, log }); },
  };
}

const commandDirectory = (dir) => path.join(dir, ANNOUNCEMENT_NOTICE_COMMAND_DIR);
const commandFile = (dir, command) => path.join(commandDirectory(dir), `${command.msgid}.json`);
function putCommand(dir, command, name = `${command.msgid}.json`) {
  fs.mkdirSync(commandDirectory(dir), { recursive: true });
  fs.writeFileSync(path.join(commandDirectory(dir), name), JSON.stringify(command), 'utf8');
}

function withReadFailure(file, action) {
  const read = fs.readFileSync;
  fs.readFileSync = (name, ...args) => {
    if (name === file) throw Object.assign(new Error('simulated temporary read failure'), { code: 'EIO' });
    return read(name, ...args);
  };
  try { return action(); }
  finally { fs.readFileSync = read; }
}

test('notice constants and wire validation enforce the five-minute lifetime and strip content', () => {
  assert.equal(ANNOUNCEMENT_NOTICE_TTL_MS, 300_000);
  assert.equal(ANNOUNCEMENT_NOTICE_POLL_MS, 1000);
  const raw = {
    t: ANNOUNCEMENT_NOTICE_TYPE, id: 'maintenance', revision: 'pub-version', msgid: randomUUID(),
    createdAt: START, expiresAt: START + ANNOUNCEMENT_NOTICE_TTL_MS,
    version: 1, title: 'Private title', markdown: '# Private body', unknown: true,
  };
  const frame = frameOf(raw);
  assert.deepEqual(readAnnouncementNoticeFrame(raw, START), frame);
  assert.notEqual(readAnnouncementNoticeFrame(raw, START), raw);
  assert.deepEqual(readAnnouncementNoticeFrame(raw, raw.expiresAt - 1), frame);
  assert.equal(readAnnouncementNoticeFrame(raw, START - 1), null, 'future commands are not actionable');
  assert.equal(readAnnouncementNoticeFrame(raw, raw.expiresAt), null, 'the exact deadline is expired');
  for (const change of [
    { t: 'announcement.other' }, { id: '../private' }, { id: 'con' }, { revision: '' },
    { msgid: 'not-a-uuid' }, { msgid: '00000000-0000-1000-8000-000000000000' },
    { createdAt: -1 }, { createdAt: START + 0.5 }, { createdAt: '2026-10-09T04:00:00.000Z' },
    { expiresAt: START + ANNOUNCEMENT_NOTICE_TTL_MS + 1 }, { expiresAt: Infinity },
  ]) assert.equal(readAnnouncementNoticeFrame({ ...raw, ...change }, START), null, JSON.stringify(change));
  for (const value of [null, [], {}, 'notice']) assert.equal(readAnnouncementNoticeFrame(value, START), null);
  assert.equal(readAnnouncementNoticeFrame(raw, NaN), null);
  assert.equal(readAnnouncementNoticeFrame(raw, Infinity), null);
});

test('starting and polling an empty installation neither writes files nor reports an error', (t) => {
  const { dir, network, warnings, monitor } = fixture(t);
  const watcher = monitor();
  assert.equal(watcher.poll(), 0);
  assert.equal(network.conns.size, 0);
  assert.equal(fs.existsSync(dir), false);
  assert.deepEqual(warnings, []);
});

test('ordinary publish and pin never enqueue or broadcast a live notice', (t) => {
  const f = fixture(t);
  const ws = f.connect();
  const monitor = f.monitor();
  publish(f.store, 'first'); publish(f.store, 'second');
  f.store.pin('first'); f.store.unpin();
  assert.equal(monitor.poll(), 0);
  assert.deepEqual(ws.frames, []);
  assert.equal(fs.existsSync(commandDirectory(f.dir)), false);
});

test('enqueue persists an independent UUID command for the target item rather than the latest publication', async (t) => {
  const f = fixture(t);
  const first = publish(f.store, 'first');
  const second = publish(f.store, 'second');
  const catalogBefore = fs.readFileSync(path.join(f.dir, ANNOUNCEMENT_INDEX_FILE), 'utf8');
  const [one, two] = await Promise.all([f.enqueue('first'), f.enqueue('first')]);
  assert.notEqual(one.msgid, two.msgid, 'two notify calls never replace each other');
  assert.equal(one.revision, first.revision);
  assert.notEqual(one.revision, second.revision);
  assert.equal(one.createdAt, START);
  assert.equal(one.expiresAt, START + ANNOUNCEMENT_NOTICE_TTL_MS);
  assert.equal(one.version, 1);
  assert.deepEqual(Object.keys(one).sort(), ['createdAt', 'expiresAt', 'id', 'msgid', 'revision', 'version']);
  for (const command of [one, two]) {
    assert.deepEqual(JSON.parse(fs.readFileSync(commandFile(f.dir, command), 'utf8')), command);
  }
  assert.deepEqual(fs.readdirSync(commandDirectory(f.dir)).sort(), [`${one.msgid}.json`, `${two.msgid}.json`].sort());
  assert.equal(fs.readFileSync(path.join(f.dir, ANNOUNCEMENT_INDEX_FILE), 'utf8'), catalogBefore);
});

test('enqueue rejects absent, invalid and unreadable targets without a notification command', async (t) => {
  const f = fixture(t);
  for (const id of ['missing', '../private', 'con', '']) await assert.rejects(f.enqueue(id));
  assert.equal(fs.existsSync(commandDirectory(f.dir)), false);
  publish(f.store, 'unreadable');
  fs.writeFileSync(path.join(f.dir, 'unreadable.md'), '# broken body', 'utf8');
  await assert.rejects(f.enqueue('unreadable'), /不存在或正文不可读取/);
  assert.equal(fs.existsSync(commandDirectory(f.dir)), false);
});

test('every online socket receives one metadata frame, including prehello, lobby, game and spectator connections', async (t) => {
  const f = fixture(t);
  publish(f.store, 'maintenance');
  const active = [
    f.connect({}, { closing: false }),
    f.connect({}, { closing: false, session: { route: 'Lobby' } }),
    f.connect({}, { closing: false, session: { route: 'Game' } }),
    f.connect({}, { closing: false, session: { route: 'Game', spectator: true } }),
  ];
  const closed = f.connect({ readyState: 3 });
  const closing = f.connect({}, { closing: true });
  const failed = f.connect({ sendError: true });
  const afterFailed = f.connect();
  // A disconnected/AI seat has no connection entry and cannot receive a notice.
  const disconnected = socket();
  const monitor = f.monitor();
  const command = await f.enqueue('maintenance');
  assert.equal(monitor.poll(), 1);
  for (const ws of [...active, afterFailed]) assert.deepEqual(ws.frames, [frameOf(command)]);
  for (const ws of [closed, closing, failed, disconnected]) assert.deepEqual(ws.frames, []);
  assert.equal(monitor.poll(), 0);
  for (const ws of active) assert.equal(ws.frames.length, 1);
  assert.deepEqual(Object.keys(active[0].frames[0]).sort(), ['createdAt', 'expiresAt', 'id', 'msgid', 'revision', 't']);
});

test('one scan handles all newly queued commands, without selecting only the newest', async (t) => {
  const f = fixture(t);
  publish(f.store, 'one'); publish(f.store, 'two');
  const ws = f.connect();
  const monitor = f.monitor();
  const commands = [await f.enqueue('one'), await f.enqueue('two'), await f.enqueue('one')];
  assert.equal(monitor.poll(), 3);
  assert.equal(ws.frames.length, 3);
  assert.deepEqual(new Set(ws.frames.map((frame) => frame.msgid)), new Set(commands.map((command) => command.msgid)));
  assert.equal(monitor.poll(), 0);
});

test('pending notices broadcast by creation time, using UUID order only to break equal timestamps', (t) => {
  const f = fixture(t);
  const item = publish(f.store, 'one');
  const ws = f.connect();
  const monitor = f.monitor();
  const make = (msgid, offset) => ({
    version: 1, id: item.id, revision: item.revision, msgid,
    createdAt: START + offset, expiresAt: START + offset + ANNOUNCEMENT_NOTICE_TTL_MS,
  });
  const earlier = make('ffffffff-ffff-4fff-8fff-ffffffffffff', 1);
  const equalTime = make('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 1);
  const later = make('00000000-0000-4000-8000-000000000000', 2);
  for (const command of [later, earlier, equalTime]) putCommand(f.dir, command);
  f.setTime(START + 2);
  assert.equal(monitor.poll(), 3);
  assert.deepEqual(ws.frames, [frameOf(equalTime), frameOf(earlier), frameOf(later)]);
});

test('a restart skips existing commands, while later commands still broadcast', async (t) => {
  const f = fixture(t);
  publish(f.store, 'one');
  const existing = await f.enqueue('one');
  const ws = f.connect();
  const monitor = f.monitor();
  assert.equal(monitor.poll(), 0);
  const later = await f.enqueue('one');
  assert.equal(monitor.poll(), 1);
  assert.deepEqual(ws.frames, [frameOf(later)]);
  assert.equal(fs.existsSync(commandFile(f.dir, existing)), true, 'the monitor leaves the old command in place');
  monitor.close();
  const restarted = f.monitor();
  assert.equal(restarted.poll(), 0);
  assert.equal(ws.frames.length, 1);
});

test('separate server processes sharing a command directory each consume every new UUID once', async (t) => {
  const f = fixture(t);
  publish(f.store, 'one');
  const firstSocket = f.connect();
  const secondSocket = socket();
  const first = f.monitor();
  const second = f.monitor({ network: { conns: new Map([[secondSocket, { closing: false }]]) } });
  const command = await f.enqueue('one');
  assert.equal(first.poll(), 1);
  assert.equal(second.poll(), 1);
  assert.deepEqual(firstSocket.frames, [frameOf(command)]);
  assert.deepEqual(secondSocket.frames, [frameOf(command)]);
  assert.equal(first.poll(), 0); assert.equal(second.poll(), 0);
  assert.equal(fs.existsSync(commandFile(f.dir, command)), true);
});

test('a delivered UUID cannot replay after its file disappears and is restored during the same lifetime', async (t) => {
  const f = fixture(t);
  publish(f.store, 'one');
  const ws = f.connect();
  const monitor = f.monitor();
  const command = await f.enqueue('one');
  assert.equal(monitor.poll(), 1);
  fs.unlinkSync(commandFile(f.dir, command));
  assert.equal(monitor.poll(), 0);
  f.setTime(START + 1000);
  putCommand(f.dir, command);
  assert.equal(monitor.poll(), 0);
  assert.deepEqual(ws.frames, [frameOf(command)]);
});

test('notices seen while nobody is connected are not replayed to a later connection', async (t) => {
  const f = fixture(t);
  publish(f.store, 'one');
  const monitor = f.monitor();
  await f.enqueue('one');
  assert.equal(monitor.poll(), 1);
  const later = f.connect();
  assert.equal(monitor.poll(), 0);
  assert.deepEqual(later.frames, []);
});

test('temporary command-file IO failure is retried within the TTL and never duplicates successful delivery', async (t) => {
  const f = fixture(t);
  publish(f.store, 'one');
  const ws = f.connect();
  const monitor = f.monitor();
  const command = await f.enqueue('one');
  withReadFailure(commandFile(f.dir, command), () => {
    assert.equal(monitor.poll(), 0);
    assert.equal(monitor.poll(), 0);
  });
  assert.deepEqual(ws.frames, []);
  assert.ok(f.warnings.length > 0);
  f.setTime(START + 1000);
  assert.equal(monitor.poll(), 1);
  assert.equal(monitor.poll(), 0);
  assert.deepEqual(ws.frames, [frameOf(command)]);
});

test('an unreadable announcement retries after recovery, and an expired retry is discarded', async (t) => {
  const f = fixture(t);
  publish(f.store, 'one');
  const reader = createAnnouncementStore({ dir: f.dir, log: { warn: (line) => f.warnings.push(line) } });
  const ws = f.connect();
  const monitor = f.monitor({ store: reader });
  const command = await f.enqueue('one');
  const bodyFile = path.join(f.dir, 'one.md');
  const original = fs.readFileSync(bodyFile);
  fs.writeFileSync(bodyFile, '# damaged', 'utf8');
  assert.equal(monitor.poll(), 0, 'a fresh reader has no valid cached body');
  fs.writeFileSync(bodyFile, original);
  f.setTime(START + 1000);
  assert.equal(monitor.poll(), 1);
  assert.deepEqual(ws.frames, [frameOf(command)]);
  const later = await f.enqueue('one');
  withReadFailure(commandFile(f.dir, later), () => assert.equal(monitor.poll(), 0));
  f.setTime(later.expiresAt);
  assert.equal(monitor.poll(), 0);
  assert.equal(ws.frames.length, 1);
  assert.equal(fs.existsSync(commandFile(f.dir, later)), true, 'expiration does not let the monitor delete files');
});

test('a previously verified body may be served from the ordinary store cache without mixing publication revisions', async (t) => {
  const f = fixture(t);
  const item = publish(f.store, 'one');
  const reader = createAnnouncementStore({ dir: f.dir, log: { warn: (line) => f.warnings.push(line) } });
  assert.equal(reader.read('one').revision, item.revision);
  const ws = f.connect();
  const monitor = f.monitor({ store: reader });
  const cached = await f.enqueue('one');
  const bodyFile = path.join(f.dir, 'one.md');
  const original = fs.readFileSync(bodyFile);
  fs.writeFileSync(bodyFile, '# damaged', 'utf8');
  assert.equal(monitor.poll(), 1, 'the ordinary read endpoint still has a verified body of this revision');
  assert.deepEqual(ws.frames, [frameOf(cached)]);
  fs.writeFileSync(bodyFile, original);
  const stale = await f.enqueue('one');
  const catalogFile = path.join(f.dir, ANNOUNCEMENT_INDEX_FILE);
  const catalog = JSON.parse(fs.readFileSync(catalogFile, 'utf8'));
  catalog.items[0].revision = `pub-changed-${randomUUID()}`;
  catalog.revision = catalog.items[0].revision;
  fs.writeFileSync(catalogFile, JSON.stringify(catalog), 'utf8');
  assert.equal(monitor.poll(), 0, 'new source metadata invalidates the old cached revision');
  assert.equal(ws.frames.length, 1);
  assert.ok(f.warnings.some((line) => line.includes('版本不一致')));
  putCommand(f.dir, stale);
  assert.equal(monitor.poll(), 0);
});

test('a rebuilt directory notice retries after a damaged new catalog temporarily exposes an old cached revision', async (t) => {
  const f = fixture(t);
  const previous = publish(f.store, 'one');
  assert.equal(f.store.read('one').revision, previous.revision);
  const ws = f.connect();
  const monitor = f.monitor();
  const archivedDir = path.join(f.root, 'previous-announcements');
  assert.equal(path.dirname(path.resolve(f.dir)), path.resolve(f.root));
  assert.equal(path.dirname(path.resolve(archivedDir)), path.resolve(f.root));
  fs.renameSync(f.dir, archivedDir);
  const rebuilt = createAnnouncementStore({ dir: f.dir, log: { warn: (line) => f.warnings.push(line) } });
  const current = rebuilt.publish({ id: 'one', title: 'Rebuilt announcement', markdown: '# New directory content\n' });
  assert.notEqual(current.revision, previous.revision);
  f.setTime(START + 1000);
  const command = await enqueueAnnouncementNotice({ store: rebuilt, id: 'one', now: f.now });
  const catalogFile = path.join(f.dir, ANNOUNCEMENT_INDEX_FILE);
  const catalog = fs.readFileSync(catalogFile);
  fs.writeFileSync(catalogFile, '{ temporary damaged new catalog', 'utf8');
  assert.equal(monitor.poll(), 0);
  assert.equal(f.store.read('one').revision, previous.revision, 'the old reader falls back to its previous valid revision');
  assert.deepEqual(ws.frames, []);
  assert.ok(f.warnings.some((line) => line.includes('版本不一致')));
  fs.writeFileSync(catalogFile, catalog);
  f.setTime(START + 2000);
  assert.equal(monitor.poll(), 1, 'the new publication is retried after the catalog recovers within its TTL');
  assert.equal(monitor.poll(), 0);
  assert.deepEqual(ws.frames, [frameOf(command)]);
  assert.equal(f.store.read('one').revision, current.revision);
});

test('temporary thrown or null announcement reads do not prevent other pending notices from being processed', async (t) => {
  const f = fixture(t);
  publish(f.store, 'one'); publish(f.store, 'two');
  const ws = f.connect();
  const monitor = f.monitor();
  const one = await f.enqueue('one');
  const two = await f.enqueue('two');
  const read = f.store.read.bind(f.store);
  let mode = 'throw';
  f.store.read = (id) => {
    if (id === 'one' && mode === 'throw') throw new Error('temporary source failure');
    if (id === 'one' && mode === 'null') return null;
    return read(id);
  };
  assert.equal(monitor.poll(), 1);
  assert.deepEqual(ws.frames, [frameOf(two)]);
  mode = 'null';
  assert.equal(monitor.poll(), 0);
  mode = 'ready';
  assert.equal(monitor.poll(), 1);
  assert.deepEqual(ws.frames, [frameOf(two), frameOf(one)]);
});

test('malformed, oversized, future, expired and mismatched commands cannot block a valid notice', async (t) => {
  const f = fixture(t);
  publish(f.store, 'one');
  const ws = f.connect();
  const monitor = f.monitor();
  const valid = await f.enqueue('one');
  const make = (change = {}) => ({ ...valid, msgid: randomUUID(), ...change });
  const malformed = make();
  fs.writeFileSync(commandFile(f.dir, malformed), '{ invalid JSON', 'utf8');
  const oversized = make();
  fs.writeFileSync(commandFile(f.dir, oversized), 'a'.repeat(ANNOUNCEMENT_NOTICE_MAX_COMMAND_BYTES + 1), 'utf8');
  const invalidUtf8 = make();
  fs.writeFileSync(commandFile(f.dir, invalidUtf8), Buffer.from([0xff, 0xfe]));
  for (const command of [
    make({ version: 2 }), make({ id: '../private' }), make({ revision: 'pub-other-version' }),
    make({ createdAt: START - ANNOUNCEMENT_NOTICE_TTL_MS, expiresAt: START }),
    make({ createdAt: START + 1000, expiresAt: START + 1000 + ANNOUNCEMENT_NOTICE_TTL_MS }),
  ]) putCommand(f.dir, command);
  const duplicateBody = make();
  putCommand(f.dir, duplicateBody, `${randomUUID()}.json`);
  putCommand(f.dir, make(), 'manual-note.json');
  fs.mkdirSync(commandFile(f.dir, make()));
  assert.equal(monitor.poll(), 1);
  assert.deepEqual(ws.frames, [frameOf(valid)]);
  assert.equal(monitor.poll(), 0);
  assert.ok(f.warnings.length > 0);
});

test('a damaged catalog on a fresh reader is logged and recovered without stopping the monitor', async (t) => {
  const f = fixture(t);
  publish(f.store, 'one');
  const ws = f.connect();
  const reader = createAnnouncementStore({ dir: f.dir, log: { warn: (line) => f.warnings.push(line) } });
  const monitor = f.monitor({ store: reader });
  const command = await f.enqueue('one');
  const file = path.join(f.dir, ANNOUNCEMENT_INDEX_FILE);
  const catalog = fs.readFileSync(file);
  fs.writeFileSync(file, '{ damaged', 'utf8');
  assert.equal(monitor.poll(), 0);
  assert.deepEqual(ws.frames, []);
  assert.ok(f.warnings.length > 0);
  fs.writeFileSync(file, catalog);
  assert.equal(monitor.poll(), 1);
  assert.deepEqual(ws.frames, [frameOf(command)]);
});

test('a failed startup snapshot stays uninitialized until the directory can be safely enumerated', async (t) => {
  const f = fixture(t);
  publish(f.store, 'one');
  await f.enqueue('one');
  const ws = f.connect();
  const readDirectory = fs.readdirSync;
  fs.readdirSync = (dir, ...args) => {
    if (dir === commandDirectory(f.dir)) throw Object.assign(new Error('temporary directory failure'), { code: 'EIO' });
    return readDirectory(dir, ...args);
  };
  let monitor;
  try { monitor = f.monitor(); assert.equal(monitor.poll(), 0); }
  finally { fs.readdirSync = readDirectory; }
  assert.equal(monitor.poll(), 0, 'recovery snapshots existing files rather than replaying them');
  const later = await f.enqueue('one');
  assert.equal(monitor.poll(), 1);
  assert.deepEqual(ws.frames, [frameOf(later)]);
});

test('enqueue prunes only expired matching UUID regular files and keeps valid or unrelated files', async (t) => {
  const f = fixture(t);
  publish(f.store, 'one');
  const expired = await f.enqueue('one');
  f.setTime(START + ANNOUNCEMENT_NOTICE_TTL_MS - 1000);
  const valid = await f.enqueue('one');
  const unrelated = 'operator-note.json';
  const malformed = `${randomUUID()}.json`;
  const mismatched = `${randomUUID()}.json`;
  putCommand(f.dir, expired, unrelated);
  fs.writeFileSync(path.join(commandDirectory(f.dir), malformed), '{ invalid', 'utf8');
  putCommand(f.dir, expired, mismatched);
  const directoryName = `${randomUUID()}.json`;
  fs.mkdirSync(path.join(commandDirectory(f.dir), directoryName));
  f.setTime(expired.expiresAt);
  const fresh = await f.enqueue('one');
  assert.equal(fs.existsSync(commandFile(f.dir, expired)), false);
  for (const name of [`${valid.msgid}.json`, `${fresh.msgid}.json`, unrelated, malformed, mismatched, directoryName]) {
    assert.equal(fs.existsSync(path.join(commandDirectory(f.dir), name)), true, name);
  }
  assert.equal(fs.existsSync(path.join(commandDirectory(f.dir), '.notice.write.lock')), false);
});

test('close and network shutdown stop further delivery and remain safe when repeated', async (t) => {
  const f = fixture(t);
  publish(f.store, 'one');
  const ws = f.connect();
  const monitor = f.monitor();
  await f.enqueue('one');
  f.network.closed = true;
  assert.equal(monitor.poll(), 0);
  f.network.closed = false;
  monitor.close(); monitor.close(); monitor.start();
  assert.equal(monitor.poll(), 0);
  assert.deepEqual(ws.frames, []);
});
