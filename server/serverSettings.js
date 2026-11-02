// Private per-server settings. CLI writes replace one small file atomically; no HTTP administration endpoint.
// i18n-ignore-file: filesystem administration errors and operator logs, never player-facing UI text
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { MAX_SEATS } from '../shared/constants.js';
import { ROOT } from './http/config.js';

export const SERVER_SETTINGS_FILE = 'server-settings.json';
export const SERVER_SETTINGS_POLL_MS = 1000;
const MAX_FILE_BYTES = 4096;
const decoder = new TextDecoder('utf-8', { fatal: true });

/** null means no server restriction; available room seats still bound the AI count. */
export function validAiLimit(value) {
  return value === null || (Number.isInteger(value) && value >= 0 && value < MAX_SEATS);
}

/** Strict CLI/environment value: 0…MAX_SEATS-1 or "unlimited". */
export function parseAiLimit(value) {
  const text = String(value ?? '').trim();
  if (text === 'unlimited') return null;
  if (/^(?:0|[1-9]\d*)$/.test(text) && validAiLimit(Number(text))) return Number(text);
  throw new RangeError(`AI 上限必须为 0–${MAX_SEATS - 1} 的整数或 unlimited`);
}

export function parseAssetCacheRequirement(value) {
  const text = String(value ?? '').trim();
  if (text === 'required' || text === '1') return true;
  if (text === 'optional' || text === '0') return false;
  throw new RangeError('预缓存准入必须为 required / optional，环境变量也可使用 1 / 0');
}

/** Owner CLI rate in Mbps, persisted as bytes per second. `unlimited` is null. */
export function parseAssetCacheRate(value) {
  const text = String(value ?? '').trim().toLowerCase();
  if (text === 'unlimited') return null;
  if (!/^\d+(?:\.\d+)?$/.test(text)) throw new RangeError('素材在线限速必须为非负 Mbps 数值或 unlimited');
  const mbps = Number(text);
  const bytes = mbps * 125_000;
  if (!Number.isSafeInteger(bytes)) throw new RangeError('素材在线限速超出安全范围');
  return bytes;
}

function validAssetCacheRate(value) { return value === null || (Number.isSafeInteger(value) && value >= 0); }
export function validAssetCacheLimits(value) {
  return value === null || (value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every((key) => ['totalBps', 'clientBps'].includes(key))
    && validAssetCacheRate(value.totalBps) && validAssetCacheRate(value.clientBps)
    && !(value.clientBps === 0 && value.totalBps !== 0));
}

function initialAssetCacheLimits(env) {
  const total = String(env.SP_ASSET_CACHE_TOTAL_BPS ?? '').trim();
  const client = String(env.SP_ASSET_CACHE_CLIENT_BPS ?? '').trim();
  if (!total && !client) return null;
  const parsed = { totalBps: total ? parseAssetCacheByteRate(total) : null, clientBps: client ? parseAssetCacheByteRate(client) : null };
  if (parsed.clientBps === 0 && parsed.totalBps !== 0) throw new RangeError('素材在线单 IP 限速必须在总限速启用时为正数');
  return Object.freeze(parsed);
}

function parseAssetCacheByteRate(value) {
  const text = String(value ?? '').trim().toLowerCase();
  if (text === 'unlimited') return null;
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(Number(text))) throw new RangeError('素材在线限速必须为非负字节/秒整数或 unlimited');
  return Number(text);
}

export function initialServerSettings(env = process.env) {
  const ai = String(env.SP_MAX_AI_PER_ROOM ?? '').trim();
  const precache = String(env.SP_REQUIRE_ASSET_CACHE ?? '').trim();
  return Object.freeze({ maxAiPerRoom: ai ? parseAiLimit(ai) : null,
    requireAssetCache: precache ? parseAssetCacheRequirement(precache) : false,
    assetCacheLimits: initialAssetCacheLimits(env) });
}

/** Explicit option, environment, then <root>/runtime. Relative paths resolve from the repository root. */
export function serverSettingsDirectory({ dir, root = ROOT, env = process.env } = {}) {
  return path.resolve(root, dir || env.SP_SERVER_SETTINGS_DIR || 'runtime');
}

function verifyDirectory(dir) {
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('服务器配置目录必须为普通目录，不能使用符号链接');
}

function checkedSettings(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.version !== 1
    || Object.keys(raw).some((key) => !['version', 'maxAiPerRoom', 'requireAssetCache', 'assetCacheLimits', 'bandwidthEmergencyEnabled'].includes(key))
    || !validAiLimit(raw.maxAiPerRoom)
    || raw.requireAssetCache !== undefined && typeof raw.requireAssetCache !== 'boolean'
    || raw.assetCacheLimits !== undefined && !validAssetCacheLimits(raw.assetCacheLimits)
    || raw.bandwidthEmergencyEnabled !== undefined && typeof raw.bandwidthEmergencyEnabled !== 'boolean') throw new Error('服务器配置格式无效');
  // Existing version-1 AI-only files keep their former permissive admission policy.
  return Object.freeze({ maxAiPerRoom: raw.maxAiPerRoom, requireAssetCache: raw.requireAssetCache ?? false,
    assetCacheLimits: raw.assetCacheLimits ?? null,
    ...(raw.bandwidthEmergencyEnabled === undefined ? {} : { bandwidthEmergencyEnabled: raw.bandwidthEmergencyEnabled }) });
}

