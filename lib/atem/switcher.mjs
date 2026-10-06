// The emulated switcher: holds state as the raw status commands a real ATEM
// sends, applies commands from clients, runs transitions, records and plays
// macros, and serves the file-transfer protocol used for macros and media.
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { parseCommands, frameCommand, readField, writeField, copyField } from './codec.mjs';
import { Spec } from './spec.mjs';

// Describe the hardware rather than its settings; never taken from saved state.
const STRUCTURE = new Set(['TlIn', 'TlSr', 'TlFc', 'WhoI', 'InCm']);

const MACRO_STORE = 0xffff;
const MAX_PAYLOAD = 1300;
const CHUNK = 1396;

// VideoMode enum -> frames per second (used to time transitions and macro pauses).
const MODE_FPS = [29.97, 25, 29.97, 25, 50, 59.94, 25, 29.97, 23.98, 24, 25, 29.97, 50, 59.94,
  23.98, 24, 25, 29.97, 50, 59.94, 23.98, 24, 25, 29.97, 50, 59.94, 30, 60, 30, 60];

export class Switcher extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string[]} opts.profile   hex payloads recorded from a real switcher
   * @param {(cmds:{name:string,data:Buffer}[])=>void} [opts.transform]  model derivation
   * @param {string} [opts.stateFile] where to persist the switcher's state
   */
  constructor({ profile, transform, stateFile, log = () => {} }) {
    super();
    this.log = log;
    this.stateFile = stateFile;
    let cmds = profile.flatMap((hex) => parseCommands(Buffer.from(hex.trim(), 'hex')));
    const ver = cmds.find((c) => c.name === '_ver');
    this.version = ver ? ver.data.readUInt32BE(0) : 0x00020020;
    this.spec = new Spec(this.version);
    if (transform) {
      cmds = transform(cmds, this.spec) || cmds;
      // A transform may upgrade the protocol version; use the matching layouts.
      const v2 = cmds.find((c) => c.name === '_ver');
      if (v2 && v2.data.readUInt32BE(0) !== this.version) {
        this.version = v2.data.readUInt32BE(0);
        this.spec = new Spec(this.version);
      }
    }

    this.macros = {};        // index -> Buffer of macro ops
    this.media = {};         // "store:index" -> { data, name, hash }
    this.transfers = new Map();
    this.recorder = null;    // { index, name, description, ops: Buffer[] }
    this.player = null;
    this.animations = new Map();
    this.unhandled = new Map();

    // Build the model fresh, then lay any saved programming over it.
    this.load(cmds, true);
    this.restore();
    this.tick = setInterval(() => this.step(), 1000 / 50);
  }

  // ------------------------------------------------------------ state store

  load(cmds, fresh) {
    this.store = new Map();
    for (const c of cmds) {
      if (c.name === 'InCm') continue;
      let key = this.keyFor(c.name, c.data);
      if (this.store.has(key)) { let n = 1; while (this.store.has(`${key}#${n}`)) n++; key = `${key}#${n}`; }
      this.store.set(key, { name: c.name, data: c.data });
    }
    if (fresh) this.factoryClean();
  }

  keyFor(name, data) {
    const spec = this.spec.toClient[name];
    return spec ? this.spec.idKey(spec, data) : name;
  }

  find(name, ids = {}) {
    for (const rec of this.store.values()) {
      if (rec.name !== name) continue;
      const spec = this.spec.toClient[name];
      if (!spec) return rec;
      if (Object.entries(ids).every(([f, v]) => { const fs_ = spec.fields.find((x) => x.name === f); return !fs_ || readField(rec.data, fs_) === v; })) return rec;
    }
    return null;
  }

  all(name) { return [...this.store.values()].filter((r) => r.name === name); }

  get(rec, field) { return readField(rec.data, this.spec.toClient[rec.name].fields.find((f) => f.name === field)); }

  set(rec, field, value) {
    const f = this.spec.toClient[rec.name].fields.find((x) => x.name === field);
    if (f) writeField(rec.data, f, value);
  }

  // Replaces or inserts a status command and sends it to every client.
  put(name, data, { broadcast = true } = {}) {
    const key = this.keyFor(name, data);
    const rec = this.store.get(key);
    if (rec) rec.data = data; else this.store.set(key, { name, data });
    if (broadcast) this.out(name, data);
    this.dirty();
  }

  touch(rec) { this.out(rec.name, rec.data); this.dirty(); }

  out(name, data, to = null) { this.emit('out', { frame: frameCommand(name, data), to }); }

  // Packs the full state into packets for a newly connected client.
  initPayloads() {
    const frames = [];
    const order = ['_ver', '_pin'];
    for (const n of order) for (const r of this.all(n)) frames.push(frameCommand(r.name, r.data));
    for (const r of this.store.values()) if (!order.includes(r.name)) frames.push(frameCommand(r.name, r.data));
    frames.push(frameCommand('InCm', Buffer.from([1, 0, 0, 0])));
    const packets = [];
    let cur = [];
    let size = 0;
    for (const f of frames) {
      if (size + f.length > MAX_PAYLOAD && cur.length) { packets.push(Buffer.concat(cur)); cur = []; size = 0; }
      cur.push(f);
      size += f.length;
    }
    if (cur.length) packets.push(Buffer.concat(cur));
    return packets;
  }

  // A recording reflects whoever owned that switcher. Start with empty macro
  // and media pools so the project only contains what you program.
  factoryClean() {
    for (const rec of this.all('MPrp')) rec.data = emptyMacroProps(rec.data.readUInt16BE(0));
    for (const rec of this.all('MPfe')) rec.data = stillEntry(rec.data[0], rec.data.readUInt16BE(2), null);
    for (const rec of this.all('MPCS')) { const d = Buffer.alloc(rec.data.length); d[0] = rec.data[0]; rec.data = d; }
    for (const rec of this.all('MPAS')) { const d = Buffer.alloc(rec.data.length); d[0] = rec.data[0]; rec.data = d; }
    for (const rec of this.all('MRPr')) rec.data = Buffer.alloc(4);
    for (const rec of this.all('MRcS')) { rec.data = Buffer.alloc(4); rec.data.writeUInt16BE(0xffff, 2); }
    for (const rec of this.all('LKST')) rec.data[2] = 0;
  }

  // ------------------------------------------------------------ persistence

  dirty() {
    if (!this.stateFile) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.save(), 500);
  }

  save() {
    if (!this.stateFile) return;
    const doc = {
      version: this.version,
      store: [...this.store.entries()].map(([k, r]) => [k, r.name, r.data.toString('hex')]),
      macros: Object.fromEntries(Object.entries(this.macros).map(([i, b]) => [i, b.toString('hex')])),
      media: Object.fromEntries(Object.entries(this.media).map(([k, m]) => [k, { ...m, data: m.data.toString('base64') }])),
    };
    fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
    fs.writeFileSync(this.stateFile + '.tmp', JSON.stringify(doc));
    fs.renameSync(this.stateFile + '.tmp', this.stateFile);
  }

  restore() {
    if (!this.stateFile || !fs.existsSync(this.stateFile)) return false;
    try {
      const doc = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
      if (doc.version !== this.version) return false;
      // Saved values replace the fresh ones setting by setting. Settings the model no
      // longer has are dropped and new ones keep their defaults, so fixes to a model
      // still reach a show that was programmed before them.
      for (const [k, name, hex] of doc.store) {
        if (name.startsWith('_') || STRUCTURE.has(name)) continue; // always from the model itself
        const rec = this.store.get(k);
        if (rec && rec.name === name) rec.data = Buffer.from(hex, 'hex');
      }
      this.macros = Object.fromEntries(Object.entries(doc.macros || {}).map(([i, h]) => [i, Buffer.from(h, 'hex')]));
      this.media = Object.fromEntries(Object.entries(doc.media || {}).map(([k, m]) => [k, { ...m, data: Buffer.from(m.data, 'base64') }]));
      // Anything mid-flight when the emulator stopped is over now.
      for (const rec of this.all('TrPs')) { rec.data[1] = 0; rec.data[2] = 0; rec.data.writeUInt16BE(0, 4); }
      for (const rec of this.all('MRPr')) rec.data = Buffer.alloc(4);
      for (const rec of this.all('MRcS')) { rec.data = Buffer.alloc(4); rec.data.writeUInt16BE(0xffff, 2); }
      for (const rec of this.all('LKST')) rec.data[2] = 0;
      return true;
    } catch (e) {
      this.log(`Could not read saved state (${e.message}); starting fresh.`);
      return false;
    }
  }

  reset() {
    this.macros = {};
    this.media = {};
    if (this.stateFile && fs.existsSync(this.stateFile)) fs.unlinkSync(this.stateFile);
  }

  close() { clearInterval(this.tick); if (this.saveTimer) { clearTimeout(this.saveTimer); this.save(); } }

  get fps() {
    const vm = this.find('VidM');
    return vm ? MODE_FPS[vm.data[0]] || 30 : 30;
  }

  // ------------------------------------------------------------ commands from clients

  handle(client, cmds, { fromMacro = false } = {}) {
    for (const { name, data } of cmds) {
      try {
        const h = HANDLERS[name];
        let recordable = true;
        if (h) recordable = h.call(this, data, client) !== false;
        else if (this.spec.pairs[name]) this.applySet(name, data);
        else { this.noteUnhandled(name, data); recordable = false; }
        if (this.recorder && !fromMacro && recordable) this.record(name, data);
      } catch (e) {
        this.log(`Error handling ${name}: ${e.stack || e.message}`);
      }
    }
  }

  noteUnhandled(name, data) {
    const n = (this.unhandled.get(name) || 0) + 1;
    this.unhandled.set(name, n);
    if (n === 1) this.log(`Unhandled command ${name} ${data.toString('hex').slice(0, 64)}`);
    this.emit('unhandled', name);
  }

  // Generic: copy the fields a set command carries into its status command.
  applySet(name, data) {
    const set = this.spec.toServer[name];
    const get = this.spec.pairs[name];
    const ids = {};
    for (const f of set.fields.filter((x) => x.id)) {
      const target = get.fields.find((g) => g.name === f.name) || get.fields.find((g) => g.id && g.off === f.off - (set.maskField ? set.maskField.off + 1 : 0));
      if (target) ids[target.name] = readField(data, f);
    }
    let rec = this.find(get.raw, ids);
    if (!rec) { this.noteUnhandled(`${name}->${get.raw}`, data); return; }
    const mask = set.maskField ? readField(data, { ...set.maskField, args: [] }) : null;
    const updated = Buffer.from(rec.data);
    for (const gf of get.fields) {
      if (gf.id) continue;
      const sf = this.spec.setField(set, gf);
      if (!sf) continue;
      if (mask !== null && set.mask && set.mask[sf.name] !== undefined && !(mask & set.mask[sf.name])) continue;
      if (mask !== null && set.mask && set.mask[sf.name] === undefined) continue;
      copyField(data, sf, updated, gf);
    }
    if (name === 'CInL') updated[26] = 0; // names no longer default
    rec.data = updated;
    this.touch(rec);
  }

  // ------------------------------------------------------------ transitions

  meCount() { const t = this.find('_top'); return t ? t.data[0] : 1; }

  swap(me) {
    const pgm = this.find('PrgI', { Index: me });
    const pvw = this.find('PrvI', { Index: me });
    if (!pgm || !pvw) return;
    const a = pgm.data.readUInt16BE(2);
    pgm.data.writeUInt16BE(pvw.data.readUInt16BE(2), 2);
    pvw.data.writeUInt16BE(a, 2);
    this.touch(pgm);
    this.touch(pvw);
  }

  // Ends a transition: background swaps and selected keys toggle, as on the hardware.
  completeTransition(me) {
    const ss = this.find('TrSS', { Index: me });
    const selection = ss ? ss.data[4] : 1;
    if (selection & 1) this.swap(me);
    for (let k = 0; k < 4; k++) {
      if (!(selection & (2 << k))) continue;
      const on = this.find('KeOn', { MixEffectIndex: me, KeyerIndex: k });
      if (on) { on.data[2] = on.data[2] ? 0 : 1; this.touch(on); }
    }
    if (ss) { ss.data[1] = ss.data[3]; ss.data[2] = ss.data[4]; this.touch(ss); }
  }

  tieDsks(me, frames) {
    if (me !== 0) return;
    for (const p of this.all('DskP')) {
      if (!p.data[1]) continue;
      const idx = p.data[0];
      if (frames) this.startDsk(idx, frames);
      else { const s = this.find('DskS', { Index: idx }); if (s) { s.data[1] = s.data[1] ? 0 : 1; this.touch(s); } }
    }
  }

  transitionFrames(me) {
    const ss = this.find('TrSS', { Index: me });
    const style = ss ? ss.data[3] : 0;
    const src = { 0: ['TMxP', 1], 1: ['TDpP', 1], 2: ['TWpP', 1], 3: ['TDvP', 1] }[style];
    if (src) { const r = this.find(src[0], { Index: me }); if (r) return r.data[src[1]] || 1; }
    if (style === 4) { const r = this.find('TStP', { Index: me }); if (r) return r.data.readUInt16BE(16) || 25; }
    return 25;
  }

  startDsk(idx, frames) {
    const s = this.find('DskS', { Index: idx });
    if (!s || this.animations.has(`dsk${idx}`)) return;
    const from = s.data[1] ? 1 : 0;
    this.animations.set(`dsk${idx}`, { kind: 'dsk', idx, frames, start: Date.now(), to: from ? 0 : 1 });
  }

  // Advances running transitions; called 50 times a second.
  step() {
    const now = Date.now();
    for (const [key, a] of this.animations) {
      const total = (a.frames / this.fps) * 1000;
      const p = Math.min(1, (now - a.start) / total);
      const remaining = Math.max(0, Math.round(a.frames * (1 - p)));
      if (a.kind === 'me') {
        const ps = this.find('TrPs', { Index: a.me });
        if (ps) {
          ps.data[1] = p < 1 ? 1 : 0;
          ps.data[2] = p < 1 ? remaining : 0;
          ps.data.writeUInt16BE(p < 1 ? Math.round(p * 10000) : 0, 4);
          this.touch(ps);
        }
        if (p >= 1) { this.animations.delete(key); this.completeTransition(a.me); }
      } else if (a.kind === 'ftb') {
        const s = this.find('FtbS', { Index: a.me });
        if (s) {
          s.data[2] = p < 1 ? 1 : 0;
          s.data[3] = p < 1 ? remaining : 0;
          if (p >= 1) s.data[1] = a.to;
          this.touch(s);
        }
        if (p >= 1) this.animations.delete(key);
      } else if (a.kind === 'dsk') {
        const s = this.find('DskS', { Index: a.idx });
        if (s) {
          const v8 = s.data.length >= 8 && this.spec.toClient.DskS.fields.some((f) => f.name === 'IsTowardsOnAir');
          s.data[1] = p < 1 ? 1 : a.to;
          s.data[2] = p < 1 ? 1 : 0;
          s.data[3] = p < 1 ? 1 : 0;
          if (v8) { s.data[4] = p < 1 && a.to ? 1 : 0; s.data[5] = p < 1 ? remaining : 0; } else s.data[4] = p < 1 ? remaining : 0;
          this.touch(s);
        }
        if (p >= 1) this.animations.delete(key);
      }
    }
  }

  // ------------------------------------------------------------ macros

  macroProps(index, used, name = '', description = '') {
    const n = Buffer.from(name, 'utf8');
    const d = Buffer.from(description, 'utf8');
    const buf = Buffer.alloc(pad4(8 + n.length + d.length));
    buf.writeUInt16BE(index, 0);
    buf[2] = used ? 1 : 0;
    buf.writeUInt16BE(n.length, 4);
    buf.writeUInt16BE(d.length, 6);
    n.copy(buf, 8);
    d.copy(buf, 8 + n.length);
    this.put('MPrp', buf);
  }

  readMacroProps(index) {
    const rec = this.find('MPrp', { Index: index });
    if (!rec) return { name: '', description: '' };
    const nl = rec.data.readUInt16BE(4);
    const dl = rec.data.readUInt16BE(6);
    return { used: rec.data[2] === 1, name: rec.data.toString('utf8', 8, 8 + nl), description: rec.data.toString('utf8', 8 + nl, 8 + nl + dl) };
  }

  recorderStatus(recording, index) {
    const b = Buffer.alloc(4);
    b[0] = recording ? 1 : 0;
    b.writeUInt16BE(recording ? index : 0xffff, 2);
    this.put('MRcS', b);
  }

  playerStatus() {
    const b = Buffer.alloc(4);
    const prev = this.find('MRPr');
    const loop = prev ? prev.data[1] : 0;
    if (this.player) {
      b[0] = 1 | (this.player.waiting ? 2 : 0);
      b.writeUInt16BE(this.player.index, 2);
    }
    b[1] = loop;
    this.put('MRPr', b);
  }

  // Turns a command into the macro operations the switcher would record.
  record(name, data) {
    const set = this.spec.toServer[name];
    if (!set || !set.macroOps) return;
    const mask = set.maskField ? readField(data, { ...set.maskField, args: [] }) : null;
    for (const m of set.macroOps) {
      if (!m.op) continue;
      if (m.when && set.mask && !(mask & set.mask[m.when])) continue;
      const op = this.spec.macroOps[m.op];
      if (!op) continue;
      const buf = Buffer.alloc(op.len);
      buf.writeUInt16LE(op.len, 0);
      buf.writeUInt16LE(op.id, 2);
      for (const of of op.fields) {
        const expr = m.assign[of.name];
        const sf = expr && set.fields.find((f) => f.name === expr);
        if (sf) writeField(buf, of, readField(data, sf), true);
      }
      this.recorder.ops.push(buf);
    }
  }

  pushOp(name, fields = {}) {
    const id = this.spec.macroOpIds[name];
    const op = this.spec.macroOps[name];
    const len = op ? op.len : 4;
    const buf = Buffer.alloc(len);
    buf.writeUInt16LE(len, 0);
    buf.writeUInt16LE(id, 2);
    if (op) for (const f of op.fields) if (fields[f.name] !== undefined) writeField(buf, f, fields[f.name], true);
    this.recorder.ops.push(buf);
  }

  async runMacro(index) {
    const blob = this.macros[index];
    if (!blob) return;
    this.stopMacro();
    const player = { index, waiting: false, stopped: false, wake: null };
    this.player = player;
    this.playerStatus();
    const loop = () => { const r = this.find('MRPr'); return r && r.data[1]; };
    do {
      for (const op of splitOps(blob)) {
        if (player.stopped) break;
        const id = op.readUInt16LE(2);
        const def = this.spec.macroById[id];
        if (def && def.name === 'MacroSleep') {
          const frames = readField(op, def.fields.find((f) => f.name === 'Frames'), true);
          await new Promise((res) => { const t = setTimeout(res, (frames / this.fps) * 1000); player.wake = () => { clearTimeout(t); res(); }; });
        } else if (id === this.spec.macroOpIds.MacroUserWait) {
          player.waiting = true;
          this.playerStatus();
          await new Promise((res) => { player.wake = res; });
          player.waiting = false;
          if (!player.stopped) this.playerStatus();
        } else {
          const cmd = this.opToCommand(op, def);
          if (cmd) this.handle(null, [cmd], { fromMacro: true });
        }
      }
    } while (!player.stopped && loop());
    if (this.player === player) { this.player = null; this.playerStatus(); }
  }

  stopMacro() {
    if (!this.player) return;
    this.player.stopped = true;
    if (this.player.wake) this.player.wake();
    this.player = null;
    this.playerStatus();
  }

  opToCommand(op, def) {
    if (!def || !def.toCommand || !def.toCommand.command) {
      this.log(`Macro op ${def ? def.name : op.readUInt16LE(2)} is not supported in playback`);
      return null;
    }
    const cls = this.spec.classes[def.toCommand.command];
    if (!cls || !cls.len) return null;
    const data = Buffer.alloc(cls.len);
    if (cls.maskField && cls.mask) {
      const flags = def.toCommand.mask || Object.keys(def.toCommand.assign);
      writeField(data, { ...cls.maskField, args: [] }, flags.reduce((m, f) => m | (cls.mask[f] || 0), 0));
    }
    for (const [cmdProp, opProp] of Object.entries(def.toCommand.assign)) {
      const cf = cls.fields.find((f) => f.name === cmdProp);
      const of = def.fields.find((f) => f.name === opProp);
      if (cf && of) copyField(op, of, data, cf, true, false);
    }
    return { name: cls.raw, data };
  }

  // ------------------------------------------------------------ media / transfers

  transferData(store, index) {
    if (store === MACRO_STORE) return this.macros[index] || null;
    const m = this.media[`${store}:${index}`];
    return m ? m.data : null;
  }

  finishUpload(t) {
    const data = Buffer.concat(t.chunks).subarray(0, t.size);
    if (t.store === MACRO_STORE) {
      this.macros[t.index] = data;
      const props = this.readMacroProps(t.index);
      this.macroProps(t.index, true, props.name || t.name || '', props.description || '');
    } else {
      this.media[`${t.store}:${t.index}`] = { data, name: t.name || '', hash: t.hash || '' };
      if (t.store === 0) this.put('MPfe', stillEntry(0, t.index, { hash: t.hash, name: t.name }));
    }
    this.dirty();
  }
}

