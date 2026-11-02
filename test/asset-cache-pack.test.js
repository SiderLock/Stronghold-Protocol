import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createAssetCacheCatalog } from '../server/assetCacheCatalog.js';
import { packAssetCache, exportAssetCacheCatalog, assetCachePackManifest, parseAssetCachePackArgs, planAssetCachePack, main } from '../tools/asset-cache-pack.mjs';
import { verifyAssetCatalog } from '../shared/assetCache.js';
import { readZip } from '../tools/package-update.mjs';
import { writeAssetZip, updateCRC32 } from '../tools/asset-cache/zip.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sp-asset-pack-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'data'));
  await fs.mkdir(path.join(root, 'public', 'assets'), { recursive: true });
  await fs.writeFile(path.join(root, 'public', 'assets', '头像.png'), 'art data');
  await fs.writeFile(path.join(root, 'public', 'assets', 'unlisted.png'), 'do not ship');
  await fs.writeFile(path.join(root, 'data', 'assets.json'), JSON.stringify({ a: '/assets/头像.png' }));
  await fs.writeFile(path.join(root, 'package.json'), '{"version":"0.2.2"}');
  return root;
}

test('full ZIP contains only manifest and selected art, with UTF-8 and verified byte contents', async (t) => {
  const root = await fixture(t);
  const r = await packAssetCache({ root });
  assert.equal(r.totalFiles, 1); assert.equal(r.totalBytes, 8);
  const entries = new Map();
  readZip(r.zipPath, (name, bytes) => entries.set(name, bytes));
  assert.deepEqual([...entries.keys()], ['manifest.json', 'assets/头像.png']);
  const manifest = JSON.parse(entries.get('manifest.json').toString());
  assert.equal(manifest.schema, 1); assert.equal(manifest.version, r.version);
  assert.equal(manifest.files[0].sha256, createHash('sha256').update(entries.get('assets/头像.png')).digest('hex'));
  assert.equal(entries.get('assets/头像.png').toString(), 'art data');
  assert.ok(!(await fs.readdir(path.dirname(r.zipPath))).some((x) => x.endsWith('.part')));
  await assert.rejects(packAssetCache({ root }), /已存在/);
});

test('incomplete catalog refuses full-pack creation and leaves no misleading package', async (t) => {
  const root = await fixture(t);
  await fs.unlink(path.join(root, 'public', 'assets', '头像.png'));
  await assert.rejects(packAssetCache({ root }), /不完整.*拒绝/s);
  assert.equal(await fs.access(path.join(root, '.cache')).then(() => true, () => false), false);
  assert.throws(() => assetCachePackManifest({ complete: true, files: [] }), /不完整/);
});

test('catalog-to-pack mutation is caught by a second hash and removes only its partial output', async (t) => {
  const root = await fixture(t);
  const catalog = await createAssetCacheCatalog({ publicDir: path.join(root, 'public'), dataDir: path.join(root, 'data') });
  await fs.writeFile(path.join(root, 'public', 'assets', '头像.png'), 'changed!');
  await assert.rejects(packAssetCache({ root, catalog }), /内容变化/);
  assert.deepEqual(await fs.readdir(path.join(root, '.cache', 'asset-cache-pack')), []);
});

test('a stale partial file belonging to another process is not overwritten or removed', async (t) => {
  const root = await fixture(t);
  const catalog = await createAssetCacheCatalog({ publicDir: path.join(root, 'public'), dataDir: path.join(root, 'data') });
  const out = path.join(root, '.cache', 'asset-cache-pack');
  await fs.mkdir(out, { recursive: true });
  const name = `Stronghold-Protocol-assets-${catalog.version.slice(0, 12)}.zip.part`;
  await fs.writeFile(path.join(out, name), 'other process');
  await assert.rejects(packAssetCache({ root, catalog }), /EEXIST/);
  assert.equal(await fs.readFile(path.join(out, name), 'utf8'), 'other process');
});

