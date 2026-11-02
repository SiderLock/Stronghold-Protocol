// Announcement entry lifecycle and accessible reader controls; no match simulation or server is required.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../../public/js/store.js';
import {
  AnnouncementButton, AnnouncementDialog, announcementDate, installAnnouncements,
  ANNOUNCEMENT_MOUNT_DELAY_MS, ANNOUNCEMENT_RESTORE_GRACE_MS, focusAnnouncementView,
} from '../../public/js/ui/announcements.js';
import { createAnnouncementController, createAnnouncementState } from '../../public/js/ui/announcementModel.js';
import { AnnouncementMarkdown } from '../../public/js/ui/announcementMarkdown.js';

const metadata = (id, revision) => ({ id, revision, title: `公告 ${id}`, publishedAt: '2026-10-09T00:00:00.000Z' });
const item = metadata('latest', 'pub-one');
const index = { revision: item.revision, pinnedId: null, items: [item] };

function* walk(vnode) {
  if (Array.isArray(vnode)) { for (const child of vnode) yield* walk(child); return; }
  if (!vnode || typeof vnode !== 'object') return;
  yield vnode;
  yield* walk(vnode.props?.children);
}
const classed = (vnode, cls) => String(vnode.props?.class || '').split(' ').includes(cls);

function fakeTimers() {
  let now = 0;
  let seq = 0;
  const tasks = new Map();
  const add = (fn, ms, repeat) => { const id = ++seq; tasks.set(id, { fn, at: now + ms, repeat }); return id; };
  return {
    setTimeout: (fn, ms) => add(fn, ms, 0), clearTimeout: (id) => tasks.delete(id),
    setInterval: (fn, ms) => add(fn, ms, ms), clearInterval: (id) => tasks.delete(id),
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        const next = [...tasks.entries()].filter(([, task]) => task.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        const [id, task] = next;
        tasks.delete(id);
        now = task.at;
        if (task.repeat) tasks.set(id, { ...task, at: now + task.repeat });
        task.fn();
        for (let i = 0; i < 20; i++) await Promise.resolve();
      }
      now = end;
      for (let i = 0; i < 20; i++) await Promise.resolve();
    },
  };
}

function fakeEvents() {
  const listeners = new Map();
  return {
    on(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
      return () => listeners.get(type).delete(fn);
    },
    emit(type) { for (const fn of listeners.get(type) || []) fn(); },
  };
}

function shell(entered = false) {
  return createStore({ session: { entered }, connection: { status: entered ? 'handshaking' : 'connected' }, ui: { restoring: false }, game: false });
}
const route = (state) => !state.session.entered ? 'title' : state.game ? 'game' : 'lobby';

test('title waits until host mount and nickname autofocus has settled, without waiting for welcome', async () => {
  const appStore = shell();
  const timers = fakeTimers();
  let mounted = false;
  const checks = [];
  const controller = { refresh: (options) => checks.push(options), contextChanged() {}, close() {} };
  const installed = installAnnouncements({ appStore, selectRoute: route, timers, browser: {}, controller, isMounted: () => mounted, pollMs: 0 });
  try {
    await timers.advance(500);
    assert.deepEqual(checks, [], 'fetching before the UI host mounts would race title autofocus');
    mounted = true;
    installed.hostChanged();
    await timers.advance(ANNOUNCEMENT_MOUNT_DELAY_MS - 1);
    assert.deepEqual(checks, []);
    await timers.advance(1);
    assert.deepEqual(checks, [{ auto: true }]);
    assert.deepEqual(installed.getContext(), { route: 'title', ready: true });
  } finally { installed.dispose(); }
});

test('entered startup waits for welcome and the full room/match restore grace', async () => {
  const appStore = shell(true);
  const timers = fakeTimers();
  const net = fakeEvents();
  const checks = [];
  const controller = { refresh: (options) => checks.push(options), contextChanged() {}, close() {} };
  const installed = installAnnouncements({ appStore, selectRoute: route, net, timers, browser: {}, controller, isMounted: () => true, pollMs: 0 });
  try {
    await timers.advance(2000);
    assert.deepEqual(checks, [], 'a reconnecting lobby is not yet known to be an ordinary entrance');
    net.emit('welcome');
    appStore.set({ connection: { status: 'online' } });
    await timers.advance(ANNOUNCEMENT_RESTORE_GRACE_MS - 1);
    assert.equal(installed.getContext().ready, false);
    assert.deepEqual(checks, []);
    await timers.advance(1 + ANNOUNCEMENT_MOUNT_DELAY_MS);
    assert.deepEqual(checks, [{ auto: true }]);
  } finally { installed.dispose(); }
});

