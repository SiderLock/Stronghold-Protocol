// One cooperative computation budget per process, shared by real match schedulers (including match hosts).
// Network/deadline timers stay outside this queue. No simulation ticks or candidates are discarded.
import { setImmediate, clearImmediate } from 'node:timers';

export const WORK_SLICE_MS = 8; // [ASSUMED] wall-clock budget between event-loop yields, not a preemption guarantee.
const clock = () => globalThis.performance?.now() ?? Date.now();

export function createWorkQueue({ budgetMs = WORK_SLICE_MS, now = clock,
  defer = fn => setImmediate(fn), clear = clearImmediate, onError = e => console.error('[work] callback threw', e) } = {}) {
  const waiting = new Set();
  const counters = { completed: 0, cancelled: 0, turns: 0, maxQueued: 0, maxSliceMs: 0, maxTurnMs: 0, maxWaitMs: 0 };
  let timer = null, running = false, lastSlowAt = -Infinity;
  function arm() {
    if (timer != null || running || !waiting.size) return;
    timer = defer(drain);
    timer?.unref?.();
  }
  function drain() {
    timer = null;
    running = true;
    const began = now();
    counters.turns++;
    try {
      let count = 0;
      while (waiting.size && count++ < 64) { // loop-cap: [ASSUMED] cap for cheap/self-rescheduling callbacks
        const task = waiting.values().next().value;
        waiting.delete(task);
        const at = now(), waitMs = Math.max(0, at - task.at);
        try { task.fn(); } catch (e) { onError(e); }
        const elapsedMs = Math.max(0, now() - at);
        counters.completed++;
        counters.maxSliceMs = Math.max(counters.maxSliceMs, elapsedMs);
        counters.maxWaitMs = Math.max(counters.maxWaitMs, waitMs);
        if (elapsedMs >= 25 && task.options.onSlow && at - lastSlowAt >= 30000) { // [ASSUMED] local diagnostic thresholds
          lastSlowAt = at;
          // Observability must never interrupt gameplay or the rest of the queue.
          try { task.options.onSlow({ work: task.options.work, elapsedMs: Math.round(elapsedMs),
            waitMs: Math.round(waitMs), queued: waiting.size }); } catch { /* local logging only */ }
        }
        if (now() - began >= budgetMs) break;
      }
    } finally {
      counters.maxTurnMs = Math.max(counters.maxTurnMs, Math.max(0, now() - began));
      running = false;
      arm();
    }
  }
  return {
    submit(fn, options = {}) {
      const task = { fn, options, at: now() };
      waiting.add(task);
      counters.maxQueued = Math.max(counters.maxQueued, waiting.size);
      arm();
      return task;
    },
    cancel(task) {
      if (!waiting.delete(task)) return;
      counters.cancelled++;
      if (!waiting.size && timer != null) { clear(timer); timer = null; }
    },
    stats() { return { queued: waiting.size, running: Number(running), ...counters }; },
  };
}

// Allocating the queue starts no timer. Disposing one match cancels only its own handles, not another room's work.
export const processWorkQueue = createWorkQueue();
