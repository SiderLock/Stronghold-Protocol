import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setTimeout as pause } from 'node:timers/promises';
import { createRehearsalPool } from '../../server/match/rehearsalPool.js';
import { Battle } from '../../server/sim/Battle.js';
import { DataSource } from '../../server/sim/simdata.js';
import { RehearsalRun, rehearsalCap } from '../../server/sim/rehearsal.js';
import { getData } from '../../server/data.js';
import { makeMatch } from './harness.js';
import { runHeadless } from '../../server/match/fields.js';
import { createBattleFromSpec, resultDigest } from '../../server/sim/spec.js';
import { RESULT_LIMITS } from '../../shared/protocol.js';

const data = getData({ log: {} });
const spec = JSON.parse(readFileSync(new URL('../../public/dev/perf/hard-normal-r13.json', import.meta.url))).spec;
const payload = { inputs: [{ ...spec, players: spec.players.map(p => ({ ...p, units: [] })) }, spec],
  content: 'full', playerId: spec.players[0].playerId, cap: rehearsalCap(spec.timeLimit) };
const source = new DataSource(data, null);

test('child previews pick exactly the synchronous winner, run concurrently and release resources', async () => {
  const pool = createRehearsalPool({ data, workers: 2 });
  try {
    const run = new RehearsalRun(payload.inputs.map(opts => () => new Battle({ ...opts, data: source, recordEvents: false })), payload.playerId, payload.cap);
    run.run();
    assert.equal(run.score.index, 1, 'the child must choose a better later candidate, not always index zero');
    const first = pool.submit(payload), second = pool.submit(payload);
    let pending = true, ticks = 0;
    const timer = setInterval(() => { if (pending) ticks++; }, 5);
    try {
      const picks = await Promise.all([first.promise, second.promise]);
      pending = false;
      assert.deepEqual(picks, [run.score.index, run.score.index]);
      assert.ok(ticks > 2, 'parent timers run while child simulations are outstanding');
      assert.equal(pool.stats().running, 0);
      assert.equal(pool.stats().queued, 0);
    } finally { clearInterval(timer); }
  } finally { pool.close(); }
  assert.equal(pool.stats().workers, 0);
  assert.equal(pool.submit(payload), null);
});

test('cancelling a running or queued preview rejects it without applying a late result', async () => {
  const pool = createRehearsalPool({ data, workers: 1 });
  try {
    const first = pool.submit(payload), queued = pool.submit(payload);
    const rejected = Promise.all([assert.rejects(first.promise), assert.rejects(queued.promise)]);
    queued.cancel();
    for (let i = 0; i < 500 && !pool.stats().running; i++) await pause(10);
    assert.equal(pool.stats().running, 1);
    first.cancel();
    await rejected;
    assert.equal(pool.stats().running, 0);
    assert.equal(pool.stats().queued, 0);
  } finally { pool.close(); }
});

test('disabled pools and queue shutdown leave no pending work', async () => {
  const disabled = createRehearsalPool({ data, workers: 0 });
  assert.equal(disabled.submit(payload), null);
  disabled.close();
  const pool = createRehearsalPool({ data, workers: 1 });
  const first = pool.submit(payload), second = pool.submit(payload);
  const rejected = Promise.all([assert.rejects(first.promise), assert.rejects(second.promise)]);
  pool.close();
  await rejected;
  assert.equal(pool.stats().workers, 0);
});

test('batch cancellation does not start replacement children before the remaining fields can be cancelled', async () => {
  const pool = createRehearsalPool({ data, workers: 1 });
  const tasks = Array.from({ length: 3 }, () => pool.submit(payload));
  const rejected = tasks.map(task => assert.rejects(task.promise));
  try {
    for (let i = 0; i < 500 && !pool.stats().running; i++) await pause(5);
    assert.equal(pool.stats().running, 1);
    tasks[0].cancel();
    assert.equal(pool.stats().workers, 0, 'replacement waits until this cancellation stack ends');
    tasks[1].cancel(); tasks[2].cancel();
    await Promise.all(rejected);
    await pause(5);
    assert.equal(pool.stats().workers, 0);
    assert.equal(pool.stats().queued, 0);
  } finally { pool.close(); }
});

