import '../../ui/compat.js';
import { parseSceneChunks, sceneGroupRects } from './load.js';
import { prepareSceneBuckets, sceneGeometryKey } from './sceneGeometry.js';

self.onmessage = ({ data: { id, doc, buffer, areas } }) => {
  try {
    const chunks = parseSceneChunks(doc, buffer);
    if (!chunks?.length) throw new Error(`invalid scene geometry (${buffer?.byteLength} bytes)`);
    const pack = { doc, chunks, groups: sceneGroupRects(chunks) };
    const buckets = prepareSceneBuckets(pack, areas);
    const value = { chunks, groups: pack.groups, prepared: { key: sceneGeometryKey(pack, areas), buckets } };
    const buffers = new Set([buffer]);
    for (const { chunk } of buckets) for (const v of Object.values(chunk)) if (ArrayBuffer.isView(v)) buffers.add(v.buffer);
    self.postMessage({ id, value }, [...buffers]);
  } catch (err) { self.postMessage({ id, value: null, error: String(err?.message || err).slice(0, 300) }); }
};
