import { performance } from 'node:perf_hooks';
import { RecentPeak } from '../shared/networkTiming.js';

// [ASSUMED] 250 ms sampling, eight-second evidence window. A pong also checks an overdue sampler,
// so a ping handled immediately after a long task cannot incorrectly report a healthy server.
export function createConnectionMetrics({ now = () => performance.now() } = {}) {
  const loop = new RecentPeak(now);
  const handler = new RecentPeak(now);
  let due = now() + 250;
  const timer = setInterval(() => {
    loop.add(Math.max(0, now() - due));
    due = now() + 250;
  }, 250);
  timer.unref?.();
  return {
    handler,
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
