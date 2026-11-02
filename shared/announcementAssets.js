// Announcement images have their own read-only endpoint and persistent directory, never a public/ mount.
// This module is shared by the Markdown renderer and HTTP route; paths are decoded exactly once per segment.

export const ANNOUNCEMENT_ASSET_URL_PREFIX = '/api/announcement-assets/';
export const ANNOUNCEMENT_ASSET_DIR = 'assets';
export const ANNOUNCEMENT_ASSET_MAX_BYTES = 16 * 1024 * 1024;
export const ANNOUNCEMENT_ASSET_MAX_URL_LENGTH = 4096;

export const ANNOUNCEMENT_ASSET_MIME = Object.freeze({
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
});

const RESERVED_DEVICE = /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])$/i;

/**
 * Parse only the raw suffix after ANNOUNCEMENT_ASSET_URL_PREFIX, never an absolute URL or leading slash.
 * Literal spaces/Chinese can be normalized by the renderer; HTTP URLs encode each returned segment.
 * @param {string} rawPath
 * @returns {string[]|null}
 */
export function announcementAssetSegments(rawPath) {
  if (typeof rawPath !== 'string' || rawPath.length === 0 || rawPath.length > ANNOUNCEMENT_ASSET_MAX_URL_LENGTH) return null;
  const rawSegments = rawPath.split('/');
  if (rawSegments.length > 32) return null;
  const segments = [];
  for (const raw of rawSegments) {
    let segment;
    try { segment = decodeURIComponent(raw); encodeURIComponent(segment); }
    catch { return null; }
    if (!segment || segment.length > 255 || segment.startsWith('.') || /[. ]$/.test(segment)
      || /[\\/<>:"|?*%\u0000-\u001f\u007f-\u009f]/.test(segment)
      || RESERVED_DEVICE.test(segment.split('.')[0].trim())) return null;
    segments.push(segment);
  }
  // Browser normalization can expand literal Chinese/emoji paths. Keep the complete encoded URL within the
  // HTTP request listener's limit so the renderer never emits a source that the server must reject with 414.
  if (ANNOUNCEMENT_ASSET_URL_PREFIX.length + segments.map(encodeURIComponent).join('/').length > ANNOUNCEMENT_ASSET_MAX_URL_LENGTH) return null;
  return segments;
}

/** Supported raster image extension only. Path safety is independently checked by announcementAssetSegments. */
export function announcementAssetMime(fileName) {
  if (typeof fileName !== 'string') return null;
  const dot = fileName.lastIndexOf('.');
  return dot > 0 ? ANNOUNCEMENT_ASSET_MIME[fileName.slice(dot).toLowerCase()] || null : null;
}
