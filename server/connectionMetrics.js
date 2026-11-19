import { performance } from 'node:perf_hooks';
import { RecentPeak } from '../shared/networkTiming.js';

// [ASSUMED] 250 ms sampling, eight-second evidence window. A pong also checks an overdue sampler,
// so a ping handled immediately after a long task cannot incorrectly report a healthy server.
export function createConnectionMetrics({ now = () => performance.now(), onSlow = null } = {}) {
  const loop = new RecentPeak(now);
  const handler = new RecentPeak(now);
  let due = now() + 250;
  let lastSlowAt = -Infinity;
  const timer = setInterval(() => {
    loop.add(Math.max(0, now() - due));
    due = now() + 250;
  }, 250);
  timer.unref?.();
  return {
    handler,
    // Keep synchronous dispatch separate from an asynchronous match host's total response time.
    // Only bounded local logs get the context; pongs and health retain their existing contract.
    recordHandler(type, syncMs, totalMs = syncMs, context = null) {
      if (!Number.isFinite(syncMs) || !Number.isFinite(totalMs) || syncMs < 0 || totalMs < 0) return;
      handler.add(totalMs);
      const at = now();
      if (!onSlow || Math.max(syncMs, totalMs) < 100 || at - lastSlowAt < 30000) return;
      lastSlowAt = at;
      try { onSlow({ type, syncMs: Math.round(syncMs), totalMs: Math.round(totalMs) }, context); }
      catch { /* A local diagnostics sink must not interrupt the request pipeline. */ }
    },
    snapshot: () => {
      const overdue = Math.round(Math.max(0, now() - due));
      const recent = loop.evidence();
      const handling = handler.evidence();
      return { loopMs: overdue >= 100 ? overdue : recent?.ms ?? loop.read() ?? 0,
        loopAgeMs: overdue >= 100 ? 0 : recent?.ageMs ?? null,
        handlerMs: handling?.ms ?? handler.read(), handlerAgeMs: handling?.ageMs ?? null };
    },
    close: () => clearInterval(timer),
  };
}
