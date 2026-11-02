// server/http/announcementAssets.js — ordinary and urgent announcement image reads share this dedicated mount.
// Only bounded raster files under the configured announcement storage's assets/ directory can be served.
// i18n-ignore-file: operator diagnostics, no player-facing text

import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  ANNOUNCEMENT_ASSET_DIR, ANNOUNCEMENT_ASSET_MAX_BYTES, announcementAssetSegments, announcementAssetMime,
} from '../../shared/announcementAssets.js';
import { GzipCache, serveFile } from './files.js';
import { sendJson } from './common.js';

const gzipCache = new GzipCache(); // All allowed images are non-compressible; kept for serveFile's shared interface.

function inside(root, file) {
  const relative = path.relative(root, file);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** Resolve with both lexical and real boundaries, rejecting symlinks at the assets root and every descendant. */
async function resolveAsset(dir, segments) {
  const storage = await fsp.realpath(dir);
  const root = path.join(dir, ANNOUNCEMENT_ASSET_DIR);
  const rootStat = await fsp.lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return null;
  const realRoot = await fsp.realpath(root);
  if (!inside(storage, realRoot)) return null;
  let file = root;
  let stat;
  for (let i = 0; i < segments.length; i++) {
    file = path.join(file, segments[i]);
    stat = await fsp.lstat(file);
    if (stat.isSymbolicLink() || (i < segments.length - 1 ? !stat.isDirectory() : !stat.isFile())) return null;
    const real = await fsp.realpath(file);
    if (!inside(realRoot, real) || path.basename(real).startsWith('.')) return null;
    file = real;
  }
  if (!stat || stat.size > ANNOUNCEMENT_ASSET_MAX_BYTES || !announcementAssetMime(path.basename(file))) return null;
  return { file, stat };
}

/**
 * Route caller already enforces GET/HEAD and security headers. Failed lookups never expose local paths.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {string} rawSuffix
 * @param {import('../announcements.js').AnnouncementStore|undefined} announcements
 * @param {{ debug?: Function, warn?: Function }} [log]
 */
export async function serveAnnouncementAsset(req, res, rawSuffix, announcements, log = {}) {
  const segments = announcementAssetSegments(rawSuffix);
  const mime = segments && announcementAssetMime(segments[segments.length - 1]);
  let asset;
  if (mime && typeof announcements?.dir === 'string') {
    try { asset = await resolveAsset(announcements.dir, segments); }
    catch (error) {
      if (!['ENOENT', 'ENOTDIR', 'ENAMETOOLONG', 'ELOOP', 'EINVAL', 'EACCES', 'EPERM'].includes(error.code)) {
        log.warn?.('[announcement-assets] image lookup failed', error);
      }
    }
  }
  if (!asset) { sendJson(req, res, 404, { error: 'ANNOUNCEMENT_ASSET_NOT_FOUND' }); return; }
  // Same-name images can be corrected while the server runs. Ignore query cache-busters so ?v never grants
  // immutable caching; ETag and Last-Modified still provide cheap revalidation and HEAD uses identical headers.
  await serveFile(req, res, asset.file, asset.stat, 'announcement-assets', segments, '', gzipCache, log);
}
