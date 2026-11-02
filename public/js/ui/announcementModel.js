// Ordinary announcement state and asynchronous lifecycle, independent of the UI framework.
import {
  readAnnouncementIndex, defaultAnnouncementId, shouldShowAnnouncements, isAnnouncementRevision,
  ANNOUNCEMENT_MAX_BODY_CHARS,
} from '../../../shared/announcements.js';

export const ANNOUNCEMENT_STORAGE_KEY = 'sp.pref.announcements';

/** Each overlay gets its own mutable store state. */
export function createAnnouncementState() {
  return {
    open: false, loading: false, listError: null,
    detailLoading: false, detailError: null,
    revision: '', pinnedId: null, items: [], selectedId: null, detail: null,
    mobileView: 'detail', suppressed: false,
  };
}

/** Publication order comes from the service; dates and opaque revisions never reorder it. */
export function normalizeAnnouncementList(payload) {
  return readAnnouncementIndex(payload) || { revision: '', pinnedId: null, items: [] };
}

function defaultStorage() {
  try { return globalThis.localStorage; } catch { return null; }
}

function storedRevision(storage) {
  try {
    const value = JSON.parse(storage?.getItem(ANNOUNCEMENT_STORAGE_KEY) || 'null');
    return value?.v === 1 && isAnnouncementRevision(value.suppressedRevision) ? value.suppressedRevision : null;
  } catch { return null; }
}

/**
 * @param {{ target: {get: Function, set: Function, subscribe?: Function}, getContext: Function,
 *   fetchImpl?: Function, storage?: {getItem?: Function, setItem?: Function, removeItem?: Function}|null }} deps
 */
