// Test-only TCP bridge: delay each direction independently while retaining byte order, including upgrades.
import net from 'node:net';
import { performance } from 'node:perf_hooks';

export async function latencyProxy(targetPort) {
  let uploadMs = 0, downloadMs = 0;
  const peers = new Set();
  const server = net.createServer((socket) => {
    const upstream = net.connect({ host: '127.0.0.1', port: targetPort });
    const timers = new Set();
    const peer = { socket, upstream };
    peers.add(peer);
    socket.setNoDelay(true); upstream.setNoDelay(true);
    const forward = (source, target, latency) => {
      let due = 0;
      const schedule = (fn) => {
        due = Math.max(due, performance.now() + latency());
        const timer = setTimeout(() => { timers.delete(timer); if (!target.destroyed) fn(); }, Math.max(0, due - performance.now()));
        timers.add(timer);
      };
      source.on('data', (data) => schedule(() => target.write(data)));
      source.on('end', () => schedule(() => target.end()));
    };
    forward(socket, upstream, () => uploadMs);
    forward(upstream, socket, () => downloadMs);
    const close = () => {
      for (const timer of timers) clearTimeout(timer);
      timers.clear(); peers.delete(peer); socket.destroy(); upstream.destroy();
    };
    socket.on('error', close); upstream.on('error', close);
    socket.on('close', close); upstream.on('close', close);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { port: server.address().port,
    delay: (upload, download) => { uploadMs = upload; downloadMs = download; },
    close: () => new Promise(resolve => {
      for (const peer of peers) { peer.socket.destroy(); peer.upstream.destroy(); }
      server.close(resolve);
    }),
  };
}
