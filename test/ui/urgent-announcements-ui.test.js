// Explicit-notice wiring, clock calibration and the independent topmost reader; no game or server is started.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../../public/js/store.js';
import {
  UrgentAnnouncementDialog, createUrgentNoticeClock, installUrgentAnnouncements, installUrgentAnnouncementFocus,
} from '../../public/js/ui/urgentAnnouncements.js';
import { createUrgentAnnouncementState } from '../../public/js/ui/urgentAnnouncementModel.js';
import { AnnouncementMarkdown } from '../../public/js/ui/announcementMarkdown.js';
import { ANNOUNCEMENT_NOTICE_TTL_MS } from '../../shared/announcementNotices.js';

function notice(createdAt = 1_000_000) {
  return { t: 'announcement.notice', id: 'maintenance', revision: 'pub-one',
    msgid: '01234567-89ab-4cde-8fab-0123456789ab', createdAt, expiresAt: createdAt + ANNOUNCEMENT_NOTICE_TTL_MS };
}
const detail = { id: 'maintenance', revision: 'pub-one', title: '维护通知', publishedAt: '2026-10-09T00:00:00.000Z', markdown: '# 维护\n<script>as text</script>' };

function* walk(vnode) {
  if (Array.isArray(vnode)) { for (const child of vnode) yield* walk(child); return; }
  if (!vnode || typeof vnode !== 'object') return;
  yield vnode;
  yield* walk(vnode.props?.children);
}
function text(vnode) {
  if (Array.isArray(vnode)) return vnode.map(text).join('');
  if (typeof vnode === 'string' || typeof vnode === 'number') return String(vnode);
  return vnode && typeof vnode === 'object' ? text(vnode.props?.children) : '';
}
const classed = (vnode, cls) => String(vnode.props?.class || '').split(' ').includes(cls);

function events() {
  const listeners = new Map();
  return {
    on(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
      return () => listeners.get(type).delete(fn);
    },
    emit(type, event) { for (const fn of listeners.get(type) || []) fn(event); },
    types: () => [...listeners.keys()],
  };
}

test('pre-hello clock skew cannot reject the first valid server notice, and newer timestamps advance the anchor', () => {
  let local = 5_000_000_000_000;
  const appStore = createStore({ clock: { synced: false } });
  const clock = createUrgentNoticeClock({ appStore, localNow: () => local, correctedNow: () => 0 });
  const first = notice();
  assert.deepEqual(clock.accept(first), first);
  assert.equal(clock.now(), first.createdAt);
  local += 1000;
  const later = notice(first.createdAt + 2000);
  assert.deepEqual(clock.accept(later), later, 'poll delivery variation before the first pong is not a future-frame rejection');
  assert.equal(clock.now(), later.createdAt);
  assert.deepEqual(clock.accept(first), first);
  assert.equal(clock.now(), later.createdAt, 'an older frame cannot move the fallback clock backwards');
  local += ANNOUNCEMENT_NOTICE_TTL_MS;
  assert.equal(clock.accept(first), null);
});

test('invalid pre-hello frames cannot calibrate the clock, and a synced server clock strictly enforces expiry/future time', () => {
  const local = 8_000_000;
  let corrected = 1_000_001;
  const appStore = createStore({ clock: { synced: false } });
  const clock = createUrgentNoticeClock({ appStore, localNow: () => local, correctedNow: () => corrected });
  assert.equal(clock.accept({ ...notice(), id: '../private' }), null);
  assert.equal(clock.now(), local);
  assert.equal(clock.accept({ ...notice(), msgid: 'not-a-message-id' }), null);
  appStore.set({ clock: { synced: true } });
  assert.equal(clock.now(), corrected);
  assert.deepEqual(clock.accept(notice()), notice());
  assert.equal(clock.accept(notice(corrected + 1)), null);
  corrected = notice().expiresAt;
  assert.equal(clock.accept(notice()), null);
});

test('installation listens only to explicit notice pushes and disposal removes that trigger', () => {
  const net = events();
  const received = [];
  const appStore = createStore({ clock: { synced: true } });
  const clock = createUrgentNoticeClock({ appStore, localNow: () => 0, correctedNow: () => notice().createdAt });
  const target = createStore(createUrgentAnnouncementState());
  const controller = { receive: (frame) => received.push(frame), close() {} };
  const installed = installUrgentAnnouncements({ net, controller, target, clock, browser: {} });
  assert.deepEqual(net.types(), ['announcement.notice']);
  net.emit('welcome', notice());
  net.emit('m.public', notice());
  net.emit('announcement.notice', { ...notice(), revision: 'bad revision' });
  assert.deepEqual(received, []);
  net.emit('announcement.notice', notice());
  assert.deepEqual(received, [notice()]);
  installed.dispose();
  net.emit('announcement.notice', notice());
  assert.equal(received.length, 1);
});

