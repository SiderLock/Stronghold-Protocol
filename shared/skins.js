// Cosmetic skin selection shared by the browser and lobby. The caller supplies an independent random stream;
// no game/shop/draft RNG is consumed, and only skin ids (never files or URLs) travel in a selection plan.
const isPlain = v => !!v && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
const isMap = (v, max, key, val) => isPlain(v) && Object.keys(v).length <= max && Object.entries(v).every(([k, x]) => key(k) && val(x));

export const SKIN_LIMITS = Object.freeze({
  // [ASSUMED] absolute ceiling of one message. The practical cap is the operator count of the room's content
  // (checkSkinSelection drops the rest); 256 is above the vanilla roster (210) and the same order as the loadout's
  // operator map. A larger map is refused whole, the way an over-long loadout is.
  entries: 256, idLen: 64, charIdLen: 64,
});
/** A skinId. NOT `isId`: that allows only `[A-Za-z0-9_\-.:]`, while a skin key carries `@` and `#` (`char_002_amiya@winter#1`). The same character class as shared/plugins/visual.js `isSkinKey`. */
export const isSkinId = (v) => typeof v === 'string' && v.length > 0 && v.length <= SKIN_LIMITS.idLen && /^[A-Za-z0-9_][A-Za-z0-9_@#+.\-]*$/.test(v);
/**
 * An operator charId. Official ids are `char_<digits>_<token>` (character_table / data/chess.json: `char_498_inside`,
 * `char_1012_skadi2`, `char_4145_ulpia`, `char_616_pithst`). A plugin operator is `char_x_<id>`
 * (shared/plugins/recordsSchema.js). A chess id (`chess_char_1_01_a`) is not one: `isId` would accept it.
 */
export const CHAR_ID = /^char_(?:x_[A-Za-z0-9_-]+|[0-9]+_[A-Za-z0-9_]+)$/;
export const isCharId = (v) => typeof v === 'string' && v.length <= SKIN_LIMITS.charIdLen && CHAR_ID.test(v);
/**
 * Structural check of `room.skins.skins`: a plain object of ≤ 256 entries, keyed by an operator charId, each value a
 * skinId. Anything else — an array, a null-prototype object, a chess id, a bad skin id, one more entry — is refused
 * as a whole (BAD_MSG). The room's own operator list is not known here.
 */
export const isSkinSelection = (v) => isMap(v, SKIN_LIMITS.entries, isCharId, isSkinId);

/** Cosmetic-only candidate ids; no asset data or executable payloads. Leave room for the selected map under 64 KiB. */
export const SKIN_RANDOM_LIMITS = Object.freeze({ perOperator: 32, choices: 1024, bytes: 24 * 1024 });
export function isSkinPool(v) {
  if (!isMap(v, SKIN_LIMITS.entries, isCharId, rows => Array.isArray(rows) && rows.length > 0
    && rows.length <= SKIN_RANDOM_LIMITS.perOperator && rows.every(isSkinId))) return false;
  return Object.values(v).reduce((n, rows) => n + rows.length, 0) <= SKIN_RANDOM_LIMITS.choices
    && JSON.stringify(v).length <= SKIN_RANDOM_LIMITS.bytes;
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
export const skinHasModel = (skin) => !!skin && isObj(skin.spine) && isObj(skin.spine.front) && typeof skin.spine.front.skel === 'string';
export const skinHasPictures = (skin) => !!skin && ['avatar', 'avatarE2', 'portrait', 'portraitE2', 'illust']
  .some(key => typeof skin[key] === 'string' && !!skin[key]);

/** Available non-default outfits, using the picker's existing model-or-picture rule. Bounds keep room.skins <64 KiB. */
export function skinPoolFromManifest(manifest, operators = null) {
  const out = {};
  let count = 0, bytes = 2, entries = 0;
  for (const id of Object.keys(manifest?.chars || {}).sort()) {
    if (!isCharId(id) || operators && !operators.has(id) || entries >= SKIN_LIMITS.entries) continue;
    const rows = manifest.chars[id]?.skins;
    const choices = Object.keys(rows || {}).sort().filter(key => isSkinId(key)
      && (skinHasModel(rows[key]) || skinHasPictures(rows[key]))).slice(0, SKIN_RANDOM_LIMITS.perOperator);
    if (!choices.length) continue;
    const kept = [];
    for (const key of choices) {
      if (count >= SKIN_RANDOM_LIMITS.choices) break;
      const next = [...kept, key];
      const size = JSON.stringify({ [id]: next }).length - 2;
      const old = kept.length ? JSON.stringify({ [id]: kept }).length - 2 : 0;
      const extra = size - old + (!kept.length && entries ? 1 : 0);
      if (bytes + extra > SKIN_RANDOM_LIMITS.bytes) break;
      kept.push(key); bytes += extra; count++;
    }
    if (kept.length) { out[id] = kept; entries++; }
  }
  return out;
}

/** A single map for the whole match (all AI seats), or one human's next-match plan. No default row is in the pool. */
export function randomSkinSelection(pool, pickIndex) {
  const out = {};
  for (const id of Object.keys(pool || {}).sort()) {
    const choices = pool[id];
    if (Array.isArray(choices) && choices.length) out[id] = choices[pickIndex(choices.length)];
  }
  return out;
}

/** Installation outfits merge before cosmetic overlays, preserving the existing served-manifest fallback rules. */
export function mergeLocalSkins(doc, local) {
  if (!isObj(local) || !isObj(local.skins) || !isObj(doc?.chars)) return doc;
  const isSpine = s => isObj(s) && typeof s.skel === 'string' && s.skel.startsWith('/') && /\.skel$/.test(s.skel);
  const chars = { ...doc.chars };
  let added = 0;
  for (const [skinId, rec] of Object.entries(local.skins)) {
    if (!isObj(rec) || typeof rec.charId !== 'string') continue;
    const char = isObj(chars[rec.charId]) ? { ...chars[rec.charId] } : null;
    if (!char) continue;
    const skins = isObj(char.skins) ? { ...char.skins } : {};
    if (skins[skinId]) continue;
    const skin = { name: typeof rec.name === 'string' ? rec.name : skinId };
    if (typeof rec.group === 'string' && rec.group) skin.group = rec.group;
    for (const key of ['avatar', 'portrait', 'illust']) if (typeof rec[key] === 'string' && rec[key]) skin[key] = rec[key];
    if (isSpine(rec.spine?.front)) {
      skin.spine = { front: { ...rec.spine.front } };
      if (isSpine(rec.spine?.back)) skin.spine.back = { ...rec.spine.back };
    }
    if (!skin.spine && !skin.portrait && !skin.illust && !skin.avatar) continue;
    skins[skinId] = skin; char.skins = skins; chars[rec.charId] = char; added++;
  }
  return added ? { ...doc, chars } : doc;
}
