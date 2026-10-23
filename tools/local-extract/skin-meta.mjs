#!/usr/bin/env node
// tools/local-extract/skin-meta.mjs — fill each outfit model's Spine metadata into data/local-skins.json.
//
// A manifest Spine entry is not just three file paths: the client's `validSpine` (public/js/assets.js) requires
// `{ skel, atlas, anims }`, and the renderer drives the model from `anims` (idle / deploy / attack / skill / die) with
// `bounds` and `hits` placing it and timing its effects. A model with only the paths is refused ("no spine entry") and
// the unit falls back to the operator's own model — which is exactly what an extracted outfit looked like before this
// step. The metadata comes from the skeleton itself, with the same parser and role resolver a cosmetic plugin's model
// goes through (tools/local-extract/plugin-art.mjs, tools/assets/skel.mjs, tools/assets/anim-roles.mjs).
//
//   node tools/local-extract/skin-meta.mjs [--sidecar data/local-skins.json] [--json]
//
// Idempotent: every entry's spine faces are re-derived from the files on disk.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseSkel } from '../assets/skel.mjs';
import { resolveRoles } from '../assets/anim-roles.mjs';
import { applyRoleFix, PREFAB_SPINE_ROLES } from '../assets/spine.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// skinpack/char_134_ifrit.ab, char_134_ifrit_rilakkuma#1._animations contains Attack / Attack_Down and
// Skill_2_Begin/Loop/End, but no binding to the skeleton's extra "Skill" / "Skill_Down" clips. Those unused
// clips must not replace S1/S3's ordinary attack fallback (the default model's behavior). Confine to this outfit.
const normalAttack = (index) => ({ begin: null, loop: 'Attack', end: null, via: 'attack', index, idle: null });
const OUTFIT_ROLES = Object.freeze({
  'char_134_ifrit@rilakkuma#1': { skill: normalAttack(0), skills: { 0: normalAttack(0), 2: normalAttack(2) } },
});

/** `/assets/local/skins/x/front/y.skel` → `<root>/public/assets/local/skins/x/front/y.skel` */
function fileOf(url) {
  const s = String(url || '');
  if (!s.startsWith('/assets/')) return null;
  let p;
  try { p = decodeURIComponent(s); } catch { return null; }
  return path.join(ROOT, 'public', ...p.slice(1).split('/'));
}

/**
 * The metadata of one skeleton file: what a cosmetic plugin's model gets from `--spine`.
 * @param {string} skelFile
 */
export function metaOf(skelFile, atlasFile = null, { charId, skinId, onRoleWarning } = {}) {
  const sk = parseSkel(fs.readFileSync(skelFile));
  // Names alone cannot distinguish Utage's S1 rest from her S2 normal attacks. Use the same verified character
  // corrections as the default model, only for clips this outfit actually contains.
  let fixed = applyRoleFix(resolveRoles(sk.animations, { skillIndices: [0, 1, 2], durations: sk.durations }),
    PREFAB_SPINE_ROLES[charId], sk.durations);
  for (const role of fixed.missing) onRoleWarning?.(role);
  fixed = applyRoleFix(fixed.roles, skinId?.startsWith(charId + '@') ? OUTFIT_ROLES[skinId] : undefined, sk.durations);
  for (const role of fixed.missing) onRoleWarning?.(role);
  // A client-extracted atlas declares `pma: true`; the web resources the base operators come from do not (their
  // premultiplied flag is false). Read it, never assume it: a wrong flag darkens or lightens the whole model.
  let pma = false;
  if (atlasFile) {
    try { pma = /^\s*pma:\s*true\s*$/m.test(fs.readFileSync(atlasFile, 'utf8')); } catch { /* keep false */ }
  }
  return {
    pma,
    anims: fixed.roles,
    animations: sk.durations,
    events: sk.events,
    hits: sk.hits,
    bounds: sk.bounds,
  };
}

/** Fill the metadata of every spine face the sidecar names; returns the counts. */
export function fill(sidecar) {
  const doc = JSON.parse(fs.readFileSync(sidecar, 'utf8'));
  const out = { outfits: 0, faces: 0, broken: [], warnings: [] };
  for (const [skinId, rec] of Object.entries(doc.skins || {})) {
    let any = false;
    for (const face of ['front', 'back']) {
      const sp = rec.spine?.[face];
      if (!sp || typeof sp.skel !== 'string') continue;
      const file = fileOf(sp.skel);
      if (!file || !fs.existsSync(file)) { out.broken.push(`${skinId}:${face}`); continue; }
      try {
        const meta = metaOf(file, fileOf(sp.atlas), { charId: rec.charId, skinId,
          onRoleWarning: (role) => out.warnings.push(`${skinId}:${face}: role fix skipped (missing clip): ${role}`) });
        Object.assign(sp, meta);
        out.faces++;
        any = true;
      } catch (e) {
        out.broken.push(`${skinId}:${face} (${e.message})`);
      }
    }
    if (any) out.outfits++;
  }
  fs.writeFileSync(sidecar, JSON.stringify(doc), 'utf8');
  return out;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  const sidecar = path.resolve(args.includes('--sidecar') ? args[args.indexOf('--sidecar') + 1] : path.join(ROOT, 'data', 'local-skins.json'));
  const res = fill(sidecar);
  if (args.includes('--json')) process.stdout.write(JSON.stringify(res) + '\n');
  else console.log(`skin-meta: ${res.outfits} outfits, ${res.faces} faces, ${res.broken.length} broken`);
  for (const b of res.broken.slice(0, 10)) console.error('  ' + b);
  for (const w of res.warnings.slice(0, 10)) console.error('  ' + w);
}
