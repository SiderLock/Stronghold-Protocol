import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { C2S, S2C } from '../shared/protocol.js';
import { PHASE } from '../shared/constants.js';
import { WIRE_VERSION, WIRE_MESSAGES, WIRE_RECORDS, WIRE_ENUMS } from '../shared/wireSchema.js';
import { encodeWire, decodeWire, wireCatalog, WireCodecError } from '../shared/wireCodec.js';
import { makeMatch, DATA } from './match/harness.js';
import { normalizeSnapshot, SnapshotBuffer } from '../public/js/render/interp.js';

const clone = (v) => JSON.parse(JSON.stringify(v));
const roundTrip = (v, direction = null) => decodeWire(clone(encodeWire(clone(v), direction)), direction);
const nameOf = (f) => typeof f === 'string' ? f : f[0];
// Fields introduced after v1 was published use its existing extension slot. Keep this allowlist
// explicit: adding a business field must not silently weaken coverage or renumber the fixed catalog.
const V1_EXTENSIONS = Object.freeze({
  'room.create': ['assetCache', 'test'], 'room.join': ['assetCache', 'testAck'],
  'lobby.quickMatch': ['assetCache'], 'room.spectate': ['assetCache', 'testAck'],
  'b.result': ['cs'], // 0.3.0 content identity (DESIGN §8.4)
});
// Published v1 has no new numeric IDs: these post-v1 business types deliberately use its JSON fallback.
const V1_JSON_FALLBACK = Object.freeze({
  c2s: ['room.chat', 'room.setMatchmaking', 'lobby.join', 'lobby.spectate', 'b.rehearsalResult',
    'room.consent', 'room.contentReady', 'room.setMode', 'room.setPlugins', 'room.requestSeat', 'room.answerSeat',
    // 0.3.1 business types (skins / unequip rule / plugin offers / test console) — post-v1, JSON fallback
    'room.skins', 'g.unequip', 'g.offer', 'g.offerRefresh', 'g.test'],
  s2c: ['m.chat', 'm.chatState', 'm.emergency', 'm.layer', 'b.rehearsal', 'b.rehearsalCancel'],
});

test('v1 complete catalog fingerprint prevents accidental published field or enum renumbering', () => {
  const canonical = (v) => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object'
    ? Object.fromEntries(Object.keys(v).sort().map((key) => [key, canonical(v[key])])) : v;
  const fingerprint = createHash('sha256').update(JSON.stringify(canonical(wireCatalog()))).digest('hex');
  assert.equal(WIRE_VERSION, 1);
  assert.equal(fingerprint, 'ea41ddd24cfb8234de364c3890560797892705390ac4ac5cf0c5206b320f71de',
    'the v1 contract is fixed: introduce a new version and preserve v1 decoding instead of editing this fingerprint');
});

test('wire ids cover every business message and C2S field or declared v1 extension; registries are immutable', () => {
  const messages = wireCatalog().messages;
  assert.deepEqual([...messages.filter((m) => m.direction === 's2c').map((m) => m.type), ...V1_JSON_FALLBACK.s2c].sort(), [...S2C].sort());
  assert.deepEqual([...messages.filter((m) => m.direction === 'c2s').map((m) => m.type), ...V1_JSON_FALLBACK.c2s].sort(), Object.keys(C2S).sort());
  for (const [direction, types] of Object.entries(V1_JSON_FALLBACK)) {
    for (const type of types) {
      assert.equal(messages.some((m) => m.type === type), false);
      const frame = { t: type, matchId: 'chat_scope', text: '中文😀', seq: 2, messages: [] };
      assert.deepEqual(encodeWire(frame, direction), frame);
      assert.deepEqual(roundTrip(frame, direction), frame);
    }
  }
  assert.equal(new Set(messages.map((m) => m.id)).size, messages.length);
  for (const m of messages.filter((m) => m.direction === 'c2s')) {
    for (const key of Object.keys(C2S[m.type]).filter((key) => key !== '$optional')) {
      assert.ok(m.fields.map(nameOf).includes(key) || V1_EXTENSIONS[m.type]?.includes(key),
        `${m.type}.${key} needs a stable position or an explicit v1 extension contract`);
    }
  }
  for (const [type, fields] of Object.entries(V1_EXTENSIONS)) {
    const message = messages.find((entry) => entry.type === type);
    for (const field of fields) {
      assert.ok(Object.hasOwn(C2S[type], field));
      assert.ok(C2S[type].$optional.includes(field));
      assert.equal(message.fields.map(nameOf).includes(field), false, 'published v1 positions must not be extended in place');
    }
  }
  assert.deepEqual(WIRE_ENUMS.phase, Object.values(PHASE));
  assert.ok(Object.isFrozen(WIRE_MESSAGES) && Object.isFrozen(WIRE_RECORDS.bond) && Object.isFrozen(WIRE_MESSAGES[8][3]));
  assert.throws(() => WIRE_RECORDS.bond.push('changed'), TypeError);
});