test('ZIP writer rejects unsafe/duplicate paths and writes interoperable CRC-32', async (t) => {
  const root = await fixture(t);
  assert.equal((updateCRC32(0xffffffff, Buffer.from('123456789')) ^ 0xffffffff) >>> 0, 0xcbf43926);
  for (const name of ['../x', '/x', 'assets/../x', 'assets\\x', 'assets/a:stream']) {
    const handle = await fs.open(path.join(root, 'bad.zip'), 'w');
    try { await assert.rejects(writeAssetZip(handle, [{ name, data: Buffer.from('x') }]), /不安全/); }
    finally { await handle.close(); }
  }
  const handle = await fs.open(path.join(root, 'bad.zip'), 'w');
  try { await assert.rejects(writeAssetZip(handle, [{ name: 'a', data: Buffer.from('x') }, { name: 'a', data: Buffer.from('y') }]), /重复/); }
  finally { await handle.close(); }
});

test('pack CLI supports safe explicit roots/output and rejects accidental switches', () => {
  assert.equal(parseAssetCachePackArgs(['--dry-run']).dryRun, true);
  assert.equal(parseAssetCachePackArgs(['--help']).help, true);
  assert.equal(parseAssetCachePackArgs(['--catalog-only']).catalogOnly, true);
  assert.throws(() => parseAssetCachePackArgs(['--out', '--dry-run']), /需要目录/);
  assert.throws(() => parseAssetCachePackArgs(['--upload']), /未知参数/);
});

test('standalone JSON export matches the existing ZIP directory and never overwrites either file', async (t) => {
  const root = await fixture(t);
  const packed = await packAssetCache({ root });
  const exported = await exportAssetCacheCatalog({ root });
  let packedManifest;
  readZip(packed.zipPath, (name, bytes) => { if (name === 'manifest.json') packedManifest = JSON.parse(bytes); });
  const body = await fs.readFile(exported.catalogPath);
  assert.deepEqual(JSON.parse(body), packedManifest);
  assert.equal((await verifyAssetCatalog(JSON.parse(body))).version, packed.version);
  assert.equal(body.length, exported.catalogBytes);
  await assert.rejects(exportAssetCacheCatalog({ root }), /EEXIST/);
  assert.equal((await fs.readFile(exported.catalogPath)).equals(body), true);
  assert.ok(!(await fs.readdir(path.dirname(exported.catalogPath))).some((name) => name.endsWith('.part')));
});

const catalogFor = (root) => createAssetCacheCatalog({ publicDir: path.join(root, 'public'), dataDir: path.join(root, 'data') });
const zipEntries = (zipPath) => {
  const entries = new Map(); readZip(zipPath, (name, bytes) => entries.set(name, bytes)); return entries;
};
async function addAssets(root, assets) {
  for (const [url, body] of Object.entries(assets)) {
    const file = path.join(root, 'public', url);
    await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, body);
  }
  await fs.writeFile(path.join(root, 'data', 'assets.json'), JSON.stringify(Object.fromEntries(Object.keys(assets).map((url, i) => [String(i), url]))));
}

