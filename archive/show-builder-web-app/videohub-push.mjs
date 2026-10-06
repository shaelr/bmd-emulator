#!/usr/bin/env node
// Sends labels and routing to a Blackmagic Videohub over its Ethernet protocol (TCP 9990).
//
//   node tools/videohub-push.mjs <host> <file.txt>
//   node tools/videohub-push.mjs <host> <show.bmdshow.json> [--preset <name|number>] [--labels]
//   node tools/videohub-push.mjs <host> --dump [out.txt]
//   node tools/videohub-push.mjs <show.bmdshow.json> --list
//
// Options: --port <n> (default 9990)  --dry-run (print what would be sent, don't connect)

import net from 'node:net';
import fs from 'node:fs';

const USAGE = `Usage:
  node tools/videohub-push.mjs <host> <file.txt>
      Send an exported .txt (labels and/or routing) to the hub.
  node tools/videohub-push.mjs <host> <show.bmdshow.json> [--preset <name|number>] [--labels]
      From a saved project: with no --preset, send all labels + the live routing.
      With --preset, send that preset's routing (add --labels to also send labels).
  node tools/videohub-push.mjs <host> --dump [out.txt]
      Save the hub's current labels and routing (importable in the app).
  node tools/videohub-push.mjs <show.bmdshow.json> --list
      List the routing presets in a project.

Options: --port <n> (default 9990), --dry-run`;

// Blocks a client may send. Everything else in a file (device info, locks, status) is skipped.
const WRITABLE = new Set([
  'INPUT LABELS', 'OUTPUT LABELS', 'VIDEO OUTPUT ROUTING',
  'MONITORING OUTPUT LABELS', 'VIDEO MONITORING OUTPUT ROUTING',
  'SERIAL PORT LABELS', 'SERIAL PORT ROUTING',
]);

function parseArgs(argv) {
  const a = { _: [], port: 9990 };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--port') a.port = parseInt(argv[++i], 10);
    else if (k === '--preset') a.preset = argv[++i];
    else if (k === '--labels') a.labels = true;
    else if (k === '--dump') a.dump = true;
    else if (k === '--list') a.list = true;
    else if (k === '--dry-run') a.dryRun = true;
    else if (k === '-h' || k === '--help') a.help = true;
    else a._.push(k);
  }
  return a;
}

function splitBlocks(text) {
  const out = [];
  let cur = null;
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (!cur) {
      const m = raw.match(/^([A-Z][A-Z0-9 ]*):\s*$/);
      if (m) cur = { header: m[1], lines: [] };
      continue;
    }
    if (raw.trim() === '') { out.push(cur); cur = null; continue; }
    cur.lines.push(raw);
  }
  if (cur) out.push(cur);
  return out;
}

const blockText = (header, lines) => `${header}:\n${lines.join('\n')}\n\n`;

function blocksFromProject(file, args) {
  const p = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (p.format !== 'bmd-show' || !p.videohub) throw new Error(`${file} is not a show project file.`);
  const vh = p.videohub;
  const label = (arr) => arr.map((l, i) => `${i} ${String(l ?? '').replace(/[\r\n]+/g, ' ').trim()}`);
  const route = (arr) => arr.map((r, o) => (r === null || r === undefined ? null : `${o} ${r}`)).filter(Boolean);
  const blocks = [];
  let routing = vh.routing;
  if (args.preset !== undefined) {
    const n = parseInt(args.preset, 10);
    const preset = vh.presets.find((x) => x.name === args.preset) ||
      (String(n) === String(args.preset) ? vh.presets[n - 1] : undefined);
    if (!preset) throw new Error(`No preset "${args.preset}". Use --list to see them.`);
    routing = preset.routing;
    console.log(`Preset: ${preset.name}`);
  }
  if (args.preset === undefined || args.labels) {
    blocks.push({ header: 'INPUT LABELS', lines: label(vh.inputLabels) });
    blocks.push({ header: 'OUTPUT LABELS', lines: label(vh.outputLabels) });
  }
  const r = route(routing);
  if (r.length) blocks.push({ header: 'VIDEO OUTPUT ROUTING', lines: r });
  return blocks;
}