export function createAnnouncementController({ target, getContext, fetchImpl = globalThis.fetch, storage = defaultStorage() }) {
  if (!target?.get || !target?.set || typeof getContext !== 'function') throw new TypeError('Announcement store and context are required');
  let disposed = false;
  let listRequest = 0;
  let detailRequest = 0;
  let intentVersion = 0;
  let selectionVersion = 0;
  let suppressedRevision = storedRevision(storage);
  let pendingAuto = null;
  let openingIntent = null;
  const shownRevisions = new Set();
  const detailCache = new Map();

  const context = () => {
    try { return getContext() || { route: 'game', ready: false }; } catch { return { route: 'game', ready: false }; }
  };
  const ordinaryRoute = () => context().route !== 'game';
  const autoReady = () => { const c = context(); return c.ready === true && c.route !== 'game'; };
  const liveIntent = (version) => !disposed && version === intentVersion && ordinaryRoute();
  const currentIndex = () => {
    const s = target.get();
    return { revision: s.revision, pinnedId: s.pinnedId, items: s.items };
  };
  const itemFor = (id) => target.get().items.find((item) => item.id === id) || null;
  const cacheKey = (item) => `${item.id}:${item.revision}`;

  target.set({ suppressed: isAnnouncementRevision(target.get().revision) && suppressedRevision === target.get().revision });

  async function readJson(url) {
    if (typeof fetchImpl !== 'function') throw new Error('Fetch unavailable');
    const response = await fetchImpl(url, { cache: 'no-store' });
    if (!response?.ok) throw new Error('Announcement request failed');
    return response.json();
  }

  async function loadDetail(id, { showDetail = true } = {}) {
    const item = itemFor(id);
    if (disposed || !target.get().open || !ordinaryRoute() || !item) return target.get();
    const request = ++detailRequest;
    const version = intentVersion;
    const cached = detailCache.get(cacheKey(item));
    target.set({ selectedId: id, ...(showDetail ? { mobileView: 'detail' } : {}),
      detail: cached || null, detailLoading: !cached, detailError: null });
    if (cached) return target.get();
    try {
      const detail = await readJson(`/api/announcements/${encodeURIComponent(id)}`);
      const valid = readAnnouncementIndex({ revision: detail?.revision, pinnedId: null, items: [detail] });
      if (!valid || detail.id !== item.id || detail.revision !== item.revision || detail.title !== item.title
        || detail.publishedAt !== item.publishedAt || typeof detail.markdown !== 'string'
        || detail.markdown.length > ANNOUNCEMENT_MAX_BODY_CHARS) throw new Error('Invalid announcement detail');
      if (!liveIntent(version) || request !== detailRequest || !target.get().open || target.get().selectedId !== id) return target.get();
      const clean = { ...valid.items[0], markdown: detail.markdown };
      detailCache.set(cacheKey(item), clean);
      target.set({ detail: clean, detailLoading: false, detailError: null });
    } catch {
      if (liveIntent(version) && request === detailRequest && target.get().open && target.get().selectedId === id) {
        target.set({ detailLoading: false, detailError: 'DETAIL_UNAVAILABLE' });
      }
    }
    return target.get();
  }

  async function showAuto(version) {
    const index = currentIndex();
    if (!liveIntent(version) || !autoReady() || !shouldShowAnnouncements(index, suppressedRevision)
      || shownRevisions.has(index.revision)) return target.get();
    pendingAuto = null;
    shownRevisions.add(index.revision);
    const selected = target.get().open && itemFor(target.get().selectedId)
      ? target.get().selectedId : defaultAnnouncementId(index);
    target.set({ open: true, mobileView: 'detail' });
    return selected ? loadDetail(selected) : target.get();
  }

  async function refreshList({ auto = false, opening = null } = {}) {
    if (disposed || (auto && !ordinaryRoute())) return target.get();
    const request = ++listRequest;
    const version = opening?.version ?? intentVersion;
    if (auto) pendingAuto = null;
    target.set({ loading: true, listError: null });
    try {
      const payload = await readJson('/api/announcements');
      const index = readAnnouncementIndex(payload);
      if (!index) throw new Error('Invalid announcement list');
      if (disposed || request !== listRequest) return target.get();
      const state = target.get();
      const hasSelected = index.items.some((item) => item.id === state.selectedId);
      let selectedId = hasSelected ? state.selectedId : state.open ? defaultAnnouncementId(index) : null;
      const desired = openingIntent?.version === version ? openingIntent : opening;
      if (desired && liveIntent(version) && state.open && desired.selection === selectionVersion) {
        selectedId = index.items.some((item) => item.id === desired.id) ? desired.id : defaultAnnouncementId(index);
      }
      if (openingIntent?.version === version) openingIntent = null;
      const suppressed = isAnnouncementRevision(index.revision) && suppressedRevision === index.revision;
      target.set({ ...index, loading: false, listError: null, selectedId, suppressed,
        ...(selectedId ? {} : { detail: null, detailLoading: false, detailError: null }) });
      if (auto && liveIntent(version) && shouldShowAnnouncements(index, suppressedRevision) && !shownRevisions.has(index.revision)) {
        pendingAuto = { version, revision: index.revision };
        if (autoReady()) return showAuto(version);
      }
      if (liveIntent(version) && target.get().open && selectedId) {
        shownRevisions.add(index.revision);
        return loadDetail(selectedId, { showDetail: selectedId !== state.selectedId });
      }
    } catch {
      if (!disposed && request === listRequest) {
        target.set({ loading: false, listError: auto ? null : 'LIST_UNAVAILABLE' });
      }
    }
    return target.get();
  }

  function close() {
    if (disposed) return;
    intentVersion++;
    detailRequest++;
    pendingAuto = null;
    openingIntent = null;
    target.set({ open: false, loading: false, detailLoading: false });
  }

  return {
    refresh: (options = {}) => refreshList(options),
    open(id = null) {
      if (disposed || !ordinaryRoute()) return Promise.resolve(target.get());
      const version = ++intentVersion;
      detailRequest++;
      pendingAuto = null;
      openingIntent = { version, id, selection: selectionVersion };
      const selectedId = itemFor(id) ? id : defaultAnnouncementId(currentIndex());
      const selected = itemFor(selectedId);
      target.set({ open: true, loading: true, listError: null, selectedId,
        detail: selected ? detailCache.get(cacheKey(selected)) || null : null,
        detailLoading: false, detailError: null, mobileView: 'detail' });
      return refreshList({ opening: openingIntent });
    },
    close,
    select(id) {
      if (disposed || !target.get().open || !ordinaryRoute() || !itemFor(id)) return Promise.resolve(target.get());
      selectionVersion++;
      return loadDetail(id);
    },
    setSuppressed(value) {
      if (disposed) return;
      const revision = target.get().revision;
      suppressedRevision = value && isAnnouncementRevision(revision) ? revision : null;
      target.set({ suppressed: suppressedRevision !== null });
      try {
        if (suppressedRevision === null && typeof storage?.removeItem === 'function') storage.removeItem(ANNOUNCEMENT_STORAGE_KEY);
        else storage?.setItem(ANNOUNCEMENT_STORAGE_KEY, JSON.stringify({ v: 1, suppressedRevision }));
      } catch { /* Preferences remain usable in this page when storage is unavailable. */ }
    },
    contextChanged() {
      if (disposed) return Promise.resolve(target.get());
      if (!ordinaryRoute()) { close(); return Promise.resolve(target.get()); }
      if (pendingAuto && pendingAuto.revision === target.get().revision && autoReady()) return showAuto(pendingAuto.version);
      return Promise.resolve(target.get());
    },
    dispose() {
      if (disposed) return;
      close();
      disposed = true;
      listRequest++;
      detailCache.clear();
    },
  };
}
