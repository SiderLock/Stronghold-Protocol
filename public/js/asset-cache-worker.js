// The ZIP stays a File/Blob. Only one bounded entry is decompressed and hashed at a time.
// Disk IO, downloads, deep verification and ZIP work all run off the UI thread.
importScripts('/vendor/zip-native.min.js');
zip.configure({ useWebWorkers: false });
const helpers = import('../../shared/assetCache.js');
let active = null;

function cancelled() {
  if (active?.paused) throw Object.assign(new Error('ASSET_CACHE_PAUSED'), { code: 'ASSET_CACHE_PAUSED' });
}
const send = (id, type, value = {}) => self.postMessage({ id, type, ...value });

/** Only a bounded explicit response identifies why an online transfer was refused. */
async function unavailableCode(response) {
  if (!response.body) return 'ASSET_CACHE_DOWNLOAD_FAILED';
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      cancelled();
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 4096) return 'ASSET_CACHE_DOWNLOAD_FAILED';
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const code = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))?.error;
    if (code === 'ASSET_CACHE_EMERGENCY' || code === 'SERVER_EMERGENCY') return 'ASSET_CACHE_EMERGENCY';
    return code === 'ASSET_CACHE_ONLINE_DISABLED' ? code : 'ASSET_CACHE_DOWNLOAD_FAILED';
  } catch { return 'ASSET_CACHE_DOWNLOAD_FAILED'; }
  finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

class LimitedWriter extends zip.Writer {
  constructor(limit) { super(); this.limit = limit; this.chunks = []; this.length = 0; }
  writeUint8Array(chunk) {
    cancelled();
    if (this.length + chunk.length > this.limit) {
      throw Object.assign(new Error('ASSET_CACHE_FILE_TOO_LARGE'), { code: 'ASSET_CACHE_FILE_TOO_LARGE' });
    }
    this.chunks.push(chunk); this.length += chunk.length;
  }
  getData() { return new Blob(this.chunks); }
}

async function archiveEntries(reader, h) {
  const entries = [], seen = new Set();
  for await (const entry of reader.getEntriesGenerator()) {
    cancelled();
    if (entries.length >= h.MAX_CATALOG_FILES * 2) throw h.assetCacheError('ASSET_CACHE_ZIP_TOO_LARGE');
    if (!h.safeAssetZipName(entry.filename) || entry.encrypted || entry.symlink || entry.executable || seen.has(entry.filename)) {
      throw h.assetCacheError('ASSET_CACHE_ZIP_UNSAFE');
    }
    seen.add(entry.filename); entries.push(entry);
  }
  return entries;
}

async function readCatalog(message, h) {
  if (!(message.file instanceof Blob)) throw h.assetCacheError('ASSET_CACHE_BAD_CATALOG');
  let blob = message.file;
  let reader;
  try {
    if (message.format === 'zip') {
      reader = new zip.ZipReader(new zip.BlobReader(blob), { useWebWorkers: false, checkSignature: true });
      const entries = await archiveEntries(reader, h);
      const entry = entries.find((item) => !item.directory && item.filename === 'manifest.json');
      if (!entry) throw h.assetCacheError('ASSET_CACHE_CATALOG_REQUIRED');
      if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 1
        || entry.uncompressedSize > h.MAX_MANIFEST_BYTES || ![0, 8].includes(entry.compressionMethod)) {
        throw h.assetCacheError('ASSET_CACHE_BAD_CATALOG');
      }
      blob = await entry.getData(new LimitedWriter(h.MAX_MANIFEST_BYTES), { useWebWorkers: false, checkSignature: true,
        signal: active.abort.signal });
    } else if (message.format !== 'json') throw h.assetCacheError('ASSET_CACHE_BAD_MESSAGE');
    if (blob.size < 1 || blob.size > h.MAX_MANIFEST_BYTES) throw h.assetCacheError('ASSET_CACHE_BAD_CATALOG');
    const bytes = await blob.arrayBuffer();
    cancelled();
    const catalog = await h.verifyAssetCatalog(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
    cancelled();
    return { catalog };
  } catch (error) {
    if (error.code) throw error;
    throw h.assetCacheError(message.format === 'zip' ? 'ASSET_CACHE_ZIP_INVALID' : 'ASSET_CACHE_BAD_CATALOG', error);
  } finally { await reader?.close(); }
}

