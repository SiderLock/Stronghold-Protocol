import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createAssetCacheCatalog, assetCacheURLProblem } from '../server/assetCacheCatalog.js';
import { validateAssetCatalog, catalogURLMap } from '../shared/assetCache.js';
import { hashedPath } from '../shared/assetPaths.js';
import { rewriteManifest } from '../server/http/assetViews.js';
import { createAssetIndex } from '../server/http/assetIndex.js';
import { AUDIO_EXTS } from '../shared/media.js';

async function fixture(t, assets = {}, local, extra = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sp-asset-catalog-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const publicDir = path.join(root, 'public');
  const dataDir = path.join(root, 'data');
  await fs.mkdir(publicDir); await fs.mkdir(dataDir);
  await fs.writeFile(path.join(dataDir, 'assets.json'), JSON.stringify(assets));
  if (local) await fs.writeFile(path.join(dataDir, 'local-assets.json'), JSON.stringify(local));
  // the two sidecares the installation may add: its own outfits and the official battle effects
  for (const [name, doc] of Object.entries(extra)) {
    if (doc) await fs.writeFile(path.join(dataDir, name), JSON.stringify(doc));
  }
  const put = async (url, content) => {
    const target = path.join(publicDir, url.slice(1));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
  };
  return { root, publicDir, dataDir, put };
}

test('catalog hashes deployed bytes, deduplicates references and keeps stable order', async (t) => {
  const f = await fixture(t, { a: '/assets/icon.png', copies: ['/assets/icon.png'], fonts: { css: '/fonts/fonts.css' } });
  await f.put('/assets/icon.png', 'picture'); await f.put('/fonts/fonts.css', 'font style');
  await f.put('/assets/orphan.png', 'not referenced');
  const first = await createAssetCacheCatalog({ ...f, app: '0.2.2', concurrency: 2 });
  assert.equal(first.complete, true); assert.equal(first.totalFiles, 2); assert.equal(first.totalBytes, 17);
  assert.deepEqual(first.files.map((x) => x.url), ['/assets/icon.png', '/fonts/fonts.css']);
  assert.equal(first.files[0].sha256, createHash('sha256').update('picture').digest('hex'));
  const second = await createAssetCacheCatalog({ ...f, app: 'new code version' });
  assert.equal(second.version, first.version, 'app code version does not invalidate unchanged assets');
  await f.put('/assets/icon.png', 'changed');
  const changed = await createAssetCacheCatalog(f);
  assert.notEqual(changed.version, first.version, 'same path/length with changed bytes updates asset version');
});

test('missing and invalid declarations are reported without exposing absolute filesystem paths', async (t) => {
  const f = await fixture(t, { ok: '/assets/ok.png', missing: '/assets/missing.png', zero: '/assets/zero.png', bad: '/assets/../private.json', code: '/assets/malware.js', personal: '/api/announcement-assets/p.png' });
  await f.put('/assets/ok.png', 'ok'); await f.put('/assets/zero.png', '');
  const catalog = await createAssetCacheCatalog(f);
  assert.equal(catalog.complete, false); assert.equal(catalog.totalFiles, 1);
  assert.equal(catalog.missing.length, 4);
  assert.ok(!JSON.stringify(catalog).includes(f.root));
  assert.ok(!JSON.stringify(catalog).includes('/api/announcement-assets'));
});

test('media aliases match extension-less and explicit-extension priority/fallback', async (t) => {
  const f = await fixture(t, { audio: ['/assets/audio/bgm/track.ogg', '/assets/audio/bgm/track.mp3'] });
  await f.put('/assets/audio/bgm/track.ogg', 'ogg'); await f.put('/assets/audio/bgm/track.mp3', 'mp3');
  const catalog = await createAssetCacheCatalog(f);
  const mp3 = catalog.files.find((x) => x.url.endsWith('.mp3'));
  const ogg = catalog.files.find((x) => x.url.endsWith('.ogg'));
  assert.ok(mp3.aliases.includes('/media/bgm/track'));
  assert.ok(mp3.aliases.includes('/media/bgm/track.wav'), 'missing explicit extension falls back to mp3');
  assert.ok(ogg.aliases.includes('/media/bgm/track.ogg'));
  assert.ok(!ogg.aliases.includes('/media/bgm/track'));
  assert.equal(new Set(catalog.files.flatMap((x) => x.aliases).filter((url) => url.startsWith('/media/') && !url.includes('/~'))).size, 8);
});

