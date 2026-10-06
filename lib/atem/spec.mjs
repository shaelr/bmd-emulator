// Command and macro-op layouts (generated from LibAtem by tools/gen-atem-spec.mjs),
// resolved for one protocol version.
import fs from 'node:fs';

const raw = JSON.parse(fs.readFileSync(new URL('./spec.json', import.meta.url), 'utf8'));

// Set commands whose state lives in a differently-named "get" command.
// { set: [target, { setField: targetField }] }
const EXTRA_PAIRS = {
  CDsF: ['DskB'], CDsC: ['DskB'], CDsG: ['DskP'], CDsM: ['DskP'], CDsT: ['DskP'], CDsR: ['DskP'],
  CDsL: ['DskS'],
  CKTp: ['KeBP'], CKMs: ['KeBP'], CKeF: ['KeBP'], CKeC: ['KeBP'],
  FtbC: ['FtbP'],
  CMPP: ['FMPP'], CFMH: ['FMHP'],
  CFIP: ['FAIP'], CMvP: ['MvPr'], CSBP: ['SSBP', { Source: 'Source' }], CSSc: ['SSrc'],
  SMPS: ['MPfe'],
};
// Get-command fields that carry a different name in the set command.
const FIELD_ALIASES = { InputSource: 'Source', ArtFillInput: 'ArtFillSource', ArtKeyInput: 'ArtCutSource' };

export class Spec {
  constructor(version) {
    this.version = version;
    this.commands = {};       // raw name -> resolved entry for this direction preference
    this.toClient = {};
    this.toServer = {};
    const byClass = {};
    for (const entries of Object.values(raw.commands)) {
      for (const e of [].concat(entries)) {
        const variant = pickVariant(e.variants, version);
        if (!variant) continue;
        const resolved = { ...e, len: variant.len, versioned: e.variants.length > 1 };
        // Version-specific variants of a command live in separate classes (eg *V8); keep the best.
        const place = (map) => {
          const prev = map[e.raw];
          if (!prev || variant.version >= prev._v) map[e.raw] = Object.assign(resolved, { _v: variant.version });
        };
        if (e.dir === 'ToClient' || e.dir === 'Both') place(this.toClient);
        if (e.dir === 'ToServer' || e.dir === 'Both') place(this.toServer);
        byClass[e.class] = resolved;
      }
    }
    // Pair set -> get commands.
    this.pairs = {};
    for (const [rawName, s] of Object.entries(this.toServer)) {
      let target;
      if (EXTRA_PAIRS[rawName]) target = this.toClient[EXTRA_PAIRS[rawName][0]];
      else {
        const g = byClass[s.class.replace(/Set(V\d+)?Command$/, 'GetCommand')] || byClass[s.class.replace(/Set(V\d+)?Command$/, 'Get$1Command')];
        if (g && g.raw && this.toClient[g.raw]) target = this.toClient[g.raw];
      }
      if (target && target !== s) this.pairs[rawName] = target;
    }
    this.macroOps = raw.macroOps;
    this.macroOpIds = raw.macroOpIds;
    this.macroById = {};
    for (const [name, op] of Object.entries(raw.macroOps)) this.macroById[op.id] = { name, ...op };
    this.classes = byClass;
  }

  setField(setCmd, getField) {
    const want = FIELD_ALIASES[getField.name] || getField.name;
    return setCmd.fields.find((f) => f.name === want) || setCmd.fields.find((f) => f.name === getField.name);
  }

  // Field values that identify which instance of a command this is (eg M/E and keyer index).
  idKey(cmd, data) {
    const ids = cmd.fields.filter((f) => f.id);
    if (!ids.length) return cmd.raw;
    return cmd.raw + ':' + ids.map((f) => readId(data, f)).join(',');
  }
}

function readId(data, f) {
  const size = f.type.includes('16') ? 2 : f.type.includes('32') ? 4 : 1;
  if (f.off + size > data.length) return '?';
  return size === 1 ? data[f.off] : size === 2 ? data.readUInt16BE(f.off) : data.readUInt32BE(f.off);
}

function pickVariant(variants, version) {
  let best = null;
  for (const v of variants) if (v.version <= version && (!best || v.version > best.version)) best = v;
  return best || null;
}

export const SPEC_VERSIONS = raw.versions;
