// Small ZIP fixtures exercise the real import Worker with native zip.js and in-memory browser storage.
// This is a Worker integration check, not a real-browser or multiplayer load test.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import * as zip from '@zip.js/zip.js';
import * as helpers from '../shared/assetCache.js';
import { createAssetCacheCatalog } from '../server/assetCacheCatalog.js';
import { packAssetCache } from '../tools/asset-cache-pack.mjs';

const source = (await fs.readFile(new URL('../public/js/asset-cache-worker.js', import.meta.url), 'utf8'))
  .replace("const helpers = import('../../shared/assetCache.js');", 'const helpers = Promise.resolve(__helpers);');
const origin = 'https://cache.test';
const hash = (body) => createHash('sha256').update(body).digest('hex');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sp-asset-pack-worker-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'data'));
  await fs.writeFile(path.join(root, 'package.json'), '{"version":"fixture"}');
  const files = async (assets) => {
    for (const [url, body] of Object.entries(assets)) {
      const file = path.join(root, 'public', url);
      await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, body);
    }
    await fs.writeFile(path.join(root, 'data', 'assets.json'), JSON.stringify(Object.fromEntries(Object.keys(assets).map((url, i) => [String(i), url]))));
    return createAssetCacheCatalog({ publicDir: path.join(root, 'public'), dataDir: path.join(root, 'data') });
  };
  return { root, files };
}

function worker({ keysThrow = false } = {}) {
  const stores = new Map(); let network = 0, id = 0;
  const messages = [];
  const storage = { async open(name) {
    if (!stores.has(name)) stores.set(name, new Map());
    const entries = stores.get(name);
    const absolute = (value) => (typeof value === 'string' ? new URL(value, origin).href : value.url);
    return {
      async keys() {
        if (keysThrow) throw new DOMException("Failed to execute 'keys' on 'Cache': Operation too large.", 'AbortError');
        return [...entries.values()].map(({ request }) => request.clone());
      },
      async match(value) { return entries.get(absolute(value))?.response.clone(); },
      async put(value, response) { const request = typeof value === 'string' ? new Request(absolute(value)) : value.clone();
        entries.set(request.url, { request, response: response.clone() }); },
      async delete(value) { return entries.delete(absolute(value)); },
    };
  } };
  const self = { location: { origin }, postMessage(message) { messages.push(message); } };
  vm.runInContext(source, vm.createContext({ self, importScripts() {}, zip, __helpers: helpers, caches: storage,
    fetch: async () => { network++; throw new Error('Import must remain offline'); }, Blob, TextDecoder, TextEncoder,
    Uint8Array, Request, Response, AbortController, DOMException, performance, setTimeout, clearTimeout }));
  const run = async (input) => {
    const jobId = ++id;
    await self.onmessage({ data: { id: jobId, ...input } });
    const result = messages.filter((message) => message.id === jobId);
    const error = result.find((message) => message.type === 'error');
    if (error) throw new Error(error.code);
    return { done: result.find((message) => message.type === 'done'),
      progress: Object.assign({}, ...result.filter((message) => message.type === 'progress')) };
  };
  const blob = async (file) => new Blob([await fs.readFile(file)]);
  return { run, network: () => network,
    seedImported: async (paths) => {
      const cache = await storage.open(helpers.IMPORTED_ASSET_CACHE);
      await cache.put(helpers.IMPORTED_INDEX_URL, Response.json(paths));
    },
    scan: async (catalog, deep = false) => run({ action: 'scan', catalog, deep }),
    readCatalog: async (file) => (await run({ action: 'read-catalog', format: 'zip', file: await blob(file) })).done.catalog,
    importZIP: async (file, catalog) => run({ action: 'import', catalog, file: await blob(file) }),
    cachedBody: async (file) => (await (await storage.open(helpers.ASSET_CACHE_NAME)).match(origin + helpers.assetContentKey(file.sha256))).text(),
  };
}

test('generated delta bootstraps the current full directory on a cold Worker but does not claim unchanged assets', async (t) => {
  const f = await fixture(t);
  const base = await f.files({ '/assets/a.png': 'old asset', '/assets/keep.png': 'unchanged asset' });
  const current = await f.files({ '/assets/a.png': 'changed asset', '/assets/keep.png': 'unchanged asset', '/assets/new.png': 'new asset' });
  const delta = await packAssetCache({ root: f.root, catalog: current, delta: true, baseCatalog: base });
  const w = worker(); const directory = await w.readCatalog(delta.zipPath);
  assert.equal(directory.version, current.version); assert.equal(directory.complete, true);
  const result = await w.importZIP(delta.zipPath, directory);
  assert.equal(result.progress.readyFiles, 2); assert.equal(result.progress.missingFiles, 1);
  assert.equal(result.progress.importStats.imported, 2); assert.equal(result.progress.importStats.absent, 1);
  assert.equal(w.network(), 0);
});

test('old full-cache plus new delta reuses unchanged SHA bytes, including renamed and duplicate files', async (t) => {
  const f = await fixture(t);
  const base = await f.files({ '/assets/a.png': 'old asset', '/assets/keep.png': 'unchanged asset' });
  const old = await packAssetCache({ root: f.root, catalog: base });
  const w = worker(); await w.importZIP(old.zipPath, await w.readCatalog(old.zipPath));
  const current = await f.files({ '/assets/a.png': 'changed asset', '/assets/renamed.png': 'unchanged asset',
    '/assets/new.png': 'new asset', '/assets/duplicate.png': 'new asset' });
  const delta = await packAssetCache({ root: f.root, catalog: current, delta: true, baseCatalog: base });
  const directory = await w.readCatalog(delta.zipPath);
  const imported = await w.importZIP(delta.zipPath, directory);
  assert.equal(delta.packedFiles, 2); assert.equal(imported.progress.readyFiles, 4);
  assert.equal(imported.progress.missingFiles, 0); assert.equal(imported.progress.importStats.imported, 2);
  const repeated = await w.importZIP(delta.zipPath, directory);
  assert.equal(repeated.progress.importStats.imported, 0); assert.equal(repeated.progress.importStats.reused, 2);
  for (const entry of directory.files) assert.equal(hash(await w.cachedBody(entry)), entry.sha256);
  assert.equal(w.network(), 0);
});

