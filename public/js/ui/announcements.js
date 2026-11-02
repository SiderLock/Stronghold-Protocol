// Ordinary announcement viewer. The global host lives beside the existing Modal hosts; title/lobby buttons use
// openAnnouncements(). Publication and storage rules are in announcementModel.js. Match entry invalidates ordinary
// open requests, and restoring a session waits for the same grace period as main.js before any automatic display.

import { useEffect, useLayoutEffect, useRef } from '../../vendor/hooks.module.js';
import { html, Modal, Button, Icon, Spinner } from './components.js';
import { createStore, store, useStore, selectRoute as appRoute } from '../store.js';
import { t } from '../../../shared/i18n.js';
import { createAnnouncementState, createAnnouncementController } from './announcementModel.js';
import { AnnouncementMarkdown } from './announcementMarkdown.js';
import { announcementHistoryItems } from '../../../shared/announcements.js';

export const ANNOUNCEMENT_POLL_MS = 60_000;
export const ANNOUNCEMENT_MOUNT_DELAY_MS = 120;
export const ANNOUNCEMENT_RESTORE_GRACE_MS = 1500;

const cx = (...parts) => parts.filter(Boolean).join(' ');
export const announcementStore = createStore(createAnnouncementState());
let hostCount = 0;
let installation = null;
let contextProvider = () => ({ route: appRoute(store.get()), ready: true });

// Access localStorage lazily: its getter itself can throw in private / blocked-storage contexts.
const browserStorage = {
  getItem: (key) => { try { return globalThis.localStorage?.getItem(key) ?? null; } catch { return null; } },
  setItem: (key, value) => { try { globalThis.localStorage?.setItem(key, value); } catch { /* disabled / full */ } },
  removeItem: (key) => { try { globalThis.localStorage?.removeItem(key); } catch { /* disabled */ } },
};

export const announcementController = createAnnouncementController({
  target: announcementStore,
  getContext: () => contextProvider(),
  fetchImpl: (...args) => globalThis.fetch(...args),
  storage: browserStorage,
});

/** Open from an explicit user action. Stored automatic-display suppression never blocks this button. */
export const openAnnouncements = (id) => announcementController.open(id);
export const closeAnnouncements = () => announcementController.close();

/** Standard announcement entry, used on the title and lobby. */
export function AnnouncementButton({ class: cls, size = 'sm', variant = 'ghost', label = t('公告'), square = false }) {
  return html`<${Button} variant=${variant} size=${size} icon="info" square=${square}
      class=${cx('announcement-btn', cls)} title=${t('公告')} aria-label=${t('公告')}
      data-testid="announcements-open" onClick=${() => openAnnouncements()}>${square ? null : label}<//>`;
}

/** Display the declared publication date in the server's ISO metadata, independently of publication revision. */
export function announcementDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) ? value.slice(0, 10) : '';
}

/** Move focus only when a view switch hid its previously focused control. Visible controls keep their focus. */
export function focusAnnouncementView(root, previousFocus, view) {
  const doc = root?.ownerDocument;
  const visible = (element) => !!element && element.isConnected !== false && element.getClientRects?.().length > 0;
  if (!doc || !previousFocus || !root.contains(previousFocus) || visible(previousFocus)) return false;
  const active = doc.activeElement;
  if (active && root.contains(active) && visible(active)) return false;
  if (active && active !== previousFocus && active !== doc.body) return false;
  const selectors = view === 'list'
    ? ['.announcements__item.is-selected', '.announcements__item', '[data-autofocus]']
    : ['.announcements__back', '.announcements__body', '[data-autofocus]'];
  const next = selectors.map((selector) => root.querySelector(selector)).find(visible);
  if (!next) return false;
  next.focus({ preventScroll: true });
  return true;
}

const viewActions = {
  ...announcementController,
  showList: () => announcementStore.set({ mobileView: 'list' }),
  showDetail: () => announcementStore.set({ mobileView: 'detail' }),
};

