// RENDER_E2E=1 CHROME_PATH=<Edge> node --test test/render/scene-preparation.browser.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const chrome = process.env.CHROME_PATH;
const enabled = process.env.RENDER_E2E === '1' && chrome && existsSync(chrome) && existsSync('data/local-assets.json');

test('scene worker, bounded GPU resources and image decode fallback in Edge', { skip: enabled ? false : 'needs RENDER_E2E, CHROME_PATH and extracted scenes', timeout: 180000 }, async () => {
  const { default: puppeteer } = await import('puppeteer-core');
  const { startServer } = await import('../../server/index.js');
  const { gpuArgs } = await import('../../tools/perfbench.mjs');
  const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true });
  let browser;
  try {
    browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: gpuArgs() });
    const page = await browser.newPage();
    const errors = [];
    page.on('console', (m) => { if (m.type() === 'warn') console.log(m.text()); });
    page.on('pageerror', (e) => errors.push(e.message));
    await page.setViewport({ width: 1280, height: 720 });
    // An empty same-origin 404 document: no game mount, and no request interception inherited by module workers.
    await page.goto(`http://127.0.0.1:${srv.port}/__scene_test_blank__`);
    const cdp = await page.createCDPSession();
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    const result = await page.evaluate(async () => {
      const { parseSceneChunks, sceneGroupRects, loadScenePack, loadBoardPack } = await import('/js/render/board3d/load.js');
      const { prepareSceneBuckets, sceneBuckets, sceneGeometryKey } = await import('/js/render/board3d/sceneGeometry.js');
      const { prepareSceneInWorker, resetSceneWorker } = await import('/js/render/board3d/sceneWorkerClient.js');
      const { AREAS } = await import('/js/render/board3d/layout.js');
      const { BoardScene } = await import('/js/render/board3d/scene.js');
      const { presetCamera } = await import('/js/render/projection.js');
      const { assets } = await import('/js/assets.js');
      const { FxLibrary } = await import('/js/render/vfx/library.js');
      const THREE = await import('/vendor/three.module.js');
      const mf = await (await fetch('/data/local-assets.json')).json();
      const files = mf.groups['scene/act2autochess_m01'];
      const [doc, initialBuffer] = await Promise.all([fetch(files.scene.path).then((r) => r.json()), fetch(files.bin.path).then(async (r) => {
        if (!r.ok) throw new Error(`scene binary HTTP ${r.status}: ${files.bin.path}`);
        const buf = await r.arrayBuffer();
        if (!buf.byteLength) {
          const retry = await fetch(files.bin.path, { headers: { Range: `bytes=0-${files.bin.bytes - 1}` }, cache: 'no-cache' });
          const again = await retry.arrayBuffer();
          if (again.byteLength) return again;
          throw new Error(`empty scene binary: ${JSON.stringify([...r.headers])}, ${files.bin.path}`);
        }
        return buf;
      })]);
      let buffer = initialBuffer;
      const chunks = parseSceneChunks(doc, buffer), pack = { doc, chunks, groups: sceneGroupRects(chunks) };
      const baseline = [], dispatch = [], workerWall = [], cached = [];
      let output;
      for (let i = 0; i < 8; i++) {
        let at = performance.now(); prepareSceneBuckets(pack, AREAS.normal); baseline.push(performance.now() - at);
        at = performance.now(); const job = prepareSceneInWorker(doc, buffer, AREAS.normal); dispatch.push(performance.now() - at);
        output = await job; workerWall.push(performance.now() - at);
        if (output) { pack.chunks = output.chunks; buffer = output.chunks[0].position.buffer; }
      }
      if (!output?.prepared) throw new Error(`real scene worker failed: ${typeof Worker}, ${buffer.byteLength} bytes, ${chunks?.length} chunks, ${workerWall}`);
      const expected = prepareSceneBuckets(pack, AREAS.normal);
      for (let i = 0; i < expected.length; i++) {
        const a = expected[i], b = output.prepared.buckets[i];
        if (a.key !== b.key) throw new Error('material bucket mismatch');
        for (const name of ['position', 'normal', 'uv', 'uv1', 'color', 'index']) {
          if (a.chunk[name].length !== b.chunk[name].length || !a.chunk[name].every((v, j) => v === b.chunk[name][j])) throw new Error(`worker geometry mismatch: ${name}`);
        }
      }
      if (buffer.byteLength !== doc.binBytes) throw new Error('worker did not return the full buffer');
      const preparedPack = { ...pack, ...output };
      for (let i = 0; i < 8; i++) {
        const at = performance.now(); sceneBuckets(preparedPack, AREAS.normal); cached.push(performance.now() - at);
      }
      // A worker realm must install its own legacy-browser polyfills.
      const bootstrap = URL.createObjectURL(new Blob([`delete Object.hasOwn; delete globalThis.structuredClone; await import(${JSON.stringify(new URL('/js/render/board3d/sceneWorker.js', location.href).href)}); self.postMessage({ ready: true });`], { type: 'text/javascript' }));
      const legacy = new Worker(bootstrap, { type: 'module' });
      try {
        const reply = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('legacy worker timeout')), 5000);
          legacy.onmessage = ({ data }) => {
            if (data.ready) { legacy.postMessage({ id: 1, doc, buffer, areas: AREAS.normal }); return; }
            clearTimeout(timer); resolve(data);
          };
          legacy.onerror = (e) => { clearTimeout(timer); reject(new Error(e.message)); };
        });
        if (!reply.value?.prepared || reply.value.prepared.key !== sceneGeometryKey(pack, AREAS.normal)) throw new Error('legacy worker fallback failed');
      } finally { legacy.terminate(); URL.revokeObjectURL(bootstrap); }
      const imageURL = Object.values((await (await fetch('/data/local-fx.json')).json()).groups['fx/tex'])[0].path;
      const bitmap = globalThis.createImageBitmap;
      let decoded;
      try {
        globalThis.createImageBitmap = async () => { throw new TypeError('unsupported bitmap options'); };
        decoded = await new FxLibrary()._image(imageURL);
      } finally { globalThis.createImageBitmap = bitmap; }
      if (!decoded?.image?.naturalWidth || decoded.flipped) throw new Error('HTML image decode fallback failed');
      await assets.local();
      const base = await loadBoardPack(assets), stages = await (await fetch('/data/stages.json')).json();
      const board = new BoardScene(THREE, base);
      document.body.appendChild(board.renderer.domElement);
      board.resize(1280, 720, 1);
      const memory = [];
      try {
        for (const id of ['act2autochess_m01', 'act2autochess_m02', 'act2autochess_m03', 'act2autochess_m04']) {
          const scene = await loadScenePack(assets, id, { areas: AREAS.normal });
          if (!scene) throw new Error(`scene missing: ${id}`);
          board.setScenePack(id, scene); board.setStage(stages[id]);
          board.render(presetCamera('normal', { width: 1280, height: 720 }), 1);
          memory.push({ id, scenes: board.sceneRes.size, cpuPacks: board.scenePacks.size, textures: board.renderer.info.memory.textures, geometries: board.renderer.info.memory.geometries });
          if (board.sceneRes.size !== 1 || board.scenePacks.size > 2) throw new Error('scene resources are unbounded');
        }
      } finally { board.destroy(); resetSceneWorker(); }
      const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
      return { bufferBytes: buffer.byteLength, baselineMainMs: median(baseline), workerDispatchMainMs: median(dispatch), workerWallMs: median(workerWall), cachedMainMs: median(cached), firstWorkerWallMs: workerWall[0], memory, imageWidth: decoded.image.naturalWidth };
    });
    assert.deepEqual(errors, []);
    assert.equal(result.memory.length, 4);
    mkdirSync('.cache/perf-20261022-scene', { recursive: true });
    writeFileSync(path.join('.cache/perf-20261022-scene', 'report.json'), JSON.stringify({ browser: await browser.version(), cpuSlowdown: 4, viewport: '1280x720', ...result }, null, 2));
    console.log(JSON.stringify(result));
  } finally { await browser?.close(); await srv.close(); }
});
