import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { EventEmitter } from 'node:events';
import { gunzipSync } from 'node:zlib';
import { createAssetCacheHandler } from '../server/http/assetCache.js';
import { createRequestHandler } from '../server/http/routes.js';
import { CacheDownloadLimiter, assetCacheLimitOptions } from '../server/http/cacheLimiter.js';

const log = { warn() {}, error() {}, debug() {} };
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function fixture(run, { limits, trustProxy = false, sizes = [32_000, 32_000], failFirstBuild = false,
  catalogProperties = {}, updateNow } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sp-cache-http-'));
  const publicDir = path.join(root, 'public');
  await fs.mkdir(path.join(publicDir, 'assets'), { recursive: true });
  const files = sizes.map((bytes, i) => ({ url: `/assets/test-${i}.png`, bytes,
    sha256: sha256(Buffer.alloc(bytes, i + 1)), type: 'image/png', aliases: [] }));
  for (let i = 0; i < files.length; i++) await fs.writeFile(path.join(publicDir, files[i].url), Buffer.alloc(files[i].bytes, i + 1));
  const catalog = { schema: 1, version: sha256(JSON.stringify({ schema: 1, files })), app: 'test', files,
    totalFiles: files.length, totalBytes: sizes.reduce((sum, value) => sum + value, 0), complete: true, missing: [], ...catalogProperties };
  let builds = 0;
  const assetCache = createAssetCacheHandler({ publicDir, dataDir: root, log, limits, trustProxy, updateNow,
    buildCatalog: async () => { builds++; if (failFirstBuild && builds === 1) throw new Error('test setup not ready'); return catalog; } });
  const server = http.createServer(createRequestHandler({ assetCache, log,
    serveStatic: async (req, res) => { res.writeHead(200, { 'Content-Length': 4 }); res.end('game'); } }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try { await run({ root, publicDir, files, catalog, server, assetCache, builds: () => builds }); }
  finally {
    assetCache.close();
    await new Promise((resolve) => { server.close(resolve); server.closeAllConnections?.(); });
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()), 'cleanup remains in the temporary directory');
    assert.ok(path.basename(root).startsWith('sp-cache-http-'), 'cleanup targets only this test fixture');
    await fs.rm(root, { recursive: true, force: true });
  }
}

function request(server, url, { method = 'GET', headers = {}, onResponse, onChunk } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.address().port, path: url, method, headers }, (res) => {
      const chunks = []; const startedAt = performance.now();
      onResponse?.(res, req);
      res.on('data', (chunk) => { chunks.push(chunk); onChunk?.(chunk, req); });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks),
        elapsed: performance.now() - startedAt }));
      res.on('error', reject);
    });
    req.on('error', reject); req.end();
  });
}

const downloadURL = (entry) => `/api/asset-cache/file?url=${encodeURIComponent(entry.url)}&hash=${entry.sha256}`;
const errorOf = (res) => JSON.parse(res.body.toString()).error;
const updateURL = (catalog, values = {}) => '/api/asset-cache/catalog-update?' + new URLSearchParams({
  from: '0'.repeat(64), to: catalog.version, readyFiles: '1', readyBytes: '1', ...values,
});
const manualHeaders = { 'X-Asset-Cache-Update': 'manual' };

test('runtime emergency rejects filling before catalog work and resumes without overriding owner disable', async () => {
  await fixture(async ({ assetCache, server, files, catalog, builds }) => {
    assetCache.trip('test-congestion');
    for (const options of [{}, { method: 'HEAD' }]) {
      const response = await request(server, downloadURL(files[0]), options);
      assert.equal(response.status, 503);
      assert.equal(response.headers['retry-after'], '120');
      if (!options.method) assert.equal(errorOf(response), 'ASSET_CACHE_EMERGENCY');
    }
    const update = await request(server, updateURL(catalog), { headers: manualHeaders });
    assert.equal(errorOf(update), 'ASSET_CACHE_EMERGENCY');
    assert.equal(builds(), 0, 'rejected requests cannot hash or build the full directory');
    assert.equal(assetCache.policy().emergency, true);
    assetCache.resume();
    assert.equal((await request(server, downloadURL(files[0]))).status, 200);
  });
});

