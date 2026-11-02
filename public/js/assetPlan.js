// Manifest-only plans: never guess file names, request audio banks or decode the whole roster into GPU memory.
const VISUAL = /^\/assets\/.+\.(?:png|webp|jpe?g|gif|svg|skel|atlas|json|obj|bin)$/i;
// CacheDownloadLimiter publishes unlimited rates as null. Unknown/disabled/limited policies never permit this queue.
export const backgroundFillAllowed = (policy) => policy?.enabled === true && policy.totalBps === null && policy.clientBps === null;
export function visualAssetURLs(value) {
  const urls = new Set(), seen = new Set();
  function walk(v) {
    if (typeof v === 'string') { if (VISUAL.test(v)) urls.add(v); return; }
    if (!v || typeof v !== 'object' || seen.has(v)) return;
    seen.add(v);
    for (const [key, next] of Object.entries(v)) if (!['audio', 'voice', 'voiceJp', 'voiceEn', 'voiceKr', 'voiceNative'].includes(key)) walk(next);
  }
  walk(value); return [...urls];
}

/** Uses the same shown operator and Spine resolver as the field view (including DIY, stand-ins and skin fallback). */
export function currentAssetPlan({ pub, priv, assets, local, chess, token, enemy }) {
  if (!pub || !priv) return [];
  const urls = new Set();
  const add = (value) => { for (const u of visualAssetURLs(value)) urls.add(u); };
  const unit = (id, skin) => {
    if (!id) return;
    add(assets.picture(id, skin ? { skin } : undefined));
    for (const back of [false, true]) {
      const model = assets.spineEntry(id, { skin, back });
      if (model) add({ skel: model.skel, atlas: model.atlas, textures: model.textures });
    }
  };
  for (const p of [...(priv.board || []), ...(priv.hand || []), ...(priv.temp || [])]) {
    if (!p) continue;
    if (p.kind === 'item') { add(assets.itemIcon(p.id)); continue; }
    const rec = p.kind === 'token' ? token(p.id) : chess(p.id);
    unit(typeof rec?.spine === 'string' ? rec.spine : rec?.charId || rec?.tokenId || p.id, p.skin);
    add(assets.skillIcon(rec?.skill?.skillId));
    for (const item of p.items || []) add(assets.itemIcon(item.id));
  }
  add(local?.groups?.[`scene/${pub.stageId}`]);
  for (const name of ['map/autochess', 'map/common', 'map/fx', 'map/water']) add(local?.groups?.[name]);
  for (const row of priv.nextEnemies || []) {
    const id = row.enemyKey || row.enemyId || row.key, rec = enemy?.(id);
    unit(typeof rec?.spine === 'string' ? rec.spine : rec?.enemyId || id);
  }
  for (const row of priv.prepMapChars || []) unit(row.unitId || row.tokenId || row.key);
  for (const slot of priv.shop?.slots || []) {
    if (!slot || slot.sold) continue;
    const rec = chess(slot.id);
    add(assets.picture(rec?.charId || slot.id));
  }
  return [...urls];
}
