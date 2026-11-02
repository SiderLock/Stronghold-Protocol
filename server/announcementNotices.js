// server/announcementNotices.js — explicit online fan-out, independent from ordinary publication.
// commands/<UUID>.json is immutable. The live monitor is read-only: each server process consumes its own copy.
// Only enqueue prunes expired, valid UUID commands, under a short filesystem lock shared by CLI processes.
// i18n-ignore-file: filesystem administration errors and operator logs, never player-facing UI text

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { isAnnouncementId, isAnnouncementRevision } from '../shared/announcements.js';
import {
  ANNOUNCEMENT_NOTICE_TYPE, ANNOUNCEMENT_NOTICE_TTL_MS, ANNOUNCEMENT_NOTICE_POLL_MS,
  ANNOUNCEMENT_NOTICE_MAX_COMMAND_BYTES, isAnnouncementNoticeId, readAnnouncementNoticeCommand,
} from '../shared/announcementNotices.js';
import { send } from './net.js';

export const ANNOUNCEMENT_NOTICE_COMMAND_DIR = 'commands';
const LOCK_FILE = '.notice.write.lock';
const decoder = new TextDecoder('utf-8', { fatal: true });
const commandId = (name) => name.endsWith('.json') && isAnnouncementNoticeId(name.slice(0, -5)) ? name.slice(0, -5) : null;

function verifyDirectory(dir) {
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('通知命令目录必须为真实目录，不能使用符号链接');
}

/** IO failures can be retried; immutable malformed/unsafe files cannot be legitimate partial commands. */
function readCommandFile(file) {
  let bytes;
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > ANNOUNCEMENT_NOTICE_MAX_COMMAND_BYTES) {
      return { invalid: true, error: new Error('通知命令不是普通小文件或使用了符号链接') };
    }
    bytes = fs.readFileSync(file);
    if (bytes.length > ANNOUNCEMENT_NOTICE_MAX_COMMAND_BYTES) return { invalid: true, error: new Error('通知命令超过大小限制') };
  } catch (error) { return { invalid: false, error }; }
  try {
    const command = readAnnouncementNoticeCommand(JSON.parse(decoder.decode(bytes)));
    if (!command) return { invalid: true, error: new Error('通知命令格式无效') };
    return { command };
  } catch (error) { return { invalid: true, error }; }
}

function atomicWriteCommand(file, command) {
  const temp = path.join(path.dirname(file), `.tmp-${randomUUID()}`);
  let fd;
  let failure;
  try {
    fd = fs.openSync(temp, 'wx', 0o600);
    fs.writeFileSync(fd, Buffer.from(`${JSON.stringify(command)}\n`, 'utf8'));
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    fs.renameSync(temp, file);
  } catch (error) { failure = error; }
  finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch (error) { failure ||= error; } }
    try { fs.unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') failure ||= error; }
  }
  if (failure) throw failure;
}

async function acquireLock(dir) {
  const lock = path.join(dir, LOCK_FILE);
  const deadline = Date.now() + 3000;
  while (true) {
    try { return { fd: fs.openSync(lock, 'wx', 0o600), lock }; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (Date.now() >= deadline) throw new Error(`通知目录仍在更新；若上次命令异常中止，请检查并移除 ${LOCK_FILE} 后重试`, { cause: error });
      await delay(20);
    }
  }
}

/** No broad directory deletion: only expired valid commands with a matching UUID regular-file basename. */
function pruneExpiredCommands(dir, now, log) {
  for (const name of fs.readdirSync(dir)) {
    const msgid = commandId(name);
    if (!msgid) continue;
    const file = path.join(dir, name);
    const { command } = readCommandFile(file);
    if (!command || command.msgid !== msgid || command.expiresAt > now) continue;
    try { fs.unlinkSync(file); }
    catch (error) { if (error.code !== 'ENOENT') log.warn?.(`[announcement-notices] 过期命令 ${msgid} 清理失败：${error.message}`); }
  }
}

/**
 * Queue one explicit notice, never implicitly called by publish/pin. Success means written, not acknowledged.
 * @param {{ store: import('./announcements.js').AnnouncementStore, id: string, now?: () => number,
 *   log?: { warn?: Function } }} deps
 */
export async function enqueueAnnouncementNotice({ store, id, now = Date.now, log = console }) {
  if (!isAnnouncementId(id)) throw new Error('公告 ID 无效');
  const first = store.read(id);
  if (!first || !isAnnouncementRevision(first.revision)) throw new Error(`公告 ${id} 不存在或正文不可读取，未提交通知`);
  const dir = path.join(store.dir, ANNOUNCEMENT_NOTICE_COMMAND_DIR);
  fs.mkdirSync(dir, { recursive: true }); verifyDirectory(dir);
  const { fd, lock } = await acquireLock(dir);
  try {
    verifyDirectory(dir);
    const item = store.read(id);
    if (!item || !isAnnouncementRevision(item.revision)) throw new Error(`公告 ${id} 不存在或正文不可读取，未提交通知`);
    const createdAt = now();
    const command = readAnnouncementNoticeCommand({ version: 1, id, revision: item.revision, msgid: randomUUID(), createdAt, expiresAt: createdAt + ANNOUNCEMENT_NOTICE_TTL_MS });
    if (!command) throw new Error('通知时间无效，未提交通知');
    pruneExpiredCommands(dir, createdAt, log);
    atomicWriteCommand(path.join(dir, `${command.msgid}.json`), command);
    return command;
  } finally { fs.closeSync(fd); fs.unlinkSync(lock); }
}