test('schema-1 catalog retains plain paths and aliases content-hashed art, fonts and scene binary by actual bytes', async (t) => {
  const local = { groups: { 'scene/act2autochess_m01': { scene: { path: '/assets/local/scene/act2autochess_m01/scene.json' },
    bin: { path: '/assets/local/scene/act2autochess_m01/scene.bin' } } } };
  const f = await fixture(t, { icon: '/assets/icon.webp', font: '/fonts/main.woff2' }, local);
  for (const [url, content] of [['/assets/icon.webp', 'image'], ['/fonts/main.woff2', 'font'],
    ['/assets/local/scene/act2autochess_m01/scene.json', '{"version":1}'],
    ['/assets/local/scene/act2autochess_m01/scene.bin', Buffer.from([0, 1, 2, 3])]]) await f.put(url, content);
  const catalog = await createAssetCacheCatalog(f);
  assert.equal(catalog.schema, 1); assert.equal(catalog.complete, true); assert.deepEqual(catalog.missing, []);
  assert.doesNotThrow(() => validateAssetCatalog(catalog));
  const map = catalogURLMap(catalog);
  for (const entry of catalog.files) {
    assert.ok(!entry.url.includes('/~'), 'ZIP names and plain file requests retain their existing canonical paths');
    assert.equal(map.get(hashedPath(entry.url, entry.sha256.slice(0, 16))), entry);
    assert.equal(map.get(hashedPath(entry.url, '0'.repeat(16))), undefined, 'unrelated content hashes are never normalized away');
  }
  assert.equal(catalog.files.find((entry) => entry.url.endsWith('.bin')).type, 'application/octet-stream');
});

test('Spine aliases use the same model membership and ordered hashes as the served standard and local manifests', async (t) => {
  const standard = { chars: { hero: { front: { skel: '/assets/hero/model.skel', atlas: '/assets/hero/model.atlas',
    textures: ['/assets/hero/page.png'] } } } };
  const local = { groups: { 'spine/token/token_test': {
    'z.skel': { path: '/assets/local/spine/token/token_test/model.skel' },
    'a.atlas': { path: '/assets/local/spine/token/token_test/model.atlas' },
    'm.png': { path: '/assets/local/spine/token/token_test/page.png' },
  } } };
  const f = await fixture(t, standard, local);
  for (const prefix of ['/assets/hero', '/assets/local/spine/token/token_test']) {
    await f.put(`${prefix}/model.skel`, prefix + ' skeleton');
    await f.put(`${prefix}/model.atlas`, '\npage.png\nsize: 2,2\n');
    await f.put(`${prefix}/page.png`, prefix + ' picture');
  }
  const catalog = await createAssetCacheCatalog(f);
  assert.equal(catalog.complete, true); assert.doesNotThrow(() => validateAssetCatalog(catalog));
  const map = catalogURLMap(catalog);
  const hashes = createAssetIndex({ publicDir: f.publicDir, cacheFile: null });
  t.after(() => hashes.close());
  await hashes.refresh();
  for (const [name, manifest] of [['assets.json', standard], ['local-assets.json', local]]) {
    const served = rewriteManifest(manifest, name, hashes);
    for (const rels of served.models) {
      const hash = hashes.modelHash(rels);
      for (const rel of rels) {
        assert.equal(map.get(hashedPath(`/${rel}`, hash)), map.get(`/${rel}`));
        assert.equal(map.get(hashedPath(`/${rel}`, '0'.repeat(16))), undefined);
      }
    }
    assert.ok(JSON.stringify(served.doc).includes('/~'), name);
  }
  const changed = { ...standard, chars: { hero: { front: { ...standard.chars.hero.front, textures: ['/assets/hero/missing.png'] } } } };
  await fs.writeFile(path.join(f.dataDir, 'assets.json'), JSON.stringify(changed));
  const incomplete = await createAssetCacheCatalog(f);
  const known = incomplete.files.find((entry) => entry.url === '/assets/hero/model.skel');
  assert.equal(incomplete.complete, false);
  assert.equal(known.aliases.length, 1, 'a model with a missing member only keeps its file hash alias');
});