test('restored Game does not fetch at startup, poll or focus; returning to a normal entrance can check', async () => {
  const appStore = shell(true);
  const timers = fakeTimers();
  const net = fakeEvents();
  const browserEvents = fakeEvents();
  const browser = { addEventListener: browserEvents.on, removeEventListener() {}, document: { visibilityState: 'visible' } };
  const checks = [];
  const controller = { refresh: (options) => checks.push(options), contextChanged() {}, close() {} };
  const installed = installAnnouncements({ appStore, selectRoute: route, net, timers, browser, controller, isMounted: () => true, pollMs: 1000 });
  try {
    net.emit('welcome');
    appStore.set({ connection: { status: 'online' }, game: true });
    await timers.advance(10_000);
    browserEvents.emit('focus');
    await timers.advance(1000);
    assert.deepEqual(installed.getContext(), { route: 'game', ready: false });
    assert.deepEqual(checks, []);
    appStore.set({ game: false });
    await timers.advance(ANNOUNCEMENT_MOUNT_DELAY_MS);
    assert.deepEqual(checks, [{ auto: true }]);
  } finally { installed.dispose(); }
});

test('local recovery selection delays startup, polling and focus auto-checks until it closes', async () => {
  const appStore = shell(true);
  const timers = fakeTimers();
  const net = fakeEvents();
  const browserEvents = fakeEvents();
  const browser = { addEventListener: browserEvents.on, removeEventListener() {}, document: { visibilityState: 'visible' } };
  const checks = [];
  const controller = { refresh: (options) => checks.push(options), contextChanged() {}, close() {} };
  const installed = installAnnouncements({ appStore, selectRoute: route, net, timers, browser, controller, isMounted: () => true, pollMs: 1000 });
  try {
    net.emit('welcome');
    appStore.set({ connection: { status: 'online' } });
    appStore.patch('ui', { resumePromptOpen: true });
    await timers.advance(10_000);
    browserEvents.emit('focus');
    await timers.advance(ANNOUNCEMENT_MOUNT_DELAY_MS);
    assert.equal(installed.getContext().ready, false);
    assert.deepEqual(checks, [], 'ordinary reminders must not cover the recovery choices');
    appStore.patch('ui', { resumePromptOpen: false });
    await timers.advance(ANNOUNCEMENT_MOUNT_DELAY_MS);
    assert.equal(installed.getContext().ready, true);
    assert.deepEqual(checks, [{ auto: true }], 'closing recovery schedules the deferred entrance check');
  } finally { installed.dispose(); }
});

test('an in-flight automatic announcement waits for local recovery selection to finish', async () => {
  const appStore = shell();
  const target = createStore(createAnnouncementState());
  const timers = fakeTimers();
  let installed, finishIndex;
  const controller = createAnnouncementController({
    target, storage: null,
    getContext: () => installed?.getContext() || { route: 'title', ready: false },
    fetchImpl: async (url) => url === '/api/announcements'
      ? new Promise((resolve) => { finishIndex = () => resolve({ ok: true, json: async () => index }); })
      : { ok: true, json: async () => ({ ...item, markdown: '正文' }) },
  });
  installed = installAnnouncements({ appStore, selectRoute: route, timers, browser: {}, controller, isMounted: () => true, pollMs: 0 });
  try {
    await timers.advance(ANNOUNCEMENT_MOUNT_DELAY_MS);
    assert.equal(typeof finishIndex, 'function');
    appStore.patch('ui', { resumePromptOpen: true });
    finishIndex();
    await timers.advance(0);
    assert.equal(target.get().open, false, 'a late index response cannot open over recovery');
    appStore.patch('ui', { resumePromptOpen: false });
    await timers.advance(0);
    assert.equal(target.get().open, true, 'the pending publication can be shown after recovery closes');
    assert.equal(target.get().detail.markdown, '正文');
  } finally { installed.dispose(); controller.dispose(); }
});

