import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('offline benchmark verifies semantic restoration and takeover while keeping connection dictionaries separate', () => {
  const players = Array.from({ length: 20 }, (_, seat) => ({ playerId: `p_${seat}`, seat, name: '测量玩家', lp: 30,
    bonds: Array.from({ length: 18 }, (_, n) => ({ bondId: `bond_${n}`, count: n, active: n > 3, tier: n % 3, layers: n })) }));
  const lines = [];
  for (let i = 0; i < 12; i++) for (const connection of [1, 2]) {
    lines.push({ connection, start: i / 5, end: i / 5 + 0.001, message: { t: 'm.public', players, phase: 'COMBAT', round: 11,
      fields: [{ fieldId: 'n:p_0', progress: { killed: i, resolved: i, total: 100, done: false } }] } });
    lines.push({ connection, message: { t: 'pong', c: i, s: i, rid: i } });
  }
  const command = spawnSync(process.execPath, ['tools/wire-bench.mjs', '-', '--duration', '3'], {
    input: '\uFEFF' + lines.map((line) => JSON.stringify(line)).join('\n'), encoding: 'utf8', timeout: 10000, windowsHide: true,
  });
  assert.equal(command.status, 0, command.stderr);
  const report = JSON.parse(command.stdout);
  assert.equal(report.verifiedMessages, 48); assert.equal(report.connections, 2);
  assert.equal(report.mainRoom.playerCount, 20); assert.equal(report.mainRoom.humanCount, 20);
  assert.equal(report.mainRoom.public.messages, 24); assert.equal(report.mainRoom.phases.length, 1);
  assert.ok(report.total.modes.positions_deflate_context.wireBytes < report.total.modes.json_deflate_frame.wireBytes);
  assert.ok(report.total.modes.positions.wireBytes < report.total.modes.json.wireBytes);
});

test('one transition frame reports bytes without inferring a sustained bandwidth spike', () => {
  const command = spawnSync(process.execPath, ['tools/wire-bench.mjs', '-', '--duration', '2'], {
    input: JSON.stringify({ connection: 1, start: 1, end: 1.00001, message: { t: 'm.public', phase: 'ROUND_START', round: 12, players: [] } }),
    encoding: 'utf8', timeout: 10000, windowsHide: true,
  });
  assert.equal(command.status, 0, command.stderr);
  const phase = JSON.parse(command.stdout).mainRoom.phases[0];
  assert.ok(phase.modes.json.wireBytes > 0);
  assert.equal(phase.modes.json.averageMbps, null);
});

test('benchmark refuses malformed input or unbounded context growth without echoing private payloads', () => {
  for (const input of ['not JSON', '{"message":{"secret":"never echo this value"}}',
    '{"connection":1,"message":{"t":"pong"}}\n{"connection":2,"message":{"t":"pong"}}']) {
    const command = spawnSync(process.execPath, ['tools/wire-bench.mjs', '-', '--max-contexts', '1'], { input, encoding: 'utf8', timeout: 10000, windowsHide: true });
    assert.equal(command.status, 1); assert.doesNotMatch(command.stderr, /never echo this value/);
  }
});