function connect(host, port) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host, port });
    let buf = '';
    let preludeDone = false;
    let idle = null;
    let waiter = null;
    const raw = [];
    const timeout = setTimeout(() => reject(new Error(`Timed out connecting to ${host}:${port}`)), 5000);

    const finishPrelude = () => {
      if (preludeDone) return;
      preludeDone = true;
      clearTimeout(timeout);
      clearTimeout(idle);
      resolve(client);
    };

    sock.setEncoding('utf8');
    sock.on('data', (chunk) => {
      raw.push(chunk);
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, '');
        buf = buf.slice(nl + 1);
        if (line === 'END PRELUDE:') finishPrelude();
        if ((line === 'ACK' || line === 'NAK') && waiter) { const w = waiter; waiter = null; w(line); }
      }
      // Older firmware doesn't send END PRELUDE; treat a short silence as the end of the dump.
      if (!preludeDone) { clearTimeout(idle); idle = setTimeout(finishPrelude, 800); }
    });
    sock.on('error', (e) => { clearTimeout(timeout); reject(e); });

    const client = {
      raw: () => raw.join(''),
      send(text) {
        return new Promise((res) => {
          const t = setTimeout(() => { waiter = null; res('TIMEOUT'); }, 3000);
          waiter = (r) => { clearTimeout(t); res(r); };
          sock.write(text);
        });
      },
      close() { sock.end(); },
    };
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args._.length) { console.log(USAGE); process.exit(args.help ? 0 : 1); }

  if (args.list) {
    const file = args._.find((x) => x.endsWith('.json'));
    if (!file) throw new Error('--list needs a .bmdshow.json project file.');
    const p = JSON.parse(fs.readFileSync(file, 'utf8'));
    const presets = p.videohub?.presets || [];
    if (!presets.length) console.log('No routing presets in this project.');
    presets.forEach((x, i) => console.log(`${String(i + 1).padStart(3)}  ${x.name}`));
    return;
  }

  const [host, file] = args._;

  if (args.dump) {
    const c = await connect(host, args.port);
    c.close();
    const keep = splitBlocks(c.raw()).filter((b) => b.header !== 'END PRELUDE');
    const text = keep.map((b) => blockText(b.header, b.lines)).join('');
    if (file) { fs.writeFileSync(file, text); console.log(`Saved hub state to ${file}`); }
    else process.stdout.write(text);
    return;
  }

  if (!file) throw new Error('Give a .txt export or a .bmdshow.json project to send.\n\n' + USAGE);
  const blocks = file.endsWith('.json')
    ? blocksFromProject(file, args)
    : splitBlocks(fs.readFileSync(file, 'utf8')).filter((b) => {
        if (WRITABLE.has(b.header)) return true;
        console.log(`Skipping read-only block: ${b.header}`);
        return false;
      });
  if (!blocks.length) throw new Error('Nothing to send.');

  if (args.dryRun) {
    for (const b of blocks) process.stdout.write(blockText(b.header, b.lines));
    return;
  }

  const c = await connect(host, args.port);
  console.log(`Connected to ${host}:${args.port}`);
  let failed = 0;
  for (const b of blocks) {
    const res = await c.send(blockText(b.header, b.lines));
    console.log(`${res === 'ACK' ? '✓' : '✗'} ${b.header} (${b.lines.length} line${b.lines.length === 1 ? '' : 's'})${res === 'ACK' ? '' : ' → ' + res}`);
    if (res !== 'ACK') failed++;
  }
  c.close();
  if (failed) { console.error(`${failed} block(s) were not acknowledged.`); process.exit(2); }
  console.log('Done.');
}

main().catch((e) => { console.error('Error: ' + e.message); process.exit(1); });
