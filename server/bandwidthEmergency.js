// Application congestion guard. Linux interface counters are supporting evidence, not a cloud-capacity measurement.
// No HTTP, lobby or network imports: callers supply cache demand / game-connection evidence and apply transitions.
import { readFile } from 'node:fs/promises';

export const BANDWIDTH_EMERGENCY_DEFAULTS = Object.freeze({
  enabled: false, pollMs: 1_000, windowMs: 5_000, triggerMs: 15_000, ratio: 0.6,
  minClients: 2, interfaceName: '', autoResumeMs: 60_000, gameBudgetBps: 500_000, minPendingBytes: 64 * 1024,
});

function integer(value, fallback, minimum, name) {
  const parsed = value == null || value === '' ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) throw new RangeError(`invalid bandwidth ${name}`);
  return parsed;
}

/** Milliseconds and bytes/second throughout; autoResumeMs:0 keeps an emergency until manual resume. */
export function bandwidthEmergencyOptions(opts = {}, env = process.env) {
  const defaults = BANDWIDTH_EMERGENCY_DEFAULTS;
  const enabled = opts.enabled ?? env.SP_BANDWIDTH_EMERGENCY_ENABLED ?? defaults.enabled;
  if (![true, false, '1', '0'].includes(enabled)) throw new RangeError('invalid bandwidth enabled');
  const ratio = Number(opts.ratio ?? env.SP_BANDWIDTH_RATIO ?? defaults.ratio);
  if (!(ratio > 0 && ratio < 1)) throw new RangeError('invalid bandwidth ratio');
  const interfaceName = opts.interfaceName ?? env.SP_BANDWIDTH_INTERFACE ?? defaults.interfaceName;
  if (typeof interfaceName !== 'string' || (interfaceName && !/^[A-Za-z0-9_.-]{1,64}$/.test(interfaceName))) {
    throw new RangeError('invalid bandwidth interface');
  }
  return {
    enabled: enabled === true || enabled === '1', ratio, interfaceName,
    pollMs: integer(opts.pollMs ?? env.SP_BANDWIDTH_POLL_MS, defaults.pollMs, 0, 'poll interval'),
    windowMs: integer(opts.windowMs ?? env.SP_BANDWIDTH_WINDOW_MS, defaults.windowMs, 1, 'window'),
    triggerMs: integer(opts.triggerMs ?? env.SP_BANDWIDTH_TRIGGER_MS, defaults.triggerMs, 1, 'trigger duration'),
    minClients: integer(opts.minClients ?? env.SP_BANDWIDTH_MIN_CLIENTS, defaults.minClients, 2, 'client count'),
    autoResumeMs: integer(opts.autoResumeMs ?? env.SP_BANDWIDTH_AUTO_RESUME_MS, defaults.autoResumeMs, 0, 'retry interval'),
    gameBudgetBps: integer(opts.gameBudgetBps ?? env.SP_BANDWIDTH_GAME_BPS, defaults.gameBudgetBps, 1, 'game budget'),
    minPendingBytes: integer(opts.minPendingBytes ?? env.SP_BANDWIDTH_MIN_PENDING_BYTES,
      defaults.minPendingBytes, 1, 'pending byte threshold'),
  };
}

/** Select the IPv4 default route instead of summing virtual/internal interfaces and double-counting their traffic. */
export function defaultEgressInterface(text) {
  const routes = [];
  for (const line of String(text).split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 8 || parts[1] !== '00000000' || parts[7] !== '00000000') continue;
    if (!(Number.parseInt(parts[3], 16) & 1) || parts[0] === 'lo') continue;
    const metric = Number(parts[6]);
    if (Number.isFinite(metric)) routes.push({ name: parts[0], metric });
  }
  routes.sort((a, b) => a.metric - b.metric);
  return routes[0]?.name || '';
}

export function interfaceTxBytes(text, interfaceName) {
  for (const line of String(text).split(/\r?\n/)) {
    const colon = line.lastIndexOf(':');
    if (colon < 0 || line.slice(0, colon).trim() !== interfaceName) continue;
    const counters = line.slice(colon + 1).trim().split(/\s+/);
    const txBytes = Number(counters[8]);
    if (counters.length >= 16 && Number.isSafeInteger(txBytes) && txBytes >= 0) return txBytes;
  }
  return null;
}

/** Windows / missing proc counters do not infer bandwidth from queued application bytes. Manual trip still works. */
export function createProcEgressSampler({ interfaceName = '', platform = process.platform, read = readFile } = {}) {
  return async () => {
    if (platform !== 'linux') return null;
    const name = interfaceName || defaultEgressInterface(await read('/proc/net/route', 'utf8'));
    if (!name) return null; // IPv6-only or unusual routing requires an explicitly configured interface.
    const txBytes = interfaceTxBytes(await read('/proc/net/dev', 'utf8'), name);
    return txBytes == null ? null : { txBytes, interfaceName: name };
  };
}

const finite = (value) => Number.isFinite(value) && value >= 0 ? value : 0;
const gameCongested = (value) => value === true || !!value?.congested ||
  finite(value?.congestedConnections) > 0 || finite(value?.delayedHeartbeats) > 0;
