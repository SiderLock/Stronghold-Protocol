// Cosmetic randomness must remain independent of gameplay and be shared by AI seats, once per new match.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Lobby } from '../server/lobby.js';
import { SessionRegistry } from '../server/net.js';
import { SKIN_RANDOM_LIMITS, isSkinPool, validateC2S } from '../shared/protocol.js';
import { encodeWire, decodeWire } from '../shared/wireCodec.js';
import { skinPoolFromManifest, randomSkinSelection } from '../shared/skins.js';
import { createRng, deriveSeed } from '../server/sim/rng.js';
import { makeMatch } from './match/harness.js';

const CHAR = 'char_498_inside', OTHER = 'char_003_kalts';
const A = `${CHAR}@a#1`, B = `${CHAR}@b#2`, C = `${OTHER}@c#3`;
const pool = { [CHAR]: [A, B], [OTHER]: [C] };
const manifest = { chars: {
  [CHAR]: { skins: { [B]: { spine: { front: { skel: '/skin.skel' } } }, [A]: { avatar: '/a.png' }, meta: { name: 'metadata only' } } },
  [OTHER]: { skins: { [C]: { portrait: '/c.png' } } },
  char_999_unknown: { skins: { ignored: { avatar: '/unknown.png' } } },
} };

function fixture(t) {
  const registry = new SessionRegistry();
  class RecordingMatch {
    constructor(opts) { this.opts = opts; this.updates = []; }
    start() {}
    dispose() {}
    setSkins(id, skins) { this.updates.push({ id, skins }); return { ok: true }; }
  }
  let seeds = 0;
  const data = { chess: { a: { charId: CHAR }, b: { charId: OTHER } }, assets: manifest };
  const lobby = new Lobby({ registry, MatchClass: RecordingMatch, getData: () => data, seedFn: () => { seeds++; return 17; } });
  t.after(() => lobby.shutdown());
  const host = registry.create('Host');
  host.connected = true;
  host.ws = { readyState: 1, bufferedAmount: 0, send() {} };
  assert.deepEqual(lobby.create(host, { mode: 'coop', difficulty: 'NORMAL', capacity: 20 }), { ok: true });
  const room = lobby.getRoom(host.roomCode);
  for (let i = 0; i < 19; i++) assert.deepEqual(lobby.addBot(host), { ok: true });
  const start = () => {
    assert.deepEqual(lobby.startMatch(room), { ok: true });
    return room.match;
  };
  const finish = () => lobby.onMatchEnd(room, room.matchCtx, {});
  return { lobby, host, room, start, finish, seeds: () => seeds };
}

test('random pool uses wearable non-default rows of current operators, with a bounded JSON payload', () => {
  assert.deepEqual(skinPoolFromManifest(manifest, new Set([CHAR, OTHER])), pool);
  assert.deepEqual(randomSkinSelection(pool, n => n - 1), { [CHAR]: B, [OTHER]: C });
  assert.deepEqual(skinPoolFromManifest({}), {});
  const huge = { chars: Object.fromEntries(Array.from({ length: 300 }, (_, n) => [`char_${n}_x`, { skins:
    Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`char_${n}_x@outfit#${i}`, { avatar: '/a.png' }])) }])) };
  const bounded = skinPoolFromManifest(huge);
  assert.ok(isSkinPool(bounded));
  assert.ok(Object.values(bounded).every(rows => rows.length <= SKIN_RANDOM_LIMITS.perOperator));
  assert.ok(JSON.stringify(bounded).length <= SKIN_RANDOM_LIMITS.bytes);
});

test('random plans round-trip on the published compact wire without changing its schema; junk is refused', () => {
  const msg = { t: 'room.skins', skins: {}, randomMode: 'match', skinPool: pool };
  assert.equal(validateC2S(msg), null);
  assert.deepEqual(decodeWire(encodeWire(msg, 'c2s'), 'c2s'), msg);
  for (const bad of [null, [], { [CHAR]: [] }, { chess_char_1_01_a: [A] }, { [CHAR]: ['bad id'] },
    { [CHAR]: Array(33).fill(A) }, Object.fromEntries(Array.from({ length: 33 }, (_, n) => [`char_${n}_x`, Array(32).fill(A)]))]) {
    assert.equal(isSkinPool(bad), false);
    assert.ok(validateC2S({ ...msg, skinPool: bad }));
  }
});

