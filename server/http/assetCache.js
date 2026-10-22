// Explicit filling and manual stale-catalog updates share one rate limit. Game requests remain unchanged.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gzip } from 'node:zlib';
import { promisify } from 'node:util';
import { performance } from 'node:perf_hooks';
import { createAssetCacheCatalog, checkedAssetPath } from '../assetCacheCatalog.js';
import { clientAddress } from '../net.js';
import { parseTrustProxy } from './config.js';
import { MIME } from './files.js';
import { assetCacheSummary, MAX_MANIFEST_BYTES } from '../../shared/assetCache.js';
import { sendJson } from './common.js';
import { CacheDownloadLimiter } from './cacheLimiter.js';

export const ASSET_CACHE_PREFIX = '/api/asset-cache/';
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const POSITIVE_INTEGER = /^[1-9]\d*$/;
const UPDATE_COOLDOWN_MS = 5_000;
const MAX_UPDATE_CLIENTS = 4096;
const gzipAsync = promisify(gzip);

function failure(req, res, status, error) { sendJson(req, res, status, { error }); }

function updateParameters(query) {
  const params = new URLSearchParams(query);
  const names = ['from', 'to', 'readyFiles', 'readyBytes'];
  if ([...params].length !== names.length || names.some((name) => params.getAll(name).length !== 1)) return null;
  const from = params.get('from'); const to = params.get('to');
  if (!HASH_PATTERN.test(from || '') || !HASH_PATTERN.test(to || '')) return null;
  for (const name of ['readyFiles', 'readyBytes']) {
    const value = params.get(name);
    if (!POSITIVE_INTEGER.test(value || '') || !Number.isSafeInteger(Number(value))) return null;
  }
  return { from, to };
}

function acceptsGzip(value) {
  let wildcard = false;
  for (const item of String(value || '').toLowerCase().split(',')) {
    const [name, ...parameters] = item.trim().split(';');
    const q = parameters.map((part) => part.trim()).find((part) => part.startsWith('q='));
    const weight = q == null ? 1 : Number(q.slice(2));
    const accepted = Number.isFinite(weight) && weight > 0 && weight <= 1;
    if (name === 'gzip') return accepted;
    if (name === '*') wildcard = accepted;
  }
  return wildcard;
}

function sameFile(a, b) {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;
}

/** Catalog URLs are allowlisted; also reject symlinks/replacements at use time, after the catalog's initial scan. */
async function openAsset(publicDir, url) {
  const { filePath, stat: before } = await checkedAssetPath(publicDir, url);
  const handle = await fsp.open(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const after = await handle.stat();
    if (!after.isFile() || !sameFile(before, after)) throw new Error('asset replaced while opening');
    return handle;
  } catch (error) { await handle.close(); throw error; }
}

