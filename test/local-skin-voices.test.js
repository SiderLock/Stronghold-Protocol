import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fillVoices } from '../tools/local-extract/skin-voices.mjs';
import { indexVoice, VOICE_BATTLE_SLOTS } from '../tools/assets/audio.mjs';
import { mergeLocalSkins } from '../shared/skins.js';
import { relOf, rewriteManifest } from '../server/http/assetViews.js';
import { createAssetCacheCatalog } from '../server/assetCacheCatalog.js';
import { voiceLine } from '../public/js/audio.js';

const CHAR = 'char_003_kalts';
const SKIN = `${CHAR}@boc#6`;
const BANK = `${CHAR}_boc#6`;
const words = { charWords: {
  base: { charId: CHAR, wordKey: CHAR, placeType: 'BATTLE_START', voiceId: 'CN_019', voiceAsset: `${CHAR}/CN_019` },
  start: { charId: CHAR, wordKey: BANK, placeType: 'BATTLE_START', voiceId: 'CN_019', voiceAsset: `${BANK}/CN_019` },
  select: { charId: CHAR, wordKey: BANK, placeType: 'BATTLE_SELECT', voiceId: 'CN_021', voiceAsset: `${BANK}/CN_021` },
  prep: { charId: CHAR, wordKey: BANK, placeType: 'GACHA', voiceId: 'CN_011', voiceAsset: `${BANK}/CN_011` },
}, voiceLangDict: { [BANK]: { dict: { CN_MANDARIN: {}, JP: {} } } } };

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sp-skin-voices-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'data'), { recursive: true });
  await mkdir(path.join(root, '.cache/gamedata/excel'), { recursive: true });
  const sidecar = path.join(root, 'data/local-skins.json');
  await writeFile(sidecar, JSON.stringify({ version: 1, skins: {
    [SKIN]: { charId: CHAR, name: '余烬', portrait: '/assets/local/skins/portrait.png' },
  } }));
  await writeFile(path.join(root, '.cache/gamedata/excel/skin_table.json'), JSON.stringify({ charSkins: {
    [SKIN]: { charId: CHAR, voiceId: BANK },
  } }));
  await writeFile(path.join(root, '.cache/gamedata/excel/charword_table.json'), JSON.stringify(words));
  const mp3 = Buffer.alloc(128);
  mp3.write('ID3');
  const requests = [];
  const fetchImpl = async url => {
    requests.push(url);
    return new Response(mp3, { headers: { 'content-length': String(mp3.length) } });
  };
  return { root, sidecar, requests, fetchImpl, read: async () => JSON.parse(await readFile(sidecar, 'utf8')) };
}

test('voice indexing keeps base banks isolated and explicitly indexes official outfit word keys', () => {
  const base = indexVoice(words, 'CN', VOICE_BATTLE_SLOTS);
  assert.deepEqual(base.get(CHAR), { start: [`${CHAR}/CN_019`] });
  assert.equal(base.has(BANK), false);
  const all = indexVoice(words, 'CN', VOICE_BATTLE_SLOTS, { byWordKey: true });
  assert.deepEqual(all.get(BANK), { start: [`${BANK}/CN_019`], select: [`${BANK}/CN_021`] });
  assert.deepEqual(all.get(CHAR), base.get(CHAR));
});

test('outfit voice dry run uses the official voiceId and only its declared languages and battle slots', async t => {
  const f = await fixture(t);
  const before = await readFile(f.sidecar, 'utf8');
  const report = await fillVoices({ root: f.root, dryRun: true, fetchImpl: f.fetchImpl, log() {} });
  assert.equal(report.plannedOutfits, 1);
  assert.equal(report.files, 4);
  assert.equal(report.written, false);
  assert.deepEqual(f.requests, []);
  assert.equal(await readFile(f.sidecar, 'utf8'), before);
});

