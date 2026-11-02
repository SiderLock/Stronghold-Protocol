// Explicit online announcement notices. Publication and ordinary-popup suppression are separate mechanisms.
// Frames contain references only; clients load verified Markdown through the existing read-only HTTP endpoint.

import { isAnnouncementId, isAnnouncementRevision } from './announcements.js';

export const ANNOUNCEMENT_NOTICE_TYPE = 'announcement.notice';
export const ANNOUNCEMENT_NOTICE_TTL_MS = 5 * 60_000;
export const ANNOUNCEMENT_NOTICE_POLL_MS = 1000;
export const ANNOUNCEMENT_NOTICE_MAX_COMMAND_BYTES = 4096;

/** @typedef {{ id: string, revision: string, msgid: string, createdAt: number, expiresAt: number }} AnnouncementNotice */
/** @typedef {AnnouncementNotice & { t: string }} AnnouncementNoticeFrame */

/** A v4 UUID is both a message ID and the exact basename of its immutable command file. */
export function isAnnouncementNoticeId(value) {
  return typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
}

/** @param {any} raw @returns {AnnouncementNotice|null} */
function readNoticeMetadata(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !isAnnouncementId(raw.id)
    || !isAnnouncementRevision(raw.revision) || !isAnnouncementNoticeId(raw.msgid)
    || !Number.isSafeInteger(raw.createdAt) || raw.createdAt < 0
    || !Number.isSafeInteger(raw.expiresAt) || raw.expiresAt !== raw.createdAt + ANNOUNCEMENT_NOTICE_TTL_MS) return null;
  return { id: raw.id, revision: raw.revision, msgid: raw.msgid, createdAt: raw.createdAt, expiresAt: raw.expiresAt };
}

/** Validate the persistent command's structure, including expired commands for safe pruning. @param {any} raw */
export function readAnnouncementNoticeCommand(raw) {
  const notice = raw?.version === 1 ? readNoticeMetadata(raw) : null;
  return notice ? { version: 1, ...notice } : null;
}

/**
 * Validate a wire frame and its queue lifetime, then strip unknown fields.
 * No date of the referenced announcement or ordinary-popup suppression participates in this check.
 * @param {any} raw
 * @param {number} [now]
 * @returns {AnnouncementNoticeFrame|null}
 */
export function readAnnouncementNoticeFrame(raw, now = Date.now()) {
  const notice = raw?.t === ANNOUNCEMENT_NOTICE_TYPE ? readNoticeMetadata(raw) : null;
  return notice && Number.isFinite(now) && notice.createdAt <= now && now < notice.expiresAt
    ? { t: ANNOUNCEMENT_NOTICE_TYPE, ...notice } : null;
}
