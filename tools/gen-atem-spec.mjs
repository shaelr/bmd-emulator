#!/usr/bin/env node
// Developer tool: builds lib/atem/spec.json from a LibAtem checkout
// (https://github.com/LibAtem/LibAtem, LGPL-3.0). LibAtem describes every ATEM
// command and macro operation with C# attributes; this extracts the byte
// layouts so the emulator can apply commands and record macros generically.
//
//   git clone --depth 1 https://github.com/LibAtem/LibAtem.git /tmp/LibAtem
//   node tools/gen-atem-spec.mjs /tmp/LibAtem

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = process.argv[2];
if (!root) { console.error('Usage: node tools/gen-atem-spec.mjs <LibAtem checkout>'); process.exit(1); }
const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'atem', 'spec.json');

const VERSIONS = { Minimum: 0x0002000f, V7_2: 0x00020016, V7_5_2: 0x0002001b, V8_0: 0x0002001c, V8_0_1: 0x0002001d, V8_1_1: 0x0002001e, V9_4: 0x0002001f, V9_6: 0x00020020 };

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? walk(path.join(dir, d.name)) : d.name.endsWith('.cs') ? [path.join(dir, d.name)] : []);
}

// Splits "a, b(c, d), e" at top-level commas.
function splitTop(s) {
  const parts = []; let depth = 0; let cur = '';
  for (const ch of s) {
    if (ch === '(' || ch === '{') depth++;
    if (ch === ')' || ch === '}') depth--;
    if (ch === ',' && depth === 0) { parts.push(cur.trim()); cur = ''; } else cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

// Reads the properties of a class: the [..] attributes stacked above each `public X Name {`.
function parseFields(body) {
  const fields = [];
  const re = /((?:\s*\[[^\]]*\]\s*)+)\s*public\s+(?:override\s+)?([\w<>.\[\]?]+)\s+(\w+)\s*\{/g;
  let m;
  while ((m = re.exec(body))) {
    const attrs = m[1];
    const ser = attrs.match(/Serialize\((\d+)\)\s*,\s*(\w+)(?:\(([^)]*)\))?/);
    if (!ser) continue;
    const xml = attrs.match(/MacroField\("([^"]+)"(?:\s*,\s*"([^"]+)")?\)/);
    fields.push({
      name: m[3],
      csType: m[2],
      off: Number(ser[1]),
      type: ser[2],
      args: ser[3] ? splitTop(ser[3]) : [],
      id: /\[CommandId\]/.test(attrs) || undefined,
      xml: xml ? (xml[2] || xml[1][0].toLowerCase() + xml[1].slice(1)) : undefined,
    });
  }
  return fields;
}

function parseMask(body) {
  const m = body.match(/enum\s+MaskFlags\s*(?::\s*\w+\s*)?\{([^}]*)\}/);
  if (!m) return null;
  const mask = {};
  for (const line of m[1].split(',')) {
    const e = line.trim().match(/^(\w+)\s*=\s*(.+)$/);
    if (!e) continue;
    const v = e[2].trim();
    const shift = v.match(/^1\s*<<\s*(\d+)$/);
    mask[e[1]] = shift ? 1 << Number(shift[1]) : Number(v);
  }
  return mask;
}

function maskField(body) {
  const m = body.match(/\[Serialize\((\d+)\)\s*,\s*(Enum8|Enum16|Enum32|UInt8|UInt16|UInt32)[^\]]*\]\s*public\s+MaskFlags\s+Mask/);
  return m ? { off: Number(m[1]), type: m[2] } : null;
}

// `Prop = Expr,` pairs inside an object initialiser.
function parseAssign(block) {
  const assign = {};
  for (const part of splitTop(block)) {
    const a = part.match(/^(\w+)\s*=\s*([\s\S]+)$/);
    if (a) assign[a[1]] = a[2].trim().replace(/\s+/g, ' ');
  }
  return assign;
}

function parseToMacroOps(body) {
  const i = body.indexOf('ToMacroOps(');
  if (i < 0) return undefined;
  const sect = body.slice(i);
  const ops = [];
  const re = /(?:if\s*\(\s*Mask\.HasFlag\(MaskFlags\.(\w+)\)\s*\)\s*)?yield\s+return\s+(?:new\s+(\w+)\s*(?:\(\s*\))?\s*\{([\s\S]*?)\}\s*;|null\s*;)/g;
  let m;
  while ((m = re.exec(sect))) {
    if (!m[2]) { ops.push({ when: m[1] || null, op: null }); continue; }
    ops.push({ when: m[1] || null, op: m[2].replace(/MacroOp$/, ''), assign: parseAssign(m[3]) });
  }
  return ops;
}

function parseToCommand(body) {
  const i = body.indexOf('ToCommand(');
  if (i < 0) return undefined;
  const sect = body.slice(i, i + 3000);
  if (/return\s+null\s*;/.test(sect.slice(0, sect.indexOf('}') + 1))) return null;
  const m = sect.match(/return\s+new\s+(\w+)\s*(?:\(\s*\))?\s*\{([\s\S]*?)\}\s*;/);
  if (!m) return { custom: true };
  const assign = parseAssign(m[2]);
  let mask;
  if (assign.Mask) {
    mask = [...assign.Mask.matchAll(/MaskFlags\.(\w+)/g)].map((x) => x[1]);
    delete assign.Mask;
  }
  return { command: m[1], assign, mask };
}

