#!/usr/bin/env node
// i18n-ignore-file: this owner CLI intentionally reports operational results in Chinese.
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createAssetCacheCatalog, checkedAssetPath, assetCacheURLProblem } from '../server/assetCacheCatalog.js';
import { validateAssetCatalog, verifyAssetCatalog, MAX_MANIFEST_BYTES } from '../shared/assetCache.js';
import { writeAssetZip } from './asset-cache/zip.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ASSET_CACHE_PACK_MANIFEST = 'manifest.json';

/** Only a complete catalog can be described as a full distribution package. */
export function assetCachePackManifest(catalog) {
  if (!catalog?.complete || catalog.missing?.length || !catalog.files?.length) {
    const detail = catalog?.missing?.map((item) => `${item.url}：${item.reason}`).join('\n') || '没有可打包素材';
    throw new Error(`素材清单不完整，拒绝生成完整包：\n${detail}`);
  }
  const hex = /^[0-9a-f]{64}$/;
  if (catalog.schema !== 1 || !hex.test(catalog.version) || catalog.totalFiles !== catalog.files.length) throw new Error('素材清单格式或总数无效');
  const names = new Set();
  let totalBytes = 0;
  for (const file of catalog.files) {
    if (assetCacheURLProblem(file.url) || names.has(file.url) || !Number.isSafeInteger(file.bytes)
      || file.bytes <= 0 || !hex.test(file.sha256) || typeof file.type !== 'string' || !Array.isArray(file.aliases)) throw new Error('素材清单文件条目无效');
    names.add(file.url); totalBytes += file.bytes;
  }
  const version = createHash('sha256').update(JSON.stringify({ schema: catalog.schema, files: catalog.files })).digest('hex');
  if (catalog.totalBytes !== totalBytes || catalog.version !== version) throw new Error('素材清单总量或内容版本无效');
  validateAssetCatalog(catalog);
  const manifest = {
    schema: catalog.schema, version: catalog.version, app: catalog.app,
    totalFiles: catalog.totalFiles, totalBytes: catalog.totalBytes,
    files: catalog.files, complete: true, missing: [], warnings: catalog.warnings || [],
  };
  if (Buffer.byteLength(JSON.stringify(manifest) + '\n', 'utf8') > MAX_MANIFEST_BYTES) throw new Error('素材目录超过浏览器可导入的大小限制');
  return manifest;
}

async function readBaseCatalog(value) {
  if (typeof value !== 'string') return value;
  const handle = await fsp.open(value, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > MAX_MANIFEST_BYTES) throw new Error('基线目录必须为大小合法的 JSON 文件');
    // One extra byte detects a concurrent file growth without allocating an unbounded read buffer.
    const buffer = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset !== stat.size) throw new Error('基线目录在读取期间发生变化');
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, offset)));
  } finally { await handle.close(); }
}

/** Both package kinds embed the exact current full catalog; only resource bodies differ. */
export async function planAssetCachePack({ catalog, delta = false, baseCatalog } = {}) {
  const manifest = assetCachePackManifest(catalog);
  if (!delta && baseCatalog !== undefined && baseCatalog !== '') throw new Error('--base-catalog 只能与 --delta 一起使用');
  if (!delta) return { manifest, files: manifest.files, delta: false, baseVersion: null,
    packedFiles: manifest.totalFiles, packedBytes: manifest.totalBytes };
  if (!baseCatalog) throw new Error('--delta 需要 --base-catalog 指定旧完整目录 JSON');
  const base = await verifyAssetCatalog(await readBaseCatalog(baseCatalog));
  if (!base.complete || base.missing.length) throw new Error('基线目录不完整，不能生成可靠的增量包');
  if (base.version === manifest.version) throw new Error('基线目录与当前目录版本相同，无需生成增量包');
  // Browser storage is addressed by SHA and size, not URL: renamed files/aliases reuse old bytes.
  const known = new Set(base.files.map((file) => `${file.sha256}:${file.bytes}`));
  const files = manifest.files.filter((file) => {
    const key = `${file.sha256}:${file.bytes}`;
    if (known.has(key)) return false;
    known.add(key); return true;
  });
  // Deletion or alias-only updates deliberately produce a manifest-only ZIP.
  return { manifest, files, delta: true, baseVersion: base.version, packedFiles: files.length,
    packedBytes: files.reduce((sum, file) => sum + file.bytes, 0) };
}

