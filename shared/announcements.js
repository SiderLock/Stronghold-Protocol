// shared/announcements.js — ordinary announcements: public metadata and browser display rules.
// No Node builtins: the server, publishing tool and browser use the same allowlist and index shape.

export const ANNOUNCEMENT_INDEX_FILE = 'index.json';
export const ANNOUNCEMENT_MAX_TITLE_LENGTH = 120;
export const ANNOUNCEMENT_MAX_BODY_CHARS = 50000;
export const ANNOUNCEMENT_MAX_BODY_BYTES = 128 * 1024;
export const ANNOUNCEMENT_MAX_INDEX_BYTES = 2 * 1024 * 1024;
export const ANNOUNCEMENT_MAX_ITEMS = 2000;

/** @typedef {{ id: string, title: string, publishedAt: string, revision: string }} AnnouncementMetadata */
/** @typedef {{ revision: string, pinnedId: string|null, items: AnnouncementMetadata[] }} AnnouncementIndex */

/** IDs are filenames on Windows too; never accept a path, extension or reserved device name. */
export function isAnnouncementId(value) {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(value)
    && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(value);
}

/** A publication has a persistent random revision, so a recreated directory cannot reuse a suppressed number. */
export function isAnnouncementRevision(value) {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,79}$/.test(value);
}

export function isAnnouncementTitle(value) {
  return typeof value === 'string' && value.trim() === value && value.length > 0
    && [...value].length <= ANNOUNCEMENT_MAX_TITLE_LENGTH && !/[\u0000-\u001f\u007f]/.test(value);
}

/** The canonical public date format is shared by the writer and all readers. */
export function isAnnouncementPublishedAt(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}

/**
 * Validate untrusted HTTP metadata and return a copy with only the public fields, or null.
 * The items are in publication order, newest first; dates never determine this order or suppression.
 * The latest publication revision survives deletion, even if no articles remain.
 * @param {any} raw
 * @returns {AnnouncementIndex|null}
 */
export function readAnnouncementIndex(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !Array.isArray(raw.items)
    || raw.items.length > ANNOUNCEMENT_MAX_ITEMS) return null;
  const ids = new Set();
  const revisions = new Set();
  /** @type {AnnouncementMetadata[]} */
  const items = [];
  for (const item of raw.items) {
    if (!item || typeof item !== 'object' || !isAnnouncementId(item.id) || !isAnnouncementTitle(item.title)
      || !isAnnouncementRevision(item.revision) || ids.has(item.id) || revisions.has(item.revision)
      || !isAnnouncementPublishedAt(item.publishedAt)) return null;
    ids.add(item.id); revisions.add(item.revision);
    items.push({ id: item.id, title: item.title, publishedAt: item.publishedAt, revision: item.revision });
  }
  if ((items.length || raw.revision !== '') && !isAnnouncementRevision(raw.revision)) return null;
  if (raw.pinnedId !== null && (!isAnnouncementId(raw.pinnedId) || !ids.has(raw.pinnedId))) return null;
  return { revision: raw.revision, pinnedId: raw.pinnedId, items };
}

/** The single pinned announcement wins, otherwise the most recently published one. @param {AnnouncementIndex|null} index */
export function defaultAnnouncementId(index) {
  return index?.pinnedId || index?.items?.[0]?.id || null;
}

/** Display the pinned article first without changing the persisted publication order.
 * @param {Pick<AnnouncementIndex, 'items'|'pinnedId'>} index
 * @returns {AnnouncementMetadata[]}
 */
export function announcementHistoryItems(index) {
  const pinned = index.items.find((item) => item.id === index.pinnedId);
  return pinned ? [pinned, ...index.items.filter((item) => item.id !== pinned.id)] : index.items.slice();
}

/** Suppression lasts until another publication, independent of the date, selected article or pinned ID. */
export function shouldShowAnnouncements(index, dismissedRevision) {
  return !!index?.items?.length && isAnnouncementRevision(index.revision) && dismissedRevision !== index.revision;
}