const CACHE_AGGREGATES = ['activeDownloads', 'activeClients', 'demandClients', 'demandNetworks',
  'streamingDownloads', 'preparingDownloads', 'remainingBytes', 'blockedDownloads', 'bytesWritten',
  'backpressureEvents', 'expectedBps', 'totalBps', 'clientBps', 'maxDownloads', 'maxDownloadsPerClient'];
const GAME_AGGREGATES = ['activeConnections', 'activeNetworks', 'congestedConnections', 'congestedNetworks',
  'delayedHeartbeats', 'delayedNetworks', 'impairedNetworks', 'maxBufferedBytes'];
function aggregateSnapshot(value, fields) {
  return Object.freeze(Object.fromEntries(fields.filter((name) => Number.isFinite(value[name]) && value[name] >= 0)
    .map((name) => [name, value[name]])));
}

/**
 * getMetrics: CacheDownloadLimiter.metrics; getCongestion: boolean or game-connection backlog/heartbeat summary.
 * sampleEgress: async {txBytes, interfaceName?} cumulative counter, or null if unavailable. Injectable for tests.
 * canResume: synchronous bool gate for automated retries (manual resume always overrides it).
 * onChange receives a snapshot after each trip/resume or delayed retry. Applying gates belongs to the caller.
 * Automatic retry means only an attempt to resume; it does not assert that the cloud's bandwidth has recovered.
 */
