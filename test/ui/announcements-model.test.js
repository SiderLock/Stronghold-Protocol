// Announcement lifecycle: server publication order, persisted suppression and asynchronous UI races.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../../public/js/store.js';
import { ANNOUNCEMENT_MAX_BODY_CHARS } from '../../shared/announcements.js';
import {
  ANNOUNCEMENT_STORAGE_KEY, createAnnouncementState, normalizeAnnouncementList, createAnnouncementController,
} from '../../public/js/ui/announcementModel.js';

const DATE = '2026-10-09T00:00:00.000Z';
const A = { id: 'a', title: '公告 A', publishedAt: DATE, revision: 'pub-a' };
const B = { id: 'b', title: '公告 B', publishedAt: DATE, revision: 'pub-b' };
const C = { id: 'c', title: '公告 C', publishedAt: DATE, revision: 'pub-c' };
const indexOf = (items = [A], pinnedId = null) => ({ revision: items[0]?.revision || '', pinnedId, items });
const detailOf = (item, markdown = `# ${item.title}\n\n公告正文。`) => ({ ...item, markdown });
const responseOf = (payload, ok = true) => ({ ok, json: async () => payload });
const ticks = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

function memoryStorage(initial = null) {
  const values = new Map(initial === null ? [] : [[ANNOUNCEMENT_STORAGE_KEY, initial]]);
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}

function deferredFetch() {
  const calls = [];
  return {
    calls,
    fetchImpl: (url, options) => new Promise((resolve, reject) => calls.push({ url, options, resolve, reject })),
    async reply(position, payload, ok = true) { calls[position].resolve(responseOf(payload, ok)); await ticks(); },
    async fail(position) { calls[position].reject(new Error('offline')); await ticks(); },
  };
}

function fixture({ fetchImpl, storage = memoryStorage(), ready = true, route = 'title' } = {}) {
  const target = createStore(createAnnouncementState());
  const current = { ready, route };
  const controller = createAnnouncementController({ target, getContext: () => current, fetchImpl, storage });
  return { target, current, controller, storage };
}

function serving(getIndex) {
  const calls = [];
  return {
    calls,
    async fetchImpl(url, options) {
      calls.push({ url, options });
      const index = getIndex();
      if (url === '/api/announcements') return responseOf(index);
      const id = decodeURIComponent(url.slice('/api/announcements/'.length));
      const item = index.items.find((candidate) => candidate.id === id);
      return responseOf(item ? detailOf(item) : null, !!item);
    },
  };
}

test('state and normalization: independent state, validated copies, service publication order', () => {
  const first = createAnnouncementState();
  const second = createAnnouncementState();
  assert.equal(first.open, false);
  assert.equal(first.mobileView, 'detail');
  first.items.push(A);
  assert.deepEqual(second.items, []);
  const backdated = { ...B, publishedAt: '2026-10-01T00:00:00.000Z' };
  const input = indexOf([{ ...backdated, privatePath: 'private' }, A], A.id);
  const normalized = normalizeAnnouncementList(input);
  assert.deepEqual(normalized.items, [backdated, A], 'publication order survives a backdated new announcement');
  assert.equal(normalized.pinnedId, A.id);
  assert.notEqual(normalized.items, input.items);
  assert.notEqual(normalized.items[0], input.items[0]);
  for (const bad of [null, {}, { ...input, revision: '../invalid' }, { ...input, pinnedId: 'missing' }]) {
    assert.deepEqual(normalizeAnnouncementList(bad), indexOf([]));
  }
});

test('auto: first visit opens the latest publication even without a pinned article', async () => {
  const server = serving(() => indexOf([B, A]));
  const f = fixture(server);
  await f.controller.refresh({ auto: true });
  const state = f.target.get();
  assert.equal(state.open, true);
  assert.equal(state.selectedId, B.id);
  assert.deepEqual(state.detail, detailOf(B));
  assert.equal(state.loading, false);
  assert.equal(state.detailLoading, false);
  assert.equal(state.suppressed, false);
  assert.deepEqual(server.calls.map((call) => call.url), ['/api/announcements', '/api/announcements/b']);
  assert.ok(server.calls.every((call) => call.options.cache === 'no-store'));
});

