// ATEM network protocol (UDP 9910): sessions, acknowledgements, retransmits.
import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';
import { parseCommands } from './codec.mjs';

const F = { ACKREQ: 0x01, HELLO: 0x02, RETX: 0x04, RETXREQ: 0x08, ACK: 0x10 };
const MAX_ID = 0x8000;
const RESEND_MS = 100;
const TIMEOUT_MS = 5000;
const KEEPALIVE_MS = 1000;
const MAX_PAYLOAD = 1300;

function header(flags, len, session, ackId, pktId, extra = 0) {
  const b = Buffer.alloc(12);
  b.writeUInt16BE((flags << 11) | len, 0);
  b.writeUInt16BE(session, 2);
  b.writeUInt16BE(ackId, 4);
  b.writeUInt16BE(extra, 6);
  b.writeUInt16BE(pktId, 10);
  return b;
}

export class AtemServer extends EventEmitter {
  constructor({ port = 9910, host = '0.0.0.0', switcher, log = () => {} }) {
    super();
    this.port = port;
    this.host = host;
    this.switcher = switcher;
    this.log = log;
    this.clients = new Map();
    this.nextClient = 1;
    this.pending = new Map(); // client key ('*' = everyone) -> Buffer[] of command frames
    this.onOut = ({ frame, to }) => this.queue(frame, to);
    switcher.on('out', this.onOut);
  }

  start() {
    return new Promise((resolve, reject) => {
      this.sock = dgram.createSocket({ type: 'udp4', reuseAddr: false });
      this.sock.once('error', reject);
      this.sock.on('message', (m, r) => this.receive(m, r));
      this.sock.bind(this.port, this.host, () => {
        this.sock.off('error', reject);
        this.sock.on('error', (e) => this.log(`UDP error: ${e.message}`));
        this.timer = setInterval(() => this.service(), 10);
        resolve();
      });
    });
  }

  stop() {
    clearInterval(this.timer);
    this.switcher.off('out', this.onOut);
    for (const c of this.clients.values()) this.sendRaw(c, Buffer.concat([header(F.HELLO, 20, c.session, 0, 0), Buffer.from([4, 0, 0, 0, 0, 0, 0, 0])]));
    this.clients.clear();
    return new Promise((res) => (this.sock ? this.sock.close(() => res()) : res()));
  }

  get clientList() {
    return [...this.clients.values()].filter((c) => c.state === 'up').map((c) => ({ address: c.addr, port: c.port, since: c.since, commands: c.rx || 0 }));
  }

  sendRaw(c, buf) { this.sock.send(buf, c.port, c.addr); }

  receive(msg, r) {
    if (msg.length < 12) return;
    const flags = msg[0] >> 3;
    const len = msg.readUInt16BE(0) & 0x7ff;
    if (len !== msg.length) return;
    const session = msg.readUInt16BE(2);
    const ackId = msg.readUInt16BE(4);
    const pktId = msg.readUInt16BE(10);
    const key = `${r.address}:${r.port}`;

    if (flags & F.HELLO) {
      const kind = msg[12];
      if (kind === 1) {
        let c = this.clients.get(key);
        if (!c) {
          const id = this.nextClient++ % 0x7fff || this.nextClient++;
          c = { key, addr: r.address, port: r.port, id, session: 0x8000 | id, state: 'hello', since: Date.now() };
          this.clients.set(key, c);
        }
        Object.assign(c, { state: 'hello', outId: 0, inflight: [], lastRx: Date.now(), lastTx: Date.now(), lastIn: 0, seen: new Set() });
        this.sendRaw(c, Buffer.concat([header(F.HELLO, 20, session, 0, 0), Buffer.from([0x02, 0x00, c.id >> 8, c.id & 0xff, 0, 0, 0, 0])]));
      } else if (kind === 4) {
        this.drop(key, 'disconnected');
      }
      return;
    }

    const c = this.clients.get(key);
    if (!c) return;
    c.lastRx = Date.now();

    if (flags & F.ACK) {
      if (c.state === 'hello') {
        c.state = 'up';
        this.log(`ATEM client connected: ${c.addr}`);
        this.emit('clients');
        for (const p of this.switcher.initPayloads()) this.sendData(c, p);
      } else {
        c.inflight = c.inflight.filter((p) => !covered(ackId, p.id));
      }
    }
    if (flags & F.RETXREQ) {
      const from = msg.readUInt16BE(6);
      for (const p of c.inflight) if (!covered(from, p.id) || p.id === from) { p.sent = 0; }
    }
    if (flags & F.ACKREQ && c.state === 'up') {
      this.sendRaw(c, header(F.ACK, 12, c.session, pktId, 0));
      if (c.seen.has(pktId)) return;
      c.seen.add(pktId);
      if (c.seen.size > 512) c.seen.delete(c.seen.values().next().value);
      if (len > 12) {
        const cmds = parseCommands(msg.subarray(12, len));
        c.rx = (c.rx || 0) + cmds.length;
        this.switcher.handle(c, cmds);
      }
    }
  }

  sendData(c, payload) {
    c.outId = (c.outId + 1) % MAX_ID;
    const pkt = Buffer.concat([header(F.ACKREQ, 12 + payload.length, c.session, 0, c.outId), payload]);
    c.inflight.push({ id: c.outId, pkt, sent: Date.now(), tries: 0 });
    c.lastTx = Date.now();
    this.sendRaw(c, pkt);
  }

  queue(frame, to) {
    const k = to ? to.key : '*';
    if (!this.pending.has(k)) this.pending.set(k, []);
    this.pending.get(k).push(frame);
  }

  flush(c, frames) {
    let cur = [];
    let size = 0;
    for (const f of frames) {
      if (size + f.length > MAX_PAYLOAD && cur.length) { this.sendData(c, Buffer.concat(cur)); cur = []; size = 0; }
      cur.push(f);
      size += f.length;
    }
    if (cur.length) this.sendData(c, Buffer.concat(cur));
  }

  service() {
    const now = Date.now();
    const everyone = this.pending.get('*') || [];
    for (const c of this.clients.values()) {
      if (c.state !== 'up') {
        if (now - c.lastRx > TIMEOUT_MS) this.drop(c.key, 'handshake timed out');
        continue;
      }
      const own = this.pending.get(c.key) || [];
      if (own.length || everyone.length) this.flush(c, own.concat(everyone));
      for (const p of c.inflight) {
        if (now - p.sent > RESEND_MS) {
          p.pkt[0] |= F.RETX << 3;
          p.sent = now;
          p.tries++;
          this.sendRaw(c, p.pkt);
        }
      }
      if (now - c.lastRx > TIMEOUT_MS) { this.drop(c.key, 'timed out'); continue; }
      if (!c.inflight.length && now - c.lastTx > KEEPALIVE_MS) this.sendData(c, Buffer.alloc(0));
    }
    this.pending.clear();
  }

  drop(key, why) {
    const c = this.clients.get(key);
    if (!c) return;
    this.clients.delete(key);
    if (c.state === 'up') this.log(`ATEM client ${c.addr} ${why}`);
    this.emit('clients');
  }
}

// True when packet `id` is at or before `ack` (ids wrap at 15 bits).
function covered(ack, id) {
  const d = (ack - id + MAX_ID) % MAX_ID;
  return d < MAX_ID / 2;
}
