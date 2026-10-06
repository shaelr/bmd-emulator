#!/usr/bin/env node
// A software Videohub that speaks the Videohub Ethernet Protocol on TCP 9990.
// Use it to rehearse tools/videohub-push.mjs, or to point any Videohub
// controller (Bitfocus Companion, etc.) at your computer instead of the hardware.
//
//   node tools/videohub-sim.mjs [--inputs 12] [--outputs 12] [--port 9990] [--model "Smart Videohub 12x12"]

import net from 'node:net';

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : def; };
const INPUTS = parseInt(opt('inputs', '12'), 10);
const OUTPUTS = parseInt(opt('outputs', '12'), 10);
const PORT = parseInt(opt('port', '9990'), 10);
const MODEL = opt('model', `Blackmagic Smart Videohub ${INPUTS} x ${OUTPUTS}`);

const state = {
  inputLabels: Array.from({ length: INPUTS }, (_, i) => `Input ${i + 1}`),
  outputLabels: Array.from({ length: OUTPUTS }, (_, i) => `Output ${i + 1}`),
  routing: Array.from({ length: OUTPUTS }, (_, i) => i % INPUTS),
  locks: new Array(OUTPUTS).fill('U'),
};

const block = (header, lines) => `${header}:\n${lines.join('\n')}${lines.length ? '\n' : ''}\n`;
const dumps = {
  'INPUT LABELS': () => state.inputLabels.map((l, i) => `${i} ${l}`),
  'OUTPUT LABELS': () => state.outputLabels.map((l, i) => `${i} ${l}`),
  'VIDEO OUTPUT ROUTING': () => state.routing.map((r, o) => `${o} ${r}`),
  'VIDEO OUTPUT LOCKS': () => state.locks.map((l, o) => `${o} ${l}`),
};

function prelude() {
  return block('PROTOCOL PREAMBLE', ['Version: 2.3']) +
    block('VIDEOHUB DEVICE', ['Device present: true', `Model name: ${MODEL}`, `Video inputs: ${INPUTS}`,
      'Video processing units: 0', `Video outputs: ${OUTPUTS}`, 'Video monitoring outputs: 0', 'Serial ports: 0']) +
    Object.entries(dumps).map(([h, f]) => block(h, f())).join('') +
    block('END PRELUDE', []);
}

const clients = new Set();
const broadcast = (text) => { for (const c of clients) c.write(text); };

// Applies a request block. Returns the status update to broadcast, '' for none, or null to NAK.
function handle(header, lines) {
  if (header === 'PING') return '';
  if (!lines.length) return dumps[header] ? block(header, dumps[header]()) : null;
  const changed = [];
  for (const line of lines) {
    const m = line.match(/^(\d+) (.*)$/);
    if (!m) return null;
    const idx = parseInt(m[1], 10);
    const val = m[2];
    if (header === 'INPUT LABELS' && idx < INPUTS) state.inputLabels[idx] = val;
    else if (header === 'OUTPUT LABELS' && idx < OUTPUTS) state.outputLabels[idx] = val;
    else if (header === 'VIDEO OUTPUT ROUTING' && idx < OUTPUTS && parseInt(val, 10) < INPUTS) state.routing[idx] = parseInt(val, 10);
    else if (header === 'VIDEO OUTPUT LOCKS' && idx < OUTPUTS && /^[OUF]$/.test(val)) state.locks[idx] = val === 'F' ? 'U' : val;
    else if (!dumps[header]) return null;
    else continue;
    changed.push(header === 'VIDEO OUTPUT LOCKS' ? `${idx} ${state.locks[idx]}` : line);
  }
  console.log(`${header}: ${changed.length} change(s)`);
  for (const l of changed) console.log('   ' + l);
  return changed.length ? block(header, changed) : '';
}

net.createServer((sock) => {
  clients.add(sock);
  console.log(`+ client ${sock.remoteAddress}`);
  sock.setEncoding('utf8');
  sock.write(prelude());
  let buf = '';
  let cur = null;
  sock.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, '');
      buf = buf.slice(nl + 1);
      if (!cur) {
        const m = line.match(/^([A-Z][A-Z0-9 ]*):$/);
        if (m) cur = { header: m[1], lines: [] };
        continue;
      }
      if (line !== '') { cur.lines.push(line); continue; }
      const update = handle(cur.header, cur.lines);
      cur = null;
      if (update === null) { sock.write('NAK\n\n'); continue; }
      sock.write('ACK\n\n');
      if (update) broadcast(update);
    }
  });
  sock.on('close', () => { clients.delete(sock); console.log(`- client ${sock.remoteAddress}`); });
  sock.on('error', () => clients.delete(sock));
}).listen(PORT, () => console.log(`Videohub simulator (${INPUTS}x${OUTPUTS}) listening on port ${PORT}`));