test('eight manual humans plus twelve AI seats finish worker-backed prep and leave humans in control', async () => {
  const h = makeMatch({ humans: 8, bots: 12, botRehearsal: 3, seed: 4 }).start().toPrep();
  const m = h.m;
  const pool = createRehearsalPool({ data: m.data, workers: 2 });
  const submit = pool.submit;
  let submitted = 0;
  pool.submit = (...args) => { submitted++; return submit(...args); };
  // Exercise real IPC with the harness's deterministic clock held inside this prep.
  m.rehearsalPool = pool;
  m.botSliceMs = 8;
  try {
    const bots = m.order.filter(ps => ps.isBot);
    for (const ps of bots) m.scheduleBotPrep(ps);
    h.sched.advance(1000);
    for (let i = 0; i < 1000 && bots.some(ps => !ps.ready); i++) {
      await pause(10);
      h.sched.advance(0);
    }
    assert.ok(submitted > 0, 'actual layout jobs reached the process pool');
    assert.ok(bots.every(ps => ps.ready));
    assert.ok(m.humans().every(ps => !ps.ready), 'no worker readies a manual human');
    assert.equal(m.phase, 'PREP');
    assert.equal(m.errorCount, 0);
    h.invariants();
  } finally { m.dispose(); pool.close(); }
});

test('worker failure resumes the original sliced preview', async () => {
  const h = makeMatch({ humans: 1, bots: 1, botRehearsal: 3, seed: 4 }).start().toPrep();
  const m = h.m;
  const ps = m.order.find(p => p.isBot);
  let submitted = 0;
  m.rehearsalPool = { submit() { submitted++; return { promise: Promise.reject(new Error('worker failed')), cancel() {} }; } };
  m.botSliceMs = 8;
  try {
    m.scheduleBotPrep(ps);
    h.sched.advance(1000);
    for (let i = 0; i < 100 && !ps.ready; i++) { await pause(1); h.sched.advance(0); }
    assert.ok(submitted > 0);
    assert.ok(ps.ready, 'failure used the original local job');
    assert.equal(m.errorCount, 0);
    assert.ok(h.logs.warn.some(line => line.includes('rehearsal fallback')));
    h.invariants();
  } finally { m.dispose(); }
});

test('ending prep cancels its tasks and ignores an answer arriving afterward', async () => {
  const h = makeMatch({ humans: 1, bots: 1, botRehearsal: 3, seed: 4 }).start().toPrep();
  const m = h.m, ps = m.order.find(p => p.isBot);
  let answer, cancelled = 0;
  m.rehearsalPool = { submit() { return { promise: new Promise(resolve => { answer = resolve; }), cancel() { cancelled++; } }; } };
  m.botSliceMs = 8;
  try {
    m.scheduleBotPrep(ps);
    h.sched.advance(1000);
    assert.equal(typeof answer, 'function');
    m.phase = 'COMBAT';
    const board = JSON.stringify([...ps.board]);
    m._cancelRehearsal();
    answer(1);
    await pause(1);
    h.sched.advance(0);
    assert.equal(cancelled, 1);
    assert.equal(m._workerRehearsals.size, 0);
    assert.equal(ps.ready, false);
    assert.equal(JSON.stringify([...ps.board]), board);
  } finally { m.dispose(); }
});

test('a pool startup timeout rejects queued work once and disables further submissions', async () => {
  const pool = createRehearsalPool({ data, workers: 1, timeoutMs: 1 });
  try {
    const task = pool.submit(payload);
    await assert.rejects(task.promise, /startup timeout/);
    assert.equal(pool.stats().disabled, true);
    assert.equal(pool.stats().workers, 0);
    assert.equal(pool.submit(payload), null);
  } finally { pool.close(); }
});

test('an oversized 600-enemy result replays in the child with full losses and the synchronous digest', async () => {
  const h = makeMatch({ humans: 1, clientCombat: true, clients: false }).start();
  const m = h.m;
  h.drive(() => m.phase === 'COMBAT');
  const field = m.fields[0];
  const original = field.spec.spawns[0];
  field.spec.spawns = Array.from({ length: 600 }, () => ({ ...original, count: 1 }));
  const expected = runHeadless(createBattleFromSpec(field.spec, m.ds, { recordEvents: false }), { players: field.players });
  assert.ok(expected.result.perPlayer.p_0.leaked.length > RESULT_LIMITS.leaked);
  const pool = createRehearsalPool({ data: m.data, workers: 1 });
  m.rehearsalPool = pool;
  let released = 0, parentBuilds = 0;
  m._armRelease = () => { released++; };
  m._specBattle = () => { parentBuilds++; throw new Error('must not replay on the network thread'); };
  try {
    assert.deepEqual(m._onYield(h.ps('p_0'), { battleId: field.battleId }), { ok: true });
    for (let i = 0; i < 2000 && !released; i++) { await pause(5); h.sched.advance(0); }
    assert.equal(released, 1);
    assert.equal(parentBuilds, 0);
    assert.equal(field.resultSource, 'server');
    assert.equal(resultDigest(field.result).hash, resultDigest(expected.result).hash);
    assert.equal(field.result.perPlayer.p_0.leaked.length, 600);
    assert.deepEqual(field.timeline, expected.timeline);
    assert.equal(field.endGt, expected.battle.time);
    assert.equal(m.errorCount, 0);
  } finally { m.dispose(); pool.close(); }
});

