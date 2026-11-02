import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { CacheDownloadLimiter } from '../server/http/cacheLimiter.js';

function response(blocked = false) {
  const res = new EventEmitter(); res.chunks = [];
  res.write = chunk => { res.chunks.push(Buffer.from(chunk)); return !blocked; };
  res.end = () => { res.writableFinished = true; res.emit('finish'); };
  res.destroy = () => { res.destroyed = true; res.emit('close'); };
  return res;
}
const flush = () => new Promise(resolve => setImmediate(resolve));

test('one unresolved disk read cannot block another client or another file from the same client', async () => {
  const limiter = new CacheDownloadLimiter();
  let finishRead;
  const read = new Promise(resolve => { finishRead = resolve; });
  const slow = response(), same = response(), other = response();
  const a = limiter.acquire('a', slow), b = limiter.acquire('a', same), c = limiter.acquire('b', other);
  const pending = a.stream({ read: async () => { await read; return { bytesRead: 10 }; } }, slow, 10);
  b.streamBuffer(Buffer.from('same'), same); c.streamBuffer(Buffer.from('other'), other);
  const pumping = limiter.pump();
  try {
    await flush();
    assert.equal(same.writableFinished, true, 'a healthy file must finish while its sibling disk read is still pending');
    assert.equal(other.writableFinished, true, 'a different client must finish without waiting for that read');
    a.release(); await pending;
    const fresh = response(); limiter.acquire('c', fresh).streamBuffer(Buffer.from('fresh'), fresh);
    await limiter.pump(); await flush();
    assert.equal(fresh.writableFinished, true, 'closing the slow request also cannot leave the global pump locked');
  } finally { finishRead(); await pumping; limiter.close(); }
});

test('stalled preparation, reads, backpressure and final flushing release their slots; late reads send nothing', async () => {
  const limiter = new CacheDownloadLimiter({ stallTimeoutMs: 50 });
  let finishRead; const pending = new Promise(resolve => { finishRead = resolve; });
  const prep = response(), reading = response(), blocked = response(true), ending = response();
  ending.end = () => { ending.writableEnded = true; };
  const a = limiter.acquire('prep', prep), b = limiter.acquire('reading', reading),
    c = limiter.acquire('blocked', blocked), d = limiter.acquire('ending', ending);
  b.stream({ read: async () => { await pending; return { bytesRead: 10 }; } }, reading, 10);
  c.streamBuffer(Buffer.alloc(100000), blocked); d.streamBuffer(Buffer.alloc(1), ending);
  const pumping = limiter.pump();
  try {
    await flush();
    for (const client of limiter.clients.values()) for (const job of client.jobs) job.progressAt -= 51;
    await limiter.pump();
    for (const res of [prep, reading, blocked, ending]) assert.equal(res.destroyed, true);
    assert.equal(limiter.policy().activeDownloads, 0);
    assert.equal(a.released, true);
    finishRead(); await flush();
    assert.equal(reading.chunks.length, 0);
    const fresh = response(); limiter.acquire('reading', fresh).streamBuffer(Buffer.from('ok'), fresh);
    await limiter.pump(); assert.equal(fresh.writableFinished, true);
  } finally { finishRead(); await pumping; limiter.close(); }
});
