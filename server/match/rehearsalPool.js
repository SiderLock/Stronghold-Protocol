// Stateless vanilla previews and oversized-result replays run outside the network/match event loop.
// A child process follows match/host's existing isolation choice; cancellation never kills a server process.
import { fork } from 'node:child_process';
import { availableParallelism } from 'node:os';

export function createRehearsalPool({ data, workers = Math.min(2, Math.max(0, availableParallelism() - 1)),
  timeoutMs = 30000, idleMs = 60000, log = {} } = {}) {
  const size = Number.isInteger(workers) && workers >= 0 ? Math.min(workers, 4) : 0;
  const slots = new Set();
  const queue = [];
  let closed = false, disabled = false, sequence = 0;

  function retire(slot, error = null) {
    if (!slots.delete(slot)) return;
    clearTimeout(slot.timer);
    clearTimeout(slot.idle);
    if (slot.job) { slot.job.reject(error || new Error('rehearsal worker stopped')); slot.job = null; }
    try { slot.child.kill(); } catch { /* already exited */ }
    pump();
  }
  function armIdle(slot) {
    clearTimeout(slot.idle);
    slot.child.unref(); slot.child.channel?.unref();
    slot.idle = setTimeout(() => retire(slot), idleMs);
    slot.idle.unref?.();
  }
  function spawn() {
    const child = fork(new URL('./rehearsalWorker.js', import.meta.url), [], {
      execArgv: ['--max-old-space-size=512'], serialization: 'advanced', windowsHide: true,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    const slot = { child, ready: false, job: null, timer: null, idle: null };
    slots.add(slot);
    child.unref(); child.channel?.unref();
    if (queue.length) { child.ref(); child.channel?.ref(); }
    const fail = (error) => {
      if (!slots.has(slot)) return;
      log.warn?.(`[rehearsal] worker unavailable: ${error.message}`);
      // Never respawn endlessly on a boot/import failure. Existing jobs fall back to sliced local work.
      disabled = true;
      for (const job of queue.splice(0)) job.reject(error);
      retire(slot, error);
    };
    child.on('error', fail);
    child.on('exit', () => fail(new Error('rehearsal worker exited')));
    child.on('message', (message) => {
      if (!slots.has(slot)) return;
      if (message?.type === 'ready') {
        clearTimeout(slot.timer); slot.ready = true; armIdle(slot); pump(); return;
      }
      const job = slot.job;
      if (!job || message?.id !== job.id) return;
      clearTimeout(slot.timer); slot.job = null;
      if (job.payload.kind === 'headless' && message.output?.result?.perPlayer && Array.isArray(message.output.timeline)
        && Number.isFinite(message.output.time)) job.resolve(message.output);
      else if (job.payload.kind !== 'headless' && Number.isInteger(message.index) && message.index >= 0 && message.index < job.payload.inputs.length) job.resolve(message.index);
      else job.reject(new Error('invalid rehearsal worker result'));
      armIdle(slot); pump();
    });
    slot.timer = setTimeout(() => fail(new Error('rehearsal worker startup timeout')), timeoutMs);
    slot.timer.unref?.();
    try { child.send({ type: 'init', data }, (error) => { if (error) fail(error); }); }
    catch (error) { fail(error); }
    return slot;
  }
  function pump() {
    if (closed || disabled) return;
    while (queue.length) {
      let slot = [...slots].find((s) => s.ready && !s.job);
      if (!slot) {
        for (const starting of slots) if (!starting.ready) { starting.child.ref(); starting.child.channel?.ref(); }
        if (slots.size < size) {
          try { spawn(); } catch (error) {
            disabled = true;
            for (const job of queue.splice(0)) job.reject(error);
          }
        }
        return;
      }
      const job = queue.shift();
      if (job.cancelled) continue;
      clearTimeout(slot.idle); slot.job = job; job.slot = slot;
      slot.child.ref(); slot.child.channel?.ref();
      slot.timer = setTimeout(() => retire(slot, new Error('rehearsal worker job timeout')), timeoutMs);
      slot.timer.unref?.();
      try { slot.child.send({ type: 'run', id: job.id, ...job.payload }, (error) => { if (error) retire(slot, error); }); }
      catch (error) { retire(slot, error); }
    }
  }
  return {
    data,
    warm() {
      if (closed || disabled || !size || slots.size) return;
      try { spawn(); } catch { disabled = true; }
    },
    submit(payload) {
      if (closed || disabled || !size || queue.length >= 128) return null;
      const job = { id: ++sequence, payload, cancelled: false, slot: null, resolve: null, reject: null };
      const promise = new Promise((resolve, reject) => { job.resolve = resolve; job.reject = reject; });
      // Cancellation may precede the consumer installing its continuation.
      promise.catch(() => {});
      if (payload.kind === 'headless') {
        const firstPreview = queue.findIndex(queued => queued.payload.kind !== 'headless');
        queue.splice(firstPreview < 0 ? queue.length : firstPreview, 0, job);
      } else queue.push(job);
      pump();
      return { promise, cancel() {
        if (job.cancelled) return;
        job.cancelled = true;
        const index = queue.indexOf(job);
        if (index >= 0) queue.splice(index, 1);
        if (job.slot?.job === job) retire(job.slot, new Error('rehearsal cancelled'));
        else job.reject(new Error('rehearsal cancelled'));
      } };
    },
    stats() { return { workers: slots.size, running: [...slots].filter(s => s.job).length, queued: queue.length, capacity: size, disabled }; },
    close() {
      closed = true;
      for (const job of queue.splice(0)) job.reject(new Error('rehearsal pool closed'));
      for (const slot of [...slots]) retire(slot);
    },
  };
}
