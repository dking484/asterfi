// Minimal Asterisk Manager Interface client with auto-reconnect and event lists.
import net from 'node:net';
import { EventEmitter } from 'node:events';

export class Ami extends EventEmitter {
  constructor({ host, port, username, secret }) {
    super();
    this.opts = { host, port, username, secret };
    this.connected = false;
    this.pending = new Map();
    this.seq = 0;
    this.buf = '';
    this.socket = null;
    this.retry = 1000;
  }

  start() {
    this.#connect();
  }

  #connect() {
    const s = net.createConnection({ host: this.opts.host, port: this.opts.port });
    this.socket = s;
    this.buf = '';
    s.setEncoding('utf8');
    s.on('data', (d) => this.#onData(d));
    s.on('error', (e) => this.emit('log', `AMI socket error: ${e.message}`));
    s.on('close', () => {
      const was = this.connected;
      this.connected = false;
      for (const p of this.pending.values()) p.reject(new Error('AMI disconnected'));
      this.pending.clear();
      if (was) this.emit('disconnected');
      setTimeout(() => this.#connect(), this.retry);
      this.retry = Math.min(this.retry * 2, 15000);
    });
  }

  #onData(chunk) {
    this.buf += chunk;
    // First line is the banner, which has no blank-line terminator.
    if (this.buf.startsWith('Asterisk Call Manager')) {
      const nl = this.buf.indexOf('\r\n');
      if (nl === -1) return;
      this.buf = this.buf.slice(nl + 2);
      this.#login();
    }
    let idx;
    while ((idx = this.buf.indexOf('\r\n\r\n')) !== -1) {
      const raw = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 4);
      this.#onMessage(parse(raw));
    }
  }

  async #login() {
    try {
      const r = await this.action({ Action: 'Login', Username: this.opts.username, Secret: this.opts.secret });
      if (r.Response !== 'Success') throw new Error(r.Message || 'login failed');
      this.connected = true;
      this.retry = 1000;
      this.emit('connected');
    } catch (e) {
      this.emit('log', `AMI login failed: ${e.message}`);
      this.socket.destroy();
    }
  }

  #onMessage(msg) {
    const id = msg.ActionID;
    const p = id && this.pending.get(id);
    if (p) {
      if (msg.Response) {
        p.response = msg;
        if (msg.EventList !== 'start') {
          this.pending.delete(id);
          p.resolve(msg);
        }
        return;
      }
      if (msg.Event) {
        if (msg.EventList === 'Complete') {
          this.pending.delete(id);
          p.resolve({ ...p.response, events: p.events });
        } else {
          p.events.push(msg);
        }
        return;
      }
    }
    if (msg.Event) this.emit('event', msg);
  }

  action(fields, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      if (!this.socket || this.socket.destroyed) return reject(new Error('AMI not connected'));
      const ActionID = `af${++this.seq}`;
      let out = '';
      for (const [k, v] of Object.entries({ ...fields, ActionID })) {
        if (v === undefined || v === null) continue;
        for (const item of Array.isArray(v) ? v : [v]) out += `${k}: ${item}\r\n`;
      }
      const timer = setTimeout(() => {
        this.pending.delete(ActionID);
        reject(new Error(`AMI ${fields.Action} timed out`));
      }, timeoutMs);
      this.pending.set(ActionID, {
        events: [],
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.socket.write(out + '\r\n');
    });
  }

  async command(cmd) {
    const r = await this.action({ Action: 'Command', Command: cmd });
    const out = r.Output;
    return Array.isArray(out) ? out.join('\n') : out || '';
  }
}

function parse(raw) {
  const msg = {};
  for (const line of raw.split('\r\n')) {
    const i = line.indexOf(':');
    if (i === -1) continue;
    const k = line.slice(0, i);
    const v = line.slice(i + 1).trimStart();
    if (k in msg) msg[k] = Array.isArray(msg[k]) ? [...msg[k], v] : [msg[k], v];
    else msg[k] = v;
  }
  return msg;
}
