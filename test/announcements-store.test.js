// Ordinary announcements: persistent publication revision, history/pinning, safe filesystem reads and atomic writes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  ANNOUNCEMENT_INDEX_FILE, ANNOUNCEMENT_MAX_BODY_CHARS, ANNOUNCEMENT_MAX_BODY_BYTES, ANNOUNCEMENT_MAX_TITLE_LENGTH,
  isAnnouncementId, readAnnouncementIndex, defaultAnnouncementId, shouldShowAnnouncements,
} from '../shared/announcements.js';
import { announcementDirectory, createAnnouncementStore, readAnnouncementMarkdown } from '../server/announcements.js';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-announcements-store-'));
  t.after(() => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('sp-announcements-store-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const dir = path.join(root, 'announcements');
  const warnings = [];
  const store = createAnnouncementStore({ dir, log: { warn: (line) => warnings.push(line) } });
  return { root, dir, store, warnings };
}

const publish = (store, id, extra = {}) => store.publish({ id, title: `公告 ${id}`, markdown: `# ${id}\n\n中文正文。\n`, ...extra });
const catalogOf = (dir) => JSON.parse(fs.readFileSync(path.join(dir, ANNOUNCEMENT_INDEX_FILE), 'utf8'));
const putCatalog = (dir, catalog) => fs.writeFileSync(path.join(dir, ANNOUNCEMENT_INDEX_FILE), JSON.stringify(catalog), 'utf8');

test('missing announcement directory succeeds as an empty list, without creating runtime files', (t) => {
  const { dir, store, warnings } = fixture(t);
  assert.deepEqual(store.list(), { revision: '', pinnedId: null, items: [] });
  assert.equal(store.read('missing'), null);
  assert.equal(defaultAnnouncementId(store.list()), null);
  assert.equal(shouldShowAnnouncements(store.list(), null), false);
  assert.equal(fs.existsSync(dir), false);
  assert.deepEqual(warnings, []);
});

test('directory choice is explicit option, then environment, then runtime below the selected root', (t) => {
  const { root } = fixture(t);
  assert.equal(announcementDirectory({ root, env: {} }), path.join(root, 'runtime', 'announcements'));
  assert.equal(announcementDirectory({ root, env: { SP_ANNOUNCEMENTS_DIR: 'persistent' } }), path.join(root, 'persistent'));
  assert.equal(announcementDirectory({ root, dir: 'chosen', env: { SP_ANNOUNCEMENTS_DIR: 'ignored' } }), path.join(root, 'chosen'));
});

test('publication persists metadata and UTF-8 Markdown; a fresh server sees later publications without restart', (t) => {
  const { dir, store } = fixture(t);
  const first = publish(store, 'first', { markdown: '\uFEFF# 中文标题\r\n正文\r\n', publishedAt: '2026-10-09T04:00:00.000Z' });
  const reader = createAnnouncementStore({ dir });
  assert.deepEqual(reader.read('first'), { ...first, markdown: '# 中文标题\n正文\n' });
  const second = publish(store, 'second', { publishedAt: '2026-01-01T00:00:00.000Z' });
  const index = reader.list();
  assert.deepEqual(index.items, [second, first], 'publication order is independent of a displayed date');
  assert.equal(index.revision, second.revision);
  assert.equal(defaultAnnouncementId(index), 'second');
  assert.deepEqual(Object.keys(index.items[0]).sort(), ['id', 'publishedAt', 'revision', 'title']);
  assert.match(catalogOf(dir).items[0].sha256, /^[a-f0-9]{64}$/);
  assert.equal(fs.readdirSync(dir).some((name) => name.startsWith('.tmp-') || name === '.write.lock'), false);
});

test('pinning is single-valued and never changes the publication suppression revision', (t) => {
  const { store } = fixture(t);
  publish(store, 'one'); publish(store, 'two');
  const dismissed = store.list().revision;
  store.pin('one');
  assert.equal(defaultAnnouncementId(store.list()), 'one');
  assert.equal(store.list().revision, dismissed);
  assert.equal(shouldShowAnnouncements(store.list(), dismissed), false);
  store.pin('two');
  assert.equal(store.list().pinnedId, 'two');
  store.unpin();
  assert.equal(defaultAnnouncementId(store.list()), 'two');
  assert.equal(store.list().revision, dismissed);
  publish(store, 'three', { pin: true });
  assert.equal(defaultAnnouncementId(store.list()), 'three');
  assert.equal(shouldShowAnnouncements(store.list(), dismissed), true);
});

test('new persistent publication tokens do not collide when a storage directory is recreated', (t) => {
  const { root, store } = fixture(t);
  const one = publish(store, 'one').revision;
  const fresh = createAnnouncementStore({ dir: path.join(root, 'fresh') });
  const two = publish(fresh, 'one').revision;
  assert.notEqual(one, two);
  assert.equal(shouldShowAnnouncements(fresh.list(), one), true);
});

test('a pin survives publication of a newer announcement; history and latest revision both advance', (t) => {
  const { store } = fixture(t);
  const pinned = publish(store, 'pinned', { pin: true });
  const newer = publish(store, 'newer');
  const index = store.list();
  assert.equal(index.pinnedId, pinned.id);
  assert.equal(index.revision, newer.revision);
  assert.equal(defaultAnnouncementId(index), pinned.id);
  assert.equal(shouldShowAnnouncements(index, pinned.revision), true);
});

test('bad indexes preserve the last valid metadata; fresh stores return empty and log once', (t) => {
  const { dir, store, warnings } = fixture(t);
  publish(store, 'one');
  const before = store.list();
  fs.writeFileSync(path.join(dir, ANNOUNCEMENT_INDEX_FILE), '{ malformed', 'utf8');
  assert.deepEqual(store.list(), before);
  assert.deepEqual(store.list(), before);
  assert.equal(warnings.length, 1);
  const freshWarnings = [];
  const fresh = createAnnouncementStore({ dir, log: { warn: (line) => freshWarnings.push(line) } });
  assert.deepEqual(fresh.list(), { revision: '', pinnedId: null, items: [] });
  assert.equal(freshWarnings.length, 1);
  assert.throws(() => publish(store, 'two'), /未作修改/);
  assert.equal(fs.readFileSync(path.join(dir, ANNOUNCEMENT_INDEX_FILE), 'utf8'), '{ malformed');
  assert.equal(fs.existsSync(path.join(dir, 'two.md')), false);
  assert.equal(fs.existsSync(path.join(dir, '.write.lock')), false);
});

test('a corrupted body returns its prior verified copy and cannot be carried into a rewritten catalog', (t) => {
  const { dir, store, warnings } = fixture(t);
  const one = publish(store, 'one');
  const good = store.read(one.id);
  const bytes = fs.readFileSync(path.join(dir, 'one.md'));
  bytes[0] = bytes[0] === 35 ? 36 : 35;
  fs.writeFileSync(path.join(dir, 'one.md'), bytes);
  assert.deepEqual(store.read('one'), good);
  assert.equal(warnings.length, 1);
  assert.throws(() => store.pin('one'), /正文校验失败/);
  assert.throws(() => publish(store, 'two'), /正文校验失败/);
  assert.equal(store.list().revision, one.revision);
});

test('invalid catalog members never replace a known valid state or provide arbitrary file paths', (t) => {
  const { dir, store } = fixture(t);
  publish(store, 'one');
  const before = store.list();
  const original = catalogOf(dir);
  for (const change of [
    (index) => { index.items[0].id = '../private'; },
    (index) => { index.pinnedId = 'missing'; },
    (index) => { index.revision = 'invalid revision'; },
    (index) => { index.items.push({ ...index.items[0] }); },
    (index) => { index.items[0].bytes += 1; },
  ]) {
    const bad = structuredClone(original); change(bad); putCatalog(dir, bad);
    assert.deepEqual(store.list(), before);
  }
  for (const id of ['../private', '/private', 'one.md', 'one/../private', '%2e%2e', 'CON', 'con', 'lpt1', '']) {
    assert.equal(store.read(id), null, id);
    assert.equal(isAnnouncementId(id), false, id);
  }
  putCatalog(dir, original);
  assert.ok(store.read('one'));
});

test('publication validation rejects empty/oversized content and duplicate IDs without overwriting files', (t) => {
  const { dir, store } = fixture(t);
  const good = publish(store, 'one');
  const index = fs.readFileSync(path.join(dir, ANNOUNCEMENT_INDEX_FILE), 'utf8');
  for (const extra of [
    { title: '' }, { title: 'a'.repeat(ANNOUNCEMENT_MAX_TITLE_LENGTH + 1) }, { title: 'bad\ntitle' },
    { markdown: ' \n\t' }, { markdown: 'a'.repeat(ANNOUNCEMENT_MAX_BODY_BYTES + 1) }, { markdown: '\u0000bad' },
    { id: '../bad' }, { publishedAt: 'not-a-date' }, { id: 'one' },
  ]) assert.throws(() => publish(store, 'new', extra));
  assert.equal(fs.readFileSync(path.join(dir, ANNOUNCEMENT_INDEX_FILE), 'utf8'), index);
  assert.equal(store.read(good.id).title, good.title);
  assert.throws(() => store.pin('missing'), /找不到公告/);
});

test('an administration lock rejects concurrent updates without modifying existing metadata', (t) => {
  const { dir, store } = fixture(t);
  publish(store, 'one');
  const before = store.list();
  fs.writeFileSync(path.join(dir, '.write.lock'), 'another publisher', 'utf8');
  assert.throws(() => publish(store, 'two'), /正在更新/);
  assert.deepEqual(store.list(), before);
  assert.equal(fs.existsSync(path.join(dir, 'two.md')), false);
  assert.equal(fs.readFileSync(path.join(dir, '.write.lock'), 'utf8'), 'another publisher');
});

test('body limits use the same UTF-16 character budget as the renderer, in addition to the byte limit', (t) => {
  const { dir, store } = fixture(t);
  publish(store, 'ascii-limit', { markdown: 'a'.repeat(ANNOUNCEMENT_MAX_BODY_CHARS) });
  publish(store, 'emoji-limit', { markdown: '😀'.repeat(ANNOUNCEMENT_MAX_BODY_CHARS / 2) });
  assert.equal(store.read('ascii-limit').markdown.length, ANNOUNCEMENT_MAX_BODY_CHARS);
  assert.equal(createAnnouncementStore({ dir }).read('emoji-limit').markdown.length, ANNOUNCEMENT_MAX_BODY_CHARS);
  assert.throws(() => publish(store, 'too-many-ascii', { markdown: 'a'.repeat(ANNOUNCEMENT_MAX_BODY_CHARS + 1) }), /50000 字符/);
  assert.throws(() => publish(store, 'too-many-emoji', { markdown: '😀'.repeat(ANNOUNCEMENT_MAX_BODY_CHARS / 2 + 1) }), /50000 字符/);
  assert.throws(() => publish(store, 'too-many-bytes', { markdown: '中'.repeat(45000) }), /131072 字节/);
  assert.deepEqual(store.list().items.map((item) => item.id), ['emoji-limit', 'ascii-limit']);
  const oversized = Buffer.from('a'.repeat(ANNOUNCEMENT_MAX_BODY_CHARS + 1), 'utf8');
  const catalog = catalogOf(dir);
  const entry = catalog.items.find((item) => item.id === 'ascii-limit');
  entry.bytes = oversized.length; entry.sha256 = createHash('sha256').update(oversized).digest('hex');
  fs.writeFileSync(path.join(dir, 'ascii-limit.md'), oversized); putCatalog(dir, catalog);
  const warnings = [];
  const reader = createAnnouncementStore({ dir, log: { warn: (line) => warnings.push(line) } });
  assert.equal(reader.read('ascii-limit'), null, 'a hand-edited body cannot bypass the shared character limit');
  assert.match(warnings[0], /50000 字符/);
});

test('the publisher never writes an expanded year that a restarted reader would reject', (t) => {
  const { dir, store } = fixture(t);
  assert.throws(() => publish(store, 'far-future', { publishedAt: '+010000-01-01T00:00:00.000Z' }), /0000–9999/);
  assert.equal(fs.existsSync(dir), false);
  const edge = publish(store, 'last-year', { publishedAt: '9999-12-31T23:59:59.999Z' });
  assert.deepEqual(createAnnouncementStore({ dir }).list().items, [edge]);
});

test('an index rename failure retains the old catalog and leaves no half-written index or lock', (t) => {
  const { dir, store } = fixture(t);
  publish(store, 'one');
  const before = store.list();
  const rename = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (to === path.join(dir, ANNOUNCEMENT_INDEX_FILE)) throw new Error('simulated disk failure');
    return rename(from, to);
  };
  try { assert.throws(() => publish(store, 'two'), /simulated disk failure/); }
  finally { fs.renameSync = rename; }
  assert.deepEqual(createAnnouncementStore({ dir }).list(), before);
  assert.equal(store.read('two'), null, 'an unlisted body is never exposed');
  assert.equal(fs.readdirSync(dir).some((name) => name.startsWith('.tmp-') || name === '.write.lock'), false);
});

