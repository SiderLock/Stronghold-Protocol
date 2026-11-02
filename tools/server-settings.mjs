#!/usr/bin/env node
// Local server-owner administration; no server restart, public write endpoint or copied installation default.
// i18n-ignore-file: owner CLI usage and output, never player-facing UI text
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { parseAiLimit, parseAssetCacheRequirement, parseAssetCacheRate, initialServerSettings, readServerSettings,
  serverSettingsDirectory, writeServerSettings } from '../server/serverSettings.js';

const USAGE = `服务器配置（UTF-8）：
  node tools/server-settings.mjs ai-limit <整数|unlimited> [--dir <目录>]
  node tools/server-settings.mjs asset-cache <required|optional> [--dir <目录>]
  node tools/server-settings.mjs asset-cache-limit <总Mbps|unlimited> [单IPMbps|unlimited] [--dir <目录>]
  node tools/server-settings.mjs bandwidth-emergency <on|off> [--dir <目录>]
  node tools/server-settings.mjs show [--json] [--dir <目录>]
  默认目录：runtime；可用 SP_SERVER_SETTINGS_DIR 指定持久化目录。
  设置会持久保存，运行中的服务器约 1 秒内读取；AI 上限在对局结束后应用。
  asset-cache 默认 optional，required 限制新创建、加入、最快匹配和观战；不踢出现有成员或阻止续玩。
  asset-cache-limit 默认 unlimited；例如 8 4 表示总 8 Mbps、单 IP 4 Mbps，unlimited unlimited 恢复无限制。
  bandwidth-emergency 默认 off；关闭时完全停止带宽采样、需求/拥堵读取和定时器；运行中的服务器约 1 秒内读取。
  修改一个设置保留另一个；SP_MAX_AI_PER_ROOM / SP_REQUIRE_ASSET_CACHE 仅作无持久配置时的启动默认值。`;
const writeUtf8 = (stream, value) => stream.write(Buffer.from(`${value}\n`, 'utf8'));

/** Interactive Windows cmd uses UTF-8 too; redirected output always remains explicit UTF-8. */
export function prepareServerSettingsConsole({ platform = process.platform, stdout = process.stdout, stderr = process.stderr, run = spawnSync } = {}) {
  if (platform !== 'win32' || (!stdout.isTTY && !stderr.isTTY)) return;
  try { run('cmd.exe', ['/d', '/c', 'chcp', '65001'], { stdio: 'ignore', windowsHide: true, timeout: 1000 }); }
  catch { /* A missing console utility never prevents server administration. */ }
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!command || command === '--help' || command === '-h') return { command: 'help' };
  if (!['ai-limit', 'asset-cache', 'asset-cache-limit', 'bandwidth-emergency', 'show'].includes(command)) throw new Error(`未知命令 ${command}`);
  const options = { command, dir: undefined, json: false, value: undefined, clientValue: undefined };
  const seen = new Set();
  for (let index = 0; index < rest.length; index++) {
    const token = rest[index];
    if (!token.startsWith('--')) {
      if (command === 'show' || options.value !== undefined && command !== 'asset-cache-limit'
        || command === 'asset-cache-limit' && options.clientValue !== undefined) throw new Error(`不支持的参数 ${token}`);
      if (command === 'ai-limit') options.value = parseAiLimit(token);
      else if (command === 'asset-cache') options.value = parseAssetCacheRequirement(token);
      else if (command === 'bandwidth-emergency') {
        if (options.value !== undefined) throw new Error(`不支持的参数 ${token}`);
        if (token !== 'on' && token !== 'off') throw new Error('带宽紧急保护必须为 on 或 off');
        options.value = token === 'on';
      }
      else if (options.value === undefined) options.value = parseAssetCacheRate(token);
      else options.clientValue = parseAssetCacheRate(token);
    } else {
      if (seen.has(token)) throw new Error(`参数 ${token} 重复`);
      seen.add(token);
      if (token === '--dir') {
        const value = rest[++index];
        if (!value || value.startsWith('--')) throw new Error('参数 --dir 缺少值');
        options.dir = value;
      } else if (token === '--json' && command === 'show') options.json = true;
      else throw new Error(`不支持的参数 ${token}`);
    }
  }
  if (command === 'ai-limit' && options.value === undefined) throw new Error('ai-limit 需要指定整数或 unlimited');
  if (command === 'asset-cache' && options.value === undefined) throw new Error('asset-cache 需要指定 required 或 optional');
  if (command === 'asset-cache-limit' && options.value === undefined) throw new Error('asset-cache-limit 需要指定总 Mbps 或 unlimited');
  if (command === 'bandwidth-emergency' && options.value === undefined) throw new Error('bandwidth-emergency 需要指定 on 或 off');
  if (command === 'asset-cache-limit' && options.clientValue === undefined) options.clientValue = options.value;
  return options;
}