test('pin and suppression: an older pinned article opens, while suppression records the latest publication', async () => {
  const f = fixture(serving(() => indexOf([B, A], A.id)));
  await f.controller.refresh({ auto: true });
  assert.equal(f.target.get().selectedId, A.id);
  f.controller.setSuppressed(true);
  assert.equal(f.target.get().suppressed, true);
  assert.deepEqual(JSON.parse(f.storage.getItem(ANNOUNCEMENT_STORAGE_KEY)), { v: 1, suppressedRevision: B.revision });
});

test('close: no repeated auto popup in this page; a new controller opens again without suppression', async () => {
  const server = serving(() => indexOf([B, A]));
  const f = fixture(server);
  await f.controller.refresh({ auto: true });
  f.controller.close();
  await f.controller.refresh({ auto: true });
  await f.controller.contextChanged();
  assert.equal(f.target.get().open, false);
  assert.equal(f.storage.getItem(ANNOUNCEMENT_STORAGE_KEY), null);
  const next = fixture({ ...server, storage: f.storage });
  await next.controller.refresh({ auto: true });
  assert.equal(next.target.get().open, true, 'closing alone does not survive a page refresh');
});

test('a new same-date publication reopens; dates and selected article do not identify a publication', async () => {
  let index = indexOf([B, A]);
  const f = fixture(serving(() => index));
  await f.controller.refresh({ auto: true });
  f.controller.close();
  index = indexOf([C, B, A]);
  await f.controller.refresh({ auto: true });
  assert.equal(f.target.get().open, true);
  assert.equal(f.target.get().revision, C.revision);
  assert.equal(f.target.get().selectedId, C.id);
});

test('persisted suppression: auto stays closed, manual bypasses it, a new revision opens again', async () => {
  let index = indexOf([B, A]);
  const storage = memoryStorage(JSON.stringify({ v: 1, suppressedRevision: B.revision }));
  const f = fixture({ ...serving(() => index), storage });
  await f.controller.refresh({ auto: true });
  assert.equal(f.target.get().open, false);
  assert.equal(f.target.get().suppressed, true);
  await f.controller.open(A.id);
  assert.equal(f.target.get().open, true);
  assert.equal(f.target.get().selectedId, A.id);
  assert.equal(f.target.get().suppressed, true, 'manual viewing does not clear the preference');
  f.controller.close();
  index = indexOf([C, B, A]);
  await f.controller.refresh({ auto: true });
  assert.equal(f.target.get().open, true);
  assert.equal(f.target.get().suppressed, false);
  f.controller.setSuppressed(true);
  f.controller.setSuppressed(false);
  assert.equal(f.storage.getItem(ANNOUNCEMENT_STORAGE_KEY), null);
  assert.equal(f.target.get().suppressed, false);
});

test('manual opens immediately with loading, shows list failure, and refresh retries it', async () => {
  const network = deferredFetch();
  const f = fixture(network);
  const opening = f.controller.open();
  assert.equal(f.target.get().open, true);
  assert.equal(f.target.get().loading, true);
  await network.fail(0);
  await opening;
  assert.equal(f.target.get().open, true);
  assert.equal(f.target.get().listError, 'LIST_UNAVAILABLE');
  assert.equal(f.target.get().loading, false);
  const retry = f.controller.refresh();
  assert.equal(f.target.get().listError, null);
  await network.reply(1, indexOf([A]));
  await network.reply(2, detailOf(A));
  await retry;
  assert.deepEqual(f.target.get().detail, detailOf(A));
  assert.equal(f.target.get().listError, null);
});

test('auto failure is silent and does not consume the later successful auto opportunity', async () => {
  let online = false;
  const server = serving(() => indexOf([A]));
  const f = fixture({ fetchImpl: (...args) => online ? server.fetchImpl(...args) : Promise.reject(new Error('offline')) });
  await f.controller.refresh({ auto: true });
  assert.equal(f.target.get().open, false);
  assert.equal(f.target.get().listError, null);
  assert.equal(f.target.get().loading, false);
  online = true;
  await f.controller.refresh({ auto: true });
  assert.equal(f.target.get().open, true);
});

