// Shared loadout toolbar control. The server owns per-match rolls; this dialog only chooses the policy or a fixed roll.
import { useState } from '../../vendor/hooks.module.js';
import { html, Icon, Button, Modal } from './components.js';
import { useStore } from '../store.js';
import { useData } from '../data.js';
import { skinsStore, SKINS_KEY, SKINS_RANDOM_MODE_KEY, hasAnySkinChoices, randomizeSkins, setSkinRandomMode } from './skins.js';
import { toast } from './toasts.js';
import { t } from '../../../shared/i18n.js';

export function SkinRandomControls() {
  const ready = useData('assets');
  const state = useStore(v => v, Object.is, skinsStore), [open, setOpen] = useState(false);
  const mode = state[SKINS_RANDOM_MODE_KEY], available = ready && hasAnySkinChoices();
  const count = Object.keys(state[SKINS_KEY] || {}).length;
  const roll = () => {
    const n = randomizeSkins();
    if (n) toast(t('已为 {count} 名干员随机选择时装并固定', { count: n }));
  };
  return html`<button type="button" class=${`lo-tbtn lo-skin-random-trigger${mode === 'match' ? ' is-on' : ''}`}
    data-testid="skin-random" onClick=${() => setOpen(true)} title=${t('皮肤随机')} aria-label=${t('皮肤随机')}>
    <${Icon} name="refresh" /><span class="lo-tbtn__l">${t('皮肤随机')}</span>
  </button>
  <${Modal} open=${open} onClose=${() => setOpen(false)} title=${t('皮肤随机')} micro="RANDOM OUTFITS" width="min(92vw, 540px)"
    actions=${html`<${Button} variant="secondary" icon="refresh" disabled=${!available} data-testid="skin-random-roll" onClick=${roll}>${t('随机一套并固定')}<//>
      <${Button} onClick=${() => setOpen(false)}>${t('完成')}<//>`}>
    <div class="lo-skin-random" data-testid="skin-random-options">
      <p>${t('为所有有可用时装的干员随机选择皮肤；没有时装的干员保留默认外观。')}</p>
      <label><input type="radio" name="skin-random-mode" value="fixed" checked=${mode !== 'match'}
        onChange=${() => setSkinRandomMode('fixed')} /><span><b>${t('固定本次随机内容')}</b><small>${t('保存当前这套皮肤，后续对局继续使用；手动选皮肤也会切回此模式。')}</small></span></label>
      <label><input type="radio" name="skin-random-mode" value="match" checked=${mode === 'match'} disabled=${!available}
        onChange=${() => setSkinRandomMode('match')} /><span><b>${t('每局都随机')}</b><small>${t('从下一局开始，开局时重新随机一套；本局和重连时保持不变。')}</small></span></label>
      <p class="t-dim" role="status">${available ? t('当前已为 {count} 名干员选择时装', { count }) : t('当前没有可随机的时装')}</p>
    </div>
  <//>`;
}
