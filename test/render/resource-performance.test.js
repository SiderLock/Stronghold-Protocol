import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAssets } from '../../public/js/assets.js';
import { FxLibrary } from '../../public/js/render/vfx/library.js';
import { FxGL, FX_TEXTURE_BYTES } from '../../public/js/render/vfx/gl.js';
import { OfficialFx } from '../../public/js/render/vfx/system.js';
import { pressureResolution } from '../../public/js/render/app/host.js';
import { sanitizeSettings, DEFAULT_SETTINGS } from '../../public/js/ui/gameLogic/settings.js';

const turn = () => new Promise(resolve => setImmediate(resolve));
const gate = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test('decoded-image cache evicts least-recent references by bytes without closing a live image', async () => {
  let closed = 0, loaded = 0;
  const a = createAssets({ manifest: {}, imageCacheBytes: 32, imageCacheMax: 10,
    loadImage: async () => { loaded++; return { width: 2, height: 2, close() { closed++; } }; } });
  const live = await a.image('/a');
  await a.image('/b');
  assert.equal(a.imageNow('/a'), live);
  await a.image('/c');
  assert.equal(a.imageNow('/b'), null, 'b was least recently used');
  assert.equal(a.imageNow('/a'), live);
  assert.equal(a.imageStats().bytes, 32);
  assert.equal(a.imageStats().entries, 2);
  assert.equal(loaded, 3);
  assert.equal(closed, 0, 'cache eviction must not invalidate a renderer holding the image');
  assert.equal(live.width, 2);
  await a.image('/b');
  assert.equal(loaded, 4, 'an evicted image can be loaded again');
});

test('image decoding is bounded, shares pending URLs and drains after failure', async () => {
  const jobs = [];
  let active = 0, peak = 0;
  const a = createAssets({ manifest: {}, imageConcurrency: 2, imageCacheMax: 2, loadImage: url => {
    const g = gate(); jobs.push({ ...g, url }); peak = Math.max(peak, ++active);
    return g.promise.finally(() => active--);
  } });
  const first = a.image('/0');
  assert.equal(a.image('/0'), first);
  const all = [first, ...Array.from({ length: 5 }, (_, i) => a.image(`/${i + 1}`))];
  await turn();
  assert.equal(jobs.length, 2);
  for (let i = 0; i < 6; i++) { jobs[i].resolve(i === 1 ? null : { width: 1, height: 1 }); await turn(); }
  const values = await Promise.all(all);
  assert.equal(values[1], null);
  assert.equal(peak, 2);
  assert.deepEqual(a.imageStats(), { entries: 2, bytes: 8, active: 0, queued: 0 });
});

function library() {
  const lib = new FxLibrary({ list: { groups: { 'fx/prefabs': { p: '/p' }, 'fx/tex': { tex: { path: '/tex' } } } } });
  lib.texInfo = async () => ({});
  return lib;
}

test('context loss rejects old decoded images without overwriting the restored context load', async () => {
  const lib = library(), jobs = [];
  lib._image = () => { const g = gate(); jobs.push(g); return g.promise; };
  const old = lib.loadTexture('tex', false);
  await turn();
  lib.dropImages();
  const fresh = lib.loadTexture('tex', false);
  await turn();
  let oldClosed = 0;
  const current = { width: 4, height: 4 };
  jobs[1].resolve({ image: current, flipped: true });
  assert.equal((await fresh).image, current);
  jobs[0].resolve({ image: { close() { oldClosed++; } }, flipped: true });
  assert.equal(await old, null);
  assert.equal(oldClosed, 1);
  assert.equal(lib.texture('tex', false).image, current);
  lib.destroy();
});

test('retired FX libraries drain queued work without decoding and discard in-flight results', async () => {
  const lib = library(), jobs = [];
  await lib.init();
  for (let i = 0; i < 12; i++) lib.groups['fx/tex'][`t${i}`] = { path: `/t${i}` };
  lib._image = () => { const g = gate(); jobs.push(g); return g.promise; };
  const pending = Array.from({ length: 12 }, (_, i) => lib.loadTexture(`t${i}`, false));
  await turn();
  assert.equal(jobs.length, 8);
  lib.destroy(); lib.destroy();
  let closed = 0;
  for (const g of jobs) g.resolve({ image: { close() { closed++; } }, flipped: true });
  assert.deepEqual(await Promise.all(pending), Array(12).fill(null));
  await turn();
  assert.equal(jobs.length, 8, 'queued decodes never start after teardown');
  assert.equal(closed, 8);
  assert.equal(lib.images.size, 0);
  assert.equal(lib.imageLoads.size, 0);
  assert.equal(lib.active, 0);
  assert.equal(lib.queue.length, 0);
  assert.equal(lib.available, false);
  assert.equal(await lib.loadTexture('tex', false), null);
});

