// Every switcher ATEM Software Control supports. Models with a recording use the
// startup state captured from real hardware (from the sofie-atem-connection test
// suite, MIT). The rest are built from the closest recorded sibling: renamed,
// and trimmed to the right number of inputs, M/Es, keyers and outputs.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readField, writeField, parseCommands } from './codec.mjs';
import { Spec } from './spec.mjs';
import { stableId } from '../bonjour.mjs';

const PROFILE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'profiles');

// shrink: { inputs, mes, dsks, aux, mediaPlayers, superSources, multiviewers }
// upgrade: the recording is from firmware older than ATEM Software Control 10 accepts
//   for this model, so it's converted to the current protocol (2.32)
// borrow: { profile, names } settings a built model needs that its base lacks (eg ISO recording)
// omit: settings of the base model this one doesn't have (eg the Mini Pro has no ISO recording)
// ports: 'sdi' converts HDMI inputs to SDI (for the SDI siblings of the Mini range)
export const MODELS = [
  { id: 'mini', name: 'ATEM Mini', family: 'Mini', profile: 'mini-v8.6' },
  { id: 'mini-pro', name: 'ATEM Mini Pro', family: 'Mini', model: 0x0e, from: 'mini-pro-iso', omit: ['ISOi', 'STAB', 'SAth', 'SwVr', 'AiVM'] },
  { id: 'mini-pro-iso', name: 'ATEM Mini Pro ISO', family: 'Mini', profile: 'mini-pro-iso-v8.4' },
  { id: 'mini-extreme', name: 'ATEM Mini Extreme', family: 'Mini', profile: 'mini-extreme-v8.6' },
  { id: 'mini-extreme-iso', name: 'ATEM Mini Extreme ISO', family: 'Mini', profile: 'mini-extreme-iso-v9.5' },
  { id: 'mini-extreme-iso-g2', name: 'ATEM Mini Extreme ISO G2', family: 'Mini', profile: 'mini-extreme-iso-g2-v10.1.1' },

  { id: 'sdi', name: 'ATEM SDI', family: 'SDI', model: 0x15, from: 'mini', ports: 'sdi' },
  { id: 'sdi-pro-iso', name: 'ATEM SDI Pro ISO', family: 'SDI', model: 0x16, from: 'sdi-extreme-iso', shrink: { inputs: 4, aux: 2, dsks: 1, mediaPlayers: 1, superSources: 0 } },
  { id: 'sdi-extreme-iso', name: 'ATEM SDI Extreme ISO', family: 'SDI', profile: 'sdi-extreme-iso-v8.8' },

  { id: 'tvs', name: 'ATEM Television Studio', family: 'Television Studio', model: 0x01, from: 'tvs-hd' },
  { id: 'tvs-hd', name: 'ATEM Television Studio HD', family: 'Television Studio', profile: 'tvshd-v8.2.0' },
  { id: 'tvs-pro-hd', name: 'ATEM Television Studio Pro HD', family: 'Television Studio', model: 0x09, from: 'tvs-hd' },
  { id: 'tvs-pro-4k', name: 'ATEM Television Studio Pro 4K', family: 'Television Studio', model: 0x0a, from: '1me-ps4k', shrink: { inputs: 8, aux: 1 } },
  { id: 'tvs-hd8', name: 'ATEM Television Studio HD8', family: 'Television Studio', profile: 'tvs-hd8-v9.0' },
  { id: 'tvs-hd8-iso', name: 'ATEM Television Studio HD8 ISO', family: 'Television Studio', model: 0x1b, from: 'tvs-hd8', borrow: { profile: 'mini-pro-iso-v8.4', names: ['ISOi'] } },
  { id: 'tvs-4k8', name: 'ATEM Television Studio 4K8', family: 'Television Studio', profile: 'tvs-4k8-v9.3' },

  { id: 'ps4k', name: 'ATEM Production Studio 4K', family: 'Production Studio', model: 0x04, from: '1me-ps4k', shrink: { inputs: 8, aux: 1 } },
  { id: '1me-ps4k', name: 'ATEM 1 M/E Production Studio 4K', family: 'Production Studio', profile: '1me4k-v8.2' },
  { id: '2me-ps4k', name: 'ATEM 2 M/E Production Studio 4K', family: 'Production Studio', profile: '2me4k-v8.4' },
  { id: '1me-prod', name: 'ATEM 1 M/E Production Switcher', family: 'Production Switcher', model: 0x02, from: '1me-ps4k', shrink: { inputs: 8 } },
  { id: '2me-prod', name: 'ATEM 2 M/E Production Switcher', family: 'Production Switcher', model: 0x03, from: '2me-ps4k', shrink: { inputs: 16 } },

  { id: '2me-bs4k', name: 'ATEM 2 M/E Broadcast Studio 4K', family: 'Broadcast Studio', model: 0x07, from: '4me-bs4k', shrink: { mes: 2 } },
  { id: '4me-bs4k', name: 'ATEM 4 M/E Broadcast Studio 4K', family: 'Broadcast Studio', profile: '4me4k-v8.2' },

  { id: '1me-const-hd', name: 'ATEM 1 M/E Constellation HD', family: 'Constellation', model: 0x12, from: '2me-const-hd', shrink: { mes: 1, inputs: 10, aux: 6, multiviewers: 1, superSources: 0 } },
  { id: '2me-const-hd', name: 'ATEM 2 M/E Constellation HD', family: 'Constellation', profile: 'constellation-2me-hd-v9.6.2' },
  { id: '4me-const-hd', name: 'ATEM 4 M/E Constellation HD', family: 'Constellation', model: 0x14, from: '4me-const-4k' },
  { id: '1me-const-4k', name: 'ATEM 1 M/E Constellation 4K', family: 'Constellation', model: 0x1c, from: '4me-const-4k', shrink: { mes: 1, inputs: 10, aux: 6, dsks: 2, mediaPlayers: 2, multiviewers: 1, superSources: 0 } },
  { id: '2me-const-4k', name: 'ATEM 2 M/E Constellation 4K', family: 'Constellation', model: 0x1d, from: '4me-const-4k', shrink: { mes: 2, inputs: 20, aux: 12, dsks: 2, mediaPlayers: 2, multiviewers: 2, superSources: 1 } },
  { id: '4me-const-4k', name: 'ATEM 4 M/E Constellation 4K', family: 'Constellation', profile: 'constellation-4me-4k-v9.1' },
  { id: '4me-const-4k-plus', name: 'ATEM 4 M/E Constellation 4K Plus', family: 'Constellation', model: 0x1f, from: '4me-const-4k' },
  { id: 'const-8k', name: 'ATEM Constellation 8K', family: 'Constellation', profile: 'constellation-v8.2.3', upgrade: true },
];

