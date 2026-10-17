// GitHub #531 / #530: the player zip must not ship a package.json whose `npm test` is a silent green, and the
// Markdown it ships must not keep relative links to files the zip does not contain. The repository copies stay as they
// are; tools/package.mjs rewrites the staged copies. These tests call that rewrite directly (no zip, no browser).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PLAYER_MARKDOWN, PLAYER_NPM_SCRIPTS, playerPackageJson, playerPackageProblems, releaseTag, rewritePlayerDoc,
  selectTracked, trackedFiles, playerDocHref, markdownLinkMatches,
} from '../tools/package.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const DISHONEST = ['test', 'golden', 'golden:update', 'build-data', 'check:imports', 'ci', 'package', 'package:lite', 'lint', 'typecheck'];
const KEPT = [...PLAYER_NPM_SCRIPTS, 'dev'];

test('release tags drop a trailing -dev and keep an already released version', () => {
  assert.equal(releaseTag('0.2.5-dev'), 'v0.2.5');
  assert.equal(releaseTag('0.2.4'), 'v0.2.4');
  assert.equal(releaseTag('9.9.9'), 'v9.9.9');
});

test('the packaged package.json keeps only scripts whose node files ship', () => {
  const shipped = selectTracked(trackedFiles(ROOT), { root: ROOT }).keep;
  const next = playerPackageJson(pkg, shipped);
  for (const name of DISHONEST) assert.equal(next.scripts[name], undefined, name);
  for (const name of KEPT) assert.equal(next.scripts[name], pkg.scripts[name], name);
  assert.deepEqual(Object.keys(next), Object.keys(pkg));
  assert.deepEqual(playerPackageProblems(pkg, shipped), []);
  assert.match(pkg.scripts.test, /^node --test "/, 'the repository package.json still runs the suite (tools/ci.mjs TEST_FILES)');
  assert.equal(pkg.scripts.lint, 'eslint .');
  const keys = Object.keys(next);
  assert.deepEqual(keys.filter((k) => k !== 'scripts'), Object.keys(pkg).filter((k) => k !== 'scripts'));
});

test('a script with no shipped node file is dropped, including a bare node --test', () => {
  const shipped = new Set(['server/index.js', 'tools/vendor.mjs']);
  const next = playerPackageJson({
    name: 'x', version: '1.0.0',
    scripts: {
      start: 'node server/index.js',
      dev: 'node --watch server/index.js',
      test: 'node --test',
      named: 'node --test test/a.test.js',
      lint: 'eslint .',
      both: 'node tools/vendor.mjs && node tools/missing.mjs',
      vendor: 'node tools/vendor.mjs',
    },
  }, shipped);
  assert.deepEqual(Object.keys(next.scripts).sort(), ['dev', 'start', 'vendor']);
  assert.ok(playerPackageProblems({ scripts: { start: 'node server/missing.js', setup: 'node tools/setup.mjs', doctor: 'node tools/doctor.mjs', launch: 'node scripts/launch.mjs', postinstall: 'node tools/vendor.mjs', vendor: 'node tools/vendor.mjs', assets: 'node tools/vendor.mjs' } }, shipped).length > 0);
});

function linkTarget(from, href) {
  const raw = href.split('#')[0];
  const dir = path.posix.dirname(from);
  return path.posix.normalize(path.posix.join(dir, raw));
}

test('packaged copies of the shipped docs point unshipped relative links at the release tag', () => {
  const shipped = new Set(selectTracked(trackedFiles(ROOT), { root: ROOT }).keep);
  const version = pkg.version;
  const tag = releaseTag(version);
  const host = 'https://github.com/sganggs/Stronghold-Protocol';
  const focus = new Set(['README.md', 'docs/PLAYING.md', 'docs/DEPLOY.md']);
  let fileRewrites = 0;
  assert.ok(PLAYER_MARKDOWN.includes('README.md') && PLAYER_MARKDOWN.includes('docs/PLAYING.md') && PLAYER_MARKDOWN.includes('docs/DEPLOY.md'));
  for (const rel of PLAYER_MARKDOWN) {
    const md = readFileSync(path.join(ROOT, rel), 'utf8');
    for (const [, , href] of markdownLinkMatches(md)) {
      if (/^(?:[a-z][a-z0-9+.-]*:|#)/i.test(href)) continue;
      const target = linkTarget(rel, href);
      const onDisk = target.startsWith('..') ? null : path.join(ROOT, target);
      const releaseLatest = /^(?:\.\.\/)+releases\/latest$/.test(target);
      assert.ok(releaseLatest || (onDisk && existsSync(onDisk)), `${rel} source link ${href} (${target})`);
    }
    const next = rewritePlayerDoc(md, rel, shipped, version);
    assert.equal(rewritePlayerDoc(next, rel, shipped, version), next, `${rel} rewrite is idempotent`);
    const before = markdownLinkMatches(md);
    const after = markdownLinkMatches(next);
    assert.equal(before.length, after.length, rel);
    for (let i = 0; i < after.length; i++) {
      const href = after[i][2];
      if (/^(?:[a-z][a-z0-9+.-]*:|#)/i.test(href)) {
        if (before[i][2] !== href) assert.ok(href.startsWith(`${host}/`), `${rel} ${before[i][2]} → ${href}`);
        continue;
      }
      const target = linkTarget(rel, href);
      assert.ok(!target.startsWith('..') && shipped.has(target), `${rel} still links to ${href} (${target}), which the zip does not ship`);
    }
    if (!focus.has(rel)) continue;
    for (let i = 0; i < before.length; i++) {
      if (before[i][2] === after[i][2]) continue;
      if (!/^[a-z][a-z0-9+.-]*:/i.test(after[i][2])) {
        assert.ok(shipped.has(linkTarget(rel, after[i][2])), 'site-root links to shipped branch docs become offline relative links');
        continue;
      }
      if (/\.(?:png|jpe?g|gif|webp|svg)(?:#|$)/i.test(before[i][2])) {
        assert.match(after[i][2], new RegExp(`^${host}/raw/${tag}/`));
      } else {
        fileRewrites++;
        assert.match(after[i][2], new RegExp(`^${host}/(?:blob/${tag}/|releases/)`));
      }
    }
  }
  assert.ok(fileRewrites >= 23, `README / PLAYING / DEPLOY rewrote ${fileRewrites} file links, want at least 23`);
});

test('player package follows tracked branch-document references offline and leaves source/private/unreferenced files out', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sp-player-docs-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const docs = {
    'README.md': '[容量](/docs/PLAYER_CAPACITY.md) [维护](docs/development/README.md)',
    'docs/PLAYER_CAPACITY.md': '[决定](development/DECISIONS.md#d001)',
    'docs/development/README.md': '[记录](records/README.md) [源码](../../test/branch-only.test.js)',
    'docs/development/DECISIONS.md': '[依据](records/one.md)',
    'docs/development/records/README.md': '[任务](one.md)',
    'docs/development/records/one.md': '[前次](two.md) [未跟踪](untracked.md) [私有](../../../runtime/private.md)',
    'docs/development/records/two.md': '[当前](one.md)\n```md\n[不采纳](unused.md)\n```',
    'docs/development/records/unused.md': 'not referenced',
    'docs/development/records/untracked.md': 'not tracked',
    'test/branch-only.test.js': 'test source', 'runtime/private.md': 'private data',
  };
  for (const [rel, text] of Object.entries(docs)) {
    const file = path.join(root, rel); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, text);
  }
  const tracked = Object.keys(docs).filter((rel) => !rel.endsWith('/untracked.md'));
  const { keep, drop } = selectTracked(tracked, { root });
  for (const rel of Object.keys(docs).filter((p) => p.endsWith('.md') && !/(?:unused|untracked|private)\.md$/.test(p))) {
    assert.ok(keep.includes(rel), rel);
  }
  for (const rel of ['docs/development/records/unused.md', 'test/branch-only.test.js', 'runtime/private.md']) assert.ok(drop.includes(rel), rel);
  assert.ok(!keep.includes('docs/development/records/untracked.md'));
  assert.equal(playerDocHref('/docs/PLAYER_CAPACITY.md#人数规则', 'README.md', keep, '0.2.6'), 'docs/PLAYER_CAPACITY.md#人数规则');
  assert.equal(playerDocHref('two.md', 'docs/development/records/one.md', keep, '0.2.6'), 'two.md');
});

test('current branch capacity, decision and indexed task docs remain local in the player package', () => {
  const { keep } = selectTracked(trackedFiles(ROOT), { root: ROOT });
  assert.ok(keep.includes('docs/PLAYER_CAPACITY.md'));
  assert.ok(keep.includes('docs/development/DECISIONS.md'));
  assert.ok(keep.includes('docs/development/records/README.md'));
  for (const rel of keep.filter((p) => p.endsWith('.md') && p.startsWith('docs/development/'))) {
    const before = readFileSync(path.join(ROOT, rel), 'utf8');
    const after = rewritePlayerDoc(before, rel, keep, pkg.version);
    assert.doesNotMatch(after, /https:\/\/github\.com\/sganggs\/Stronghold-Protocol\/blob\/[^\s)]+\/(?:docs\/development\/|docs\/PLAYER_CAPACITY\.md)/);
  }
});

test('packaged Markdown preserves fenced and inline example URLs verbatim while rewriting real links', () => {
  const examples = '`![说明](assets/banner.png)` and ``[source](test/a.test.js) `nested` ``\n```markdown\n![示例](assets/other.png)\n```';
  assert.equal(rewritePlayerDoc(examples, 'docs/development/records/example.md', [], '0.2.6'), examples);
  assert.deepEqual(markdownLinkMatches(examples), []);
  const real = rewritePlayerDoc('[source](test/a.test.js) ' + examples, 'README.md', [], '0.2.6');
  assert.ok(real.startsWith('[source](https://github.com/sganggs/Stronghold-Protocol/blob/v0.2.6/test/a.test.js) '));
  assert.ok(real.endsWith(examples));
});