test('symlinked body/index files are rejected when this platform allows creating symlinks', (t) => {
  const { root, dir, store } = fixture(t);
  publish(store, 'one');
  const before = store.list();
  const privateFile = path.join(root, 'private.md');
  fs.writeFileSync(privateFile, '# secret\n', 'utf8');
  const link = path.join(root, 'link.md');
  try { fs.symlinkSync(privateFile, link); }
  catch (e) {
    if (e.code === 'EPERM' || e.code === 'EACCES' || e.code === 'ENOSYS') { t.skip('当前 Windows 会话没有创建文件符号链接权限'); return; }
    throw e;
  }
  fs.unlinkSync(path.join(dir, 'one.md'));
  fs.symlinkSync(privateFile, path.join(dir, 'one.md'));
  assert.equal(store.read('one'), null);
  assert.throws(() => store.pin('one'), /正文缺失/);
  const indexCopy = path.join(root, 'private-index.json');
  fs.copyFileSync(path.join(dir, ANNOUNCEMENT_INDEX_FILE), indexCopy);
  fs.unlinkSync(path.join(dir, ANNOUNCEMENT_INDEX_FILE));
  fs.symlinkSync(indexCopy, path.join(dir, ANNOUNCEMENT_INDEX_FILE));
  assert.deepEqual(store.list(), before);
  assert.throws(() => publish(store, 'two'), /不能使用符号链接/);
});

