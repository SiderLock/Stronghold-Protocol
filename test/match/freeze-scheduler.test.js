import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FreezeScheduler } from '../../server/match/freezeScheduler.js';
import { VirtualScheduler } from '../../server/match/scheduler.js';

test('virtual runners advance through the wrapper, respecting freeze and disposal', () => {
  const source = new VirtualScheduler();
  const scheduler = new FreezeScheduler(source);
  const fired = [];
  scheduler.setTimeout(() => fired.push(1), 10);
  assert.equal(scheduler.runNext(), true);
  assert.deepEqual(fired, [1]);
  scheduler.setTimeout(() => fired.push(2), 10);
  scheduler.freeze();
  assert.equal(scheduler.runNext(), false);
  assert.deepEqual(fired, [1]);
  scheduler.resume();
  assert.equal(scheduler.runNext(), true);
  assert.deepEqual(fired, [1, 2]);
  scheduler.dispose();
  assert.equal(scheduler.runNext(), false);
});

test('freeze preserves timeout/interval handles and their remaining delay, without missed-tick replay', () => {
  const source = new VirtualScheduler({ start: 1000 });
  const scheduler = new FreezeScheduler(source);
  const fired = [];
  scheduler.setTimeout(() => fired.push(['timeout', source.now()]), 100);
  const cancelled = scheduler.setTimeout(() => fired.push(['cancelled']), 120);
  const interval = scheduler.setInterval(() => fired.push(['interval', source.now()]), 50);
  source.advance(20);
  scheduler.freeze();
  scheduler.clearTimeout(cancelled);
  scheduler.setTimeout(() => fired.push(['during', source.now()]), 10);
  source.advance(10000);
  assert.equal(scheduler.now(), 11020, 'public wall clock continues');
  assert.equal(scheduler.gameNow(), 1020, 'game clock stays at the freeze epoch');
  assert.deepEqual(fired, []);
  assert.equal(source.pending(), 0);
  assert.equal(scheduler.resume(), 10000);
  source.advance(9);
  assert.deepEqual(fired, []);
  source.advance(1);
  assert.deepEqual(fired, [['during', 11030]]);
  source.advance(20);
  assert.deepEqual(fired.at(-1), ['interval', 11050]);
  scheduler.clearInterval(interval);
  source.advance(50);
  assert.deepEqual(fired.at(-1), ['timeout', 11100]);
  assert.equal(fired.length, 3);
  scheduler.dispose();
  assert.equal(source.disposed, false, 'an injected source belongs to its caller');
});

test('dispose while frozen cancels held intervals and never schedules them again', () => {
  const source = new VirtualScheduler();
  const scheduler = new FreezeScheduler(source, { ownsSource: true });
  scheduler.setInterval(() => assert.fail('disposed interval fired'), 100);
  scheduler.freeze();
  scheduler.dispose();
  scheduler.resume();
  assert.equal(source.disposed, true);
  assert.equal(source.pending(), 0);
  assert.equal(scheduler.handles.size, 0);
});