test('all 19 AI seats share the opening roll; fixed human choices and the gameplay seed are preserved', t => {
  const h = fixture(t);
  assert.deepEqual(h.lobby.skins(h.host, { skins: { [CHAR]: B } }), { ok: true });
  const m = h.start(), bots = m.opts.seats.filter(s => s.isBot);
  assert.equal(bots.length, 19);
  assert.deepEqual(bots[0].skins, randomSkinSelection(pool, createRng(deriveSeed(17, `skins:${h.room.code}:1:ai`)).int));
  for (const bot of bots) assert.strictEqual(bot.skins, bots[0].skins, 'same configuration across every group');
  assert.deepEqual(m.opts.seats.find(s => !s.isBot).skins, { [CHAR]: B });
  assert.equal(m.opts.seed, 17);
  assert.equal(h.seeds(), 1, 'cosmetics never ask the gameplay seed source for another draw');
  h.finish();
  const next = h.start();
  assert.deepEqual(next.opts.seats.find(s => !s.isBot).skins, { [CHAR]: B }, 'fixed choices survive another match');
  assert.deepEqual(next.opts.seats.find(s => s.isBot).skins,
    randomSkinSelection(pool, createRng(deriveSeed(17, `skins:${h.room.code}:2:ai`)).int));
  assert.equal(h.seeds(), 2);
});

test('per-match human plan rolls at start, ignores live/reconnect resends, then rolls at the next start', t => {
  const h = fixture(t), plan = { skins: { [CHAR]: 'stale' }, randomMode: 'match', skinPool: pool };
  assert.deepEqual(h.lobby.skins(h.host, plan), { ok: true });
  const saved = h.host.skinRandomPool;
  assert.ok(Object.isFrozen(saved) && Object.isFrozen(saved[CHAR]));
  for (const bad of [{ ...plan, randomMode: 'other' }, { skins: {}, randomMode: 'match' }, { skins: {}, skinPool: pool }]) {
    assert.equal(h.lobby.skins(h.host, bad).error, 'BAD_MSG');
    assert.strictEqual(h.host.skinRandomPool, saved, 'refusal is atomic');
  }
  const m = h.start(), own = () => m.opts.seats.find(s => !s.isBot).skins;
  const expected = randomSkinSelection(pool, createRng(deriveSeed(17, `skins:${h.room.code}:1:${h.host.playerId}`)).int);
  assert.deepEqual(own(), expected);
  assert.deepEqual(h.lobby.skins(h.host, plan), { ok: true });
  assert.deepEqual(m.updates, [], 'a cached preference resend must not overwrite the server opening roll');
  assert.deepEqual(own(), expected);
  h.finish();
  const next = h.start();
  assert.deepEqual(next.opts.seats.find(s => !s.isBot).skins,
    randomSkinSelection(pool, createRng(deriveSeed(17, `skins:${h.room.code}:2:${h.host.playerId}`)).int));
  assert.deepEqual(h.lobby.skins(h.host, { skins: expected }), { ok: true });
  assert.equal(h.host.skinRandomPool, null, 'freezing/manual editing cancels future rolls');
  assert.deepEqual(next.updates.at(-1).skins, expected, 'fixed edits still apply live');
});

test('giving a bot an outfit preserves setup, shop and wave RNG states', () => {
  const seat = { seat: 0, playerId: 'ai_0', name: 'AI', isBot: true, connected: true };
  const base = makeMatch({ mode: 'solo', seats: [seat], seed: 17 });
  const dressed = makeMatch({ mode: 'solo', seats: [{ ...seat, skins: { [CHAR]: A } }], seed: 17 });
  for (const key of ['rngSetup', 'rngShop', 'rngWaves']) assert.equal(dressed.m[key].state(), base.m[key].state(), key);
  assert.deepEqual(dressed.ps('ai_0').skins, { [CHAR]: A });
});