test('hashed media routes retain explicit-extension priority and only alias the bytes the resolver selects', async (t) => {
  const f = await fixture(t, { audio: ['/assets/audio/bgm/track.ogg', '/assets/audio/bgm/track.mp3'] });
  await f.put('/assets/audio/bgm/track.ogg', 'ogg'); await f.put('/assets/audio/bgm/track.mp3', 'mp3');
  const catalog = await createAssetCacheCatalog(f);
  const map = catalogURLMap(catalog);
  const mp3 = map.get('/assets/audio/bgm/track.mp3');
  const ogg = map.get('/assets/audio/bgm/track.ogg');
  assert.doesNotThrow(() => validateAssetCatalog(catalog));
  for (const ext of ['', ...AUDIO_EXTS]) {
    const entry = ext === '.ogg' ? ogg : mp3;
    assert.equal(map.get(hashedPath('/media/bgm/track' + ext, entry.sha256.slice(0, 16))), entry);
  }
  assert.equal(map.get(hashedPath('/media/bgm/track', ogg.sha256.slice(0, 16))), undefined,
    'the ogg file hash must not make an extension-less mp3 response look like cached ogg bytes');
});

test('an audio stem with only one installed format accepts all seventeen exact file and media aliases', async (t) => {
  const f = await fixture(t, { audio: '/assets/audio/track.mp3' }); await f.put('/assets/audio/track.mp3', 'mp3');
  const catalog = await createAssetCacheCatalog(f);
  assert.equal(catalog.files[0].aliases.length, 17);
  assert.doesNotThrow(() => validateAssetCatalog(catalog));
});

test('local token models and atlas-only texture dependencies enter the complete package', async (t) => {
  const prefix = '/assets/local/spine/token/token_mon3tr';
  const local = { groups: { 'spine/token/token_mon3tr': {
    skel: { path: `${prefix}/token.skel` }, atlas: { path: `${prefix}/token.atlas` },
  } } };
  const f = await fixture(t, {}, local);
  await f.put(`${prefix}/token.skel`, 'skeleton');
  await f.put(`${prefix}/token.atlas`, '\ntoken.png\nsize: 512,512\nformat: RGBA8888\nfilter: Linear,Linear\n\nsecond.png\nsize: 2,2\n');
  await f.put(`${prefix}/token.png`, 'page1'); await f.put(`${prefix}/second.png`, 'page2');
  const catalog = await createAssetCacheCatalog(f);
  assert.equal(catalog.complete, true); assert.equal(catalog.totalFiles, 4);
  await fs.unlink(path.join(f.publicDir, prefix.slice(1), 'second.png'));
  const missing = await createAssetCacheCatalog(f);
  assert.equal(missing.complete, false);
  assert.deepEqual(missing.missing, [{ url: `${prefix}/second.png`, reason: 'missing file' }]);
});

test('a missing texture referenced by a standard runtime Spine model remains blocking', async (t) => {
  const f = await fixture(t, { chars: { a: { spine: { skel: '/assets/op/a.skel', atlas: '/assets/op/a.atlas', textures: [] } } } });
  await f.put('/assets/op/a.skel', 'skeleton'); await f.put('/assets/op/a.atlas', '\nmissing.png\nsize: 2,2\n');
  const catalog = await createAssetCacheCatalog(f);
  assert.equal(catalog.complete, false);
  assert.deepEqual(catalog.missing, [{ url: '/assets/op/missing.png', reason: 'missing file' }]);
});

test('unused extracted UI atlas dependencies warn without blocking a complete runtime asset pack', async (t) => {
  const prefix = '/assets/local/ui/battle';
  const f = await fixture(t, { a: '/assets/icon.png' }, { groups: { 'ui/battle': {
    atlas: { path: `${prefix}/unused.atlas`, kind: 'TextAsset' }, skel: { path: `${prefix}/unused.skel`, kind: 'TextAsset' },
  } } });
  await f.put('/assets/icon.png', 'picture'); await f.put(`${prefix}/unused.skel`, 'unused skeleton');
  await f.put(`${prefix}/unused.atlas`, '\nunused.png\nsize: 2,2\n');
  const catalog = await createAssetCacheCatalog(f);
  assert.equal(catalog.complete, true); assert.equal(catalog.totalFiles, 3);
  assert.deepEqual(catalog.missing, []);
  assert.deepEqual(catalog.warnings, [{ url: `${prefix}/unused.png`, reason: 'unused atlas dependency: missing file' }]);
  assert.ok(catalog.files.some((file) => file.url.endsWith('/unused.atlas')));
});

