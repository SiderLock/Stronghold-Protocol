// Dedicated pre-cache downloads only. One budget covers every response, including clients behind different IPs.
// Token buckets account bytes accepted by node:http; round-robin is by client, then by that client's files.
import { performance } from 'node:perf_hooks';

export const ASSET_CACHE_LIMIT_DEFAULTS = Object.freeze({
  // Online filling is unrestricted unless the owner opts in to a byte budget. `null` is the
  // persisted/JSON representation; the limiter uses Infinity internally for arithmetic.
  totalBps: null, clientBps: null, maxDownloads: 24, maxDownloadsPerClient: 2,
});

const QUANTUM = 8 * 1024;
const TICK_MS = 20;
const BURST_SECONDS = 0.1;
const IDLE_CLIENT_MS = 2_000;
const STALL_TIMEOUT_MS = 60_000;

function rate(value, fallback) {
  if (value === null || String(value).trim().toLowerCase() === 'unlimited') return Infinity;
  const parsed = value === undefined || value === '' ? fallback : Number(value);
  if (parsed === null) return Infinity;
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new RangeError('asset cache rate must be a non-negative integer');
  return parsed;
}

/** Bytes per second, not Mbps. A zero aggregate rate explicitly disables online filling. */
export function assetCacheLimitOptions(opts = {}, env = process.env) {
  opts ??= {};
  const totalInput = Object.hasOwn(opts, 'totalBps') ? opts.totalBps : env.SP_ASSET_CACHE_TOTAL_BPS;
  const clientInput = Object.hasOwn(opts, 'clientBps') ? opts.clientBps : env.SP_ASSET_CACHE_CLIENT_BPS;
  const totalBps = rate(totalInput, ASSET_CACHE_LIMIT_DEFAULTS.totalBps);
  const clientBps = rate(clientInput, ASSET_CACHE_LIMIT_DEFAULTS.clientBps);
  if (totalBps > 0 && clientBps === 0) throw new RangeError('asset cache client rate must be positive when online filling is enabled');
  return { ...ASSET_CACHE_LIMIT_DEFAULTS, ...opts, totalBps, clientBps };
}

function publicRate(value) { return Number.isFinite(value) ? value : null; }

