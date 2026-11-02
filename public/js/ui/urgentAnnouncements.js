// Explicit server-owner notices. This host has its own queue and lifetime: normal announcement preferences,
// routes, match clocks and reconnect restoration never control it. Only announcement.notice frames enqueue it.

import { useLayoutEffect, useRef } from '../../vendor/hooks.module.js';
import { html, Modal, Button, Icon, Spinner } from './components.js';
import { createStore, store, useStore, serverNow, selectRoute } from '../store.js';
import { t } from '../../../shared/i18n.js';
import { readAnnouncementNoticeFrame } from '../../../shared/announcementNotices.js';
import { AnnouncementMarkdown } from './announcementMarkdown.js';
import { createUrgentAnnouncementState, createUrgentAnnouncementController } from './urgentAnnouncementModel.js';

/** Use the existing measured server clock; pre-hello notices provide an initial trusted server-time anchor. */
export function createUrgentNoticeClock({ appStore = store, localNow = Date.now, correctedNow = serverNow } = {}) {
  let anchor = null;
  const synced = () => appStore.get().clock?.synced === true;
  const now = () => synced() ? correctedNow() : anchor ? anchor.server + localNow() - anchor.local : localNow();
  return {
    now,
    accept(frame) {
      if (!synced()) {
        const valid = readAnnouncementNoticeFrame(frame, frame?.createdAt);
        if (!valid) return null;
        // Poll delivery can vary by a second before the first pong. Advance the anchor for a newer server timestamp,
        // but never move it backwards for an old frame; once clock.sync succeeds its stricter measured time wins.
        if (!anchor || valid.createdAt > now()) anchor = { server: valid.createdAt, local: localNow() };
      }
      return readAnnouncementNoticeFrame(frame, now());
    },
  };
}

const urgentClock = createUrgentNoticeClock();
export const urgentAnnouncementStore = createStore(createUrgentAnnouncementState());
export const urgentAnnouncementController = createUrgentAnnouncementController({
  target: urgentAnnouncementStore,
  now: urgentClock.now,
  fetchImpl: (...args) => globalThis.fetch(...args),
});
export const closeUrgentAnnouncement = () => urgentAnnouncementController.close();

/** Independent, single-article reader. Pending notices are consumed FIFO when the current one is closed. */
export function UrgentAnnouncementDialog({ state, actions = urgentAnnouncementController, bodyRef, running = false }) {
  if (!state.open || !state.notice) return null;
  const pending = state.queue.length;
  const footer = html`<span class="urgent-announcement__pending" role="status">
      ${pending ? t('还有 {count} 条紧急通知等待查看', { count: pending }) : null}
    </span>
    <${Button} variant="amber" size="sm" data-autofocus onClick=${() => actions.close()}>${t('关闭')}<//>`;
  return html`<div class="urgent-announcement-layer" data-testid="urgent-announcement-layer" data-notice-msgid=${state.notice.msgid}>
    <${Modal} open=${true} title=${t('服主紧急通知')} micro="SERVER NOTICE" tone="amber"
        class="urgent-announcement" onClose=${() => actions.close()} actions=${footer}>
      <article class="urgent-announcement__article">
        <header class="urgent-announcement__article-head">
          <h3>${state.detail?.title || t('公告详情')}</h3>
          ${state.detail ? html`<time dateTime=${state.detail.publishedAt}>${state.detail.publishedAt.slice(0, 10)}</time>` : null}
        </header>
        ${running ? html`<p class="urgent-announcement__running"><${Icon} name="warn" />${t('对局仍在继续，请尽快阅读')}</p>` : null}
        <div ref=${bodyRef} class="urgent-announcement__body" tabIndex="0" aria-busy=${state.loading ? 'true' : undefined}>
          ${state.loading ? html`<div class="announcements__status"><${Spinner} size="sm" label=${t('正在加载公告正文')} /></div>`
            : state.error ? html`<div class="announcements__status" role="status">
                <${Icon} name="warn" /><p>${t('公告正文加载失败，请重试')}</p>
                <${Button} size="sm" icon="refresh" onClick=${() => actions.retry()}>${t('重试')}<//>
              </div>`
            : state.detail ? html`<${AnnouncementMarkdown} source=${state.detail.markdown} />` : null}
        </div>
      </article>
    <//>
  </div>`;
}

/** Mount alongside the ordinary host. It stays mounted while game / spectator / title routes change. */
export function UrgentAnnouncementHost() {
  const state = useStore((s) => s, Object.is, urgentAnnouncementStore);
  const running = useStore((s) => selectRoute(s) === 'game');
  const bodyRef = useRef(null);
  useLayoutEffect(() => { if (bodyRef.current) bodyRef.current.scrollTop = 0; }, [state.notice?.msgid]);
  return html`<${UrgentAnnouncementDialog} state=${state} bodyRef=${bodyRef} running=${running} />`;
}

/** Highest visible modal handles Escape and retains focus even if another modal mounts afterwards. */
export function installUrgentAnnouncementFocus({
  target = urgentAnnouncementStore, close = closeUrgentAnnouncement, browser = globalThis,
  getRoot = () => browser.document?.querySelector('.urgent-announcement'),
} = {}) {
  const onKey = (event) => {
    if (!target.get().open || event.key !== 'Escape') return;
    event.preventDefault();
    event.stopImmediatePropagation();
    close();
  };
  const onFocus = (event) => {
    if (!target.get().open) return;
    const root = getRoot();
    if (!root || root.contains(event.target)) return;
    root.querySelector('[data-autofocus]')?.focus({ preventScroll: true });
  };
  browser.addEventListener?.('keydown', onKey, true);
  browser.addEventListener?.('focusin', onFocus, true);
  return () => {
    browser.removeEventListener?.('keydown', onKey, true);
    browser.removeEventListener?.('focusin', onFocus, true);
  };
}

let installation = null;

/** Install the sole trigger: an explicit WebSocket notice frame. No welcome, route, preference or polling hooks. */
export function installUrgentAnnouncements({
  net, controller = urgentAnnouncementController, target = urgentAnnouncementStore,
  clock = urgentClock, browser = globalThis,
} = {}) {
  installation?.dispose();
  const unsubscribe = net?.on?.('announcement.notice', (frame) => {
    const valid = clock.accept(frame);
    if (valid) controller.receive(valid);
  });
  const removeFocus = installUrgentAnnouncementFocus({ target, browser, close: () => controller.close() });
  let disposed = false;
  const api = {
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe?.();
      removeFocus();
      if (installation === api) installation = null;
    },
  };
  installation = api;
  return api;
}
