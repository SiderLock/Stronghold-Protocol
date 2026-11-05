// render/vfx/tier.js — 设置「官方特效」 (settings `officialFx`): 'auto' | 'off' | 'low' | 'lite' | 'full' → the tier the
// official battle effects run at. full / lite retain the old 完整 / 精简 profiles, displayed as 高 / 中; low is 低.
// 'auto' (the default) is 高 on a desktop and 中 on a touch device; nothing runs
// when no effects were extracted from the local client (the setting is hidden then, ui/settings.js).

export const OFFICIAL_FX = Object.freeze(['auto', 'off', 'low', 'lite', 'full']);

/** A touch-first device (coarse pointer, no fine one): the light tier by default. */
export function touchDevice() {
  try {
    const mm = globalThis.matchMedia;
    if (typeof mm !== 'function') return false;
    return mm('(pointer: coarse)').matches && !mm('(any-pointer: fine)').matches;
  } catch { return false; }
}

/** The effective tier of a setting value ('off' | 'low' | 'lite' | 'full'). */
export function resolveOfficialFx(value, available = true, touch = touchDevice()) {
  if (!available) return 'off';
  if (value === 'off' || value === 'low' || value === 'lite' || value === 'full') return value;
  return touch ? 'lite' : 'full';
}
