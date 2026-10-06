// Announces the emulators on the local network with macOS's dns-sd tool, the
// same way the hardware announces itself, so the Blackmagic apps list them.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';

export function stableId(seed, length = 32) {
  return crypto.createHash('md5').update('bmd-emulator:' + seed).digest('hex').slice(0, length);
}

export class Announcement {
  constructor(log = () => {}) {
    this.log = log;
    this.procs = [];
  }

  // services: [{ name, type, port, txt: {key: value} }]
  // localOnly announces to apps on this Mac only, not to the rest of the network.
  start(services, { localOnly = true } = {}) {
    this.stop();
    if (process.platform !== 'darwin') {
      this.log('Network discovery needs macOS; connect the Blackmagic app by IP address instead.');
      return;
    }
    for (const s of services) {
      const txt = Object.entries(s.txt || {}).map(([k, v]) => `${k}=${v}`);
      // Local-only: a proxy record pointing at 127.0.0.1, which is where the emulator listens.
      const host = `bmd-emulator-${s.type.replace(/[^a-z]/g, '')}.local`;
      const args = localOnly
        ? ['-lo', '-P', s.name, s.type, 'local', String(s.port), host, '127.0.0.1', ...txt]
        : ['-R', s.name, s.type, 'local', String(s.port), ...txt];
      const p = spawn('dns-sd', args, { stdio: 'ignore' });
      p.on('error', (e) => this.log(`Bonjour announcement failed: ${e.message}`));
      this.procs.push(p);
    }
  }

  stop() {
    for (const p of this.procs) p.kill();
    this.procs = [];
  }
}
