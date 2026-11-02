// Private, disposable full-SHA cache. Never import this from a client catalog or trust a 16-hex URL hash.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const MAX_CACHE_BYTES = 64 * 1024 * 1024;
const MAX_ENTRIES = 200_000;
const SHA = /^[a-f0-9]{64}$/;

/** BigInt stats preserve nanosecond timestamps and inode identity across process restarts. */
export function assetFileStamp(stat) {
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.birthtimeNs].map(String).join(':');
}

export async function openAssetDigestCache(file, publicDir) {
  const root = path.resolve(publicDir);
  let previous = Object.create(null);
  if (file) {
    let handle;
    try {
      handle = await fsp.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_CACHE_BYTES) throw new Error('invalid digest cache');
      const saved = JSON.parse(await handle.readFile('utf8'));
      if (saved.schema === 1 && saved.root === root && saved.entries && typeof saved.entries === 'object'
        && !Array.isArray(saved.entries) && Object.keys(saved.entries).length <= MAX_ENTRIES) previous = saved.entries;
    } catch { /* Missing, malformed or unreadable caches use a full scan. */ }
    finally { await handle?.close(); }
  }
  const entries = Object.create(null);
  let count = 0;
  return {
    get(url, stat) {
      const hit = previous[url];
      if (!hit || !SHA.test(hit.sha256) || hit.stamp !== assetFileStamp(stat)
        || !Number.isSafeInteger(hit.bytes) || BigInt(hit.bytes) !== stat.size) return null;
      return { bytes: hit.bytes, sha256: hit.sha256 };
    },
    set(url, stat, digest) {
      if (file && count++ < MAX_ENTRIES) entries[url] = { stamp: assetFileStamp(stat), ...digest };
    },
    async save() {
      if (!file) return;
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        const body = JSON.stringify({ schema: 1, root, entries });
        if (Buffer.byteLength(body) > MAX_CACHE_BYTES) return;
        await fsp.mkdir(path.dirname(file), { recursive: true });
        await fsp.writeFile(temporary, body, { flag: 'wx', mode: 0o600 });
        await fsp.rename(temporary, file);
      } catch { /* A read-only/full disk must not make the usable catalog unavailable. */ }
      finally { await fsp.unlink(temporary).catch(() => {}); }
    },
  };
}