test('urgent reader has its own title, safe Markdown, FIFO hint and close; it never exposes normal suppression or history', () => {
  const calls = [];
  const state = { ...createUrgentAnnouncementState(), open: true, notice: notice(), detail, queue: [notice(1_000_001)], remaining: 2 };
  const dialog = UrgentAnnouncementDialog({ state, running: true, actions: { close: () => calls.push('close'), retry: () => calls.push('retry') } });
  assert.ok(classed(dialog, 'urgent-announcement-layer'));
  const nodes = [...walk(dialog)];
  const modal = nodes.find((node) => node.props?.class === 'urgent-announcement');
  assert.equal(modal.props.title, '服主紧急通知');
  assert.ok(text(dialog).includes('对局仍在继续，请尽快阅读'));
  assert.equal(nodes.some((node) => node.type === 'input' || node.type === 'nav'), false);
  const markdown = nodes.find((node) => node.type === AnnouncementMarkdown);
  assert.equal(markdown.props.source, detail.markdown);
  assert.ok(text(modal.props.actions).includes('还有 1 条紧急通知等待查看'));
  [...walk(modal.props.actions)].find((node) => node.props?.['data-autofocus']).props.onClick();
  modal.props.onClose();
  assert.deepEqual(calls, ['close', 'close']);
});

test('closed urgent state renders nothing, while a failed detail has a direct retry without reopening other notices', () => {
  const calls = [];
  const actions = { close() {}, retry: () => calls.push('retry') };
  assert.equal(UrgentAnnouncementDialog({ state: createUrgentAnnouncementState(), actions }), null);
  const dialog = UrgentAnnouncementDialog({ state: { ...createUrgentAnnouncementState(), open: true, notice: notice(), error: 'DETAIL_UNAVAILABLE' }, actions });
  const retry = [...walk(dialog)].find((node) => node.props?.icon === 'refresh');
  retry.props.onClick();
  assert.deepEqual(calls, ['retry']);
  assert.equal([...walk(dialog)].some((node) => classed(node, 'urgent-announcement__running')), false, 'title/lobby does not claim a match is running');
});

test('topmost urgent Escape consumes the key before other modal listeners and only closes the urgent queue', () => {
  const callbacks = new Map();
  const removed = [];
  const browser = {
    addEventListener: (type, fn, capture) => callbacks.set(type, { fn, capture }),
    removeEventListener: (type, fn, capture) => removed.push([type, fn, capture]),
  };
  const target = createStore({ open: true });
  let closed = 0;
  const remove = installUrgentAnnouncementFocus({ target, browser, close: () => closed++, getRoot: () => null });
  assert.equal(callbacks.get('keydown').capture, true);
  const event = { key: 'Escape', prevented: false, stopped: false,
    preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; } };
  callbacks.get('keydown').fn(event);
  assert.deepEqual([closed, event.prevented, event.stopped], [1, true, true]);
  callbacks.get('keydown').fn({ ...event, key: 'Enter' });
  target.set({ open: false });
  callbacks.get('keydown').fn({ ...event, prevented: false, stopped: false });
  assert.equal(closed, 1);
  remove();
  assert.deepEqual(removed.map(([type, , capture]) => [type, capture]), [['keydown', true], ['focusin', true]]);
});

test('later ordinary modal autofocus cannot take focus away from the visible urgent reader', () => {
  const callbacks = new Map();
  const focused = [];
  const button = { focus: (options) => focused.push(options) };
  const root = { contains: (node) => node === button, querySelector: () => button };
  const target = createStore({ open: true });
  const browser = { addEventListener: (type, fn) => callbacks.set(type, fn), removeEventListener() {} };
  const remove = installUrgentAnnouncementFocus({ target, browser, getRoot: () => root });
  callbacks.get('focusin')({ target: {} });
  assert.deepEqual(focused, [{ preventScroll: true }]);
  callbacks.get('focusin')({ target: button });
  target.set({ open: false });
  callbacks.get('focusin')({ target: {} });
  assert.equal(focused.length, 1);
  remove();
});