/** Content keys already stored in the pre-cache. Cache.keys() throws "Operation too large" for a full 0.3.1 pack. */
/**
 * The hashes the last operation wrote into the cache's SHA index (writeCacheIndex). A full pack is 50 000 files: asking
 * Cache.match once per file is the slowest part of every check/download/import on a phone. The index is a snapshot, so a
 * few entries are probed before trusting it — a partially evicted cache falls back to the real scan below.
 * @returns {Promise<Set<string> | null>} null when there is no usable index
 */
async function indexedHashes(cache, origin, catalog, h) {
  try {
    const listed = await (await cache.match(origin + h.ASSET_CACHE_INDEX_URL))?.json();
    if (!Array.isArray(listed)) return null;
    const known = new Set(catalog.files.map((entry) => entry.sha256));
    const hashes = new Set();
    for (const sha of listed) if (typeof sha === 'string' && known.has(sha)) hashes.add(sha);
    if (!hashes.size) return null;
    const sample = [...hashes];
    const probes = sample.length > 3 ? [sample[0], sample[sample.length >> 1], sample[sample.length - 1]] : sample;
    for (const sha of probes) if (!(await cache.match(origin + h.assetContentKey(sha)))) return null;
    return hashes;
  } catch { return null; }
}

async function precacheHashes(cache, catalog, h) {
  const origin = self.location.origin;
  let hashes = await indexedHashes(cache, origin, catalog, h);
  if (hashes) return hashes;
  hashes = new Set();
  for (let i = 0; i < catalog.files.length; i += 16) {
    cancelled();
    await Promise.all(catalog.files.slice(i, i + 16).map(async (entry) => {
      if (await cache.match(origin + h.assetContentKey(entry.sha256))) hashes.add(entry.sha256);
    }));
  }
  return hashes;
}

/** Pathnames the title import already verified and stored, or null. Lets the pre-cache reuse them without rewriting. */
async function importedAssetPaths(h) {
  try {
    const cache = await caches.open(h.IMPORTED_ASSET_CACHE);
    const index = await (await cache.match(h.IMPORTED_INDEX_URL))?.json();
    if (Array.isArray(index)) return new Set(index.filter((path) => typeof path === 'string' && path));
    try {
      const paths = new Set();
      for (const request of await cache.keys()) {
        const url = new URL(request.url);
        if (url.pathname !== h.IMPORTED_INDEX_URL && url.pathname !== h.IMPORTED_BORROWED_URL) paths.add(url.pathname);
      }
      return paths;
    } catch { return null; }
  } catch {
    return null;
  }
}

/** Persist the content keys the SW prune may delete without enumerating the whole cache. */
async function writeCacheIndex(cache, hashes, h) {
  try {
    await cache.put(self.location.origin + h.ASSET_CACHE_INDEX_URL,
      new Response(JSON.stringify([...hashes].sort()), { headers: { 'Content-Type': 'application/json' } }));
  } catch { /* the next operation writes a fresh index */ }
}

