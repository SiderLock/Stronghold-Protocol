// 小人预览 (docs/SKINS.md 小人预览): the model a 皮肤 row wears, played live in the picker's enlarged view.
//
// Why live instead of a picture or a pre-rendered clip: the files are the ones a battle already pulls, so the frame
// costs no extra bytes and shows what a deploy shows; a GIF of one clip measured ≈ 360 KB at 256 px (30 frames,
// transparent), which over a catalogue would be ≈ 190 MB of extra files every client would fetch, at no better rate.
//
// Four things this module exists to keep true, each of which is silent when it breaks:
//   * ONE canvas per preview, owned by the preview and destroyed with it. The box is a real node of the modal: an
//     async load that resolves after the modal closed must never attach its canvas to a node that is gone.
//   * The box keeps a CONSTANT vdom shape — an art layer plus a mount layer — because an `img ↔ null` flip makes
//     Preact re-diff the children and would take the appended canvas with it.
//   * `getLocalBounds()` is asked AFTER an update: on a freshly built skeleton the bounds cache is empty, the rect
//     comes back 0×0 and the manifest's union bounds (≈1200 px for a 300 px idle pose) take over, shrinking the model
//     to a speck.
//   * A model that cannot load (a picture-only outfit, a broken file, no WebGL) never blocks the picker: the static
//     art stays and the caption says 模型不可用.
//
// PIXI and the asset store are loaded LAZILY, inside the effect: `public/js/ui/skinPicker.js` is reachable from
// `screens/loadout.js`, which main.js imports, and test/ui/plugins-client.test.js pins that `public/js/assets.js` is
// not on that static graph.

import { useEffect, useRef, useState } from '../../vendor/hooks.module.js';
import { html } from './components.js';
import { data } from '../data.js';
import { t } from '../../../shared/i18n.js';
import { settingsStore } from './settingsStore.js';

/** Device pixel ratio for the preview canvas, capped the way the battle renderer caps its own. */
const dpr = () => Math.min(2, globalThis.devicePixelRatio || 1);

const BOX_W = 320;
const BOX_H = 340;
/** How many extra buttons stay inline before the rest fold behind 更多动画 (two or fewer is shorter than the toggle). */
const EXTRA_INLINE = 3;

/**
 * The model a row previews: the skin's own Front, else the operator's own — the choice `assets.js spineEntry` makes for
 * a battle unit, without loading the asset store at module scope (see the header). Null when neither has a model, which
 * is the picture-only case the caller keeps on its static art.
 * @param {any} m the composed manifest @param {string} charId @param {string|null} skinId
 * @returns {any | null} a manifest Spine entry
 */
export function previewEntry(m, charId, skinId, { back = false } = {}) {
  const rec = m && typeof m === 'object' && m.chars ? m.chars[charId] : null;
  if (!rec) return null;
  const skin = skinId && rec.skins && typeof rec.skins === 'object' ? rec.skins[skinId] : null;
  const spine = skin && skin.spine && skin.spine.front ? skin.spine : rec.spine;
  if (!spine) return null;
  // `back` (the dev harness, and an outfit's own Back model when it ships one): a record with no Back keeps its Front,
  // which is what a unit facing UP draws for such an outfit anyway (assets.js spineEntry)
  const face = back && spine.back && typeof spine.back.skel === 'string' ? spine.back : spine.front;
  return face && typeof face.skel === 'string' ? face : null;
}

/** One clip of a button: the manifest names the clips, the first one is what the button plays. */
const button = (key, label, names, loop) => {
  const list = (Array.isArray(names) ? names : [names]).filter((n) => typeof n === 'string' && n);
  const unique = list.filter((n, i) => list.indexOf(n) === i);
  return unique.length ? { key, label, clip: unique[0], names: unique, loop } : null;
};

/**
 * The buttons a model offers, from its own manifest entry (docs/SKINS.md 小人预览): the roles a battle plays first,
 * then every remaining clip as its own button, labelled with the clip's own name — so nothing a skeleton ships is
 * unreachable. `anims` carries the semantic roles, `animations` the whole clip list with durations.
 * @param {any} entry a manifest Spine entry
 * @returns {{ primary: any[], extra: any[] }}
 */
export function clipsOf(entry) {
  const roles = (entry && entry.anims) || {};
  const clips = Object.keys((entry && entry.animations) || {});
  const attack = roles.attack && typeof roles.attack === 'object' ? roles.attack : { loop: roles.attack };
  const skill = roles.skill && typeof roles.skill === 'object' ? roles.skill : { loop: roles.skill };
  const primary = [
    button('deploy', '部署', [roles.deploy], false),
    button('idle', '待机', roles.idle ? [roles.idle] : clips.filter((n) => /^idle$/i.test(n)), true),
    button('attack', '攻击', [attack.loop, attack.begin, attack.end, roles.attackDown], true),
    button('skill', '技能', [skill.loop, skill.begin, skill.end], true),
  ].filter(Boolean);
  const used = new Set(primary.flatMap((b) => b.names));
  const extra = clips.filter((n) => !used.has(n)).map((n) => ({ key: `raw:${n}`, label: n, clip: n, names: [n], loop: true }));
  return { primary, extra };
}

/** The button a fresh model starts on: 待机 when the skeleton has one, else the first of anything. */
const firstClip = (group) => (group.primary.find((b) => b.key === 'idle') || group.primary[0] || group.extra[0] || { key: 'idle' }).key;

/**
 * The live frame: the model playing the selected clip, or the row's static art while it loads and whenever it cannot
 * load. The buttons never rebuild the skeleton — they only re-point the running one at another clip.
 * @param {{ charId: string, skinId?: string|null, art?: string|null, name?: string }} props
 */
