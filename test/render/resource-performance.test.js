import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAssets } from '../../public/js/assets.js';
import { FxLibrary } from '../../public/js/render/vfx/library.js';
import { FxGL, FX_TEXTURE_BYTES } from '../../public/js/render/vfx/gl.js';
import { OfficialFx } from '../../public/js/render/vfx/system.js';
import { FrameData } from '../../public/js/render/vfx/geom.js';
import { BLEND } from '../../public/js/render/vfx/materials.js';
import { pressureResolution } from '../../public/js/render/app/host.js';
import { sanitizeSettings, DEFAULT_SETTINGS } from '../../public/js/ui/gameLogic/settings.js';

const turn = () => new Promise(resolve => setImmediate(resolve));
const gate = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test('FX frame counters include actual uploaded bytes and reset after the previous rendered frame', () => {
  const uploads = [];
  const glr = Object.create(FxGL.prototype);
  glr.gl = { bindBuffer() {}, bindVertexArray() {}, bufferData(_target, data) { uploads.push(data.byteLength); } };
  glr.stats = { draws: 4, tris: 16, uploadBytes: 0 };
  glr.beginFrame = () => {};
  const frame = new FrameData();
  frame.quads(2); frame.meshes(1); frame.verts(3); frame.indices(6);
  glr.upload(frame);
  assert.equal(glr.stats.uploadBytes, uploads.reduce((sum, bytes) => sum + bytes, 0));
  assert.equal(glr.stats.uploadBytes, (2 * 27 + 30 + 3 * 12 + 6) * 4);
  frame.reset(); glr.upload(frame);
  assert.equal(uploads.length, 4, 'empty buffers add no upload');
  OfficialFx.prototype.frameStats.call({ glr });
  assert.deepEqual(glr.stats, { draws: 0, tris: 0, uploadBytes: 0, quads: 0, meshes: 0 });
});

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

test('FX descriptors and meshes pass queued images in FIFO order within the shared load limit', async t => {
  const lib = library(), jobs = [], started = [];
  t.mock.method(console, 'warn', () => {});
  await lib.init();
  lib.groups['fx/prefabs'] = { a: { path: '/a' }, b: { path: '/b' } };
  lib.groups['fx/mesh'] = { m: { path: '/m' } };
  for (let i = 0; i < 12; i++) lib.groups['fx/tex'][`t${i}`] = { path: `/t${i}` };
  let peak = 0;
  lib._image = url => {
    peak = Math.max(peak, lib.active);
    started.push(url);
    const job = gate(); jobs.push(job);
    return job.promise;
  };
  lib._json = async url => {
    peak = Math.max(peak, lib.active);
    started.push(url);
    if (url === '/b') throw new Error('expected descriptor failure');
    if (url === '/m') return { positions: [0, 0, 0], indices: [0] };
    return { key: 'a', nodes: [], materials: [], meshes: ['m'], textures: [], refs: [] };
  };
  const images = Array.from({ length: 12 }, (_, i) => lib.loadTexture(`t${i}`, false));
  await turn();
  assert.equal(jobs.length, 8);
  const a = lib.load('a'), duplicate = lib.load('a'), b = lib.load('b'), mesh = lib.loadMesh('m');
  await turn();
  assert.equal(started.length, 8, 'active work finishes before queued work starts');
  jobs[0].resolve(null);
  await turn();
  assert.deepEqual(started.slice(8), ['/a', '/b', '/m', '/t8']);
  const [def, same, missing, data] = await Promise.all([a, duplicate, b, mesh]);
  assert.equal(def, lib.def('a'));
  assert.equal(same, def);
  assert.equal(missing, null);
  assert.ok(lib.failed.has('b'));
  assert.ok(data.positions.length > 0);
  for (let i = 1; i < 12; i++) { jobs[i].resolve(null); await turn(); }
  await Promise.all(images);
  await turn();
  assert.equal(peak, 8);
  assert.deepEqual(started.filter(url => url.startsWith('/t')), Array.from({ length: 12 }, (_, i) => `/t${i}`));
  assert.equal(lib.active, 0);
  assert.equal(lib.queue.length, 0);
  lib.destroy();
});

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
  lib.groups['fx/prefabs'].late = { path: '/late' };
  lib.groups['fx/mesh'] = { late: { path: '/mesh-late' } };
  let jsonLoads = 0;
  lib._json = async () => { jsonLoads++; return {}; };
  const prefab = lib.load('late'), mesh = lib.loadMesh('late');
  await turn();
  lib.destroy(); lib.destroy();
  let closed = 0;
  for (const g of jobs) g.resolve({ image: { close() { closed++; } }, flipped: true });
  assert.deepEqual(await Promise.all(pending), Array(12).fill(null));
  assert.deepEqual(await Promise.all([prefab, mesh]), [null, null]);
  assert.equal(jsonLoads, 0);
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

