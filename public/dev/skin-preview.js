// public/dev/skin-preview.js — the harness behind public/dev/skin-preview.html (dev only; public/dev/ never ships,
// tools/package.mjs NOT_TRACKED_SHIP).
//
// Why a separate file and not an inline <script> in the HTML: this server sends a Content-Security-Policy whose
// script-src is 'self' + the hashes of the app's own inline scripts (server/http/csp.js), so a dev page's inline
// module is refused ("Executing inline script violates … script-src"). public/dev/fx-viewer.html + fx-viewer.js is
// the same html + module pair.
//
// It mounts the real `SkinModelPreview` (public/js/ui/skinPreview.js) on the REAL manifest: fetch('/data/assets.json')
// → data.setContent, so `previewEntry(data.get('assets'), charId, skinId)` sees the shape a battle does, and the
// module's own lazy imports (render/app/pixi.js → /vendor/pixi.min.js + /vendor/pixi-spine.js, and
// assets.spine.acquire(entry)) run against the downloaded art under public/assets/.
//
// Query:  ?char=<charId>&skin=<skinId>
//         default char: char_498_inside (the docs' operator, front+back on disk) else the first manifest record with
//         `spine.front.skel`; `skin` picks one of the record's own `skins` (a cosmetic plugin's overlay writes those —
//         this installation's committed manifest carries none).
//
// Hooks (driven by test/render/skin-preview.browser.test.js):
//   window.__skinPreview = { ready, error, manifest, entry, charId, skinId,
//                            show(charId, skinId?) → re-render with another operator/skin,
//                            clear()                → unmount the component,
//                            state()                → what the DOM currently shows }
// A model that cannot load is NOT an error here: the component keeps the static art (art=null) and its caption says
// 模型不可用 — `state().note` is how a test tells the two apart.

import { h, render } from '/vendor/preact.module.js';
import htm from '/vendor/htm.module.js';
import { data } from '/js/data.js';
import { SkinModelPreview, previewEntry } from '/js/ui/skinPreview.js';

const html = htm.bind(h);                       // the same Preact `h` the component's own html is bound to
const q = new URLSearchParams(location.search);
const host = document.getElementById('app');
const statusEl = document.getElementById('status');

const api = { ready: false, error: null, manifest: null, entry: null, charId: null, skinId: null };
window.__skinPreview = api;

/** The first record of the manifest that can actually draw (a `spine.front.skel`), or null. */
const firstWithModel = (m) => Object.keys((m && m.chars) || {}).find((id) => m.chars[id]?.spine?.front?.skel) || null;

function draw(charId, skinId = null) {
  api.charId = charId;
  api.skinId = skinId;
  api.entry = previewEntry(api.manifest, charId, skinId);
  render(html`<${SkinModelPreview} charId=${charId} skinId=${skinId} art=${null} name=${charId} />`, host);
  statusEl.classList.toggle('is-bad', !api.entry);
  statusEl.textContent = `${charId}${skinId ? ' · ' + skinId : ''}${api.entry ? '' : ' · 无模型（组件走 模型不可用 兜底）'}`;
}

/** Draw another operator / skin (a different `entry` rebuilds the model and drops the old canvas). */
api.show = (charId, skinId = null) => draw(charId || api.charId, skinId);
/** Unmount: the effect's cleanup destroys the PIXI app and its canvas. */
api.clear = () => { render(null, host); statusEl.textContent = 'unmounted'; };
/** What the DOM shows, so the test does not have to guess at the component's internal status. */
api.state = () => {
  const root = host.querySelector('[data-testid="skin-preview"]');
  const canvas = (root && root.querySelector('canvas')) || null;
  const btn = (x) => x.textContent.trim();
  return {
    mounted: !!root,
    canvases: host.querySelectorAll('canvas').length,
    canvas: canvas ? { w: canvas.width, h: canvas.height, cls: canvas.className, label: canvas.getAttribute('aria-label') } : null,
    artHidden: root ? root.querySelector('.lo-spine__art')?.hidden ?? null : null,
    note: root ? root.querySelector('.lo-spine__note')?.textContent?.trim() ?? null : null,
    buttons: root ? [...root.querySelectorAll('.lo-spine__btn')].map(btn) : [],
    on: root ? [...root.querySelectorAll('.lo-spine__btn.is-on')].map(btn) : [],
  };
};

try {
  const res = await fetch('/data/assets.json');
  if (!res.ok) throw new Error(`HTTP ${res.status} /data/assets.json`);
  api.manifest = await res.json();
  // The real manifest, exactly as data.js would hold it: the component reads data.get('assets').
  data.setContent({ id: 'dev-skin-preview', values: { assets: api.manifest } });
  const wanted = q.get('char');
  const fallback = api.manifest.chars && api.manifest.chars.char_498_inside ? 'char_498_inside' : firstWithModel(api.manifest);
  draw(wanted || fallback, q.get('skin') || null);
  api.ready = true;
} catch (err) {
  api.error = String((err && err.message) || err);
  statusEl.classList.add('is-bad');
  statusEl.textContent = `ERROR: ${api.error}`;
  throw err;                                    // pageerror: the test reports it with the stack
}
