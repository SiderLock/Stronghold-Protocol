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
const flush = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate) {
  for (let i = 0; i < 500; i++) { if (await predicate()) return; await flush(); }
  assert.ok(await predicate(), 'worker reached the expected transfer phase');
}

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

function worker({ keysThrow = false, fetcher } = {}) {
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
    fetch: async (...args) => { network++; if (fetcher) return fetcher(...args); throw new Error('Import must remain offline'); }, Blob, TextDecoder, TextEncoder,
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
  return { run, messages, network: () => network, pause: () => self.onmessage({ data: { type: 'pause' } }),
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

test('a stalled request ignoring abort times out; retries follow healthy files in the same Worker', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = await fixture(t), catalog = await f.files({ '/assets/a.png': 'a', '/assets/b.png': 'bb', '/assets/c.png': 'ccc' });
  const calls = [];
  const w = worker({ fetcher: (url) => {
    const target = new URL(url, origin).searchParams.get('url'); calls.push(target);
    if (calls.length === 1) return new Promise(() => {});
    const body = Buffer.from(target.includes('a.png') ? 'a' : target.includes('b.png') ? 'bb' : 'ccc');
    return new Response(body, { headers: { 'content-length': String(body.length) } });
  } });
  const running = w.run({ action: 'download', catalog, maxParallel: 1 });
  await until(() => calls.length === 1);
  t.mock.timers.tick(60000);
  const result = await running;
  assert.deepEqual(calls, ['/assets/a.png', '/assets/b.png', '/assets/c.png', '/assets/a.png']);
  assert.equal(result.progress.readyFiles, 3);
  for (const entry of catalog.files) assert.equal(hash(await w.cachedBody(entry)), entry.sha256);
});

test('a stuck body and stuck cancellation never block healthy files or a retry without reloading', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = await fixture(t), catalog = await f.files({ '/assets/a.png': 'aa', '/assets/b.png': 'bbb' });
  const calls = []; let repaired = false;
  const w = worker({ fetcher: (url) => {
    const target = new URL(url, origin).searchParams.get('url'); calls.push(target);
    if (target.includes('a.png') && !repaired) return new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array([97])); }, cancel: () => new Promise(() => {}),
    }), { headers: { 'content-length': '2' } });
    const body = target.includes('a.png') ? 'aa' : 'bbb';
    return new Response(body, { headers: { 'content-length': String(body.length) } });
  } });
  const rejected = assert.rejects(w.run({ action: 'download', catalog, maxParallel: 1 }), /ASSET_CACHE_DOWNLOAD_FAILED/);
  for (let attempt = 1; attempt <= 3; attempt++) {
    await until(() => calls.filter(x => x.includes('a.png')).length === attempt);
    await flush(); await flush(); t.mock.timers.tick(60000);
  }
  await rejected;
  assert.equal(await w.cachedBody(catalog.files[1]), 'bbb', 'healthy bytes remain usable after a partial operation');
  assert.equal(w.messages.filter(x => x.type === 'progress').at(-1).readyFiles, 1, 'the failed operation still publishes completed files');
  repaired = true;
  const again = await w.run({ action: 'download', catalog, maxParallel: 1 });
  assert.equal(again.progress.readyFiles, 2);
  assert.equal(calls.filter(x => x.includes('b.png')).length, 1, 'retry reuses the completed file');
  assert.equal(await w.cachedBody(catalog.files[0]), 'aa');
});

test('fatal errors cancel sibling IO and settle all lanes before the Worker accepts a fresh operation', async t => {
  const f = await fixture(t), catalog = await f.files({ '/assets/a.png': 'aa', '/assets/b.png': 'bbb' });
  const signals = []; let failed = true;
  const w = worker({ fetcher: (url, opts) => {
    signals.push(opts.signal);
    const target = new URL(url, origin).searchParams.get('url');
    if (failed) return target.includes('a.png') ? new Response('', { status: 409 }) : new Promise(() => {});
    const body = target.includes('a.png') ? 'aa' : 'bbb';
    return new Response(body, { headers: { 'content-length': String(body.length) } });
  } });
  await assert.rejects(w.run({ action: 'download', catalog, maxParallel: 2 }), /ASSET_CACHE_STALE_CATALOG/);
  assert.equal(signals.length, 2);
  assert.ok(signals.every(signal => signal.aborted));
  failed = false;
  assert.equal((await w.run({ action: 'download', catalog })).progress.readyFiles, 2);
});

test('a reduced server lease still drains a later retry after another lane has already finished', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = await fixture(t), catalog = await f.files({ '/assets/a.png': 'aa', '/assets/b.png': 'bbb' });
  let tries = 0;
  const w = worker({ fetcher: url => {
    if (new URL(url, origin).searchParams.get('url').includes('b.png')) {
      if (++tries === 1) return new Response('', { status: 429, headers: { 'retry-after': '1' } });
      if (tries === 2) throw new TypeError('connection interrupted');
      return new Response('bbb', { headers: { 'content-length': '3' } });
    }
    return new Response('aa', { headers: { 'content-length': '2' } });
  } });
  const running = w.run({ action: 'download', catalog, maxParallel: 2 });
  await until(() => w.cachedBody(catalog.files[0]).then(body => body === 'aa', () => false));
  t.mock.timers.tick(1000);
  assert.equal((await running).progress.readyFiles, 2);
  assert.equal(tries, 3);
});