test('published example has stable positions; null, false, zero and absence remain distinct', () => {
  assert.deepEqual(encodeWire({ t: 'm.public', phase: 'COMBAT', round: 11 }), [1, 8, '6', 7, 11]);
  for (const bossHp of [null, { hp: 0, max: 1 }]) {
    const message = { t: 'm.public', phase: 'PREP', paused: false, players: [], fields: [], bossHp };
    assert.deepEqual(roundTrip(message), message);
  }
  const absent = { t: 'm.public', phase: 'PREP' };
  assert.ok(!Object.hasOwn(roundTrip(absent), 'bossHp'));
  assert.deepEqual(roundTrip({ t: 'g.bandFocus', rid: 0, bandId: null, groupId: 1 }),
    { t: 'g.bandFocus', rid: 0, bandId: null, groupId: 1 });
});

test('unknown types, enum spellings, raw arrays and extension fields survive without interpretation', () => {
  const unknown = { t: 'future.message', values: [1, 8, '6', 7, 11] };
  assert.deepEqual(encodeWire(unknown), unknown);
  for (const phase of ['FUTURE_PHASE', 7, false, [7, 8], { value: 'COMBAT' }]) {
    const message = { t: 'm.public', phase, players: [{ playerId: '新玩家😀', bonds: [], future: { t: 'x', v: [1, 8, '0'] } }],
      future: [[1, 8, '6', 7, 11], { t: 'nested', text: '中文' }], values: null };
    assert.deepEqual(roundTrip(message), message);
  }
  const nestedT = { t: 'm.public', bossHp: { hp: 1, max: 2, t: 'future' } };
  assert.deepEqual(roundTrip(nestedT), nestedT);
});

test('lobby access metadata uses v1 extensions and preserves hidden room codes', () => {
  const roomId = '93b479b7-ff62-4f3b-a06a-5f0ac230dc9e';
  const state = {
    t: 'lobby.state', online: 5, roomCount: 1, matchCount: 1, playingCount: 3, joinableCount: 0,
    rooms: [{ roomId, code: null, mode: 'coop', difficulty: 'NORMAL', capacity: 20,
      playerCount: 20, humanCount: 3, botCount: 17, inMatch: true, joinable: false,
      allowMatchmaking: false, spectatorCount: 1, spectatable: true,
      hostOnline: true, disconnectedRetained: false, createdAt: 100 }],
  };
  assert.deepEqual(roundTrip(state, 's2c'), state);
  assert.deepEqual(roundTrip({ t: 'room.state', code: 'ABCD', allowMatchmaking: false }, 's2c'),
    { t: 'room.state', code: 'ABCD', allowMatchmaking: false });
  for (const message of [
    { t: 'room.setMatchmaking', allowed: false },
    { t: 'lobby.join', roomId, assetCache: { schema: 1, version: 'a'.repeat(64), readyFiles: 1, readyBytes: 7 } },
    { t: 'lobby.spectate', roomId },
  ]) {
    assert.deepEqual(encodeWire(message, 'c2s'), message, 'new types deliberately retain JSON fallback');
    assert.deepEqual(roundTrip(message, 'c2s'), message);
  }
});

