import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import * as helpers from '../shared/assetCache.js';

const origin = 'https://game.test';
const body = new TextEncoder().encode('atlas bytes');
const sha256 = await helpers.sha256Hex(body);
const entry = { url: '/assets/model.atlas', bytes: body.length, sha256, type: 'text/plain', aliases: [] };
const catalog = { schema: 1, version: await helpers.sha256Hex(new TextEncoder().encode(JSON.stringify({ schema: 1, files: [entry] }))), files: [entry], totalFiles: 1, totalBytes: body.length,
  complete: true, missing: [], app: 'test' };
const source = (await fs.readFile(new URL('../public/asset-cache-sw.js', import.meta.url), 'utf8'))
  .replace(/import \{[\s\S]*?\} from '\/shared\/assetCache\.js';/, '');

async function fixture({ slowMetadata = false, blockPassive = false, networkReply = null } = {}) {
  const handlers = new Map(), stores = new Map(), windows = new Map();
  let network = 0, locks = 0, activations = 0;
  const storage = {
    async open(name) {
      if (!stores.has(name)) stores.set(name, new Map());
      const records = stores.get(name);
      return {
        async match(value) { return records.get(typeof value === 'string' ? value : value.url)?.response.clone(); },
        async put(value, response) {
          if (slowMetadata && name === helpers.ASSET_CACHE_META) await new Promise((resolve) => setTimeout(resolve, 2));
          const request = typeof value === 'string' ? new Request(value) : value.clone();
          records.set(request.url, { request, response: response.clone() });
        },
        async keys() { return [...records.values()].map((record) => record.request.clone()); },
        async delete(value) { return records.delete(typeof value === 'string' ? value : value.url); },
      };
    },
    async delete(name) { return stores.delete(name); },
  };
  const clients = { async matchAll() { return [...windows.values()]; }, async claim() {} };
  const self = { location: { origin }, clients, navigator: { locks: { async request(_name, _options, fn) {
    locks++; return fn(blockPassive ? null : {});
  } } }, async skipWaiting() { activations++; }, addEventListener(name, callback) { handlers.set(name, callback); } };
  const context = vm.createContext({ ...helpers, self, caches: storage, fetch: async () => {
    network++;
    if (networkReply) return networkReply();
    // Fetch returns decoded bytes, while Content-Length still describes the compressed wire body.
    return new Response(body, { headers: { 'Content-Type': 'text/plain', 'Content-Encoding': 'gzip', 'Content-Length': '7' } });
  }, Request, Response, Headers, URL, Uint8Array, crypto: globalThis.crypto, Date, Promise, Map, Set });
  vm.runInContext(source, context);
  const addClient = (id) => windows.set(id, { id, postMessage() {} });
  const message = (id, data) => new Promise((resolve, reject) => {
    handlers.get('message')({ source: windows.get(id), data, ports: [{ postMessage: resolve }],
      waitUntil(promise) { promise.catch(reject); } });
  });
  const fetchFile = async (id, url = entry.url, headers = {}) => {
    const waits = []; let result;
    handlers.get('fetch')({ clientId: id, request: new Request(origin + url, { headers }),
      respondWith(promise) { result = promise; }, waitUntil(promise) { waits.push(promise); } });
    const response = await result;
    await Promise.all(waits);
    return response;
  };
  return { addClient, removeClient: (id) => windows.delete(id), message, fetchFile, storage,
    network: () => network, locks: () => locks, activations: () => activations };
}

test('SW advertises its coordination protocol without activating automatically', async () => {
  const f = await fixture(); f.addClient('page');
  assert.equal(f.activations(), 0);
  const reply = await f.message('page', { type: 'ASSET_CACHE_CAPABILITIES' });
  assert.equal(reply.ok, true);
  assert.equal(reply.protocol, helpers.ASSET_CACHE_SW_PROTOCOL);
  assert.equal(reply.imported, true);
  assert.equal(f.activations(), 0, 'capability probing must not replace the active worker');
});

test('render-cache budget and in-flight clearing do not block gameplay or recreate cleared data', async () => {
  const f = await fixture(); f.addClient('page');
  await f.message('page', { type: 'ASSET_CACHE_RENDER_CONSENT', enabled: true });
  const cache = await f.storage.open(helpers.RENDER_CACHE_NAME), url = '/assets/~0123456789abcdef/page.png';
  await cache.put(origin + helpers.RENDER_CACHE_INDEX, Response.json({ bytes: helpers.RENDER_CACHE_LIMIT }));
  assert.equal(await (await f.fetchFile('page', url)).text(), 'atlas bytes', 'full optional cache never blocks the network response');
  assert.equal(await cache.match(origin + url), undefined);
  const streaming = await fixture({ networkReply: () => new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array([1, 2])); } })) });
  streaming.addClient('page');
  await streaming.message('page', { type: 'ASSET_CACHE_RENDER_CONSENT', enabled: true });
  const fetch = streaming.fetchFile('page', url);
  await new Promise((resolve) => setTimeout(resolve, 10));
  const cleared = await Promise.race([
    streaming.message('page', { type: 'ASSET_CACHE_RENDER_CONSENT', enabled: false, clear: true }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('clear waited for the stalled network body')), 500)),
  ]);
  assert.equal(cleared.ok, true);
  const response = await fetch;
  await response.body.cancel();
  assert.equal(await (await streaming.storage.open(helpers.RENDER_CACHE_NAME)).match(origin + url), undefined);
});

