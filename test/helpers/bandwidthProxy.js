// Test-only TCP bridge. Shares one outbound application-byte budget fairly across HTTP and WS connections.
// This models a bottleneck, not the cloud's packet scheduler or TLS/TCP overhead; inbound traffic is untouched.
import net from 'node:net';
import { performance } from 'node:perf_hooks';

export async function bandwidthProxy(targetPort) {
  const peers = new Set();
  let rate = 0; let tokens = 0; let last = performance.now(); let cursor = 0; let sent = 0; let peak = 0;
  const server = net.createServer((socket) => {
    const upstream = net.connect({ host: '127.0.0.1', port: targetPort });
    const peer = { socket, upstream, queue: [], bytes: 0, blocked: false, ended: false, closed: false };
    peers.add(peer); socket.setNoDelay(true); upstream.setNoDelay(true);
    socket.pipe(upstream);
    const resume = () => { if (!peer.blocked && peer.bytes < 32768 && !peer.ended) upstream.resume(); };
    socket.on('drain', () => { peer.blocked = false; resume(); });
    upstream.on('data', (chunk) => {
      if (!rate) { if (!socket.write(chunk)) { peer.blocked = true; upstream.pause(); } return; }
      peer.queue.push(chunk); peer.bytes += chunk.length;
      peak = Math.max(peak, [...peers].reduce((sum, p) => sum + p.bytes, 0));
      if (peer.bytes >= 65536) upstream.pause();
    });
    const close = () => {
      if (peer.closed) return;
      peer.closed = true; peers.delete(peer); peer.queue.length = 0; socket.destroy(); upstream.destroy();
    };
    // A completed HTTP upstream may close while its last bytes still await the shared budget.
    // Forward FIN after those bytes; destroying the downstream here would truncate a valid response.
    const end = () => { peer.ended = true; if (!peer.bytes && !socket.destroyed) socket.end(); };
    socket.on('error', close); upstream.on('error', close);
    socket.on('close', close); upstream.on('end', end);
    upstream.on('close', (hadError) => { if (hadError) close(); else end(); });
  });
  const timer = setInterval(() => {
    const now = performance.now();
    tokens = Math.min(rate * 0.1, tokens + rate * (now - last) / 1000); last = now;
    if (!rate || tokens < 1) return;
    const active = [...peers]; let idle = 0;
    while (tokens >= 1 && active.length && idle < active.length) {
      const peer = active[cursor++ % active.length];
      if (!peer.bytes || peer.blocked || peer.socket.destroyed) { idle++; continue; }
      idle = 0;
      const first = peer.queue[0]; const count = Math.min(1024, first.length, Math.floor(tokens));
      if (count === first.length) peer.queue.shift(); else peer.queue[0] = first.subarray(count);
      peer.bytes -= count; tokens -= count; sent += count;
      if (!peer.socket.write(first.subarray(0, count))) { peer.blocked = true; peer.upstream.pause(); }
      if (!peer.blocked && peer.bytes < 32768 && !peer.ended) peer.upstream.resume();
      if (!peer.bytes && peer.ended) peer.socket.end();
    }
  }, 20);
  timer.unref();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { port: server.address().port,
    limit: (bytesPerSecond) => {
      if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) throw new Error('test budget must be positive');
      rate = bytesPerSecond; tokens = 0; last = performance.now();
    },
    stats: () => ({ bytesPerSecond: rate, bytesSent: sent, peakQueuedBytes: peak, connections: peers.size }),
    close: () => new Promise((resolve) => {
      clearInterval(timer); for (const peer of peers) { peer.socket.destroy(); peer.upstream.destroy(); }
      peers.clear(); server.close(resolve);
    }),
  };
}