test('manifest-only removal / alias update preserves ready cache contents and stays offline', async (t) => {
  const f = await fixture(t);
  const base = await f.files({ '/assets/a.png': 'old asset', '/assets/remove.png': 'obsolete asset' });
  const old = await packAssetCache({ root: f.root, catalog: base });
  const w = worker(); await w.importZIP(old.zipPath, await w.readCatalog(old.zipPath));
  const current = await f.files({ '/assets/a.png': 'old asset' });
  current.files[0].aliases.push('/assets/alias.png');
  current.version = hash(JSON.stringify({ schema: current.schema, files: current.files }));
  const delta = await packAssetCache({ root: f.root, catalog: current, delta: true, baseCatalog: base });
  const directory = await w.readCatalog(delta.zipPath);
  const result = await w.importZIP(delta.zipPath, directory);
  assert.equal(delta.packedFiles, 0); assert.ok(directory.files[0].aliases.includes('/assets/alias.png'));
  assert.equal(result.progress.readyFiles, 1); assert.equal(result.progress.missingFiles, 0);
  assert.equal(result.progress.importStats.imported, 0); assert.equal(w.network(), 0);
});

test('pre-hash schema-1 ZIP updates to exact hash aliases through a directory-only delta without downloading art', async (t) => {
  const f = await fixture(t);
  const current = await f.files({ '/assets/model.skel': 'unchanged model', '/assets/local/scene/test/scene.bin': 'scene binary' });
  const previous = structuredClone(current);
  for (const entry of previous.files) entry.aliases = [];
  previous.version = hash(JSON.stringify({ schema: previous.schema, files: previous.files }));
  const old = await packAssetCache({ root: f.root, catalog: previous });
  const w = worker(); await w.importZIP(old.zipPath, await w.readCatalog(old.zipPath));
  const delta = await packAssetCache({ root: f.root, catalog: current, delta: true, baseCatalog: previous });
  assert.equal(delta.packedFiles, 0);
  const directory = await w.readCatalog(delta.zipPath);
  const imported = await w.importZIP(delta.zipPath, directory);
  assert.equal(directory.schema, 1); assert.equal(directory.version, current.version);
  assert.ok(directory.files.every((entry) => entry.aliases.some((alias) => alias.includes('/~'))));
  assert.equal(imported.progress.readyFiles, 2); assert.equal(imported.progress.missingFiles, 0);
  assert.equal(imported.progress.importStats.imported, 0); assert.equal(w.network(), 0);
  for (const entry of directory.files) assert.equal(hash(await w.cachedBody(entry)), entry.sha256);
});

test('a title-imported file counts as ready through the shared index without being downloaded again', async (t) => {
  const f = await fixture(t);
  const catalog = await f.files({ '/assets/title.png': 'imported by the title screen' });
  const w = worker();
  const entry = catalog.files[0];
  const hashed = `/assets/~${entry.sha256.slice(0, 16)}/title.png`;
  entry.aliases = [hashed];
  catalog.version = hash(JSON.stringify({ schema: 1, files: catalog.files }));
  await w.seedImported([hashed]);
  const result = await w.scan(catalog);
  assert.equal(result.progress.readyFiles, 1);
  assert.equal(result.progress.missingFiles, 0);
  assert.equal(w.network(), 0);
  const again = await w.run({ action: 'download', catalog });
  assert.equal(again.progress.readyFiles, 1);
  assert.equal(w.network(), 0, 'the imported copy is reused instead of downloaded');
});

test('a full pre-cache never calls Cache.keys(), whose query limit a 0.3.1 pack exceeds', async (t) => {
  const f = await fixture(t);
  const catalog = await f.files({ '/assets/a.png': 'a', '/assets/b.png': 'b' });
  const pack = await packAssetCache({ root: f.root, catalog });
  const w = worker({ keysThrow: true });
  const directory = await w.readCatalog(pack.zipPath);
  // Import would have thrown an AbortError from the first cache.keys() before this fix.
  const imported = await w.importZIP(pack.zipPath, directory);
  assert.equal(imported.progress.readyFiles, 2);
  assert.equal(imported.progress.importStats.imported, 2);
  const scanned = await w.scan(directory);
  assert.equal(scanned.progress.readyFiles, 2);
  assert.equal(scanned.progress.missingFiles, 0);
});

test('a duplicate content entry stays missing until its own URL is ready, not just its SHA', async (t) => {
  const f = await fixture(t);
  const catalog = await f.files({ '/assets/a.png': 'same bytes', '/assets/b.png': 'same bytes' });
  const [a, b] = catalog.files;
  assert.equal(a.sha256, b.sha256);
  a.aliases = [`/assets/~${a.sha256.slice(0, 16)}/a.png`];
  b.aliases = [`/assets/~${b.sha256.slice(0, 16)}/b.png`];
  catalog.version = hash(JSON.stringify({ schema: 1, files: catalog.files }));
  const w = worker();
  await w.seedImported([a.aliases[0]]);
  const scanned = await w.scan(catalog);
  assert.equal(scanned.progress.readyFiles, 1);
  assert.equal(scanned.progress.missingFiles, 1, 'b.png shares bytes but its URL is not imported');
});
