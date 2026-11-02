// Urgent notices: explicit wire delivery, bounded FIFO acknowledgement and independent asynchronous details.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../../public/js/store.js';
import { ANNOUNCEMENT_MAX_BODY_CHARS } from '../../shared/announcements.js';
import { ANNOUNCEMENT_NOTICE_TTL_MS } from '../../shared/announcementNotices.js';
import { createUrgentAnnouncementState, createUrgentAnnouncementController } from '../../public/js/ui/urgentAnnouncementModel.js';

const NOW = Date.parse('2026-10-09T00:00:00.000Z');
const DATE = new Date(NOW).toISOString();
const msgid = (number) => `00000000-0000-4000-8000-${number.toString(16).padStart(12, '0')}`;
const frameOf = (number = 1, id = 'a', createdAt = NOW) => ({
  t: 'announcement.notice', id, revision: `pub-${id}`, msgid: msgid(number),
  createdAt, expiresAt: createdAt + ANNOUNCEMENT_NOTICE_TTL_MS,
});
const detailOf = (frame, markdown = '# 紧急公告\n\n请阅读并确认。') => ({
  id: frame.id, revision: frame.revision, title: `公告 ${frame.id}`, publishedAt: DATE, markdown,
});
const responseOf = (payload, ok = true) => ({ ok, json: async () => payload });
const ticks = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