/** Separate view for the same state on desktop and mobile; neither scroll region scrolls the modal footer. */
export function AnnouncementDialog({ state, actions = viewActions, bodyRef, onViewAction }) {
  const selected = state.items.find((item) => item.id === state.selectedId) || null;
  const detail = state.detail?.id === state.selectedId ? state.detail : null;
  const title = detail?.title || selected?.title || t('公告详情');
  const date = detail?.publishedAt || selected?.publishedAt || '';
  const pin = state.selectedId && state.selectedId === state.pinnedId;
  const suppressDisabled = !state.revision || !state.items.length;
  const footer = html`<div class="announcements__preferences">
      <label class=${cx('announcements__suppress', suppressDisabled && 'is-disabled')}>
        <input type="checkbox" checked=${state.suppressed} disabled=${suppressDisabled}
          onChange=${(event) => actions.setSuppressed(event.currentTarget.checked)} />
        <span>${t('下次不再显示')}</span>
      </label>
      <span class="announcements__preference-hint">${t('发布新公告后重新提醒')}</span>
    </div>
    <div class="announcements__footer-buttons">
      <${Button} variant="ghost" size="sm" icon="refresh" loading=${state.loading}
        onClick=${() => actions.refresh()}>${t('刷新')}<//>
      <${Button} variant="primary" size="sm" data-autofocus onClick=${() => actions.close()}>${t('关闭')}<//>
    </div>`;
  return html`<${Modal} open=${state.open} title=${t('公告')} micro="ANNOUNCEMENTS"
      class="announcements" onClose=${() => actions.close()} actions=${footer}>
    <div class=${cx('announcements__layout', state.mobileView === 'list' ? 'is-list' : 'is-detail')}>
      <aside class="announcements__history" aria-label=${t('历史公告')}>
        <div class="announcements__history-head">
          <h3>${t('历史公告')}</h3>
          ${selected ? html`<${Button} class="announcements__mobile-toggle" variant="ghost" size="sm"
            iconRight="chevronRight" onClick=${(event) => { onViewAction?.(event?.currentTarget); actions.showDetail(); }}>${t('返回正文')}<//>` : null}
        </div>
        <nav class="announcements__history-scroll" aria-label=${t('公告列表')}>
          ${announcementHistoryItems(state).map((item) => html`<button type="button" key=${item.id}
              class=${cx('announcements__item', item.id === state.selectedId && 'is-selected')}
              aria-current=${item.id === state.selectedId ? 'true' : undefined}
              onClick=${(event) => { onViewAction?.(event?.currentTarget); actions.select(item.id); }} data-announcement-id=${item.id}>
            <span class="announcements__item-title">${item.title}</span>
            <span class="announcements__item-meta">
              <time dateTime=${item.publishedAt}>${announcementDate(item.publishedAt)}</time>
              ${item.id === state.pinnedId ? html`<span class="announcements__pin">${t('置顶')}</span>` : null}
            </span>
          </button>`)}
          ${!state.items.length && state.loading ? html`<div class="announcements__status"><${Spinner} size="sm" label=${t('正在加载公告')} /></div>` : null}
          ${!state.items.length && !state.loading && !state.listError ? html`<p class="announcements__empty">${t('暂无公告')}</p>` : null}
          ${state.listError ? html`<p class="announcements__list-warning" role="status">${t('公告列表加载失败，请重试')}</p>` : null}
        </nav>
      </aside>
      <section class="announcements__detail" aria-labelledby="announcement-article-title">
        <div class="announcements__article-head">
          <${Button} class="announcements__mobile-toggle announcements__back" variant="ghost" size="sm"
            icon="chevronLeft" onClick=${(event) => { onViewAction?.(event?.currentTarget); actions.showList(); }}>${t('历史公告')}<//>
          <div class="announcements__article-heading">
            <h3 id="announcement-article-title">${title}</h3>
            ${selected ? html`<div class="announcements__article-meta">
              <time dateTime=${date}>${announcementDate(date)}</time>
              ${pin ? html`<span class="announcements__pin">${t('置顶')}</span>` : null}
            </div>` : null}
          </div>
        </div>
        <div ref=${bodyRef} class="announcements__body" tabIndex="0" aria-busy=${state.detailLoading ? 'true' : undefined}>
          ${state.detailLoading ? html`<div class="announcements__status"><${Spinner} size="sm" label=${t('正在加载公告正文')} /></div>`
            : state.detailError ? html`<div class="announcements__status" role="status">
                <${Icon} name="warn" /><p>${t('公告正文加载失败，请重试')}</p>
                <${Button} size="sm" icon="refresh" onClick=${() => actions.select(state.selectedId)}>${t('重试')}<//>
              </div>`
            : detail ? html`<${AnnouncementMarkdown} source=${detail.markdown} />`
            : html`<p class="announcements__empty">${state.loading ? t('正在加载公告') : state.listError ? t('公告列表加载失败，请重试') : t('暂无公告')}</p>`}
        </div>
      </section>
    </div>
  <//>`;
}

