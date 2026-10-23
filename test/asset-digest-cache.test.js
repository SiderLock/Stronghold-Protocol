import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createAssetCacheCatalog, hashAssetFile } from '../server/assetCacheCatalog.js';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sp-digest-cache-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const publicDir = path.join(root, 'public'), dataDir = path.join(root, 'data');
  await fs.mkdir(path.join(publicDir, 'assets'), { recursive: true });
  await fs.mkdir(dataDir);
  const manifest = path.join(dataDir, 'assets.json'), image = path.join(publicDir, 'assets', 'a.png');
  await fs.writeFile(manifest, JSON.stringify({ a: '/assets/a.png', b: '/assets/b.png' }));
  await fs.writeFile(image, 'first');
  await fs.writeFile(path.join(publicDir, 'assets', 'b.png'), 'second');
  const hashCacheFile = path.join(root, 'private', 'digests.json');
  let stats;
  const options = { publicDir, dataDir, hashCacheFile, onHashStats: s => { stats = s; } };
  return { root, image, manifest, hashCacheFile, options, run: () => createAssetCacheCatalog(options), stats: () => stats };
}

test('a fresh catalog process reuses full hashes and preserves every catalog byte', async t => {
  const f = await fixture(t);
  const cold = await f.run();
  assert.deepEqual(f.stats(), { reused: 0, hashed: 2, readBytes: 11 });
  assert.deepEqual(await f.run(), cold);
  assert.deepEqual(f.stats(), { reused: 2, hashed: 0, readBytes: 0 });
  assert.deepEqual(await createAssetCacheCatalog({ ...f.options, hashCacheFile: null }), cold, 'uncached integrity scan agrees');
});

test('same-size edits with restored mtime, atomic replacements, and manifest changes invalidate only affected entries', async t => {
  const f = await fixture(t);
  const first = await f.run();
  const old = await fs.stat(f.image);
  await fs.writeFile(f.image, 'other');
  await fs.utimes(f.image, old.atime, old.mtime);
  const edit = await f.run();
  assert.notEqual(edit.version, first.version);
  assert.equal(edit.files[0].sha256, createHash('sha256').update('other').digest('hex'));
  assert.deepEqual(f.stats(), { reused: 1, hashed: 1, readBytes: 5 });
  await fs.writeFile(f.image + '.tmp', 'third');
  await fs.utimes(f.image + '.tmp', old.atime, old.mtime);
  await fs.rename(f.image + '.tmp', f.image);
  assert.notEqual((await f.run()).version, edit.version);
  assert.equal(f.stats().hashed, 1);
  await fs.writeFile(f.manifest, JSON.stringify({ a: '/assets/a.png', absent: '/assets/new.png' }));
  const missing = await f.run();
  assert.equal(missing.complete, false);
  assert.equal(missing.totalFiles, 1);
  assert.equal(missing.missing[0].url, '/assets/new.png');
  assert.deepEqual(Object.keys(JSON.parse(await fs.readFile(f.hashCacheFile)).entries), ['/assets/a.png'], 'removed manifest entries are pruned');
});

test('deleted and symlinked files cannot be revived by the persistent hash cache', async t => {
  const f = await fixture(t);
  await f.run();
  await fs.unlink(f.image);
  const gone = await f.run();
  assert.equal(gone.complete, false);
  assert.equal(gone.missing[0].reason, 'missing file');
  try { await fs.symlink(path.join(f.options.publicDir, 'assets', 'b.png'), f.image); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) { t.diagnostic('symlink creation unavailable; deletion path verified'); return; } throw error; }
  assert.equal((await f.run()).missing[0].reason, 'symbolic link refused');
});

test('malformed, foreign-root and invalid digest caches fall back; unwritable cache does not block content', async t => {
  const f = await fixture(t);
  const first = await f.run();
  const valid = JSON.parse(await fs.readFile(f.hashCacheFile));
  for (const body of ['{bad', JSON.stringify({ ...valid, schema: 2 }), JSON.stringify({ ...valid, root: '/other' }),
    JSON.stringify({ ...valid, entries: { '/assets/a.png': { ...valid.entries['/assets/a.png'], sha256: 'invalid' } } })]) {
    await fs.writeFile(f.hashCacheFile, body);
    assert.deepEqual(await f.run(), first);
    assert.equal(f.stats().hashed, 2);
  }
  await fs.rm(path.dirname(f.hashCacheFile), { recursive: true });
  await fs.writeFile(path.dirname(f.hashCacheFile), 'not a directory');
  assert.deepEqual(await f.run(), first);
});

test('a file replaced after path validation cannot be saved under its old identity', async t => {
  const f = await fixture(t);
  const before = await fs.lstat(f.image, { bigint: true });
  await fs.writeFile(f.image, 'later');
  await assert.rejects(hashAssetFile(f.image, before), /file changed during catalog build/);
});