// ---------------------------------------------------------------- commands
const commands = {};
const byClass = {};
for (const file of walk(path.join(root, 'LibAtem', 'Commands'))) {
  const src = fs.readFileSync(file, 'utf8');
  // A file can hold several classes; handle each.
  const classRe = /((?:\[[^\]]*\]\s*)*)public\s+class\s+(\w+)\s*:\s*\w+/g;
  const starts = [];
  let cm;
  while ((cm = classRe.exec(src))) starts.push({ idx: cm.index, attrs: cm[1], name: cm[2] });
  starts.forEach((c, k) => {
    const body = src.slice(c.idx, k + 1 < starts.length ? starts[k + 1].idx : src.length);
    const names = [...c.attrs.matchAll(/CommandName\("(.{4})"\s*,\s*CommandDirection\.(\w+)(?:\s*,\s*ProtocolVersion\.(\w+))?(?:\s*,\s*(\d+))?\)/g)];
    if (!names.length) return;
    const variants = names.map((n) => ({ dir: n[2], version: VERSIONS[n[3] || 'Minimum'], len: n[4] !== undefined ? Number(n[4]) : null }));
    const raw = names[0][1];
    const entry = {
      raw,
      class: c.name,
      dir: variants[0].dir,
      variants,
      noId: /NoCommandId/.test(c.attrs) || undefined,
      custom: /override\s+void\s+(Serialize|Deserialize)\s*\(/.test(body) || undefined,
      mask: parseMask(body) || undefined,
      maskField: maskField(body) || undefined,
      fields: parseFields(body).filter((f) => f.name !== 'Mask'),
      macroOps: parseToMacroOps(body),
    };
    commands[raw] = commands[raw] ? [].concat(commands[raw], entry) : entry;
    byClass[c.name] = raw;
  });
}

// ---------------------------------------------------------------- macro ops
const typeSrc = fs.readFileSync(path.join(root, 'LibAtem', 'Common', 'MacroOperationType.cs'), 'utf8');
// C# enum: entries without a value are the previous value plus one.
const opIds = {};
{
  const enumBody = typeSrc.slice(typeSrc.indexOf('{', typeSrc.indexOf('enum MacroOperationType')) + 1);
  let next = 0;
  for (const raw of enumBody.slice(0, enumBody.indexOf('}')).split('\n')) {
    const line = raw.replace(/\/\/.*$/, '').trim();
    const m = line.match(/^(\w+)\s*(?:=\s*(0x[0-9a-fA-F]+|\d+))?\s*,?$/);
    if (!m) continue;
    const v = m[2] !== undefined ? Number(m[2]) : next;
    opIds[m[1]] = v;
    next = v + 1;
  }
}

// Every class in MacroOperations, with its base class, so inherited fields resolve.
const opClasses = {};
for (const file of walk(path.join(root, 'LibAtem', 'MacroOperations'))) {
  const src = fs.readFileSync(file, 'utf8');
  const classRe = /((?:\[[^\]]*\]\s*)*)public\s+(?:abstract\s+)?class\s+(\w+)\s*:\s*(\w+)/g;
  const starts = [];
  let cm;
  while ((cm = classRe.exec(src))) starts.push({ idx: cm.index, attrs: cm[1], name: cm[2], base: cm[3] });
  starts.forEach((c, k) => {
    const body = src.slice(c.idx, k + 1 < starts.length ? starts[k + 1].idx : src.length);
    const op = c.attrs.match(/MacroOperation\(MacroOperationType\.(\w+)\s*,\s*(?:ProtocolVersion\.(\w+)\s*,\s*)?(\d+)\)/);
    opClasses[c.name] = { base: c.base, fields: parseFields(body), op, toCommand: op ? parseToCommand(body) : undefined };
  });
}
const resolveFields = (name) => {
  const c = opClasses[name];
  if (!c) return [];
  const own = c.fields;
  const inherited = resolveFields(c.base).filter((f) => !own.some((o) => o.name === f.name));
  return inherited.concat(own).sort((a, b) => a.off - b.off);
};
const macroOps = {};
for (const [cls, c] of Object.entries(opClasses)) {
  if (!c.op) continue;
  macroOps[c.op[1]] = {
    id: opIds[c.op[1]],
    class: cls,
    minVersion: VERSIONS[c.op[2] || 'Minimum'],
    len: Number(c.op[3]),
    fields: resolveFields(cls),
    toCommand: c.toCommand,
  };
}

const spec = {
  generatedFrom: 'LibAtem (https://github.com/LibAtem/LibAtem), LGPL-3.0',
  generatedAt: new Date().toISOString(),
  versions: VERSIONS,
  commands,
  macroOps,
  macroOpIds: opIds,
};
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(spec, null, 1));
const cmdList = Object.values(commands).flat();
console.log(`commands: ${cmdList.length} (${cmdList.filter((c) => c.dir === 'ToServer').length} to switcher, ${cmdList.filter((c) => c.dir === 'ToClient').length} to client, ${cmdList.filter((c) => c.dir === 'Both').length} both, ${cmdList.filter((c) => c.custom).length} custom)`);
console.log(`macro ops: ${Object.keys(macroOps).length}, with ids: ${Object.values(macroOps).filter((o) => o.id !== undefined).length}`);
console.log(`wrote ${out}`);