test('media cache includes an installed resolver alternative omitted by the declared manifest', async (t) => {
  const f = await fixture(t, { audio: '/assets/audio/bgm/track.ogg' });
  await f.put('/assets/audio/bgm/track.ogg', 'ogg'); await f.put('/assets/audio/bgm/track.mp3', 'mp3');
  const catalog = await createAssetCacheCatalog(f);
  assert.equal(catalog.totalFiles, 2);
  assert.ok(catalog.files.find((x) => x.url.endsWith('.mp3')).aliases.includes('/media/bgm/track'));
  assert.ok(!catalog.files.find((x) => x.url.endsWith('.ogg')).aliases.includes('/media/bgm/track'));
});

test('missing declared audio does not hide a safe installed media resolver fallback', async (t) => {
  const f = await fixture(t, { audio: '/assets/audio/bgm/track.ogg' });
  await f.put('/assets/audio/bgm/track.mp3', 'mp3 fallback');
  const catalog = await createAssetCacheCatalog(f);
  assert.equal(catalog.complete, false, 'a declared missing resource is still reported');
  assert.deepEqual(catalog.missing, [{ url: '/assets/audio/bgm/track.ogg', reason: 'missing file' }]);
  assert.equal(catalog.totalFiles, 1);
  assert.equal(catalog.files[0].url, '/assets/audio/bgm/track.mp3');
  assert.ok(catalog.files[0].aliases.includes('/media/bgm/track'));
  assert.ok(catalog.files[0].aliases.includes('/media/bgm/track.ogg'), 'explicit missing ogg follows server fallback to mp3');
  assert.equal(catalog.files[0].type, 'audio/mpeg');
  assert.equal(catalog.files[0].sha256, createHash('sha256').update('mp3 fallback').digest('hex'));
});

test('empty higher-priority media files cannot silently alias a different playable file', async (t) => {
  const f = await fixture(t, { audio: '/assets/audio/bgm/track.ogg' });
  await f.put('/assets/audio/bgm/track.ogg', 'ogg'); await f.put('/assets/audio/bgm/track.mp3', '');
  const catalog = await createAssetCacheCatalog(f);
  assert.equal(catalog.complete, false);
  assert.ok(!catalog.files[0].aliases.includes('/media/bgm/track'));
  assert.ok(catalog.files[0].aliases.includes('/media/bgm/track.ogg'));
});

test('board tiles table follows runtime WebP remapping without adding unused original PNG', async (t) => {
  const prefix = '/assets/local/map/autochess';
  const f = await fixture(t, {}, { groups: { 'map/autochess': { TX_autochessi_D: { path: `${prefix}/TX_autochessi_D.webp` } } } });
  await f.put(`${prefix}/TX_autochessi_D.webp`, 'webp');
  await f.put(`${prefix}/TX_autochessi_D.png`, 'old png');
  await f.put(`${prefix}/tiles.json`, JSON.stringify({ source: { D: { path: `${prefix}/TX_autochessi_D.png` } } }));
  const catalog = await createAssetCacheCatalog(f);
  assert.equal(catalog.complete, true);
  assert.deepEqual(catalog.files.map((x) => x.url), [`${prefix}/TX_autochessi_D.webp`, `${prefix}/tiles.json`]);
});

test('links to private or other public files never enter catalog', async (t) => {
  const f = await fixture(t, { a: '/assets/link.png' });
  const target = path.join(f.root, 'private.png');
  await fs.writeFile(target, 'secret'); await fs.mkdir(path.join(f.publicDir, 'assets'));
  try { await fs.symlink(target, path.join(f.publicDir, 'assets', 'link.png')); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) { t.skip('OS does not permit creating test symlinks'); return; } throw error; }
  const catalog = await createAssetCacheCatalog(f);
  assert.equal(catalog.files.length, 0); assert.equal(catalog.complete, false);
  assert.equal(catalog.missing[0].reason, 'symbolic link refused');
});

test('missing required manifest and malformed optional manifest are never called complete', async (t) => {
  const f = await fixture(t, { a: '/assets/a.png' });
  await f.put('/assets/a.png', 'art'); await fs.unlink(path.join(f.dataDir, 'assets.json'));
  const missing = await createAssetCacheCatalog(f);
  assert.equal(missing.complete, false); assert.equal(missing.missing[0].url, '/data/assets.json');
  await fs.writeFile(path.join(f.dataDir, 'assets.json'), '{"a":"/assets/a.png"}');
  await fs.writeFile(path.join(f.dataDir, 'local-assets.json'), '{');
  const malformed = await createAssetCacheCatalog(f);
  assert.equal(malformed.complete, false); assert.equal(malformed.missing[0].url, '/data/local-assets.json');
});