/** Read-only startup and show operations never create a directory. null means no persistent override. */
export function readServerSettings(dir) {
  try {
    verifyDirectory(dir);
    const file = path.join(dir, SERVER_SETTINGS_FILE);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('服务器配置必须为普通文件，不能使用符号链接');
    if (stat.size > MAX_FILE_BYTES) throw new Error(`服务器配置超过 ${MAX_FILE_BYTES} 字节限制`);
    const bytes = fs.readFileSync(file);
    if (bytes.length > MAX_FILE_BYTES) throw new Error(`服务器配置超过 ${MAX_FILE_BYTES} 字节限制`);
    return checkedSettings(JSON.parse(decoder.decode(bytes)));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

/** Patch only named settings; concurrent commands retain atomic last-writer-wins semantics. */
export function writeServerSettings(dir, value) {
  const patch = value && typeof value === 'object' && !Array.isArray(value) ? value : { maxAiPerRoom: value };
  if (Object.hasOwn(patch, 'maxAiPerRoom') && !validAiLimit(patch.maxAiPerRoom)) {
    throw new RangeError(`AI 上限必须为 0–${MAX_SEATS - 1} 的整数或 null`);
  }
  if (Object.hasOwn(patch, 'assetCacheLimits') && !validAssetCacheLimits(patch.assetCacheLimits)) {
    throw new RangeError('素材在线限速配置无效');
  }
  if (Object.hasOwn(patch, 'bandwidthEmergencyEnabled') && typeof patch.bandwidthEmergencyEnabled !== 'boolean') {
    throw new RangeError('带宽紧急保护开关必须为 on / off');
  }
  if (!Object.keys(patch).length || Object.keys(patch).some((key) => !['maxAiPerRoom', 'requireAssetCache', 'assetCacheLimits', 'bandwidthEmergencyEnabled'].includes(key))
    || Object.hasOwn(patch, 'requireAssetCache') && typeof patch.requireAssetCache !== 'boolean'
    || Object.hasOwn(patch, 'bandwidthEmergencyEnabled') && typeof patch.bandwidthEmergencyEnabled !== 'boolean') throw new Error('服务器配置字段无效');
  fs.mkdirSync(dir, { recursive: true });
  verifyDirectory(dir);
  const file = path.join(dir, SERVER_SETTINGS_FILE);
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('服务器配置必须为普通文件，不能使用符号链接');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  // A full, explicit replacement can repair malformed settings. A partial command refuses to
  // guess the other policy: in particular changing the AI ceiling must not silently remove strict admission.
  const previous = Object.hasOwn(patch, 'maxAiPerRoom') && Object.hasOwn(patch, 'requireAssetCache')
    ? null : readServerSettings(dir) || initialServerSettings();
  const next = checkedSettings({ version: 1, ...previous, ...patch });
  const temporary = path.join(dir, `.server-settings-${randomUUID()}.tmp`);
  let fd;
  let failure;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(fd, Buffer.from(`${JSON.stringify({ version: 1, ...next }, null, 2)}\n`, 'utf8'));
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    fs.renameSync(temporary, file);
  } catch (error) { failure = error; }
  finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch (error) { failure ||= error; } }
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') failure ||= error; }
  }
  if (failure) throw failure;
  return next;
}

/**
 * Valid persisted values win over the initial environment fallback. A malformed replacement keeps the last valid
 * policy, so a partial manual edit cannot silently disable a restriction. Removing the file explicitly restores
 * the startup fallback. onChange is not invoked while constructing the controller.
 * @param {{ dir?: string, root?: string, env?: object, log?: {warn?: Function}, pollMs?: number,
 *   onChange?: (next: {maxAiPerRoom:number|null, requireAssetCache:boolean, assetCacheLimits:object|null, bandwidthEmergencyEnabled?:boolean}, previous: object) => void }} [options]
 */
export function createServerSettings(options = {}) {
  const { env = process.env, log = console, pollMs = SERVER_SETTINGS_POLL_MS, onChange } = options;
  if (!Number.isSafeInteger(pollMs) || pollMs < 0) throw new RangeError('服务器配置检查间隔无效');
  const dir = serverSettingsDirectory({ ...options, env });
  const fallback = initialServerSettings(env);
  // Startup has no last-good disk value to preserve. Refuse corrupt persistent settings rather than accidentally
  // booting an unrestricted public server. Only replacement errors during an already-running process are tolerated.
  let state = readServerSettings(dir) || fallback;
  let warning = '';
  let timer;
  let closed = false;
  let started = false;

  function refresh(notify = true) {
    if (closed) return false;
    let next;
    try { next = readServerSettings(dir) || fallback; warning = ''; }
    catch (error) {
      const message = String(error.message || error);
      if (message !== warning) { log.warn?.(`[server-settings] ${message}；保留最近有效设置。`); warning = message; }
      return false;
    }
    if (next.maxAiPerRoom === state.maxAiPerRoom && next.requireAssetCache === state.requireAssetCache
      && JSON.stringify(next.assetCacheLimits) === JSON.stringify(state.assetCacheLimits)
      && next.bandwidthEmergencyEnabled === state.bandwidthEmergencyEnabled) return false;
    const previous = state;
    state = next;
    if (notify) onChange?.(state, previous);
    return true;
  }
  const controller = {
    dir,
    get: () => state,
    poll: () => refresh(),
    start() {
      if (closed || started) return controller;
      started = true;
      refresh();
      if (pollMs > 0) { timer = setInterval(() => refresh(), pollMs); timer.unref?.(); }
      return controller;
    },
    close() { closed = true; clearInterval(timer); },
  };
  return controller;
}