/**
 * Each process has an independent seen set: sharing a spool must notify players connected to every instance.
 * start snapshots old commands before polling. pollMs:0 lets tests drive polls without scheduling a timer.
 * @param {{ store: import('./announcements.js').AnnouncementStore,
 *   network: { conns: Map<any, { closing?: boolean }>, closed?: boolean },
 *   log?: { warn?: Function }, now?: () => number, pollMs?: number }} deps
 */
export function createAnnouncementNoticeMonitor({ store, network, log = console, now = Date.now, pollMs = ANNOUNCEMENT_NOTICE_POLL_MS }) {
  if (!Number.isSafeInteger(pollMs) || pollMs < 0) throw new Error('通知检查间隔无效');
  const dir = path.join(store.dir, ANNOUNCEMENT_NOTICE_COMMAND_DIR);
  const seen = new Set();
  const deliveredUntil = new Map();
  const warned = new Map();
  // Startup IDs remain only for one TTL. This prevents a removed/restored startup file from replaying while valid.
  let initialNames = new Set();
  let startedAt = 0;
  let started = false;
  let initialized = false;
  let closed = false;
  let scanning = false;
  let timer;

  function warn(key, error) {
    const text = String(error?.message || error);
    if (warned.get(key) !== text) { warned.set(key, text); log.warn?.(`[announcement-notices] ${key}: ${text}`); }
  }

  function names() {
    try { verifyDirectory(dir); return fs.readdirSync(dir).filter((name) => commandId(name)).sort(); }
    catch (error) {
      if (error.code === 'ENOENT') return [];
      warn('命令目录读取失败', error);
      return null;
    }
  }

  function initialize() {
    const current = names();
    if (!current) return false;
    initialNames = new Set(current);
    for (const name of current) seen.add(name);
    initialized = true;
    return true;
  }

  function poll() {
    if (!started || closed || scanning || network.closed) return 0;
    scanning = true;
    try {
      if (!initialized) { initialize(); return 0; }
      const current = names();
      if (!current) return 0;
      const currentNames = new Set(current);
      for (const name of seen) if (!currentNames.has(name)) seen.delete(name);
      for (const key of warned.keys()) if (commandId(key) && !currentNames.has(key)) warned.delete(key);
      const time = now();
      for (const [msgid, expiresAt] of deliveredUntil) if (expiresAt <= time) deliveredUntil.delete(msgid);
      if (time >= startedAt + ANNOUNCEMENT_NOTICE_TTL_MS) initialNames.clear();
      const pending = [];
      for (const name of current) {
        if (seen.has(name)) continue;
        if (initialNames.has(name)) { seen.add(name); continue; }
        if (deliveredUntil.has(commandId(name))) { seen.add(name); continue; }
        const { command, error, invalid } = readCommandFile(path.join(dir, name));
        if (!command) {
          if (error?.code !== 'ENOENT') warn(name, error);
          if (invalid) seen.add(name);
          continue;
        }
        if (command.msgid !== commandId(name)) { warn(name, '命令编号与文件名不一致'); seen.add(name); continue; }
        if (command.createdAt < startedAt || command.expiresAt <= time) { seen.add(name); continue; }
        if (command.createdAt > time) continue;
        pending.push({ name, command });
      }
      pending.sort((a, b) => a.command.createdAt - b.command.createdAt || a.name.localeCompare(b.name));
      let broadcast = 0;
      for (const { name, command } of pending) {
        let item;
        try { item = store.read(command.id); }
        catch (error) { warn(name, error); continue; }
        if (!item) { warn(name, '引用公告暂不可读取；有效期内重试'); continue; }
        // A broken new catalog can temporarily expose the old store cache, especially after storage recreation.
        // Never send the wrong version, and keep retrying the immutable command until its TTL instead of losing it.
        if (item.revision !== command.revision) { warn(name, '引用公告版本不一致；有效期内重试'); continue; }
        const frame = { t: ANNOUNCEMENT_NOTICE_TYPE, id: command.id, revision: command.revision,
          msgid: command.msgid, createdAt: command.createdAt, expiresAt: command.expiresAt };
        seen.add(name); // mark before fan-out, including a command received when no clients are connected
        deliveredUntil.set(command.msgid, command.expiresAt);
        for (const [ws, conn] of network.conns) if (!conn?.closing) send(ws, frame);
        broadcast++;
      }
      return broadcast;
    } finally { scanning = false; }
  }

  const monitor = {
    start() {
      if (started || closed) return monitor;
      startedAt = now(); started = true;
      initialize();
      if (pollMs > 0) { timer = setInterval(poll, pollMs); timer.unref?.(); }
      return monitor;
    },
    poll,
    close() {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      seen.clear(); deliveredUntil.clear(); warned.clear(); initialNames.clear();
    },
  };
  return monitor;
}