test('path validation rejects executable, alternate stream, traversal and encoded paths', () => {
  for (const url of ['/assets/a.js', '/assets/../a.png', '/assets/.hidden.png', '/assets/a.png:secret', '/assets/%2e%2e/a.png', '/assets/a.png?x=1', '/assets/a\\b.png', '/fonts/private.json']) {
    assert.ok(assetCacheURLProblem(url), url);
  }
  assert.equal(assetCacheURLProblem('/assets/local/map/fx/[opt]merged_textures.png'), null);
});

test('catalog matches browser validation and canonical URL map for aliases', async (t) => {
  const f = await fixture(t, { audio: ['/assets/audio/a.ogg', '/assets/audio/a.mp3'], image: '/assets/icon.webp' });
  await f.put('/assets/audio/a.ogg', 'ogg'); await f.put('/assets/audio/a.mp3', 'mp3'); await f.put('/assets/icon.webp', 'webp');
  const catalog = await createAssetCacheCatalog(f);
  assert.doesNotThrow(() => validateAssetCatalog(catalog));
  const map = catalogURLMap(catalog);
  assert.equal(map.get('/media/a'), map.get('/assets/audio/a.mp3'));
  assert.equal(map.get('/assets/audio/a.ogg'), map.get('/media/a.ogg'));
});

test('the catalog includes the installation outfits and the official effects (a pre-cache that skips them means the first outfit in a match downloads)', async (t) => {
  const model = (base) => ({ skel: `/assets/${base}.skel`, atlas: `/assets/${base}.atlas`, textures: [`/assets/${base}.png`],
    pma: true, anims: { idle: 'Idle' }, animations: { Idle: 1 }, events: [], hits: {}, bounds: { width: 1, height: 1 } });
  const f = await fixture(t, { chars: { char_a: { avatar: '/assets/a.png' } } }, null, {
    // an outfit as the extractor writes it (tools/local-extract/skins.py)
    'local-skins.json': { version: 1, skins: { 'char_a@x#1': { charId: 'char_a', name: 'X',
      avatar: '/assets/local/skins/char_a/x/avatar.png', portrait: '/assets/local/skins/char_a/x/portrait.png',
      spine: { front: { ...model('local/skins/char_a/x/front/model') } } } } },
    // one effect prefab as data/local-fx.json lists it
    'local-fx.json': { groups: { 'fx/prefabs': { k: { path: '/assets/local/fx/prefabs/k.json', kind: 'FxPrefab' } } } },
  });
  await f.put('/assets/a.png', 'a');
  await f.put('/assets/local/skins/char_a/x/avatar.png', 'avatar');
  await f.put('/assets/local/skins/char_a/x/portrait.png', 'portrait');
  for (const name of ['model.skel', 'model.atlas', 'model.png']) await f.put(`/assets/local/skins/char_a/x/front/${name}`, name);
  await f.put('/assets/local/fx/prefabs/k.json', '{"k":1}');

  const catalog = await createAssetCacheCatalog({ ...f, concurrency: 2 });
  assert.equal(catalog.complete, true);
  const urls = catalogURLMap(catalog);
  // the outfit's pictures and model are in the catalog …
  assert.ok(urls.has('/assets/local/skins/char_a/x/avatar.png'));
  assert.ok(urls.has('/assets/local/skins/char_a/x/portrait.png'));
  assert.ok(urls.has('/assets/local/skins/char_a/x/front/model.skel'));
  // … and its model answers the SAME url the served manifest hands out (the model hash, not a file hash)
  const { doc } = rewriteManifest({ chars: { char_a: { skins: { 'char_a@x#1': { avatar: '/assets/local/skins/char_a/x/avatar.png',
    spine: { front: model('local/skins/char_a/x/front/model') } } } } } }, 'assets.json',
  { hashOf: (rel) => catalog.files.find((x) => x.url === `/${rel}`)?.sha256.slice(0, 16) || null,
    modelHash(rels) { const parts = rels.map((r) => this.hashOf(r)); return parts.every(Boolean) ? createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 16) : null; } });
  assert.ok(urls.has(doc.chars.char_a.skins['char_a@x#1'].spine.front.skel), 'the served model URL is a cache hit');
  // the effect prefab too
  assert.ok(urls.has('/assets/local/fx/prefabs/k.json'));
});
