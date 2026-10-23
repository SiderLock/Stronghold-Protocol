import test from 'node:test';
import assert from 'node:assert/strict';
import { createAssetTransfer, releaseAssetReader } from '../shared/assetCache.js';

test('inactivity rejects even an IO promise that ignores abort, then frees the timer', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const transfer = createAssetTransfer();
  const result = transfer.wait(new Promise(() => {}));
  const rejected = assert.rejects(result, { code: 'ASSET_CACHE_DOWNLOAD_FAILED' });
  t.mock.timers.tick(60000); await rejected;
  assert.equal(transfer.signal.aborted, true); transfer.close();
});

test('slow progressing transfers reset the deadline, while cancellation and cleanup remove it', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const parent = new AbortController();
  const transfer = createAssetTransfer({ signal: parent.signal });
  for (let i = 0; i < 4; i++) { t.mock.timers.tick(40000); transfer.progress(); }
  assert.equal(await transfer.wait(Promise.resolve('bytes')), 'bytes');
  assert.equal(transfer.signal.aborted, false);
  const rejected = assert.rejects(transfer.wait(new Promise(() => {})), { name: 'AbortError' });
  parent.abort(); await rejected;
  transfer.close(); t.mock.timers.tick(100000);
});

test('already aborted requests cannot await a stuck body, and reader cancellation never holds cleanup', async () => {
  const parent = new AbortController(); parent.abort();
  const transfer = createAssetTransfer({ signal: parent.signal });
  await assert.rejects(transfer.wait(new Promise(() => {})), { name: 'AbortError' }); transfer.close();
  let released = 0;
  releaseAssetReader({ cancel: () => new Promise(() => {}), releaseLock: () => { released++; } });
  releaseAssetReader({ cancel() { throw new Error('closed'); }, releaseLock() { throw new Error('locked'); } });
  assert.equal(released, 1);
});