test('bad HTTP or malformed list data produces a manual list error', async () => {
  for (const response of [responseOf(null, false), responseOf({ items: [] }), { ok: true, json: async () => { throw new Error('bad JSON'); } }]) {
    const f = fixture({ fetchImpl: async () => response });
    await f.controller.open();
    assert.equal(f.target.get().open, true);
    assert.equal(f.target.get().listError, 'LIST_UNAVAILABLE');
    assert.equal(f.target.get().loading, false);
  }
});

test('invalid detail is shown as a detail error and selecting it again retries', async () => {
  let valid = false;
  const f = fixture({ fetchImpl: async (url) => responseOf(url === '/api/announcements'
    ? indexOf([A]) : valid ? detailOf(A) : detailOf(B)) });
  await f.controller.open();
  assert.equal(f.target.get().listError, null);
  assert.equal(f.target.get().detail, null);
  assert.equal(f.target.get().detailError, 'DETAIL_UNAVAILABLE');
  valid = true;
  await f.controller.select(A.id);
  assert.deepEqual(f.target.get().detail, detailOf(A));
  assert.equal(f.target.get().detailError, null);
});

test('detail length: the shared maximum is accepted, an oversized response is rejected and can retry', async () => {
  for (const length of [ANNOUNCEMENT_MAX_BODY_CHARS, ANNOUNCEMENT_MAX_BODY_CHARS + 1]) {
    let markdown = 'a'.repeat(length);
    const f = fixture({ fetchImpl: async (url) => responseOf(url === '/api/announcements'
      ? indexOf([A]) : detailOf(A, markdown)) });
    await f.controller.open();
    assert.equal(f.target.get().listError, null);
    if (length === ANNOUNCEMENT_MAX_BODY_CHARS) {
      assert.equal(f.target.get().detail.markdown.length, length);
      assert.equal(f.target.get().detailError, null);
    } else {
      assert.equal(f.target.get().detail, null);
      assert.equal(f.target.get().detailError, 'DETAIL_UNAVAILABLE');
      markdown = '修正后的正文。';
      await f.controller.select(A.id);
      assert.equal(f.target.get().detail.markdown, markdown, 'an invalid response is never cached');
      assert.equal(f.target.get().detailError, null);
    }
  }
});

test('auto waits for ready and contextChanged opens the fetched announcement exactly once', async () => {
  const server = serving(() => indexOf([A]));
  const f = fixture({ ...server, ready: false });
  await f.controller.refresh({ auto: true });
  assert.equal(f.target.get().open, false);
  assert.equal(server.calls.length, 1);
  f.current.ready = true;
  await f.controller.contextChanged();
  assert.equal(f.target.get().open, true);
  assert.equal(server.calls.length, 2, 'ready reuses the list that has already arrived');
  f.controller.close();
  await f.controller.contextChanged();
  assert.equal(f.target.get().open, false);
});

test('entering Game cancels a not-ready automatic opportunity even after returning to lobby', async () => {
  const server = serving(() => indexOf([A]));
  const f = fixture({ ...server, ready: false });
  await f.controller.refresh({ auto: true });
  f.current.route = 'game';
  await f.controller.contextChanged();
  f.current.route = 'lobby';
  f.current.ready = true;
  await f.controller.contextChanged();
  assert.equal(f.target.get().open, false);
  assert.equal(server.calls.length, 1);
});

test('late auto list cannot open after a Game round trip', async () => {
  const network = deferredFetch();
  const f = fixture(network);
  const refresh = f.controller.refresh({ auto: true });
  f.current.route = 'game';
  await f.controller.contextChanged();
  f.current.route = 'lobby';
  await f.controller.contextChanged();
  await network.reply(0, indexOf([A]));
  await refresh;
  assert.equal(f.target.get().open, false);
  assert.equal(f.target.get().detail, null);
  assert.equal(network.calls.length, 1, 'there is no late detail request either');
});

