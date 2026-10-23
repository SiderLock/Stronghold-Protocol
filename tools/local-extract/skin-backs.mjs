#!/usr/bin/env node
// tools/local-extract/skin-backs.mjs — fill each outfit's Back model from the public web resources.
//
// Legacy fallback for an installation missing a local Back. Prefer re-extraction with skins.py --models-only:
// the client's battle prefab DOES bind both Front and Back, often to TextAssets with identical names. The old
// name-based scan missed that pair and could export Back as Front (2026-10-21, docs/SKINS.md).
// The web resources the base operators' Front/Back pairs come from (fexli/ArknightsResource, see
// tools/assets/sources.mjs) also carry `spine/<charId>/<variant>/Back/<variant>.{skel,atlas,png}` for older outfits;
// this tool downloads only a missing Back and cannot repair an incorrectly extracted Front.
//
//   node tools/local-extract/skin-backs.mjs [--only a,b] [--limit n] [--concurrency 6] [--json]
//
// jdDelivr is the fast mirror; the raw host is the fallback (it is slow from some networks). Files already on disk are
// kept (rerun after an interruption). An outfit the resources do not list stays Front-only, exactly as before.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MIRRORS = [
  'https://cdn.jsdelivr.net/gh/fexli/ArknightsResource@main',
  'https://raw.githubusercontent.com/fexli/ArknightsResource/main',
];

/** The client's stem as the resource repository names the variant (`char_003_kalts_boc#6` → variant `boc_6`). */
function dumpVariant(charId, stem) {
  const rest = stem.startsWith(`${charId}_`) ? stem.slice(charId.length + 1) : null;
  return rest ? rest.replace(/#/g, '_') : null;
}

/** `boc#6` → the directory name the extractor uses for the same outfit (`boc_6`). */
const dirStem = (stem) => stem.replace(/[^A-Za-z0-9_.@-]/g, '_');

const fetchOne = async (url) => {
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(180_000) });
  if (!res.ok) return { ok: false, status: res.status };
  return { ok: true, bytes: Buffer.from(await res.arrayBuffer()) };
};

/** Download one file from the first mirror that answers; a 404 on every mirror means "not in the resources". */
async function grab(relPath, { attempts = 2 } = {}) {
  let last = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    for (const base of MIRRORS) {
      try {
        const got = await fetchOne(`${base}/${relPath}`);
        if (got.ok) return got;
        last = got.status;
        if (got.status === 404) continue;      // this mirror lacks it; the next may still have it
        if (got.status === 403 || got.status === 429) await new Promise((r) => setTimeout(r, 1200 + attempt * 1500));
      } catch (error) { last = error.message; }
    }
  }
  return { ok: false, status: last };
}

export async function fillBacks({ sidecar, outRoot, only = null, limit = 0, concurrency = 6, log = console.log } = {}) {
  const doc = JSON.parse(fs.readFileSync(sidecar, 'utf8'));
  const want = Object.entries(doc.skins || {}).filter(([skinId, rec]) => {
    if (only && !only.includes(skinId) && !only.includes(rec?.charId)) return false;
    return typeof rec?.spine?.front?.skel === 'string';
  }).slice(0, limit > 0 ? limit : undefined);

  const stats = { outfits: want.length, have: 0, added: 0, skipped: 0, missing: [] };
  let next = 0;
  const worker = async () => {
    while (next < want.length) {
      const [skinId, rec] = want[next++];
      if (rec.spine.back) { stats.have++; continue; }
      const charId = rec.charId;
      const stem = path.posix.basename(rec.spine.front.skel, '.skel');
      const variant = dumpVariant(charId, stem);
      if (!variant) { stats.missing.push(`${skinId}: no variant name`); stats.skipped++; continue; }
      const dumpStem = `${charId}_${variant}`;
      const seg = `spine/${charId}/${dumpStem}/Back/${dumpStem}`;
      const dir = path.join(outRoot, 'spine', 'skin', charId, dirStem(stem), 'back');
      const sel = await grab(`${seg}.skel`);
      if (!sel.ok) { stats.missing.push(`${skinId}: skel ${sel.status ?? 'error'}`); stats.skipped++; continue; }
      const atlas = await grab(`${seg}.atlas`);
      if (!atlas.ok) { stats.missing.push(`${skinId}: atlas ${atlas.status ?? 'error'}`); stats.skipped++; continue; }
      // the atlas names its page; the page file must carry exactly that name
      const page = String(atlas.bytes.toString('utf8')).replace(/\r/g, '').split('\n')[0].trim();
      if (!/\.(?:png|jpe?g|webp)$/i.test(page)) { stats.missing.push(`${skinId}: odd atlas page`); stats.skipped++; continue; }
      const png = await grab(`${seg}.${page.split('.').pop()}`);
      if (!png.ok) { stats.missing.push(`${skinId}: page ${png.status ?? 'error'}`); stats.skipped++; continue; }
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${stem}.skel`), sel.bytes);
      fs.writeFileSync(path.join(dir, `${stem}.atlas`), atlas.bytes);
      fs.writeFileSync(path.join(dir, page), png.bytes);
      const base = `/assets/spine/skin/${charId}/${dirStem(stem)}/back/${stem}`;
      rec.spine.back = { skel: `${base}.skel`, atlas: `${base}.atlas`, textures: [`/assets/spine/skin/${charId}/${dirStem(stem)}/back/${page}`] };
      stats.added++;
      if (stats.added % 20 === 0) log(`  … ${stats.added} backs`);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(12, concurrency)) }, worker));
  fs.writeFileSync(sidecar, JSON.stringify(doc), 'utf8');
  return stats;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
  const only = opt('--only', '') ? opt('--only', '').split(',').filter(Boolean) : null;
  const res = await fillBacks({ sidecar: path.join(ROOT, 'data', 'local-skins.json'),
    outRoot: path.join(ROOT, 'public', 'assets'), only, limit: Number(opt('--limit', '0')) || 0,
    concurrency: Number(opt('--concurrency', '6')) || 6 });
  if (args.includes('--json')) process.stdout.write(JSON.stringify(res) + '\n');
  else console.log(`skin-backs: ${res.added} added, ${res.have} already had one, ${res.skipped} not in the resources`);
  for (const m of res.missing.slice(0, 10)) console.error('  ' + m);
}
