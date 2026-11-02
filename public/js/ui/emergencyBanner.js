// Persistent emergency notice, separate from solo pause and ordinary connection recovery.
import { html, Icon } from './components.js';
import { useStore, emergencyActive } from '../store.js';
import { useDocClass } from './device.js';
import { t } from '../../../shared/i18n.js';

export function EmergencyBanner() {
  const active = useStore(emergencyActive);
  const inMatch = useStore((s) => !!s.room?.inMatch || !!s.match?.public && s.match.public.phase !== 'RESULT');
  const setup = useStore((s) => ['INFO_CHECK', 'BAND_DRAFT'].includes(s.match?.public?.phase));
  useDocClass('sp-emergency', active);
  useDocClass('sp-emergency-setup', active && setup);
  if (!active) return null;
  return html`<div class="emergency-banner" role="alert" aria-live="assertive" data-testid="server-emergency">
    <${Icon} name="shield" />
    <span>${inMatch ? t('服务器带宽紧急保护已开启，对局已冻结，请等待恢复')
      : t('服务器带宽紧急保护已开启，暂时停止进入对局和在线补齐，请等待恢复')}</span>
  </div>`;
}