export function getModel(id) {
  const m = MODELS.find((x) => x.id === id);
  if (!m) throw new Error(`Unknown model "${id}"`);
  return m;
}

export function modelSource(m) {
  return m.profile ? 'recorded' : 'derived';
}

// Returns { profile: hex lines, transform } ready for new Switcher().
export function loadModel(id, userProfileDir) {
  const m = getModel(id);
  // A capture from your own hardware always wins.
  if (userProfileDir) {
    const own = path.join(userProfileDir, `${m.id}.data`);
    if (fs.existsSync(own)) return { model: m, source: 'captured', profile: readProfile(own) };
  }
  const built = buildModel(m);
  // Recordings carry whatever labels their owners typed; start from factory names.
  return { ...built, transform: (cmds, spec) => identify(factoryNames(built.transform ? built.transform(cmds, spec) : cmds, spec), m) };
}

function buildModel(m) {
  if (m.profile) {
    const profile = readProfile(path.join(PROFILE_DIR, `${m.profile}.data`));
    return { model: m, source: 'recorded', profile, transform: m.upgrade ? (cmds, spec) => upgrade(cmds, spec) : undefined };
  }
  const base = buildModel(getModel(m.from));
  return {
    model: m,
    source: 'derived',
    basedOn: base.model.name,
    profile: base.profile,
    transform: (cmds, spec) => derive(base.transform ? base.transform(cmds, spec) : cmds, spec, m),
  };
}