test('render cache requires per-page consent, survives the next page, respects versions and clears separately', async () => {
  const f = await fixture(); f.addClient('page'); f.addClient('next');
  const url = '/assets/~0123456789abcdef/model.atlas';
  await f.fetchFile('page', url);
  const cache = await f.storage.open(helpers.RENDER_CACHE_NAME);
  assert.equal(await cache.match(origin + url), undefined, 'default is no optional disk write');
  await f.message('page', { type: 'ASSET_CACHE_RENDER_CONSENT', enabled: true });
  await f.fetchFile('page', url);
  assert.ok(await cache.match(origin + url));
  const count = f.network();
  await f.message('next', { type: 'ASSET_CACHE_RENDER_CONSENT', enabled: true });
  assert.equal(await (await f.fetchFile('next', url)).text(), 'atlas bytes');
  assert.equal(f.network(), count, 'next page reuses disk without a network request');
  const partial = await f.fetchFile('next', url, { Range: 'bytes=0-4' });
  assert.equal(partial.status, 206);
  assert.equal(await partial.text(), 'atlas');
  await f.fetchFile('next', '/assets/~fedcba9876543210/model.atlas');
  assert.equal(f.network(), count + 1, 'another content version must not reuse the old file');
  const imported = await f.storage.open(helpers.IMPORTED_ASSET_CACHE);
  await imported.put(origin + url, new Response('imported'));
  assert.equal(await (await f.fetchFile('page', url)).text(), 'imported', 'explicit imported copy wins');
  await f.message('page', { type: 'ASSET_CACHE_RENDER_CONSENT', enabled: false, clear: true });
  assert.ok(await imported.match(origin + url), 'clear does not remove an imported pack');
  assert.equal(await (await f.storage.open(helpers.RENDER_CACHE_NAME)).match(origin + url), undefined);
});

test('render consent survives catalog pinning and its bytes never satisfy strict admission', async () => {
  const f = await fixture(); f.addClient('page');
  await f.message('page', { type: 'ASSET_CACHE_RENDER_CONSENT', enabled: true });
  await f.message('page', { type: 'ASSET_CACHE_PIN', catalog });
  const url = '/assets/~0123456789abcdef/body.skel';
  await f.fetchFile('page', url);
  assert.ok(await (await f.storage.open(helpers.RENDER_CACHE_NAME)).match(origin + url));
  assert.equal(await (await f.storage.open(helpers.ASSET_CACHE_NAME)).match(origin + helpers.assetContentKey(sha256)), undefined);
});

test('an explicit idle SW activation preserves catalogs, old page pins and cached contents', async () => {
  const f = await fixture(); f.addClient('old'); f.addClient('new');
  const changed = structuredClone(catalog);
  changed.files[0].aliases.push(`/assets/~${sha256.slice(0, 16)}/model.atlas`);
  changed.version = await helpers.sha256Hex(new TextEncoder().encode(JSON.stringify({ schema: 1, files: changed.files })));
  await f.message('old', { type: 'ASSET_CACHE_PIN', catalog });
  await f.message('new', { type: 'ASSET_CACHE_PIN', catalog: changed });
  const cache = await f.storage.open(helpers.ASSET_CACHE_NAME);
  await cache.put(origin + helpers.assetContentKey(sha256), new Response(body, { headers: helpers.validatedCacheHeaders(entry) }));
  const meta = await f.storage.open(helpers.ASSET_CACHE_META);
  const snapshot = async () => Promise.all((await meta.keys()).map(async (key) => [key.url, await (await meta.match(key)).text()]));
  const before = await snapshot();
  assert.equal(f.activations(), 0, 'pinning does not activate a waiting worker');
  assert.equal((await f.message('new', { type: 'ASSET_CACHE_ACTIVATE' })).ok, true);
  assert.equal(f.activations(), 1);
  assert.deepEqual(await snapshot(), before, 'activation must not rewrite or prune persisted pins and catalogs');
  assert.equal(await (await f.fetchFile('old')).text(), 'atlas bytes');
  assert.equal(await (await f.fetchFile('new', changed.files[0].aliases[0])).text(), 'atlas bytes');
  assert.equal(f.network(), 0, 'both page catalogs still reuse their verified contents');
});

