// Publication policy layered over the existing player-file allowlist. No local art is read here.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { selectTracked, isRefused, isJunk, playerPackageJson, rewritePlayerDoc,
  importProblems, entryProblems, shipsPacks, GENERATED_PACK_INDEX } from './package.mjs';
import { writePackIndex } from './packs.mjs';
import { manifestText } from './package-update.mjs';
import { inManifest, digestFile, parseManifest } from '../server/update.js';

export const RELEASE = 'v0.3.3-20p.1';
const EXTRA_DOCS = ['docs/RELEASE_PACKAGES.md', `docs/releases/${RELEASE}.md`];

export function publicationDenied(rel) {
  return isRefused(rel) || isJunk(rel) || rel.startsWith('docs/development/')
    || rel === 'data/assets.json' || /^data\/local[^/]*\.json$/i.test(rel) || rel.startsWith('public/assets/local/');
}

export function publicationFiles(tracked) {
  // Deliberately omit selectTracked's root option: it follows historical development-note links.
  const available = new Set(tracked);
  return [...new Set([...selectTracked(tracked).keep, ...EXTRA_DOCS.filter((f) => available.has(f))])]
    .filter((f) => !publicationDenied(f)).sort();
}

function checkedPlan(root, tracked) {
  const files = publicationFiles(tracked);
  const problems = importProblems(root, files);
  if (problems.length) throw new Error(problems.join('\n'));
  return files;
}

function walk(root, rel = '') {
  return fs.readdirSync(path.join(root, rel), { withFileTypes: true }).flatMap((d) => {
    const p = path.posix.join(rel, d.name);
    if (d.isSymbolicLink()) throw new Error(`symlink refused: ${p}`);
    return d.isDirectory() ? walk(root, p) : [p];
  });
}

export function prepareStage(root, files, source) {
  const pkgPath = path.join(root, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  fs.writeFileSync(pkgPath, `${JSON.stringify(playerPackageJson(pkg, files), null, 2)}\n`);
  const have = new Set(files);
  for (const rel of files.filter((f) => f.endsWith('.md'))) {
    let text = rewritePlayerDoc(fs.readFileSync(path.join(root, rel), 'utf8'), rel, have, pkg.version);
    // Only rewrite generated omitted-file links; explicit attribution links retain their original targets.
    for (const kind of ['blob', 'raw']) text = text.replaceAll(
      `https://github.com/sganggs/Stronghold-Protocol/${kind}/v${pkg.version}/`,
      `https://github.com/SiderLock/Stronghold-Protocol/${kind}/${source}/`);
    if (rel === 'README.md') text = `> 本便携包的素材范围以 [发布包说明](docs/RELEASE_PACKAGES.md) 为准：仅包含已核验上游完整包的素材，不含本分支自行提取或新增的素材。\n\n${text}`;
    fs.writeFileSync(path.join(root, rel), text);
  }
  if (shipsPacks(files)) writePackIndex(root, path.join(root, GENERATED_PACK_INDEX));
  const problems = [...importProblems(root, files), ...entryProblems(pkg, files)];
  if (problems.length) throw new Error(problems.join('\n'));
  return { version: pkg.version, files: files.length };
}

export function finalizeStage(root, provenance = { files: {} }) {
  const files = walk(root);
  const present = new Set(files);
  const artPath = f => f.startsWith('public/assets/') || f.startsWith('public/fonts/')
    || f === 'data/assets.json' || f === 'data/local-assets.json' || f === 'data/local-fx.json';
  const approved = provenance.files || {};
  for (const [rel, row] of Object.entries(approved)) {
    if (!artPath(rel) || isRefused(rel) || isJunk(rel) || rel.includes('..') || rel.includes('\\') || row.origin !== `Stronghold-Protocol/${rel}`
      || !/^[a-f0-9]{64}$/.test(row.sha256) || !Number.isSafeInteger(row.size) || row.size < 0 || !present.has(rel)) {
      throw new Error(`invalid/missing upstream entry: ${rel}`);
    }
  }
  for (const rel of files.filter(artPath)) {
    const row = approved[rel], actual = digestFile(path.join(root, rel));
    if (!row || !actual || actual.size !== row.size || actual.sha256 !== row.sha256) throw new Error(`unverified upstream file: ${rel}`);
  }
  const denied = files.filter(f => publicationDenied(f) && !Object.hasOwn(approved, f));
  if (denied.length) throw new Error(`publication refused: ${denied.join(', ')}`);
  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  const entries = new Map(files.filter(inManifest).map((f) => [f, digestFile(path.join(root, f))]));
  const text = manifestText({ app: version, files: entries });
  parseManifest(text);
  fs.writeFileSync(path.join(root, 'MANIFEST.json'), text);
  return { version, files: entries.size };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const [mode, root, input, source] = process.argv.slice(2);
  const result = mode === 'plan' ? checkedPlan(root, JSON.parse(fs.readFileSync(input, 'utf8')))
    : mode === 'prepare' ? prepareStage(root, JSON.parse(fs.readFileSync(input, 'utf8')), source)
      : mode === 'finalize' ? finalizeStage(root, input ? JSON.parse(fs.readFileSync(input, 'utf8')) : undefined) : null;
  if (!result) throw new Error('expected plan, prepare or finalize');
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
