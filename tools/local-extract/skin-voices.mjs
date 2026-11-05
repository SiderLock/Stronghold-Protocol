#!/usr/bin/env node
// Install official battle voices for the outfits already listed in data/local-skins.json.
// skin_table.voiceId selects the bank. Existing pictures/models and unavailable voice slots survive a retry.
// Files live under public/assets/local/voices, which the ordinary asset downloader never prunes.

import { readFile, writeFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { cachedJson } from '../assets/cache.mjs';
import { Downloader } from '../assets/downloader.mjs';
import { indexVoice, VOICE_BATTLE_SLOTS, VOICE_DIRS } from '../assets/audio.mjs';
import { RAW, joinUrl } from '../assets/sources.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TREES = Object.freeze({
  cn: { field: 'voice', type: 'CN_MANDARIN' },
  jp: { field: 'voiceJp', type: 'JP' },
  en: { field: 'voiceEn', type: 'EN' },
  kr: { field: 'voiceKr', type: 'KR' },
});

/** Download an installation's official outfit banks and atomically add their available slots to its sidecar. */
export async function fillVoices({ root = ROOT, dryRun = false, fetchImpl = globalThis.fetch, log = console.log } = {}) {
  const sidecar = path.join(root, 'data/local-skins.json');
  const local = JSON.parse(await readFile(sidecar, 'utf8'));
  const [skins, charword] = await Promise.all(['skin_table', 'charword_table'].map(table => cachedJson({
    cacheFile: path.join(root, '.cache/gamedata/excel', `${table}.json`),
    url: joinUrl(RAW.gamedata, `excel/${table}.json`), fetchImpl, log,
  })));
  const banks = indexVoice(charword, 'CN', VOICE_BATTLE_SLOTS, { byWordKey: true });
  const plans = new Map();
  const jobs = [];
  for (const [skinId, rec] of Object.entries(local.skins || {})) {
    const official = skins.charSkins?.[skinId];
    const slots = banks.get(official?.voiceId);
    if (!official || official.charId !== rec?.charId || !slots) continue;
    const fields = {};
    for (const [lang, { field, type }] of Object.entries(TREES)) {
      if (!charword.voiceLangDict?.[official.voiceId]?.dict?.[type]) continue;
      const tree = {};
      for (const [slot, assets] of Object.entries(slots)) {
        const lines = [];
        for (const asset of assets) {
          const match = /^([A-Za-z0-9_#]+)\/([A-Za-z]{2}_\d+)$/.exec(asset);
          if (!match) continue;
          const file = `${match[1]}/${match[2].toLowerCase()}.mp3`;
          const rel = `local/voices/${lang}/${file}`;
          jobs.push({ rel, urls: [joinUrl(RAW.aa2voice, `${VOICE_DIRS[lang]}/${file}`)], kind: 'mp3' });
          lines.push(rel);
        }
        if (lines.length) tree[slot] = lines;
      }
      if (Object.keys(tree).length) fields[field] = tree;
    }
    if (Object.keys(fields).length) plans.set(skinId, fields);
  }
  const result = { plannedOutfits: plans.size, files: new Set(jobs.map(job => job.rel)).size,
    downloaded: 0, skipped: 0, missing: [], errors: [], written: false };
  if (dryRun || !plans.size) return result;
  const downloader = new Downloader({ root: path.join(root, 'public/assets'),
    ledgerPath: path.join(root, '.cache/assets-ledger.json'), fetchImpl, log });
  await downloader.loadLedger();
  const downloaded = await downloader.run(jobs, 'skin voices');
  result.downloaded = downloader.totals.ok;
  result.skipped = downloader.totals.skip;
  for (const [rel, status] of downloaded) {
    if (status.status === 'miss') result.missing.push(rel);
    if (status.status === 'error') result.errors.push({ rel, error: status.error });
  }
  // Re-read after downloads so another extraction's new pictures/models are retained.
  const current = JSON.parse(await readFile(sidecar, 'utf8'));
  let changed = false;
  for (const [skinId, fields] of plans) {
    const rec = current.skins?.[skinId];
    if (!rec || rec.charId !== local.skins[skinId].charId) continue;
    for (const [field, slots] of Object.entries(fields)) {
      const tree = { ...rec[field] };
      for (const [slot, rels] of Object.entries(slots)) {
        if (!rels.every(rel => downloader.accepted.has(rel))) continue;
        const urls = rels.map(rel => '/assets/' + rel.split('/').map(encodeURIComponent).join('/'));
        const value = urls.length === 1 ? urls[0] : urls;
        if (JSON.stringify(tree[slot]) === JSON.stringify(value)) continue;
        tree[slot] = value;
        changed = true;
      }
      if (Object.keys(tree).length) rec[field] = tree;
    }
  }
  if (changed) {
    const temp = `${sidecar}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, JSON.stringify(current), { flag: 'wx' });
      await rename(temp, sidecar);
      result.written = true;
    } finally {
      await unlink(temp).catch(() => {});
    }
  }
  return result;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  if (args.some(arg => !['--dry-run', '--json'].includes(arg))) {
    console.error('usage: node tools/local-extract/skin-voices.mjs [--dry-run] [--json]');
    process.exitCode = 2;
  } else {
    const result = await fillVoices({ dryRun: args.includes('--dry-run'), log: line => console.error(line) });
    console.log(JSON.stringify(result, null, args.includes('--json') ? undefined : 2));
    if (result.missing.length || result.errors.length) process.exitCode = 1;
  }
}