test('any live playing page blocks SW activation, including pins changed by the active worker', async () => {
  const f = await fixture(); f.addClient('requester'); f.addClient('playing');
  const meta = await f.storage.open(helpers.ASSET_CACHE_META);
  const key = `${origin}/__sp_asset_cache__/pin/playing`;
  await meta.put(key, Response.json({ version: catalog.version, playing: true }));
  assert.equal((await f.message('requester', { type: 'ASSET_CACHE_ACTIVATE' })).error, 'ASSET_CACHE_PLAYING');
  assert.equal(f.activations(), 0);
  assert.equal((await (await meta.match(key)).json()).playing, true, 'refusal preserves the live page pin');
  // Emulate another (active) worker writing this shared metadata after the waiting worker's probe.
  await meta.put(key, Response.json({ version: catalog.version, playing: false }));
  assert.equal((await f.message('requester', { type: 'ASSET_CACHE_ACTIVATE' })).ok, true);
  assert.equal(f.activations(), 1, 'a cached playing=true pin must not permanently block a later idle retry');
  await meta.put(key, Response.json({ version: catalog.version, playing: true }));
  assert.equal((await f.message('requester', { type: 'ASSET_CACHE_ACTIVATE' })).error, 'ASSET_CACHE_PLAYING');
  assert.equal(f.activations(), 1, 'a cached playing=false pin must not admit a page that has since entered a match');
  f.removeClient('playing');
  assert.equal((await f.message('requester', { type: 'ASSET_CACHE_ACTIVATE' })).ok, true);
  assert.equal(f.activations(), 2, 'a closed page does not retain a live activation guard');
  assert.equal((await (await meta.match(key)).json()).playing, true, 'ignoring a closed page does not delete its metadata');
});

test('SW uses the ordinary network until this document pins its own catalog, even if old verified cache exists', async () => {
  const f = await fixture(); f.addClient('old'); f.addClient('new');
  await f.message('old', { type: 'ASSET_CACHE_PIN', catalog });
  const cache = await f.storage.open(helpers.ASSET_CACHE_NAME);
  await cache.put(origin + helpers.assetContentKey(sha256), new Response('old-cache!!', { headers: helpers.validatedCacheHeaders(entry) }));
  assert.equal(await (await f.fetchFile('new')).text(), 'atlas bytes');
  assert.equal(f.network(), 1, 'new document must not inherit the old page catalog');
  assert.equal(await (await f.fetchFile('old')).text(), 'old-cache!!');
  assert.equal(f.network(), 1);
});

test('SW passive caching verifies decoded gzip bytes and respects the shared mutation lock', async () => {
  const f = await fixture(); f.addClient('page');
  await f.message('page', { type: 'ASSET_CACHE_PIN', catalog });
  assert.equal(await (await f.fetchFile('page')).text(), 'atlas bytes');
  assert.equal(f.network(), 1); assert.equal(f.locks(), 1);
  assert.equal(await (await f.fetchFile('page')).text(), 'atlas bytes');
  assert.equal(f.network(), 1, 'gzip body was validated and cached locally');
  const blocked = await fixture({ blockPassive: true }); blocked.addClient('page');
  await blocked.message('page', { type: 'ASSET_CACHE_PIN', catalog });
  await blocked.fetchFile('page'); await blocked.fetchFile('page');
  assert.equal(blocked.network(), 2, 'clear/import/deep scan lock prevents competing passive writes');
});

test('SW serializes pin/playing writes and never lets a late same-version pin clear the live match flag', async () => {
  const f = await fixture({ slowMetadata: true }); f.addClient('page');
  const pinned = f.message('page', { type: 'ASSET_CACHE_PIN', catalog, playing: false });
  const entered = f.message('page', { type: 'ASSET_CACHE_PLAYING', playing: true });
  assert.equal((await pinned).ok, true); assert.equal((await entered).playing, true);
  assert.equal((await f.message('page', { type: 'ASSET_CACHE_PIN', catalog, playing: false })).ok, true);
  assert.equal((await f.message('page', { type: 'ASSET_CACHE_CAN_MUTATE' })).playing, true);
  assert.equal((await f.message('page', { type: 'ASSET_CACHE_CLEAR' })).error, 'ASSET_CACHE_PLAYING');
});

test('SW allows the first verified pin during direct reconnect, but refuses directory changes during a live match', async () => {
  const f = await fixture(); f.addClient('page');
  assert.equal((await f.message('page', { type: 'ASSET_CACHE_PLAYING', playing: true })).playing, true);
  assert.equal((await f.message('page', { type: 'ASSET_CACHE_PIN', catalog })).ok, true);
  const changed = structuredClone(catalog);
  changed.files[0].url = '/assets/other.atlas';
  changed.version = await helpers.sha256Hex(new TextEncoder().encode(JSON.stringify({ schema: 1, files: changed.files })));
  assert.equal((await f.message('page', { type: 'ASSET_CACHE_PIN', catalog: changed })).error, 'ASSET_CACHE_PLAYING');
  assert.equal((await f.message('page', { type: 'ASSET_CACHE_CAN_MUTATE' })).playing, true);
});

