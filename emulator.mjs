#!/usr/bin/env node
// BMD Emulator: pretend ATEM switchers and Videohub routers for programming a
// show in Blackmagic's own software without the hardware.
//
//   node emulator.mjs                 open the control panel (http://localhost:9900)
//   node emulator.mjs --atem mini-pro --videohub 40x40-12g --no-browser
//   node emulator.mjs --list          list model ids
//   node emulator.mjs --data <dir>    keep saved state in <dir>

import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Switcher } from './lib/atem/switcher.mjs';
import { AtemServer } from './lib/atem/server.mjs';
import { MODELS, loadModel, modelSource } from './lib/atem/models.mjs';
import { VideohubServer, VIDEOHUB_MODELS } from './lib/videohub/server.mjs';
import { Announcement, stableId } from './lib/bonjour.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const BMD_VIDEOHUB_SERVER = '/Library/LaunchDaemons/com.blackmagic-design.videohub.server.plist';

const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : undefined; };
// --data <dir> keeps saved state and captured switchers elsewhere (the menu bar app
// uses ~/Library/Application Support/BMD Emulator); otherwise next to this file.
const DATA = opt('data') ? path.resolve(opt('data')) : path.join(ROOT, 'data');
const USER_PROFILES = opt('data') ? path.join(DATA, 'profiles') : path.join(ROOT, 'profiles');
const SETTINGS = path.join(DATA, 'settings.json');
const PANEL_PORT = Number(opt('port') || 9900);

if (args.includes('--list')) {
  console.log('ATEM models:');
  for (const m of MODELS) console.log(`  ${m.id.padEnd(22)} ${m.name}`);
  console.log('\nVideohub models:');
  for (const m of VIDEOHUB_MODELS) console.log(`  ${m.id.padEnd(22)} ${m.name} (${m.inputs}x${m.outputs})`);
  process.exit(0);
}

// ------------------------------------------------------------ logging

const logLines = [];
let logCount = 0; // total lines ever logged, so clients can ask for what's new
const listeners = new Set();
function log(msg) {
  const line = `${new Date().toLocaleTimeString()}  ${msg}`;
  console.log(line);
  logLines.push(line);
  logCount++;
  if (logLines.length > 500) logLines.shift();
  push({ type: 'log', line });
}
function push(evt) { for (const res of listeners) res.write(`data: ${JSON.stringify(evt)}\n\n`); }
const changed = () => push({ type: 'status' });

function readSettings() { try { return JSON.parse(fs.readFileSync(SETTINGS, 'utf8')); } catch { return {}; } }
function writeSettings(patch) {
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(SETTINGS, JSON.stringify({ ...readSettings(), ...patch }, null, 1));
}

// Off by default: the emulators listen and announce on this Mac only, so they
// never show up in other operators' software on a production network.
const networkOn = () => !!readSettings().network;
const bindHost = () => (networkOn() ? '0.0.0.0' : '127.0.0.1');

// ------------------------------------------------------------ ATEM

let atem = null;

async function startAtem(id) {
  await stopAtem();
  const loaded = loadModel(id, USER_PROFILES);
  const m = loaded.model;
  const switcher = new Switcher({
    profile: loaded.profile,
    transform: loaded.transform,
    stateFile: path.join(DATA, `atem-${m.id}.json`),
    log,
  });
  const server = new AtemServer({ port: 9910, host: bindHost(), switcher, log });
  try {
    await server.start();
  } catch (e) {
    switcher.close();
    throw new Error(e.code === 'EADDRINUSE' ? 'UDP port 9910 is already in use. Is another emulator running?' : e.message);
  }
  const bonjour = new Announcement(log);
  const name = `${m.name} (Emulator)`;
  const txt = { txtvers: 1, class: 'AtemSwitcher', 'device name': name, 'unique id': stableId(m.id) };
  bonjour.start([
    { name, type: '_blackmagic._tcp', port: 9910, txt },
    { name, type: '_switcher_ctrl._udp', port: 9910, txt },
  ], { localOnly: !networkOn() });
  server.on('clients', changed);
  switcher.on('unhandled', changed);
  atem = { model: m, source: loaded.source, basedOn: loaded.basedOn, switcher, server, bonjour };
  writeSettings({ atem: m.id });
  log(`ATEM emulator started: ${m.name} (${loaded.source}${loaded.basedOn ? ` from ${loaded.basedOn}` : ''})`);
  changed();
}