test('incremental ZIP embeds the exact latest full manifest and packs only new unique content', async (t) => {
  const root = await fixture(t);
  await addAssets(root, { '/assets/头像.png': 'art data', '/assets/keep.png': 'same content' });
  const base = await catalogFor(root);
  const baseJSON = (await exportAssetCacheCatalog({ root, catalog: base })).catalogPath;
  await addAssets(root, { '/assets/头像.png': 'new data', '/assets/renamed.png': 'same content',
    '/assets/new.png': 'new content', '/assets/duplicate.png': 'new content' });
  const current = await catalogFor(root);
  const progress = [];
  const delta = await packAssetCache({ root, catalog: current, delta: true, baseCatalog: baseJSON, onProgress: (entry) => progress.push(entry) });
  const full = await packAssetCache({ root, catalog: current });
  const exported = await exportAssetCacheCatalog({ root, catalog: current });
  const entries = zipEntries(delta.zipPath);
  assert.match(delta.zipPath, new RegExp(`delta-${base.version.slice(0, 12)}-to-${current.version.slice(0, 12)}\\.zip$`));
  assert.deepEqual(JSON.parse(entries.get('manifest.json')), JSON.parse(zipEntries(full.zipPath).get('manifest.json')));
  assert.deepEqual(JSON.parse(entries.get('manifest.json')), JSON.parse(await fs.readFile(exported.catalogPath)));
  assert.equal((await verifyAssetCatalog(JSON.parse(entries.get('manifest.json')))).version, current.version);
  assert.equal(delta.totalFiles, 4); assert.equal(delta.packedFiles, 2);
  assert.equal(delta.packedBytes, Buffer.byteLength('new data') + Buffer.byteLength('new content'));
  assert.equal(delta.baseVersion, base.version); assert.equal(delta.delta, true);
  assert.equal(entries.size, 3); assert.equal(entries.has('assets/renamed.png'), false);
  assert.deepEqual(progress.map(({ done, total }) => [done, total]), [[1, 2], [2, 2]]);
  for (const [name, body] of entries) {
    if (name === 'manifest.json') continue;
    const file = current.files.find((item) => item.url === '/' + name);
    assert.equal(body.length, file.bytes); assert.equal(createHash('sha256').update(body).digest('hex'), file.sha256);
  }
  const bytes = await fs.readFile(delta.zipPath);
  await assert.rejects(packAssetCache({ root, catalog: current, delta: true, baseCatalog: base }), /已存在/);
  assert.deepEqual(await fs.readFile(delta.zipPath), bytes);
  assert.equal((await fs.readdir(path.dirname(delta.zipPath))).some((name) => name.endsWith('.part')), false);
});

test('deletion and alias-only updates still export the current complete directory in a manifest-only delta', async (t) => {
  const root = await fixture(t);
  await addAssets(root, { '/assets/头像.png': 'art data', '/assets/remove.png': 'removed' });
  const base = await catalogFor(root);
  await addAssets(root, { '/assets/头像.png': 'art data' });
  const removed = await catalogFor(root);
  const result = await packAssetCache({ root, catalog: removed, delta: true, baseCatalog: base });
  assert.deepEqual([...zipEntries(result.zipPath).keys()], ['manifest.json']);
  assert.equal(result.packedFiles, 0); assert.equal(result.packedBytes, 0);
  const aliased = structuredClone(removed); aliased.files[0].aliases.push('/assets/another.png');
  aliased.version = createHash('sha256').update(JSON.stringify({ schema: 1, files: aliased.files })).digest('hex');
  const aliasDelta = await packAssetCache({ root, catalog: aliased, delta: true, baseCatalog: removed });
  assert.deepEqual([...zipEntries(aliasDelta.zipPath).keys()], ['manifest.json']);
  assert.deepEqual(JSON.parse(zipEntries(aliasDelta.zipPath).get('manifest.json')), assetCachePackManifest(aliased));
});