export function createBandwidthEmergencyController(options = {}) {
  const { env = process.env, platform = process.platform, now = Date.now, getMetrics = () => ({}),
    getCongestion = () => false, canResume = () => true, onChange, log = console } = options;
  const opts = bandwidthEmergencyOptions(options, env);
  const sampleEgress = options.sampleEgress || createProcEgressSampler({ interfaceName: opts.interfaceName, platform });
  const supported = !!options.sampleEgress || platform === 'linux';
  let started = false, closed = false, polling = false, timer = null;
  let enabled = opts.enabled;
  let active = false, reason = '', startedAt = 0, retryAt = 0, source = '', action = '';
  let badSince = null, txBps = null, sampledAt = 0, available = false, sampleError = '';
  let interfaceName = opts.interfaceName, cacheMetrics = {}, congestion = false, congestionMetrics = {};
  let rule = '', detectionExpectedBps = 0;
  let previousBackpressureEvents = null, recentBackpressure = false;
  let lastTrigger = null;
  const samples = [];

  function resetEvidence() {
    samples.length = 0; badSince = null; txBps = null; rule = ''; detectionExpectedBps = 0;
  }

  function readDemand() {
    cacheMetrics = { ...getMetrics() };
    const pressureEvents = finite(cacheMetrics.backpressureEvents);
    recentBackpressure = previousBackpressureEvents != null && pressureEvents > previousBackpressureEvents;
    previousBackpressureEvents = pressureEvents;
    const game = getCongestion();
    congestion = gameCongested(game);
    congestionMetrics = game && typeof game === 'object' ? { ...game } : {};
  }

  function status() {
    return { active, reason, startedAt, retryAt, source, action, started, closed,
      lastTrigger: lastTrigger ? { ...lastTrigger, metrics: { ...lastTrigger.metrics }, congestion: { ...lastTrigger.congestion } } : null,
      enabled, config: { ...opts, enabled }, metrics: { ...cacheMetrics }, detection: {
        supported, available, interfaceName, sampledAt, txBps, sampleError, gameCongested: congestion,
        congestion: { ...congestionMetrics }, rule, expectedBps: detectionExpectedBps,
        badForMs: badSince == null ? 0 : Math.max(0, now() - badSince),
      } };
  }

  function notify() {
    try { onChange?.(status()); }
    catch (error) { log.warn?.(`[bandwidth-emergency] transition handler failed: ${error.message}`); }
  }

  function trip(nextReason = 'egress-congestion', { source: nextSource = 'manual' } = {}) {
    if (closed || active) return false;
    active = true; reason = String(nextReason); startedAt = now();
    retryAt = opts.autoResumeMs > 0 ? startedAt + opts.autoResumeMs : 0;
    source = nextSource; action = 'trip';
    // Keep only aggregate counters, before external gates clear live demand and resetEvidence clears the window.
    // The private immutable copy survives resume; every status/notification gets independent nested objects.
    lastTrigger = Object.freeze({ at: startedAt, source, rule, txBps, expectedBps: detectionExpectedBps,
      badForMs: badSince == null ? 0 : Math.max(0, startedAt - badSince),
      metrics: aggregateSnapshot(cacheMetrics, CACHE_AGGREGATES), congestion: aggregateSnapshot(congestionMetrics, GAME_AGGREGATES) });
    notify();
    resetEvidence();
    return true;
  }

  function resume({ source: nextSource = 'manual' } = {}) {
    if (closed || !active) return false;
    active = false; reason = ''; startedAt = 0; retryAt = 0;
    source = nextSource; action = nextSource === 'automatic-retry' ? 'retry' : 'resume';
    resetEvidence();
    notify();
    return true;
  }

  async function poll() {
    if (closed || polling || !enabled) return status();
    polling = true;
    try {
      const time = now();
      try { readDemand(); }
      catch (error) { sampleError = `demand: ${error.message}`; resetEvidence(); return status(); }
      if (active && retryAt > 0 && time >= retryAt) {
        let allowed = false;
        try { allowed = canResume() === true; }
        catch (error) { sampleError = `resume: ${error.message}`; }
        // Never thaw known-congested or fully disconnected matches just to run another detection window.
        if (congestion || !allowed) {
          retryAt = time + opts.autoResumeMs; source = 'automatic-retry'; action = 'retry-delayed'; notify();
        } else {
          resume({ source: 'automatic-retry' });
          try { readDemand(); }
          catch (error) { sampleError = `demand: ${error.message}`; resetEvidence(); return status(); }
        }
      }
      if (!supported || active) return status();
      let sample;
      try { sample = await sampleEgress(); }
      catch (error) { sampleError = String(error.message || error); sample = null; }
      if (closed || !enabled) return status();
      if (!sample || !Number.isSafeInteger(sample.txBytes) || sample.txBytes < 0) {
        available = false; resetEvidence(); return status();
      }
      available = true; sampleError = ''; sampledAt = time;
      const name = String(sample.interfaceName || opts.interfaceName || 'injected');
      const previous = samples.at(-1);
      if (name !== interfaceName || (previous && (sample.txBytes < previous.txBytes || time <= previous.at ||
        time - previous.at > Math.max(opts.windowMs, opts.pollMs * 3)))) resetEvidence();
      interfaceName = name;
      samples.push({ at: time, txBytes: sample.txBytes });
      const cutoff = time - opts.windowMs;
      while (samples.length > 2 && samples[1].at <= cutoff) samples.shift();
      const first = samples[0];
      if (time - first.at < opts.windowMs) { badSince = null; return status(); }
      txBps = (sample.txBytes - first.txBytes) * 1000 / (time - first.at);
      const expectedBps = finite(cacheMetrics.expectedBps);
      const demandClients = finite(cacheMetrics.demandClients);
      const demandNetworks = cacheMetrics.demandNetworks == null ? demandClients : finite(cacheMetrics.demandNetworks);
      const demand = finite(cacheMetrics.activeDownloads) > 0 && expectedBps > 0 &&
        finite(cacheMetrics.remainingBytes) >= opts.minPendingBytes;
      // Short blocked/drain cycles can fall between one-second samples; cumulative events retain their evidence.
      const evidence = congestion || (demandNetworks >= opts.minClients &&
        (finite(cacheMetrics.blockedDownloads) > 0 || recentBackpressure));
      const activeNetworks = finite(congestionMetrics.activeNetworks);
      // Counts may overlap. Prefer the caller's union; max is a conservative lower bound otherwise.
      const impairedNetworks = congestionMetrics.impairedNetworks == null ?
        Math.max(finite(congestionMetrics.congestedNetworks), finite(congestionMetrics.delayedNetworks)) :
        finite(congestionMetrics.impairedNetworks);
      const gameEvidence = activeNetworks >= 2 && impairedNetworks >= 2 &&
        impairedNetworks >= Math.ceil(activeNetworks / 2);
      const cacheLow = demand && evidence && txBps < expectedBps * opts.ratio;
      const gameLow = gameEvidence && txBps < opts.gameBudgetBps * opts.ratio;
      const nextRule = cacheLow ? 'cache-demand' : gameLow ? 'game-congestion' : '';
      if (nextRule !== rule) badSince = null;
      rule = nextRule;
      detectionExpectedBps = cacheLow ? expectedBps : gameLow ? opts.gameBudgetBps : 0;
      if (!nextRule) badSince = null;
      else {
        badSince ??= time;
        if (time - badSince >= opts.triggerMs) trip('egress-congestion', { source: 'automatic' });
      }
      return status();
    } finally { polling = false; }
  }

  const controller = {
    trip, resume, status, poll,
    setEnabled(next) {
      if (closed) return false;
      if (typeof next !== 'boolean') throw new TypeError('bandwidth emergency enabled must be boolean');
      if (enabled === next) return false;
      enabled = next;
      resetEvidence();
      clearInterval(timer); timer = null;
      // An explicit operator disable means the protection is no longer wanted. Release an
      // existing emergency before stopping all detector work; no automatic sample/retry runs while off.
      if (!enabled && active) resume({ source: 'operator-disable' });
      if (enabled && started && opts.pollMs > 0) {
        timer = setInterval(() => { void poll(); }, opts.pollMs); timer.unref?.();
      }
      return true;
    },
    start() {
      if (started || closed) return controller;
      started = true;
      if (!enabled) return controller;
      void poll();
      if (opts.pollMs > 0) { timer = setInterval(() => { void poll(); }, opts.pollMs); timer.unref?.(); }
      return controller;
    },
    close() {
      if (closed) return;
      closed = true; clearInterval(timer); timer = null; resetEvidence();
    },
  };
  return controller;
}
