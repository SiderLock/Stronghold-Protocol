// Keyboard behavior is checked separately from the Edge layout/multiplayer suite: an IME's Enter commits a
// composition, and Shift+Enter adds a newline. Neither may leak into a send action or the game's keyboard handler.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chatEnterSends } from '../../public/js/ui/matchChat.js';

test('chat Enter sends plain text, leaving Shift+Enter for a newline', () => {
  assert.equal(chatEnterSends({ key: 'Enter' }), true);
  assert.equal(chatEnterSends({ key: 'Enter', shiftKey: true }), false);
  for (const key of [' ', 'Escape', 'r', 'F', 'ArrowDown', 'Process']) assert.equal(chatEnterSends({ key }), false, key);
  assert.equal(chatEnterSends(null), false);
});

test('chat does not send an IME composition commit or the legacy 229 event', () => {
  assert.equal(chatEnterSends({ key: 'Enter', isComposing: true }), false);
  assert.equal(chatEnterSends({ key: 'Enter', keyCode: 229 }), false);
  assert.equal(chatEnterSends({ key: 'Enter', isComposing: false, keyCode: 13 }), true);
});
