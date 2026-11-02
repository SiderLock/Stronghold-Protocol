// The capacity branch keeps D004 manual-human priority as a fixed co-op rule; the upstream room switch becomes
// a read-only indicator for every viewer. An older / off room.state flag must not advertise a toggleable rule.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SRC = readFileSync(path.join(ROOT, 'public/js/screens/room.js'), 'utf8');
const EN = JSON.parse(readFileSync(path.join(ROOT, 'public/i18n/en.json'), 'utf8'));
const mod = () => import(pathToFileURL(path.join(ROOT, 'public/js/screens/room.js')).href);

const room = (o = {}) => ({
  code: 'ABCD', hostId: 'h', mode: 'coop', difficulty: 'NORMAL', aiPicksLast: false,
  seats: [{ seat: 0, playerId: 'h', name: 'Host', isBot: false, ready: false, connected: true }, { seat: 1, playerId: 'g', name: 'G', isBot: false, ready: false, connected: true }, null, null],
  ...o,
});

test('aiLastOption: hidden in solo, fixed on and read-only for the host and other viewers', async () => {
  const { aiLastOption } = await mod();
  assert.equal(aiLastOption(room({ mode: 'solo' }), 'h'), null, 'solo: no AI teammates');
  assert.deepEqual(aiLastOption(room(), 'h'), { on: true, editable: false });
  assert.deepEqual(aiLastOption(room({ aiPicksLast: true }), 'h'), { on: true, editable: false });
  assert.deepEqual(aiLastOption(room({ aiPicksLast: true }), 'g'), { on: true, editable: false });
  assert.deepEqual(aiLastOption(room({ aiPicksLast: undefined }), 'g'), { on: true, editable: false }, 'an older server');
  assert.equal(aiLastOption(null, 'h'), null);
});

test('room.js sends no priority toggle and explains the fixed manual-human priority through t()', () => {
  assert.doesNotMatch(SRC, /net\.request\('room\.setAiPicksLast'/);
  for (const zh of ['AI 队友最后选择', '本分支固定由在线且未托管的博士先选，AI、托管和掉线席位随后选择', '固定规则']) {
    assert.ok(SRC.includes(`t('${zh}')`), zh);
    assert.equal(typeof EN[zh], 'string', `en.json: ${zh}`);
    assert.ok(EN[zh].length > 0 && !/[一-鿿]/.test(EN[zh]), `English for ${zh}`);
  }
});