test('map keys and extensions cannot mutate prototypes', () => {
  const message = JSON.parse('{"t":"room.loadout","entries":{"__proto__":{"skill":1,"module":"none"},"constructor":{"skill":0}},"__proto__":{"polluted":true}}');
  const restored = roundTrip(message);
  assert.deepEqual(restored, message);
  assert.equal(Object.getPrototypeOf(restored), Object.prototype);
  assert.equal(Object.getPrototypeOf(restored.entries), Object.prototype);
  assert.equal({}.polluted, undefined);
});

test('malformed compact frames reject versions, directions, masks, missing/extra values and collisions', () => {
  for (const frame of [[], [99, 8, '0'], [1, 999, '0'], [1, 8, ''], [1, 8, '00'], [1, 8, '-1'],
    [1, 8, 'f'.repeat(32)], [1, 8, '1'], [1, 8, '0', 1], [1, 8, '2', 99],
    [1, 8, '200000000', { phase: 'PREP' }], [1, 8, '200000000', { t: 'm.private' }]]) {
    assert.throws(() => decodeWire(frame), WireCodecError, JSON.stringify(frame));
  }
  assert.throws(() => decodeWire(encodeWire({ t: 'g.refresh' }), 's2c'), /direction/);
  assert.throws(() => encodeWire({ t: 'm.public' }, 'c2s'), /direction/);
  assert.throws(() => encodeWire({ t: 'm.public', players: {} }), /list/);
  assert.throws(() => decodeWire([WIRE_VERSION, 8, '1000000', [['not-hex']]]), WireCodecError);
});

// Generate valid structural values, including optional field subsets. Fixed seed makes failures reproducible.
let state = 0x26a10010;
function random() { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 2 ** 32; }
function raw() {
  const values = [null, false, true, 0, 123.25, '', '中文😀', [], [1, null, [2, 3]], { future: 'v', t: 'raw' }];
  return clone(values[Math.floor(random() * values.length)]);
}
function valueFor(type, depth = 0) {
  if (!type) return raw();
  if (random() < 0.2) return null;
  if (Array.isArray(type)) {
    if (type[0] === 'enum') return random() < 0.8 ? WIRE_ENUMS[type[1]][Math.floor(random() * WIRE_ENUMS[type[1]].length)] : raw();
    if (type[0] === 'list') return [valueFor(type[1], depth + 1), valueFor(type[1], depth + 1)];
    return { '玩家_A': valueFor(type[1], depth + 1), '玩家_B': valueFor(type[1], depth + 1) };
  }
  return recordFor(WIRE_RECORDS[type], depth + 1);
}
function recordFor(fields, depth = 0) {
  assert.ok(depth < 12, 'schema graph must remain bounded');
  const out = {};
  for (const field of fields) if (random() < 0.65) out[nameOf(field)] = valueFor(typeof field === 'string' ? null : field[1], depth);
  if (random() < 0.2) out.futureExtension = raw();
  return out;
}

test('all schemas round-trip 2840 deterministic combinations of optional fields and nested values', () => {
  state = 0x26a10010;
  const frames = createHash('sha256');
  for (const [, type, direction, fields] of WIRE_MESSAGES) {
    for (let i = 0; i < 40; i++) {
      const message = { t: type, rid: i, ...recordFor(fields) };
      frames.update(JSON.stringify(encodeWire(clone(message), direction)) + '\n');
      assert.deepEqual(roundTrip(message, direction), message, `${type} combination ${i}`);
    }
  }
  assert.equal(frames.digest('hex'), '7e229a466db11fcea828c82a9626212c0b324a28ccacb37f5f87da82af689272',
    'preserve the published v1 bytes as well as round trips; do not regenerate this corpus hash to change the encoding');
});