function readProfile(file) {
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
}

// ------------------------------------------------------------ derivation

const INPUT_KEYED = new Set(['InMp', 'FIEP', 'FASG']);

export function derive(cmds, spec, m) {
  const top = cmds.find((c) => c.name === '_top');
  const topSpec = spec.toClient._top;
  const cur = (name) => (top ? readField(top.data, topSpec.fields.find((f) => f.name === name)) : undefined);
  const s = m.shrink || {};
  const limit = {
    mes: s.mes ?? cur('MixEffectBlocks'),
    dsks: s.dsks ?? cur('DownstreamKeyers'),
    aux: s.aux ?? cur('Auxiliaries'),
    mediaPlayers: s.mediaPlayers ?? cur('MediaPlayers'),
    superSources: s.superSources ?? cur('SuperSource'),
    multiviewers: s.multiviewers ?? cur('Multiviewers'),
    inputs: s.inputs ?? Infinity,
  };

  const meConfig = cmds.find((c) => c.name === '_MeC');
  const keysPerMe = meConfig ? meConfig.data[1] || 1 : 1;
  const originalMes = cur('MixEffectBlocks') || 1;

  const removedSource = (v) => {
    if (v >= 1 && v < 1000) return v > limit.inputs;
    if (v >= 3010 && v < 4000) return Math.floor((v - 3000) / 10) > limit.mediaPlayers;
    // Key masks are numbered across all M/Es: 4010 = M/E 1 key 1, then on through the keys.
    if (v >= 4010 && v < 5000) return Math.floor(((v - 4000) / 10 - 1) / keysPerMe) >= limit.mes;
    if (v >= 5010 && v < 6000) return (v - 5000) / 10 > limit.dsks;
    // Bigger switchers have a clean feed per M/E; keep at least the usual two.
    if (v >= 7001 && v < 7100) return limit.mes < originalMes && v - 7000 > Math.max(2, limit.mes);
    if (v >= 6000 && v < 6100) return v - 6000 >= limit.superSources;
    if (v >= 8001 && v < 9000) return v - 8000 > limit.aux;
    if (v >= 10010 && v < 11000) return Math.floor((v - 10000) / 10) > limit.mes;
    return false;
  };

  const drop = (c) => {
    const def = spec.toClient[c.name];
    // Newer commands with no known layout that are keyed by input in their first two bytes.
    if (INPUT_KEYED.has(c.name) && c.data.length >= 2) {
      const v = c.data.readUInt16BE(0);
      return v >= 1 && v < 1000 && v > limit.inputs;
    }
    if (!def) return false;
    for (const f of def.fields) {
      const v = readField(c.data, f);
      if (typeof v !== 'number') continue;
      switch (f.csType) {
        case 'MixEffectBlockId': if (v >= limit.mes) return true; break;
        case 'DownstreamKeyId': if (v >= limit.dsks) return true; break;
        case 'MediaPlayerId': if (v >= limit.mediaPlayers) return true; break;
        case 'SuperSourceId': if (v >= limit.superSources) return true; break;
        default:
      }
      if (f.name === 'MultiviewIndex' && v >= limit.multiviewers) return true;
      if (c.name === 'AuxS' && f.name === 'Id' && v >= limit.aux) return true;
      if (c.name === 'InPr' && f.name === 'Id' && removedSource(v)) return true;
      if (f.csType === 'AudioSource' && f.id && v >= 1 && v < 1000 && v > limit.inputs) return true;
      if (f.csType === 'long' && f.name === 'SourceId') { /* per-input audio channel; covered by Index */ }
    }
    return false;
  };

  const out = cmds.filter((c) => !drop(c) && !(m.omit && m.omit.includes(c.name)));

  for (const c of out) {
    const def = spec.toClient[c.name];
    if (!def) continue;
    // Point anything routed to a removed source at Black.
    for (const f of def.fields) {
      if (f.csType === 'VideoSource' && !f.id && removedSource(readField(c.data, f))) writeField(c.data, f, 0);
    }
    if (c.name === '_pin') {
      writeField(c.data, def.fields.find((f) => f.name === 'Name'), m.name);
      if (m.model !== undefined) writeField(c.data, def.fields.find((f) => f.name === 'Model'), m.model);
    }
    if (c.name === 'InPr' && m.ports === 'sdi') {
      const avail = def.fields.find((f) => f.name === 'AvailableExternalPorts');
      const curp = def.fields.find((f) => f.name === 'ExternalPortType');
      if (readField(c.data, curp) === 2) { writeField(c.data, curp, 1); writeField(c.data, avail, 1); }
    }
  }

  if (top) {
    const set = (name, v) => { const f = topSpec.fields.find((x) => x.name === name); if (f && v !== undefined && v !== Infinity) writeField(top.data, f, v); };
    set('MixEffectBlocks', limit.mes);
    set('VideoSources', out.filter((c) => c.name === 'InPr').length);
    set('DownstreamKeyers', limit.dsks);
    set('Auxiliaries', limit.aux);
    set('MediaPlayers', limit.mediaPlayers);
    set('SuperSource', limit.superSources);
    set('Multiviewers', limit.multiviewers);
  }
  for (const name of ['_AMC', '_FAC']) {
    const c = out.find((x) => x.name === name);
    if (c) c.data[0] = out.filter((x) => x.name === (name === '_AMC' ? 'AMIP' : 'FAIP')).length;
  }
  const mvc = out.find((x) => x.name === '_MvC');
  const mvCount = spec.toClient._MvC && spec.toClient._MvC.fields.find((f) => f.name === 'Count');
  if (mvc && mvCount && limit.multiviewers !== undefined) writeField(mvc.data, mvCount, limit.multiviewers);

  // Settings this model has that the base model doesn't (eg ISO recording, 3G-SDI level).
  if (m.borrow) {
    const have = new Set(out.map((c) => c.name));
    const extra = readProfile(path.join(PROFILE_DIR, `${m.borrow.profile}.data`)).flatMap((h) => parseCommands(Buffer.from(h, 'hex')))
      .filter((c) => m.borrow.names.includes(c.name) && !have.has(c.name));
    out.push(...extra);
  }

  // Tally tables carry their own counts; the SDK refuses to sync if they disagree with the inputs.
  if (limit.inputs !== Infinity) {
    const external = out.filter((c) => c.name === 'InPr' && c.data.readUInt16BE(0) >= 1 && c.data.readUInt16BE(0) < 1000).length;
    for (const c of out) {
      if (c.name === '_TlC') c.data[4] = external;
      else if (c.name === 'TlIn') c.data = countedList(c.data, 1, () => true, external);
      else if (c.name === 'TlSr' || c.name === 'TlFc') c.data = countedList(c.data, 3, (e) => !removedSource(e.readUInt16BE(0)));
    }
  }
  return out;
}