test('publishing input is an explicit bounded UTF-8 Markdown file, not malformed bytes or another file type', (t) => {
  const { root } = fixture(t);
  const file = path.join(root, '正文.md');
  fs.writeFileSync(file, '\uFEFF# 发布公告\r\n你好。\r\n', 'utf8');
  assert.equal(readAnnouncementMarkdown(file), '# 发布公告\n你好。\n');
  const other = path.join(root, 'body.txt');
  fs.copyFileSync(file, other);
  assert.throws(() => readAnnouncementMarkdown(other), /\.md/);
  fs.writeFileSync(file, Buffer.from([0xff, 0xfe, 0x41]));
  assert.throws(() => readAnnouncementMarkdown(file), /encoded data|encoding/i);
  fs.writeFileSync(file, Buffer.alloc(ANNOUNCEMENT_MAX_BODY_BYTES + 1, 0x61));
  assert.throws(() => readAnnouncementMarkdown(file), /字节限制/);
});

test('public index validation rejects malformed dates/metadata and strips private checksum fields', (t) => {
  const { dir, store } = fixture(t);
  publish(store, 'one');
  const raw = catalogOf(dir);
  assert.deepEqual(readAnnouncementIndex(raw), store.list());
  assert.equal(readAnnouncementIndex({ ...raw, pinnedId: 'missing' }), null);
  assert.equal(readAnnouncementIndex({ ...raw, items: [{ ...raw.items[0], publishedAt: '2026-02-31T00:00:00.000Z' }] }), null);
  assert.equal(readAnnouncementIndex({ ...raw, items: [{ ...raw.items[0], title: ' ' }] }), null);
  assert.equal(shouldShowAnnouncements(store.list(), raw.revision), false);
  assert.equal(shouldShowAnnouncements(store.list(), 'yesterday'), true);
});

