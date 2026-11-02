import test from 'node:test';
import assert from 'node:assert/strict';
import { store, serverNow, emergencyActive, emergencyClockAt, matchClockNow } from '../../public/js/store.js';
import { secondsLeft } from '../../public/js/ui/components.js';
import { isPaused, pauseAvailable } from '../../public/js/ui/matchStatus.js';

test('emergency freezes countdowns across global notice and match resync without changing solo pause', (t) => {
  t.after(() => store.reset());
  const since = serverNow();
  const pub = { phase: 'COMBAT', paused: false, emergencyFrozen: false, deadline: since + 30000 };
  store.patch('match', { public: pub });
  store.set({ emergency: { active: true, since } });
  assert.equal(emergencyActive(), true);
  assert.equal(emergencyClockAt(), since);
  assert.equal(matchClockNow(since + 120000), since);
  assert.equal(secondsLeft(pub.deadline), 30);
  assert.equal(isPaused(pub), false);
  assert.equal(pauseAvailable(pub, { solo: false }), false, 'emergency never exposes a co-op pause button');

  store.patch('match', { public: { ...pub, emergencyFrozen: true, emergencyFrozenAt: since } });
  store.set({ emergency: null });
  assert.equal(emergencyActive(), true, 'public state keeps clocks frozen while resume is still in transit');
  assert.equal(matchClockNow(since + 120000), since);
  assert.equal(secondsLeft(pub.deadline), 30);
  store.patch('match', { public: { ...pub, deadline: since + 150000 } });
  assert.equal(emergencyActive(), false);
  assert.equal(matchClockNow(since + 120000), since + 120000);
});

test('emergency clock uses the earliest valid freeze instant and leaves network time live', (t) => {
  t.after(() => store.reset());
  const s = { emergency: { active: true, since: 20000 }, match: { public: { emergencyFrozen: true, emergencyFrozenAt: 19000 } } };
  assert.equal(emergencyClockAt(s), 19000);
  assert.equal(matchClockNow(30000, s), 19000);
  assert.equal(matchClockNow(18000, s), 18000, 'clock corrections never move a displayed time forwards');
  assert.equal(emergencyClockAt({ emergency: { active: false, since: 1000 } }), null);
  assert.equal(emergencyClockAt({ emergency: { active: true, since: NaN } }), null);
  const before = serverNow();
  store.set({ emergency: { active: true, since: 1000 } });
  assert.ok(serverNow() >= before, 'network clock is not the frozen match clock');
});
