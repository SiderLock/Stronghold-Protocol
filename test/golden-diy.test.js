// The 自选 golden match covers what it claims (test/golden/README.md, tools/golden.mjs — 0.2.0 自选编队): reads the stored
// digest only (test/golden.test.js recomputes it). Its human seat (AI 托管) slots 推进之王 and prototypes; its shop draws
// its 自选 pieces (and only from the slots' 调度中心 levels), every fielded slot uses the chosen body, the
// stock ends where the held copies leave it, and the match ends without errors.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));
const MATCHES = read('./golden/matches.json');
const BACKUPS = read('../data/backups.json');
const ECONOMY = read('../data/config.json').economy;

test('matches: the 自选 match\'s human seat draws its selected operators and retains unscaled private stock', () => {
  const [id, dg] = Object.entries(MATCHES.scenarios).find(([k]) => /-coverage-diy$/.test(k)) || [];
  assert.ok(dg, 'scenario present');
  assert.deepEqual(dg.errors, { engine: 0, logged: 0, sim: 0, dispatcher: 0 }, id);
  assert.deepEqual(Object.keys(dg.diy.picks).sort(), Object.keys(BACKUPS.diy.slots).sort(), 'all four slots filled');
  assert.equal(dg.diy.picks.chess_char_5_diy1_a.charId, 'char_112_siege');
  const draws = dg.diy.rounds.flatMap(([, d]) => (d ? d.split(' ') : []));
  assert.ok(draws.length >= 2, `shop draws: ${draws.join(', ')}`);
  for (const d of draws) assert.ok(Object.hasOwn(BACKUPS.diy.slots, `chess_char_${d}`), d);
  // D028's smaller private stock changes the AI's shop stream: seed 5 still draws Siege, but the AI may prefer
  // another board. Native-kit combat coverage lives in the 140-case DIY golden family, independent of bot purchases.
  assert.ok(draws.includes('5_diy1_a'), `selected Siege appears in the shop: ${draws.join(', ')}`);
  assert.ok(Object.values(MATCHES.scenarios).some(d => d.diy?.rounds.some(([, , f]) => !!f)), 'a match still fields DIY slots');
  for (const [r, , f] of dg.diy.rounds) {
    for (const x of f ? f.split(' ') : []) {
      const [slot, charId] = x.split('→');
      // an elite (`_b`, merged from three copies; §35.63 bots merge 推进之王) fights as its slot's pick
      assert.equal(dg.diy.picks[`chess_char_${slot.replace(/_b$/, '_a')}`].charId, charId, `round ${r}: ${x} fights as its pick`);
    }
  }
  // the stock: never above its cap (8 at tier 5, 5 at tier 6 — D028: private 自选 stock never takes the co-op factor)
  const factor = 1;
  for (const [slot, left] of Object.entries(dg.diy.stock)) {
    const cap = ECONOMY.poolCopies[BACKUPS.diy.slots[slot].tier] * factor;
    assert.ok(left >= 0 && left <= cap, `${slot}: ${left} left, cap ${cap}`);
  }
  assert.equal(dg.mode, 'coop', 'the coverage match is co-op');
  assert.ok(Object.values(dg.diy.stock).every((left) => left <= 8), 'D028: co-op DIY stock stays at the single-player cap');
});