async function work(message) {
  const h = await helpers;
  if (message.action === 'read-catalog') return readCatalog(message, h);
  const catalog = h.validateAssetCatalog(message.catalog);
  const origin = self.location.origin;
  const cache = await caches.open(h.ASSET_CACHE_NAME);
  const ownHashes = await precacheHashes(cache, catalog, h);
  const imported = await importedAssetPaths(h);
  // Cross-cache readiness is per URL: the imported cache is keyed by the hashed URL, not by SHA. Several catalog
  // entries may name the same bytes (a duplicate or a renamed file), and only the URL that was actually imported
  // should be reported ready until the content key itself exists in the pre-cache.
  const cross = new Set();
  const entriesBySha = new Map();
  for (const entry of catalog.files) {
    const group = entriesBySha.get(entry.sha256);
    if (group) group.push(entry); else entriesBySha.set(entry.sha256, [entry]);
  }
  const bytesOf = (sha) => (entriesBySha.get(sha) || []).reduce((sum, item) => sum + item.bytes, 0);
  const importedReady = (entry) => !!imported
    && (imported.has(entry.url) || (entry.aliases || []).some((alias) => imported.has(alias)));
  const crossBytesOf = (sha) => (entriesBySha.get(sha) || []).filter((entry) => cross.has(entry.url))
    .reduce((sum, item) => sum + item.bytes, 0);
  const crossFilesOf = (sha) => (entriesBySha.get(sha) || []).filter((entry) => cross.has(entry.url)).length;
  let readyFiles = 0, readyBytes = 0;
  for (const entry of catalog.files) {
    if (ownHashes.has(entry.sha256)) { readyFiles++; readyBytes += entry.bytes; }
    else if (importedReady(entry)) { cross.add(entry.url); readyFiles++; readyBytes += entry.bytes; }
  }
  const ready = (entry) => ownHashes.has(entry.sha256) || cross.has(entry.url);
  const report = (extra = {}) => {
    send(message.id, 'progress', { readyFiles, readyBytes, missingFiles: catalog.totalFiles - readyFiles,
      missingBytes: catalog.totalBytes - readyBytes, ...extra });
  };
  const store = async (entry, body) => {
    cancelled();
    if (body.byteLength !== entry.bytes || await h.sha256Hex(body) !== entry.sha256) throw h.assetCacheError('ASSET_CACHE_HASH_MISMATCH');
    cancelled();
    const request = new Request(origin + h.assetContentKey(entry.sha256), { headers: {
      'X-SP-Asset-SHA256': entry.sha256, 'X-SP-Asset-Bytes': String(entry.bytes) } });
    await cache.put(request, new Response(body, { headers: h.validatedCacheHeaders(entry) }));
    // Storing the content key makes every catalog entry with this SHA ready; entries already counted as imported
    // copies under one of its URLs must not be counted a second time.
    readyFiles += (entriesBySha.get(entry.sha256) || []).length - crossFilesOf(entry.sha256);
    readyBytes += bytesOf(entry.sha256) - crossBytesOf(entry.sha256);
    for (const item of entriesBySha.get(entry.sha256) || []) cross.delete(item.url);
    ownHashes.add(entry.sha256);
  };
  report();
  try {
    if (message.action === 'scan') {
      if (message.deep) {
        let checked = 0, invalid = 0;
        const verified = new Set();
        for (const entry of catalog.files) {
          cancelled();
          // Only bytes this cache owns can be re-read. Borrowed title-import bytes were verified at import time.
          if (!ownHashes.has(entry.sha256) || verified.has(entry.sha256)) continue;
          verified.add(entry.sha256);
          const response = await cache.match(origin + h.assetContentKey(entry.sha256));
          let valid = h.isVerifiedAssetResponse(response, entry);
          if (valid) {
            const body = await response.arrayBuffer();
            valid = body.byteLength === entry.bytes && await h.sha256Hex(body) === entry.sha256;
          }
          if (!valid) {
            ownHashes.delete(entry.sha256);
            await cache.delete(origin + h.assetContentKey(entry.sha256));
            readyFiles -= (entriesBySha.get(entry.sha256) || []).length;
            readyBytes -= bytesOf(entry.sha256);
            invalid++;
          }
          checked++;
          if (checked % 20 === 0) report({ scanStats: { checked, invalid } });
        }
        report({ scanStats: { checked, invalid } });
      }
    } else if (message.action === 'download') {
      // Parallel, bounded by what the server is willing to lease this client (server/http/cacheLimiter.js keeps a
      // per-client cap, 2 by default, and answers 429 Retry-After when it is exceeded). A single sequential loop left
      // most of a fast link idle: every file paid a full round trip before the next one started. Small files go first so
      // the ready count (and the player's "can we start" moment) climbs early instead of waiting behind a 10 MB texture.
      let received = 0;
      const started = performance.now();
      const speed = () => Math.round(received * 1000 / Math.max(1, performance.now() - started));
      let lastReport = 0;
      const bump = () => {
        const now = performance.now();
        if (now - lastReport >= 250) { lastReport = now; report({ waiting: false, speedBps: speed() }); }
      };
      const queue = catalog.files.filter((entry) => !ready(entry)).sort((a, b) => a.bytes - b.bytes);
      let limit = Math.max(1, Math.min(6, Number(message.maxParallel) || 2));
      const fetchEntry = async (entry) => {
        let response;
        for (let retry = 0; retry < 6; retry++) {
          cancelled();
          response = await fetch(`/api/asset-cache/file?url=${encodeURIComponent(entry.url)}&hash=${entry.sha256}`, {
            cache: 'no-store', signal: active.abort.signal });
          if (response.status !== 429) break;
          // The server is at its per-client lease: give a slot back and wait out the advertised delay.
          limit = Math.max(1, limit - 1);
          const seconds = Math.max(1, Math.min(30, Number(response.headers.get('retry-after')) || 3));
          report({ waiting: true, speedBps: 0 });
          await sleep(seconds * 1000, active.abort.signal);
        }
        if (response.status === 409) throw h.assetCacheError('ASSET_CACHE_STALE_CATALOG');
        if (response.status === 503) throw h.assetCacheError(await unavailableCode(response));
        if (response.status === 429) throw h.assetCacheError('ASSET_CACHE_BUSY');
        if (response.status !== 200 || Number(response.headers.get('content-length')) !== entry.bytes)
          throw h.assetCacheError('ASSET_CACHE_DOWNLOAD_FAILED');
        const buffer = new Uint8Array(entry.bytes);
        const reader = response.body.getReader();
        let offset = 0;
        try {
          while (true) {
            cancelled();
            const chunk = await reader.read();
            if (chunk.done) break;
            if (offset + chunk.value.length > entry.bytes) throw h.assetCacheError('ASSET_CACHE_FILE_TOO_LARGE');
            buffer.set(chunk.value, offset); offset += chunk.value.length; received += chunk.value.length;
            bump();
          }
        } finally { await reader.cancel().catch(() => {}); }
        if (offset !== entry.bytes) throw h.assetCacheError('ASSET_CACHE_DOWNLOAD_FAILED');
        await store(entry, buffer);
        bump();
      };
      let next = 0, running = 0;
      let failed = null;
      await new Promise((resolve) => {
        const settle = () => { if (failed || (running === 0 && next >= queue.length)) resolve(); };
        const launch = () => {
          if (failed) return;
          while (running < limit && next < queue.length) {
            const entry = queue[next++];
            running++;
            fetchEntry(entry).then(() => { running--; settle(); launch(); },
              (error) => { running--; failed = failed || error; settle(); });
          }
          settle();
        };
        launch();
      });
      if (failed) throw failed;
    } else if (message.action === 'import') {
      if (!(message.file instanceof Blob)) throw h.assetCacheError('ASSET_CACHE_ZIP_INVALID');
      const reader = new zip.ZipReader(new zip.BlobReader(message.file), { useWebWorkers: false, checkSignature: true });
      let entries;
      const expected = new Map(catalog.files.map((entry) => [entry.url.slice(1), entry]));
      const stats = { imported: 0, reused: 0, invalid: 0, unknown: 0, absent: 0 };
      try {
        // Reject unsafe archives before writing any file. Ordinary old/extra asset entries are skipped.
        entries = await archiveEntries(reader, h);
        const candidates = entries.filter((entry) => !entry.directory && entry.filename !== 'manifest.json');
        const importedHashes = new Set();
        // Decompression is local CPU, but the SHA-256 (crypto.subtle) and the Cache write are asynchronous: a small
        // pipeline keeps the next entry decompressing while the previous one is hashed and stored. Sequential handing of
        // an 18 000-file / 646 MB pack leaves most of that idle.
        const IMPORT_PARALLEL = 3;
        const jobs = [];
        for (const entry of candidates) {
          cancelled();
          const target = expected.get(entry.filename);
          if (!target) { stats.unknown++; continue; }
          if (importedHashes.has(target.sha256) || ready(target)) { stats.reused++; continue; }
          if (entry.uncompressedSize !== target.bytes || ![0, 8].includes(entry.compressionMethod)) { stats.invalid++; continue; }
          jobs.push({ entry, target });
        }
        let failed = null, nextJob = 0, running = 0;
        const finish = () => {
          if ((stats.imported + stats.reused + stats.invalid) % 10 === 0) report({ importStats: { ...stats } });
        };
        await new Promise((resolve) => {
          const settle = () => { if (failed || (running === 0 && nextJob >= jobs.length)) resolve(); };
          const launch = () => {
            if (failed) return;
            while (running < IMPORT_PARALLEL && nextJob < jobs.length) {
              const { entry, target } = jobs[nextJob++];
              running++;
              (async () => {
                cancelled();
                const blob = await entry.getData(new LimitedWriter(target.bytes), { useWebWorkers: false, checkSignature: true,
                  signal: active.abort.signal });
                const body = await blob.arrayBuffer();
                cancelled();
                if (body.byteLength !== target.bytes || await h.sha256Hex(body) !== target.sha256) { stats.invalid++; return; }
                if (importedHashes.has(target.sha256)) { stats.reused++; return; }   // another copy landed meanwhile
                await store(target, body); importedHashes.add(target.sha256); stats.imported++;
              })().then(() => { running--; finish(); settle(); launch(); },
                (error) => {
                  running--;
                  if (active.paused || error?.name === 'QuotaExceededError') { failed = failed || error; settle(); return; }
                  stats.invalid++; finish(); settle(); launch();
                });
            }
            settle();
          };
          launch();
        });
        if (failed) throw failed;
        stats.absent = catalog.files.filter((entry) => !ready(entry)).length;
        report({ importStats: stats });
      } catch (error) {
        if (error.code || error.name === 'QuotaExceededError') throw error;
        throw h.assetCacheError('ASSET_CACHE_ZIP_INVALID', error);
      } finally { await reader.close(); }
    } else throw h.assetCacheError('ASSET_CACHE_BAD_MESSAGE');
  } finally {
    // The SW prune reads this instead of Cache.keys(), which cannot list a full pack.
    await writeCacheIndex(cache, ownHashes, h);
  }
  report({ speedBps: 0, waiting: false });
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    function done() { signal.removeEventListener('abort', aborted); resolve(); }
    function aborted() { clearTimeout(timer); signal.removeEventListener('abort', aborted); reject(new DOMException('Paused', 'AbortError')); }
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) aborted();
  });
}

self.onmessage = async ({ data }) => {
  if (data?.type === 'pause') { if (active) { active.paused = true; active.abort.abort(); } return; }
  if (active) { send(data?.id, 'error', { code: 'ASSET_CACHE_BUSY' }); return; }
  active = { id: data.id, paused: false, abort: new AbortController() };
  try { const result = await work(data); send(data.id, 'done', result); }
  catch (error) {
    // Only protocol strings reach the page. A DOMException's numeric legacy code (AbortError 20) used to become an
    // untranslatable error state after a finished import.
    const code = active.paused ? 'ASSET_CACHE_PAUSED' : error.name === 'QuotaExceededError' ? 'ASSET_CACHE_QUOTA'
      : typeof error.code === 'string' && error.code ? error.code : 'ASSET_CACHE_STORAGE_ERROR';
    send(data.id, 'error', { code });
  }
  finally { active = null; }
};