function fakeClock(start = NOW) {
  let timestamp = start;
  let nextId = 1;
  const pending = new Map();
  const timers = {
    setTimeout(callback, delay) {
      const id = nextId++;
      pending.set(id, { callback, deadline: timestamp + delay });
      return id;
    },
    clearTimeout(id) { pending.delete(id); },
  };
  return {
    now: () => timestamp, timers, pending,
    set(value) { timestamp = value; },
    advance(ms) {
      timestamp += ms;
      while (true) {
        const due = [...pending].filter(([, task]) => task.deadline <= timestamp)
          .sort((a, b) => a[1].deadline - b[1].deadline)[0];
        if (!due) break;
        pending.delete(due[0]);
        due[1].callback();
      }
    },
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

function fixture(options = {}) {
  const clock = options.clock || fakeClock();
  const network = options.network || deferredFetch();
  const target = createStore(createUrgentAnnouncementState());
  const controller = createUrgentAnnouncementController({
    target, fetchImpl: options.fetchImpl || network.fetchImpl, now: clock.now, timers: clock.timers,
    ...('maxQueue' in options ? { maxQueue: options.maxQueue } : {}),
    ...('maxSeen' in options ? { maxSeen: options.maxSeen } : {}),
  });
  return { clock, network, target, controller };
}

test('initial state is closed, empty and independent; limits and required dependencies are checked', () => {
  const first = createUrgentAnnouncementState();
  const second = createUrgentAnnouncementState();
  assert.deepEqual(first, { open: false, notice: null, detail: null, loading: false, error: null, queue: [], remaining: 0 });
  first.queue.push(frameOf());
  assert.deepEqual(second.queue, []);
  for (const options of [{ maxQueue: 0 }, { maxQueue: 1.5 }, { maxSeen: 0 }, { maxSeen: Infinity }]) {
    assert.throws(() => fixture(options), TypeError);
  }
  assert.throws(() => createUrgentAnnouncementController({ target: {} }), TypeError);
});

test('only explicit valid wire receipt opens: ordinary list and local preferences have no entry path', async () => {
  const f = fixture();
  const notice = frameOf();
  assert.equal(f.controller.receive({ revision: notice.revision, pinnedId: null, items: [detailOf(notice)] }), false);
  assert.equal(f.target.get().open, false);
  assert.equal(f.network.calls.length, 0);
  assert.equal(f.controller.receive({ ...notice, privatePath: 'never public' }), true);
  const loading = f.target.get();
  assert.equal(loading.open, true);
  assert.equal(loading.loading, true);
  assert.equal(loading.error, null);
  assert.equal(loading.remaining, 1);
  assert.deepEqual(loading.notice, notice);
  assert.notEqual(loading.notice, notice);
  assert.deepEqual(f.network.calls.map((call) => call.url), ['/api/announcements/a']);
  assert.equal(f.network.calls[0].options.cache, 'no-store');
  await f.network.reply(0, { ...detailOf(notice), privatePath: 'never public' });
  assert.deepEqual(f.target.get().detail, detailOf(notice));
  assert.equal(f.target.get().loading, false);
});

test('model opens on title, normal play and spectating without consulting routing or ordinary suppression', async () => {
  for (const context of [{ route: 'title' }, { route: 'game', spectating: false }, { route: 'game', spectating: true }]) {
    const f = fixture();
    f.target.set({ context, ordinary: { open: false, suppressed: true }, game: { paused: false } });
    const before = f.target.get();
    assert.equal(f.controller.receive(frameOf()), true);
    await f.network.reply(0, detailOf(frameOf()));
    assert.equal(f.target.get().open, true);
    assert.equal(f.target.get().context, before.context);
    assert.equal(f.target.get().ordinary, before.ordinary);
    assert.equal(f.target.get().game, before.game);
  }
});

test('receipt delegates strict shape, TTL, filename, revision and msgid validation to the shared reader', () => {
  const notice = frameOf();
  const invalid = [
    null, [], {}, { ...notice, t: 'announcement.publish' }, { ...notice, t: undefined },
    { ...notice, id: '../a' }, { ...notice, id: 'con' }, { ...notice, revision: 'PUB' },
    { ...notice, msgid: 'not-a-uuid' }, { ...notice, createdAt: NOW + 1, expiresAt: NOW + 1 + ANNOUNCEMENT_NOTICE_TTL_MS },
    { ...notice, createdAt: NOW - ANNOUNCEMENT_NOTICE_TTL_MS, expiresAt: NOW },
    { ...notice, expiresAt: NOW + ANNOUNCEMENT_NOTICE_TTL_MS + 1 },
    { ...notice, createdAt: String(NOW) }, { ...notice, expiresAt: Infinity },
  ];
  for (const bad of invalid) {
    const f = fixture();
    assert.equal(f.controller.receive(bad), false);
    assert.deepEqual(f.target.get(), createUrgentAnnouncementState());
    assert.equal(f.network.calls.length, 0);
    assert.equal(f.clock.pending.size, 0);
  }
});

test('msgid deduplication survives acknowledgement; a distinct send of the same revision is accepted', () => {
  const f = fixture();
  const notice = frameOf();
  assert.equal(f.controller.receive(notice), true);
  assert.equal(f.controller.receive(notice), false);
  f.controller.close();
  assert.equal(f.target.get().open, false);
  assert.equal(f.controller.receive(notice), false);
  assert.equal(f.controller.receive(frameOf(2)), true);
  assert.equal(f.target.get().notice.msgid, msgid(2));
});

test('expired seen entries are removed on receive even if a suspended tab did not run its timer', () => {
  const f = fixture({ maxSeen: 1 });
  assert.equal(f.controller.receive(frameOf()), true);
  f.controller.close();
  f.clock.set(NOW + ANNOUNCEMENT_NOTICE_TTL_MS);
  assert.equal(f.controller.receive(frameOf(1, 'a', f.clock.now())), true);
  assert.equal(f.target.get().notice.createdAt, f.clock.now());
});

test('maxSeen preserves unexpired duplicate records and accepts new messages after TTL cleanup', () => {
  const f = fixture({ maxSeen: 2 });
  assert.equal(f.controller.receive(frameOf(1)), true);
  f.controller.close();
  assert.equal(f.controller.receive(frameOf(2, 'b')), true);
  f.controller.close();
  assert.equal(f.controller.receive(frameOf(3, 'c')), false);
  assert.equal(f.controller.receive(frameOf(1)), false);
  f.clock.advance(ANNOUNCEMENT_NOTICE_TTL_MS);
  assert.equal(f.clock.pending.size, 0);
  assert.equal(f.controller.receive(frameOf(3, 'c', f.clock.now())), true);
});

test('FIFO includes the current notice in capacity and does not fetch queued details prematurely', () => {
  const f = fixture({ maxQueue: 3 });
  const a = frameOf(1, 'a');
  const b = frameOf(2, 'b');
  const c = frameOf(3, 'c');
  const d = frameOf(4, 'd');
  for (const notice of [a, b, c]) assert.equal(f.controller.receive(notice), true);
  assert.equal(f.controller.receive(d), false);
  assert.deepEqual(f.target.get().queue, [b, c]);
  assert.equal(f.target.get().remaining, 3);
  assert.equal(f.network.calls.length, 1);
  f.controller.close();
  assert.equal(f.target.get().notice.id, 'b');
  assert.equal(f.target.get().remaining, 2);
  assert.equal(f.controller.receive(d), true, 'a rejected overflow frame was not marked as seen');
  assert.deepEqual(f.target.get().queue, [c, d]);
  f.controller.close();
  assert.equal(f.target.get().notice.id, 'c');
  f.controller.close();
  assert.equal(f.target.get().notice.id, 'd');
  f.controller.close();
  assert.deepEqual(f.target.get(), createUrgentAnnouncementState());
  assert.deepEqual(f.network.calls.map((call) => call.url), ['/api/announcements/a', '/api/announcements/b', '/api/announcements/c', '/api/announcements/d']);
});

test('default queue capacity is exactly 32 total notices and overflow preserves the existing order', () => {
  const f = fixture();
  for (let i = 1; i <= 32; i++) assert.equal(f.controller.receive(frameOf(i, `a${i}`)), true);
  assert.equal(f.target.get().remaining, 32);
  assert.equal(f.target.get().queue.length, 31);
  assert.equal(f.controller.receive(frameOf(33, 'a33')), false);
  for (let i = 1; i <= 32; i++) {
    assert.equal(f.target.get().notice.id, `a${i}`);
    f.controller.close();
  }
  assert.equal(f.target.get().open, false);
});

test('timer expires queued entries and seen IDs while the currently displayed notice stays readable', async () => {
  const f = fixture();
  const a = frameOf(1, 'a');
  f.controller.receive(a);
  f.controller.receive(frameOf(2, 'b'));
  f.clock.advance(ANNOUNCEMENT_NOTICE_TTL_MS);
  assert.equal(f.target.get().open, true);
  assert.deepEqual(f.target.get().notice, a);
  assert.deepEqual(f.target.get().queue, []);
  assert.equal(f.target.get().remaining, 1);
  assert.equal(f.clock.pending.size, 0);
  await f.network.reply(0, detailOf(a));
  assert.deepEqual(f.target.get().detail, detailOf(a), 'TTL does not discard a displayed detail that finishes late');
  f.controller.close();
  assert.equal(f.target.get().open, false);
  assert.equal(f.network.calls.length, 1);
});

test('close prunes expired queued notices and advances to the next valid notice after a long suspension', () => {
  const f = fixture();
  f.controller.receive(frameOf(1, 'a'));
  f.controller.receive(frameOf(2, 'b'));
  f.clock.set(NOW + 1000);
  const c = frameOf(3, 'c', f.clock.now());
  f.controller.receive(c);
  f.clock.set(NOW + ANNOUNCEMENT_NOTICE_TTL_MS);
  f.controller.close();
  assert.deepEqual(f.target.get().notice, c);
  assert.deepEqual(f.target.get().queue, []);
  assert.equal(f.target.get().remaining, 1);
  assert.deepEqual(f.network.calls.map((call) => call.url), ['/api/announcements/a', '/api/announcements/c']);
});

test('explicit expire never acknowledges the current notice and frees expired queue capacity', () => {
  const f = fixture({ maxQueue: 2 });
  f.controller.receive(frameOf(1, 'a'));
  f.controller.receive(frameOf(2, 'b'));
  f.clock.set(NOW + ANNOUNCEMENT_NOTICE_TTL_MS);
  f.controller.expire();
  assert.equal(f.target.get().open, true);
  assert.equal(f.target.get().notice.id, 'a');
  assert.equal(f.target.get().remaining, 1);
  assert.equal(f.controller.receive(frameOf(3, 'c', f.clock.now())), true);
  f.controller.close();
  assert.equal(f.target.get().notice.id, 'c');
});

test('closing invalidates and aborts pending details; late success and failure do not reopen the overlay', async () => {
  for (const fail of [false, true]) {
    const f = fixture();
    f.controller.receive(frameOf());
    f.controller.close();
    const closed = f.target.get();
    assert.equal(f.network.calls[0].options.signal.aborted, true);
    if (fail) await f.network.fail(0);
    else await f.network.reply(0, detailOf(frameOf()));
    assert.equal(f.target.get(), closed);
  }
});

test('late detail for a closed notice cannot overwrite the next notice even if both reference the same article', async () => {
  for (const nextId of ['a', 'b']) {
    const f = fixture();
    const a = frameOf(1, 'a');
    const b = frameOf(2, nextId);
    f.controller.receive(a);
    f.controller.receive(b);
    f.controller.close();
    await f.network.reply(1, detailOf(b, '下一条正文'));
    const next = f.target.get();
    await f.network.reply(0, detailOf(a, '上一条迟到正文'));
    assert.equal(f.target.get(), next);
    assert.equal(f.target.get().detail.markdown, '下一条正文');
    assert.equal(f.target.get().notice.msgid, b.msgid);
  }
});

test('after a long closed interval a newly delivered notice opens without an earlier response interfering', async () => {
  const f = fixture();
  f.controller.receive(frameOf(1, 'a'));
  f.controller.close();
  f.clock.advance(ANNOUNCEMENT_NOTICE_TTL_MS * 10);
  const b = frameOf(2, 'b', f.clock.now());
  assert.equal(f.controller.receive(b), true);
  await f.network.reply(0, detailOf(frameOf(1, 'a')));
  assert.equal(f.target.get().loading, true);
  assert.deepEqual(f.target.get().notice, b);
  await f.network.reply(1, detailOf(b));
  assert.deepEqual(f.target.get().detail, detailOf(b));
});

test('HTTP failures and malformed details expose one stable error while retaining the current notice', async () => {
  const notice = frameOf();
  const valid = detailOf(notice);
  const badDetails = [
    null, {}, { ...valid, id: 'b' }, { ...valid, revision: 'pub-other' },
    { ...valid, title: '' }, { ...valid, title: 'bad\nname' }, { ...valid, publishedAt: 'yesterday' },
    { ...valid, markdown: null }, { ...valid, markdown: 'x'.repeat(ANNOUNCEMENT_MAX_BODY_CHARS + 1) },
  ];
  for (const detail of badDetails) {
    const f = fixture();
    f.controller.receive(notice);
    await f.network.reply(0, detail);
    assert.equal(f.target.get().error, 'DETAIL_UNAVAILABLE');
    assert.equal(f.target.get().loading, false);
    assert.equal(f.target.get().detail, null);
    assert.deepEqual(f.target.get().notice, notice);
    assert.equal(f.target.get().open, true);
  }
  for (const httpFailure of [false, true]) {
    const f = fixture();
    f.controller.receive(notice);
    if (httpFailure) await f.network.reply(0, valid, false);
    else await f.network.fail(0);
    assert.equal(f.target.get().error, 'DETAIL_UNAVAILABLE');
  }
});

test('body character limit accepts exactly the shared maximum', async () => {
  const f = fixture();
  const notice = frameOf();
  f.controller.receive(notice);
  await f.network.reply(0, detailOf(notice, '字'.repeat(ANNOUNCEMENT_MAX_BODY_CHARS)));
  assert.equal(f.target.get().error, null);
  assert.equal(f.target.get().detail.markdown.length, ANNOUNCEMENT_MAX_BODY_CHARS);
});

test('retry only loads the displayed notice and still works after its receipt TTL has elapsed', async () => {
  const f = fixture();
  const notice = frameOf();
  await f.controller.retry();
  assert.equal(f.network.calls.length, 0);
  f.controller.receive(notice);
  await f.network.fail(0);
  f.clock.advance(ANNOUNCEMENT_NOTICE_TTL_MS);
  const pending = f.controller.retry();
  assert.equal(f.target.get().error, null);
  assert.equal(f.target.get().loading, true);
  assert.equal(f.network.calls.length, 2);
  await f.network.reply(1, detailOf(notice));
  await pending;
  assert.deepEqual(f.target.get().detail, detailOf(notice));
  f.controller.close();
  await f.controller.retry();
  assert.equal(f.network.calls.length, 2);
});

test('a second retry invalidates a previous retry and only the latest request may update details', async () => {
  const f = fixture();
  const notice = frameOf();
  f.controller.receive(notice);
  const first = f.controller.retry();
  const second = f.controller.retry();
  assert.equal(f.network.calls[0].options.signal.aborted, true);
  assert.equal(f.network.calls[1].options.signal.aborted, true);
  await f.network.reply(2, detailOf(notice, '最新请求'));
  await second;
  const latest = f.target.get();
  await f.network.fail(1);
  await first;
  await f.network.reply(0, detailOf(notice, '首次请求'));
  assert.equal(f.target.get(), latest);
});

test('receipt and close do not share caller or published queue arrays with the internal FIFO', () => {
  const f = fixture();
  const a = frameOf(1, 'a');
  const b = frameOf(2, 'b');
  f.controller.receive(a);
  f.controller.receive(b);
  a.id = 'mutated';
  b.id = 'mutated';
  f.target.get().queue.length = 0;
  f.controller.close();
  assert.equal(f.target.get().notice.id, 'b');
  assert.equal(f.target.get().remaining, 1);
});

test('disposal aborts details and clears timers, queue and state; no public or late callback writes afterwards', async () => {
  const f = fixture();
  f.controller.receive(frameOf(1, 'a'));
  f.controller.receive(frameOf(2, 'b'));
  const callback = [...f.clock.pending.values()][0].callback;
  f.controller.dispose();
  const disposed = f.target.get();
  assert.deepEqual(disposed, createUrgentAnnouncementState());
  assert.equal(f.network.calls[0].options.signal.aborted, true);
  assert.equal(f.clock.pending.size, 0);
  await f.network.reply(0, detailOf(frameOf()));
  assert.equal(f.controller.receive(frameOf(3, 'c')), false);
  f.controller.close();
  f.controller.expire();
  f.controller.dispose();
  callback();
  await f.controller.retry();
  assert.equal(f.target.get(), disposed);
  assert.equal(f.network.calls.length, 1);
  assert.equal(f.clock.pending.size, 0);
});