test('FX draw preserves effective material state while reusing GL calls inside each pass', () => {
  const enabled = new Set(), calls = [], draws = [], gpu = {};
  const gl = new Proxy({
    enable(cap) { calls.push(['enable', cap]); enabled.add(cap); },
    disable(cap) { calls.push(['disable', cap]); enabled.delete(cap); },
    blendFuncSeparate(...values) { calls.push(['blend']); gpu.blend = values; },
    blendEquationSeparate(rgb, alpha) { calls.push(['equation']); gpu.equation = [rgb, alpha]; },
    depthFunc(value) { calls.push(['depthFunc']); gpu.depthFunc = value; },
    depthMask(value) { calls.push(['depthMask']); gpu.write = value; },
    cullFace(value) { calls.push(['cullFace']); gpu.cull = value; },
    colorMask(...values) { calls.push(['colorMask']); gpu.mask = values; },
    drawElementsInstanced() {
      draws.push({ blend: gpu.blend, equation: gpu.equation, write: gpu.write, mask: gpu.mask,
        depth: enabled.has('DEPTH_TEST') ? gpu.depthFunc : null, cull: enabled.has('CULL_FACE') ? gpu.cull : null });
    },
  }, { get: (o, key) => key in o ? o[key] : /^[A-Z_0-9]+$/.test(String(key)) ? key : () => {} });
  const rec = { prog: {}, vp: {}, pass: -1 }, plan = { tex: [], f: [], v: [] };
  const glr = Object.assign(Object.create(FxGL.prototype), { gl, hasDepth: true,
    stats: { draws: 0, tris: 0 }, program: () => rec, _plan: () => plan });
  const state = { src: BLEND.SrcAlpha, dst: BLEND.OneMinusSrcAlpha, op: 'Add', zTest: null, zWrite: false, cull: 'Off', colorMask: 15 };
  const alpha = ['SRC_ALPHA', 'ONE_MINUS_SRC_ALPHA', 'ONE', 'ONE_MINUS_SRC_ALPHA'];
  const multiply = ['ZERO', 'SRC_COLOR', 'ONE', 'ONE_MINUS_SRC_ALPHA'];
  const additive = ['ONE', 'ONE', 'ZERO', 'ONE'];
  const expected = { blend: alpha, equation: ['FUNC_ADD', 'FUNC_ADD'], write: false,
    mask: [true, true, true, true], depth: null, cull: null };
  const cases = [
    { state, family: 'basic', expected },
    { state: { ...state, colorMask: 14 }, family: 'basic', expected },
    { state, family: 'basic', expected },
    { state, family: 'multiply', expected: { ...expected, blend: multiply } },
    { state: { ...state, src: BLEND.DstColor }, family: 'basic', expected: { ...expected, blend: multiply } },
    { state: { ...state, src: BLEND.One, dst: BLEND.One, zTest: 'less', cull: 'Back', colorMask: 13 },
      family: 'basic', expected: { ...expected, blend: additive, depth: 'LESS', cull: 'BACK', mask: [true, true, false, true] } },
    { state: { ...state, zTest: 'less', zWrite: true, cull: 'Front', op: 'RevSub' },
      family: 'basic', expected: { ...expected, depth: 'LESS', write: true, cull: 'FRONT', equation: ['FUNC_REVERSE_SUBTRACT', 'FUNC_ADD'] } },
    { state: { ...state, zWrite: true, colorMask: 0 }, family: 'basic',
      expected: { ...expected, mask: [false, false, false, true] } },
    { state: { ...state, zTest: 'less' }, family: 'basic', expected: { ...expected, depth: 'LESS' } },
  ];
  const items = cases.map((row, i) => ({ kind: 'quad', mat: { state: row.state, family: row.family }, first: i, count: 1 }));
  const frame = { pass: 1, time: 0, vp: [], cam: [], half: false };
  glr.draw(items, frame);
  assert.deepEqual(draws, cases.map(row => row.expected));
  assert.equal(calls.filter(([name]) => name === 'blend').length, 4);
  assert.equal(calls.filter(([name]) => name === 'depthFunc').length, 1, 'depth function survives disable / enable');
  assert.equal(calls.filter(([name, cap]) => name === 'enable' && cap === 'CULL_FACE').length, 1, 'changing cull direction keeps culling enabled');
  assert.equal(enabled.has('DEPTH_TEST'), false);
  assert.equal(enabled.has('CULL_FACE'), false);
  assert.equal(gpu.write, true);
  assert.deepEqual(gpu.mask, [true, true, true, true]);
  // Pixi may change every state between passes, so the first material must establish all of them again.
  gpu.blend = ['foreign']; gpu.depthFunc = 'GREATER'; gpu.mask = [false, false, false, false];
  enabled.add('DEPTH_TEST'); enabled.add('CULL_FACE');
  glr.draw(items.slice(0, 1), { ...frame, pass: 2 });
  assert.deepEqual(draws.at(-1), expected);
  glr.hasDepth = false;
  glr.draw([items.at(-1)], { ...frame, pass: 3 });
  assert.deepEqual(draws.at(-1), expected, 'a context without depth remains depth-disabled');
});