test('a current Game route blocks auto list continuation even before a context hook runs', async () => {
  const network = deferredFetch();
  const f = fixture(network);
  const refresh = f.controller.refresh({ auto: true });
  f.current.route = 'game';
  await network.reply(0, indexOf([A]));
  await refresh;
  assert.equal(f.target.get().open, false);
  f.current.route = 'room';
  await f.controller.contextChanged();
  assert.equal(f.target.get().open, false);
});

test('Game closes an existing popup and invalidates its detail even after returning', async () => {
  const network = deferredFetch();
  const f = fixture(network);
  const opening = f.controller.open();
  await network.reply(0, indexOf([A]));
  assert.equal(f.target.get().detailLoading, true);
  f.current.route = 'game';
  await f.controller.contextChanged();
  assert.equal(f.target.get().open, false);
  assert.equal(f.target.get().detailLoading, false);
  f.current.route = 'room';
  await f.controller.contextChanged();
  await network.reply(1, detailOf(A));
  await opening;
  assert.equal(f.target.get().open, false);
  assert.equal(f.target.get().detail, null);
});

test('manual and automatic opening are both blocked while Game is on screen', async () => {
  const server = serving(() => indexOf([A]));
  const f = fixture({ ...server, route: 'game' });
  await f.controller.open();
  await f.controller.refresh({ auto: true });
  assert.equal(f.target.get().open, false);
  assert.equal(server.calls.length, 0);
});

test('close during a manual or automatic list request prevents a late popup and detail fetch', async () => {
  for (const manual of [true, false]) {
    const network = deferredFetch();
    const f = fixture(network);
    const pending = manual ? f.controller.open() : f.controller.refresh({ auto: true });
    f.controller.close();
    await network.reply(0, indexOf([A]));
    await pending;
    assert.equal(f.target.get().open, false);
    assert.equal(f.target.get().selectedId, null);
    assert.equal(f.target.get().detail, null);
    assert.equal(network.calls.length, 1);
  }
});

test('close during detail loading prevents late content from changing the closed popup', async () => {
  const network = deferredFetch();
  const f = fixture(network);
  const opening = f.controller.open();
  await network.reply(0, indexOf([A]));
  f.controller.close();
  await network.reply(1, detailOf(A));
  await opening;
  assert.equal(f.target.get().detail, null);
  assert.equal(f.target.get().detailLoading, false);
  assert.equal(f.target.get().open, false);
});

test('concurrent lists: the most recent refresh wins over a slower older response', async () => {
  const network = deferredFetch();
  const f = fixture(network);
  const old = f.controller.open();
  const latest = f.controller.refresh();
  await network.reply(1, indexOf([B, A]));
  await network.reply(2, detailOf(B));
  await latest;
  await network.reply(0, indexOf([A]));
  await old;
  assert.equal(f.target.get().revision, B.revision);
  assert.equal(f.target.get().selectedId, B.id);
  assert.deepEqual(f.target.get().detail, detailOf(B));
});

test('a newer automatic refresh cannot discard a manual request to open a specific article', async () => {
  const network = deferredFetch();
  const f = fixture(network);
  const manual = f.controller.open(A.id);
  const automatic = f.controller.refresh({ auto: true });
  await network.reply(1, indexOf([B, A]));
  assert.equal(f.target.get().selectedId, A.id);
  await network.reply(2, detailOf(A));
  await automatic;
  await network.reply(0, indexOf([A]));
  await manual;
  assert.equal(f.target.get().selectedId, A.id);
  assert.deepEqual(f.target.get().detail, detailOf(A));
});

test('fast selection: a slower old detail response or error cannot replace the current page', async () => {
  for (const oldFails of [false, true]) {
    const network = deferredFetch();
    const f = fixture(network);
    const opening = f.controller.open();
    await network.reply(0, indexOf([A, B]));
    const selected = f.controller.select(B.id);
    await network.reply(2, detailOf(B));
    await selected;
    if (oldFails) await network.fail(1);
    else await network.reply(1, detailOf(A));
    await opening;
    assert.equal(f.target.get().selectedId, B.id);
    assert.deepEqual(f.target.get().detail, detailOf(B));
    assert.equal(f.target.get().detailError, null);
    assert.equal(f.target.get().detailLoading, false);
  }
});