test('deleting older, newest, pinned and last announcements preserves publication revision across restarts', (t) => {
  const { dir, store } = fixture(t);
  publish(store, 'oldest'); publish(store, 'pinned', { pin: true }); publish(store, 'newest');
  const revision = store.list().revision;
  const reader = createAnnouncementStore({ dir });
  reader.read('oldest'); reader.read('pinned'); reader.read('newest');
  for (const [id, remaining, pinnedId] of [
    ['oldest', ['newest', 'pinned'], 'pinned'],
    ['newest', ['pinned'], 'pinned'],
    ['pinned', [], null],
  ]) {
    assert.equal(store.remove(id).id, id);
    const index = reader.list();
    assert.deepEqual(index.items.map((item) => item.id), remaining);
    assert.equal(index.pinnedId, pinnedId);
    assert.equal(index.revision, revision, 'deletion is not a new publication or an old publication replay');
    assert.equal(shouldShowAnnouncements(index, revision), false);
    assert.equal(reader.read(id), null, 'verified cached bodies cannot restore a deleted entry');
    assert.equal(fs.existsSync(path.join(dir, `${id}.md`)), false);
    assert.deepEqual(createAnnouncementStore({ dir }).list(), index);
    assert.equal(fs.existsSync(path.join(dir, '.write.lock')), false);
  }
  assert.equal(defaultAnnouncementId(store.list()), null);
  const next = publish(store, 'after-deletion');
  assert.notEqual(next.revision, revision);
  assert.equal(shouldShowAnnouncements(store.list(), revision), true);
});