test('SW exact hash aliases reuse unchanged full-SHA contents after an explicit catalog update and respect old pins', async () => {
  const f = await fixture(); f.addClient('old'); f.addClient('updated');
  await f.message('old', { type: 'ASSET_CACHE_PIN', catalog });
  await f.message('updated', { type: 'ASSET_CACHE_PIN', catalog });
  const cache = await f.storage.open(helpers.ASSET_CACHE_NAME);
  await cache.put(origin + helpers.assetContentKey(sha256), new Response(body, { headers: helpers.validatedCacheHeaders(entry) }));
  const hashUrl = `/assets/~${sha256.slice(0, 16)}/model.atlas`;
  const changed = structuredClone(catalog);
  changed.files[0].aliases.push(hashUrl);
  changed.version = await helpers.sha256Hex(new TextEncoder().encode(JSON.stringify({ schema: 1, files: changed.files })));
  assert.equal((await f.message('updated', { type: 'ASSET_CACHE_PIN', catalog: changed })).ok, true);
  assert.equal(await (await f.fetchFile('updated', hashUrl)).text(), 'atlas bytes');
  assert.equal(f.network(), 0, 'an alias-only directory update does not download unchanged cache content');
  const partial = await f.fetchFile('updated', hashUrl, { Range: 'bytes=0-4' });
  assert.equal(partial.status, 206); assert.equal(await partial.text(), 'atlas'); assert.equal(f.network(), 0);
  await f.fetchFile('updated', '/assets/~0000000000000000/model.atlas');
  assert.equal(f.network(), 1, 'an unrelated hash does not resolve by dropping its segment');
  await f.fetchFile('old', hashUrl);
  // The old page's catalog does not know the new alias, but it does list the same file under its plain path WITH THE SAME
  // hash: the bytes are already verified in this cache, so a still-open page reuses them instead of downloading them
  // again (asset-cache-sw.js cachedHashAlias). A page is never handed bytes with a different hash than its pin.
  assert.equal(f.network(), 1, 'the same content hash is reused even without the alias');
  assert.equal(await (await f.fetchFile('old')).text(), 'atlas bytes');
  assert.equal(f.network(), 1, 'the old plain-path pin continues to use its existing verified content');
});

test('the merged SW serves the title screen imported cache when no pinned catalog matches', async () => {
  const f = await fixture(); f.addClient('page');
  const importedUrl = `/assets/~0123456789abcdef/title.png`;
  const imported = await f.storage.open(helpers.IMPORTED_ASSET_CACHE);
  await imported.put(origin + importedUrl, new Response('title-bytes'));
  assert.equal(await (await f.fetchFile('page', importedUrl)).text(), 'title-bytes');
  assert.equal(f.network(), 0, 'the imported copy is served without the network');
  // A Range request is left to the network: partial responses never come from that cache.
  const ranged = await f.fetchFile('page', importedUrl, { Range: 'bytes=0-1' });
  assert.equal(await ranged.text(), 'atlas bytes');
  assert.equal(f.network(), 1, 'the fixture network body');
});

test('prune uses the SHA index and never enumerates a full pre-cache', async () => {
  const f = await fixture(); f.addClient('page');
  await f.message('page', { type: 'ASSET_CACHE_PIN', catalog });
  const cache = await f.storage.open(helpers.ASSET_CACHE_NAME);
  await cache.put(origin + helpers.assetContentKey(sha256), new Response(body, { headers: helpers.validatedCacheHeaders(entry) }));
  const staleSha = 'c'.repeat(64);
  await cache.put(origin + helpers.assetContentKey(staleSha), new Response('stale'));
  await cache.put(origin + helpers.ASSET_CACHE_INDEX_URL, Response.json([sha256, staleSha]));
  // A legacy/small cache would also answer keys(); break it to prove prune no longer calls it.
  cache.keys = async () => { throw new DOMException('Operation too large.', 'AbortError'); };
  const reply = await f.message('page', { type: 'ASSET_CACHE_PRUNE' });
  assert.equal(reply.ok, true, 'a complete import must not become an error because keys() is too large');
  assert.equal(await cache.match(origin + helpers.assetContentKey(sha256)) !== undefined, true);
  assert.equal(await cache.match(origin + helpers.assetContentKey(staleSha)), undefined);
  assert.deepEqual(await (await cache.match(origin + helpers.ASSET_CACHE_INDEX_URL)).json(), [sha256]);
});
