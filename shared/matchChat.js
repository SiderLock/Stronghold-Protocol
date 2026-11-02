// Match-only text chat. Shared input rules have no storage, clocks or platform APIs.
export const CHAT_LIMITS = Object.freeze({ text: 200, inputUnits: 400, history: 200 });

/** Unicode code points, matching the displayed character budget (an emoji counts once). */
export function chatTextLength(value) {
  return typeof value === 'string' ? [...value].length : 0;
}

/** Reject oversized/raw malformed input before normalization; never truncate a player's message. */
export function isChatTextInput(value) {
  if (typeof value !== 'string' || !value.length || value.length > CHAT_LIMITS.inputUnits) return false;
  if (chatTextLength(value) > CHAT_LIMITS.text) return false;
  // for…of yields a lone surrogate as one unit; valid pairs remain two-unit characters.
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (char.length === 1 && code >= 0xd800 && code <= 0xdfff) return false;
  }
  return true;
}

/** Plain NFC text with bounded line breaks; markup stays literal for textContent rendering. */
export function normalizeChatText(value) {
  if (!isChatTextInput(value)) return null;
  const text = value.normalize('NFC')
    // Strip invisible controls and direction overrides; preserve ZWJ emoji sequences and normal Unicode letters.
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, '')
    .replace(/\r\n?/gu, '\n')
    .replace(/[^\S\n]+/gu, ' ')
    .replace(/ *\n */gu, '\n')
    .replace(/\n{3,}/gu, '\n\n').trim();
  return text && chatTextLength(text) <= CHAT_LIMITS.text ? text : null;
}