// Rebuilds a "u16 count + fixed-size entries" list, keeping entries that pass `keep`
// (and at most `max` of them), padded to a multiple of 4 bytes.
function countedList(data, size, keep, max = Infinity) {
  const count = data.readUInt16BE(0);
  const entries = [];
  for (let i = 0; i < count && 2 + (i + 1) * size <= data.length; i++) {
    const e = data.subarray(2 + i * size, 2 + (i + 1) * size);
    if (entries.length < max && keep(e)) entries.push(e);
  }
  const body = Buffer.concat([Buffer.from([entries.length >> 8, entries.length & 0xff]), ...entries]);
  const out = Buffer.alloc(Math.ceil(body.length / 4) * 4);
  body.copy(out);
  return out;
}

// ------------------------------------------------------------ protocol upgrade

const CURRENT = 0x00020020; // 2.32, what firmware 9.6 and later report
const TEMPLATE = 'constellation-2me-hd-v9.6.2';

// Rewrites commands whose layout changed since the recording was made. Fields are
// copied by name; bytes LibAtem doesn't describe come from a current recording.
function upgrade(cmds, oldSpec) {
  const newSpec = new Spec(CURRENT);
  const template = new Map(readProfile(path.join(PROFILE_DIR, `${TEMPLATE}.data`))
    .flatMap((h) => parseCommands(Buffer.from(h, 'hex'))).reverse().map((c) => [c.name, c.data]));
  const oldMvc = cmds.find((c) => c.name === '_MvC');
  const mvCountField = oldSpec.toClient._MvC && oldSpec.toClient._MvC.fields.find((f) => f.name === 'Count');
  const multiviewers = oldMvc && mvCountField ? readField(oldMvc.data, mvCountField) : 1;

  for (const c of cmds) {
    if (c.name === '_ver') { c.data.writeUInt32BE(CURRENT, 0); continue; }
    const from = oldSpec.toClient[c.name];
    const to = newSpec.toClient[c.name];
    if (!from || !to || !to.len || (from.class === to.class && from.len === to.len)) continue;
    const out = Buffer.alloc(to.len);
    const t = template.get(c.name);
    if (t) t.copy(out, 0, 0, Math.min(t.length, to.len));
    for (const f of to.fields) {
      const old = from.fields.find((x) => x.name === f.name);
      if (old) writeField(out, f, readField(c.data, old));
    }
    if (c.name === '_top') {
      const mv = to.fields.find((f) => f.name === 'Multiviewers');
      if (mv) writeField(out, mv, multiviewers);
    }
    c.data = out;
  }

  return cmds;
}

