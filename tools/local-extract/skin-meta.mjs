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

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

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
export function metaOf(skelFile, atlasFile = null) {
  const sk = parseSkel(fs.readFileSync(skelFile));
  // A client-extracted atlas declares `pma: true`; the web resources the base operators come from do not (their
  // premultiplied flag is false). Read it, never assume it: a wrong flag darkens or lightens the whole model.
  let pma = false;
  if (atlasFile) {
    try { pma = /^\s*pma:\s*true\s*$/m.test(fs.readFileSync(atlasFile, 'utf8')); } catch { /* keep false */ }
  }
  return {
    pma,
    anims: resolveRoles(sk.animations, { skillIndices: [0, 1, 2], durations: sk.durations }),
    animations: sk.durations,
    events: sk.events,
    hits: sk.hits,
    bounds: sk.bounds,
  };
}

/** Fill the metadata of every spine face the sidecar names; returns the counts. */
export function fill(sidecar) {
  const doc = JSON.parse(fs.readFileSync(sidecar, 'utf8'));
  const out = { outfits: 0, faces: 0, broken: [] };
  for (const [skinId, rec] of Object.entries(doc.skins || {})) {
    let any = false;
    for (const face of ['front', 'back']) {
      const sp = rec.spine?.[face];
      if (!sp || typeof sp.skel !== 'string') continue;
      const file = fileOf(sp.skel);
      if (!file || !fs.existsSync(file)) { out.broken.push(`${skinId}:${face}`); continue; }
      try {
        const meta = metaOf(file, fileOf(sp.atlas));
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
}