test('list changes retain an existing reading selection, then choose the default if it disappears', async () => {
  let index = indexOf([B, A], B.id);
  const f = fixture(serving(() => index));
  await f.controller.open();
  await f.controller.select(A.id);
  index = indexOf([C, B, A], C.id);
  await f.controller.refresh();
  assert.equal(f.target.get().selectedId, A.id, 'refreshing metadata does not jump away from reading');
  index = indexOf([C, B], B.id);
  await f.controller.refresh();
  assert.equal(f.target.get().selectedId, B.id);
  assert.deepEqual(f.target.get().detail, detailOf(B));
});

test('manual reopen chooses the current pin rather than the previously browsed article', async () => {
  const f = fixture(serving(() => indexOf([B, A], A.id)));
  await f.controller.open();
  await f.controller.select(B.id);
  f.controller.close();
  await f.controller.open();
  assert.equal(f.target.get().selectedId, A.id);
});

test('background refresh preserves the mobile list; user selection, reopen and a new auto prompt show detail', async () => {
  let index = indexOf([B, A]);
  const f = fixture(serving(() => index));
  await f.controller.refresh({ auto: true });
  f.target.set({ mobileView: 'list' });
  await f.controller.refresh({ auto: true });
  assert.equal(f.target.get().mobileView, 'list', 'a periodic refresh must not kick the user out of history');
  assert.equal(f.target.get().selectedId, B.id);
  await f.controller.select(A.id);
  assert.equal(f.target.get().mobileView, 'detail');
  f.target.set({ mobileView: 'list' });
  await f.controller.open();
  assert.equal(f.target.get().mobileView, 'detail');
  f.target.set({ mobileView: 'list' });
  index = indexOf([C, B, A]);
  await f.controller.refresh({ auto: true });
  assert.equal(f.target.get().mobileView, 'detail', 'a newly published automatic prompt still opens its detail view');
});

test('background refresh preserves the mobile list while retrying an uncached detail asynchronously', async () => {
  const network = deferredFetch();
  const f = fixture(network);
  const opening = f.controller.open();
  await network.reply(0, indexOf([A]));
  await network.fail(1);
  await opening;
  f.target.set({ mobileView: 'list' });
  const refreshing = f.controller.refresh({ auto: true });
  await network.reply(2, indexOf([A]));
  assert.equal(f.target.get().detailLoading, true);
  assert.equal(f.target.get().mobileView, 'list');
  await network.reply(3, detailOf(A));
  await refreshing;
  assert.equal(f.target.get().mobileView, 'list');
  assert.deepEqual(f.target.get().detail, detailOf(A));
});

test('selection while a manual refresh is pending remains selected when the list arrives', async () => {
  const network = deferredFetch();
  const f = fixture(network);
  const opening = f.controller.open();
  await network.reply(0, indexOf([B, A], B.id));
  await network.reply(1, detailOf(B));
  await opening;
  const reopening = f.controller.open();
  const selecting = f.controller.select(A.id);
  await network.reply(3, detailOf(A));
  await selecting;
  await network.reply(2, indexOf([C, B, A], C.id));
  await reopening;
  assert.equal(f.target.get().selectedId, A.id);
  assert.deepEqual(f.target.get().detail, detailOf(A));
});

test('empty lists never auto-open, while manual opening can show an empty state', async () => {
  const f = fixture(serving(() => indexOf([])));
  await f.controller.refresh({ auto: true });
  assert.equal(f.target.get().open, false);
  await f.controller.open();
  assert.equal(f.target.get().open, true);
  assert.equal(f.target.get().selectedId, null);
  assert.equal(f.target.get().detailLoading, false);
  assert.equal(f.target.get().listError, null);
  f.controller.setSuppressed(true);
  assert.equal(f.target.get().suppressed, false);
});