test('delta refuses absent, same-version, tampered, incomplete and oversized baseline directories before publishing', async (t) => {
  const root = await fixture(t); const current = await catalogFor(root);
  await assert.rejects(packAssetCache({ root, catalog: current, delta: true }), /需要 --base-catalog/);
  await assert.rejects(packAssetCache({ root, catalog: current, delta: true, baseCatalog: current }), /版本相同/);
  await assert.rejects(packAssetCache({ root, catalog: current, baseCatalog: current }), /只能与 --delta/);
  const broken = structuredClone(current); broken.files[0].sha256 = 'a'.repeat(64);
  await assert.rejects(planAssetCachePack({ catalog: current, delta: true, baseCatalog: broken }), /ASSET_CACHE_BAD_CATALOG/);
  const incomplete = { ...current, complete: false, missing: [{ url: '/assets/missing.png' }] };
  await assert.rejects(planAssetCachePack({ catalog: current, delta: true, baseCatalog: incomplete }), /基线目录不完整/);
  const invalidPath = path.join(root, 'base.json'); await fs.writeFile(invalidPath, '{oops');
  await assert.rejects(packAssetCache({ root, catalog: current, delta: true, baseCatalog: invalidPath }), /JSON/);
  const huge = await fs.open(invalidPath, 'w'); await huge.truncate(32 * 1024 * 1024 + 1); await huge.close();
  await assert.rejects(packAssetCache({ root, catalog: current, delta: true, baseCatalog: invalidPath }), /大小合法/);
  assert.equal(await fs.access(path.join(root, '.cache')).then(() => true, () => false), false);
});

test('delta catches file mutation while preserving another invocation partial output', async (t) => {
  const root = await fixture(t); const base = await catalogFor(root);
  await addAssets(root, { '/assets/头像.png': 'art data', '/assets/new.png': 'new bytes' });
  const current = await catalogFor(root);
  await fs.writeFile(path.join(root, 'public', 'assets', 'new.png'), 'bad bytes');
  await assert.rejects(packAssetCache({ root, catalog: current, delta: true, baseCatalog: base }), /内容变化/);
  const out = path.join(root, '.cache', 'asset-cache-pack');
  assert.deepEqual(await fs.readdir(out), []);
  const stale = path.join(out, `Stronghold-Protocol-assets-delta-${base.version.slice(0, 12)}-to-${current.version.slice(0, 12)}.zip.part`);
  await fs.writeFile(stale, 'other invocation');
  await assert.rejects(packAssetCache({ root, catalog: current, delta: true, baseCatalog: base }), /EEXIST/);
  assert.equal(await fs.readFile(stale, 'utf8'), 'other invocation');
});

test('delta CLI validates mode combinations, supports dry-run and publishes a self-describing current package', async (t) => {
  assert.equal(parseAssetCachePackArgs(['--delta', '--base-catalog', 'old.json']).delta, true);
  assert.equal(parseAssetCachePackArgs(['--delta', '--base-catalog', 'old.json']).baseCatalog, path.resolve('old.json'));
  assert.throws(() => parseAssetCachePackArgs(['--delta']), /需要 --base-catalog/);
  assert.throws(() => parseAssetCachePackArgs(['--base-catalog', 'old.json']), /只能与 --delta/);
  assert.throws(() => parseAssetCachePackArgs(['--delta', '--base-catalog', 'old.json', '--catalog-only']), /不能同时使用/);
  assert.throws(() => parseAssetCachePackArgs(['--base-catalog', '--delta']), /JSON 文件/);
  const root = await fixture(t); const base = await catalogFor(root);
  const baseFile = path.join(root, 'base.json'); await fs.writeFile(baseFile, JSON.stringify(base));
  await addAssets(root, { '/assets/头像.png': 'art data', '/assets/new.png': 'new bytes' });
  assert.equal(await main(['--root', root, '--delta', '--base-catalog', baseFile, '--dry-run']), 0);
  assert.equal(await fs.access(path.join(root, '.cache')).then(() => true, () => false), false);
  const out = path.join(root, 'published');
  assert.equal(await main(['--root', root, '--delta', '--base-catalog', baseFile, '--out', out]), 0);
  const current = await catalogFor(root);
  const [name] = await fs.readdir(out);
  assert.match(name, /^Stronghold-Protocol-assets-delta-/);
  const entries = zipEntries(path.join(out, name));
  assert.deepEqual([...entries.keys()], ['manifest.json', 'assets/new.png']);
  assert.deepEqual(JSON.parse(entries.get('manifest.json')), assetCachePackManifest(current));
});