// ------------------------------------------------------------ factory names

// Which family a source belongs to, and its number within that family.
function sourceKind(id) {
  if (id === 0) return { kind: 'black', n: 0 };
  if (id < 1000) return { kind: 'input', n: id };
  if (id === 1000) return { kind: 'bars', n: 0 };
  if (id > 2000 && id < 2100) return { kind: 'color', n: id - 2000 };
  if (id >= 3010 && id < 4000) return { kind: id % 10 ? 'mpkey' : 'mp', n: Math.floor((id - 3000) / 10) };
  if (id >= 4010 && id < 5000) return { kind: 'keymask', n: (id - 4000) / 10 };
  if (id >= 5010 && id < 6000) return { kind: 'dskmask', n: (id - 5000) / 10 };
  if (id >= 6000 && id < 6100) return { kind: 'ssrc', n: id - 5999 };
  if (id > 7000 && id < 7100) return { kind: 'cleanfeed', n: id - 7000 };
  if (id > 8000 && id < 8100) return { kind: 'aux', n: id - 8000 };
  if (id > 9000 && id < 9100) return { kind: 'multiview', n: id - 9000 };
  if (id >= 10010 && id < 11000) return { kind: id % 10 ? 'pvw' : 'pgm', n: Math.floor((id - 10000) / 10) };
  return { kind: 'other:' + id, n: 0 };
}

// Short names are at most 4 characters: "CAM9" becomes "CM10", "OUT9" becomes "OT10".
function fitShort(prefix, n) {
  const s = prefix + n;
  if (s.length <= 4) return s;
  const p = prefix.length > 1 ? prefix[0] + prefix[prefix.length - 1] : prefix;
  return (p + n).slice(0, 4);
}

const FALLBACK = {
  black: () => ['Black', 'BLK'],
  input: (n) => [`Camera ${n}`, fitShort('CAM', n)],
  bars: () => ['Color Bars', 'BARS'],
  color: (n) => [`Color ${n}`, `COL${n}`],
  mp: (n) => [`Media Player ${n}`, `MP${n}`],
  mpkey: (n) => [`Media Player ${n} Key`, `MP${n}K`],
  dskmask: (n) => [`DSK ${n} Mask`, `DK${n}M`],
  cleanfeed: (n) => [`Clean Feed ${n}`, `CFD${n}`],
  aux: (n) => [`Auxiliary ${n}`, fitShort('AUX', n)],
  multiview: (n) => [n > 1 ? `Multi View ${n}` : 'Multi View', n > 1 ? `MVW${n}` : 'MVW'],
};