// ------------------------------------------------------------ command handlers
// Return false when the command should not be recorded into a macro.

const HANDLERS = {
  // Switching
  DCut(d) {
    const me = d[0];
    if (this.animations.has(`me${me}`)) return;
    this.completeTransition(me);
    this.tieDsks(me, 0);
  },
  DAut(d) {
    const me = d[0];
    if (this.animations.has(`me${me}`)) return;
    const frames = this.transitionFrames(me);
    const ss = this.find('TrSS', { Index: me });
    if (ss) { ss.data[1] = ss.data[3]; this.touch(ss); }
    this.animations.set(`me${me}`, { kind: 'me', me, frames, start: Date.now() });
    this.tieDsks(me, frames);
  },
  CTPs(d) {
    const me = d[0];
    const pos = d.readUInt16BE(2);
    const ps = this.find('TrPs', { Index: me });
    if (!ps) return;
    if (pos >= 10000) {
      ps.data[1] = 0; ps.data[2] = 0; ps.data.writeUInt16BE(0, 4);
      this.touch(ps);
      this.completeTransition(me);
      return;
    }
    ps.data[1] = pos > 0 ? 1 : 0;
    ps.data.writeUInt16BE(pos, 4);
    this.touch(ps);
  },
  FtbA(d) {
    const me = d[0];
    if (this.animations.has(`ftb${me}`)) return;
    const s = this.find('FtbS', { Index: me });
    const p = this.find('FtbP', { Index: me });
    if (!s) return;
    this.animations.set(`ftb${me}`, { kind: 'ftb', me, frames: p ? p.data[1] || 25 : 25, start: Date.now(), to: s.data[1] ? 0 : 1 });
  },
  FCut(d) {
    const s = this.find('FtbS', { Index: d[0] });
    if (s) { s.data[1] = s.data[1] ? 0 : 1; this.touch(s); }
  },
  DDsA(d) {
    const idx = this.spec.toServer.DDsA.fields.find((f) => f.name === 'Index').off;
    const k = d[idx];
    const p = this.find('DskP', { Index: k });
    this.startDsk(k, p ? p.data[2] || 25 : 25);
  },

  // Macros
  MSRc(d) {
    const index = d.readUInt16BE(0);
    const nl = d.readUInt16BE(2);
    const dl = d.readUInt16BE(4);
    this.stopMacro();
    this.recorder = { index, name: d.toString('utf8', 6, 6 + nl), description: d.toString('utf8', 6 + nl, 6 + nl + dl), ops: [] };
    this.recorderStatus(true, index);
    return false;
  },
  MSlp(d) {
    if (this.recorder) this.pushOp('MacroSleep', { Frames: d.readUInt16BE(2) });
    return false;
  },
  MAct(d) {
    const index = d.readUInt16BE(0);
    switch (d[2]) {
      case 0: this.runMacro(index); break;
      case 1: this.stopMacro(); break;
      case 2:
        if (this.recorder) {
          const r = this.recorder;
          this.recorder = null;
          this.macros[r.index] = Buffer.concat(r.ops);
          this.macroProps(r.index, true, r.name, r.description);
          this.recorderStatus(false);
          this.log(`Recorded macro ${r.index + 1} "${r.name}" (${r.ops.length} steps)`);
        }
        break;
      case 3: if (this.recorder) this.pushOp('MacroUserWait'); break;
      case 4: if (this.player && this.player.waiting && this.player.wake) this.player.wake(); break;
      case 5: delete this.macros[index]; this.macroProps(index, false); break;
    }
    this.dirty();
    return false;
  },
  CMPr(d) {
    const mask = d[0];
    const index = d.readUInt16BE(2);
    const nl = d.readUInt16BE(4);
    const dl = d.readUInt16BE(6);
    const cur = this.readMacroProps(index);
    const name = mask & 1 ? d.toString('utf8', 8, 8 + nl) : cur.name;
    const description = mask & 2 ? d.toString('utf8', 8 + nl, 8 + nl + dl) : cur.description;
    this.macroProps(index, cur.used || !!this.macros[index], name, description);
    return false;
  },
  MRCP(d) {
    const r = this.find('MRPr');
    if (r && d[0] & 1) { r.data[1] = d[1]; this.touch(r); }
    return false;
  },

  // Locks and file transfers
  LOCK(d, client) {
    const index = d.readUInt16BE(0);
    const locked = d[2] === 1;
    const st = Buffer.alloc(4);
    st.writeUInt16BE(index, 0);
    st[2] = locked ? 1 : 0;
    if (locked) this.out('LKOB', Buffer.from([index >> 8, index & 0xff, 0, 0]), client);
    this.out('LKST', st);
    return false;
  },
  FTSD(d, client) {
    const t = { id: d.readUInt16BE(0), store: d.readUInt16BE(2), index: d.readUInt16BE(6), size: d.readInt32BE(8), chunks: [], received: 0, pending: 0, client };
    this.transfers.set(t.id, t);
    this.continueUpload(t);
    return false;
  },
  FTFD(d) {
    const t = this.transfers.get(d.readUInt16BE(0));
    if (t) {
      t.name = d.toString('utf8', 2, 66).replace(/\0.*$/s, '');
      t.description = d.toString('utf8', 66, 194).replace(/\0.*$/s, '');
      t.hash = d.subarray(194, 210).toString('hex');
    }
    return false;
  },
  FTDa(d, client) {
    const t = this.transfers.get(d.readUInt16BE(0));
    if (!t) return false;
    const size = d.readUInt16BE(2);
    if (t.download) return false;
    t.chunks.push(Buffer.from(d.subarray(4, 4 + size)));
    t.received += size;
    t.pending--;
    if (t.received >= t.size) {
      this.transfers.delete(t.id);
      this.finishUpload(t);
      this.out('FTDC', Buffer.from([t.id >> 8, t.id & 0xff, 0, 0]), client);
    } else if (t.pending <= 0) this.continueUpload(t);
    return false;
  },
  FTSU(d, client) {
    const id = d.readUInt16BE(0);
    const store = d.readUInt16BE(2);
    const index = d.readUInt16BE(6);
    const data = this.transferData(store, index);
    if (!data) {
      this.out('FTDE', Buffer.from([id >> 8, id & 0xff, 2, 0]), client);
      return false;
    }
    const t = { id, download: true, data, offset: 0, client };
    this.transfers.set(id, t);
    this.sendDownloadChunk(t);
    return false;
  },
  FTUA(d) {
    const t = this.transfers.get(d.readUInt16BE(0));
    if (t && t.download) this.sendDownloadChunk(t);
    return false;
  },
  FTAD(d) { this.transfers.delete(d.readUInt16BE(0)); return false; },

  // Media pool bookkeeping
  SMPS(d) {
    const index = d[0];
    const m = this.media[`0:${index}`];
    if (m) { m.name = d.toString('utf8', 1, 65).replace(/\0.*$/s, ''); this.put('MPfe', stillEntry(0, index, m)); }
    return false;
  },
  CSTL(d) { delete this.media[`0:${d[0]}`]; this.put('MPfe', stillEntry(0, d[0], null)); return false; },
  CLMP() {
    for (const k of Object.keys(this.media)) if (k.startsWith('0:')) { delete this.media[k]; this.put('MPfe', stillEntry(0, Number(k.slice(2)), null)); }
    return false;
  },

  // Housekeeping clients send that need a reply or nothing at all
  TiRq(d, client) {
    const now = new Date();
    const t = Buffer.alloc(8);
    t[0] = now.getHours(); t[1] = now.getMinutes(); t[2] = now.getSeconds();
    t[3] = Math.floor((now.getMilliseconds() / 1000) * this.fps);
    this.out('Time', t, client);
    return false;
  },
  SRsv() { return false; },
  SRcl() { return false; },
  CCmd() { return false; },
  CCdo() { return false; },
  SToD() { return false; },
  TlMe() { return false; },
  DSTR() { return false; },
  RAMP() { return false; },
  RFLP() { return false; },
  RFIP() { return false; },
  SALN() { return false; },
  SFLN() { return false; },
};