test('runtime emergency aborts an active HTTP fill and accepts only a fresh transfer after resume', async () => {
  await fixture(async ({ assetCache, server, files }) => {
    await assert.rejects(request(server, downloadURL(files[0]), {
      onChunk: () => assetCache.trip('test-active-abort'),
    }));
    assert.equal(assetCache.policy().activeDownloads, 0);
    assert.equal(errorOf(await request(server, downloadURL(files[0]))), 'ASSET_CACHE_EMERGENCY');
    assetCache.resume();
    const fresh = await request(server, downloadURL(files[0]));
    assert.equal(fresh.body.length, files[0].bytes);
  }, { sizes: [256000], limits: { totalBps: 1_000_000, clientBps: 1_000_000 } });
});

test('pre-cache status exposes only a tiny summary and shares the immutable snapshot with admission', async () => {
  await fixture(async ({ server, catalog, builds, assetCache }) => {
    assert.equal(assetCache.currentSummary(), null);
    const [status, expected] = await Promise.all([request(server, '/api/asset-cache/status'), assetCache.summary()]);
    const report = JSON.parse(status.body);
    assert.equal(report.totalBytes, catalog.totalBytes); assert.equal(report.totalFiles, 2);
    assert.equal(report.policy.totalBps, 1_000_000); assert.equal(report.policy.clientBps, 500_000);
    assert.equal(report.policy.activeDownloads, 0); assert.equal(builds(), 1);
    assert.equal(status.headers['cache-control'], 'no-store');
    assert.equal(report.version, catalog.version); assert.equal(report.complete, true);
    assert.equal(report.requireAssetCache, false); assert.equal(report.catalogSource, 'server');
    for (const key of ['files', 'aliases', 'missing', 'warnings']) assert.equal(report[key], undefined);
    assert.ok(status.body.length < 1024, 'summary size stays independent of full file/alias count');
    assert.equal(expected, assetCache.currentSummary());
    const head = await request(server, '/api/asset-cache/status', { method: 'HEAD' });
    assert.equal(head.body.length, 0); assert.equal(head.headers['content-length'], status.headers['content-length']);
    assert.equal(builds(), 1);
  }, { limits: { totalBps: 1_000_000, clientBps: 500_000 } });
});

test('summary reports server completeness independently of the reusable file-content version', async () => {
  await fixture(async ({ server, catalog, publicDir, root, assetCache }) => {
    const before = await request(server, '/api/asset-cache/status');
    const next = { ...catalog, complete: false, missing: [{ url: '/assets/missing.png', reason: 'missing file' }] };
    assetCache.close();
    const replacement = createAssetCacheHandler({ publicDir, dataDir: root, log, buildCatalog: async () => next });
    server.removeAllListeners('request');
    server.on('request', createRequestHandler({ assetCache: replacement, log, serveStatic: async () => {} }));
    try {
      const after = await request(server, '/api/asset-cache/status');
      assert.equal(after.status, 200); assert.equal(JSON.parse(before.body).complete, true);
      assert.equal(JSON.parse(after.body).version, catalog.version);
      assert.equal(JSON.parse(after.body).complete, false);
      assert.equal(JSON.parse(after.body).missingFiles, 1);
    } finally { replacement.close(); }
  });
});

