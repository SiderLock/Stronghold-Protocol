// Local JSONL benchmark; output contains aggregates only, never names, session tokens or captured payloads.
// Each line: {connection, start?, end?, capturePayloadBytes?, captureWireBytes?, message:{t,...}}.
import fs from 'node:fs';
import readline from 'node:readline';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { isDeepStrictEqual } from 'node:util';
import { WIRE_VERSION, encodeWire, decodeWire } from '../shared/wireCodec.js';

const TAIL = Buffer.from([0, 0, 255, 255]);
const DEFLATE = { level: 6, memLevel: 7, windowBits: 15 };
const MODES = ['json', 'positions', 'json_deflate_frame', 'positions_deflate_frame', 'json_deflate_context', 'positions_deflate_context'];
const headerBytes = (bytes) => bytes < 126 ? 2 : bytes <= 65535 ? 4 : 10;

class Context {
  constructor(inflate = false) {
    this.stream = inflate ? zlib.createInflateRaw({ windowBits: 15 }) : zlib.createDeflateRaw(DEFLATE);
    this.chunks = []; this.failure = null; this.reject = null;
    this.stream.on('data', (chunk) => this.chunks.push(chunk));
    this.stream.on('error', (error) => { this.failure = error; this.reject?.(error); });
  }
  update(body) {
    return new Promise((resolve, reject) => {
      if (this.failure) { reject(this.failure); return; }
      this.reject = reject;
      this.stream.write(body);
      this.stream.flush(zlib.constants.Z_SYNC_FLUSH, () => {
        this.reject = null;
        if (this.failure) { reject(this.failure); return; }
        const output = Buffer.concat(this.chunks); this.chunks = []; resolve(output);
      });
    });
  }
  close() { this.stream.destroy(); }
}

const empty = () => ({ messages: 0, capturePayloadBytes: 0, captureWireBytes: 0,
  modes: Object.fromEntries(MODES.map((mode) => [mode, { payloadBytes: 0, wireBytes: 0 }])) });

function add(bucket, record, lengths) {
  bucket.messages++;
  bucket.capturePayloadBytes += record.capturePayloadBytes || lengths.json;
  bucket.captureWireBytes += record.captureWireBytes || lengths.json + headerBytes(lengths.json);
  for (const mode of MODES) {
    bucket.modes[mode].payloadBytes += lengths[mode];
    bucket.modes[mode].wireBytes += lengths[mode] + headerBytes(lengths[mode]);
  }
}

function finish(bucket, seconds) {
  const baseline = bucket.modes.json.wireBytes;
  for (const mode of MODES) {
    bucket.modes[mode].reductionPercent = baseline ? 100 * (1 - bucket.modes[mode].wireBytes / baseline) : 0;
    // A sub-second phase transition has no stable rate window: report its bytes, never a misleading spike.
    bucket.modes[mode].averageMbps = seconds >= 1 ? bucket.modes[mode].wireBytes * 8 / seconds / 1e6 : null;
  }
  return bucket;
}