test('deleting a pinned item clears only its pin and leaves other cached bodies, shared assets and drafts intact', (t) => {
  const { root, dir, store } = fixture(t);
  publish(store, 'pinned', { pin: true }); publish(store, 'other');
  store.read('pinned'); const other = store.read('other');
  const assets = path.join(dir, 'assets');
  fs.mkdirSync(assets);
  const image = path.join(assets, 'shared.png');
  const draft = path.join(root, 'publisher-draft.md');
  fs.writeFileSync(image, Buffer.from([1, 2, 3]));
  fs.writeFileSync(draft, '# Original draft\n', 'utf8');
  store.remove('pinned');
  assert.equal(store.list().pinnedId, null);
  assert.equal(store.read('pinned'), null);
  assert.deepEqual(store.read('other'), other);
  assert.deepEqual(fs.readFileSync(image), Buffer.from([1, 2, 3]));
  assert.equal(fs.readFileSync(draft, 'utf8'), '# Original draft\n');
});

test('deletion rejects unsafe, missing and locked targets without changing the catalog or bodies', (t) => {
  const { dir, store } = fixture(t);
  publish(store, 'one');
  const before = fs.readFileSync(path.join(dir, ANNOUNCEMENT_INDEX_FILE), 'utf8');
  for (const id of ['../private', '/private', 'one.md', 'one/../private', '%2e%2e', 'CON', 'con', 'lpt1', '']) {
    assert.throws(() => store.remove(id), /ID 无效/);
  }
  assert.throws(() => store.remove('missing'), /找不到公告/);
  fs.writeFileSync(path.join(dir, '.write.lock'), 'another writer', 'utf8');
  assert.throws(() => store.remove('one'), /正在更新/);
  assert.equal(fs.readFileSync(path.join(dir, ANNOUNCEMENT_INDEX_FILE), 'utf8'), before);
  assert.equal(fs.readFileSync(path.join(dir, '.write.lock'), 'utf8'), 'another writer');
  assert.ok(store.read('one'));
});