/** No staging copy or archiver dependency: stream/hash/deflate one resource at a time. */
export async function packAssetCache({ root = REPO, out, catalog, delta = false, baseCatalog, onProgress = () => {} } = {}) {
  const publicDir = path.join(root, 'public');
  const source = catalog || await createAssetCacheCatalog({ publicDir, dataDir: path.join(root, 'data') });
  const plan = await planAssetCachePack({ catalog: source, delta, baseCatalog });
  const { manifest } = plan;
  const destination = path.resolve(out || path.join(root, '.cache', 'asset-cache-pack'));
  const stat = await fsp.lstat(destination).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (stat?.isSymbolicLink() || (stat && !stat.isDirectory())) throw new Error('输出位置必须为普通目录');
  await fsp.mkdir(destination, { recursive: true });
  const fileName = delta ? `Stronghold-Protocol-assets-delta-${plan.baseVersion.slice(0, 12)}-to-${source.version.slice(0, 12)}.zip`
    : `Stronghold-Protocol-assets-${source.version.slice(0, 12)}.zip`;
  const zipPath = path.join(destination, fileName);
  // Exclusive creation refuses accidental replacement; a different content version gets a different name.
  const temporary = `${zipPath}.part`;
  let handle;
  let opened = false;
  try {
    if (await fsp.lstat(zipPath).then(() => true, (error) => { if (error.code === 'ENOENT') return false; throw error; })) {
      throw new Error(`素材包已存在：${zipPath}`);
    }
    handle = await fsp.open(temporary, 'wx');
    opened = true;
    const entries = [{ name: ASSET_CACHE_PACK_MANIFEST, data: Buffer.from(JSON.stringify(manifest) + '\n', 'utf8') }];
    // Re-check immediately before use, including symlink components. The writer compares hashes again.
    for (const file of plan.files) {
      const { filePath } = await checkedAssetPath(publicDir, file.url);
      entries.push({ name: file.url.slice(1), filePath, bytes: file.bytes, sha256: file.sha256 });
    }
    let done = 0;
    const result = await writeAssetZip(handle, entries, { onEntry: (entry) => {
      if (entry.name === ASSET_CACHE_PACK_MANIFEST) return;
      return onProgress({ ...entry, done: ++done, total: plan.packedFiles });
    } });
    await handle.sync();
    await handle.close(); handle = null;
    // hard-link publishing is atomic and cannot overwrite an existing package on either OS.
    await fsp.link(temporary, zipPath);
    return { zipPath, zipBytes: result.bytes, totalFiles: source.totalFiles, totalBytes: source.totalBytes,
      version: source.version, delta: plan.delta, baseVersion: plan.baseVersion, packedFiles: plan.packedFiles, packedBytes: plan.packedBytes };
  } finally {
    if (handle) await handle.close();
    // Never delete a stale .part belonging to another invocation; only remove our opened file.
    if (opened) await fsp.unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  }
}

/** Export the same full directory without rewriting an already distributed ZIP. */
export async function exportAssetCacheCatalog({ root = REPO, out, catalog } = {}) {
  const source = catalog || await createAssetCacheCatalog({ publicDir: path.join(root, 'public'), dataDir: path.join(root, 'data') });
  const manifest = assetCachePackManifest(source);
  const destination = path.resolve(out || path.join(root, '.cache', 'asset-cache-pack'));
  const stat = await fsp.lstat(destination).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
  if (stat?.isSymbolicLink() || stat && !stat.isDirectory()) throw new Error('输出位置必须为普通目录');
  await fsp.mkdir(destination, { recursive: true });
  const catalogPath = path.join(destination, `Stronghold-Protocol-catalog-${source.version.slice(0, 12)}.json`);
  const temporary = `${catalogPath}.part`;
  const body = Buffer.from(JSON.stringify(manifest) + '\n', 'utf8');
  let handle;
  let opened = false;
  try {
    handle = await fsp.open(temporary, 'wx'); opened = true;
    await handle.writeFile(body); await handle.sync();
    await handle.close(); handle = null;
    await fsp.link(temporary, catalogPath);
    return { catalogPath, catalogBytes: body.length, totalFiles: source.totalFiles, totalBytes: source.totalBytes, version: source.version };
  } finally {
    if (handle) await handle.close();
    if (opened) await fsp.unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  }
}

