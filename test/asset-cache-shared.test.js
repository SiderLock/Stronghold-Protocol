import test from 'node:test';
import assert from 'node:assert/strict';
import { safeAssetPath, safeAssetZipName, decodedAssetPath, parseAssetRange, validateAssetCatalog,
  assetContentKey, isVerifiedAssetResponse, validatedCacheHeaders, sha256Hex } from '../shared/assetCache.js';
import { verifyAssetCatalog, assetCacheSummary, catalogMatchesSummary, assetCacheReadinessMatches } from '../shared/assetCache.js';
import { MAX_ASSET_ALIASES } from '../shared/assetCache.js';
import { createAssetCacheManager } from '../public/js/assetCache.js';

const entry = { url: '/assets/audio/中 文.mp3', bytes: 3,
  sha256: 'a'.repeat(64), type: 'audio/mpeg', aliases: ['/media/中 文'] };
const fixture = () => ({ schema: 1, version: 'b'.repeat(64), files: [{ ...entry, aliases: [...entry.aliases] }],
  totalFiles: 1, totalBytes: 3, complete: true, missing: [] });

test('catalog accepts decoded Unicode art and media aliases, rejects path/private/code collisions', () => {
  assert.equal(validateAssetCatalog(fixture()).totalFiles, 1);
  for (const value of ['/data/x.json', '/js/x.js', '/api/announcement-assets/x.png', '/assets/../x.png',
    '/assets/%2e.png', '/assets/x.png?q=1', '/assets/a\\b.png', 'https://cdn.test/x.png', '/assets/x.js']) {
    assert.equal(safeAssetPath(value), false, value);
  }
  for (const field of ['bytes', 'sha256', 'type', 'aliases']) {
    const bad = fixture(); bad.files[0][field] = null;
    assert.throws(() => validateAssetCatalog(bad), /BAD_CATALOG/);
  }
  const collision = fixture(); collision.files.push({ ...entry }); collision.totalFiles++;
  assert.throws(() => validateAssetCatalog(collision), /BAD_CATALOG/);
  const wrongTotal = fixture(); wrongTotal.totalBytes++;
  assert.throws(() => validateAssetCatalog(wrongTotal), /BAD_CATALOG/);
});

test('request normalization keeps same-origin aliases/query variants, rejects encoded separators and APIs', () => {
  const origin = 'https://game.test';
  assert.equal(decodedAssetPath('/assets/audio/%E4%B8%AD%20%E6%96%87.mp3?v=one', origin), entry.url);
  assert.equal(decodedAssetPath('/media/%E4%B8%AD%20%E6%96%87?x=1', origin), entry.aliases[0]);
  assert.equal(decodedAssetPath('/assets/~0123456789abcdef/scene/test/scene.bin?v=one', origin),
    '/assets/~0123456789abcdef/scene/test/scene.bin', 'the hash remains part of the pinned catalog lookup');
  for (const url of ['https://other.test/assets/x.png', '/assets/a%2fb.png', '/assets/%255c.png',
    '/api/asset-cache/file?url=/assets/x.png', '/assets/%zz.png']) assert.equal(decodedAssetPath(url, origin), null);
});

test('catalog accepts bounded hashed aliases and scene binaries without permitting executable or private resources', () => {
  const value = fixture();
  value.files[0].aliases = Array.from({ length: MAX_ASSET_ALIASES }, (_, i) => `/assets/alias-${i}.bin`);
  assert.doesNotThrow(() => validateAssetCatalog(value));
  value.files[0].aliases.push('/assets/too-many.bin');
  assert.throws(() => validateAssetCatalog(value), /BAD_CATALOG/);
  assert.equal(safeAssetPath('/assets/local/scene/test/scene.bin'), true);
  assert.equal(safeAssetPath('/fonts/scene.bin'), false);
  assert.equal(safeAssetPath('/runtime/scene.bin'), false);
  assert.equal(safeAssetPath('/assets/scene.js'), false);
});

test('ZIP names retain Unicode/directory entries and reject hidden, executable path tricks and traversal', () => {
  for (const name of ['manifest.json', 'assets/', 'assets/模型.atlas', 'fonts/main.woff2']) assert.equal(safeAssetZipName(name), true);
  for (const name of ['', '/assets/a.png', 'assets/../x.png', 'assets/./x.png', 'assets/.x.png',
    'assets/a\\b.png', 'assets/x.png:stream', 'assets/x.png ', 'assets/x.png.', 'assets/a\u0000.png'])
    assert.equal(safeAssetZipName(name), false, name);
});

