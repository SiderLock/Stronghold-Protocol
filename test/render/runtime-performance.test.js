import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installCompat } from '../../public/js/ui/compat.js';
import { FxLibrary } from '../../public/js/render/vfx/library.js';
import { parseSceneChunks, sceneGroupRects, mergeSceneChunks, sceneMaterialKey } from '../../public/js/render/board3d/load.js';
import { sceneBuckets, sceneGroupVisible } from '../../public/js/render/board3d/sceneGeometry.js';
import { prepareSceneInWorker, resetSceneWorker } from '../../public/js/render/board3d/sceneWorkerClient.js';
import { AREAS } from '../../public/js/render/board3d/layout.js';

test('older-browser clone preserves DataViews, offsets, cycles and shared typed-array buffers', () => {
  const g = {};
  installCompat(g);
  const buffer = new ArrayBuffer(32), view = new DataView(buffer, 8, 12), bytes = new Uint8Array(buffer, 4, 20);
  view.setFloat32(0, 123.5);
  const input = { buffer, view, bytes }; input.self = input;
  const copy = g.structuredClone(input);
  assert.equal(copy.self, copy);
  assert.notEqual(copy.buffer, buffer);
  assert.equal(copy.view.buffer, copy.buffer);
  assert.equal(copy.bytes.buffer, copy.buffer);
  assert.equal(copy.view.byteOffset, 8);
  assert.equal(copy.view.byteLength, 12);
  assert.equal(copy.bytes.byteOffset, 4);
  assert.equal(copy.bytes.length, 20);
  assert.equal(copy.view.getFloat32(0), 123.5);
  copy.bytes[4] = 0;
  assert.notDeepEqual(copy.bytes, bytes);
});

test('ImageBitmap decode rejection falls back through the same blob, with cleanup on success and failure', async (t) => {
  const oldBitmap = globalThis.createImageBitmap;
  globalThis.createImageBitmap = async () => { throw new TypeError('unsupported options'); };
  let requests = 0, revoked = 0, broken = false;
  const blob = new Blob(['png']);
  t.mock.method(URL, 'createObjectURL', (b) => { assert.equal(b, blob); return 'blob:fx'; });
  t.mock.method(URL, 'revokeObjectURL', (u) => { assert.equal(u, 'blob:fx'); revoked++; });
  const oldImage = globalThis.Image;
  globalThis.Image = class {
    set src(u) { assert.equal(u, 'blob:fx'); queueMicrotask(() => broken ? this.onerror() : this.onload()); }
  };
  try {
    const lib = new FxLibrary({ fetch: async () => { requests++; return { ok: true, blob: async () => blob }; } });
    const image = await lib._image('/effect.png');
    assert.equal(image.flipped, false, 'HTML images use the existing GL upload flip');
    assert.equal(requests, 1, 'no second network request');
    assert.equal(revoked, 1);
    broken = true;
    await assert.rejects(lib._image('/effect.png'), /fx image/);
    assert.equal(revoked, 2);
  } finally {
    if (oldBitmap === undefined) delete globalThis.createImageBitmap; else globalThis.createImageBitmap = oldBitmap;
    if (oldImage === undefined) delete globalThis.Image; else globalThis.Image = oldImage;
  }
});

test('scene worker absence, CSP/startup failure and post-transfer timeout use bounded fallback', async (t) => {
  const old = globalThis.Worker;
  const buffer = new ArrayBuffer(8);
  try {
    delete globalThis.Worker;
    assert.equal(await prepareSceneInWorker({}, buffer, []), null);
    globalThis.Worker = class { constructor() { throw new Error('CSP'); } };
    assert.equal(await prepareSceneInWorker({}, buffer, []), null);
    assert.equal(buffer.byteLength, 8, 'startup failure does not transfer ownership');
    resetSceneWorker();
    let stopped = 0;
    globalThis.Worker = class {
      postMessage(message, transfer) { structuredClone(message, { transfer }); }
      terminate() { stopped++; }
    };
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const job = prepareSceneInWorker({}, buffer, []);
    t.mock.timers.tick(5001);
    assert.equal(await job, null);
    assert.equal(stopped, 1);
    assert.equal(buffer.byteLength, 0, 'a post-transfer failure requires the loader recovery fetch');
  } finally { resetSceneWorker(); if (old === undefined) delete globalThis.Worker; else globalThis.Worker = old; }
});

test('cached scene geometry matches legacy visible material/lightmap buckets and reuses arrays across rebuilds', (t) => {
  const manifestUrl = new URL('../../data/local-assets.json', import.meta.url);
  let groups;
  try { groups = JSON.parse(readFileSync(manifestUrl)).groups; } catch { t.skip('optional extracted art is absent'); return; }
  let checked = 0;
  for (const [name, files] of Object.entries(groups)) {
    if (!name.startsWith('scene/') || !files.scene || !files.bin) continue;
    checked++;
    const root = new URL('../../public/', import.meta.url);
    const doc = JSON.parse(readFileSync(new URL(files.scene.path.slice(1), root)));
    const bytes = readFileSync(new URL(files.bin.path.slice(1), root));
    const chunks = parseSceneChunks(doc, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    const pack = { doc, chunks, groups: sceneGroupRects(chunks) };
    for (const areas of Object.values(AREAS)) {
      const expected = new Map();
      for (const c of chunks) {
        if (c.group && !sceneGroupVisible(pack.groups[c.group], areas)) continue;
        const key = sceneMaterialKey(c, doc.materials[c.material]);
        if (!expected.has(key)) expected.set(key, []);
        expected.get(key).push(c);
      }
      const actual = sceneBuckets(pack, areas);
      assert.equal(actual.length, expected.size, name);
      for (const b of actual) assert.deepEqual(b.chunk, mergeSceneChunks(expected.get(b.key)), name);
      assert.equal(sceneBuckets(pack, areas), actual, 'same visibility reuses merged arrays');
    }
  }
  if (!checked) t.skip('no extracted scenes');
});
