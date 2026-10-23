// One scene-preparation worker per page. ArrayBuffers transfer both ways; renderer/texture objects stay on the page.
let worker = null, disabled = false, sequence = 0;
const pending = new Map();

function stop(disable) {
  worker?.terminate(); worker = null; disabled = disable;
  for (const job of pending.values()) { clearTimeout(job.timer); job.resolve(null); }
  pending.clear();
}

export function resetSceneWorker() { stop(false); }

/** Moves ownership of buffer. On failure the caller refetches only if it was already detached. */
export function prepareSceneInWorker(doc, buffer, areas) {
  if (disabled || typeof Worker !== 'function') return Promise.resolve(null);
  if (!worker) {
    try {
      worker = new Worker(new URL('./sceneWorker.js', import.meta.url), { type: 'module' });
      worker.onmessage = ({ data }) => {
        const job = pending.get(data?.id);
        if (!job) return;
        pending.delete(data.id); clearTimeout(job.timer);
        if (data.error) console.warn('[board3d] scene preparation failed', data.error);
        job.resolve(data.value || null);
      };
      worker.onerror = (event) => { console.warn('[board3d] scene worker unavailable', event.message); stop(true); };
      worker.onmessageerror = () => stop(true);
    } catch (err) { console.warn('[board3d] scene worker unavailable', err?.message); stop(true); return Promise.resolve(null); }
  }
  return new Promise((resolve) => {
    const id = ++sequence;
    const timer = setTimeout(() => { console.warn('[board3d] scene preparation timed out'); stop(true); }, 5000);
    pending.set(id, { resolve, timer });
    try {
      worker.postMessage({ id, doc, buffer, areas }, [buffer]);
    } catch (err) { console.warn('[board3d] scene worker transfer failed', err?.message); stop(true); }
  });
}
