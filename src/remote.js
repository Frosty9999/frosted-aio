// Phone remote: a small web server on the home network. A phone opens http://<pc-ip>:<port>, enters the
// PIN shown in Frosted-AIO, and gets a page to switch profiles, videos, brightness and so on.
//
// Safety:
//  - Only answers devices on the local network (private, link-local and loopback addresses).
//  - Only answers requests addressed to an IP or "localhost" (stops DNS-rebinding tricks from web pages).
//  - The PIN is exchanged for a random session token; 5 wrong PINs from one address lock it out for 5 minutes.
//  - Tokens live in memory only and are dropped when the PIN changes or the remote is turned off.

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/remote.js': ['remote.js', 'text/javascript; charset=utf-8'],
  '/remote.css': ['remote.css', 'text/css; charset=utf-8'],
  '/icon.png': ['../assets/icon-256.png', 'image/png'],
  '/manifest.json': ['manifest.json', 'application/manifest+json']
};

function isLocalAddress(addr) {
  const a = String(addr || '').replace(/^::ffff:/, '');
  if (a === '::1' || a.startsWith('127.')) return true;
  if (/^10\./.test(a) || /^192\.168\./.test(a) || /^169\.254\./.test(a)) return true;
  const m = a.match(/^172\.(\d+)\./);
  if (m && +m[1] >= 16 && +m[1] <= 31) return true;
  if (/^(fe80|fc|fd)/i.test(a)) return true;
  return false;
}

const hostOk = (host) => {
  const h = String(host || '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  return h === 'localhost' || /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || /^[0-9a-f:]+$/i.test(h);
};

/** IPv4 addresses of this PC on the local network, e.g. ['192.168.1.20']. */
function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    if (/vethernet|virtualbox|vmware|hyper-v|loopback|wsl/i.test(name)) continue;
    for (const i of list || []) if (i.family === 'IPv4' && !i.internal && isLocalAddress(i.address) && !i.address.startsWith('169.254.')) out.push(i.address);
  }
  return out;
}

const equalPin = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

class RemoteServer {
  /**
   * @param {object} o
   * @param {() => object} o.getState   what the phone page shows
   * @param {(action: string, value: any) => any} o.act   runs a phone action
   * @param {(fileName: string) => string|null} o.thumbFile   thumbnail path for a cooler file, if any
   * @param {Function} o.log
   */
  constructor({ getState, act, thumbFile, log, host = '0.0.0.0' }) {
    Object.assign(this, { getState, act, thumbFile, log, host });
    this.server = null;
    this.port = null;
    this.pin = null;
    this.tokens = new Map(); // token -> last used (ms)
    this.fails = new Map(); // ip -> { n, until }
    this.error = null;
  }

  get running() {
    return !!this.server?.listening;
  }

  /** Starts (or restarts on a new port/PIN). Resolves with null, or an error message. */
  async start(port, pin) {
    if (this.running && this.port === port) {
      if (pin !== this.pin) this.tokens.clear();
      this.pin = pin;
      return null;
    }
    await this.stop();
    this.pin = pin;
    this.port = port;
    this.error = null;
    return new Promise((resolve) => {
      const srv = http.createServer((req, res) => this._handle(req, res).catch((e) => this._send(res, 500, { error: e.message })));
      srv.headersTimeout = 10000;
      srv.requestTimeout = 15000;
      srv.on('error', (e) => {
        this.error = e.code === 'EADDRINUSE' ? `Port ${port} is already in use by another program. Pick a different port.` : e.message;
        this.log('remote: server error', e.message);
        this.server = null;
        resolve(this.error);
      });
      srv.listen(port, this.host, () => {
        this.server = srv;
        this.log('remote: listening on port', port);
        resolve(null);
      });
    });
  }

  stop() {
    this.tokens.clear();
    const srv = this.server;
    this.server = null;
    if (!srv) return Promise.resolve();
    return new Promise((resolve) => {
      srv.close(() => resolve());
      srv.closeAllConnections?.();
    });
  }

  _send(res, code, body, type = 'application/json; charset=utf-8') {
    res.writeHead(code, {
      'Content-Type': type,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'"
    });
    res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
  }

  _readJson(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const parts = [];
      req.on('data', (d) => {
        size += d.length;
        if (size > 4096) {
          reject(new Error('Request too large.'));
          req.destroy();
        } else parts.push(d);
      });
      req.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(parts).toString('utf8') || '{}'));
        } catch {
          reject(new Error('Bad request.'));
        }
      });
      req.on('error', reject);
    });
  }

  _authed(req, url) {
    const h = String(req.headers.authorization || '');
    const token = h.startsWith('Bearer ') ? h.slice(7) : url.searchParams.get('t');
    if (!token || !this.tokens.has(token)) return false;
    this.tokens.set(token, Date.now());
    return true;
  }

  async _handle(req, res) {
    const ip = req.socket.remoteAddress;
    if (!isLocalAddress(ip) || !hostOk(req.headers.host)) {
      req.socket.destroy();
      return;
    }
    const url = new URL(req.url, 'http://local');

    if (req.method === 'GET' && STATIC[url.pathname]) {
      const [file, type] = STATIC[url.pathname];
      const body = fs.readFileSync(path.join(__dirname, 'remote', file));
      return this._send(res, 200, body, type);
    }

    if (req.method === 'POST' && url.pathname === '/api/login') {
      const f = this.fails.get(ip);
      if (f && f.until > Date.now()) return this._send(res, 429, { error: 'Too many wrong PINs. Try again in a few minutes.' });
      const { pin } = await this._readJson(req);
      if (!this.pin || !equalPin(String(pin || '').trim(), this.pin)) {
        const n = (f && f.until <= Date.now() && f.n >= 5 ? 0 : f?.n || 0) + 1;
        this.fails.set(ip, { n, until: n >= 5 ? Date.now() + 5 * 60 * 1000 : 0 });
        this.log('remote: wrong PIN from', ip, `(${n})`);
        return this._send(res, 401, { error: n >= 5 ? 'Too many wrong PINs. Try again in 5 minutes.' : 'Wrong PIN.' });
      }
      this.fails.delete(ip);
      const token = crypto.randomBytes(24).toString('hex');
      // Keep at most 20 phones signed in; drop the least recently used.
      if (this.tokens.size >= 20) this.tokens.delete([...this.tokens.entries()].sort((a, b) => a[1] - b[1])[0][0]);
      this.tokens.set(token, Date.now());
      this.log('remote: phone signed in from', ip);
      return this._send(res, 200, { token });
    }

    if (url.pathname.startsWith('/api/')) {
      if (!this._authed(req, url)) return this._send(res, 401, { error: 'Enter the PIN shown in Frosted-AIO.' });
      if (req.method === 'GET' && url.pathname === '/api/state') return this._send(res, 200, this.getState());
      if (req.method === 'GET' && url.pathname === '/api/thumb') {
        const file = this.thumbFile(String(url.searchParams.get('f') || ''));
        if (!file) return this._send(res, 404, { error: 'No preview.' });
        return this._send(res, 200, fs.readFileSync(file), 'image/jpeg');
      }
      if (req.method === 'POST' && url.pathname === '/api/action') {
        const { action, value } = await this._readJson(req);
        try {
          await this.act(String(action || ''), value);
          return this._send(res, 200, this.getState());
        } catch (e) {
          return this._send(res, 400, { error: e.message });
        }
      }
    }
    this._send(res, 404, { error: 'Not found.' });
  }
}

const newPin = () => String(crypto.randomInt(0, 1000000)).padStart(6, '0');

module.exports = { RemoteServer, lanAddresses, newPin, isLocalAddress };