test('installed voices survive manifest composition and pre-caching, and play through existing language fallback', async t => {
  const f = await fixture(t);
  const report = await fillVoices({ root: f.root, fetchImpl: f.fetchImpl, log() {} });
  assert.equal(report.downloaded, 4);
  assert.deepEqual(report.missing, []);
  assert.deepEqual(report.errors, []);
  assert.equal(report.written, true);
  assert.ok(f.requests.every(url => url.includes('boc%236') && new URL(url).hash === ''));
  const local = await f.read();
  const skin = local.skins[SKIN];
  assert.equal(skin.portrait, '/assets/local/skins/portrait.png');
  assert.equal(skin.voiceEn, undefined);
  const url = `/assets/local/voices/jp/${CHAR}_boc/skin-6/cn_019.mp3`;
  assert.equal(skin.voiceJp.start, url);
  assert.equal((await readFile(path.join(f.root, 'public', relOf(url)))).toString('latin1', 0, 3), 'ID3');
  const doc = mergeLocalSkins({ chars: { [CHAR]: {} } }, local);
  const served = rewriteManifest(doc, 'assets.json', { hashOf: () => '0123456789abcdef', modelHash: () => null }).doc;
  assert.ok(served.chars[CHAR].skins[SKIN].voiceJp.start.includes('~0123456789abcdef/'));
  const audio = { voice: { [CHAR]: { start: '/assets/base-cn.mp3' } },
    voiceJp: { [CHAR]: { start: '/assets/base-jp.mp3' } } };
  assert.deepEqual(voiceLine(audio, CHAR, 'start', 'jp', () => 0, doc.chars[CHAR].skins[SKIN]), {
    url, fallback: skin.voice.start,
  });
  await writeFile(path.join(f.root, 'data/assets.json'), '{}');
  await mkdir(path.join(f.root, 'public/assets/local/skins'), { recursive: true });
  await writeFile(path.join(f.root, 'public/assets/local/skins/portrait.png'), 'portrait');
  const catalog = await createAssetCacheCatalog({ publicDir: path.join(f.root, 'public'), dataDir: path.join(f.root, 'data') });
  assert.equal(catalog.complete, true);
  assert.deepEqual(catalog.missing, []);
  assert.ok(catalog.files.some(file => file.url === url), 'the actual installed voice enters the pre-cache');
  const again = await fillVoices({ root: f.root, fetchImpl: f.fetchImpl, log() {} });
  assert.equal(again.skipped, 4);
  assert.equal(again.written, false);
  assert.equal(f.requests.length, 4);
});

test('a missing dub preserves its installed slot and a download retains concurrently refreshed art', async t => {
  const f = await fixture(t);
  const local = await f.read();
  local.skins[SKIN].voiceJp = { start: '/assets/local/voices/previous.mp3' };
  await writeFile(f.sidecar, JSON.stringify(local));
  let updated = false;
  const fetchImpl = async url => {
    if (!updated) {
      updated = true;
      const latest = await f.read();
      latest.skins[SKIN].portrait = '/assets/local/skins/refreshed.png';
      await writeFile(f.sidecar, JSON.stringify(latest));
    }
    if (url.includes('/sound_beta_2/voice/') && url.endsWith('/cn_019.mp3')) return new Response('', { status: 404 });
    return f.fetchImpl(url);
  };
  const report = await fillVoices({ root: f.root, fetchImpl, log() {} });
  assert.equal(report.missing.length, 1);
  const after = (await f.read()).skins[SKIN];
  assert.equal(after.portrait, '/assets/local/skins/refreshed.png');
  assert.equal(after.voiceJp.start, '/assets/local/voices/previous.mp3');
  assert.ok(after.voiceJp.select);
  assert.ok(after.voice.start);
});

test('an incomplete multi-line slot keeps its previous lines until the whole slot can be installed', async t => {
  const f = await fixture(t);
  const charword = structuredClone(words);
  charword.charWords.select2 = { ...charword.charWords.select, voiceId: 'CN_022', voiceAsset: `${BANK}/CN_022` };
  await writeFile(path.join(f.root, '.cache/gamedata/excel/charword_table.json'), JSON.stringify(charword));
  const previous = ['/assets/local/voices/previous-1.mp3', '/assets/local/voices/previous-2.mp3'];
  const local = await f.read();
  local.skins[SKIN].voiceJp = { select: previous };
  await writeFile(f.sidecar, JSON.stringify(local));
  const report = await fillVoices({ root: f.root, log() {}, fetchImpl: async url => {
    if (url.includes('/sound_beta_2/voice/') && url.endsWith('/cn_022.mp3')) return new Response('', { status: 404 });
    return f.fetchImpl(url);
  } });
  assert.equal(report.missing.length, 1);
  assert.deepEqual((await f.read()).skins[SKIN].voiceJp.select, previous);
  const retry = await fillVoices({ root: f.root, fetchImpl: f.fetchImpl, log() {} });
  assert.equal(retry.downloaded, 1);
  assert.equal(retry.skipped, 5);
  assert.deepEqual(retry.missing, []);
  const lines = (await f.read()).skins[SKIN].voiceJp.select;
  assert.equal(lines.length, 2);
  assert.ok(lines[0].endsWith('/cn_021.mp3') && lines[1].endsWith('/cn_022.mp3'));
});
