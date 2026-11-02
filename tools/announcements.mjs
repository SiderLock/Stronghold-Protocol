#!/usr/bin/env node
// Ordinary announcement administration. UTF-8 Markdown input is explicit; no HTTP write endpoint is exposed.
// node tools/announcements.mjs publish --title <title> --file <body.md> [--id <id>] [--pin] [--dir <dir>]
// node tools/announcements.mjs list [--json] [--dir <dir>]
// node tools/announcements.mjs pin <id> [--dir <dir>]
// node tools/announcements.mjs unpin [--dir <dir>]
// node tools/announcements.mjs delete <id> [--dir <dir>]
// node tools/announcements.mjs notify <id> [--dir <dir>]   explicitly notify currently connected real clients

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createAnnouncementStore, readAnnouncementMarkdown } from '../server/announcements.js';
import { enqueueAnnouncementNotice } from '../server/announcementNotices.js';
import { announcementHistoryItems } from '../shared/announcements.js';

const USAGE = `公告管理（正文与输出均为 UTF-8）：
  node tools/announcements.mjs publish --title <标题> --file <正文.md> [--id <ID>] [--pin] [--dir <目录>]
  node tools/announcements.mjs list [--json] [--dir <目录>]
  node tools/announcements.mjs pin <ID> [--dir <目录>]
  node tools/announcements.mjs unpin [--dir <目录>]
  node tools/announcements.mjs delete <ID> [--dir <目录>]
  node tools/announcements.mjs notify <ID> [--dir <目录>]
  默认目录：runtime/announcements；可用 SP_ANNOUNCEMENTS_DIR 指定持久化目录。`;

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!command || command === '--help' || command === '-h') return { command: 'help' };
  if (!['publish', 'list', 'pin', 'unpin', 'delete', 'notify'].includes(command)) throw new Error(`未知命令 ${command}`);
  const options = { command, dir: undefined, title: undefined, file: undefined, id: undefined, pin: false, json: false };
  const seen = new Set();
  for (let i = 0; i < rest.length; i++) {
    const value = rest[i];
    if (!value.startsWith('--')) {
      if (!['pin', 'delete', 'notify'].includes(command) || options.id) throw new Error(`不支持的参数 ${value}`);
      options.id = value;
      continue;
    }
    if (seen.has(value)) throw new Error(`参数 ${value} 重复`);
    seen.add(value);
    if (value === '--dir' || (command === 'publish' && ['--title', '--file', '--id'].includes(value))) {
      const next = rest[++i];
      if (!next || next.startsWith('--')) throw new Error(`参数 ${value} 缺少值`);
      options[value.slice(2)] = next;
    } else if (value === '--json' && command === 'list') options.json = true;
    else if (value === '--pin' && command === 'publish') options.pin = true;
    else throw new Error(`不支持的参数 ${value}`);
  }
  if (command === 'publish' && (!options.title || !options.file)) throw new Error('发布需要 --title 和显式指定的 --file <正文.md>');
  if (command === 'pin' && !options.id) throw new Error('置顶需要指定公告 ID');
  if (command === 'delete' && !options.id) throw new Error('删除需要指定公告 ID');
  if (command === 'notify' && !options.id) throw new Error('发送通知需要指定公告 ID');
  return options;
}

/** Writes explicitly encoded UTF-8 bytes, including when Windows cmd redirects the output. */
const writeUtf8 = (stream, value) => stream.write(Buffer.from(`${value}\n`, 'utf8'));

/** Windows cmd needs its console code page changed too; redirected output always remains UTF-8. */
export function prepareAnnouncementConsole({ platform = process.platform, stdout = process.stdout, stderr = process.stderr, run = spawnSync } = {}) {
  if (platform !== 'win32' || (!stdout.isTTY && !stderr.isTTY)) return;
  try { run('cmd.exe', ['/d', '/c', 'chcp', '65001'], { stdio: 'ignore', windowsHide: true, timeout: 1000 }); }
  catch { /* An unavailable console command must not prevent announcement administration. */ }
}

/** @param {string[]} argv @returns {Promise<number>} */
export async function main(argv) {
  prepareAnnouncementConsole();
  let options;
  try { options = parseArgs(argv); }
  catch (e) { writeUtf8(process.stderr, `公告管理：${e.message}\n${USAGE}`); return 2; }
  if (options.command === 'help') { writeUtf8(process.stdout, USAGE); return 0; }
  const log = { warn: (line) => writeUtf8(process.stderr, line) };
  const store = createAnnouncementStore({ dir: options.dir, log });
  try {
    if (options.command === 'list') {
      const index = store.list();
      if (options.json) writeUtf8(process.stdout, JSON.stringify(index, null, 2));
      else if (!index.items.length) writeUtf8(process.stdout, '当前没有公告。');
      else for (const item of announcementHistoryItems(index)) writeUtf8(process.stdout, `${item.id === index.pinnedId ? '[置顶] ' : ''}${item.id}\t${item.publishedAt}\t${item.title}`);
      return 0;
    }
    if (options.command === 'publish') {
      const markdown = readAnnouncementMarkdown(path.resolve(options.file));
      const item = store.publish({ id: options.id, title: options.title, markdown, pin: options.pin });
      writeUtf8(process.stdout, `已发布公告 ${item.id}${options.pin ? '，并设为唯一置顶' : ''}。`);
    } else if (options.command === 'notify') {
      await enqueueAnnouncementNotice({ store, id: options.id, log });
      writeUtf8(process.stdout, '已提交发送命令，运行中的服务器将在约1秒内通知在线玩家。');
    } else if (options.command === 'pin') {
      store.pin(options.id);
      writeUtf8(process.stdout, `已置顶公告 ${options.id}。`);
    } else if (options.command === 'delete') {
      store.remove(options.id);
      writeUtf8(process.stdout, `已删除公告 ${options.id}。`);
    } else {
      store.unpin();
      writeUtf8(process.stdout, '已取消公告置顶。');
    }
    return 0;
  } catch (e) { writeUtf8(process.stderr, `公告管理：${e.message}`); return 1; }
}

const invoked = (() => { try { return pathToFileURL(fs.realpathSync(process.argv[1] || '')).href; } catch { return null; } })();
if (invoked === import.meta.url) main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => {
  writeUtf8(process.stderr, `公告管理：${e.message}`); process.exitCode = 1;
});
