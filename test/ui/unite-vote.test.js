import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PHASE } from '../../shared/constants.js';
import { UniteSkipVote, PhaseCapsule } from '../../public/js/ui/hud.js';
import { Button } from '../../public/js/ui/components.js';

const pub = { phase: PHASE.UNITE, unite: { round: 1, roundsMax: 5,
  skipVote: { id: 'unite:test:1:1', eligible: ['me', 'other'], voters: [], needed: 2, passed: false, open: true } } };
const button = (v) => [v.props.children].flat().find((n) => n?.type === Button);
const text = (v) => typeof v === 'string' || typeof v === 'number' ? String(v)
  : Array.isArray(v) ? v.map(text).join('') : v?.props ? text(v.props.children) : '';

test('eligible human sees vote button and tally; vote callback is wired', () => {
  let called = 0;
  let sent;
  const view = UniteSkipVote({ pub, myId: 'me', onVote: (scope) => { called++; sent = scope; } });
  assert.equal(button(view).props.disabled, false);
  assert.match(text(view), /投票跳过后续全部联防.*0\/2 票.*需 2 票/);
  assert.match(button(view).props.title, /本轮打完就跳过后续全部联防/);
  button(view).props.onClick();
  assert.equal(called, 1);
  assert.deepEqual(sent, { voteId: 'unite:test:1:1' });
});

test('observer, autoplay and offline seats only see the disabled tally', () => {
  for (const myId of ['viewer', 'ai_0', 'offline', 'autoplay']) {
    const view = UniteSkipVote({ pub, myId });
    assert.equal(button(view).props.disabled, true);
    assert.match(text(view), /需 2 票/);
  }
});

test('vote UI distinguishes voted, approved and closed states', () => {
  for (const [patch, label] of [[{ voters: ['me'] }, '已投票跳过后续全部联防'],
    [{ voters: ['me', 'other'], passed: true }, '已通过：跳过后续全部联防'], [{ open: false }, '投票跳过后续全部联防']]) {
    const p = { ...pub, unite: { ...pub.unite, skipVote: { ...pub.unite.skipVote, ...patch } } };
    const view = UniteSkipVote({ pub: p, myId: 'me' });
    assert.equal(button(view).props.disabled, true);
    assert.match(text(view), new RegExp(label));
  }
});

test('vote UI is absent outside unite or on the final wave', () => {
  for (const p of [{ phase: PHASE.UNITE }, { ...pub, phase: PHASE.PREP }, { ...pub, unite: { ...pub.unite, round: 5 } },
    { ...pub, unite: { ...pub.unite, roundsMax: 1 } }, { ...pub, unite: { ...pub.unite, skipVote: null } }]) {
    assert.equal(UniteSkipVote({ pub: p, myId: 'me' }), null);
  }
});

test('middle waves show the full remaining-wave meaning, while legacy vote frames omit identity', () => {
  for (const round of [2, 3, 4]) {
    const middle = { ...pub, unite: { ...pub.unite, round } };
    assert.match(text(UniteSkipVote({ pub: middle, myId: 'me' })), /投票跳过后续全部联防/);
  }
  let scope;
  const legacy = { ...pub, unite: { ...pub.unite, skipVote: { ...pub.unite.skipVote, id: undefined } } };
  button(UniteSkipVote({ pub: legacy, myId: 'me', onVote: (s) => { scope = s; } })).props.onClick();
  assert.deepEqual(scope, {});
});

test('empty electorate disables voting and explains why no threshold can be reached', () => {
  const p = { ...pub, unite: { ...pub.unite, skipVote: { ...pub.unite.skipVote, eligible: [], needed: 1 } } };
  const view = UniteSkipVote({ pub: p, myId: 'me' });
  assert.equal(button(view).props.disabled, true);
  assert.match(text(view), /暂无可投票玩家/);
});

test('the combat capsule shows current and planned Unite waves while preserving the old single-wave layout', () => {
  const middle = { ...pub, unite: { ...pub.unite, round: 3 } };
  const view = PhaseCapsule({ pub: middle, hud: { killed: 4, total: 17 } });
  const wave = [view.props.children].flat().find((n) => n?.props?.['data-testid'] === 'unite-wave');
  assert.equal(text(wave), '3/5');
  assert.equal(wave.props.title, '第 3 轮联防 · 最多 5 轮');
  const single = PhaseCapsule({ pub: { ...pub, unite: { round: 1, roundsMax: 1 } }, hud: {} });
  assert.equal([single.props.children].flat().some((n) => n?.props?.['data-testid'] === 'unite-wave'), false);
});