Switcher.prototype.continueUpload = function (t) {
  const remaining = Math.ceil((t.size - t.received) / CHUNK);
  const count = Math.max(1, Math.min(20, remaining));
  t.pending = count;
  const b = Buffer.alloc(12);
  b.writeUInt16BE(t.id, 0);
  b.writeUInt16BE(CHUNK, 6);
  b.writeUInt16BE(count, 8);
  this.out('FTCD', b, t.client);
};

Switcher.prototype.sendDownloadChunk = function (t) {
  if (t.offset >= t.data.length) {
    this.transfers.delete(t.id);
    this.out('FTDC', Buffer.from([t.id >> 8, t.id & 0xff, 0, 0]), t.client);
    return;
  }
  const body = t.data.subarray(t.offset, t.offset + CHUNK - 4);
  t.offset += body.length;
  const head = Buffer.alloc(4);
  head.writeUInt16BE(t.id, 0);
  head.writeUInt16BE(body.length, 2);
  this.out('FTDa', Buffer.concat([head, body]), t.client);
};

function pad4(n) { return Math.ceil(n / 4) * 4; }

function emptyMacroProps(index) {
  const b = Buffer.alloc(8);
  b.writeUInt16BE(index, 0);
  return b;
}

function stillEntry(bank, index, m) {
  const name = Buffer.from(m && m.name ? m.name : '', 'utf8');
  const b = Buffer.alloc(pad4(24 + name.length));
  b[0] = bank;
  b.writeUInt16BE(index, 2);
  if (m) {
    b[4] = 1;
    if (m.hash) Buffer.from(m.hash, 'hex').copy(b, 5, 0, 16);
    b.writeUInt16BE(name.length, 22);
    name.copy(b, 24);
  }
  return b;
}

export function splitOps(blob) {
  const ops = [];
  let o = 0;
  while (o + 4 <= blob.length) {
    const len = blob.readUInt16LE(o);
    if (len < 4 || o + len > blob.length) break;
    ops.push(blob.subarray(o, o + len));
    o += len;
  }
  return ops;
}
