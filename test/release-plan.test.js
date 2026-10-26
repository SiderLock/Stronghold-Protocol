import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { publicationFiles, finalizeStage, RELEASE } from '../tools/release-plan.mjs';
import { markdownLinkMatches } from '../tools/package.mjs';
import { digestFile } from '../server/update.js';

test('release allowlist excludes local art, sidecars and private development notes', () => {
  const got = publicationFiles(['package.json', 'server/index.js', 'shared/constants.js',
    'test/helpers/battleHarness.js', 'docs/RELEASE_PACKAGES.md', `docs/releases/${RELEASE}.md`,
    'docs/LOCAL_ASSET_EXTRACTION.md', 'tools/local-extract/skins.py',
    'docs/development/README.md', 'docs/development/records/private.md',
    'data/assets.json', 'data/local-skins.json', 'data/local-fx.json', 'data/local-unexpected.json',
    'public/assets/local/skins/a.png', 'public/assets/upstream.png', 'public/fonts/test.woff',
    'public/vendor/pixi.min.js', 'runtime/settings.json', '.env.production', 'public/dev/report.html']);
  assert.deepEqual(got, ['docs/LOCAL_ASSET_EXTRACTION.md', 'docs/RELEASE_PACKAGES.md',
    `docs/releases/${RELEASE}.md`, 'package.json', 'server/index.js', 'shared/constants.js',
    'test/helpers/battleHarness.js', 'tools/local-extract/skins.py']);
});

test('current notes summarize both upstream releases and local changes before the download boundary', () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const rel = `docs/releases/${RELEASE}.md`;
  const text = fs.readFileSync(path.join(root, rel), 'utf8');
  const changes = text.split('## 下载与素材边界')[0];
  assert.match(changes, /releases\/tag\/v0\.3\.2/);
  assert.match(changes, /releases\/tag\/v0\.3\.3/);
  assert.match(changes, /每局都随机/);
  assert.match(changes, /水遁忍者/);
  assert.match(changes, /多人同步优化/);
  for (const [, , href] of markdownLinkMatches(text)) {
    if (/^(?:[a-z][a-z0-9+.-]*:|#)/i.test(href)) continue;
    assert.ok(fs.existsSync(path.resolve(root, path.dirname(rel), href.split('#')[0])), href);
  }
});

test('finalized art and indexes must match the complete verified upstream file set', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-release-provenance-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '0.3.3' }));
  const provenance = { files: {} };
  for (const rel of ['public/assets/local/fx/upstream.bin', 'data/assets.json', 'data/local-assets.json', 'data/local-fx.json']) {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{}');
    provenance.files[rel] = { ...digestFile(file), origin: `Stronghold-Protocol/${rel}` };
  }
  assert.throws(() => finalizeStage(root), /unverified upstream/);
  finalizeStage(root, provenance);
  const art = path.join(root, 'public/assets/local/fx/upstream.bin');
  fs.writeFileSync(art, 'local replacement');
  assert.throws(() => finalizeStage(root, provenance), /unverified upstream/);
  fs.writeFileSync(art, '{}');
  const extra = path.join(root, 'data/local-skins.json');
  fs.writeFileSync(extra, '{}');
  assert.throws(() => finalizeStage(root, provenance), /publication refused/);
  provenance.files['data/local-skins.json'] = { ...digestFile(extra), origin: 'Stronghold-Protocol/data/local-skins.json' };
  assert.throws(() => finalizeStage(root, provenance), /invalid\/missing upstream/);
  delete provenance.files['data/local-skins.json'];
  fs.unlinkSync(extra);
  fs.unlinkSync(art);
  assert.throws(() => finalizeStage(root, provenance), /invalid\/missing upstream/);
});

test('release notes put detailed changes and their sources before downloads; document links resolve', () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const release = 'docs/releases/v0.3.1-20p.2.md';
  const text = fs.readFileSync(path.join(root, release), 'utf8');
  assert.ok(text.indexOf('## 更新日志') < text.indexOf('## 下载与素材边界'));
  assert.ok(text.indexOf('/pull/652') < text.indexOf('## 下载与素材边界'));
  for (const rel of [release, 'docs/RELEASE_PACKAGES.md']) {
    for (const [, , href] of markdownLinkMatches(fs.readFileSync(path.join(root, rel), 'utf8'))) {
      if (/^(?:[a-z][a-z0-9+.-]*:|#)/i.test(href)) continue;
      assert.ok(fs.existsSync(path.resolve(root, path.dirname(rel), href.split('#')[0])), `${rel}: ${href}`);
    }
  }
});
