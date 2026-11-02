import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gpuProfile, gpuDefaults } from '../../public/js/ui/glInfo.js';

/** A fake global whose canvas reports the given WebGL API surface. */
function fakeEnv({ webgl2 = false, webgl = false, renderer = '' } = {}) {
  const lose = { lost: false, loseContext() { this.lost = true; } };
  const surface = () => ({
    RENDERER: 0x1F01,
    getExtension(name) {
      if (name === 'WEBGL_debug_renderer_info') return { UNMASKED_RENDERER_WEBGL: 0x9246 };
      if (name === 'WEBGL_lose_context') return lose;
      return null;
    },
    getParameter(p) { return p === 0x9246 || p === 0x1F01 ? renderer : null; },
  });
  const gl2 = webgl2 ? surface() : null;
  const gl1 = webgl ? surface() : null;
  const canvas = {
    getContext(kind) {
      if (kind === 'webgl2') return gl2;
      if (kind === 'webgl' || kind === 'experimental-webgl') return gl1;
      return null;
    },
  };
  return { document: { createElement: () => canvas }, __lose: lose };
}

test('no canvas at all = could not ask: webgl 0 but NOT downgraded', () => {
  const p = gpuProfile({ document: { createElement: () => null } });
  assert.deepEqual({ webgl: p.webgl, software: p.software, probed: p.probed }, { webgl: 0, software: false, probed: false });
  assert.deepEqual(gpuDefaults(p), {}, 'a Node/test harness is never "no WebGL"');
});

test('a canvas with no WebGL context = no WebGL, and the first run starts on the light tier', () => {
  const p = gpuProfile(fakeEnv());
  assert.equal(p.webgl, 0);
  assert.equal(p.probed, true);
  assert.deepEqual(gpuDefaults(p), { quality: 'low', officialFx: 'off' });
});

test('WebGL2 is detected, and a software rasteriser is recognised by its renderer name', () => {
  const hw = fakeEnv({ webgl2: true, renderer: 'ANGLE (NVIDIA GeForce GTX 1060 Direct3D11)' });
  const hwP = gpuProfile(hw);
  assert.equal(hwP.webgl, 2);
  assert.equal(hwP.software, false);
  assert.deepEqual(gpuDefaults(hwP), {}, 'a real GPU keeps the default tier');

  const sw = fakeEnv({ webgl: true, renderer: 'Google SwiftShader' });
  const swP = gpuProfile(sw);
  assert.equal(swP.webgl, 1);
  assert.equal(swP.software, true);
  assert.deepEqual(gpuDefaults(swP), { quality: 'low', officialFx: 'off' }, 'SwiftShader gets the light tier');
  assert.equal(sw.__lose.lost, true, 'the probe releases its context');
});