async function stopAtem({ remember = false } = {}) {
  if (!atem) return;
  const a = atem;
  atem = null;
  a.bonjour.stop();
  await a.server.stop();
  a.switcher.close();
  if (remember) writeSettings({ atem: null });
  log(`ATEM emulator stopped (${a.model.name})`);
  changed();
}

// ------------------------------------------------------------ Videohub

let videohub = null;

async function startVideohub({ id, inputs, outputs }) {
  await stopVideohub();
  const m = VIDEOHUB_MODELS.find((x) => x.id === id) || { id: 'custom', name: 'Blackmagic Videohub', inputs, outputs };
  const ins = Number(inputs) || m.inputs;
  const outs = Number(outputs) || m.outputs;
  const server = new VideohubServer({ model: m.name, inputs: ins, outputs: outs, host: bindHost(), stateFile: path.join(DATA, `videohub-${m.id}-${ins}x${outs}.json`), log });
  try {
    await server.start();
  } catch (e) {
    if (e.code === 'EADDRINUSE') {
      const err = new Error('TCP port 9990 is in use, usually by the Blackmagic Videohub Server that comes with the Videohub software. Pause it, then start again.');
      err.code = 'BMD_SERVER';
      throw err;
    }
    throw e;
  }
  const bonjour = new Announcement(log);
  // Videohub Control browses _videohub._tcp; Videohub Setup browses _blackmagic._tcp
  // with the _videohub subtype and reads these TXT fields, as a real hub sends them.
  const vhName = `${server.friendlyName} (Emulator)`;
  bonjour.start([
    { name: vhName, type: '_videohub._tcp', port: 9990, txt: {} },
    { name: vhName, type: '_blackmagic._tcp,_videohub', port: 9990, txt: {
      txtvers: 1, name: m.name, class: 'Videohub', 'protocol version': '2.8',
      'unique id': server.uniqueId.toLowerCase(), 'device name': vhName,
    } },
  ], { localOnly: !networkOn() });
  server.on('clients', changed);
  server.on('change', changed);
  videohub = { model: m, inputs: ins, outputs: outs, server, bonjour };
  writeSettings({ videohub: { id: m.id, inputs: ins, outputs: outs } });
  log(`Videohub emulator started: ${m.name} (${ins}x${outs})`);
  changed();
}

async function stopVideohub({ remember = false } = {}) {
  if (!videohub) return;
  const v = videohub;
  videohub = null;
  v.bonjour.stop();
  await v.server.stop();
  if (remember) writeSettings({ videohub: null });
  log(`Videohub emulator stopped (${v.model.name})`);
  changed();
}

// Pauses or resumes Blackmagic's own Videohub Server (needs an admin password).
function bmdVideohubServer(action) {
  const cmd = action === 'stop' ? `launchctl unload ${BMD_VIDEOHUB_SERVER}` : `launchctl load ${BMD_VIDEOHUB_SERVER}`;
  return new Promise((resolve, reject) => {
    execFile('osascript', ['-e', `do shell script "${cmd}" with administrator privileges`], (err, _out, stderr) => {
      if (err) reject(new Error(/User canceled|-128/.test(stderr) ? 'Cancelled.' : stderr.trim() || err.message));
      else resolve();
    });
  });
}

// ------------------------------------------------------------ status

function lanAddresses() {
  return Object.values(os.networkInterfaces()).flat().filter((a) => a && a.family === 'IPv4' && !a.internal).map((a) => a.address);
}

// True when something other than our emulator answers on TCP 9990 (normally
// Blackmagic's own Videohub Server).
function port9990Busy() {
  if (videohub) return Promise.resolve(false);
  return new Promise((resolve) => {
    const s = net.connect(9990, '127.0.0.1');
    const done = (v) => { s.destroy(); resolve(v); };
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
    s.setTimeout(300, () => done(false));
  });
}

async function statusWithPorts() {
  return { ...status(), port9990Busy: await port9990Busy() };
}

function status() {
  return {
    addresses: lanAddresses(),
    network: networkOn(),
    atem: atem && {
      id: atem.model.id,
      name: atem.model.name,
      source: atem.source,
      basedOn: atem.basedOn,
      clients: atem.server.clientList,
      unhandled: [...atem.switcher.unhandled.entries()].map(([name, count]) => ({ name, count })),
      macros: Object.keys(atem.switcher.macros).length,
    },
    videohub: videohub && {
      id: videohub.model.id,
      name: videohub.model.name,
      inputs: videohub.inputs,
      outputs: videohub.outputs,
      clients: videohub.server.clientList,
    },
    bmdVideohubServer: fs.existsSync(BMD_VIDEOHUB_SERVER),
    dataDir: DATA,
  };
}

