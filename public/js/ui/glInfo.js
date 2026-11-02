// public/js/ui/glInfo.js — what this browser's WebGL can do, probed once at boot.
//
// Why: the whole battle field is WebGL (PIXI for the units, three.js for the optional 3D board), and some
// Chromium-based browsers popular in China (e.g. 星愿 / Twinkstar, Chromium 98 with a GPU/驱动 conflict documented in
// their own forum) fail to create a WebGL context or lose it mid-match. Those players used to get a console warning and
// a silently simplified board; the probe lets the client (a) default a software renderer to the low quality tier
// instead of the heavy one, and (b) tell the player what to do instead of showing a blank field.
//
// `gpuProfile()` is pure over its `g` argument (no module state), so it is testable with a fake global.

/** Renderer names that mean "no real GPU": a software rasteriser running inside the browser. */
const SOFTWARE_RE = /swiftshader|llvmpipe|softpipe|software|basic render|microsoft basic render|angle \(software/i;

/**
 * What WebGL this environment has.
 * @param {any} [g] the global object (tests pass a fake one)
 * @returns {{ webgl: 0 | 1 | 2, software: boolean, renderer: string, probed: boolean }}
 *   `probed` is false when there was no canvas to ask at all (Node, a test harness): "could not ask" must not read as
 *   "no WebGL" and silently downgrade a desktop player.
 */
export function gpuProfile(g = globalThis) {
  const out = { webgl: 0, software: false, renderer: '', probed: false };
  let canvas = null;
  try {
    canvas = g?.document?.createElement?.('canvas') || null;
    if (!canvas || typeof canvas.getContext !== 'function') return out;
    out.probed = true;
    let gl2 = null;
    try { gl2 = canvas.getContext('webgl2'); } catch { gl2 = null; }
    let gl = gl2;
    if (!gl) {
      try { gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl'); } catch { gl = null; }
    }
    if (!gl) return out;
    out.webgl = gl2 ? 2 : 1;
    try {
      const ext = gl.getExtension?.('WEBGL_debug_renderer_info');
      const raw = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter?.(gl.RENDERER);
      out.renderer = typeof raw === 'string' ? raw : String(raw ?? '');
    } catch { /* some drivers hide it */ }
    out.software = SOFTWARE_RE.test(out.renderer);
    // Do not keep a GPU context alive just for the probe: browsers cap the number of live contexts per page.
    try { gl.getExtension?.('WEBGL_lose_context')?.loseContext?.(); } catch { /* ignore */ }
  } catch { /* no canvas / blocked: report "no WebGL" */ }
  return out;
}

/** The boot-time profile (probed once per page). */
export const gpu = gpuProfile();

/**
 * The settings a first-time player should start with on this machine: a software renderer (or no WebGL at all) cannot
 * carry the heavy tier — the official effects and the high-resolution board are what make such a browser drop frames or
 * lose the context. A player who already saved settings keeps them.
 * @param {any} profile
 * @returns {{ quality?: 'low', officialFx?: 'off' }}
 */
export function gpuDefaults(profile) {
  if (!profile || !profile.probed) return {};
  return profile.software || profile.webgl === 0 ? { quality: 'low', officialFx: 'off' } : {};
}
