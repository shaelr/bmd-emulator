// Emulated Blackmagic Videohub speaking the Videohub Ethernet Protocol on TCP 9990.
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

export const VIDEOHUB_MODELS = [
  { id: 'micro', name: 'Blackmagic Micro Videohub', inputs: 16, outputs: 16 },
  { id: 'smart', name: 'Blackmagic Smart Videohub', inputs: 16, outputs: 16 },
  { id: 'smart-12', name: 'Blackmagic Smart Videohub 12 x 12', inputs: 12, outputs: 12 },
  { id: 'smart-20', name: 'Blackmagic Smart Videohub 20 x 20', inputs: 20, outputs: 20 },
  { id: 'smart-40', name: 'Blackmagic Smart Videohub 40 x 40', inputs: 40, outputs: 40 },
  { id: 'smart-12g-40', name: 'Smart Videohub 12G 40x40', inputs: 40, outputs: 40 },
  { id: 'cleanswitch-12', name: 'Smart Videohub CleanSwitch 12x12', inputs: 12, outputs: 12 },
  { id: 'compact', name: 'Blackmagic Compact Videohub', inputs: 40, outputs: 40 },
  { id: 'studio', name: 'Blackmagic Studio Videohub', inputs: 16, outputs: 16 },
  { id: 'broadcast', name: 'Blackmagic Broadcast Videohub', inputs: 72, outputs: 72 },
  { id: 'universal-72', name: 'Blackmagic Universal Videohub', inputs: 72, outputs: 72 },
  { id: 'universal-288', name: 'Blackmagic Universal Videohub 288', inputs: 288, outputs: 288 },
  { id: '10x10-12g', name: 'Blackmagic Videohub 10x10 12G', inputs: 10, outputs: 10 },
  { id: '20x20-12g', name: 'Blackmagic Videohub 20x20 12G', inputs: 20, outputs: 20 },
  { id: '40x40-12g', name: 'Blackmagic Videohub 40x40 12G', inputs: 40, outputs: 40 },
  { id: '80x80-12g', name: 'Blackmagic Videohub 80x80 12G', inputs: 80, outputs: 80 },
  { id: '120x120-12g', name: 'Blackmagic Videohub 120x120 12G', inputs: 120, outputs: 120 },
];

const OPTIONAL_BLOCKS = new Set([
  'MONITORING OUTPUT LABELS', 'MONITORING OUTPUT LOCKS', 'VIDEO MONITORING OUTPUT ROUTING',
  'SERIAL PORT LABELS', 'SERIAL PORT ROUTING', 'SERIAL PORT LOCKS', 'SERIAL PORT DIRECTIONS', 'SERIAL PORT STATUS',
  'PROCESSING UNIT ROUTING', 'PROCESSING UNIT LOCKS', 'FRAME LABELS', 'FRAME BUFFER ROUTING', 'FRAME BUFFER LOCKS',
  'VIDEO INPUT STATUS', 'VIDEO OUTPUT STATUS', 'ALARM STATUS', 'INPUT MAPPING', 'OUTPUT MAPPING', 'ENGINEERING',
]);

const block = (header, lines) => `${header}:\n${lines.join('\n')}${lines.length ? '\n' : ''}\n`;

export class VideohubServer extends EventEmitter {
  constructor({ model, inputs, outputs, friendlyName, port = 9990, host = '127.0.0.1', stateFile, log = () => {} }) {
    super();
    this.model = model;
    this.port = port;
    this.host = host;
    this.stateFile = stateFile;
    this.log = log;
    this.clients = new Set();
    this.state = this.restore(inputs, outputs) || {
      inputLabels: Array.from({ length: inputs }, (_, i) => `Input ${i + 1}`),
      outputLabels: Array.from({ length: outputs }, (_, i) => `Output ${i + 1}`),
      routing: Array.from({ length: outputs }, (_, i) => i % inputs),
      takeMode: new Array(outputs).fill(false),
    };
    this.inputs = inputs;
    this.outputs = outputs;
    this.lockOwner = new Array(outputs).fill(null); // socket that holds each output's lock
    this.friendlyName = friendlyName || model.replace(/^Blackmagic /, '');
    this.uniqueId = crypto.createHash('md5').update('bmd-emulator:' + model).digest('hex').slice(0, 12).toUpperCase();
  }

  restore(inputs, outputs) {
    if (!this.stateFile || !fs.existsSync(this.stateFile)) return null;
    try {
      const s = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
      if (s.inputLabels.length !== inputs || s.outputLabels.length !== outputs) return null;
      s.takeMode = s.takeMode || new Array(outputs).fill(false);
      return s;
    } catch { return null; }
  }