test('UI lifecycle with the real model closes on Game and does not duplicate a revision on reconnect', async () => {
  const appStore = shell();
  const target = createStore(createAnnouncementState());
  const timers = fakeTimers();
  const net = fakeEvents();
  let installed;
  const requests = [];
  const controller = createAnnouncementController({
    target, storage: null,
    getContext: () => installed?.getContext() || { route: 'title', ready: false },
    fetchImpl: async (url) => {
      requests.push(url);
      return { ok: true, json: async () => url === '/api/announcements' ? index : { ...item, markdown: '正文' } };
    },
  });
  installed = installAnnouncements({ appStore, selectRoute: route, net, timers, browser: {}, controller, isMounted: () => true, pollMs: 0 });
  try {
    await timers.advance(ANNOUNCEMENT_MOUNT_DELAY_MS);
    assert.equal(target.get().open, true);
    assert.equal(target.get().detail.markdown, '正文');
    appStore.set({ session: { entered: true }, connection: { status: 'online' }, game: true });
    assert.equal(target.get().open, false, 'entering a match immediately removes the ordinary modal');
    appStore.set({ game: false });
    net.emit('welcome');
    await timers.advance(ANNOUNCEMENT_RESTORE_GRACE_MS + ANNOUNCEMENT_MOUNT_DELAY_MS);
    assert.equal(target.get().open, false, 'one page must not automatically display the same revision twice');
    assert.equal(requests.filter((url) => url.includes('/latest')).length, 1);
  } finally { installed.dispose(); controller.dispose(); }
});

test('disposing lifecycle stops scheduled checks and subscription work', async () => {
  const appStore = shell();
  const timers = fakeTimers();
  const net = fakeEvents();
  const checks = [];
  const controller = { refresh: (options) => checks.push(options), contextChanged() {}, close() {} };
  const installed = installAnnouncements({ appStore, selectRoute: route, net, timers, browser: {}, controller, isMounted: () => true, pollMs: 1000 });
  installed.dispose();
  net.emit('welcome');
  appStore.set({ game: true });
  await timers.advance(10_000);
  assert.deepEqual(checks, []);
  assert.equal(installed.getContext().ready, false);
});

test('reader keeps history navigation, Markdown source, persistent preference and explicit close controls', () => {
  const older = metadata('older', 'pub-older');
  const calls = [];
  const actions = {
    select: (id) => calls.push(['select', id]), close: () => calls.push(['close']),
    refresh: () => calls.push(['refresh']), setSuppressed: (value) => calls.push(['suppressed', value]),
    showList: () => calls.push(['list']), showDetail: () => calls.push(['detail']),
  };
  const state = { ...createAnnouncementState(), open: true, ...index, pinnedId: older.id, items: [item, older], selectedId: item.id,
    detail: { ...item, markdown: '<script>raw text</script>' }, suppressed: true };
  const dialog = AnnouncementDialog({ state, actions });
  const nodes = [...walk(dialog)];
  const history = nodes.filter((node) => classed(node, 'announcements__item'));
  assert.deepEqual(history.map((node) => node.props['data-announcement-id']), ['older', 'latest']);
  assert.equal(history[1].props['aria-current'], 'true');
  assert.equal(history[0].props['aria-current'], undefined);
  history[0].props.onClick();
  const markdown = nodes.find((node) => node.type === AnnouncementMarkdown);
  assert.equal(markdown.props.source, state.detail.markdown, 'the safe Markdown component receives text, not HTML');
  assert.ok(nodes.some((node) => classed(node, 'announcements__body') && node.props.tabIndex === '0'));
  nodes.find((node) => classed(node, 'announcements__back')).props.onClick();
  const footerNodes = [...walk(dialog.props.actions)];
  assert.equal(classed(footerNodes.find((node) => node.type === 'label'), 'is-disabled'), false);
  const checkbox = footerNodes.find((node) => node.type === 'input');
  assert.equal(checkbox.props.checked, true);
  checkbox.props.onChange({ currentTarget: { checked: false } });
  footerNodes.find((node) => node.props?.['data-autofocus']).props.onClick();
  assert.deepEqual(calls, [['select', 'older'], ['list'], ['suppressed', false], ['close']]);
});

test('empty history cannot suppress an unknown publication, and detail failures expose a retry', () => {
  const calls = [];
  const actions = { close() {}, refresh() {}, setSuppressed() {}, select: (id) => calls.push(id) };
  const empty = AnnouncementDialog({ state: { ...createAnnouncementState(), open: true }, actions });
  assert.equal([...walk(empty.props.actions)].find((node) => node.type === 'input').props.disabled, true);
  assert.ok([...walk(empty.props.actions)].some((node) => classed(node, 'announcements__suppress') && classed(node, 'is-disabled')));
  const failed = AnnouncementDialog({ state: { ...createAnnouncementState(), open: true, ...index, selectedId: item.id, detailError: 'failed' }, actions });
  const retry = [...walk(failed)].find((node) => node.props?.icon === 'refresh');
  retry.props.onClick();
  assert.deepEqual(calls, [item.id]);
});