test('a deletion index rename failure leaves the catalog and body intact and releases its lock', (t) => {
  const { dir, store } = fixture(t);
  publish(store, 'one', { pin: true });
  const before = store.list();
  const body = fs.readFileSync(path.join(dir, 'one.md'));
  const rename = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (to === path.join(dir, ANNOUNCEMENT_INDEX_FILE)) throw new Error('simulated delete index failure');
    return rename(from, to);
  };
  try { assert.throws(() => store.remove('one'), /simulated delete index failure/); }
  finally { fs.renameSync = rename; }
  assert.deepEqual(createAnnouncementStore({ dir }).list(), before);
  assert.deepEqual(fs.readFileSync(path.join(dir, 'one.md')), body);
  assert.equal(fs.readdirSync(dir).some((name) => name.startsWith('.tmp-') || name === '.write.lock'), false);
});

test('body cleanup failure is reported after a successful deletion without restoring the catalog entry', (t) => {
  const { dir, store, warnings } = fixture(t);
  const item = publish(store, 'one', { pin: true });
  store.read('one');
  const bodyFile = path.join(dir, 'one.md');
  const unlink = fs.unlinkSync;
  fs.unlinkSync = (file) => {
    if (file === bodyFile) throw Object.assign(new Error('simulated cleanup denied'), { code: 'EACCES' });
    return unlink(file);
  };
  try { assert.deepEqual(store.remove('one'), item); }
  finally { fs.unlinkSync = unlink; }
  const expected = { revision: item.revision, pinnedId: null, items: [] };
  assert.deepEqual(store.list(), expected);
  assert.deepEqual(createAnnouncementStore({ dir }).list(), expected);
  assert.equal(store.read('one'), null);
  assert.equal(fs.existsSync(bodyFile), true, 'the warning must not imply that filesystem cleanup succeeded');
  assert.equal(fs.existsSync(path.join(dir, '.write.lock')), false);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /已从索引删除.*one\.md 未能清理.*simulated cleanup denied/);
});

test('deletion strictly validates existing data before rewriting any catalog', (t) => {
  const { dir, store } = fixture(t);
  publish(store, 'one'); publish(store, 'two');
  const catalogFile = path.join(dir, ANNOUNCEMENT_INDEX_FILE);
  const original = fs.readFileSync(catalogFile, 'utf8');
  fs.writeFileSync(catalogFile, '{ invalid catalog', 'utf8');
  assert.throws(() => store.remove('one'), /未作修改/);
  assert.equal(fs.readFileSync(catalogFile, 'utf8'), '{ invalid catalog');
  assert.equal(fs.existsSync(path.join(dir, 'one.md')), true);
  fs.writeFileSync(catalogFile, original, 'utf8');
  fs.writeFileSync(path.join(dir, 'two.md'), '# Corrupt remaining body\n', 'utf8');
  assert.throws(() => store.remove('one'), /未作修改/);
  assert.equal(fs.readFileSync(catalogFile, 'utf8'), original);
  assert.equal(fs.existsSync(path.join(dir, 'one.md')), true);
  assert.equal(fs.existsSync(path.join(dir, '.write.lock')), false);
});
