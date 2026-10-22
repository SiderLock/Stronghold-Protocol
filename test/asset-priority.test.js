import test from 'node:test';
import assert from 'node:assert/strict';
import { createAssetPreloader } from '../public/js/assetPriority.js';
import { currentAssetPlan, visualAssetURLs, backgroundFillAllowed } from '../public/js/assetPlan.js';
import { renderAssetKey } from '../shared/assetCache.js';
import { sanitizeSettings } from '../public/js/ui/gameLogic/settings.js';

const wait = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));
function fixture() {
  const demand = { active: 0, subscribe(fn) { this.fn = fn; return () => {}; }, set(n) { this.active = n; this.fn(n); } };
  const events = [], jobs = [];
  const loader = createAssetPreloader({ demand, delay: 5, load: (url, options) => new Promise((resolve, reject) => {
    const job = { url, options, resolve, reject }; jobs.push(job); events.push(url);
    options.signal?.addEventListener('abort', () => { events.push(`abort:${url}`); reject(new Error('aborted')); }, { once: true });
  }) });
  return { loader, demand, events, jobs };
}

test('actual renderer demand finishes before own prefetch; optional transfer yields to a newly bought skin', async () => {
  const f = fixture(), remaining = ['other-1', 'other-2'];
  try {
    f.demand.set(1);
    f.loader.update({ required: ['own-skin', 'own-map'], remaining, allow: true });
    await wait(); assert.deepEqual(f.events, []);
    f.demand.set(0); await wait();
    assert.deepEqual(f.events, ['own-skin', 'own-map']);
    f.jobs[0].resolve(); await wait(); assert.equal(f.events.length, 2);
    f.jobs[1].resolve(); await wait(); assert.equal(f.events[2], 'other-1');
    f.loader.update({ required: ['own-skin', 'new-skin'], remaining, allow: true });
    await wait();
    assert.ok(f.events.indexOf('abort:other-1') < f.events.indexOf('new-skin'));
    assert.equal(f.events.filter((x) => x === 'own-skin').length, 1, 'already completed own content is reused');
    f.jobs.find((j) => j.url === 'new-skin').resolve();
  } finally { f.loader.destroy(); }
});

test('state updates do not restart the remaining queue or starve it; disable aborts optional work', async () => {
  const f = fixture(), remaining = ['a', 'b'];
  try {
    f.loader.update({ remaining, allow: true }); await wait();
    assert.deepEqual(f.events, ['a']);
    f.jobs[0].resolve();
    for (let i = 0; i < 5; i++) { f.loader.update({ remaining, allow: true }); await wait(5); }
    assert.deepEqual(f.events, ['a', 'b']);
    f.loader.update({ allow: false }); await wait();
    assert.ok(f.events.includes('abort:b'));
  } finally { f.loader.destroy(); }
});

test('cache consent is explicit and immutable cache keys cannot alias scripts, old versions or private data', () => {
  for (const policy of [null, {}, { enabled: false, totalBps: null, clientBps: null },
    { enabled: true, totalBps: 1000000, clientBps: null }, { enabled: true, totalBps: null, clientBps: 1000 }]) assert.equal(backgroundFillAllowed(policy), false);
  assert.equal(backgroundFillAllowed({ enabled: true, totalBps: null, clientBps: null }), true);
  for (const raw of [undefined, {}, { renderCache: 'true' }, { renderCache: 1 }]) assert.equal(sanitizeSettings(raw).renderCache, false);
  assert.equal(sanitizeSettings({ renderCache: true }).renderCache, true);
  const origin = 'https://game.test', key = '/assets/~0123456789abcdef/body.skel';
  assert.equal(renderAssetKey(key, origin), origin + key);
  for (const url of ['/assets/body.skel', '/api/private.json', '/assets/~0123456789abcdef/code.js',
    '/assets/~0123456789abcdef/voice.mp3', key + '?v=2', 'https://other.test' + key]) assert.equal(renderAssetKey(url, origin), null);
});

test('data saver pauses optional files, keeps current files usable, and resumes after a connection change', async () => {
  const connection = Object.assign(new EventTarget(), { saveData: true });
  const environment = { setTimeout, clearTimeout, document: Object.assign(new EventTarget(), { hidden: false }), navigator: { onLine: true, connection } };
  const seen = [];
  const loader = createAssetPreloader({ environment, delay: 5, load: async (url) => { seen.push(url); } });
  try {
    loader.update({ required: ['own'], remaining: ['other'], allow: true });
    await wait(); assert.deepEqual(seen, ['own']);
    connection.saveData = false; connection.dispatchEvent(new Event('change'));
    await wait(); assert.deepEqual(seen, ['own', 'other']);
  } finally { loader.destroy(); }
});

test('own skin, map and actual enemyKey enter the current plan; other players and audio stay in the background', () => {
  const local = { groups: { 'scene/map1': { bin: { path: '/assets/map.bin' } } } };
  const assets = {
    picture: (id, opts) => `/assets/${opts?.skin || id}.png`,
    spineEntry: (id, opts) => ({ skel: `/assets/${opts?.skin || id}-${opts.back ? 'back' : 'front'}.skel`, textures: ['/assets/page.webp'] }),
    skillIcon: () => null, itemIcon: (id) => `/assets/${id}.png`,
  };
  const result = currentAssetPlan({ pub: { stageId: 'map1' }, priv: { board: [{ id: 'chess-1', skin: 'chosen-skin' }],
    nextEnemies: [{ enemyKey: 'wave-key' }] }, assets, local,
  chess: () => ({ charId: 'own' }), token: () => null, enemy: () => ({ enemyId: 'actual-enemy' }) });
  assert.ok(result.includes('/assets/chosen-skin-front.skel'));
  assert.ok(result.includes('/assets/chosen-skin-back.skel'));
  assert.ok(result.includes('/assets/map.bin'));
  assert.ok(result.includes('/assets/actual-enemy-front.skel'));
  assert.ok(result.indexOf('/assets/chosen-skin-front.skel') < result.indexOf('/assets/actual-enemy-front.skel'));
  const mf = { chars: { own: { image: '/assets/own.png' } }, audio: { sfx: '/assets/sound.mp3', bogus: '/assets/audio.json' } };
  mf.self = mf;
  assert.deepEqual(visualAssetURLs(mf), ['/assets/own.png']);
});
