// Bounded, recent measurements. Missing evidence stays null; wall-clock offsets are never one-way latency.
export class RecentPeak {
  constructor(now = Date.now, windowMs = 8000) {
    this.now = now;
    this.windowMs = windowMs;
    this.buckets = new Map();
  }

  add(value) {
    if (!Number.isFinite(value) || value < 0) return;
    const at = Math.floor(this.now() / 1000) * 1000;
    if (!this.buckets.has(at) || value >= this.buckets.get(at).value) this.buckets.set(at, { value, at: this.now() });
    this.trim();
  }

  trim() {
    const now = this.now();
    for (const at of this.buckets.keys()) if (at + 1000 <= now - this.windowMs || at > now) this.buckets.delete(at);
  }

  read() {
    this.trim();
    return this.buckets.size ? Math.round(Math.max(...[...this.buckets.values()].map(sample => sample.value))) : null;
  }

  /** Most recent significant peak, so a historical stall is not blamed for a later slow link. */
  evidence(minimum = 100) {
    this.trim();
    let recent = null;
    for (const sample of this.buckets.values()) {
      if (sample.value >= minimum && (!recent || sample.at > recent.at)) recent = sample;
    }
    return recent ? { ms: Math.round(recent.value), ageMs: Math.round(this.now() - recent.at) } : null;
  }

  clear() { this.buckets.clear(); }
}