function noPublicExtensions(message) {
  function record(v, fields, path) {
    if (v == null) return;
    const known = new Set(fields.map(nameOf));
    for (const k of Object.keys(v)) assert.ok(k === 't' || known.has(k)
      || (fields === WIRE_RECORDS.card && k === 'soldOut')
      || (path === 'm.public' && ['emergencyFrozen', 'emergencyFrozenAt', 'emergencyReason', 'bossPairs'].includes(k)),
      `${path}.${k} needs an explicit position or declared v1 extension`);
    for (const field of fields) if (typeof field !== 'string' && Object.hasOwn(v, field[0])) {
      const [key, type] = field;
      if (typeof type === 'string') record(v[key], WIRE_RECORDS[type], `${path}.${key}`);
      else if (type[0] === 'list') for (const item of v[key] || []) if (typeof type[1] === 'string') record(item, WIRE_RECORDS[type[1]], `${path}.${key}[]`);
    }
  }
  record(message, WIRE_MESSAGES.find((m) => m[1] === 'm.public')[3], 'm.public');
}

test('v0.2.4 stock, prep medics and zero coins retain v1 extension semantics', () => {
  const publicMessage = { t: 'm.public', sp: {
    cards: [{ idx: 0, kind: 'item', id: 'item-a', soldOut: true }],
    groups: [{ id: 0, cards: [{ idx: 1, kind: 'item', id: 'item-b', soldOut: false }] }],
  } };
  noPublicExtensions(publicMessage);
  assert.deepEqual(roundTrip(publicMessage, 's2c'), publicMessage);
  const privateMessage = { t: 'm.private', bossMate: { playerId: 'p20', side: 1, units: [] },
    prepMapChars: Array.from({ length: 20 }, (_, i) => ({ uid: -i - 1, defId: 'reserve-medic', x: i % 10, y: 0 })) };
  assert.deepEqual(roundTrip(privateMessage, 's2c'), privateMessage);
  const snap = { t: 0, units: [[1, 0, 0, 100, 100, 0, 0, 0, 0]], coins: [[1, 0, 10]] };
  const frame = { ...snap, t: 'b.snap', gt: snap.t, fieldId: 'f20' };
  const restored = roundTrip(frame, 's2c');
  assert.deepEqual(restored, frame);
  assert.deepEqual([...normalizeSnapshot(restored).coins], [[1, [0, 10]]]);
  const buffer = new SnapshotBuffer({ delay: 0 });
  buffer.push(restored);
  assert.deepEqual(buffer.sample(0).get(1).coins, [0, 10]);
  buffer.push(roundTrip({ t: 'b.snap', fieldId: 'f20', gt: 1, units: snap.units }, 's2c'));
  assert.equal(buffer.sample(1).get(1).coins, null);
});

test('real match public/private views for 1–20 seats restore exactly, including parallel drafts', () => {
  for (let count = 1; count <= 20; count++) {
    const h = makeMatch({ humans: count, difficulty: 'HARD', fake: true, seed: 123 }).start();
    try {
      const check = () => {
        const view = clone(h.m.publicView());
        noPublicExtensions(view);
        assert.deepEqual(roundTrip(view, 's2c'), view);
        for (const ps of h.m.order) assert.deepEqual(roundTrip(ps.privateView(), 's2c'), clone(ps.privateView()));
      };
      check();
      for (const ps of h.m.order) h.m.handle(ps.playerId, { t: 'g.infoReady' });
      h.sched.advance(1);
      check();
      if ([1, 4, 8, 20].includes(count)) { h.toPrep(1); check(); }
      assert.equal(h.m.errorCount, 0);
    } finally { h.m.dispose(); }
  }
});

// Exercise current Match-produced optional fields, rather than only generated schema examples or old captures.
// Boss fixtures start from R1 preparation and jump directly to the target phase; they never play all 14 rounds.
function checkMatchWire(h) {
  const seen = new Set(); const phases = new Set(); let count = 0;
  const check = (msg) => {
    const original = clone(msg);
    assert.deepEqual(roundTrip(original, 's2c'), original, original.t);
    if (original.t === 'm.public') { noPublicExtensions(original); phases.add(original.phase); }
    seen.add(original.t); count++;
  };
  h.onSend.push((_playerId, msg) => check(msg)); h.onBroadcast.push(check);
  const handle = h.m.handle.bind(h.m);
  h.m.handle = (playerId, msg) => handle(playerId, roundTrip(clone(msg), 'c2s'));
  return { seen, phases, count: () => count };
}