test('an explicit cold directory request streams the current catalog through the shared limiter', async () => {
  await fixture(async ({ server, catalog, builds }) => {
    const response = await request(server, '/api/asset-cache/catalog', {
      headers: { 'Accept-Encoding': 'gzip', 'If-None-Match': '"old-catalog"' },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers['content-encoding'], 'gzip');
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(response.headers['x-asset-cache-catalog'], 'online');
    assert.deepEqual(JSON.parse(gunzipSync(response.body)), catalog);
    assert.equal(builds(), 1, 'the first explicit directory request builds one reusable snapshot');
    const head = await request(server, '/api/asset-cache/catalog', { method: 'HEAD' });
    assert.equal(head.status, 405); assert.equal(head.body.length, 0); assert.equal(head.headers.allow, 'GET');
  });
});

test('catalog updates require an explicit GET with an exact stale-version and positive cache report', async () => {
  await fixture(async ({ server, catalog, builds }) => {
    const noHeader = await request(server, updateURL(catalog));
    assert.equal(noHeader.status, 403); assert.equal(errorOf(noHeader), 'ASSET_CACHE_CATALOG_UPDATE_MANUAL_ONLY');
    const head = await request(server, updateURL(catalog), { method: 'HEAD', headers: manualHeaders });
    assert.equal(head.status, 405); assert.equal(head.headers.allow, 'GET'); assert.equal(head.body.length, 0);
    for (const values of [{ from: '' }, { from: 'old' }, { to: '' }, { readyFiles: '0' }, { readyBytes: '0' },
      { readyFiles: '-1' }, { readyFiles: '1.5' }, { readyBytes: '9007199254740992' }, { readyBytes: '01' }]) {
      const invalid = await request(server, updateURL(catalog, values), { headers: manualHeaders });
      assert.equal(invalid.status, 400); assert.equal(errorOf(invalid), 'ASSET_CACHE_INVALID_REQUEST');
      assert.ok(invalid.body.length < 128);
    }
    for (const extra of ['&from=' + '1'.repeat(64), '&to=' + catalog.version, '&readyFiles=1', '&readyBytes=1', '&extra=1']) {
      assert.equal((await request(server, updateURL(catalog) + extra, { headers: manualHeaders })).status, 400);
    }
    assert.equal((await request(server, updateURL(catalog), { headers: { ...manualHeaders, Range: 'bytes=0-10' } })).status, 400);
    const matched = await request(server, updateURL(catalog, { from: catalog.version }), { headers: manualHeaders });
    assert.equal(matched.status, 409); assert.equal(errorOf(matched), 'ASSET_CACHE_CATALOG_ALREADY_CURRENT');
    assert.equal(builds(), 0, 'cold/empty/non-manual/malformed calls cannot build or serialize a large directory');
    const staleTarget = await request(server, updateURL(catalog, { to: '1'.repeat(64) }), { headers: manualHeaders });
    assert.equal(staleTarget.status, 409); assert.equal(errorOf(staleTarget), 'ASSET_CACHE_CATALOG_VERSION_MISMATCH');
    assert.equal(builds(), 1);
  });
});

test('manual updates return gzip or identity JSON, with one snapshot and a per-IP 5-second cooldown', async () => {
  let now = 1000;
  await fixture(async ({ server, catalog, builds, assetCache }) => {
    const gzip = await request(server, updateURL(catalog), { headers: {
      ...manualHeaders, 'Accept-Encoding': 'br, gzip', 'X-Forwarded-For': '203.0.113.1',
    } });
    assert.equal(gzip.status, 200); assert.equal(gzip.headers['content-encoding'], 'gzip');
    assert.equal(gzip.headers['content-length'], String(gzip.body.length));
    assert.equal(gzip.headers.vary, 'Accept-Encoding'); assert.equal(gzip.headers['x-accel-buffering'], 'no');
    assert.equal(gzip.headers['cache-control'], 'no-store');
    assert.deepEqual(JSON.parse(gunzipSync(gzip.body)), catalog);
    assert.ok(gzip.body.length < Buffer.byteLength(JSON.stringify(catalog)) / 10);
    const repeat = await request(server, updateURL(catalog), { headers: {
      ...manualHeaders, 'X-Forwarded-For': '203.0.113.1',
    } });
    assert.equal(repeat.status, 429); assert.equal(errorOf(repeat), 'ASSET_CACHE_CATALOG_UPDATE_COOLDOWN');
    assert.equal(repeat.headers['retry-after'], '5'); assert.ok(repeat.body.length < 128);
    const identity = await request(server, updateURL(catalog), { headers: {
      ...manualHeaders, 'Accept-Encoding': 'gzip;q=0, *;q=1', 'X-Forwarded-For': '203.0.113.2',
    } });
    assert.equal(identity.status, 200); assert.equal(identity.headers['content-encoding'], undefined);
    assert.deepEqual(JSON.parse(identity.body), catalog);
    assert.equal(builds(), 1); assert.equal(assetCache.policy().activeDownloads, 0);
    now += 5_000;
    const afterCooldown = await request(server, updateURL(catalog), { headers: {
      ...manualHeaders, 'Accept-Encoding': 'gzip', 'X-Forwarded-For': '203.0.113.1',
    } });
    assert.equal(afterCooldown.status, 200); assert.deepEqual(afterCooldown.body, gzip.body);
    assert.equal(builds(), 1);
  }, { trustProxy: true, updateNow: () => now, catalogProperties: { warnings: ['test '.repeat(5000)] } });
});

test('catalog updates obey the online-disable setting and oversized JSON fails before streaming headers', async () => {
  await fixture(async ({ server, catalog, builds, assetCache }) => {
    const result = await request(server, updateURL(catalog), { headers: manualHeaders });
    assert.equal(result.status, 503); assert.equal(errorOf(result), 'ASSET_CACHE_ONLINE_DISABLED');
    assert.equal(builds(), 0); assert.equal(assetCache.policy().activeDownloads, 0);
  }, { limits: { totalBps: 0 } });
  await fixture(async ({ server, catalog, assetCache }) => {
    const result = await request(server, updateURL(catalog), { headers: manualHeaders });
    assert.equal(result.status, 503); assert.equal(errorOf(result), 'ASSET_CACHE_CATALOG_UNAVAILABLE');
    assert.ok(result.body.length < 128); assert.equal(assetCache.policy().activeDownloads, 0);
  }, { catalogProperties: { warnings: ['x'.repeat(32 * 1024 * 1024)] } });
});

test('catalog and file downloads share the aggregate and per-IP byte ceilings over real HTTP', async () => {
  for (const sameIp of [false, true]) await fixture(async ({ server, catalog, files, assetCache }) => {
    const started = performance.now();
    const [directory, file] = await Promise.all([
      request(server, updateURL(catalog), { headers: { ...manualHeaders, 'X-Forwarded-For': '203.0.113.1' } }),
      request(server, downloadURL(files[0]), { headers: { 'X-Forwarded-For': '203.0.113.2' } }),
    ]);
    const elapsed = performance.now() - started;
    const minimum = (directory.body.length + file.body.length) / 120_000 * 1000 * 0.85;
    assert.equal(directory.status, 200); assert.equal(file.status, 200);
    assert.deepEqual(JSON.parse(directory.body), catalog); assert.equal(sha256(file.body), files[0].sha256);
    assert.ok(elapsed >= minimum, `catalog transfer bypassed aggregate file budget (${elapsed} ms < ${minimum} ms)`);
    assert.ok(elapsed < 3500, 'both responses continue to make progress under the same scheduler');
    assert.equal(assetCache.policy().activeDownloads, 0);
  }, { trustProxy: !sameIp, sizes: [80_000], catalogProperties: { warnings: ['x'.repeat(80_000)] },
    limits: { totalBps: sameIp ? 1_000_000 : 120_000, clientBps: 120_000 } });
});

test('catalog updates share file concurrency slots, and cancellation releases the slot but retains cooldown', async () => {
  await fixture(async ({ server, catalog, files, assetCache }) => {
    let begin;
    const begun = new Promise((resolve) => { begin = resolve; });
    const slow = request(server, downloadURL(files[0]), { onResponse: begin });
    await begun;
    const busy = await request(server, updateURL(catalog), { headers: manualHeaders });
    assert.equal(busy.status, 429); assert.equal(errorOf(busy), 'ASSET_CACHE_BUSY');
    await slow;
    let canceled = false; let busyFile;
    await assert.rejects(request(server, updateURL(catalog), { headers: manualHeaders, onResponse: () => {
      busyFile = request(server, downloadURL(files[0]));
    }, onChunk: (_chunk, req) => {
      if (!canceled) { canceled = true; req.destroy(new Error('test canceled')); }
    } }), /test canceled|aborted/);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const fileResult = await busyFile;
    // The cancellation and file request may race; either result is safe and no slot remains held.
    assert.ok(fileResult.status === 200 || fileResult.status === 429);
    assert.equal(assetCache.policy().activeDownloads, 0);
    const cooldown = await request(server, updateURL(catalog), { headers: manualHeaders });
    assert.equal(cooldown.status, 429); assert.equal(errorOf(cooldown), 'ASSET_CACHE_CATALOG_UPDATE_COOLDOWN');
    assert.equal((await request(server, downloadURL(files[0]))).status, 200);
  }, { sizes: [20_000], catalogProperties: { warnings: ['x'.repeat(120_000)] },
    limits: { totalBps: 120_000, clientBps: 120_000, maxDownloads: 1 } });
});

test('pre-cache downloads only exact catalog paths/hashes, full uncompressed responses and safe GET/HEAD', async () => {
  await fixture(async ({ server, files, assetCache }) => {
    const response = await request(server, downloadURL(files[0]), { headers: { 'Accept-Encoding': 'gzip' } });
    assert.equal(response.status, 200); assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(response.headers['content-encoding'], undefined); assert.equal(response.headers['x-asset-sha256'], files[0].sha256);
    assert.equal(response.headers['x-accel-buffering'], 'no'); assert.equal(sha256(response.body), files[0].sha256);
    const head = await request(server, downloadURL(files[0]), { method: 'HEAD' });
    assert.equal(head.status, 200); assert.equal(head.body.length, 0); assert.equal(assetCache.policy().activeDownloads, 0);
    const stale = await request(server, downloadURL({ ...files[0], sha256: '0'.repeat(64) }));
    assert.equal(stale.status, 409); assert.equal(errorOf(stale), 'ASSET_CACHE_STALE_HASH');
    const unknown = await request(server, downloadURL({ ...files[0], url: '/assets/../secret.png' }));
    assert.equal(unknown.status, 404); assert.equal(errorOf(unknown), 'ASSET_CACHE_FILE_NOT_FOUND');
    const ranged = await request(server, downloadURL(files[0]), { headers: { Range: 'bytes=0-9' } });
    assert.equal(ranged.status, 400); assert.equal(errorOf(ranged), 'ASSET_CACHE_RANGE_UNSUPPORTED');
    assert.equal((await request(server, downloadURL(files[0]) + '&hash=' + files[0].sha256)).status, 400);
    assert.equal((await request(server, '/api/asset-cache/not-found')).status, 404);
    assert.equal((await request(server, '/api/asset-cache/status', { method: 'POST' })).status, 405);
  }, { limits: { totalBps: 2_000_000, clientBps: 1_000_000 } });
});

test('changed and missing files never masquerade as the catalog hash', async () => {
  await fixture(async ({ server, publicDir, files }) => {
    await request(server, '/api/asset-cache/status');
    const file = path.join(publicDir, files[0].url);
    await fs.writeFile(file, Buffer.alloc(files[0].bytes, 99));
    const changed = await request(server, downloadURL(files[0]));
    assert.equal(changed.status, 409); assert.equal(errorOf(changed), 'ASSET_CACHE_SOURCE_CHANGED');
    await fs.unlink(file);
    assert.equal((await request(server, downloadURL(files[0]))).status, 409);
  });
});

test('a file replaced by a symlink after catalog construction is refused', async (t) => {
  await fixture(async ({ server, publicDir, files }) => {
    await request(server, '/api/asset-cache/status');
    const file = path.join(publicDir, files[0].url);
    await fs.unlink(file);
    try { await fs.symlink(path.join(publicDir, files[1].url), file, 'file'); }
    catch (error) {
      if (!['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) throw error;
      t.skip(`symlink creation unavailable (${error.code})`); return;
    }
    const result = await request(server, downloadURL(files[0]));
    assert.equal(result.status, 409); assert.equal(errorOf(result), 'ASSET_CACHE_SOURCE_CHANGED');
  });
});

test('an unavailable catalog returns a retryable failure and does not poison subsequent requests', async () => {
  await fixture(async ({ server, builds }) => {
    const unavailable = await request(server, '/api/asset-cache/status');
    assert.equal(unavailable.status, 503); assert.equal(unavailable.headers['retry-after'], '5');
    assert.equal(errorOf(unavailable), 'ASSET_CACHE_CATALOG_UNAVAILABLE');
    assert.equal((await request(server, '/api/asset-cache/status')).status, 200);
    assert.equal(builds(), 2);
  }, { failFirstBuild: true });
});

test('online disable and full slots are explicit; HEAD and game assets do not consume download slots', async () => {
  await fixture(async ({ server, files, assetCache }) => {
    const disabled = await request(server, downloadURL(files[0]));
    assert.equal(disabled.status, 503); assert.equal(errorOf(disabled), 'ASSET_CACHE_ONLINE_DISABLED');
    assert.equal((await request(server, '/assets/test-0.png')).status, 200);
    assert.equal((await request(server, downloadURL(files[0]), { method: 'HEAD' })).status, 200);
    assert.equal(assetCache.policy().activeDownloads, 0);
  }, { limits: { totalBps: 0 } });
  await fixture(async ({ server, files, assetCache }) => {
    let begin;
    const begun = new Promise((resolve) => { begin = resolve; });
    const slow = request(server, downloadURL(files[0]), { onResponse: begin });
    await begun;
    const busy = await request(server, downloadURL(files[1]));
    assert.equal(busy.status, 429); assert.equal(busy.headers['retry-after'], '3');
    const before = performance.now();
    assert.equal((await request(server, '/assets/normal-game.png')).body.toString(), 'game');
    assert.ok(performance.now() - before < 300, 'ordinary gameplay HTTP is not queued behind pre-cache downloads');
    assert.equal((await request(server, downloadURL(files[1]), { method: 'HEAD' })).status, 200);
    assert.equal(assetCache.policy().activeDownloads, 1);
    assert.equal((await slow).status, 200);
    assert.equal(assetCache.policy().activeDownloads, 0);
  }, { limits: { totalBps: 120_000, clientBps: 120_000, maxDownloads: 1 } });
});

test('two clients dynamically share the one aggregate byte budget fairly over real HTTP', async () => {
  await fixture(async ({ server, files }) => {
    const started = performance.now(); const received = [0, 0]; const first = [null, null];
    const responses = await Promise.all(files.map((entry, i) => request(server, downloadURL(entry), {
      headers: { 'X-Forwarded-For': `203.0.113.${i + 1}` },
      onChunk: (chunk) => { received[i] += chunk.length; if (first[i] == null) first[i] = performance.now() - started; },
    })));
    const elapsed = performance.now() - started;
    assert.ok(elapsed >= 850, `aggregate 160000 bytes at 160000 B/s cannot finish in ${elapsed} ms`);
    assert.ok(elapsed < 3000, `scheduler kept available bandwidth unused (${elapsed} ms)`);
    assert.ok(Math.abs(responses[0].elapsed - responses[1].elapsed) < 300, 'round-robin does not starve either client');
    assert.ok(first.every((time) => time != null && time < 250));
    assert.deepEqual(received, [80_000, 80_000]);
    responses.forEach((res, i) => assert.equal(sha256(res.body), files[i].sha256));
  }, { trustProxy: true, sizes: [80_000, 80_000], limits: { totalBps: 160_000, clientBps: 160_000 } });
});

test('multiple responses from one client share its ceiling; cancellation releases its slot immediately', async () => {
  await fixture(async ({ server, files, assetCache }) => {
    const started = performance.now();
    await Promise.all(files.map((entry) => request(server, downloadURL(entry))));
    const elapsed = performance.now() - started;
    assert.ok(elapsed >= 850, `two sockets bypassed a shared client ceiling (${elapsed} ms)`);
    assert.ok(elapsed < 3000);
    let canceled = false;
    await assert.rejects(request(server, downloadURL(files[0]), { onChunk: (_chunk, req) => {
      if (!canceled) { canceled = true; req.destroy(new Error('test canceled')); }
    } }), /test canceled|aborted/);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(assetCache.policy().activeDownloads, 0);
    assert.equal((await request(server, downloadURL(files[1]))).status, 200);
  }, { sizes: [40_000, 40_000], limits: { totalBps: 1_000_000, clientBps: 80_000 } });
});

test('rate configuration uses byte units and fails closed on invalid values', () => {
  assert.equal(assetCacheLimitOptions({}, { SP_ASSET_CACHE_TOTAL_BPS: '0' }).totalBps, 0);
  assert.equal(assetCacheLimitOptions({}, { SP_ASSET_CACHE_TOTAL_BPS: '1000000' }).totalBps, 1_000_000);
  assert.throws(() => assetCacheLimitOptions({}, { SP_ASSET_CACHE_TOTAL_BPS: '-1' }), RangeError);
  assert.throws(() => assetCacheLimitOptions({ clientBps: 0 }), RangeError);
  assert.throws(() => new CacheDownloadLimiter({ maxDownloads: 0 }), RangeError);
});

test('very low positive rates still accumulate a one-byte token', async () => {
  const limiter = new CacheDownloadLimiter({ totalBps: 1, clientBps: 1 });
  const response = new EventEmitter(); response.write = () => true; response.end = () => { response.writableEnded = true; response.emit('close'); };
  const handle = { read: async (buffer, _offset, length) => { buffer.fill(1); return { bytesRead: length }; } };
  const lease = limiter.acquire('low-rate'); lease.stream(handle, response, 1);
  // Advance the elapsed refill time without adding a wall-clock one-second delay.
  limiter.updatedAt -= 1200; limiter.clients.get('low-rate').updatedAt -= 1200;
  try {
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(response.writableEnded, true);
  } finally { limiter.close(); }
});

test('backpressure bounds the buffered chunk; drain resumes and shutdown cancels waiting responses', async () => {
  const limiter = new CacheDownloadLimiter({ totalBps: 1_000_000, clientBps: 1_000_000 });
  const response = new EventEmitter();
  const lengths = [];
  response.write = (buffer) => { lengths.push(buffer.length); return false; };
  response.destroy = () => { response.destroyed = true; response.emit('close'); };
  response.end = () => { response.writableEnded = true; response.emit('close'); };
  let readCalls = 0;
  const handle = { read: async (buffer, _offset, length) => { readCalls++; buffer.fill(1); return { bytesRead: length }; } };
  const lease = limiter.acquire('test-client');
  const streaming = lease.stream(handle, response, 100_000);
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(readCalls, 1, 'no further file chunks are read while the response is backpressured');
  assert.ok(lengths[0] <= 8192, 'each response holds at most one quantum in application memory');
  response.emit('drain');
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(readCalls, 2);
  limiter.close(); await streaming;
  assert.equal(limiter.policy().activeDownloads, 0); assert.equal(response.destroyed, true);
  assert.equal(limiter.acquire('late-client'), null);
});

test('catalog buffers honor bounded backpressure and cancellation without copying the full body per client', async () => {
  const limiter = new CacheDownloadLimiter({ totalBps: 1_000_000, clientBps: 1_000_000 });
  const response = new EventEmitter(); const chunks = []; const body = Buffer.alloc(100_000, 7);
  response.write = (chunk) => { chunks.push(chunk); return false; };
  response.destroy = () => { response.destroyed = true; response.emit('close'); };
  response.end = () => { response.writableEnded = true; response.emit('close'); };
  const lease = limiter.acquire('buffer-client'); const streaming = lease.streamBuffer(body, response);
  try {
    await new Promise((resolve) => setTimeout(resolve, 90));
    assert.equal(chunks.length, 1); assert.ok(chunks[0].length <= 8192);
    assert.equal(chunks[0].buffer, body.buffer, 'a response retains a bounded view of the shared immutable catalog');
    assert.throws(() => lease.streamBuffer(Buffer.from('replacement'), response), /already streaming/);
    response.emit('drain');
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(chunks.length, 2); assert.equal(chunks[1][0], 7, 'invalid double-start cannot replace the active body');
  } finally { limiter.close(); await streaming; }
  assert.equal(limiter.policy().activeDownloads, 0); assert.equal(response.destroyed, true);
});