export function SkinModelPreview({ charId, skinId = null, art = null, name = '', face = 'front' }) {
  const hostRef = useRef(null);
  const actorRef = useRef(null);
  const [status, setStatus] = useState('idle');          // idle | loading | ready | failed
  const [group, setGroup] = useState({ primary: [], extra: [] });
  const [clip, setClip] = useState('idle');
  const [more, setMore] = useState(false);
  const entry = previewEntry(data.get('assets'), charId, skinId, { back: face === 'back' });

  useEffect(() => {
    if (!entry) {
      setStatus('failed');
      setGroup({ primary: [], extra: [] });
      return undefined;
    }
    const next = clipsOf(entry);
    setGroup(next);
    setClip(firstClip(next));
    setStatus('loading');
    let cancelled = false;
    let app = null;
    let spine = null;
    let store = null;
    let releaseRenderer = null;
    let releaseModel = null;
    let observer = null;
    let unsubscribe = null;
    let inView = true;
    const visibility = () => {
      if (!app || cancelled) return;
      if (document.hidden || !inView) app.stop(); else app.start();
    };
    const dispose = () => {
      unsubscribe?.(); unsubscribe = null;
      observer?.disconnect();
      document.removeEventListener('visibilitychange', visibility);
      if (actorRef.current === spine) actorRef.current = null;
      if (app) releaseRenderer?.(app.renderer);
      try { app?.destroy(true, { children: true, texture: false, baseTexture: false }); } catch { /* ignore */ }
      app = null; spine = null;
      releaseModel?.();
    };
    (async () => {
      try {
        const [{ ensurePixi }, assets, { releaseGl }] = await Promise.all([import('../render/app/pixi.js'), import('../assets.js'), import('../render/app/host.js')]);
        store = assets.assets;
        releaseRenderer = releaseGl;
        const P = await ensurePixi();
        if (cancelled) return;
        let released = false;
        releaseModel = () => { if (!released) { released = true; store.spine.release(entry); } };
        const spineData = await store.spine.acquire(entry);
        if (cancelled) { releaseModel(); return; }
        const host = hostRef.current;
        if (!host) { releaseModel(); return; }
        app = new P.Application({ width: BOX_W, height: BOX_H, backgroundAlpha: 0, antialias: dpr() < 1.5, resolution: dpr(), autoDensity: true });
        app.ticker.maxFPS = settingsStore.get().frameLimit;
        unsubscribe = settingsStore.subscribe(s => { if (app) app.ticker.maxFPS = s.frameLimit; });
        const canvas = app.view;
        canvas.className = 'lo-spine__canvas';
        canvas.setAttribute('aria-label', t('小人预览'));
        host.appendChild(canvas);
        spine = new P.spine.Spine(spineData);
        spine.autoUpdate = false;
        app.stage.addChild(spine);
        spine.update(0);                                    // measure after an update (the header's third trap)
        const b = spine.getLocalBounds();
        const scale = b.width > 0 && b.height > 0 ? Math.min((BOX_W * 0.92) / b.width, (BOX_H * 0.92) / b.height) : 1;
        spine.scale.set(scale);
        spine.x = BOX_W / 2 - (b.x + b.width / 2) * scale;
        spine.y = BOX_H / 2 - (b.y + b.height / 2) * scale;
        app.ticker.add(() => { if (spine) spine.update(app.ticker.deltaMS / 1000); });
        document.addEventListener('visibilitychange', visibility);
        if (typeof IntersectionObserver === 'function') {
          observer = new IntersectionObserver(([item]) => { inView = !!item?.isIntersecting; visibility(); });
          observer.observe(host);
        }
        visibility();
        actorRef.current = spine;
        setStatus('ready');
      } catch {
        dispose();
        if (!cancelled) setStatus('failed');
      }
    })();
    return () => {
      cancelled = true;
      dispose();
    };
    // `entry` is the manifest's own object: a layer change replaces it and the model is built again
  }, [entry]);

  // the selected clip, applied to the running skeleton
  useEffect(() => {
    if (!actorRef.current || status !== 'ready') return;
    const all = [...group.primary, ...group.extra];
    const b = all.find((x) => x.key === clip);
    if (!b) return;
    try { actorRef.current.state.setAnimation(0, b.clip, b.loop); } catch { /* a clip the skeleton dropped: keep playing */ }
  }, [clip, group, status]);

  const buttons = (list) => list.map((b) => html`<button type="button" key=${b.key}
      class=${`lo-spine__btn${clip === b.key ? ' is-on' : ''}`} title=${b.names.join(' · ')}
      onClick=${() => setClip(b.key)}>${t(b.label)}</button>`);
  const folded = group.extra.length > EXTRA_INLINE;
  const hasButtons = group.primary.length > 0 || group.extra.length > 0;

  return html`<div class="lo-spine" data-testid="skin-preview">
    <div class="lo-spine__frame" style=${`width:${BOX_W}px;height:${BOX_H}px`}>
      ${/* constant shape: the art layer stays in the DOM (hidden once the model plays), the mount layer holds the canvas */ null}
      <div class="lo-spine__art" hidden=${status === 'ready'}>
        ${art ? html`<img src=${art} alt=${name} />` : null}
      </div>
      <div class="lo-spine__mount" ref=${hostRef}></div>
    </div>
    ${hasButtons ? html`<div class="lo-spine__clips">
      ${buttons(group.primary)}
      ${buttons(folded && !more ? [] : group.extra)}
      ${folded ? html`<button type="button" class="lo-spine__btn lo-spine__btn--more" onClick=${() => setMore(!more)}>
        ${more ? t('收起动画') : t('更多动画')}</button>` : null}
    </div>` : null}
    <p class="lo-spine__note">${status === 'failed' ? t('模型不可用') : t('小人预览')}</p>
  </div>`;
}
