// Shared preference state without loading the settings modal / audio just to read image visibility.
// settings.js owns persistence and the audio / document effects, as before.
import { createStore, loadPref } from '../store.js';
import { sanitizeSettings } from './gameLogic/settings.js';
import { gpu, gpuDefaults } from './glInfo.js';

// A first-run player on a software renderer (or a browser that cannot make a WebGL context at all) starts on the light
// tier: the heavy one (high resolution + official effects) is what makes such a browser stutter or lose the context.
// Anyone who has saved settings keeps exactly what they chose (docs/ASSETS.md, 设置).
const saved = loadPref('settings', null);
export const settingsStore = createStore(sanitizeSettings(saved === null ? gpuDefaults(gpu) : saved));