  save() {
    if (!this.stateFile) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
      const { inputLabels, outputLabels, routing, takeMode } = this.state;
      fs.writeFileSync(this.stateFile, JSON.stringify({ inputLabels, outputLabels, routing, takeMode }, null, 1));
    }, 300);
  }

  // Lock state as one client sees it: O = locked by you, L = by someone else.
  lockLetter(o, sock) { const w = this.lockOwner[o]; return !w ? 'U' : w === sock ? 'O' : 'L'; }

  dumps(sock) {
    const s = this.state;
    return {
      'INPUT LABELS': () => s.inputLabels.map((l, i) => `${i} ${l}`),
      'OUTPUT LABELS': () => s.outputLabels.map((l, i) => `${i} ${l}`),
      'VIDEO OUTPUT LOCKS': () => this.lockOwner.map((_, o) => `${o} ${this.lockLetter(o, sock)}`),
      'VIDEO OUTPUT ROUTING': () => s.routing.map((r, o) => `${o} ${r}`),
      'CONFIGURATION': () => ['Take Mode: false'],
    };
  }

  prelude(sock) {
    const d = this.dumps(sock);
    return block('PROTOCOL PREAMBLE', ['Version: 2.8']) +
      block('VIDEOHUB DEVICE', [
        'Device present: true', `Model name: ${this.model}`, `Friendly name: ${this.friendlyName}`, `Unique ID: ${this.uniqueId}`,
        `Video inputs: ${this.inputs}`, 'Video processing units: 0', `Video outputs: ${this.outputs}`,
        'Video monitoring outputs: 0', 'Serial ports: 0']) +
      Object.entries(d).map(([h, f]) => block(h, f())).join('') +
      block('END PRELUDE', []);
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = net.createServer((sock) => this.accept(sock));
      this.server.once('error', reject);
      this.server.listen(this.port, this.host, () => { this.server.off('error', reject); resolve(); });
    });
  }

  stop() {
    for (const c of this.clients) c.destroy();
    this.clients.clear();
    clearTimeout(this.saveTimer);
    if (this.stateFile) this.save();
    return new Promise((res) => (this.server ? this.server.close(() => res()) : res()));
  }

  get clientList() { return [...this.clients].map((c) => ({ address: c.remoteAddress?.replace(/^::ffff:/, '') })); }

  broadcast(text) { for (const c of this.clients) c.write(text); }

  accept(sock) {
    this.clients.add(sock);
    this.log(`Videohub client connected: ${sock.remoteAddress?.replace(/^::ffff:/, '')}`);
    this.emit('clients');
    sock.setEncoding('utf8');
    sock.write(this.prelude(sock));
    let buf = '';
    let cur = null;
    sock.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, '');
        buf = buf.slice(nl + 1);
        if (!cur) {
          const m = line.match(/^([A-Z][A-Z0-9 ]*):\s*$/);
          if (m) cur = { header: m[1], lines: [] };
          continue;
        }
        if (line !== '') { cur.lines.push(line); continue; }
        const { header, lines } = cur;
        cur = null;
        const res = this.handle(header, lines, sock);
        if (this.debug || res === null || (!lines.length && header !== 'PING')) this.log(`Videohub ${res === null ? 'rejected' : 'received'} ${header}: ${lines.slice(0, 3).join(' | ')}${lines.length > 3 ? ` (+${lines.length - 3} lines)` : ''}`);
        if (res === null) { sock.write('NAK\n\n'); continue; }
        sock.write('ACK\n\n');
        if (res.self) sock.write(res.self);
        if (res.all) this.broadcast(res.all);
        if (res.locks) for (const c of this.clients) c.write(block('VIDEO OUTPUT LOCKS', res.locks.map((o) => `${o} ${this.lockLetter(o, c)}`)));
      }
    });
    const gone = () => {
      if (!this.clients.delete(sock)) return;
      const freed = [];
      this.lockOwner.forEach((w, o) => { if (w === sock) { this.lockOwner[o] = null; freed.push(o); } });
      for (const c of this.clients) if (freed.length) c.write(block('VIDEO OUTPUT LOCKS', freed.map((o) => `${o} U`)));
      this.log('Videohub client disconnected');
      this.emit('clients');
    };
    sock.on('close', gone);
    sock.on('error', gone);
  }

  // Returns { self, all, locks } to send, or null to NAK.
  handle(header, lines, sock) {
    const s = this.state;
    const d = this.dumps(sock);
    if (header === 'PING') return {};
    if (!lines.length) {
      if (d[header]) return { self: block(header, d[header]()) };
      if (header === 'VIDEOHUB DEVICE') return { self: this.prelude(sock).split('\n\n')[1] + '\n\n' };
      // Blocks for hardware this hub doesn't have: answer with an empty block.
      if (OPTIONAL_BLOCKS.has(header)) return { self: block(header, []) };
      return null;
    }
    const changed = [];
    const locks = [];
    for (const line of lines) {
      if (header === 'CONFIGURATION') { changed.push(line); continue; }
      const m = line.match(/^(\d+) ?(.*)$/);
      if (!m) return null;
      const idx = Number(m[1]);
      const val = m[2];
      if (header === 'INPUT LABELS' && idx < this.inputs) { s.inputLabels[idx] = val; changed.push(line); }
      else if (header === 'OUTPUT LABELS' && idx < this.outputs) { s.outputLabels[idx] = val; changed.push(line); }
      else if (header === 'VIDEO OUTPUT ROUTING' && idx < this.outputs && Number(val) < this.inputs) {
        if (this.lockOwner[idx] && this.lockOwner[idx] !== sock) continue;
        s.routing[idx] = Number(val);
        changed.push(`${idx} ${s.routing[idx]}`);
      } else if (header === 'VIDEO OUTPUT LOCKS' && idx < this.outputs && /^[OUF]$/.test(val)) {
        const owner = this.lockOwner[idx];
        if (val === 'O' && (!owner || owner === sock)) this.lockOwner[idx] = sock;
        else if (val === 'U' && owner === sock) this.lockOwner[idx] = null;
        else if (val === 'F') this.lockOwner[idx] = null;
        else continue;
        locks.push(idx);
      } else if (!d[header]) return null;
    }
    if (changed.length) { this.save(); this.emit('change', header); }
    return { all: changed.length && header !== 'VIDEO OUTPUT LOCKS' ? block(header, changed) : '', locks: locks.length ? locks : null };
  }
}