test('all four current twenty-seat event families restore every parallel page and personal reward', () => {
  const modeId = 'mode_multi_abyss'; const schedule = DATA.choices.schedule[modeId];
  for (const family of ['bounty', 'supply', 'shop', 'tactic']) {
    const data = { ...DATA, choices: { ...DATA.choices, schedule: { ...DATA.choices.schedule,
      [modeId]: { ...schedule, rounds: { ...schedule.rounds, 11: { ...schedule.rounds[11], families: [{ family, weight: 1 }] } } },
    } } };
    const h = makeMatch({ humans: 20, difficulty: 'ABYSS', data, fake: true, seed: 84 });
    const wire = checkMatchWire(h);
    try {
      h.start(); h.toPrep(1); h.m.round = 11; h.m.enterSpDraft(); h.m.flush(true);
      assert.equal(h.m.publicView().sp.family, family);
      assert.equal(h.m.sp.groups.length, 5);
      for (const group of h.m.sp.groups) {
        assert.equal(group.cards.length, 6);
        while (!group.done) {
          const playerId = group.order[group.idx]; const idx = group.cards.find((card) => group.taken[card.idx] == null).idx;
          assert.deepEqual(h.m.handle(playerId, { t: 'g.choice', idx, draftId: h.m.sp.id, groupId: group.id }), { ok: true });
          h.m.flush(true);
        }
      }
      h.sched.advance(1); h.m.flush(true);
      assert.equal(h.m.phase, PHASE.PREP);
      assert.ok(wire.phases.has(PHASE.SP_DRAFT) && wire.seen.has('m.private'));
      assert.equal(h.m.errorCount, 0, JSON.stringify(h.logs.error)); h.invariants();
    } finally { h.m.dispose(); }
  }
});

test('current twenty-seat client reports and all five Unite rounds retain their complete JSON meaning', () => {
  const waves = new Map();
  const h = makeMatch({ humans: 20, fake: true, clientCombat: true, seed: 8620,
    script: (battle) => {
      if (battle.kind === 'normal') return { leaks: { p_0: 6 } };
      if (battle.kind !== 'unite') return {};
      if (!waves.has(battle.opts.seed)) waves.set(battle.opts.seed, waves.size + 1);
      return { survivors: { p_0: 6 - waves.get(battle.opts.seed) } };
    },
  });
  const wire = checkMatchWire(h);
  try {
    h.start(); h.toPrep(1);
    const spawn = h.m.wave.spawns.find((s) => s.countInTotal !== false);
    h.m.wave = { ...h.m.wave, spawns: [{ ...spawn, time: 0, count: 6, interval: 0 }] };
    for (let wave = 1; wave <= 5; wave++) {
      assert.ok(h.drive(() => h.m.phase === PHASE.UNITE && h.m.unitePlan.round === wave));
      const publicView = h.m.publicView(); noPublicExtensions(publicView);
      assert.deepEqual(roundTrip(clone(publicView), 's2c'), clone(publicView));
      assert.equal(publicView.unite.roundsMax, 5);
      if (wave < 5) {
        assert.ok(publicView.unite.skipVote.id && publicView.unite.skipVote.needed > 0);
        assert.equal(h.m.handle('p_11', { t: 'g.uniteSkipVote', voteId: publicView.unite.skipVote.id }).ok, true);
      } else assert.equal(publicView.unite.skipVote, null, 'last wave has no later wave to skip');
      h.m.onReconnect('p_0');
    }
    assert.ok(h.drive(() => h.m.phase === PHASE.SETTLE));
    h.m.flush(true);
    assert.deepEqual([...wire.phases].filter((p) => ['COMBAT', 'UNITE', 'SETTLE'].includes(p)).sort(), ['COMBAT', 'SETTLE', 'UNITE']);
    assert.ok(wire.seen.has('b.start') && wire.seen.has('m.private') && wire.count() > 100);
    assert.equal(h.m.verifyStats.rejected, 0); assert.equal(h.m.errorCount, 0, JSON.stringify(h.logs.error));
    h.invariants();
  } finally { h.m.dispose(); }
});

