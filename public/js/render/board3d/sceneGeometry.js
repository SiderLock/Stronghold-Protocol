// Pure scene preparation, shared by the page fallback and the module worker. No renderer or DOM objects cross it.
import { mergeSceneChunks, sceneMaterialKey } from './load.js';

/**
 * Is a named part of an official scene (its ground rect [x0, y0, x1, y1]) shown with the built `areas`? The official
 * scene keeps each field as a sub-graphic it switches on (HIDDEN@n: the left / right normal field, the boss field);
 * a part is shown when its centre lies in one of the areas.
 * `inactive` is never shown. scenes.py tags that group on a GameObject the client saved disabled and that no
 * MapSubGraphicHolder turns on (fog_1 / fog_2, the same quads a later extract names mapeff_survival_shadow_*).
 * Their centre is the origin, which lies in the boss field and outside a normal / 联防 field, so the centre test
 * alone draws them as white patches under the boss ground (GitHub #918). [ASSUMED] the battle never turns that
 * object on for a phase: nothing in the extracted scene lists it under a sub-graphic, and mapeff are already
 * left undrawn. A HIDDEN part is a different group and still follows the field.
 */
export function sceneGroupVisible(rect, areas, group = '') {
  if (group === 'inactive') return false;
  if (!Array.isArray(rect) || rect.length < 4) return true;
  const cx = (rect[0] + rect[2]) / 2, cy = (rect[1] + rect[3]) / 2;
  return (areas || []).some((a) => cx >= a.c0 - 0.5 && cx <= a.c1 + 0.5 && cy >= a.r0 - 0.5 && cy <= a.r1 + 0.5);
}

/**
 * 规程's scene is its three pieces whole (regulation_scenes.py layout 'pieces'): the stage a view draws names the one
 * piece it shows and where that piece's cells are in the grid (render/arenaView.js scenePiece). A pieces scene without
 * that, or a stage with it on a scene cut before (an older extract), is not drawn: the procedural board shows.
 */
export function scenePieceMatches(pack, piece) {
  return (pack.doc?.layout === 'pieces') === !!piece;
}

function chunkShown(c, pack, areas, piece) {
  if (pack.doc?.layout === 'pieces') return c.group === piece.group;
  return !c.group || sceneGroupVisible(pack.groups?.[c.group], areas, c.group);
}

/** Cache by visible chunk indices: camera transitions with the same fields reuse exactly the same geometry. */
export function sceneGeometryKey(pack, areas, piece = null) {
  return (pack.chunks || []).flatMap((c, i) => chunkShown(c, pack, areas, piece) ? [i] : []).join(',');
}

export function prepareSceneBuckets(pack, areas, piece = null) {
  const buckets = new Map();
  for (const c of pack.chunks || []) {
    if (!chunkShown(c, pack, areas, piece)) continue;
    const info = pack.doc?.materials?.[c.material] || null;
    const key = sceneMaterialKey(c, info);
    let bucket = buckets.get(key);
    if (!bucket) { bucket = { info, chunks: [] }; buckets.set(key, bucket); }
    bucket.chunks.push(c);
  }
  return [...buckets].map(([key, b]) => ({ key, info: b.info, chunk: mergeSceneChunks(b.chunks) }));
}

// Two recent visibility sets per pack; do not accumulate copies for every intermediate camera area.
const prepared = new WeakMap();
export function sceneBuckets(pack, areas, piece = null) {
  // A pieces scene without its piece (or the other way round) is not drawable: the caller falls back to the board.
  if (!scenePieceMatches(pack, piece)) return null;
  let cache = prepared.get(pack);
  if (!cache) { cache = new Map(); prepared.set(pack, cache); }
  const key = sceneGeometryKey(pack, areas, piece);
  let value = cache.get(key);
  if (!value) {
    value = pack.prepared?.key === key ? pack.prepared.buckets : prepareSceneBuckets(pack, areas, piece);
    // Seed only once: evicting this variant must also release its retained merged arrays.
    delete pack.prepared;
  }
  cache.delete(key); cache.set(key, value);
  if (cache.size > 2) cache.delete(cache.keys().next().value);
  return value;
}