test('FX uniforms retain material, animated-array and program changes while sharing equivalent values', () => {
  const values = new Map(), calls = [], draws = [];
  let program;
  const animated = [9, 8, 7, 6];
  const gl = new Proxy({
    TEXTURE0: 100,
    useProgram(value) { program = value; },
    uniform1i(loc, value) { calls.push(['sampler', loc]); values.set(loc, value); },
    uniform1f(loc, value) { calls.push(['float', loc]); values.set(loc, value); },
    uniform4f(loc, ...value) { calls.push(['vector', loc]); values.set(loc, value); },
    drawElementsInstanced() {
      draws.push({ program, float: values.get(program + 'F'), vector: values.get(program + 'V'), sampler: values.get(program + 'I') });
      if (draws.length === 3) animated[0] = 11;
    },
  }, { get: (o, key) => key in o ? o[key] : /^[A-Z_0-9]+$/.test(String(key)) ? key : () => {} });
  const records = Object.fromEntries(['A', 'B'].map(key => [key, { prog: key, vp: {}, pass: -1, plans: new WeakMap(), uniforms: [
    { name: '_Opacity', type: 'FLOAT', unit: -1, loc: key + 'F' },
    { name: '_Color', type: 'FLOAT_VEC4', unit: -1, loc: key + 'V' },
    { name: '_MainTex', type: 'SAMPLER_2D', unit: 0, loc: key + 'I' },
  ] }]));
  const material = key => ({ key, family: 'basic', state: {}, floats: { _Opacity: 1 }, vecs: { _Color: [1, 2, 3, 4] },
    textures: [{ name: '_MainTex', key: 'tex', def: 'white' }] });
  const a = material('A'), other = material('A'), b = material('B');
  const rows = [
    { mat: a }, { mat: other },
    { mat: a, ov: { _Opacity: 0.5, _Color: animated } },
    { mat: a, ov: { _Opacity: 0.5, _Color: animated } },
    { mat: a }, { mat: b }, { mat: a },
    { mat: a, ov: { _Opacity: -0 } }, { mat: a, ov: { _Opacity: 0 } },
  ];
  const items = rows.map((row, i) => ({ ...row, kind: 'quad', first: i, count: 1 }));
  const glr = Object.assign(Object.create(FxGL.prototype), { gl, defaults: { white: 'tex' }, texture: () => 'tex',
    stats: { draws: 0, tris: 0 }, program: (_kind, mat) => records[mat.key], _state() {} });
  const frame = { pass: 1, time: 0, vp: [], cam: [], half: false };
  glr.draw(items, frame);
  const expected = { program: 'A', float: 1, vector: [1, 2, 3, 4], sampler: 0 };
  assert.deepEqual(draws, [expected, expected,
    { ...expected, float: 0.5, vector: [9, 8, 7, 6] },
    { ...expected, float: 0.5, vector: [11, 8, 7, 6] },
    expected, { ...expected, program: 'B' }, expected,
    { ...expected, float: -0 }, { ...expected, float: 0 }]);
  assert.equal(calls.filter(([kind]) => kind === 'sampler').length, 2, 'sampler units are established per program');
  assert.equal(calls.filter(([kind]) => kind === 'float').length, 6);
  assert.equal(calls.filter(([kind]) => kind === 'vector').length, 5);
  values.set('AF', -1); values.set('AV', [-1, -1, -1, -1]); values.set('AI', 5);
  calls.length = 0;
  glr.draw(items.slice(0, 1), { ...frame, pass: 2 });
  assert.deepEqual(draws.at(-1), expected);
  assert.deepEqual(calls.map(([kind]) => kind), ['sampler', 'float', 'vector'], 'another pass re-establishes every uniform');
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
