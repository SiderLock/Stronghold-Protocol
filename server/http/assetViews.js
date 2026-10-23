// server/http/assetViews.js — the served manifests (host bandwidth, layer 1; docs/ASSETS.md "The served manifests"):
// data/assets.json, data/local-assets.json and data/local-fx.json (the official battle effects' file list, DESIGN §33 —
// kept out of local-assets.json: ~8,800 entries) as this server hands them out, every art URL carrying the content hash
// of its file as its first segment (shared/assetPaths.js) — `/assets/char/avatar/x.png` →
// `/assets/~<hash>/char/avatar/x.png`, `/fonts/~<hash>/…` — so the browser keeps the file for a year and asks again
// only when the bytes change. Audio keeps the `/assets/~<hash>/audio/….mp3` form: public/js/media.js turns it into
// `/media/~<hash>/…` when it fetches it.
//
//   * A Spine model's skeleton, atlas and pages carry ONE hash, that of the model (assetIndex.js models): pixi-spine
//     finds the atlas by the skeleton's name and the pages next to the atlas, so their URLs share a folder. A model is
//     every `{ skel, atlas, textures }` object of data/assets.json (chars' front / back, tokens, enemies) and every
//     `spine/…` group of data/local-assets.json (the files a `spineLocal` record names).
//   * A URL the index has no hash for (not on disk, not hashed yet) stays as it is.
//   * The committed data/assets.json is never written: a view is built in memory from the file and the index, again
//     when either changes (the file's size / mtime, the index's generation), and once after every index build, so the
//     index knows the model lists before any page asks.
//   * Optional local operator chars merge into the served assets manifest before cosmetic layers (§34.28).
//     Without hashing they use plain URLs. Without local chars or a ready index, files go out as they are.

import fsp from 'node:fs/promises';
import path from 'node:path';
import { hashedPath } from '../../shared/assetPaths.js';
import { hash16 } from './assetIndex.js';
import { noopLog } from './config.js';
import { mergeLocalChars } from '../plugins/artReferences.js';
export { mergeLocalChars } from '../plugins/artReferences.js';
export { mergeLocalSkins };

/** The manifests that have a view, by their name under data/. */
export const VIEW_MANIFESTS = Object.freeze(['assets.json', 'local-assets.json', 'local-fx.json']);

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const ART_URL = /^\/(?:assets|fonts)\/./;

