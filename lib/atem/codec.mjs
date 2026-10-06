// Command framing and field encoding for the ATEM protocol.
// Commands are big-endian; macro operations are little-endian.

export function parseCommands(buf) {
  const out = [];
  let o = 0;
  while (o + 8 <= buf.length) {
    const len = buf.readUInt16BE(o);
    if (len < 8 || o + len > buf.length) break;
    out.push({ name: buf.toString('latin1', o + 4, o + 8), data: Buffer.from(buf.subarray(o + 8, o + len)) });
    o += len;
  }
  return out;
}

export function frameCommand(name, data) {
  const head = Buffer.alloc(8);
  head.writeUInt16BE(8 + data.length, 0);
  head.write(name, 4, 4, 'latin1');
  return Buffer.concat([head, data]);
}

// Evaluates simple numeric attribute arguments such as "1000" or "9 * 65535".
function num(expr) {
  if (expr === undefined) return undefined;
  const s = String(expr).replace(/[a-zA-Z_]/g, '').trim();
  if (!/^[-\d.\s*/+()]+$/.test(s)) return undefined;
  try { return Function(`"use strict";return (${s})`)(); } catch { return undefined; }
}

const SIZES = {
  Enum8: 1, UInt8: 1, UInt8Range: 1, UInt8D: 1, Bool: 1, Int8: 1,
  Enum16: 2, UInt16: 2, UInt16D: 2, UInt16Range: 2, UInt16Tol: 2, Decibels: 2, Int16: 2, Int16D: 2, StringLength: 2,
  Enum32: 4, UInt32: 4, UInt32D: 4, UInt32DScale: 4, UInt32Range: 4, UInt32RangeAttribute: 4, IpAddress: 4,
  Int32: 4, Int32D: 4, DirectionInt32: 4, HyperDeckTime: 4,
  Int64: 8,
};
const SIGNED = new Set(['Int8', 'Int16', 'Int16D', 'Int32', 'Int32D', 'DirectionInt32', 'Int64']);
const SCALED = new Set(['UInt8D', 'UInt16D', 'Int16D', 'UInt32D', 'Int32D', 'UInt32DScale']);

export function fieldSize(f) {
  if (f.type === 'String' || f.type === 'ByteArray') return num(f.args[0]) ?? 0;
  return SIZES[f.type] ?? 0;
}

function scaleOf(f) { return SCALED.has(f.type) ? (num(f.args[0]) || 1) : 1; }

// Reads a field as a logical value: number (scaled), boolean or string.
export function readField(buf, f, le = false) {
  const off = f.off;
  const size = fieldSize(f);
  if (!size || off + size > buf.length) return undefined;
  if (f.type === 'Bool') {
    const bit = num(f.args[0]);
    return bit !== undefined ? Boolean(buf[off] & (1 << bit)) : buf[off] !== 0;
  }
  if (f.type === 'String') return buf.toString('utf8', off, off + size).replace(/\0.*$/s, '');
  if (f.type === 'ByteArray') return buf.subarray(off, off + size).toString('hex');
  let v;
  const signed = SIGNED.has(f.type);
  if (size === 1) v = signed ? buf.readInt8(off) : buf.readUInt8(off);
  else if (size === 2) v = le ? (signed ? buf.readInt16LE(off) : buf.readUInt16LE(off)) : (signed ? buf.readInt16BE(off) : buf.readUInt16BE(off));
  else if (size === 4) v = le ? (signed ? buf.readInt32LE(off) : buf.readUInt32LE(off)) : (signed ? buf.readInt32BE(off) : buf.readUInt32BE(off));
  else if (size === 8) v = Number(le ? buf.readBigInt64LE(off) : buf.readBigInt64BE(off));
  return v / scaleOf(f);
}

export function writeField(buf, f, value, le = false) {
  const off = f.off;
  const size = fieldSize(f);
  if (!size || off + size > buf.length || value === undefined) return;
  if (f.type === 'Bool') {
    const bit = num(f.args[0]);
    if (bit !== undefined) buf[off] = value ? buf[off] | (1 << bit) : buf[off] & ~(1 << bit);
    else buf[off] = value ? 1 : 0;
    return;
  }
  if (f.type === 'String') {
    buf.fill(0, off, off + size);
    buf.write(String(value), off, size, 'utf8');
    return;
  }
  if (f.type === 'ByteArray') {
    buf.fill(0, off, off + size);
    Buffer.from(String(value), 'hex').copy(buf, off, 0, size);
    return;
  }
  const signed = SIGNED.has(f.type);
  let v = Math.round(Number(value) * scaleOf(f));
  if (size === 1) signed ? buf.writeInt8(clamp(v, -128, 127), off) : buf.writeUInt8(clamp(v, 0, 255), off);
  else if (size === 2) {
    v = signed ? clamp(v, -32768, 32767) : clamp(v, 0, 65535);
    le ? (signed ? buf.writeInt16LE(v, off) : buf.writeUInt16LE(v, off)) : (signed ? buf.writeInt16BE(v, off) : buf.writeUInt16BE(v, off));
  } else if (size === 4) {
    v = signed ? clamp(v, -2147483648, 2147483647) : clamp(v, 0, 4294967295);
    le ? (signed ? buf.writeInt32LE(v, off) : buf.writeUInt32LE(v, off)) : (signed ? buf.writeInt32BE(v, off) : buf.writeUInt32BE(v, off));
  } else if (size === 8) le ? buf.writeBigInt64LE(BigInt(v), off) : buf.writeBigInt64BE(BigInt(v), off);
}

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

// Copies raw bytes when both fields share an encoding, otherwise converts the value.
export function copyField(src, sf, dst, df, srcLe = false, dstLe = false) {
  if (sf.type === df.type && String(sf.args[0]) === String(df.args[0]) && srcLe === dstLe && fieldSize(sf) === fieldSize(df) && !(sf.type === 'Bool' && sf.args.length)) {
    const n = fieldSize(sf);
    if (sf.off + n <= src.length && df.off + n <= dst.length) src.copy(dst, df.off, sf.off, sf.off + n);
    return;
  }
  writeField(dst, df, readField(src, sf, srcLe), dstLe);
}
