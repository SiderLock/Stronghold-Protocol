// Visible consumers announce demand; optional network work yields without coupling renderer implementations.
let active = 0;
const listeners = new Set();
const notify = () => { for (const fn of listeners) { try { fn(active); } catch { /* optional observer */ } } };
export const assetDemand = {
  get active() { return active; },
  subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
};
export function trackAssetDemand(promise) {
  active++; notify();
  return Promise.resolve(promise).finally(() => { active--; notify(); });
}

/** Two current-view files or one optional file. New foreground demand preempts optional work. */
export function createAssetPreloader({ load, environment = globalThis, demand = assetDemand, delay = 600 } = {}) {
  const env = environment, done = new Set(), failed = new Set(), loading = new Set();
  let foreground = [], background = [], enabled = false, full = false, destroyed = false;
  let lastRemaining = null, lastRequired = [];
  let timer = null, optional = null;
  const available = (url) => !done.has(url) && !failed.has(url) && !loading.has(url);
  const backgroundAllowed = () => !env.document?.hidden && env.navigator?.onLine !== false
    && !env.navigator?.connection?.saveData && !['slow-2g', '2g'].includes(env.navigator?.connection?.effectiveType);
  const cancelOptional = () => { optional?.abort.abort(); };
  function schedule(wait = delay) {
    if (destroyed || !enabled) return;
    if (timer !== null) {
      if (!foreground.length) return;
      env.clearTimeout(timer);
    }
    timer = env.setTimeout(pump, foreground.length ? 0 : wait);
  }
  function pump() {
    timer = null;
    if (destroyed || !enabled || env.navigator?.onLine === false || env.document?.hidden) return;
    if (demand.active) return; // reuse visible consumers' in-flight loads instead of requesting their files twice
    while (foreground.length && loading.size < 2) {
      const url = foreground.shift();
      if (!available(url)) continue;
      loading.add(url);
      Promise.resolve().then(() => load(url, { background: false })).then(() => done.add(url), () => failed.add(url))
        .finally(() => { loading.delete(url); schedule(); });
    }
    if (foreground.length || loading.size || demand.active || optional || full || !backgroundAllowed()) return;
    let url;
    while (background.length && !url) { const next = background.shift(); if (available(next)) url = next; }
    if (!url) return;
    const job = optional = { url, abort: new AbortController() };
    Promise.resolve().then(() => load(url, { background: true, signal: job.abort.signal }))
      .then(() => done.add(url), () => { if (!job.abort.signal.aborted) failed.add(url); })
      .finally(() => {
        if (job.abort.signal.aborted && !done.has(url)) background.unshift(url);
        if (optional === job) optional = null;
        schedule(16);
      });
  }
  const off = demand.subscribe((n) => { if (n) cancelOptional(); schedule(); });
  const wake = () => {
    if (!backgroundAllowed()) cancelOptional();
    else {
      failed.clear();
      foreground = [...new Set(lastRequired)].filter(available);
      background = [...new Set(lastRemaining || [])].filter(available);
    }
    schedule();
  };
  env.addEventListener?.('online', wake);
  env.document?.addEventListener?.('visibilitychange', wake);
  env.navigator?.connection?.addEventListener?.('change', wake);
  return {
    update({ required = [], remaining = [], allow = enabled, stopped = full } = {}) {
      const current = new Set(foreground);
      lastRequired = required;
      foreground = [...new Set(required)].filter(available);
      if (foreground.some((u) => !current.has(u))) cancelOptional();
      if (remaining !== lastRemaining) { background = [...new Set(remaining)].filter(available); lastRemaining = remaining; }
      enabled = allow; full = stopped;
      if (!enabled || full) cancelOptional();
      schedule();
    },
    status: () => ({ completed: done.size, failed: failed.size, required: foreground.length + loading.size,
      remaining: background.length, enabled, full, optional: !!optional }),
    destroy() {
      destroyed = true; cancelOptional(); off(); if (timer !== null) env.clearTimeout(timer);
      env.removeEventListener?.('online', wake); env.document?.removeEventListener?.('visibilitychange', wake);
      env.navigator?.connection?.removeEventListener?.('change', wake);
    },
  };
}