/** Mount once next to the existing global UI hosts. Modal restores the nickname field after closing. */
export function AnnouncementHost() {
  const state = useStore((s) => s, Object.is, announcementStore);
  const bodyRef = useRef(null);
  const viewFocusRef = useRef(null);
  useEffect(() => {
    hostCount++;
    installation?.hostChanged();
    return () => { hostCount--; installation?.hostChanged(); };
  }, []);
  useLayoutEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
  }, [state.selectedId, state.open]);
  useLayoutEffect(() => {
    const previousFocus = viewFocusRef.current;
    viewFocusRef.current = null;
    if (state.open) focusAnnouncementView(bodyRef.current?.closest('.announcements'), previousFocus, state.mobileView);
  }, [state.mobileView, state.selectedId, state.open]);
  return html`<${AnnouncementDialog} state=${state} bodyRef=${bodyRef}
    onViewAction=${(element) => { viewFocusRef.current = element; }} />`;
}

/**
 * Install ordinary-entry checks. Never fetch during Game, never auto-open on a transient restored lobby, and the
 * controller remembers revisions already shown in this page so reconnects cannot repeatedly interrupt the player.
 * Dependencies are injectable for short lifecycle tests without a browser or game simulation.
 */
export function installAnnouncements({
  appStore = store, selectRoute = appRoute, net, timers = globalThis, browser = globalThis,
  restoreGraceMs = ANNOUNCEMENT_RESTORE_GRACE_MS, pollMs = ANNOUNCEMENT_POLL_MS,
  mountDelayMs = ANNOUNCEMENT_MOUNT_DELAY_MS, isMounted = () => hostCount > 0,
  controller = announcementController,
} = {}) {
  installation?.dispose();
  let disposed = false;
  let checkTimer = null;
  let restoreTimer = null;
  let welcomed = appStore.get().connection?.status === 'online';
  let restored = false;

  const getContext = () => {
    const s = appStore.get();
    const route = selectRoute(s);
    return {
      route,
      ready: !disposed && isMounted() && route !== 'game' && !s.ui?.restoring && !s.ui?.resumePromptOpen
        && (route === 'title' || (welcomed && restored && s.connection?.status === 'online')),
    };
  };
  contextProvider = getContext;

  const check = () => {
    checkTimer = null;
    if (getContext().ready) controller.refresh({ auto: true });
  };
  const schedule = () => {
    timers.clearTimeout(checkTimer);
    checkTimer = null;
    if (getContext().ready) checkTimer = timers.setTimeout(check, mountDelayMs);
  };
  const finishRestore = () => {
    restored = true;
    controller.contextChanged();
    schedule();
  };
  const welcome = () => {
    welcomed = true;
    restored = false;
    timers.clearTimeout(restoreTimer);
    timers.clearTimeout(checkTimer);
    controller.contextChanged();
    restoreTimer = timers.setTimeout(finishRestore, restoreGraceMs);
  };
  const unsubscribe = appStore.subscribe((s, prev) => {
    const route = selectRoute(s);
    if (route !== selectRoute(prev) || s.ui?.restoring !== prev.ui?.restoring
        || s.ui?.resumePromptOpen !== prev.ui?.resumePromptOpen
        || s.connection?.status !== prev.connection?.status) {
      controller.contextChanged();
      schedule();
    }
  });
  const unsubscribeWelcome = net?.on?.('welcome', welcome);
  const focus = () => { if (browser.document?.visibilityState !== 'hidden') schedule(); };
  browser.addEventListener?.('focus', focus);
  browser.document?.addEventListener?.('visibilitychange', focus);
  const pollTimer = pollMs > 0 ? timers.setInterval(() => { if (getContext().ready) check(); }, pollMs) : null;

  const api = {
    getContext,
    refresh: () => controller.refresh({ auto: true }),
    hostChanged() { controller.contextChanged(); schedule(); },
    dispose() {
      if (disposed) return;
      disposed = true;
      timers.clearTimeout(checkTimer);
      timers.clearTimeout(restoreTimer);
      if (pollTimer != null) timers.clearInterval(pollTimer);
      unsubscribe();
      unsubscribeWelcome?.();
      browser.removeEventListener?.('focus', focus);
      browser.document?.removeEventListener?.('visibilitychange', focus);
      controller.close();
      if (installation === api) installation = null;
    },
  };
  installation = api;
  controller.contextChanged();
  if (welcomed) welcome();
  else schedule();
  return api;
}