export class CacheDownloadLimiter {
  constructor(opts = {}) {
    this.opts = assetCacheLimitOptions(opts);
    this.stallTimeoutMs = opts.stallTimeoutMs ?? STALL_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.stallTimeoutMs) || this.stallTimeoutMs < 1) throw new RangeError('invalid asset cache stall timeout');
    for (const name of ['maxDownloads', 'maxDownloadsPerClient']) {
      if (!Number.isSafeInteger(this.opts[name]) || this.opts[name] < 1) throw new RangeError(`invalid asset cache ${name}`);
    }
    this.clients = new Map();
    this.active = 0;
    this.tokens = 0;
    this.updatedAt = performance.now();
    this.cursor = 0;
    this.timer = null;
    this.pumping = false;
    this.closed = false;
    this.tripped = false;
    this.tripReason = '';
    this.tripSince = 0;
    this.bytesWritten = 0;
    this.backpressureEvents = 0;
  }

  policy() {
    return { enabled: !this.closed && !this.tripped && this.opts.totalBps > 0, totalBps: publicRate(this.opts.totalBps),
      clientBps: publicRate(this.opts.clientBps), maxDownloads: this.opts.maxDownloads,
      maxDownloadsPerClient: this.opts.maxDownloadsPerClient, activeDownloads: this.active,
      emergency: this.tripped, emergencyReason: this.tripReason, emergencySince: this.tripSince };
  }

  /** Per-IP demand sets the existing cap; distinct network keys provide separate congestion evidence. */
  metrics() {
    let activeClients = 0, demandClients = 0, streamingDownloads = 0, preparingDownloads = 0;
    let remainingBytes = 0, blockedDownloads = 0;
    const demandNetworks = new Set();
    for (const client of this.clients.values()) {
      if (!client.jobs.size) continue;
      activeClients++;
      let demand = false;
      for (const job of client.jobs) {
        if (!job.started) { preparingDownloads++; continue; }
        streamingDownloads++;
        const remaining = Math.max(0, job.size - job.position);
        remainingBytes += remaining;
        if (remaining > 0) { demand = true; demandNetworks.add(job.networkKey); }
        if (job.blocked) blockedDownloads++;
      }
      if (demand) demandClients++;
    }
    return { ...this.policy(), activeClients, demandClients, demandNetworks: demandNetworks.size, streamingDownloads, preparingDownloads,
      remainingBytes, blockedDownloads, bytesWritten: this.bytesWritten,
      backpressureEvents: this.backpressureEvents,
      expectedBps: this.policy().enabled && Number.isFinite(this.opts.totalBps) && Number.isFinite(this.opts.clientBps)
        ? Math.min(this.opts.totalBps, this.opts.clientBps * demandClients) : 0 };
  }

  /** Reserve before opening/hash-checking a file, bounding disk work as well as sockets. */
  acquire(key, response = null, networkKey = key) {
    if (this.closed || this.tripped || this.opts.totalBps === 0 || this.active >= this.opts.maxDownloads) return null;
    const now = performance.now();
    this.prune(now);
    let client = this.clients.get(key);
    if (client && client.jobs.size >= this.opts.maxDownloadsPerClient) return null;
    if (!client) {
      client = { tokens: 0, updatedAt: now, idleAt: now, jobs: new Set(), cursor: 0 };
      this.clients.set(key, client);
    }
    let resolve;
    const done = new Promise((r) => { resolve = r; });
    const job = { client, networkKey, handle: null, buffer: null, res: null, size: 0, position: 0, blocked: false, released: false,
      reading: false, chunk: null, progressAt: now,
      started: false, ending: false, aborted: false,
      cleanup: null, resolve, done };
    client.jobs.add(job);
    this.active++;
    const release = () => this.release(job);
    const attach = (res) => {
      job.res = res;
      const onClose = () => release();
      const onError = () => release();
      const onDrain = () => { job.blocked = false; job.progressAt = performance.now(); this.schedule(); };
      res.once('close', onClose); res.once('finish', onClose); res.once('error', onError); res.on('drain', onDrain);
      job.cleanup = () => { res.off('close', onClose); res.off('finish', onClose); res.off('error', onError); res.off('drain', onDrain); };
      if (res.destroyed || res.writableFinished) release();
    };
    if (response) attach(response);
    this.schedule(); // preparation can stall before stream() ever starts
    const start = (handle, buffer, res, size) => {
      // A file can finish preparing after an emergency abort, including after a subsequent resume.
      // Its old lease must never start sending again.
      if (job.released) { if (job.aborted && !res.destroyed) res.destroy(); return done; }
      if (job.started) throw new Error('asset cache lease already streaming');
      if (job.res && job.res !== res) throw new Error('asset cache lease response changed');
      job.handle = handle; job.buffer = buffer; job.size = size; job.started = true; job.progressAt = performance.now();
      if (!job.res) attach(res);
      if (res.destroyed || res.writableEnded) release();
      else this.schedule();
      return done;
    };
    return {
      release,
      touch: () => { if (!job.released) job.progressAt = performance.now(); },
      get released() { return job.released; },
      stream: (handle, res, size) => start(handle, null, res, size),
      // The immutable catalog body uses the exact same scheduler, byte budget, slots and backpressure
      // as file downloads. Retain the shared body, rather than copying it once per requesting client.
      streamBuffer: (buffer, res) => {
        if (!Buffer.isBuffer(buffer)) throw new TypeError('asset cache body must be a Buffer');
        return start(null, buffer, res, buffer.length);
      },
    };
  }

  /** Apply an owner setting without restarting the HTTP server. Zero aggregate rate aborts active fills. */
  setLimits(opts = {}) {
    const current = { ...this.opts, totalBps: publicRate(this.opts.totalBps), clientBps: publicRate(this.opts.clientBps) };
    const next = assetCacheLimitOptions({ ...current, ...opts });
    const wasEnabled = this.opts.totalBps > 0;
    this.opts = next;
    this.tokens = next.totalBps === Infinity ? Infinity : Math.min(this.tokens, Math.max(1, next.totalBps * BURST_SECONDS));
    if (next.totalBps === 0 && wasEnabled) this.abortAll();
    else if (this.active) this.schedule();
    return this.policy();
  }

  prune(now) {
    for (const [key, client] of this.clients) {
      if (!client.jobs.size && now - client.idleAt > IDLE_CLIENT_MS) this.clients.delete(key);
    }
  }

  release(job) {
    if (job.released) return;
    job.released = true;
    job.chunk = null; job.buffer = null;
    job.cleanup?.();
    job.client.jobs.delete(job);
    job.client.idleAt = performance.now();
    this.active--;
    job.resolve();
    if (!this.active && this.timer) { clearTimeout(this.timer); this.timer = null; }
  }

  schedule() {
    if (this.closed || this.tripped || this.timer || this.pumping || !this.active) return;
    this.timer = setTimeout(() => { this.timer = null; this.pump(); }, TICK_MS);
    this.timer.unref?.();
  }

  abort(job) {
    if (job.released) return;
    job.aborted = true;
    job.res?.destroy(); this.release(job);
  }

  /** One bounded read per response. Its completion never holds the shared scheduler or sends prepaid bytes. */
  read(job) {
    job.reading = true;
    const length = Math.min(QUANTUM, job.size - job.position);
    const buffer = Buffer.allocUnsafe(length);
    let reading;
    try { reading = job.handle.read(buffer, 0, length, job.position); }
    catch { job.reading = false; this.abort(job); return; }
    Promise.resolve(reading).then(({ bytesRead }) => {
      job.reading = false;
      if (job.released) return;
      if (bytesRead !== length) { this.abort(job); return; }
      job.chunk = buffer;
      job.progressAt = performance.now();
      // Re-enter after disk completion, without adding a 20 ms delay to every 8 KiB chunk. Tokens are consumed
      // only by writes below, so late reads cannot exceed either the current aggregate or per-client budget.
      this.pump();
    }, () => { job.reading = false; this.abort(job); });
  }

  async pump() {
    if (this.closed || this.tripped || this.pumping) return;
    this.pumping = true;
    try {
      const now = performance.now();
      for (const client of this.clients.values()) for (const job of [...client.jobs]) {
        // Waiting for configured bandwidth is healthy; only blocked IO/preparation/flushes have a stall deadline.
        if ((!job.started || job.reading || job.blocked || job.ending) && now - job.progressAt >= this.stallTimeoutMs) this.abort(job);
      }
      this.tokens = this.opts.totalBps === Infinity ? Infinity
        : Math.min(Math.max(1, this.opts.totalBps * BURST_SECONDS), this.tokens + (now - this.updatedAt) * this.opts.totalBps / 1000);
      this.updatedAt = now;
      const clients = [...this.clients.values()].filter((client) => client.jobs.size);
      for (const client of clients) {
        client.tokens = this.opts.clientBps === Infinity ? Infinity
          : Math.min(Math.max(1, this.opts.clientBps * BURST_SECONDS), client.tokens + (now - client.updatedAt) * this.opts.clientBps / 1000);
        client.updatedAt = now;
      }
      let misses = 0;
      // No busy-spin when every client is capped/backpressured/preparing its file.
      while (!this.closed && !this.tripped && this.tokens >= 1 && clients.length && misses < clients.length) {
        const client = clients[this.cursor++ % clients.length];
        const jobs = [...client.jobs];
        let job = null;
        for (let i = 0; i < jobs.length; i++) {
          const candidate = jobs[client.cursor++ % jobs.length];
          if (!candidate.released && !candidate.ending && !candidate.reading
            && (candidate.handle || candidate.buffer) && !candidate.blocked) { job = candidate; break; }
        }
        if (!job || client.tokens < 1) { misses++; continue; }
        if (job.handle && !job.chunk) { this.read(job); misses++; continue; }
        const length = Math.floor(Math.min(QUANTUM, this.tokens, client.tokens, job.size - job.position));
        if (length <= 0) {
          if (job.position >= job.size) { job.ending = true; job.res.end(); }
          else misses++;
          continue;
        }
        misses = 0;
        try {
          const bytesRead = job.buffer ? length : Math.min(length, job.chunk.length);
          const buffer = job.buffer ? job.buffer.subarray(job.position, job.position + bytesRead) : job.chunk.subarray(0, bytesRead);
          this.tokens -= bytesRead; client.tokens -= bytesRead;
          job.blocked = !job.res.write(buffer);
          if (job.chunk) job.chunk = bytesRead === job.chunk.length ? null : job.chunk.subarray(bytesRead);
          job.progressAt = performance.now();
          if (job.blocked) this.backpressureEvents++;
          job.position += bytesRead;
          this.bytesWritten += bytesRead;
          // Retain the response until finish/close so emergency abort also cancels its final buffered quantum.
          if (job.position === job.size) { job.ending = true; job.res.end(); }
        } catch {
          this.abort(job);
        }
      }
    } finally { this.pumping = false; this.schedule(); }
  }

  abortAll() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const client of this.clients.values()) for (const job of [...client.jobs]) {
      job.aborted = true;
      job.res?.destroy(); this.release(job);
    }
    this.clients.clear();
    this.tokens = 0;
    this.updatedAt = performance.now();
  }

  /** Recoverable emergency gate; unlike close(), resume() may admit entirely new leases afterwards. */
  trip(reason = 'bandwidth-congestion') {
    if (this.closed || this.tripped) return false;
    this.tripped = true;
    this.tripReason = String(reason);
    this.tripSince = Date.now();
    this.abortAll();
    return true;
  }

  resume() {
    if (this.closed || !this.tripped) return false;
    this.tripped = false;
    this.tripReason = '';
    this.tripSince = 0;
    this.tokens = 0;
    this.updatedAt = performance.now();
    return true;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.abortAll();
  }
}