export function parseAssetCachePackArgs(argv) {
  const options = { root: REPO, out: '', dryRun: false, catalogOnly: false, delta: false, baseCatalog: '', help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--catalog-only') options.catalogOnly = true;
    else if (arg === '--delta') options.delta = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--root' || arg === '--out' || arg === '--base-catalog') {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error(`${arg} 需要${arg === '--base-catalog' ? ' JSON 文件' : '目录'}路径`);
      options[arg === '--base-catalog' ? 'baseCatalog' : arg.slice(2)] = path.resolve(value);
    } else throw new Error(`未知参数：${arg}`);
  }
  if (!options.help) {
    if (options.delta && options.catalogOnly) throw new Error('--delta 与 --catalog-only 不能同时使用');
    if (options.delta && !options.baseCatalog) throw new Error('--delta 需要 --base-catalog 指定旧完整目录 JSON');
    if (options.baseCatalog && !options.delta) throw new Error('--base-catalog 只能与 --delta 一起使用');
  }
  return options;
}

const MiB = (bytes) => `${(bytes / 1048576).toFixed(2)} MiB`;
export async function main(argv) {
  if (process.platform === 'win32' && (process.stdout.isTTY || process.stderr.isTTY)) {
    try { spawnSync('cmd.exe', ['/d', '/c', 'chcp', '65001'], { stdio: 'ignore', windowsHide: true, timeout: 1000 }); }
    catch { /* Redirected Node output is already UTF-8. */ }
  }
  try {
    const options = parseAssetCachePackArgs(argv);
    if (options.help) {
      console.log('用法：node tools/asset-cache-pack.mjs [--dry-run | --catalog-only | --delta --base-catalog 旧目录.json] [--out 输出目录] [--root 项目目录]');
      console.log('完整包和增量包均内置当前完整 manifest.json；增量只含旧完整目录中不存在的素材内容，新玩家仍需基础素材。');
      return 0;
    }
    console.log('读取素材清单并计算逐文件 SHA-256…');
    const catalog = await createAssetCacheCatalog({ publicDir: path.join(options.root, 'public'), dataDir: path.join(options.root, 'data') });
    console.log(`素材：${catalog.totalFiles} 个文件，${MiB(catalog.totalBytes)}，版本 ${catalog.version.slice(0, 12)}`);
    const plan = await planAssetCachePack({ catalog, delta: options.delta, baseCatalog: options.baseCatalog });
    for (const warning of catalog.warnings || []) console.log(`提示（不影响完整性）：${warning.url}：${warning.reason}`);
    if (options.delta) console.log(`增量：${plan.packedFiles} 个素材内容，${MiB(plan.packedBytes)}；包含当前完整目录，基线 ${plan.baseVersion.slice(0, 12)}`);
    if (options.dryRun) { console.log('清单完整；仅核对，未生成文件。'); return 0; }
    if (options.catalogOnly) {
      const result = await exportAssetCacheCatalog({ ...options, catalog });
      console.log(`独立目录：${result.catalogPath}\n目录大小：${MiB(result.catalogBytes)}；可在预缓存窗口单独导入，无需重新生成完整 ZIP。`);
      return 0;
    }
    const result = await packAssetCache({ ...options, catalog, onProgress: ({ done, total }) => {
      if (done % 500 === 0 || done === total) console.log(`打包进度：${done}/${total}`);
    } });
    console.log(`${options.delta ? '增量包' : '完整包'}：${result.zipPath}\n压缩后：${MiB(result.zipBytes)}；仅素材及当前完整校验目录，不含服务器程序或私人数据。`);
    return 0;
  } catch (error) { console.error(`素材打包失败：${error.message}`); return 1; }
}

// Node writes UTF-8 to pipes and Windows terminals; launch.cmd already selects the UTF-8 code page.
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = await main(process.argv.slice(2));
}