/** URL path of a manifest → the index's rel path ('/assets/a%20b.png' → 'assets/a b.png'), or null. */
export function relOf(url) {
  if (typeof url !== 'string' || !ART_URL.test(url) || /[?#]/.test(url)) return null;
  let p;
  try { p = decodeURIComponent(url); } catch { return null; }
  if (p.includes('\0') || p.includes('\\')) return null;
  const segs = p.slice(1).split('/');
  if (segs.some((s) => s === '' || s === '.' || s === '..')) return null;
  return segs.join('/');
}

/** Is `o` a Spine object of data/assets.json (`{ skel: '/….skel', atlas, textures? }`)? */
const isSpine = (o) => isObj(o) && typeof o.skel === 'string' && o.skel.startsWith('/') && /\.skel$/.test(o.skel);

/**
 * The installation's own outfits (data/local-skins.json, tools/local-extract/skins.py) merged into the served assets
 * manifest: `chars[<charId>].skins[<official skin id>] = { name, group, avatar?, portrait?, illust?, spine }`.
 *
 * Why here and not a cosmetic plugin: a plugin may never carry official game files (docs/PLUGINS.md §9), while the
 * official outfits are exactly that — so they live with the rest of the official art under `public/assets/local/`
 * (git-ignored, extracted from the player's own client) and the server serves them as part of the manifest. A record
 * the committed manifest already holds is left alone (a plugin's overlay is applied later, on the client, and still
 * wins). Absent file: nothing changes.
 * @param {any} doc the parsed data/assets.json
 * @param {any} local the parsed data/local-skins.json
 * @returns {any} the doc (or a copy with the outfits merged)
 */
function mergeLocalSkins(doc, local) {
  if (!isObj(local) || !isObj(local.skins) || !isObj(doc.chars)) return doc;
  let added = 0;
  const chars = { ...doc.chars };
  for (const [skinId, rec] of Object.entries(local.skins)) {
    if (!isObj(rec) || typeof rec.charId !== 'string' || typeof skinId !== 'string') continue;
    const char = isObj(chars[rec.charId]) ? { ...chars[rec.charId] } : null;
    if (!char) continue;                       // an operator this build does not have (a newer client)
    const skins = isObj(char.skins) ? { ...char.skins } : {};
    if (skins[skinId]) continue;               // already described (the committed manifest or another sidecar)
    const rec2 = { name: typeof rec.name === 'string' ? rec.name : skinId };
    if (typeof rec.group === 'string' && rec.group) rec2.group = rec.group;
    for (const k of ['avatar', 'portrait', 'illust']) if (typeof rec[k] === 'string' && rec[k]) rec2[k] = rec[k];
    if (isSpine(rec.spine?.front)) {
      // the model is not three paths: the Spine entry carries `pma`, the clip roles the renderer plays (`anims`), the
      // clip durations, the events, the hit timings and the bounds that place it (tools/local-extract/skin-meta.mjs).
      // A record without them is refused by public/js/assets.js validSpine and the unit falls back to its own model.
      rec2.spine = { front: { ...rec.spine.front } };
      if (isSpine(rec.spine?.back)) rec2.spine.back = { ...rec.spine.back };
    }
    if (!rec2.spine && !rec2.portrait && !rec2.illust && !rec2.avatar) continue;   // nothing to show
    skins[skinId] = rec2;
    char.skins = skins;
    chars[rec.charId] = char;
    added++;
  }
  return added ? { ...doc, chars } : doc;
}

/** The URLs of a Spine object: skeleton, atlas, pages (the `<skel name>.png` when it lists none). */
function spineUrls(o) {
  const out = [o.skel];
  if (typeof o.atlas === 'string' && o.atlas) out.push(o.atlas);
  const pages = Array.isArray(o.textures) ? o.textures.filter((u) => typeof u === 'string' && u) : [];
  out.push(...(pages.length ? pages : [o.skel.replace(/\.skel$/, '.png')]));
  return out;
}

/**
 * The served copy of a manifest and its model lists. `index`: hashOf(rel) / modelHash(rels) of assetIndex.js.
 * @param {any} doc the parsed manifest (not changed)
 * @param {'assets.json'|'local-assets.json'|'local-fx.json'} name
 * @param {{ hashOf: (rel: string) => string | null, modelHash: (rels: string[]) => string | null }} index
 * @returns {{ doc: any, models: string[][], hashed: number, plain: number }}
 */
export function rewriteManifest(doc, name, index) {
  const models = [];
  let hashed = 0;
  let plain = 0;
  const own = (url) => {
    const rel = relOf(url);
    const h = rel ? index.hashOf(rel) : null;
    if (h) { hashed++; return hashedPath(url, h); }
    if (rel) plain++;
    return url;
  };
  /** All URLs of one model with the model's hash (or all left plain when a member is unknown). */
  const model = (urls) => {
    const rels = urls.map(relOf);
    if (rels.some((r) => !r)) return null;
    models.push(rels);
    const h = index.modelHash(rels);
    if (!h) { plain += urls.length; return null; }
    hashed += urls.length;
    return h;
  };
  const walk = (v) => {
    if (typeof v === 'string') return ART_URL.test(v) ? own(v) : v;
    if (Array.isArray(v)) return v.map(walk);
    if (!isObj(v)) return v;
    if ((name === 'assets.json' || name === 'local-assets.json') && isSpine(v)) {
      const h = model(spineUrls(v));
      const out = {};
      for (const [k, x] of Object.entries(v)) {
        if (h && k === 'skel') out[k] = hashedPath(x, h);
        else if (h && k === 'atlas' && typeof x === 'string') out[k] = hashedPath(x, h);
        else if (h && k === 'textures' && Array.isArray(x)) out[k] = x.map((u) => (typeof u === 'string' ? hashedPath(u, h) : u));
        else out[k] = walk(x);
      }
      return out;
    }
    const out = {};
    for (const [k, x] of Object.entries(v)) out[k] = walk(x);
    return out;
  };
  if (name === 'local-assets.json' && isObj(doc) && isObj(doc.groups)) {
    const groups = {};
    for (const [g, entries] of Object.entries(doc.groups)) {
      if (g.startsWith('spine/') && isObj(entries)) {
        const names = Object.keys(entries).filter((n) => isObj(entries[n]) && typeof entries[n].path === 'string').sort();
        const [, kind, id, face] = g.split('/');
        const operator = kind === 'char' ? doc.chars?.[id]?.spine?.[face] : null;
        // The same model appears in chars and groups: use its skeleton/atlas/pages order in both views.
        const urls = isSpine(operator) ? spineUrls(operator) : names.map((n) => entries[n].path);
        const h = urls.length ? model(urls) : null;
        groups[g] = {};
        for (const [n, e] of Object.entries(entries)) {
          groups[g][n] = h && isObj(e) && typeof e.path === 'string' ? { ...e, path: hashedPath(e.path, h) } : walk(e);
        }
      } else groups[g] = walk(entries);
    }
    return { doc: { ...walk({ ...doc, groups: null }), groups }, models, hashed, plain };
  }
  return { doc: walk(doc), models, hashed, plain };
}

/**
 * The views of one server.
 * @param {{ dataDir: string, index?: ReturnType<typeof import('./assetIndex.js').createAssetIndex> | null, log?: object }} opts
 */
export function createManifestViews({ dataDir, index, log = noopLog }) {
  const dir = path.resolve(dataDir);
  /** @type {Map<string, { key: string, view: { body: Buffer, hash: string, hashed: number, plain: number } | null, models: string[][] }>} */
  const cache = new Map();
  /** @type {Map<string, Promise<any>>} */
  const pending = new Map();
  const warned = new Set();

  const pushModels = () => index?.setModels([...cache.values()].flatMap((c) => c.models));
  const plainIndex = { hashOf: () => null, modelHash: () => null };

  /** Build a hashed view or a plain local-operator merge; otherwise leave ordinary file serving alone. */
  async function build(name) {
    // Local operator art also works with SP_ASSET_INDEX=0 and during the initial hash scan.
    const localFile = path.join(dir, 'local-assets.json');
    const localStat = name === 'assets.json' ? await fsp.stat(localFile).catch(() => null) : null;
    // the installation's own outfits (tools/local-extract/skins.py): a sidecar beside the manifest
    const skinsFile = path.join(dir, 'local-skins.json');
    const skinsStat = name === 'assets.json' ? await fsp.stat(skinsFile).catch(() => null) : null;
    const indexed = index?.ready && index.size > 0;
    if (!indexed && !localStat) return null;
    const file = path.join(dir, name);
    const st = await fsp.stat(file).catch(() => null);
    if (!st || !st.isFile()) {
      if (cache.delete(name)) pushModels();
      return null;
    }
    const key = `${index?.generation || 0}|${st.size}|${st.mtimeMs}|${localStat?.size || 0}|${localStat?.mtimeMs || 0}`
      + `|${skinsStat?.size || 0}|${skinsStat?.mtimeMs || 0}`;
    const hit = cache.get(name);
    if (hit && hit.key === key) return hit.view;
    let doc;
    try {
      doc = JSON.parse(await fsp.readFile(file, 'utf8'));
    } catch (e) {
      if (!warned.has(name)) { warned.add(name); log.warn?.(`[assets] data/${name} unreadable (${e?.message || e}); served as it is`); }
      cache.set(name, { key, view: null, models: [] });
      pushModels();
      return null;
    }
    // Both local sidecars merge into the served copy. When hashing is off (a scan still running, or
    // SP_ASSET_INDEX=0) the view is only worth building if one of them actually changed something — otherwise the
    // file is served as it is, exactly as before.
    let merged = doc;
    if (localStat) {
      let local;
      try { local = JSON.parse(await fsp.readFile(localFile, 'utf8')); } catch { /* optional local art */ }
      merged = mergeLocalChars(merged, local);
    }
    if (skinsStat) {
      let localSkins;
      try { localSkins = JSON.parse(await fsp.readFile(skinsFile, 'utf8')); } catch { /* optional outfits */ }
      merged = mergeLocalSkins(merged, localSkins);
    }
    if (!indexed && merged === doc) return null;
    doc = merged;
    // one synchronous step: the view and the model lists the index checks a model's URLs against
    const { doc: out, models, hashed, plain } = rewriteManifest(doc, name, indexed ? index : plainIndex);
    const body = Buffer.from(JSON.stringify(out));
    const view = { body, hash: hash16(body), hashed, plain };
    cache.set(name, { key, view, models });
    pushModels();
    return view;
  }

  /** The view of `name` (one build at a time per manifest). */
  function get(name) {
    if (!VIEW_MANIFESTS.includes(name)) return Promise.resolve(null);
    const running = pending.get(name);
    if (running) return running;
    const p = build(name).catch((e) => { log.error?.('[assets] manifest view failed', e); return null; }).finally(() => pending.delete(name));
    pending.set(name, p);
    return p;
  }

  const rebuildAll = () => Promise.all(VIEW_MANIFESTS.map(get));
  // after every build that changed the hashes (and the first one): the views, and with them the index's model lists
  index?.onChange(() => { rebuildAll(); });
  index?.whenReady().then(() => rebuildAll(), () => {});

  return {
    get,
    rebuildAll,
    stats() {
      const out = {};
      for (const [name, c] of cache) out[name] = c.view ? { bytes: c.view.body.length, hashed: c.view.hashed, plain: c.view.plain } : null;
      return out;
    },
  };
}