test('single byte range handling covers open/suffix/clamped and rejects invalid multipart requests', () => {
  assert.deepEqual(parseAssetRange('bytes=1-2', 5), { start: 1, end: 2 });
  assert.deepEqual(parseAssetRange('bytes=1-', 5), { start: 1, end: 4 });
  assert.deepEqual(parseAssetRange('bytes=-2', 5), { start: 3, end: 4 });
  assert.deepEqual(parseAssetRange('bytes=-20', 5), { start: 0, end: 4 });
  assert.deepEqual(parseAssetRange('bytes=2-20', 5), { start: 2, end: 4 });
  for (const value of ['bytes=5-', 'bytes=2-1', 'bytes=-0', 'bytes=-', 'bytes=0-1,3-4', 'bytes=9007199254740992-']) {
    assert.equal(parseAssetRange(value, 5), null, value);
  }
});

test('verified content keys/response markers cannot mistake partial or mismatched data for full cache', async () => {
  assert.equal(assetContentKey(entry.sha256), '/__sp_asset_cache__/sha256/' + entry.sha256);
  assert.throws(() => assetContentKey('not a hash'), /BAD_HASH/);
  assert.equal(isVerifiedAssetResponse(new Response('abc', { headers: validatedCacheHeaders(entry) }), entry), true);
  assert.equal(isVerifiedAssetResponse(new Response('abc', { status: 206, headers: validatedCacheHeaders(entry) }), entry), false);
  assert.equal(isVerifiedAssetResponse(new Response('abc'), entry), false);
  assert.equal(await sha256Hex(new TextEncoder().encode('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('manager imports under Node without DOM side effects; insecure contexts remain unsupported', async () => {
  const manager = createAssetCacheManager({ environment: {} });
  assert.equal(manager.getState().supported, false);
  assert.equal((await manager.initialize()).error, 'ASSET_CACHE_HTTPS_REQUIRED');
  await manager.setPlaying(true);
  assert.equal(manager.getState().playing, true);
  manager.destroy();
});

test('local directory digest preserves schema-1 ZIP versions and detects changed URLs, hashes and aliases', async () => {
  const value = fixture();
  value.version = await sha256Hex(new TextEncoder().encode(JSON.stringify({ schema: value.schema, files: value.files })));
  assert.equal((await verifyAssetCatalog(value)).version, value.version);
  const reordered = { ...value, files: value.files.map(({ aliases, type, sha256, bytes, url }) => ({ aliases, type, sha256, bytes, url })) };
  assert.equal((await verifyAssetCatalog(reordered)).version, value.version, 'JSON property order does not require repacking existing assets');
  for (const changes of [{ url: '/assets/audio/other.mp3' }, { sha256: 'c'.repeat(64) }, { aliases: ['/media/other'] }]) {
    await assert.rejects(verifyAssetCatalog({ ...value, files: [{ ...entry, ...changes }] }), /BAD_CATALOG/);
  }
});

test('readiness requires current complete server metadata plus exact local file and byte counts', () => {
  const summary = assetCacheSummary(fixture());
  const full = { schema: 1, version: summary.version, readyFiles: 1, readyBytes: 3 };
  assert.equal(catalogMatchesSummary(fixture(), summary), true);
  assert.equal(assetCacheReadinessMatches(full, summary), true);
  for (const report of [null, true, {}, { ...full, readyFiles: 0 }, { ...full, readyBytes: 2 },
    { ...full, version: 'c'.repeat(64) }, { ...full, ready: true }, { ...full, schema: 2 }]) {
    assert.equal(assetCacheReadinessMatches(report, summary), false);
  }
  assert.equal(assetCacheReadinessMatches(full, { ...summary, complete: false, missingFiles: 1 }), false);
  assert.equal(assetCacheReadinessMatches({ ...full, readyFiles: 0, readyBytes: 0 },
    { ...summary, totalFiles: 0, totalBytes: 0 }), false, 'empty server data cannot turn 0/0 into full readiness');
  assert.equal(assetCacheReadinessMatches({ ...full, readyBytes: 0 }, { ...summary, totalBytes: 0 }), false);
});
