import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorkQueue } from '../../server/match/workQueue.js';
import { RealScheduler, VirtualScheduler } from '../../server/match/scheduler.js';
import { FreezeScheduler } from '../../server/match/freezeScheduler.js';
import { HeadlessJob } from '../../server/match/fields.js';

function fixture(options = {}) {
  let at = 1000, sequence = 0;
  const turns = new Map();
  const queue = createWorkQueue({ now: () => at, defer: fn => { const id = ++sequence; turns.set(id, fn); return id; },
    clear: id => turns.delete(id), ...options });
  return { queue, now: () => at, spend(ms) { at += ms; }, pending: () => turns.size,
    turn() { const [id, fn] = turns.entries().next().value; turns.delete(id); fn(); } };
}

test('fourteen AI jobs share one turn budget and let unrelated work run between them', () => {
  const f = fixture(), seen = [];
  for (let i = 0; i < 14; i++) f.queue.submit(() => { seen.push(i); f.spend(8); });
  assert.equal(f.pending(), 1, 'one process-level drain, not fourteen independent timers');
  f.turn();
  assert.deepEqual(seen, [0]);
  seen.push('player request');
  while (f.pending()) f.turn();
  assert.deepEqual(seen, [0, 'player request', ...Array.from({ length: 13 }, (_, i) => i + 1)]);
  assert.equal(f.queue.stats().queued, 0);
  assert.equal(f.queue.stats().completed, 14);
});

test('a cheap self-rescheduling computation yields even when its clock never advances', () => {
  const f = fixture();
  let calls = 0;
  const run = () => { if (++calls < 1000) f.queue.submit(run); };
  f.queue.submit(run);
  f.turn();
  assert.ok(calls > 0 && calls < 1000, 'network timers still get a turn with a coarse clock');
  while (f.pending()) f.turn();
  assert.equal(calls, 1000);
});

test('freezing/cancelling one room keeps another room running and preserves stable handles on resume', () => {
  const f = fixture(), seen = [];
  const a = new RealScheduler({ now: f.now, workQueue: f.queue });
  const b = new RealScheduler({ now: f.now, workQueue: f.queue });
  const frozen = new FreezeScheduler(a, { ownsSource: true });
  const held = frozen.setTimeout(() => seen.push('held'), 0, { work: 'bot' });
  const cancelled = frozen.setTimeout(() => seen.push('cancelled'), 0, { work: 'battle' });
  b.setTimeout(() => seen.push('other room'), 0, { work: 'bot' });
  frozen.freeze();
  frozen.clearTimeout(cancelled);
  f.turn();
  assert.deepEqual(seen, ['other room']);
  f.spend(60000);
  frozen.resume();
  assert.ok(frozen.handles.has(held));
  f.turn();
  assert.deepEqual(seen, ['other room', 'held']);
  assert.equal(frozen.handles.size, 0);
  frozen.dispose(); b.dispose();
  assert.equal(f.pending(), 0);
});

test('disposal cancels queued and delayed computations without cancelling another scheduler', () => {
  const f = fixture(), seen = [];
  const a = new RealScheduler({ workQueue: f.queue }), b = new RealScheduler({ workQueue: f.queue });
  a.setTimeout(() => assert.fail('disposed queued work'), 0, { work: 'battle' });
  a.setTimeout(() => assert.fail('disposed delayed work'), 60000, { work: 'bot' });
  b.setTimeout(() => seen.push('survived'), 0, { work: 'bot' });
  a.dispose();
  f.turn();
  assert.deepEqual(seen, ['survived']);
  assert.equal(a._work.size, 0);
  assert.equal(b._work.size, 0);
  b.dispose();
});

test('a failed job cannot strand later jobs and cancelling the last task removes its timer', () => {
  const errors = [], f = fixture({ onError: e => errors.push(e.message) });
  let completed = false;
  f.queue.submit(() => { throw new Error('test failure'); });
  f.queue.submit(() => { completed = true; });
  f.turn();
  assert.deepEqual(errors, ['test failure']);
  assert.equal(completed, true);
  const pending = f.queue.submit(() => assert.fail('cancelled task'));
  f.queue.cancel(pending);
  f.queue.cancel(pending);
  assert.equal(f.pending(), 0);
  assert.equal(f.queue.stats().cancelled, 1);
});

test('slow-slice evidence is bounded, includes queue wait, and cannot interrupt computation', () => {
  const f = fixture(), evidence = [];
  const slow = () => f.spend(30);
  const options = { work: 'battle', onSlow: sample => { evidence.push(sample); throw new Error('logger unavailable'); } };
  f.queue.submit(slow, options);
  f.spend(100);
  f.turn();
  f.queue.submit(slow, options); f.turn();
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].waitMs, 100);
  assert.equal(evidence[0].work, 'battle');
  f.spend(30000);
  f.queue.submit(slow, options); f.turn();
  assert.equal(evidence.length, 2);
  assert.equal(f.queue.stats().completed, 3);
});

test('virtual match callbacks retain their original ordering and timing with work metadata', () => {
  const source = new VirtualScheduler({ start: 0 }), scheduler = new FreezeScheduler(source), fired = [];
  scheduler.setTimeout(() => fired.push('compute'), 0, { work: 'battle' });
  scheduler.setTimeout(() => fired.push('ordinary'), 0);
  source.advance(0);
  assert.deepEqual(fired, ['compute', 'ordinary']);
  assert.equal(source.now(), 0);
  scheduler.dispose(); source.dispose();
});

test('ordinary headless work checks its budget promptly while recorded journals retain their step boundaries', () => {
  function battle() {
    let wall = 0;
    return { now: () => wall, finished: false, time: 0, total: 100, killed: 0,
      step() { wall += 2; this.time += 1 / 30; } };
  }
  const ordinary = battle();
  const job = new HeadlessJob(ordinary);
  assert.equal(job.run(8, ordinary.now), false);
  assert.ok(ordinary.now() <= 16, 'a small budget cannot be delayed by a full sixteen-tick chunk');
  let noted = 0;
  const replay = battle(), journal = new HeadlessJob(replay);
  assert.equal(journal.run(8, replay.now, { replaying: true, note() { noted++; }, stop: () => noted >= 16 }), false);
  assert.equal(noted, 16, 'existing journal boundaries still replay exactly');
});