test('deleting the newest or last article retains browser suppression until an actual new publication', async () => {
  let index = indexOf([B, A], B.id);
  const server = serving(() => index);
  const storage = memoryStorage();
  const f = fixture({ ...server, storage });
  await f.controller.open();
  f.controller.setSuppressed(true);
  const revision = index.revision;
  index = { revision, pinnedId: null, items: [A] };
  await f.controller.refresh();
  assert.equal(f.target.get().selectedId, A.id);
  assert.deepEqual(f.target.get().detail, detailOf(A));
  assert.equal(f.target.get().suppressed, true);
  assert.equal(f.target.get().listError, null);
  f.controller.close();
  const reloaded = fixture({ ...server, storage });
  await reloaded.controller.refresh({ auto: true });
  assert.equal(reloaded.target.get().open, false, 'deletion is not a new publication on a fresh page');
  index = { revision, pinnedId: null, items: [] };
  await reloaded.controller.refresh({ auto: true });
  assert.equal(reloaded.target.get().open, false);
  assert.equal(reloaded.target.get().revision, revision);
  assert.equal(reloaded.target.get().suppressed, true);
  assert.equal(reloaded.target.get().detail, null);
  await reloaded.controller.open();
  assert.equal(reloaded.target.get().selectedId, null);
  assert.equal(reloaded.target.get().detailLoading, false);
  assert.equal(reloaded.target.get().listError, null);
  reloaded.controller.close();
  index = indexOf([C]);
  await reloaded.controller.refresh({ auto: true });
  assert.equal(reloaded.target.get().open, true);
  assert.equal(reloaded.target.get().suppressed, false);
  assert.equal(reloaded.target.get().selectedId, C.id);
});

test('a late deleted detail cannot refill the empty reader after the deletion list arrives', async () => {
  const network = deferredFetch();
  const f = fixture(network);
  const opening = f.controller.open();
  await network.reply(0, indexOf([A]));
  const refreshing = f.controller.refresh();
  await network.reply(2, { revision: A.revision, pinnedId: null, items: [] });
  await refreshing;
  assert.equal(f.target.get().selectedId, null);
  assert.equal(f.target.get().detail, null);
  await network.reply(1, detailOf(A));
  await opening;
  assert.equal(f.target.get().detail, null);
  assert.equal(f.target.get().detailLoading, false);
  assert.equal(f.target.get().detailError, null);
});

test('disabled, malformed and quota-failing storage cannot break fetching or page-local suppression', async () => {
  const blocked = {
    getItem() { throw new Error('disabled'); },
    setItem() { throw new Error('quota'); },
    removeItem() { throw new Error('disabled'); },
  };
  for (const storage of [null, blocked, memoryStorage('{'), memoryStorage(JSON.stringify({ v: 1, suppressedRevision: '../bad' }))]) {
    const server = serving(() => indexOf([A]));
    const f = fixture({ ...server, storage });
    await f.controller.refresh({ auto: true });
    assert.equal(f.target.get().open, true);
    f.controller.setSuppressed(true);
    assert.equal(f.target.get().suppressed, true);
    f.controller.close();
    await f.controller.refresh({ auto: true });
    assert.equal(f.target.get().open, false);
    f.controller.setSuppressed(false);
    assert.equal(f.target.get().suppressed, false);
  }
});

test('dispose invalidates pending requests and all subsequent public actions', async () => {
  const network = deferredFetch();
  const f = fixture(network);
  const pending = f.controller.refresh({ auto: true });
  f.controller.dispose();
  const state = f.target.get();
  await network.reply(0, indexOf([A]));
  await pending;
  await f.controller.open();
  await f.controller.refresh({ auto: true });
  await f.controller.select(A.id);
  await f.controller.contextChanged();
  f.controller.setSuppressed(true);
  f.controller.close();
  f.controller.dispose();
  assert.equal(f.target.get(), state, 'there are no store writes after disposal');
  assert.equal(network.calls.length, 1);
});
