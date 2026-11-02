// server/announcements.js — live ordinary announcements, stored outside the served source tree.
// runtime/announcements/index.json + <id>.md by default; SP_ANNOUNCEMENTS_DIR can name persistent storage.
// The small index is checked on every request. Bodies are read on demand and verified against their index hash.
// Publishing commits the body first, then atomically replaces the index; readers never see a half-written index.
// Deletion commits the index first, then removes that body; shared assets remain independently managed.

import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { TextDecoder } from 'node:util';
import {
  ANNOUNCEMENT_INDEX_FILE, ANNOUNCEMENT_MAX_TITLE_LENGTH, ANNOUNCEMENT_MAX_BODY_CHARS, ANNOUNCEMENT_MAX_BODY_BYTES,
  ANNOUNCEMENT_MAX_INDEX_BYTES, ANNOUNCEMENT_MAX_ITEMS, isAnnouncementId, isAnnouncementTitle, isAnnouncementPublishedAt, readAnnouncementIndex,
} from '../shared/announcements.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INDEX_VERSION = 1;
const LOCK_FILE = '.write.lock';
const decoder = new TextDecoder('utf-8', { fatal: true });
const emptyIndex = () => ({ version: INDEX_VERSION, revision: '', pinnedId: null, items: [] });
const metadataOf = ({ id, title, publishedAt, revision }) => ({ id, title, publishedAt, revision });
const hashOf = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Explicit option, environment, then <root>/runtime/announcements. Relative paths resolve from root. */
export function announcementDirectory({ dir, root = ROOT, env = process.env } = {}) {
  return path.resolve(root, dir || env.SP_ANNOUNCEMENTS_DIR || path.join('runtime', 'announcements'));
}

/** Reject file symlinks, directories and oversized input before reading any contents. */
function readSmallFile(file, limit) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('必须为普通文件，不能使用符号链接');
  if (stat.size > limit) throw new Error(`文件超过 ${limit} 字节限制`);
  const bytes = fs.readFileSync(file);
  if (bytes.length > limit) throw new Error(`文件超过 ${limit} 字节限制`);
  return bytes;
}

/** A temporary file in the destination directory, flushed before rename. No partial target is ever exposed. */
function atomicWrite(file, bytes) {
  const temp = path.join(path.dirname(file), `.tmp-${randomUUID()}`);
  let fd;
  let failure;
  try {
    fd = fs.openSync(temp, 'wx', 0o600);
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    fs.renameSync(temp, file);
  } catch (e) {
    failure = e;
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch (e) { failure ||= e; } }
    try { fs.unlinkSync(temp); } catch (e) { if (e.code !== 'ENOENT') failure ||= e; }
  }
  if (failure) throw failure;
}

function validDiskIndex(raw) {
  const publicIndex = readAnnouncementIndex(raw);
  if (!publicIndex || raw.version !== INDEX_VERSION) throw new Error('公告索引格式无效');
  for (const item of raw.items) {
    if (!Number.isSafeInteger(item.bytes) || item.bytes < 1 || item.bytes > ANNOUNCEMENT_MAX_BODY_BYTES
      || typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256)) throw new Error('公告正文校验信息无效');
  }
  return { ...publicIndex, version: INDEX_VERSION, items: raw.items.map((item) => ({ ...metadataOf(item), bytes: item.bytes, sha256: item.sha256 })) };
}

function normalizeMarkdown(markdown) {
  if (typeof markdown !== 'string') throw new Error('公告正文必须为 Markdown 文本');
  const text = markdown.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  if (!text.trim()) throw new Error('公告正文不能为空');
  if (text.length > ANNOUNCEMENT_MAX_BODY_CHARS) throw new Error(`公告正文不能超过 ${ANNOUNCEMENT_MAX_BODY_CHARS} 字符（UTF-16）`);
  if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(text)) throw new Error('公告正文不能包含控制字符');
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length > ANNOUNCEMENT_MAX_BODY_BYTES) throw new Error(`公告正文不能超过 ${ANNOUNCEMENT_MAX_BODY_BYTES} 字节`);
  return { text, bytes };
}

/** Read an explicitly selected UTF-8 Markdown file for the publishing tool, never by a client-supplied path. */
export function readAnnouncementMarkdown(file) {
  if (path.extname(file).toLowerCase() !== '.md') throw new Error('发布正文文件必须使用 .md 扩展名');
  return normalizeMarkdown(decoder.decode(readSmallFile(file, ANNOUNCEMENT_MAX_BODY_BYTES))).text;
}

