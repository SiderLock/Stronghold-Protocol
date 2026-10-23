import { N_ } from '../../shared/i18n.js';

export const QUALITY_TEXT = Object.freeze({
  server: N_('服务器处理较慢，操作响应可能延迟'),
  device: N_('当前页面运行较慢，可尝试降低画质或关闭其他页面'),
  connection: N_('连接延迟较高，可尝试切换网络或暂停下载'),
});

// [ASSUMED] Require two affected probes; two healthy probes clear the small notice.
// A send queue locates congestion in the delivery path, not at the user's router. Never call it user fault.
export class ConnectionQuality {
  constructor() { this.reset(); }
  reset() { this.cause = null; this.candidate = null; this.streak = 0; this.previousRtt = null; }
  sample({ rtt, server = null, clientLag = null, clientLagAge = 0, uploadBytes = 0, visible = true }) {
    if (!visible) { this.reset(); return null; }
    const jitter = this.previousRtt == null ? 0 : Math.abs(rtt - this.previousRtt);
    this.previousRtt = rtt;
    const overlaps = (ms, age) => ms >= 100 && age != null && age <= rtt;
    const serverBusy = server && (overlaps(server.loopMs, server.loopAgeMs) || overlaps(server.handlerMs, server.handlerAgeMs));
    const cause = serverBusy ? 'server' : overlaps(clientLag, clientLagAge) ? 'device'
      : rtt >= 250 || jitter >= 150 || uploadBytes >= 64 * 1024 || server?.queuedBytes >= 64 * 1024 ? 'connection' : null;
    if (cause === this.candidate) this.streak++;
    else { this.candidate = cause; this.streak = 1; }
    if (this.streak >= 2) this.cause = cause;
    return { cause: this.cause, rttMs: Math.round(rtt), jitterMs: Math.round(jitter),
      clientLagMs: clientLag, clientLagAgeMs: clientLagAge, server, uploadBytes };
  }
}