// ------------------------------------------------------------ control panel

async function body(req) {
  let s = '';
  for await (const chunk of req) s += chunk;
  return s ? JSON.parse(s) : {};
}

const routes = {
  'GET /api/models': () => ({
    atem: MODELS.map((m) => ({ id: m.id, name: m.name, family: m.family, source: fs.existsSync(path.join(USER_PROFILES, `${m.id}.data`)) ? 'captured' : modelSource(m), from: m.from && MODELS.find((x) => x.id === m.from).name })),
    videohub: VIDEOHUB_MODELS,
  }),
  'GET /api/status': () => statusWithPorts(),
  // Lines logged after line number `after` (the menu bar app polls this).
  'GET /api/log': (_b, url) => {
    const after = Number(url.searchParams.get('after') || 0);
    const first = logCount - logLines.length;
    return { lines: logLines.slice(Math.max(0, after - first)), next: logCount };
  },
  'POST /api/atem/start': async (b) => { await startAtem(b.id); return status(); },
  'POST /api/atem/stop': async () => { await stopAtem({ remember: true }); return status(); },
  'POST /api/atem/reset': async () => {
    if (!atem) return status();
    const id = atem.model.id;
    await stopAtem();
    fs.rmSync(path.join(DATA, `atem-${id}.json`), { force: true });
    await startAtem(id);
    log('ATEM emulator reset to factory state');
    return status();
  },
  'POST /api/videohub/start': async (b) => { await startVideohub(b); return status(); },
  'POST /api/videohub/stop': async () => { await stopVideohub({ remember: true }); return status(); },
  'POST /api/videohub/reset': async () => {
    if (!videohub) return status();
    const { model, inputs, outputs } = videohub;
    await stopVideohub();
    fs.rmSync(path.join(DATA, `videohub-${model.id}-${inputs}x${outputs}.json`), { force: true });
    await startVideohub({ id: model.id, inputs, outputs });
    log('Videohub emulator reset');
    return status();
  },
  'POST /api/network': async (b) => {
    writeSettings({ network: !!b.enabled });
    log(b.enabled ? 'Network access on: other computers can see and connect to the emulators.' : 'Network access off: emulators are visible on this Mac only.');
    if (atem) await startAtem(atem.model.id);
    if (videohub) await startVideohub({ id: videohub.model.id, inputs: videohub.inputs, outputs: videohub.outputs });
    return status();
  },
  'POST /api/bmd-videohub-server': async (b) => {
    await bmdVideohubServer(b.action);
    log(`Blackmagic Videohub Server ${b.action === 'stop' ? 'paused' : 'resumed'}`);
    return status();
  },
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(fs.readFileSync(path.join(ROOT, 'web', 'index.html')));
  }
  if (url.pathname === '/api/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write(`data: ${JSON.stringify({ type: 'history', lines: logLines })}\n\n`);
    listeners.add(res);
    req.on('close', () => listeners.delete(res));
    return;
  }
  const route = routes[`${req.method} ${url.pathname}`];
  if (!route) { res.writeHead(404); return res.end(); }
  try {
    const out = await route(req.method === 'POST' ? await body(req) : {}, url);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(out));
  } catch (e) {
    log(`Error: ${e.message}`);
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: e.message, code: e.code }));
  }
});

// ------------------------------------------------------------ startup / shutdown

async function main() {
  await new Promise((resolve, reject) => {
    server.once('error', (e) => reject(e.code === 'EADDRINUSE' ? new Error(`Port ${PANEL_PORT} is in use. Is the emulator already running? Try http://localhost:${PANEL_PORT}`) : e));
    server.listen(PANEL_PORT, '127.0.0.1', resolve);
  });
  const url = `http://localhost:${PANEL_PORT}`;
  log(`Control panel: ${url}`);

  const saved = readSettings();
  const atemId = opt('atem') ?? saved.atem;
  const vh = opt('videohub') ? { id: opt('videohub') } : saved.videohub;
  if (atemId) await startAtem(atemId).catch((e) => log(`ATEM: ${e.message}`));
  if (vh) await startVideohub(vh).catch((e) => log(`Videohub: ${e.message}`));

  if (!args.includes('--no-browser') && process.platform === 'darwin') execFile('open', [url]);
}

let quitting = false;
async function shutdown() {
  if (quitting) process.exit(0);
  quitting = true;
  log('Shutting down…');
  await stopAtem().catch(() => {});
  await stopVideohub().catch(() => {});
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

main().catch((e) => { console.error(e.message); process.exit(1); });
