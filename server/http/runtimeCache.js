// Content-addressed browser runtime. One catalog per process; verified buffers are bounded by bytes.
// HTML import maps pin the entire ESM graph without rewriting source or changing relative import semantics.
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const RUNTIME_QUERY = 'rv';
const HASH = /^[a-f0-9]{64}$/;
const MAX_RAW_BYTES = 32 << 20;
const MAX_RAW_FILE = 16 << 20;
const IMPORT_MAP = /<script\b(?=[^>]*\btype\s*=\s*["']importmap["'])[^>]*>([\s\S]*?)<\/script\s*>/i;
const digest = (body) => createHash('sha256').update(body).digest('hex');
const encodePath = (url) => url.split('/').map(encodeURIComponent).join('/');

export class RuntimeCache {
  constructor({ publicDir, dataDir, sharedDir, simDir, shimBody, manifestSource = null, enabled = process.env.SP_HTTP_RUNTIME_CACHE !== '0' }) {
    this.enabled = enabled;
    this.shimBody = shimBody;
    this.manifestSource = manifestSource;
    this.roots = [
      ['/js/', path.join(publicDir, 'js'), new Set(['.js', '.mjs'])],
      ['/css/', path.join(publicDir, 'css'), new Set(['.css'])],
      ['/vendor/', path.join(publicDir, 'vendor'), new Set(['.js', '.mjs', '.css'])],
      ['/data/', dataDir, new Set(['.json'])],
      ['/shared/', sharedDir, new Set(['.js', '.mjs'])],
      ['/sim/', simDir, new Set(['.js'])],
    ];
    this.pending = null;
    this.buffers = new Map(); this.inflight = new Map(); this.bytes = 0;
    this.html = null;
  }

  async snapshot() {
    if (!this.pending) this.pending = this.scan().catch((error) => { this.pending = null; throw error; });
    return this.pending;
  }

  async scan() {
    // Fix the provider's first generation before hashing any served manifest. Otherwise a raw-file
    // rv from the startup window could later name a different, rewritten HTTP body.
    await this.manifestSource?.ready();
    const entries = new Map();
    let manifestBytes = 0;
    const add = async (url, absPath) => {
      const stat = await fsp.stat(absPath);
      const manifest = this.manifestSource && (url === '/data/assets.json' || url === '/data/local-assets.json');
      const view = manifest ? await this.manifestSource.get(url.slice('/data/'.length)) : null;
      const raw = view?.body ? Buffer.from(view.body) : await fsp.readFile(absPath);
      if (manifest) {
        manifestBytes += raw.length;
        if (raw.length > MAX_RAW_FILE || manifestBytes > MAX_RAW_BYTES) throw new Error('Runtime manifest snapshot exceeds byte limit');
      }
      entries.set(url, { url: encodePath(url), absPath, hash: digest(raw), size: stat.size, mtimeMs: stat.mtimeMs,
        ...(manifest ? { frozenBody: raw } : {}) });
    };
    const walk = async (prefix, dir, extensions) => {
      const files = await fsp.readdir(dir, { withFileTypes: true }).catch((error) => {
        if (error.code === 'ENOENT') return [];
        throw error;
      });
      files.sort((a, b) => a.name.localeCompare(b.name, 'en'));
      for (const file of files) {
        if (file.name.startsWith('.') || file.name.endsWith('~') || file.isSymbolicLink()) continue;
        const url = prefix + file.name;
        if (file.isDirectory()) await walk(url + '/', path.join(dir, file.name), extensions);
        else if (file.isFile() && extensions.has(path.extname(file.name).toLowerCase())
          && url !== '/js/asset-cache-worker.js' && !(url.startsWith('/sim/') && file.name.toLowerCase() === 'nodedata.js')) {
          await add(url, path.join(dir, file.name));
        }
      }
    };
    // A serial scan bounds open files and temporary read buffers, including the large data manifests.
    for (const [prefix, dir, extensions] of this.roots) await walk(prefix, dir, extensions);
    entries.set('/data.js', { url: '/data.js', absPath: null, hash: digest(this.shimBody), size: this.shimBody.length });
    const imports = {};
    for (const entry of entries.values()) imports[entry.url] = `${entry.url}?${RUNTIME_QUERY}=${entry.hash}`;
    return { entries, imports };
  }

  async version(decoded, query) {
    const params = new URLSearchParams(query);
    if (!params.has(RUNTIME_QUERY)) return null;
    if (!this.enabled || params.getAll(RUNTIME_QUERY).length !== 1 || !HASH.test(params.get(RUNTIME_QUERY))) return false;
    const state = await this.snapshot();
    const entry = state.entries.get(decoded);
    return entry && entry.hash === params.get(RUNTIME_QUERY) ? entry : false;
  }

  /** Never serve changed bytes under an old immutable URL: hash on first read, then reuse only the verified copy. */
  async body(entry, stat) {
    if (!entry.absPath) return this.shimBody;
    // Only these exact bytes belong to the page's rv. An asset-index rescan may replace the
    // unversioned view, but never the immutable manifest of an already pinned page.
    if (entry.frozenBody) return entry.frozenBody;
    if (stat.size !== entry.size || stat.mtimeMs !== entry.mtimeMs) return null;
    const hit = this.buffers.get(entry.hash);
    if (hit) { this.buffers.delete(entry.hash); this.buffers.set(entry.hash, hit); return hit; }
    if (this.inflight.has(entry.hash)) return this.inflight.get(entry.hash);
    const pending = (async () => {
      const raw = await fsp.readFile(entry.absPath);
      if (digest(raw) !== entry.hash) return null;
      if (raw.length <= MAX_RAW_FILE && raw.length <= MAX_RAW_BYTES) {
        this.buffers.set(entry.hash, raw); this.bytes += raw.length;
        for (const [key, value] of this.buffers) {
          if (this.bytes <= MAX_RAW_BYTES) break;
          this.buffers.delete(key); this.bytes -= value.length;
        }
      }
      return raw;
    })().finally(() => this.inflight.delete(entry.hash));
    this.inflight.set(entry.hash, pending);
    return pending;
  }

  /** Return null for ordinary fixture / custom HTML without an app import map. */
  async renderIndex(absPath) {
    if (!this.enabled) return null;
    if (!this.html) this.html = (async () => {
      const source = await fsp.readFile(absPath, 'utf8');
      const match = IMPORT_MAP.exec(source);
      if (!match) return null;
      const map = JSON.parse(match[1]);
      if (!map.imports || typeof map.imports !== 'object' || Array.isArray(map.imports)) return null;
      const state = await this.snapshot();
      const imports = { ...map.imports, ...state.imports };
      for (const [key, value] of Object.entries(map.imports)) {
        if (typeof value === 'string' && state.imports[value]) imports[key] = state.imports[value];
      }
      const text = JSON.stringify({ ...map, imports }).replace(/</g, '\\u003c');
      const rendered = source.replace(IMPORT_MAP, `<script type="importmap">${text}</script>`)
        .replace(/\b(src|href)\s*=\s*(["'])(\/[^"'<>]*)\2/g, (whole, attr, quote, url) =>
          state.imports[url] ? `${attr}=${quote}${state.imports[url]}${quote}` : whole);
      const body = Buffer.from(rendered);
      return { body, tag: `runtime-html-${digest(body)}` };
    })().catch((error) => { this.html = null; throw error; });
    return this.html;
  }
}
