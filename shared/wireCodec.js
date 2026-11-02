// Pure ESM transport adapter. Game state/validation/dispatch keep the original {t, ...} objects.
// Compact JSON: [wireVersion, messageId, maskHex, ...present fields]; nested records: [maskHex, ...fields].
// The bit after the last defined position denotes an unmodified JSON extension object. No field is silently lost.
import { WIRE_VERSION, WIRE_MESSAGES, WIRE_RECORDS, WIRE_ENUMS } from './wireSchema.js';

export { WIRE_VERSION } from './wireSchema.js';

const MAX_DEPTH = 48;
const MAX_RECORDS = 100_000;
const own = (v, k) => Object.hasOwn(v, k);
const plain = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
/** @param {any} field @returns {string} */
const fieldName = (field) => typeof field === 'string' ? field : field[0];
const fieldType = (field) => typeof field === 'string' ? null : field[1];
const byType = new Map();
const byId = new Map();
const records = new Map();

/** @param {any[]} fields */
function compile(fields) {
  const names = fields.map(fieldName);
  if (names.length > 120 || new Set(names).size !== names.length || names.includes('t')) throw new Error('invalid wire schema');
  return { names, types: fields.map(fieldType), nameSet: new Set(names), bits: names.map((_, i) => 1n << BigInt(i)),
    extraBit: 1n << BigInt(names.length) };
}
for (const [name, fields] of Object.entries(WIRE_RECORDS)) records.set(name, compile(fields));
for (const [id, type, direction, fields] of WIRE_MESSAGES) {
  if (byId.has(id) || byType.has(type)) throw new Error('duplicate wire message');
  const entry = { id, type, direction, schema: compile(['rid', ...fields]) };
  byId.set(id, entry); byType.set(type, entry);
}

export class WireCodecError extends Error {
  constructor(detail) { super(`invalid compact wire: ${detail}`); this.name = 'WireCodecError'; }
}
const fail = (detail) => { throw new WireCodecError(detail); };
const define = (out, key, value) => Object.defineProperty(out, key, { value, enumerable: true, writable: true, configurable: true });

function visit(ctx, depth) {
  if (depth > MAX_DEPTH || ++ctx.count > MAX_RECORDS) fail('complexity limit');
}

function transform(value, type, decode, ctx, depth) {
  if (!type || value === null) return value;
  if (Array.isArray(type)) {
    const [kind, sub] = type;
    if (kind === 'enum') {
      const values = WIRE_ENUMS[sub];
      if (!values) fail('unknown enum');
      if (!decode) {
        if (typeof value !== 'string') return [-1, value]; // Escape non-string input, never confuse it with an enum id.
        const id = values.indexOf(value);
        return id < 0 ? value : id;
      }
      if (typeof value === 'string') return value; // New/unknown values retain their readable spelling.
      if (Array.isArray(value) && value.length === 2 && value[0] === -1) return value[1];
      if (!Number.isInteger(value) || value < 0 || value >= values.length) fail('unknown enum id');
      return values[value];
    }
    visit(ctx, depth);
    if (kind === 'list') {
      if (!Array.isArray(value)) fail('expected list');
      return value.map((item) => transform(item, sub, decode, ctx, depth + 1));
    }
    if (kind === 'map') {
      if (!plain(value)) fail('expected map');
      const out = {};
      for (const [key, item] of Object.entries(value)) define(out, key, transform(item, sub, decode, ctx, depth + 1));
      return out;
    }
    fail('unknown container');
  }
  const schema = records.get(type);
  if (!schema) fail(`unknown record ${type}`);
  return decode ? decodeRecord(value, schema, ctx, depth) : encodeRecord(value, schema, ctx, depth);
}

function encodeRecord(value, schema, ctx, depth, root = false) {
  visit(ctx, depth);
  if (!plain(value)) fail('expected object');
  let mask = 0n;
  /** @type {any[]} */ const out = [''];
  schema.names.forEach((name, i) => {
    if (own(value, name) && value[name] !== undefined) {
      mask |= schema.bits[i];
      out.push(transform(value[name], schema.types[i], false, ctx, depth + 1));
    }
  });
  let extra = null;
  for (const key of Object.keys(value)) {
    if (!schema.nameSet.has(key) && !(root && key === 't') && value[key] !== undefined) {
      if (!extra) extra = {};
      define(extra, key, value[key]);
    }
  }
  if (extra) { mask |= schema.extraBit; out.push(extra); }
  out[0] = mask.toString(16);
  return out;
}

function decodeRecord(value, schema, ctx, depth, root = false) {
  visit(ctx, depth);
  if (!Array.isArray(value) || typeof value[0] !== 'string' || !/^(0|[1-9a-f][0-9a-f]{0,30})$/.test(value[0])) fail('invalid presence mask');
  const mask = BigInt(`0x${value[0]}`);
  if (mask >= schema.extraBit * 2n) fail('unknown position');
  let at = 1;
  const out = {};
  schema.names.forEach((name, i) => {
    if ((mask & schema.bits[i]) !== 0n) {
      if (at >= value.length) fail('missing value');
      define(out, name, transform(value[at++], schema.types[i], true, ctx, depth + 1));
    }
  });
  if ((mask & schema.extraBit) !== 0n) {
    const extra = value[at++];
    if (!plain(extra)) fail('invalid extension');
    for (const [key, item] of Object.entries(extra)) {
      if (schema.nameSet.has(key) || (root && key === 't')) fail('extension overrides position');
      define(out, key, item);
    }
  }
  if (at !== value.length) fail('unexpected values');
  return out;
}

/** Encode a readable JSON message. Unknown message types remain readable JSON for forward compatibility. */
export function encodeWire(message, direction = null) {
  if (!plain(message) || typeof message.t !== 'string') fail('expected message');
  const entry = byType.get(message.t);
  if (!entry) return message;
  if (direction && entry.direction !== direction) fail('wrong direction');
  const body = encodeRecord(message, entry.schema, { count: 0 }, 0, true);
  return [WIRE_VERSION, entry.id, ...body];
}

/** Decode either legacy JSON or compact v1 to the same business object. Invalid compact input always throws. */
export function decodeWire(value, direction = null) {
  if (!Array.isArray(value)) return value;
  if (value.length < 3 || value[0] !== WIRE_VERSION) fail('unsupported version');
  const entry = byId.get(value[1]);
  if (!entry || (direction && entry.direction !== direction)) fail('unknown message id or direction');
  const out = decodeRecord(value.slice(2), entry.schema, { count: 0 }, 0, true);
  define(out, 't', entry.type);
  return out;
}

/** Public, machine-readable catalog used by the inspection CLI and documentation checks. */
export function wireCatalog() {
  return { version: WIRE_VERSION, envelope: ['version', 'messageId', 'maskHex', 'presentValues...'],
    messages: WIRE_MESSAGES.map(([id, type, direction, fields]) => ({ id, type, direction, fields: ['rid', ...fields] })),
    records: WIRE_RECORDS, enums: WIRE_ENUMS };
}