async function main() {
  let file = null; let duration = null; let maxContexts = 256;
  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg === '--duration') duration = Number(process.argv[++i]);
    else if (arg === '--max-contexts') maxContexts = Number(process.argv[++i]);
    else if (arg === '--help') {
      process.stdout.write('node tools/wire-bench.mjs [capture.jsonl|-] [--duration seconds] [--max-contexts 256]\n'); return;
    } else if (file === null && (arg === '-' || !arg.startsWith('-'))) file = arg;
    else throw new Error(`unknown argument ${arg}`);
  }
  if (duration !== null && (!Number.isFinite(duration) || duration <= 0)) throw new Error('duration must be positive seconds');
  if (!Number.isSafeInteger(maxContexts) || maxContexts < 1 || maxContexts > 4096) throw new Error('max-contexts must be 1..4096');
  const input = !file || file === '-' ? process.stdin : fs.createReadStream(file);
  const reader = readline.createInterface({ input, crlfDelay: Infinity });
  const total = empty(); const types = new Map(); const rooms = new Map(); const contexts = new Map();
  let minTime = Infinity; let maxTime = -Infinity; let codecMs = 0; let line = 0; let verified = 0;
  const began = performance.now(); const cpu = process.cpuUsage();
  try {
    for await (const text of reader) {
      line++; if (!text.trim()) continue;
      let record;
      try { record = JSON.parse(line === 1 ? text.replace(/^\uFEFF/, '') : text); } catch { throw new Error(`line ${line}: invalid JSONL`); }
      const msg = record.message;
      if (!msg || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.t !== 'string') throw new Error(`line ${line}: missing game message`);
      const key = String(record.connection ?? 0);
      if (!contexts.has(key)) {
        if (contexts.size >= maxContexts) throw new Error(`line ${line}: context bound exceeded`);
        contexts.set(key, { json: new Context(), positions: new Context(), inflate: new Context(true) });
      }
      const streams = contexts.get(key);
      const original = Buffer.from(JSON.stringify(msg));
      const beforeCodec = performance.now();
      // welcome is always the original JSON in the actual negotiation, even for a compact-capable client.
      const encoded = msg.t === 'welcome' ? msg : encodeWire(msg, 's2c');
      const compact = Buffer.from(JSON.stringify(encoded));
      const restored = Array.isArray(encoded) ? decodeWire(JSON.parse(compact.toString()), 's2c') : JSON.parse(compact.toString());
      if (!isDeepStrictEqual(restored, msg)) throw new Error(`line ${line}: ${msg.t} round-trip mismatch`);
      codecMs += performance.now() - beforeCodec;
      const [jsonContext, positionsContext] = await Promise.all([streams.json.update(original), streams.positions.update(compact)]);
      const reinflated = await streams.inflate.update(positionsContext);
      if (!reinflated.equals(compact)) throw new Error(`line ${line}: decompression mismatch`);
      verified++;
      // WebSocket permessage-deflate omits the final 00 00 ff ff sync-flush bytes, including with takeover.
      if (!jsonContext.subarray(-4).equals(TAIL) || !positionsContext.subarray(-4).equals(TAIL)) throw new Error(`line ${line}: invalid deflate trailer`);
      const independent = (body) => zlib.deflateRawSync(body, { ...DEFLATE, finishFlush: zlib.constants.Z_SYNC_FLUSH }).length - 4;
      const lengths = { json: original.length, positions: compact.length, json_deflate_frame: independent(original),
        positions_deflate_frame: independent(compact), json_deflate_context: jsonContext.length - 4,
        positions_deflate_context: positionsContext.length - 4 };
      add(total, record, lengths);
      if (!types.has(msg.t)) types.set(msg.t, empty()); add(types.get(msg.t), record, lengths);
      if (Number.isFinite(record.start)) minTime = Math.min(minTime, record.start);
      if (Number.isFinite(record.end)) maxTime = Math.max(maxTime, record.end);
      if (msg.t === 'm.public') {
        const roomKey = createHash('sha256').update(JSON.stringify((msg.players || []).map((p) => p.playerId))).digest('hex');
        if (!rooms.has(roomKey)) rooms.set(roomKey, { public: empty(), phases: new Map(), playerCount: msg.players?.length || 0,
          humanCount: (msg.players || []).filter((p) => !p.isBot).length });
        const room = rooms.get(roomKey); add(room.public, record, lengths);
        const phaseKey = `${msg.round}:${msg.phase}:${msg.unite?.round || 0}`;
        if (!room.phases.has(phaseKey)) room.phases.set(phaseKey, { ...empty(), round: msg.round, phase: msg.phase,
          uniteRound: msg.unite?.round || null, start: Infinity, end: -Infinity });
        const phase = room.phases.get(phaseKey); add(phase, record, lengths);
        phase.start = Math.min(phase.start, record.start ?? 0); phase.end = Math.max(phase.end, record.end ?? 0);
      }
    }
  } finally {
    reader.close(); if (input !== process.stdin) input.destroy();
    for (const streams of contexts.values()) for (const stream of Object.values(streams)) stream.close();
  }
  if (!verified) throw new Error('no game messages to benchmark');
  const seconds = duration ?? (maxTime - minTime);
  const mainRoom = [...rooms.values()].sort((a, b) => b.public.modes.json.payloadBytes - a.public.modes.json.payloadBytes)[0];
  const cpuUsed = process.cpuUsage(cpu);
  const report = { schema: 1, wireVersion: WIRE_VERSION, compression: { ...DEFLATE, serverContextTakeover: true },
    verifiedMessages: verified, connections: contexts.size, durationSeconds: Number.isFinite(seconds) ? seconds : null,
    total: finish(total, seconds), types: Object.fromEntries([...types].map(([type, bucket]) => [type, finish(bucket, seconds)])),
    mainRoom: mainRoom ? { playerCount: mainRoom.playerCount, humanCount: mainRoom.humanCount, public: finish(mainRoom.public, seconds),
      phases: [...mainRoom.phases.values()].sort((a, b) => a.start - b.start).map((p) => finish(p, p.end - p.start)) } : null,
    processing: { wallSeconds: (performance.now() - began) / 1000, codecAndSemanticChecksMs: codecMs,
      cpuUserMs: cpuUsed.user / 1000, cpuSystemMs: cpuUsed.system / 1000 },
    limits: ['offline replay, not production deployment or human gameplay', 'all outbound JSON shares each physical connection dictionary',
      'starts dictionaries at capture start, never resets them at phase boundaries', 'no 5 Hz resampling or TLS/TCP/IP overhead included',
      'phase windows follow captured delivery times and can overlap; sub-second averages are omitted',
      'wire estimates use one unmasked WebSocket frame per message'] };
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
}

main().catch((error) => { process.stderr.write(`[wire-bench] ${error.message}\n`); process.exitCode = 1; });