export function main(argv) {
  prepareServerSettingsConsole();
  let options;
  try { options = parseArgs(argv); }
  catch (error) { writeUtf8(process.stderr, `服务器配置：${error.message}\n${USAGE}`); return 2; }
  if (options.command === 'help') { writeUtf8(process.stdout, USAGE); return 0; }
  try {
    if (options.command === 'ai-limit' || options.command === 'asset-cache' || options.command === 'asset-cache-limit'
      || options.command === 'bandwidth-emergency') {
      const dir = serverSettingsDirectory({ dir: options.dir });
      const ai = options.command === 'ai-limit';
      if (options.command === 'bandwidth-emergency') {
        writeServerSettings(dir, { bandwidthEmergencyEnabled: options.value });
        writeUtf8(process.stdout, `已保存带宽紧急保护：${options.value ? '开启' : '关闭'}。运行中的服务器约 1 秒内读取。`);
      } else if (options.command === 'asset-cache-limit') {
        writeServerSettings(dir, { assetCacheLimits: { totalBps: options.value, clientBps: options.clientValue } });
        const showRate = (value) => value === null ? '不限' : `${value / 125000} Mbps`;
        writeUtf8(process.stdout, `已保存素材在线限速：总 ${showRate(options.value)}，单 IP ${showRate(options.clientValue)}。运行中的服务器约 1 秒内读取。`);
      } else {
        writeServerSettings(dir, { [ai ? 'maxAiPerRoom' : 'requireAssetCache']: options.value });
        writeUtf8(process.stdout, ai
          ? `已保存每房 AI 上限：${options.value === null ? '不限' : options.value}。运行中的服务器约 1 秒内读取。`
          : `已保存预缓存准入：${options.value ? '严格，要求完整预缓存' : '允许未完整预缓存'}。运行中的服务器约 1 秒内读取；已有对局可继续恢复。`);
      }
    } else {
      const dir = serverSettingsDirectory({ dir: options.dir });
      const state = readServerSettings(dir) || initialServerSettings();
      writeUtf8(process.stdout, options.json ? JSON.stringify(state, null, 2)
        : `每房 AI 上限：${state.maxAiPerRoom === null ? '不限' : state.maxAiPerRoom}\n预缓存准入：${state.requireAssetCache ? '严格，要求完整预缓存' : '允许未完整预缓存'}\n素材在线限速：${state.assetCacheLimits ? `${state.assetCacheLimits.totalBps === null ? '不限' : `${state.assetCacheLimits.totalBps / 125000} Mbps`} / ${state.assetCacheLimits.clientBps === null ? '不限' : `${state.assetCacheLimits.clientBps / 125000} Mbps`}（总 / 单 IP）` : '不限（默认）'}\n带宽紧急保护：${state.bandwidthEmergencyEnabled === true ? '开启' : '关闭（默认）'}`);
    }
    return 0;
  } catch (error) { writeUtf8(process.stderr, `服务器配置：${error.message}`); return 1; }
}

const invoked = (() => { try { return pathToFileURL(fs.realpathSync(process.argv[1] || '')).href; } catch { return null; } })();
if (invoked === import.meta.url) process.exitCode = main(process.argv.slice(2));