test('FX prewarm attempts each queued texture once, retaining it for a later frame', () => {
  let tries = 0;
  const ctx = { warmQueue: [{ tex: 'slow', tries: 0 }], glr: { texture() { tries++; return null; } }, lite: false };
  OfficialFx.prototype._warmStep.call(ctx);
  assert.equal(tries, 1);
  assert.equal(ctx.warmQueue.length, 1);
  ctx.glr.texture = () => { tries++; return {}; };
  OfficialFx.prototype._warmStep.call(ctx);
  assert.equal(tries, 2);
  assert.equal(ctx.warmQueue.length, 0);
});

test('FX texture pressure evicts old textures, preserves recent ones and enables their reload', () => {
  const deleted = [], forgotten = [];
  const glr = Object.create(FxGL.prototype);
  glr.gl = { deleteTexture(t) { deleted.push(t); } };
  glr.lib = { forgetTexture(id) { forgotten.push(id); } };
  glr.pruneAt = 0;
  glr.frameTime = 19000;
  glr.textures = new Map([
    ['old|0', { tex: 'old', bytes: FX_TEXTURE_BYTES, used: 0 }],
    ['live|0', { tex: 'live', bytes: FX_TEXTURE_BYTES, used: 19000 }],
  ]);
  glr.stats = { texBytes: FX_TEXTURE_BYTES * 2, textures: 2 };
  glr.beginFrame(20000);
  assert.deepEqual(deleted, ['old']);
  assert.deepEqual(forgotten, ['old|0']);
  assert.equal(glr.stats.texBytes, FX_TEXTURE_BYTES);
  assert.equal(glr.texture('live', false), 'live');
  assert.equal(glr.textures.get('live|0').used, 20000);
  glr.stats.texBytes = FX_TEXTURE_BYTES * 2;
  glr.beginFrame(90000);
  assert.equal(glr.textures.has('live|0'), true, 'returning from a hidden tab keeps the current effect resident');
});

test('FX draw reuses texture bindings only within a pass and invalidates them after a lazy upload', () => {
  const binds = [], draws = [];
  let active = -1;
  const gl = new Proxy({ TEXTURE0: 100, activeTexture(u) { active = u; }, bindTexture(_target, tex) { binds.push([active, tex]); },
    drawElementsInstanced() { draws.push(1); } }, { get: (o, k) => k in o ? o[k] : () => {} });
  const rec = { prog: {}, vp: {}, pass: -1 };
  const plan = { tex: [{ unit: 0, key: 'a', loc: {} }], f: [], v: [] };
  const glr = { gl, stats: { draws: 0, tris: 0 }, textureEpoch: 0, program: () => rec, _plan: () => plan, _state() {}, texture: () => 'a' };
  const mat = { state: {} }, items = Array.from({ length: 100 }, (_, i) => ({ kind: 'quad', mat, first: i, count: 1 }));
  const frame = { pass: 1, time: 0, vp: [], cam: [], half: false };
  FxGL.prototype.draw.call(glr, items, frame);
  assert.equal(draws.length, 100, 'draw order and draw count unchanged');
  assert.equal(binds.length, 1, '100 adjacent draws need one binding');
  FxGL.prototype.draw.call(glr, items, frame);
  assert.equal(binds.length, 2, 'a new Pixi pass must rebind');
  let lookups = 0;
  glr.texture = () => { if (++lookups === 2) glr.textureEpoch++; return 'a'; };
  FxGL.prototype.draw.call(glr, items.slice(0, 3), frame);
  assert.equal(binds.length, 4, 'a lazy upload invalidates the cached texture-unit state');
});

test('mobile canvas resolution responds to pressure without exceeding quality or device limits', () => {
  assert.deepEqual([0, 1, 2, 3].map(l => pressureResolution(3, 2, l, true)), [2, 1.5, 1.25, 1]);
  for (const l of [0, 1, 2, 3]) {
    assert.equal(pressureResolution(3, 2, l, false), 2, 'desktop unchanged');
    assert.equal(pressureResolution(1, 2, l, true), 1, 'low-DPR devices not upscaled');
    assert.equal(pressureResolution(3, 1, l, true), 1, 'manual low quality remains capped');
  }
  assert.equal(pressureResolution(3, 2, 0, true), 2, 'recovery restores the chosen quality');
});

test('adaptive-resolution preference persists explicit on/off and migrates old settings', () => {
  assert.equal(sanitizeSettings(null).adaptiveResolution, DEFAULT_SETTINGS.adaptiveResolution);
  assert.equal(sanitizeSettings({ adaptiveResolution: false }).adaptiveResolution, false);
  assert.equal(sanitizeSettings({ adaptiveResolution: true }).adaptiveResolution, true);
  assert.equal(sanitizeSettings(JSON.parse(JSON.stringify(sanitizeSettings({ adaptiveResolution: false })))).adaptiveResolution, false);
});
