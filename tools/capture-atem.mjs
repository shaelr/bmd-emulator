#!/usr/bin/env node
// Records the startup state of a real ATEM switcher so the emulator can
// reproduce that exact model and firmware. Read-only: it connects, receives
// the state every client gets on connect, and leaves. It sends no commands.
//
//   node tools/capture-atem.mjs <switcher-ip> [model-id]
//
// The capture is saved to profiles/<model-id>.data and is used automatically
// the next time you pick that model in the emulator.

import dgram from 'node:dgram';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MODELS } from '../lib/atem/models.mjs';
import { parseCommands } from '../lib/atem/codec.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const [ip, modelArg] = process.argv.slice(2);
if (!ip) {
  console.log('Usage: node tools/capture-atem.mjs <switcher-ip> [model-id]');
  console.log('Model ids: node emulator.mjs --list');
  process.exit(1);
}

const F = { ACKREQ: 0x01, HELLO: 0x02, ACK: 0x10 };
const sock = dgram.createSocket('udp4');
const session = 0x1000 + Math.floor(Math.random() * 0x6fff);
const payloads = new Map();
let assigned = session;

function header(flags, len, sess, ackId, pktId) {
  const b = Buffer.alloc(12);
  b.writeUInt16BE((flags << 11) | len, 0);
  b.writeUInt16BE(sess, 2);
  b.writeUInt16BE(ackId, 4);
  b.writeUInt16BE(pktId, 10);
  return b;
}

const timeout = setTimeout(() => { console.error(`No complete answer from ${ip}:9910 within 10 seconds.`); process.exit(1); }, 10000);

sock.on('message', (msg) => {
  const flags = msg[0] >> 3;
  const len = msg.readUInt16BE(0) & 0x7ff;
  const pktId = msg.readUInt16BE(10);
  if (flags & F.HELLO) {
    sock.send(header(F.ACK, 12, msg.readUInt16BE(2), 0, 0), 9910, ip);
    return;
  }
  assigned = msg.readUInt16BE(2);
  if (flags & F.ACKREQ) {
    sock.send(header(F.ACK, 12, assigned, pktId, 0), 9910, ip);
    if (len > 12 && !payloads.has(pktId)) {
      const payload = msg.subarray(12, len);
      payloads.set(pktId, payload);
      if (parseCommands(payload).some((c) => c.name === 'InCm')) finish();
    }
  }
});

function finish() {
  clearTimeout(timeout);
  const ordered = [...payloads.entries()].sort((a, b) => a[0] - b[0]).map(([, p]) => p);
  const cmds = ordered.flatMap((p) => parseCommands(p));
  const pin = cmds.find((c) => c.name === '_pin');
  const ver = cmds.find((c) => c.name === '_ver');
  const name = pin ? pin.data.toString('utf8', 0, 40).replace(/\0.*$/s, '') : 'unknown';
  const model = modelArg ? MODELS.find((m) => m.id === modelArg) : MODELS.find((m) => m.name === name);
  if (!model) {
    console.error(`Captured "${name}", which isn't in the model list. Pass the model id to save it anyway.`);
    process.exit(1);
  }
  const dir = path.join(ROOT, 'profiles');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${model.id}.data`);
  fs.writeFileSync(file, ordered.map((p) => p.toString('hex')).join('\n'));
  const v = ver ? `${ver.data.readUInt16BE(0)}.${ver.data.readUInt16BE(2)}` : '?';
  console.log(`Captured ${name} (protocol ${v}, ${cmds.length} settings) -> ${path.relative(ROOT, file)}`);
  console.log(`The emulator now uses this capture for "${model.name}".`);
  process.exit(0);
}

sock.bind(() => {
  console.log(`Connecting to ${ip} (read-only)…`);
  sock.send(Buffer.concat([header(F.HELLO, 20, session, 0, 0), Buffer.from([1, 0, 0, 0, 0, 0, 0, 0])]), 9910, ip);
});
