// Pure scene preparation, shared by the page fallback and the module worker. No renderer or DOM objects cross it.
import { mergeSceneChunks, sceneMaterialKey } from './load.js';

/** A switchable field is visible when its centre lies in a built area. */
export function sceneGroupVisible(rect, areas) {
  if (!Array.isArray(rect) || rect.length < 4) return true;
  const cx = (rect[0] + rect[2]) / 2, cy = (rect[1] + rect[3]) / 2;
  return (areas || []).some((a) => cx >= a.c0 - 0.5 && cx <= a.c1 + 0.5 && cy >= a.r0 - 0.5 && cy <= a.r1 + 0.5);
}

/** Cache by visible chunk indices: camera transitions with the same fields reuse exactly the same geometry. */
export function sceneGeometryKey(pack, areas) {
  return (pack.chunks || []).flatMap((c, i) => !c.group || sceneGroupVisible(pack.groups?.[c.group], areas) ? [i] : []).join(',');
}

export function prepareSceneBuckets(pack, areas) {
  const buckets = new Map();
  for (const c of pack.chunks || []) {
    if (c.group && !sceneGroupVisible(pack.groups?.[c.group], areas)) continue;
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
export function sceneBuckets(pack, areas) {
  let cache = prepared.get(pack);
  if (!cache) { cache = new Map(); prepared.set(pack, cache); }
  const key = sceneGeometryKey(pack, areas);
  let value = cache.get(key);
  if (!value) {
    value = pack.prepared?.key === key ? pack.prepared.buckets : prepareSceneBuckets(pack, areas);
    // Seed only once: evicting this variant must also release its retained merged arrays.
    delete pack.prepared;
  }
  cache.delete(key); cache.set(key, value);
  if (cache.size > 2) cache.delete(cache.keys().next().value);
  return value;
}
