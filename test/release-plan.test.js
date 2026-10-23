import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { publicationFiles } from '../tools/release-plan.mjs';
import { markdownLinkMatches } from '../tools/package.mjs';

test('release allowlist excludes local art, sidecars and private development notes', () => {
  const got = publicationFiles(['package.json', 'server/index.js', 'shared/constants.js',
    'test/helpers/battleHarness.js', 'docs/RELEASE_PACKAGES.md', 'docs/releases/v0.3.1-20p.2.md',
    'docs/LOCAL_ASSET_EXTRACTION.md', 'tools/local-extract/skins.py',
    'docs/development/README.md', 'docs/development/records/private.md',
    'data/local-skins.json', 'data/local-fx.json', 'data/local-unexpected.json',
    'public/assets/local/skins/a.png', 'public/assets/upstream.png', 'public/fonts/test.woff',
    'public/vendor/pixi.min.js', 'runtime/settings.json', '.env.production', 'public/dev/report.html']);
  assert.deepEqual(got, ['docs/LOCAL_ASSET_EXTRACTION.md', 'docs/RELEASE_PACKAGES.md',
    'docs/releases/v0.3.1-20p.2.md', 'package.json', 'server/index.js', 'shared/constants.js',
    'test/helpers/battleHarness.js', 'tools/local-extract/skins.py']);
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