test('six manual humans and fourteen AI fields use the shared child without building battles on the network thread', async () => {
  const h = makeMatch({ humans: 6, bots: 14, clientCombat: true, clients: false, instant: false });
  const m = h.m, pool = createRehearsalPool({ data: m.data, workers: 1 });
  m.rehearsalPool = pool;
  let parentBuilds = 0;
  m._specBattle = () => { parentBuilds++; throw new Error('ordinary AI fields must use the child'); };
  try {
    h.start();
    assert.ok(h.drive(() => m.phase === 'COMBAT'));
    const bots = m.fields.filter(f => f.mode === 'server'), humans = m.fields.filter(f => f.mode === 'client');
    assert.equal(bots.length, 14);
    assert.equal(humans.length, 6);
    const expected = bots.map(f => runHeadless(createBattleFromSpec(f.spec, m.ds, { recordEvents: false }), { players: f.players }));
    for (let i = 0; i < 2000 && bots.some(f => !f.result); i++) { await pause(5); h.sched.advance(0); }
    assert.ok(bots.every(f => f.result && !f.done), 'results are held for their natural field-clock release');
    assert.ok(humans.every(f => f.mode === 'client' && f.authority && !f.result), 'manual humans retain authority');
    assert.equal(parentBuilds, 0);
    for (let i = 0; i < bots.length; i++) {
      assert.equal(resultDigest(bots[i].result).hash, resultDigest(expected[i].result).hash);
      assert.deepEqual(bots[i].timeline, expected[i].timeline);
      assert.equal(bots[i].endGt, expected[i].battle.time);
    }
    const end = Math.max(...bots.map(f => f.startAt + Math.round(f.endGt * 1000 / m.gameSpeed)));
    h.sched.advance(end - h.sched.now());
    assert.ok(bots.every(f => f.done), 'the result is released at the original natural time');
    assert.equal(m.phase, 'COMBAT', 'the server does not auto-complete the humans');
    assert.equal(m.errorCount, 0);
  } finally { m.dispose(); pool.close(); }
});

test('a no-human co-op unite field uses the child and preserves its full timeline and settlement', async () => {
  const h = makeMatch({ humans: 1, clientCombat: true, clients: false });
  const m = h.m, pool = createRehearsalPool({ data: m.data, workers: 1 });
  const unite = JSON.parse(readFileSync(new URL('../../public/dev/perf/hard-unite-r13.json', import.meta.url))).spec;
  const f = m._ccField({ fieldId: 'u', kind: 'unite', players: unite.players.map(p => p.playerId), opts: unite });
  const expected = runHeadless(createBattleFromSpec(f.spec, m.ds, { recordEvents: false }), { players: f.players });
  m.fields = [f]; m.rehearsalPool = pool;
  let released = 0;
  m._armRelease = () => { released++; };
  m._specBattle = () => { throw new Error('unite must use the child'); };
  try {
    m._runOnServer(f, 'no-human');
    for (let i = 0; i < 2000 && !released; i++) { await pause(5); h.sched.advance(0); }
    assert.equal(released, 1);
    assert.equal(f.battle, null);
    assert.equal(resultDigest(f.result).hash, resultDigest(expected.result).hash);
    assert.deepEqual(f.timeline, expected.timeline);
    assert.equal(f.endGt, expected.battle.time);
    assert.equal(m.errorCount, 0);
  } finally { m.dispose(); pool.close(); }
});

for (const refusal of ['full', 'failure']) {
  test(`an ordinary field falls back once when its child pool reports ${refusal}`, async () => {
    const h = makeMatch({ humans: 1, clientCombat: true, clients: false, headlessSliceMs: 0.00001 }).start();
    const m = h.m;
    h.drive(() => m.phase === 'COMBAT');
    const f = m.fields[0], expected = runHeadless(createBattleFromSpec(f.spec, m.ds, { recordEvents: false }), { players: f.players });
    let submits = 0, released = 0;
    m.rehearsalPool = { submit() { submits++; return refusal === 'full' ? null : {
      promise: Promise.reject(new Error('test pool failure')), cancel() {},
    }; } };
    m._armRelease = () => { released++; };
    try {
      m._runOnServer(f, 'no-human');
      for (let i = 0; i < 200 && !released; i++) { await pause(1); h.sched.advance(0); }
      assert.equal(submits, 1);
      assert.equal(released, 1);
      assert.equal(resultDigest(f.result).hash, resultDigest(expected.result).hash);
      assert.equal(m.errorCount, 0);
    } finally { m.dispose(); }
  });
}