export class AnnouncementStore {
  /** @param {{ dir?: string, root?: string, log?: { warn?: Function }, env?: object }} [opts] */
  constructor(opts = {}) {
    this.dir = announcementDirectory(opts);
    this.log = opts.log || console;
    this.state = emptyIndex();
    this.source = null;
    this.loaded = false;
    this.warned = new Set();
    this.bodies = new Map();
  }

  warn(key, error) {
    const line = `[announcements] ${key}: ${error?.message || error}`;
    if (!this.warned.has(line)) { this.warned.add(line); this.log.warn?.(line); }
  }

  load(strict = false) {
    try {
      let bytes;
      try { bytes = readSmallFile(path.join(this.dir, ANNOUNCEMENT_INDEX_FILE), ANNOUNCEMENT_MAX_INDEX_BYTES); }
      catch (e) {
        if (e.code !== 'ENOENT' || (this.loaded && this.state.items.length)) throw e;
        this.loaded = true;
        return this.state;
      }
      const source = decoder.decode(bytes).replace(/^\uFEFF/, '');
      if (source === this.source && !strict) return this.state;
      const next = validDiskIndex(JSON.parse(source));
      // Only metadata is read here. Every named body must be a regular file in this exact directory.
      for (const item of next.items) {
        const stat = fs.lstatSync(path.join(this.dir, `${item.id}.md`));
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== item.bytes) throw new Error(`公告 ${item.id} 的正文缺失或大小不符`);
        // Administration is rare: verify existing bodies before carrying them into a rewritten catalog.
        // HTTP reads keep bodies on demand instead of rescanning all Markdown on every request.
        if (strict) {
          const body = readSmallFile(path.join(this.dir, `${item.id}.md`), ANNOUNCEMENT_MAX_BODY_BYTES);
          if (hashOf(body) !== item.sha256) throw new Error(`公告 ${item.id} 的正文校验失败`);
          normalizeMarkdown(decoder.decode(body));
        }
      }
      this.state = next; this.source = source; this.loaded = true;
      const current = new Set(next.items.map((item) => `${item.id}:${item.revision}:${item.sha256}`));
      for (const key of this.bodies.keys()) if (!current.has(key)) this.bodies.delete(key);
      return this.state;
    } catch (e) {
      if (strict) throw new Error(`公告目录无效，未作修改：${e.message}`, { cause: e });
      this.warn('索引读取失败，保留上次有效内容', e); // i18n-ignore: operator log, not player-facing UI
      return this.state;
    }
  }

  /** Public metadata only; a missing directory is a successful empty list. */
  list() {
    const state = this.load();
    return { revision: state.revision, pinnedId: state.pinnedId, items: state.items.map(metadataOf) };
  }

  /** Metadata plus verified Markdown, or null for an unknown/invalid/unreadable ID. */
  read(id) {
    if (!isAnnouncementId(id)) return null;
    const item = this.load().items.find((entry) => entry.id === id);
    if (!item) return null;
    const key = `${id}:${item.revision}:${item.sha256}`;
    try {
      const bytes = readSmallFile(path.join(this.dir, `${id}.md`), ANNOUNCEMENT_MAX_BODY_BYTES);
      if (bytes.length !== item.bytes || hashOf(bytes) !== item.sha256) throw new Error('正文与索引校验信息不符');
      const markdown = decoder.decode(bytes);
      normalizeMarkdown(markdown);
      const body = { ...metadataOf(item), markdown };
      this.bodies.set(key, body);
      return { ...body };
    } catch (e) {
      this.warn(`公告 ${id} 读取失败，保留已加载的有效正文`, e); // i18n-ignore: operator log, not player-facing UI
      const cached = this.bodies.get(key);
      return cached ? { ...cached } : null;
    }
  }

  mutate(action) {
    fs.mkdirSync(this.dir, { recursive: true });
    const lock = path.join(this.dir, LOCK_FILE);
    let fd;
    try { fd = fs.openSync(lock, 'wx', 0o600); }
    catch (e) {
      if (e.code === 'EEXIST') throw new Error(`公告目录正在更新；若上次发布异常中止，请检查并移除 ${LOCK_FILE} 后重试`, { cause: e });
      throw e;
    }
    try { return action(this.load(true)); }
    finally { fs.closeSync(fd); fs.unlinkSync(lock); }
  }

  writeIndex(next) {
    const text = `${JSON.stringify(next, null, 2)}\n`;
    if (Buffer.byteLength(text, 'utf8') > ANNOUNCEMENT_MAX_INDEX_BYTES) throw new Error('公告索引已达到大小上限');
    atomicWrite(path.join(this.dir, ANNOUNCEMENT_INDEX_FILE), Buffer.from(text, 'utf8'));
    this.state = next; this.source = text; this.loaded = true;
  }

  /** Each publication is immutable and obtains a new persistent revision. Pinning is optional. */
  publish({ id, title, markdown, publishedAt = new Date().toISOString(), pin = false }) {
    if (id === undefined) id = `ann-${Date.now().toString(36)}-${randomUUID().slice(0, 12)}`;
    if (!isAnnouncementId(id)) throw new Error('公告 ID 只能使用小写字母、数字、下划线和连字符，长度 1–64，且不能使用设备名');
    if (typeof title === 'string') title = title.trim();
    if (!isAnnouncementTitle(title)) throw new Error(`公告标题不能为空、包含控制字符或超过 ${ANNOUNCEMENT_MAX_TITLE_LENGTH} 字符`);
    const date = new Date(publishedAt);
    if (typeof publishedAt !== 'string' || !Number.isFinite(date.getTime())) throw new Error('公告发布时间无效');
    publishedAt = date.toISOString();
    if (!isAnnouncementPublishedAt(publishedAt)) throw new Error('公告发布时间须使用 0000–9999 年范围');
    const { bytes } = normalizeMarkdown(markdown);
    return this.mutate((state) => {
      if (state.items.length >= ANNOUNCEMENT_MAX_ITEMS) throw new Error(`公告历史已达到 ${ANNOUNCEMENT_MAX_ITEMS} 条限制`);
      if (state.items.some((item) => item.id === id)) throw new Error(`公告 ID ${id} 已存在；发布新内容请使用新 ID`);
      const file = path.join(this.dir, `${id}.md`);
      try {
        fs.lstatSync(file);
        throw new Error(`公告正文 ${id}.md 已存在，未覆盖`);
      } catch (e) { if (e.code !== 'ENOENT') throw e; }
      const item = { id, title, publishedAt, revision: `pub-${Date.now().toString(36)}-${randomUUID()}`, bytes: bytes.length, sha256: hashOf(bytes) };
      const next = { version: INDEX_VERSION, revision: item.revision, pinnedId: pin ? id : state.pinnedId, items: [item, ...state.items] };
      // Commit the body before making it visible. If index replacement fails, this unpublished body can be retried
      // after removing it; retaining it is safer than masking a filesystem failure with a second write.
      atomicWrite(file, bytes);
      this.writeIndex(next);
      return metadataOf(item);
    });
  }

  /** The sole pinned ID changes without changing publication revision. */
  pin(id) {
    if (!isAnnouncementId(id)) throw new Error('公告 ID 无效');
    return this.mutate((state) => {
      if (!state.items.some((item) => item.id === id)) throw new Error(`找不到公告 ${id}`);
      this.writeIndex({ ...state, pinnedId: id });
      return this.list();
    });
  }

  unpin() {
    return this.mutate((state) => {
      this.writeIndex({ ...state, pinnedId: null });
      return this.list();
    });
  }

  /** Remove an announcement without creating a new publication or changing suppression preferences. */
  remove(id) {
    if (!isAnnouncementId(id)) throw new Error('公告 ID 无效');
    return this.mutate((state) => {
      const item = state.items.find((entry) => entry.id === id);
      if (!item) throw new Error(`找不到公告 ${id}`);
      // Make deletion visible atomically before touching its body. A failed index replacement must leave the
      // old publication intact; shared images and the publisher's original Markdown draft are never touched.
      this.writeIndex({ ...state, pinnedId: state.pinnedId === id ? null : state.pinnedId,
        items: state.items.filter((entry) => entry.id !== id) });
      for (const key of this.bodies.keys()) if (key.startsWith(`${id}:`)) this.bodies.delete(key);
      try { fs.unlinkSync(path.join(this.dir, `${id}.md`)); }
      catch (e) {
        if (e.code !== 'ENOENT') this.warn(`公告 ${id} 已从索引删除，但正文文件 ${id}.md 未能清理`, e); // i18n-ignore: operator log, not player-facing UI
      }
      return metadataOf(item);
    });
  }
}

/** The server and publishing tool share one store implementation. */
export function createAnnouncementStore(opts = {}) { return new AnnouncementStore(opts); }
