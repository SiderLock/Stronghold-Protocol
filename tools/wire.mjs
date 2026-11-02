#!/usr/bin/env node
// Inspect compact frames without the server: JSONL in/out, explicitly UTF-8. No token or state is uploaded.
import { createInterface } from 'node:readline';
import { createReadStream } from 'node:fs';
import { once } from 'node:events';
import { encodeWire, decodeWire, wireCatalog } from '../shared/wireCodec.js';

async function main() {
  const mode = process.argv[2]; const file = process.argv[3];
  if (!['encode', 'decode', 'schema'].includes(mode) || process.argv.length > 4 || (mode === 'schema' && file)) {
    process.stderr.write('用法 / usage: node tools/wire.mjs encode|decode [UTF-8.jsonl|-] | schema\n');
    process.exitCode = 1; return;
  }
  if (mode === 'schema') { process.stdout.write(`${JSON.stringify(wireCatalog(), null, 2)}\n`); return; }
  // Reading UTF-8 directly avoids older PowerShell versions re-encoding piped text as ASCII/OEM.
  const input = file && file !== '-' ? createReadStream(file, { encoding: 'utf8' }) : process.stdin;
  input.setEncoding('utf8');
  const lines = createInterface({ input, crlfDelay: Infinity });
  let lineNumber = 0;
  try {
    for await (const line of lines) {
      lineNumber++;
      if (!line.trim()) continue;
      try {
        const value = JSON.parse(lineNumber === 1 ? line.replace(/^\uFEFF/, '') : line);
        const converted = mode === 'encode' ? encodeWire(value) : decodeWire(value);
        if (!process.stdout.write(`${JSON.stringify(converted)}\n`)) await once(process.stdout, 'drain');
      } catch (error) {
        process.stderr.write(`第 ${lineNumber} 行转换失败 / line ${lineNumber}: ${error.message}\n`);
        process.exitCode = 1; break;
      }
    }
  } finally {
    lines.close(); if (input !== process.stdin) input.destroy();
  }
}

main().catch((error) => { process.stderr.write(`wire 工具失败 / failed: ${error.message}\n`); process.exitCode = 1; });