test('current twenty-seat leader/hidden-core, departure, resync and result fixtures restore exactly', () => {
  for (const hidden of [false, true]) {
    const h = makeMatch({ humans: 20, fake: true, clientCombat: true, instant: false, script: () => ({ bossDps: 0 }) });
    const wire = checkMatchWire(h);
    try {
      h.start(); h.toPrep(1);
      h.m.round = hidden ? 15 : 14; h.m.bossId = 'boss_1'; h.m.hiddenBossId = 'boss_9'; h.m.teamLp = 200;
      h.m._planBossWaves(); h.m.startFinalAssault(hidden);
      h.m.flush(true);
      const originalMax = h.m.bossPool.maxHp;
      h.m.onLeave('p_19'); h.sched.advance(500); h.m.flush(true); h.m.onReconnect('p_0');
      assert.equal(h.m.publicView().bossHp.max, originalMax / 20 * 19);
      h.m.hiddenLayerSum = 0;
      h.m.bossPool.damage('p_0', h.m.bossPool.maxHp); h.m._checkFinalEnd();
      assert.ok(h.run(() => h.ended != null), 'target phase finishes without an opening-to-R14 playthrough');
      assert.ok(wire.phases.has(hidden ? PHASE.HIDDEN_CORE : PHASE.FINAL_ASSAULT));
      for (const type of ['m.public', 'm.private', 'b.start', 'b.pool', 'b.end', 'm.result']) assert.ok(wire.seen.has(type), type);
      assert.equal(h.m.errorCount, 0, JSON.stringify(h.logs.error));
    } finally { h.m.dispose(); }
  }
});

test('UTF-8 JSONL inspection CLI restores the documented original JSON', () => {
  const original = { t: 'm.public', phase: 'COMBAT', players: [{ playerId: '龙千尘', bonds: [] }] };
  const encoded = spawnSync(process.execPath, ['tools/wire.mjs', 'encode'], { input: `${JSON.stringify(original)}\n`, encoding: 'utf8' });
  assert.equal(encoded.status, 0, encoded.stderr);
  const decoded = spawnSync(process.execPath, ['tools/wire.mjs', 'decode'], { input: encoded.stdout, encoding: 'utf8' });
  assert.equal(decoded.status, 0, decoded.stderr);
  assert.deepEqual(JSON.parse(decoded.stdout), original);
  const catalog = spawnSync(process.execPath, ['tools/wire.mjs', 'schema'], { encoding: 'utf8' });
  assert.deepEqual(JSON.parse(catalog.stdout), clone(wireCatalog()));
});

test('CLI reads UTF-8 files directly and exits cleanly on a missing file or invalid arguments', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'sp-wire-inspect-'));
  // This directory was created here, is inside the OS temp directory, and is the only deletion target.
  try {
    const message = { t: 'm.emote', playerId: '中文玩家😀', id: 'hello', ts: 0 };
    const file = path.join(dir, '中文.jsonl'); writeFileSync(file, '\uFEFF' + JSON.stringify(encodeWire(message)) + '\n', 'utf8');
    const result = spawnSync(process.execPath, ['tools/wire.mjs', 'decode', file], { encoding: 'utf8', timeout: 10000, windowsHide: true });
    assert.equal(result.status, 0, result.stderr); assert.deepEqual(JSON.parse(result.stdout), message);
    for (const args of [['decode', path.join(dir, 'absent')], ['schema', 'unexpected']]) {
      const failed = spawnSync(process.execPath, ['tools/wire.mjs', ...args], { encoding: 'utf8', timeout: 10000, windowsHide: true });
      assert.equal(failed.status, 1, failed.stderr); assert.ok(failed.stderr);
    }
  } finally {
    assert.equal(path.dirname(dir), path.resolve(os.tmpdir())); rmSync(dir, { recursive: true, force: true });
  }
});
