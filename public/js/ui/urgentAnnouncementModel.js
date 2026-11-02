// Explicit urgent notices have their own queue and acknowledgement lifecycle.
// Once displayed, a notice stays open until acknowledged; TTL only gates receipt and queued entries.
import { readAnnouncementNoticeFrame } from '../../../shared/announcementNotices.js';
import { readAnnouncementIndex, ANNOUNCEMENT_MAX_BODY_CHARS } from '../../../shared/announcements.js';

/** Each urgent overlay gets an independent state; remaining includes the displayed notice. */
export function createUrgentAnnouncementState() {
  return { open: false, notice: null, detail: null, loading: false, error: null, queue: [], remaining: 0 };
}

/**
 * @param {{ target: {get: Function, set: Function}, fetchImpl?: Function, now?: Function,
 *   timers?: {setTimeout: Function, clearTimeout: Function}, maxQueue?: number, maxSeen?: number }} deps
 */
export function createUrgentAnnouncementController({
  target, fetchImpl = globalThis.fetch, now = Date.now, timers = globalThis, maxQueue = 32, maxSeen = 256,
}) {
  if (typeof target?.get !== 'function' || typeof target?.set !== 'function' || typeof now !== 'function'
    || typeof timers?.setTimeout !== 'function' || typeof timers?.clearTimeout !== 'function'
    || !Number.isSafeInteger(maxQueue) || maxQueue < 1 || !Number.isSafeInteger(maxSeen) || maxSeen < 1) {
    throw new TypeError('Urgent announcement store, clock, timers and positive limits are required');
  }
  let disposed = false;
  let active = null;
  let queue = [];
  let cleanupTimer = null;
  let detailRequest = 0;
  let detailAbort = null;
  const seen = new Map();

  function publish(patch = {}) {
    target.set({ ...patch, queue: queue.slice(), remaining: queue.length + (active ? 1 : 0) });
  }

  function invalidateDetail() {
    detailRequest++;
    detailAbort?.abort();
    detailAbort = null;
  }

  function prune(timestamp) {
    for (const [msgid, expiresAt] of seen) if (expiresAt <= timestamp) seen.delete(msgid);
    const before = queue.length;
    queue = queue.filter((notice) => notice.expiresAt > timestamp);
    return before !== queue.length;
  }

  function scheduleCleanup() {
    if (cleanupTimer !== null) timers.clearTimeout(cleanupTimer);
    cleanupTimer = null;
    if (disposed || !seen.size) return;
    const deadline = Math.min(...seen.values());
    cleanupTimer = timers.setTimeout(() => {
      cleanupTimer = null;
      expire();
    }, Math.max(0, deadline - now()));
    cleanupTimer?.unref?.();
  }

  async function loadDetail(notice) {
    if (disposed || !notice || active !== notice) return target.get();
    invalidateDetail();
    const request = detailRequest;
    const abort = typeof globalThis.AbortController === 'function' ? new globalThis.AbortController() : null;
    detailAbort = abort;
    publish({ loading: true, error: null });
    if (disposed || active !== notice || request !== detailRequest) return target.get();
    try {
      if (typeof fetchImpl !== 'function') throw new Error('Fetch unavailable');
      const response = await fetchImpl(`/api/announcements/${encodeURIComponent(notice.id)}`, {
        cache: 'no-store', ...(abort ? { signal: abort.signal } : {}),
      });
      if (!response?.ok) throw new Error('Urgent announcement request failed');
      const detail = await response.json();
      const valid = readAnnouncementIndex({ revision: detail?.revision, pinnedId: null, items: [detail] });
      if (!valid || detail.id !== notice.id || detail.revision !== notice.revision
        || typeof detail.markdown !== 'string' || detail.markdown.length > ANNOUNCEMENT_MAX_BODY_CHARS) {
        throw new Error('Invalid urgent announcement detail');
      }
      if (disposed || active !== notice || request !== detailRequest) return target.get();
      detailAbort = null;
      publish({ detail: { ...valid.items[0], markdown: detail.markdown }, loading: false, error: null });
    } catch {
      if (!disposed && active === notice && request === detailRequest) {
        detailAbort = null;
        publish({ loading: false, error: 'DETAIL_UNAVAILABLE' });
      }
    }
    return target.get();
  }

  function activate(notice) {
    invalidateDetail();
    active = notice;
    publish({ open: !!notice, notice, detail: null, loading: !!notice, error: null });
    scheduleCleanup();
    if (notice) void loadDetail(notice);
  }

  function expire() {
    if (disposed) return;
    if (prune(now())) publish();
    scheduleCleanup();
  }

  return {
    receive(frame) {
      if (disposed) return false;
      const timestamp = now();
      const notice = readAnnouncementNoticeFrame(frame, timestamp);
      const changed = prune(timestamp);
      // Never evict an unexpired msgid to make room: duplicate protection remains intact under floods.
      if (!notice || seen.has(notice.msgid) || seen.size >= maxSeen
        || queue.length + (active ? 1 : 0) >= maxQueue) {
        if (changed) publish();
        scheduleCleanup();
        return false;
      }
      seen.set(notice.msgid, notice.expiresAt);
      if (active) {
        queue.push(notice);
        publish();
        scheduleCleanup();
      } else activate(notice);
      return true;
    },
    close() {
      if (disposed || !active) return;
      const timestamp = now();
      prune(timestamp);
      // Revalidate queued entries when they become visible, independently of the receipt check.
      let next = null;
      while (queue.length && !next) next = readAnnouncementNoticeFrame(queue.shift(), timestamp);
      activate(next);
    },
    retry() {
      if (disposed || !active) return Promise.resolve(target.get());
      expire();
      return loadDetail(active);
    },
    expire,
    dispose() {
      if (disposed) return;
      disposed = true;
      invalidateDetail();
      if (cleanupTimer !== null) timers.clearTimeout(cleanupTimer);
      cleanupTimer = null;
      queue = [];
      active = null;
      seen.clear();
      target.set(createUrgentAnnouncementState());
    },
  };
}