/** Bounded-memory verification before headers: never silently transfer changed bytes under an old SHA-256. */
async function verifyAsset(handle, entry, canceled) {
  const before = await handle.stat();
  if (before.size !== entry.bytes) return false;
  const digest = createHash('sha256');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  for (let position = 0; position < entry.bytes;) {
    if (canceled()) return false;
    const length = Math.min(buffer.length, entry.bytes - position);
    const { bytesRead } = await handle.read(buffer, 0, length, position);
    if (bytesRead !== length) return false;
    digest.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  return digest.digest('hex') === entry.sha256 && sameFile(before, await handle.stat());
}

export function createAssetCacheHandler({ publicDir, dataDir, log, limits, trustProxy, buildCatalog = createAssetCacheCatalog,
  requireAssetCache = () => false, updateNow = () => performance.now(),
  hashCacheFile = path.resolve(publicDir, '..', '.cache', 'asset-catalog-hashes.json') }) {
  const limiter = new CacheDownloadLimiter(limits);
  const proxy = trustProxy ?? parseTrustProxy(process.env.TRUST_PROXY);
  let pending = null;
  let current = null;
  let rawCatalogBody = null;
  let gzipCatalogBody = null;
  const updateClients = new Map();
  function emergencyFailure(req, res) {
    if (!limiter.policy().emergency) return false;
    res.setHeader('Retry-After', '120');
    failure(req, res, 503, 'ASSET_CACHE_EMERGENCY');
    return true;
  }
  // One immutable catalog per server lifetime, shared by the tiny summary and filling allowlist.
  // Failure is retryable (e.g. setup still copying files); a successful snapshot changes only after restart.
  async function snapshot() {
    if (!pending) pending = Promise.resolve().then(() => buildCatalog({ publicDir, dataDir, hashCacheFile,
      onHashStats: stats => log?.info?.('[asset-cache] digest scan', stats) })).then((catalog) => {
      const byUrl = new Map(catalog.files.map((entry) => [entry.url, entry]));
      current = assetCacheSummary(catalog);
      return { catalog, byUrl };
    }).catch((error) => { pending = null; throw error; });
    return pending;
  }

  async function catalogBody(catalog, compressed) {
    if (!rawCatalogBody) {
      const body = Buffer.from(JSON.stringify(catalog));
      // A server directory must fit the same bounded JSON format accepted by ZIP/JSON import.
      if (body.length > MAX_MANIFEST_BYTES) throw new Error('asset cache catalog exceeds the import size limit');
      rawCatalogBody = body;
    }
    if (!compressed) return rawCatalogBody;
    if (!gzipCatalogBody) gzipCatalogBody = gzipAsync(rawCatalogBody).catch((error) => { gzipCatalogBody = null; throw error; });
    return gzipCatalogBody;
  }

  async function serveCatalogUpdate(req, res, query) {
    if (emergencyFailure(req, res)) return;
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET'); failure(req, res, 405, 'ASSET_CACHE_CATALOG_UPDATE_GET_ONLY'); return;
    }
    if (req.headers['x-asset-cache-update'] !== 'manual') {
      failure(req, res, 403, 'ASSET_CACHE_CATALOG_UPDATE_MANUAL_ONLY'); return;
    }
    const request = updateParameters(query);
    if (!request || req.headers.range) { failure(req, res, 400, 'ASSET_CACHE_INVALID_REQUEST'); return; }
    if (request.from === request.to) { failure(req, res, 409, 'ASSET_CACHE_CATALOG_ALREADY_CURRENT'); return; }
    if (!limiter.policy().enabled) { failure(req, res, 503, 'ASSET_CACHE_ONLINE_DISABLED'); return; }
    let state;
    try { state = await snapshot(); } catch (error) {
      log?.warn?.('[asset-cache] catalog unavailable', error.message);
      res.setHeader('Retry-After', '5'); failure(req, res, 503, 'ASSET_CACHE_CATALOG_UNAVAILABLE'); return;
    }
    if (res.destroyed) return;
    if (request.to !== current.version) { failure(req, res, 409, 'ASSET_CACHE_CATALOG_VERSION_MISMATCH'); return; }
    const address = clientAddress(req, proxy);
    const key = address.ip;
    const now = updateNow();
    for (const [client, until] of updateClients) if (until <= now) updateClients.delete(client);
    const until = updateClients.get(key);
    if (until > now) {
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil((until - now) / 1000))));
      failure(req, res, 429, 'ASSET_CACHE_CATALOG_UPDATE_COOLDOWN'); return;
    }
    // Do not evict live cooldowns: rotation across many claimed addresses must not restore old ones.
    if (updateClients.size >= MAX_UPDATE_CLIENTS) {
      res.setHeader('Retry-After', '3'); failure(req, res, 429, 'ASSET_CACHE_BUSY'); return;
    }
    if (emergencyFailure(req, res)) return;
    const lease = limiter.acquire(key, res, address.key || address.ip);
    if (!lease) { res.setHeader('Retry-After', '3'); failure(req, res, 429, 'ASSET_CACHE_BUSY'); return; }
    updateClients.set(key, now + UPDATE_COOLDOWN_MS);
    const cancel = () => lease.release();
    res.once('close', cancel);
    try {
      const compressed = acceptsGzip(req.headers['accept-encoding']);
      const body = await catalogBody(state.catalog, compressed);
      if (lease.released || res.destroyed) return;
      const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length,
        'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no', Vary: 'Accept-Encoding',
        ...(compressed ? { 'Content-Encoding': 'gzip' } : {}) };
      res.writeHead(200, headers);
      await lease.streamBuffer(body, res);
    } catch (error) {
      if (!res.destroyed && !res.headersSent) failure(req, res, 503, 'ASSET_CACHE_CATALOG_UNAVAILABLE');
      else if (!res.destroyed) res.destroy();
      log?.warn?.('[asset-cache] catalog update unavailable', error.message);
    } finally { res.off('close', cancel); lease.release(); }
  }

  async function serveCatalog(req, res) {
    if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); failure(req, res, 405, 'ASSET_CACHE_CATALOG_GET_ONLY'); return; }
    if (req.headers.range) {
      failure(req, res, 400, 'ASSET_CACHE_RANGE_UNSUPPORTED'); return;
    }
    if (!limiter.policy().enabled) { failure(req, res, 503, 'ASSET_CACHE_ONLINE_DISABLED'); return; }
    let state;
    try { state = await snapshot(); } catch (error) {
      log?.warn?.('[asset-cache] catalog unavailable', error.message);
      res.setHeader('Retry-After', '5'); failure(req, res, 503, 'ASSET_CACHE_CATALOG_UNAVAILABLE'); return;
    }
    if (res.destroyed) return;
    const address = clientAddress(req, proxy);
    const lease = limiter.acquire(address.ip, res, address.key || address.ip);
    if (!lease) { res.setHeader('Retry-After', '3'); failure(req, res, 429, 'ASSET_CACHE_BUSY'); return; }
    const cancel = () => lease.release();
    res.once('close', cancel);
    try {
      const compressed = acceptsGzip(req.headers['accept-encoding']);
      const body = await catalogBody(state.catalog, compressed);
      if (lease.released || res.destroyed) return;
      const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length,
        'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no', Vary: 'Accept-Encoding',
        'X-Asset-Cache-Catalog': 'online', ...(compressed ? { 'Content-Encoding': 'gzip' } : {}) };
      res.writeHead(200, headers);
      await lease.streamBuffer(body, res);
    } catch (error) {
      if (!res.destroyed && !res.headersSent) failure(req, res, 503, 'ASSET_CACHE_CATALOG_UNAVAILABLE');
      else if (!res.destroyed) res.destroy();
      log?.warn?.('[asset-cache] catalog unavailable', error.message);
    } finally { res.off('close', cancel); lease.release(); }
  }

  async function serve(req, res, rawPath, query) {
    if (rawPath !== `${ASSET_CACHE_PREFIX}status` && emergencyFailure(req, res)) return;
    if (rawPath === `${ASSET_CACHE_PREFIX}catalog`) {
      await serveCatalog(req, res); return;
    }
    if (rawPath === `${ASSET_CACHE_PREFIX}catalog-update`) { await serveCatalogUpdate(req, res, query); return; }
    if (rawPath !== `${ASSET_CACHE_PREFIX}status` && rawPath !== `${ASSET_CACHE_PREFIX}catalog` && rawPath !== `${ASSET_CACHE_PREFIX}file`) {
      failure(req, res, 404, 'ASSET_CACHE_ROUTE_NOT_FOUND'); return;
    }
    let state;
    try { state = await snapshot(); } catch (error) {
      log?.warn?.('[asset-cache] catalog unavailable', error.message);
      res.setHeader('Retry-After', '5');
      failure(req, res, 503, 'ASSET_CACHE_CATALOG_UNAVAILABLE'); return;
    }
    if (res.destroyed) return;
    if (rawPath === `${ASSET_CACHE_PREFIX}status`) {
      sendJson(req, res, 200, { ...current, catalogSource: 'server',
        requireAssetCache: !!requireAssetCache(), policy: limiter.policy() }); return;
    }
    const params = new URLSearchParams(query);
    const url = params.get('url');
    const hash = params.get('hash');
    if (!url || !hash || !HASH_PATTERN.test(hash) || params.getAll('url').length !== 1 || params.getAll('hash').length !== 1) {
      failure(req, res, 400, 'ASSET_CACHE_INVALID_REQUEST'); return;
    }
    const entry = state.byUrl.get(url);
    if (!entry) { failure(req, res, 404, 'ASSET_CACHE_FILE_NOT_FOUND'); return; }
    if (hash !== entry.sha256) { failure(req, res, 409, 'ASSET_CACHE_STALE_HASH'); return; }
    if (req.headers.range) { failure(req, res, 400, 'ASSET_CACHE_RANGE_UNSUPPORTED'); return; }
    const headers = { 'Content-Type': entry.type || MIME[path.extname(entry.url)] || 'application/octet-stream',
      'Content-Length': entry.bytes, 'Cache-Control': 'no-store', 'X-Asset-SHA256': entry.sha256,
      'X-Accel-Buffering': 'no', 'Accept-Ranges': 'none' };
    // Metadata-only requests cannot consume a streaming slot or bypass the online-disable switch.
    if (req.method === 'HEAD') { res.writeHead(200, headers); res.end(); return; }
    if (emergencyFailure(req, res)) return;
    if (!limiter.policy().enabled) { failure(req, res, 503, 'ASSET_CACHE_ONLINE_DISABLED'); return; }
    const address = clientAddress(req, proxy);
    const key = address.ip;
    const lease = limiter.acquire(key, res, address.key || address.ip);
    if (!lease) {
      res.setHeader('Retry-After', '3'); failure(req, res, 429, 'ASSET_CACHE_BUSY'); return;
    }
    const cancel = () => lease.release();
    res.once('close', cancel);
    let handle;
    try {
      handle = await openAsset(publicDir, entry.url);
      if (lease.released || res.destroyed) return;
      if (!(await verifyAsset(handle, entry, () => lease.released || res.destroyed))) {
        if (!res.destroyed) failure(req, res, 409, 'ASSET_CACHE_SOURCE_CHANGED'); return;
      }
      if (lease.released || res.destroyed) return;
      res.writeHead(200, headers);
      await lease.stream(handle, res, entry.bytes);
    } catch (error) {
      if (!res.destroyed && !res.headersSent) failure(req, res, 409, 'ASSET_CACHE_SOURCE_CHANGED');
      else if (!res.destroyed) res.destroy();
      log?.debug?.('[asset-cache] download unavailable', error.message);
    } finally {
      res.off('close', cancel); lease.release();
      await handle?.close().catch(() => {});
    }
  }

  return { serve, close: () => { limiter.close(); updateClients.clear(); }, policy: () => limiter.policy(),
    setLimits: (limits) => limiter.setLimits(limits),
    trip: (reason) => limiter.trip(reason), resume: () => limiter.resume(), metrics: () => limiter.metrics(),
    summary: async () => { await snapshot(); return current; }, currentSummary: () => current };
}
