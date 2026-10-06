#!/usr/bin/env node
// Checks ATEM models against Blackmagic's own Switchers SDK, which is what ATEM
// Software Control uses to connect. A model that passes here connects in the app;
// "state sync failed" or "incompatible firmware" here is what makes the app show
// "Your switcher is running a newer software version".
//
//   node tools/sdk-check.mjs              every model
//   node tools/sdk-check.mjs 2me-const-4k mini-pro
//   node tools/sdk-check.mjs --names ...  also list input names as the SDK sees them
//
// Needs ATEM Software Control installed (for the SDK) and UDP 9910 free, so stop
// the ATEM in the app or emulator first.

import { execFileSync, execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Switcher } from '../lib/atem/switcher.mjs';
import { AtemServer } from '../lib/atem/server.mjs';
import { MODELS, loadModel } from '../lib/atem/models.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SDK = '/Applications/Blackmagic ATEM Switchers/Developer SDK/Mac OS X/include';
const BIN = path.join(ROOT, 'build', 'sdk-connect');

const args = process.argv.slice(2);
const names = args.includes('--names');
const ids = args.filter((a) => !a.startsWith('--'));

if (!fs.existsSync(BIN)) {
  fs.mkdirSync(path.dirname(BIN), { recursive: true });
  execFileSync('clang++', ['-std=c++17', '-I', SDK, path.join(ROOT, 'tools', 'sdk-connect.cpp'),
    path.join(SDK, 'BMDSwitcherAPIDispatch.cpp'), '-framework', 'CoreFoundation', '-o', BIN], { stdio: 'inherit' });
}

let failed = 0;
for (const m of MODELS.filter((x) => !ids.length || ids.includes(x.id))) {
  const L = loadModel(m.id);
  const sw = new Switcher({ profile: L.profile, transform: L.transform });
  const srv = new AtemServer({ port: 9910, host: '127.0.0.1', switcher: sw });
  try {
    await srv.start();
  } catch {
    console.error('UDP port 9910 is in use. Stop the ATEM in the app or emulator first.');
    process.exit(1);
  }
  const out = await new Promise((resolve) => {
    execFile(BIN, ['127.0.0.1', ...(names ? ['names'] : [])], { timeout: 20000 }, (err, stdout) => resolve(stdout || (err && err.killed ? 'FAIL: timed out' : 'FAIL: no output')));
  });
  const [first, ...rest] = out.trim().split('\n');
  if (!first.startsWith('OK')) failed++;
  console.log(`${m.id.padEnd(20)} ${first}`);
  if (names) console.log(rest.join('\n'));
  await srv.stop();
  sw.close();
}
console.log(failed ? `${failed} model(s) failed` : 'All models connect.');
process.exit(failed ? 1 : 0);
