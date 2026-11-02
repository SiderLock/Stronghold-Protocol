import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeSettings } from '../../public/js/ui/gameLogic/settings.js';
import { frameBudget } from '../../public/js/render/app/host.js';

test('frame limit preserves old profiles and round trips only the supported choices', () => {
  for (const value of [0, 30, 60]) {
    const settings = sanitizeSettings({ frameLimit: value, adaptiveResolution: false });
    assert.equal(sanitizeSettings(JSON.parse(JSON.stringify(settings))).frameLimit, value);
    assert.equal(settings.adaptiveResolution, false);
  }
  for (const value of [undefined, null, '30', true, -1, 45, 120, Infinity, NaN]) {
    assert.equal(sanitizeSettings({ frameLimit: value }).frameLimit, 0);
  }
});

test('load thresholds accept intentional 30 FPS and still detect missed frames', () => {
  for (const limit of [0, 30, 60]) {
    const budget = frameBudget(limit);
    assert.ok(budget < budget * 1.056, 'on-time frames permit load recovery');
    assert.ok(budget * 1.5 > budget * 1.17, 'missed frames still increase pressure');
  }
  assert.equal(frameBudget(0), frameBudget(60));
  assert.equal(frameBudget(30), frameBudget(60) * 2);
});
