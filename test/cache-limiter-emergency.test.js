import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { CacheDownloadLimiter } from '../server/http/cacheLimiter.js';

function response({ blocked = true, autoFinish = true } = {}) {
  const res = new EventEmitter();
  res.chunks = []; res.destroyed = false; res.destroyCalls = 0;
  res.write = (chunk) => { res.chunks.push(chunk); return !blocked; };
  res.end = () => { res.writableEnded = true; if (autoFinish) { res.writableFinished = true; res.emit('finish'); } };
  res.destroy = () => { res.destroyCalls++; res.destroyed = true; res.emit('close'); };
  return res;
}

async function pump(limiter) {
  limiter.updatedAt -= 200;
  for (const client of limiter.clients.values()) client.updatedAt -= 200;
  await limiter.pump();
}

test('demand metrics exclude preparation and count shared-IP demand only once', async () => {
  const limiter = new CacheDownloadLimiter({ totalBps: 1_000_000, clientBps: 500_000 });
  try {
    const firstRes = response();
    const a = limiter.acquire('ip-a', firstRes);
    const b = limiter.acquire('ip-a');
    const c = limiter.acquire('ip-b');
    assert.equal(limiter.metrics().activeClients, 2);
    assert.equal(limiter.metrics().preparingDownloads, 3);
    assert.equal(limiter.metrics().expectedBps, 0);
    const body = Buffer.alloc(2_000_000);
    a.streamBuffer(body, firstRes);
    b.streamBuffer(body, response());
    assert.equal(limiter.metrics().demandClients, 1);
    assert.equal(limiter.metrics().expectedBps, 500_000);
    c.streamBuffer(body, response());
    await pump(limiter);
    const metrics = limiter.metrics();
    assert.equal(metrics.activeDownloads, 3);
    assert.equal(metrics.demandClients, 2);
    assert.equal(metrics.demandNetworks, 2);
    assert.equal(metrics.expectedBps, 1_000_000);
    assert.equal(metrics.blockedDownloads, 3);
    assert.equal(metrics.backpressureEvents, 3);
    assert.equal(metrics.streamingDownloads, 3);
    assert.equal(metrics.preparingDownloads, 0);
    assert.equal(metrics.bytesWritten, 3 * 8192);
    assert.equal(metrics.remainingBytes, 6_000_000 - metrics.bytesWritten);
  } finally { limiter.close(); }
});

test('IPv6 addresses keep their individual budgets but one /64 is not independent congestion evidence', () => {
  const limiter = new CacheDownloadLimiter({ totalBps: 1_000_000, clientBps: 1_000_000 });
  try {
    const aRes = response(), bRes = response();
    limiter.acquire('2001:db8::1', aRes, '2001:db8::/64').streamBuffer(Buffer.alloc(1_000_000), aRes);
    limiter.acquire('2001:db8::2', bRes, '2001:db8::/64').streamBuffer(Buffer.alloc(1_000_000), bRes);
    assert.equal(limiter.metrics().demandClients, 2);
    assert.equal(limiter.metrics().demandNetworks, 1);
    assert.equal(limiter.metrics().expectedBps, 1_000_000, 'the existing per-IP byte budget is unchanged');
  } finally { limiter.close(); }
});

test('trip aborts streaming and preparing responses, and resume admits only fresh leases', async () => {
  const limiter = new CacheDownloadLimiter();
  const streamingRes = response();
  const preparingRes = response();
  const running = limiter.acquire('ip-a', streamingRes);
  const preparing = limiter.acquire('ip-b', preparingRes);
  const late = limiter.acquire('ip-c');
  const stream = running.streamBuffer(Buffer.alloc(1_000_000), streamingRes);
  try {
    await pump(limiter);
    assert.equal(limiter.trip('test-emergency'), true);
    assert.equal(limiter.trip('ignored'), false);
    await stream;
    assert.equal(streamingRes.destroyed, true);
    assert.equal(preparingRes.destroyed, true);
    assert.equal(preparing.released, true);
    assert.equal(late.released, true);
    assert.equal(limiter.metrics().activeDownloads, 0);
    assert.equal(limiter.metrics().expectedBps, 0);
    assert.equal(limiter.policy().enabled, false);
    assert.equal(limiter.policy().emergencyReason, 'test-emergency');
    assert.ok(limiter.policy().emergencySince > 0);
    assert.equal(limiter.acquire('new'), null);
    assert.equal(limiter.resume(), true);
    const lateRes = response({ blocked: false });
    await late.streamBuffer(Buffer.from('stale'), lateRes);
    assert.equal(lateRes.destroyed, true, 'aborted preparation cannot come back after resume');
    assert.equal(lateRes.chunks.length, 0);
    const freshRes = response({ blocked: false });
    const fresh = limiter.acquire('fresh', freshRes);
    const complete = fresh.streamBuffer(Buffer.from('fresh'), freshRes);
    await pump(limiter); await complete;
    assert.equal(freshRes.writableFinished, true);
    assert.equal(Buffer.concat(freshRes.chunks).toString(), 'fresh');
    assert.equal(limiter.policy().enabled, true);
    assert.equal(limiter.policy().totalBps, null);
    assert.equal(limiter.policy().clientBps, null);
  } finally { limiter.close(); }
});

test('an emergency during an asynchronous disk read sends no stale bytes after resume', async () => {
  const limiter = new CacheDownloadLimiter();
  let finishRead;
  const pendingRead = new Promise((resolve) => { finishRead = resolve; });
  const res = response();
  const handle = { read: async (_buffer, _offset, length) => { await pendingRead; return { bytesRead: length }; } };
  const lease = limiter.acquire('reader', res);
  const stream = lease.stream(handle, res, 50_000);
  limiter.updatedAt -= 200; limiter.clients.get('reader').updatedAt -= 200;
  const pumping = limiter.pump();
  try {
    limiter.trip(); limiter.resume(); finishRead();
    await pumping; await stream;
    assert.equal(res.destroyed, true);
    assert.equal(res.chunks.length, 0);
    assert.equal(limiter.metrics().bytesWritten, 0);
    assert.equal(limiter.metrics().activeDownloads, 0);
  } finally { finishRead(); limiter.close(); }
});

test('trip cancels a response whose last quantum is queued but has not finished on the socket', async () => {
  const limiter = new CacheDownloadLimiter();
  const res = response({ autoFinish: false });
  const lease = limiter.acquire('last-quantum', res);
  const stream = lease.streamBuffer(Buffer.alloc(100), res);
  try {
    await pump(limiter);
    assert.equal(res.writableEnded, true);
    assert.equal(lease.released, false);
    assert.equal(limiter.metrics().remainingBytes, 0);
    assert.equal(limiter.metrics().expectedBps, 0);
    limiter.trip(); await stream;
    assert.equal(res.destroyed, true);
    assert.equal(limiter.metrics().activeDownloads, 0);
  } finally { limiter.close(); }
});

test('permanent close cannot be resumed and startup disable remains disabled after a retry', () => {
  const limiter = new CacheDownloadLimiter();
  limiter.trip(); limiter.close(); limiter.close();
  assert.equal(limiter.resume(), false);
  assert.equal(limiter.trip(), false);
  assert.equal(limiter.acquire('closed'), null);
  assert.equal(limiter.metrics().activeDownloads, 0);
  const disabled = new CacheDownloadLimiter({ totalBps: 0 });
  try {
    disabled.trip(); disabled.resume();
    assert.equal(disabled.policy().enabled, false);
    assert.equal(disabled.acquire('disabled'), null);
  } finally { disabled.close(); }
});