test('pinning temporarily leads the history list while selection and publication order stay unchanged', () => {
  const newer = metadata('newer', 'pub-newer');
  const older = metadata('older', 'pub-older');
  const items = Object.freeze([newer, item, older]);
  const state = { ...createAnnouncementState(), open: true, revision: newer.revision,
    items, pinnedId: older.id, selectedId: item.id };
  const history = (pinnedId) => [...walk(AnnouncementDialog({ state: { ...state, pinnedId } }))]
    .filter((node) => classed(node, 'announcements__item'));
  assert.deepEqual(history(older.id).map((node) => node.props['data-announcement-id']), ['older', 'newer', 'latest']);
  assert.equal(history(older.id)[2].props['aria-current'], 'true');
  assert.deepEqual(history(newer.id).map((node) => node.props['data-announcement-id']), ['newer', 'latest', 'older']);
  assert.deepEqual(history(null).map((node) => node.props['data-announcement-id']), ['newer', 'latest', 'older']);
  assert.deepEqual(items.map((entry) => entry.id), ['newer', 'latest', 'older']);
  assert.equal(state.revision, newer.revision);
  assert.equal(state.selectedId, item.id);
});

test('announcement trigger has a named accessible button and declared dates remain independent of revisions', () => {
  const button = AnnouncementButton({ square: true });
  assert.equal(button.props['aria-label'], '公告');
  assert.equal(button.props['data-testid'], 'announcements-open');
  assert.equal(announcementDate(item.publishedAt), '2026-10-09');
  assert.equal(announcementDate(null), '');
});

test('mobile view switches recover focus from hidden controls or body without stealing visible or outside focus', () => {
  const focused = [];
  const element = (id, visible = true) => ({ id, isConnected: true, getClientRects: () => visible ? [{}] : [], focus: (options) => focused.push([id, options]) });
  const body = element('body');
  const hiddenBack = element('back', false);
  const hiddenItem = element('old-item', false);
  const selectedItem = element('selected-item');
  const back = element('visible-back');
  const close = element('close');
  const outside = element('nickname');
  const members = new Set([hiddenBack, hiddenItem, selectedItem, back, close]);
  const doc = { body, activeElement: hiddenBack };
  const root = {
    ownerDocument: doc, contains: (node) => members.has(node),
    querySelector: (selector) => ({ '.announcements__item.is-selected': selectedItem, '.announcements__back': back, '[data-autofocus]': close })[selector],
  };
  assert.equal(focusAnnouncementView(root, hiddenBack, 'list'), true);
  assert.deepEqual(focused.pop(), ['selected-item', { preventScroll: true }]);
  doc.activeElement = body;
  assert.equal(focusAnnouncementView(root, hiddenItem, 'detail'), true);
  assert.deepEqual(focused.pop(), ['visible-back', { preventScroll: true }]);
  doc.activeElement = close;
  assert.equal(focusAnnouncementView(root, hiddenBack, 'list'), false, 'a visible modal control keeps focus');
  doc.activeElement = outside;
  assert.equal(focusAnnouncementView(root, hiddenBack, 'list'), false, 'another active input is not interrupted');
  doc.activeElement = body;
  assert.equal(focusAnnouncementView(root, selectedItem, 'list'), false, 'desktop history remains visible');
  assert.equal(focusAnnouncementView(root, null, 'detail'), false, 'initial render and background refresh have no view action');
  assert.deepEqual(focused, []);
});

test('view navigation records the active clicked control before switching the rendered view', () => {
  const clicked = {};
  const calls = [];
  const state = { ...createAnnouncementState(), open: true, ...index, selectedId: item.id };
  const dialog = AnnouncementDialog({ state, onViewAction: (element) => calls.push(element),
    actions: { close() {}, refresh() {}, setSuppressed() {}, showList: () => calls.push('list'), select: (id) => calls.push(id) } });
  const nodes = [...walk(dialog)];
  nodes.find((node) => classed(node, 'announcements__back')).props.onClick({ currentTarget: clicked });
  nodes.find((node) => classed(node, 'announcements__item')).props.onClick({ currentTarget: clicked });
  assert.deepEqual(calls, [clicked, 'list', clicked, item.id]);
});
