// Only deployed, manifest-listed art enters this catalog. Game code, private runtime data and
// announcement images keep their existing update policies. Hashes describe the actual file bytes.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { AUDIO_EXTS, MEDIA_PREFIX } from '../shared/media.js';
import { hashedPath } from '../shared/assetPaths.js';
import { rewriteManifest } from './http/assetViews.js';

export const ASSET_CACHE_SCHEMA = 1;
export const ASSET_CACHE_MIME = Object.freeze({
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.avif': 'image/avif', '.bmp': 'image/bmp', '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg', '.opus': 'audio/ogg', '.wav': 'audio/wav',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.atlas': 'text/plain; charset=utf-8', '.obj': 'text/plain; charset=utf-8',
  '.skel': 'application/octet-stream', '.bin': 'application/octet-stream',
});

/** Canonical URLs are decoded paths, never queries, external URLs or executable resources. */
export function assetCacheURLProblem(url) {
  if (typeof url !== 'string' || !/^\/(?:assets|fonts)\//.test(url)) return 'not an asset path';
  if (/[\\\x00-\x1f\x7f?#%:]/.test(url)) return 'invalid path characters';
  const parts = url.slice(1).split('/');
  if (parts.some((s) => !s || s.startsWith('.') || s.endsWith('.') || s.endsWith(' ') || /[<>"|*]/.test(s))) return 'unsafe path segment';
  if (!Object.hasOwn(ASSET_CACHE_MIME, path.posix.extname(url).toLowerCase())) return 'unsupported resource type';
  if (parts[0] === 'fonts' && !['.css', '.woff', '.woff2', '.ttf', '.otf'].includes(path.posix.extname(url).toLowerCase())) return 'not a font resource';
  return null;
}

/** Check every path component; lstat prevents links, including a link to somewhere inside public/. */
export async function checkedAssetPath(publicDir, url, directoryChecks = new Map()) {
  const bad = assetCacheURLProblem(url);
  if (bad) throw new Error(bad);
  return checkedPublicPath(publicDir, url, directoryChecks, false);
}

/** A media directory can be safe/exist even when every declared file in it is missing. */
async function checkedAssetDirectory(publicDir, url, directoryChecks) {
  const bad = assetCacheURLProblem(`${url}/_directory_check.mp3`);
  if (bad) throw new Error(bad);
  return checkedPublicPath(publicDir, url, directoryChecks, true);
}

async function checkedPublicPath(publicDir, url, directoryChecks, directory) {
  const root = path.resolve(publicDir);
  const parts = url.slice(1).split('/');
  let current = root;
  for (let i = -1; i < parts.length; i++) {
    if (i >= 0) current = path.join(current, parts[i]);
    const last = i === parts.length - 1;
    const regularFile = last && !directory;
    let stat;
    if (!regularFile && directoryChecks.has(current)) stat = await directoryChecks.get(current);
    else {
      const promise = fsp.lstat(current);
      if (!regularFile) directoryChecks.set(current, promise);
      stat = await promise;
    }
    if (stat.isSymbolicLink()) throw new Error('symbolic link refused');
    if (regularFile ? !stat.isFile() : !stat.isDirectory()) throw new Error(regularFile ? 'not a regular file' : 'not a directory');
    if (last) return { filePath: current, stat };
  }
  throw new Error('not a file');
}

export async function hashAssetFile(filePath) {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of fs.createReadStream(filePath)) { hash.update(chunk); bytes += chunk.length; }
  return { bytes, sha256: hash.digest('hex') };
}

function collectURLs(node, urls, invalid) {
  if (typeof node === 'string') {
    if (!/^\/(?:assets|fonts)\//.test(node)) return;
    const bad = assetCacheURLProblem(node);
    if (bad) invalid.set(node, bad); else urls.add(node);
  } else if (node && typeof node === 'object') {
    for (const value of Object.values(node)) collectURLs(value, urls, invalid);
  }
}

function collectModelAtlases(node, atlases) {
  if (!node || typeof node !== 'object') return;
  // These are runtime Spine records returned by assets.spineEntry, rather than every extracted
  // TextAsset with an .atlas suffix. UI extraction also keeps unused source blobs.
  if (typeof node.skel === 'string' && typeof node.atlas === 'string') atlases.add(node.atlas);
  for (const value of Object.values(node)) collectModelAtlases(value, atlases);
}

const SAFE_ERRORS = new Set(['not an asset path', 'invalid path characters', 'unsafe path segment',
  'unsupported resource type', 'not a font resource', 'symbolic link refused', 'not a regular file',
  'not a directory', 'not a file', 'manifest is not a regular file', 'invalid manifest',
  'empty file', 'file changed during catalog build']);
const missingReason = (error) => error?.code === 'ENOENT' ? 'missing file'
  : error instanceof SyntaxError ? 'invalid JSON'
    : SAFE_ERRORS.has(error?.message) ? error.message : 'unreadable file';
const empty = (value) => value && typeof value === 'object' && !Array.isArray(value);

/**
 * Build once at boot (or explicitly after installing art), using at most `concurrency` streams.
 * Missing declared files are reported in `missing`; a server can still serve its usable files, while
 * the full-pack tool refuses a catalog whose `complete` is false. No absolute paths are disclosed.
 */
export async function createAssetCacheCatalog({ publicDir, dataDir, app, concurrency = 4 } = {}) {
  if (!publicDir || !dataDir) throw new Error('publicDir and dataDir are required');
  const urls = new Set();
  const invalid = new Map();
  const missing = new Map();
  const warnings = new Map();
  const dirs = new Map();
  const readManifest = async (name, optional) => {
    try {
      const target = path.join(dataDir, name);
      const stat = await fsp.lstat(target);
      if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('manifest is not a regular file');
      const manifest = JSON.parse(await fsp.readFile(target, 'utf8'));
      if (!empty(manifest)) throw new Error('invalid manifest');
      collectURLs(manifest, urls, invalid);
      return manifest;
    } catch (error) {
      if (!optional || error?.code !== 'ENOENT') missing.set(`/data/${name}`, `manifest: ${missingReason(error)}`);
      return null;
    }
  };
  const [standard, local] = await Promise.all([readManifest('assets.json', false), readManifest('local-assets.json', true)]);
  const modelAtlases = new Set();
  collectModelAtlases(standard, modelAtlases);
  // Optional runtime token/enemy models are reconstructed from local groups by spineEntry.
  for (const [group, records] of Object.entries(local?.groups || {})) {
    if (!group.startsWith('spine/')) continue;
    for (const record of Object.values(records || {})) {
      if (typeof record?.path === 'string' && record.path.endsWith('.atlas')) modelAtlases.add(record.path);
    }
  }

  // This runtime-only table is not listed by local extraction. Its PNG names resolve to the
  // corresponding manifest image (usually WebP), exactly as render/boardArt.sourceUrl does.
  const board = local?.groups?.['map/autochess'];
  const diffuse = board?.TX_autochessi_D?.path;
  if (typeof diffuse === 'string' && !assetCacheURLProblem(diffuse)) {
    const tilesURL = `${path.posix.dirname(diffuse)}/tiles.json`;
    urls.add(tilesURL);
    try {
      const { filePath } = await checkedAssetPath(publicDir, tilesURL, dirs);
      const tiles = JSON.parse(await fsp.readFile(filePath, 'utf8'));
      if (empty(tiles?.source)) for (const source of Object.values(tiles.source)) {
        if (typeof source?.path !== 'string') continue;
        const name = path.posix.basename(source.path).replace(/\.[^.]*$/, '');
        const sourceURL = board?.[name]?.path || source.path;
        const problem = assetCacheURLProblem(sourceURL);
        if (problem) invalid.set(sourceURL, problem); else urls.add(sourceURL);
      }
    } catch (error) { missing.set(tilesURL, missingReason(error)); }
  }

  // Follow page names only for registered runtime Spine models. Keep every explicitly listed
  // available file, including unused UI blobs; orphan source-atlas issues are advisory.
  for (const url of [...urls].filter((u) => u.endsWith('.atlas'))) {
    const runtimeModel = modelAtlases.has(url);
    try {
      const { filePath } = await checkedAssetPath(publicDir, url, dirs);
      const text = await fsp.readFile(filePath, 'utf8');
      const lines = text.replace(/\r/g, '').split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line || line.includes(':') || (i > 0 && lines[i - 1].trim())) continue;
        if (!/\.(?:png|jpe?g|webp|avif)$/i.test(line)) continue;
        if (line.startsWith('/') || line.split('/').some((s) => s === '..' || s === '.')) {
          (runtimeModel ? invalid : warnings).set(`${url} -> ${line}`, 'unsafe atlas page'); continue;
        }
        const page = `${path.posix.dirname(url)}/${line}`;
        const problem = assetCacheURLProblem(page);
        if (runtimeModel) {
          if (problem) invalid.set(page, problem); else urls.add(page);
        } else if (problem) warnings.set(page, `unused atlas: ${problem}`);
        else {
          try { await checkedAssetPath(publicDir, page, dirs); }
          catch (error) { warnings.set(page, `unused atlas dependency: ${missingReason(error)}`); }
        }
      }
    } catch (error) { missing.set(url, missingReason(error)); }
  }

  // The media resolver may choose an installed higher-priority extension that the manifest did
  // not list. Inspect only known audio directories/stems (never recursively scan unrelated art).
  const audioDirectories = new Map();
  for (const url of urls) {
    if (!url.startsWith('/assets/audio/')) continue;
    const ext = path.posix.extname(url).toLowerCase();
    if (!AUDIO_EXTS.includes(ext)) continue;
    const directory = path.posix.dirname(url);
    if (!audioDirectories.has(directory)) audioDirectories.set(directory, new Set());
    audioDirectories.get(directory).add(path.posix.basename(url).slice(0, -ext.length));
  }
  const directoryList = [...audioDirectories];
  for (let offset = 0; offset < directoryList.length; offset += 16) {
    await Promise.all(directoryList.slice(offset, offset + 16).map(async ([directory, stems]) => {
      try {
        // Check the directory independently of its declarations: a missing .ogg may still
        // resolve to an installed .mp3. Never readdir through a symlink component.
        const checked = await checkedAssetDirectory(publicDir, directory, dirs);
        const names = await fsp.readdir(checked.filePath, { withFileTypes: true });
        for (const entry of names) {
          if (!entry.isFile() && !entry.isSymbolicLink()) continue;
          const ext = path.posix.extname(entry.name).toLowerCase();
          if (!AUDIO_EXTS.includes(ext) || !stems.has(entry.name.slice(0, -ext.length))) continue;
          const url = `${directory}/${entry.name}`;
          const bad = assetCacheURLProblem(url);
          if (bad) invalid.set(url, bad); else urls.add(url);
        }
      } catch { /* Missing declared files are reported by the hash phase below. */ }
    }));
  }

  const wanted = [...urls].sort();
  const results = new Array(wanted.length);
  let next = 0;
  const workers = Math.max(1, Math.min(16, Math.floor(Number(concurrency) || 4)));
  await Promise.all(Array.from({ length: workers }, async () => {
    while (next < wanted.length) {
      const index = next++;
      const url = wanted[index];
      try {
        const { filePath, stat } = await checkedAssetPath(publicDir, url, dirs);
        if (!stat.size) throw new Error('empty file');
        const digest = await hashAssetFile(filePath);
        if (digest.bytes !== stat.size) throw new Error('file changed during catalog build');
        results[index] = { url, ...digest, type: ASSET_CACHE_MIME[path.posix.extname(url).toLowerCase()], aliases: [] };
      } catch (error) { missing.set(url, missingReason(error)); }
    }
  }));
  const files = results.filter(Boolean);
  // Both extension-less and explicit-extension routes use the real media resolver's priority.
  // If mp3 and ogg have the same stem, /media/x belongs to mp3; /media/x.ogg belongs to ogg.
  const audio = new Map();
  const byURL = new Map(files.map((file) => [file.url, file]));
  // Keep schema-1's plain file URLs and complete SHA-256 keys. A served manifest's hash path is an exact
  // alias of these bytes, not a normalization rule: an old page must never resolve a new hash via its old pin.
  for (const file of files) file.aliases.push(hashedPath(file.url, file.sha256.slice(0, 16)));
  const hashes = {
    hashOf: (rel) => byURL.get(`/${rel}`)?.sha256.slice(0, 16) || null,
    // Same ordered member hashes as assetIndex.modelHash; rewriteManifest supplies the canonical model lists.
    modelHash(rels) {
      const parts = rels.map((rel) => this.hashOf(rel));
      return parts.every(Boolean) ? createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 16) : null;
    },
  };
  for (const [name, manifest] of [['assets.json', standard], ['local-assets.json', local]]) {
    if (!manifest) continue;
    const { models } = rewriteManifest(manifest, name, hashes);
    for (const rels of models) {
      const hash = hashes.modelHash(rels);
      if (!hash) continue;
      for (const rel of rels) {
        const file = byURL.get(`/${rel}`);
        file?.aliases.push(hashedPath(file.url, hash));
      }
    }
  }
  const addMediaAlias = (file, url) => {
    if (!file) return;
    file.aliases.push(url, hashedPath(url, file.sha256.slice(0, 16)));
  };
  for (const url of wanted) {
    if (!url.startsWith('/assets/audio/')) continue;
    const ext = path.posix.extname(url).toLowerCase();
    if (!AUDIO_EXTS.includes(ext)) continue;
    // A declared miss does not exist for the resolver either; an empty/unreadable/symlink file
    // may win the server's lookup, but must never be silently replaced with different bytes.
    if (missing.get(url) === 'missing file') continue;
    const stem = url.slice('/assets/audio/'.length, -ext.length);
    if (!audio.has(stem)) audio.set(stem, new Map());
    audio.get(stem).set(ext, url);
  }
  for (const [stem, extensions] of audio) {
    const primaryURL = AUDIO_EXTS.map((ext) => extensions.get(ext)).find(Boolean);
    addMediaAlias(byURL.get(primaryURL), MEDIA_PREFIX + stem);
    for (const ext of AUDIO_EXTS) {
      const resolved = byURL.get(extensions.get(ext) || primaryURL);
      addMediaAlias(resolved, MEDIA_PREFIX + stem + ext);
    }
  }
  for (const file of files) file.aliases = [...new Set(file.aliases)].sort();
  const version = createHash('sha256').update(JSON.stringify({ schema: ASSET_CACHE_SCHEMA, files })).digest('hex');
  if (app === undefined) {
    try { app = JSON.parse(await fsp.readFile(path.join(publicDir, '..', 'package.json'), 'utf8')).version; }
    catch { app = ''; }
  }
  for (const [url, reason] of invalid) missing.set(url, reason);
  return {
    schema: ASSET_CACHE_SCHEMA, version, app: String(app || ''), files,
    totalBytes: files.reduce((sum, file) => sum + file.bytes, 0), totalFiles: files.length,
    complete: missing.size === 0 && files.length > 0,
    missing: [...missing].map(([url, reason]) => ({ url, reason })).sort((a, b) => a.url.localeCompare(b.url)),
    warnings: [...warnings].map(([url, reason]) => ({ url, reason })).sort((a, b) => a.url.localeCompare(b.url)),
  };
}

// Previous design notes used this name; keep the library interface unambiguous for tools.
export const buildAssetCatalog = createAssetCacheCatalog;
