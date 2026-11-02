// Browser-test fixture; injected by test/helpers/skinPreviewFixture.js.
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