test('a normal-field child answer stays held while frozen and cannot apply after field cancellation', async () => {
  const h = makeMatch({ humans: 1, clientCombat: true, clients: false }).start();
  const m = h.m;
  h.drive(() => m.phase === 'COMBAT');
  const f = m.fields[0];
  let answer, cancelled = 0;
  m.rehearsalPool = { submit() { return { promise: new Promise(resolve => { answer = resolve; }), cancel() { cancelled++; } }; } };
  try {
    m._runOnServer(f, 'no-human');
    m.sched.freeze();
    answer({ result: { perPlayer: {} }, timeline: [], time: 1, errors: [], failures: [] });
    await pause(1); h.sched.advance(0);
    assert.equal(f.result, null);
    m._clearFieldTimers(f);
    m.sched.resume(); h.sched.advance(0);
    assert.equal(cancelled, 1);
    assert.equal(f.result, null, 'cancelled output cannot be applied on resume');
  } finally { m.dispose(); }
});

test('a frozen normal-field child answer applies exactly once after resume', async () => {
  const h = makeMatch({ humans: 1, clientCombat: true, clients: false }).start();
  const m = h.m;
  h.drive(() => m.phase === 'COMBAT');
  const f = m.fields[0];
  let answer, released = 0;
  const output = { result: { perPlayer: {} }, timeline: [[0, 0, 0, 0]], time: 1, errors: [], failures: [] };
  m.rehearsalPool = { submit() { return { promise: new Promise(resolve => { answer = resolve; }), cancel() {} }; } };
  m._armRelease = () => { released++; };
  try {
    m._runOnServer(f, 'no-human');
    m.sched.freeze();
    answer(output);
    await pause(1); h.sched.advance(0);
    assert.equal(f.result, null);
    assert.equal(released, 0);
    m.sched.resume(); h.sched.advance(0);
    assert.equal(f.result, output.result);
    assert.equal(f.workerTask, null);
    assert.equal(released, 1);
    h.sched.advance(0);
    assert.equal(released, 1);
  } finally { m.dispose(); }
});

test('clearing a field cancels its replay and refuses late worker output', async () => {
  const h = makeMatch({ humans: 1, clientCombat: true, clients: false }).start();
  const m = h.m;
  h.drive(() => m.phase === 'COMBAT');
  const field = m.fields[0];
  let resolve, cancelled = 0;
  m.rehearsalPool = { submit() { return { promise: new Promise(done => { resolve = done; }), cancel() { cancelled++; } }; } };
  try {
    m._onYield(h.ps('p_0'), { battleId: field.battleId });
    m._stopClientCombat();
    resolve({ result: { perPlayer: {} }, timeline: [], time: 1, errors: [], failures: [] });
    await pause(1); h.sched.advance(0);
    assert.equal(cancelled, 1);
    assert.equal(field.workerTask, null);
    assert.equal(field.result, null);
  } finally { m.dispose(); }
});

test('a failed oversized replay falls back once to the existing sliced simulation', async () => {
  const h = makeMatch({ humans: 1, clientCombat: true, clients: false, headlessSliceMs: 0.00001 }).start();
  const m = h.m;
  h.drive(() => m.phase === 'COMBAT');
  const field = m.fields[0];
  const expected = runHeadless(createBattleFromSpec(field.spec, m.ds, { recordEvents: false }), { players: field.players });
  m.rehearsalPool = { submit() { return { promise: Promise.reject(new Error('worker unavailable')), cancel() {} }; } };
  let released = 0;
  m._armRelease = () => { released++; };
  try {
    m._onYield(h.ps('p_0'), { battleId: field.battleId });
    for (let i = 0; i < 100 && !released; i++) { await pause(1); h.sched.advance(0); }
    assert.equal(released, 1);
    assert.equal(m.verifyStats.takeovers, 1);
    assert.equal(resultDigest(field.result).hash, resultDigest(expected.result).hash);
    assert.equal(m.errorCount, 0);
    assert.ok(h.logs.warn.some(line => line.includes('battle replay fallback')));
  } finally { m.dispose(); }
});