// Replaces every label a previous owner customised with the factory name, worked
// out from untouched siblings in the same switcher so each model keeps its own style.
function factoryNames(cmds, spec) {
  const def = spec.toClient.InPr;
  if (!def) return cmds;
  const f = (name) => def.fields.find((x) => x.name === name);
  const fLong = f('LongName'), fShort = f('ShortName'), fDefault = f('AreNamesDefault');
  const inputs = cmds.filter((c) => c.name === 'InPr');
  const info = inputs.map((c) => {
    const id = c.data.readUInt16BE(0);
    return { c, id, ...sourceKind(id), long: readField(c.data, fLong), short: readField(c.data, fShort), isDefault: readField(c.data, fDefault) };
  });
  const count = (kind) => info.filter((x) => x.kind === kind).length;

  // A template from an untouched sibling whose names contain its own number.
  const template = (kind, n) => {
    for (const s of info) {
      if (s.kind !== kind || !s.isDefault || s.n === n || !s.n) continue;
      const num = String(s.n);
      const longRe = new RegExp(`(^|\\D)${num}(?!\\d)`);
      const shortM = String(s.short).match(new RegExp(`^(\\D*)${num}$`));
      if (!longRe.test(s.long) || !shortM) continue;
      return [s.long.replace(longRe, `$1${n}`), fitShort(shortM[1], n)];
    }
    return null;
  };

  for (const x of info) {
    let names = null;
    if (x.kind === 'pgm' || x.kind === 'pvw') {
      // Switchers that name previews "ME 1 PVW" name programs "ME 1" (or "ME 1 PGM", found by template).
      const meStyle = count('pgm') > 1 || info.some((s) => s.kind === 'pvw' && s.isDefault && /^ME \d/.test(s.long));
      names = template(x.kind, x.n) || (meStyle
        ? (x.kind === 'pgm' ? [`ME ${x.n}`, `M/E${x.n}`] : [`ME ${x.n} PVW`, `PVW${x.n}`])
        : (x.kind === 'pgm' ? ['Program', 'PGM'] : ['Preview', 'PVW']));
    } else if (x.kind === 'ssrc') {
      names = count('ssrc') > 1 ? [`SuperSource ${x.n}`, `SS${x.n}`] : ['SuperSource', 'SSRC'];
    } else if (x.kind === 'keymask') {
      names = template('keymask', x.n);
    } else if (FALLBACK[x.kind]) {
      names = template(x.kind, x.n) || FALLBACK[x.kind](x.n);
    }
    if (!names) continue;
    // Default names stay untouched, except a short name numbered for the wrong source.
    const shortWrong = x.isDefault && x.n && /\d/.test(x.short) && !String(x.short).endsWith(String(x.n));
    if (x.isDefault && !shortWrong) continue;
    if (x.isDefault && shortWrong) names = [x.long, names[1]];
    writeField(x.c.data, fLong, names[0].slice(0, 20));
    writeField(x.c.data, fShort, names[1].slice(0, 4));
    writeField(x.c.data, fDefault, true);
  }
  return cmds;
}

// The switcher's own identity block (unique id, IP, hostname, name), which ATEM
// Software Control shows in its title bar. Recordings and built models would
// otherwise carry the original switcher's; use the emulated model's instead, with
// the same unique id the emulator announces on the network.
function identify(cmds, m) {
  const who = cmds.find((c) => c.name === 'WhoI');
  if (!who || who.data.length < 176) return cmds;
  const put = (off, len, text) => { who.data.fill(0, off, off + len); who.data.write(text, off, len - 1, 'utf8'); };
  who.data.write(stableId(m.id), 0, 32, 'latin1');
  put(32, 16, '127.0.0.1');
  put(48, 64, `${m.name.replace(/[^A-Za-z0-9]+/g, '-')}.local`);
  put(112, 64, m.name);
  return cmds;
}
