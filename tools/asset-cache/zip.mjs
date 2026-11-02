// Streaming ZIP32 writer: bounded file buffers, UTF-8 names, DEFLATE and data descriptors.
// The current full asset set is well below ZIP32's 4 GiB / 65,535-entry limits. Refuse an
// oversized future catalog rather than writing an ambiguous/truncated ZIP.
import fs from 'node:fs';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createDeflateRaw } from 'node:zlib';
import { createHash } from 'node:crypto';

const U32 = 0xffffffff;
const FLAGS = 0x0808; // UTF-8 name + sizes/CRC in data descriptor
const crcTable = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
export function updateCRC32(crc, data) {
  for (let i = 0; i < data.length; i++) crc = crcTable[(crc ^ data[i]) & 255] ^ (crc >>> 8);
  return crc >>> 0;
}

function check32(n) { if (!Number.isSafeInteger(n) || n < 0 || n >= U32) throw new Error('素材包超过 ZIP32 的 4 GiB 限制'); }

/**
 * Entries: {name, filePath?, data?, bytes?, sha256?}; byte expectations are checked while packing.
 * Writes only to an already-open file handle, leaving atomic publishing/removal to the caller.
 */
export async function writeAssetZip(handle, entries, { level = 6, onEntry = () => {} } = {}) {
  if (entries.length >= 65535) throw new Error('素材包超过 ZIP32 的文件数量限制');
  let position = 0;
  const central = [];
  const names = new Set();
  const write = async (buffer) => {
    let offset = 0;
    while (offset < buffer.length) {
      const result = await handle.write(buffer, offset, buffer.length - offset, position);
      if (!result.bytesWritten) throw new Error('素材包写入失败');
      offset += result.bytesWritten;
      position += result.bytesWritten;
      check32(position);
    }
  };
  for (const entry of entries) {
    const name = entry.name;
    if (typeof name !== 'string' || !name || name.startsWith('/') || /[\\\x00-\x1f\x7f:]/.test(name)
      || name.split('/').some((s) => !s || s.startsWith('.'))) throw new Error(`不安全的 ZIP 路径：${name}`);
    if (names.has(name)) throw new Error(`ZIP 路径重复：${name}`);
    names.add(name);
    const encoded = Buffer.from(name, 'utf8');
    if (encoded.length > 65535) throw new Error('ZIP 文件名过长');
    const localOffset = position;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(FLAGS, 6);
    header.writeUInt16LE(8, 8);
    header.writeUInt16LE(0x0021, 12); // 1980-01-01; no machine-specific timestamps
    header.writeUInt16LE(encoded.length, 26);
    await write(header);
    await write(encoded);
    const start = position;
    let crc = U32;
    let bytes = 0;
    const hash = createHash('sha256');
    const inspect = new Transform({
      transform(chunk, _encoding, callback) {
        crc = updateCRC32(crc, chunk);
        bytes += chunk.length;
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    const source = entry.filePath ? fs.createReadStream(entry.filePath) : Readable.from([entry.data || Buffer.alloc(0)]);
    const deflater = createDeflateRaw({ level });
    const consume = pipeline(source, inspect, deflater);
    // Observe errors immediately; consuming the output can otherwise reject before pipeline is awaited.
    consume.catch(() => {});
    try {
      for await (const chunk of deflater) await write(chunk);
      await consume;
    } catch (error) { source.destroy(); deflater.destroy(); await consume.catch(() => {}); throw error; }
    const digest = hash.digest('hex');
    if (entry.bytes !== undefined && entry.bytes !== bytes) throw new Error(`素材打包期间发生大小变化：${name}`);
    if (entry.sha256 !== undefined && entry.sha256 !== digest) throw new Error(`素材打包期间发生内容变化：${name}`);
    const packed = position - start;
    check32(bytes); check32(packed);
    crc = (crc ^ U32) >>> 0;
    const descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(0x08074b50, 0);
    descriptor.writeUInt32LE(crc, 4);
    descriptor.writeUInt32LE(packed, 8);
    descriptor.writeUInt32LE(bytes, 12);
    await write(descriptor);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(FLAGS, 8); cd.writeUInt16LE(8, 10);
    cd.writeUInt16LE(0x0021, 14);
    cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(packed, 20); cd.writeUInt32LE(bytes, 24);
    cd.writeUInt16LE(encoded.length, 28);
    cd.writeUInt32LE(localOffset, 42);
    central.push(Buffer.concat([cd, encoded]));
    await onEntry({ name, bytes, packed, sha256: digest });
  }
  const centralOffset = position;
  for (const record of central) await write(record);
  const centralBytes = position - centralOffset;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes, 12); end.writeUInt32LE(centralOffset, 16);
  await write(end);
  return { bytes: position, entries: entries.length };
}
