// Frosted-AIO's own connection to the TRYX Panorama coolers, replacing TRYX's UDB.exe.
//
// Wire format (worked out from UDB.exe and confirmed on a Panorama SE):
//   every message = "TRYX" (4 bytes) + payload length (uint32, little-endian) + protobuf payload
//   requests  = Tryx.USBProtocol.ReqPackagePb { header { version: 1, track_id }, <one body> }
//   responses = Tryx.USBProtocol.RspPackagePb { header, error, <one body> }
// Connecting is: get_device_info -> get_sys_config -> get_device_auth (the cooler just answers "ok").
// Uploads: file_transmit_begin -> file_transmit_data (256 KB pieces, each acknowledged) -> file_transmit_end
// with a CRC32 of the whole file.
//
// USB I/O itself runs in usbio.ps1 (Windows' own USB driver, no TRYX driver); this file does the protocol.
// The public interface matches bridge.js (the UDB.exe client), so main.js can use either.

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const protobuf = require('protobufjs');

const MAGIC = Buffer.from('TRYX');
const CHUNK = 256 * 1024;
const PROTO_DIR = path.join(__dirname, 'protocol');
const unpacked = (p) => p.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);

// ---------- protobuf schema ----------

let types = null;
function loadTypes() {
  if (types) return types;
  const root = new protobuf.Root();
  root.resolvePath = (_origin, target) => path.join(PROTO_DIR, path.basename(target));
  root.loadSync(['usb_protocol.proto', 'user_config.proto', 'sys_config.proto', 'cooler.proto', 'lv_gui.proto', 'touch_display.proto', 'media_header.proto', 'deprecated.proto'], { keepCase: false });
  root.resolveAll();
  types = {
    Req: root.lookupType('Tryx.USBProtocol.ReqPackagePb'),
    Rsp: root.lookupType('Tryx.USBProtocol.RspPackagePb')
  };
  return types;
}

const TO_OBJECT = { enums: String, longs: Number, bytes: String, defaults: true, oneofs: true };

// ---------- CRC-32C (Castagnoli) ----------
// The upload's end message carries a CRC-32C of the whole file (reflected polynomial 0x82F63B78, initial
// value and result both inverted), the same routine UDB.exe uses. Plain CRC32 gets "CRCFail".

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0x82f63b78 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32c(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ---------- client ----------

class CoolerClient extends EventEmitter {
  constructor({ log = () => {} } = {}) {
    super();
    this.log = log;
    this.proc = null;
    this.rx = Buffer.alloc(0);
    this.lineBuf = '';
    this.device = null;
    this.devicePath = null;
    this.stopped = false;
    this.trackId = 1;
    this.waiters = []; // { body, resolve, reject, timer }
    this.transferring = false;
    this.restarts = 0;
  }

  // ----- lifecycle -----

  async start() {
    this.stopped = false;
    loadTypes(); // fail early if the schema can't load
    this._spawn();
  }

  _spawn() {
    const script = unpacked(path.join(__dirname, 'usbio.ps1'));
    this.proc = spawn('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], { windowsHide: true });
    this.proc.stdout.on('data', (d) => this._onLines(d));
    this.proc.stderr.on('data', (d) => this.log('usb helper:', String(d).trim().slice(0, 400)));
    this.proc.on('exit', (code) => {
      this.proc = null;
      this._dropDevice();
      if (this.stopped) return;
      this.restarts++;
      if (this.restarts > 5) return this.emit('lost', 'The USB helper keeps stopping.');
      this.log('usb helper exited', code, '- restarting');
      setTimeout(() => !this.stopped && this._spawn(), 2000);
    });
  }

  stop() {
    this.stopped = true;
    this._rejectAll(new Error('stopped'));
    if (this.proc) {
      try {
        this.proc.stdin.write('Q\n');
      } catch {}
      const p = this.proc;
      setTimeout(() => p.kill(), 500);
    }
  }

  // ----- helper output -----

  _onLines(chunk) {
    this.lineBuf += chunk.toString('ascii');
    let i;
    while ((i = this.lineBuf.indexOf('\n')) >= 0) {
      const line = this.lineBuf.slice(0, i).trim();
      this.lineBuf = this.lineBuf.slice(i + 1);
      if (!line) continue;
      const sp = line.indexOf(' ');
      const kind = sp < 0 ? line : line.slice(0, sp);
      const rest = sp < 0 ? '' : line.slice(sp + 1);
      if (kind === 'D') this._onBytes(Buffer.from(rest, 'base64'));
      else if (kind === 'OPEN') this._onOpen(rest);
      else if (kind === 'CLOSED') {
        this.log('cooler USB closed:', rest);
        this._dropDevice();
      } else if (kind === 'NODEV') this.emit('waiting', 'Waiting for the cooler to show up on USB…');
      else if (kind === 'ERR') this.log('usb helper error:', rest);
    }
  }

  _dropDevice() {
    const was = this.device;
    this.device = null;
    this.rx = Buffer.alloc(0);
    this.transferring = false;
    this._rejectAll(new Error('cooler disconnected'));
    if (was) this.emit('offline');
  }

  async _onOpen(devicePath) {
    this.devicePath = devicePath;
    this.rx = Buffer.alloc(0);
    try {
      const info = (await this._request({ getDeviceInfo: {} }, 'deviceInfo', 5000)).deviceInfo;
      await this._request({ getSysConfig: {} }, 'sysConfig', 5000);
      const auth = (await this._request({ getDeviceAuth: { key: Math.floor(Math.random() * 0xffffffff) } }, 'deviceAuth', 5000)).deviceAuth;
      const pid = (devicePath.match(/pid_([0-9a-f]{4})/i) || [])[1] || '';
      this.device = {
        sn: info.serialNumber,
        productName: info.productName,
        pid: pid.toUpperCase(),
        firmwareVersion: info.firmwareVersion,
        appVersion: info.appVersion
      };
      this.restarts = 0;
      this.log('cooler online (built-in driver):', this.device, 'auth:', auth.auth);
      this.emit('online', this.device);
      // Report what the cooler is showing now, so first runs can adopt it.
      this._request({ getUserConfig: {} }, 'userConfig', 5000)
        .then((r) => this.emit('userConfig', r.userConfig))
        .catch(() => {});
    } catch (e) {
      this.log('cooler handshake failed:', e.message);
      setTimeout(() => this.devicePath === devicePath && !this.device && this._onOpen(devicePath), 3000);
    }
  }

  // ----- framing -----

  _onBytes(bytes) {
    this.rx = this.rx.length ? Buffer.concat([this.rx, bytes]) : bytes;
    for (;;) {
      const at = this.rx.indexOf(MAGIC);
      if (at < 0) {
        this.rx = this.rx.subarray(Math.max(0, this.rx.length - 3)); // keep a possible partial magic
        return;
      }
      if (at > 0) this.rx = this.rx.subarray(at);
      if (this.rx.length < 8) return;
      const len = this.rx.readUInt32LE(4);
      if (len > 64 * 1024 * 1024) {
        this.rx = this.rx.subarray(4); // not a real frame; resync
        continue;
      }
      if (this.rx.length < 8 + len) return;
      const payload = this.rx.subarray(8, 8 + len);
      this.rx = this.rx.subarray(8 + len);
      let msg;
      try {
        msg = types.Rsp.toObject(types.Rsp.decode(payload), TO_OBJECT);
      } catch (e) {
        this.log('could not decode a cooler message:', e.message);
        continue;
      }
      this._onMessage(msg);
    }
  }

  _write(body) {
    if (!this.proc) return false;
    const msg = types.Req.fromObject({ header: { version: 1, trackId: this.trackId++ }, ...body });
    const payload = Buffer.from(types.Req.encode(msg).finish());
    const head = Buffer.alloc(8);
    MAGIC.copy(head, 0);
    head.writeUInt32LE(payload.length, 4);
    try {
      this.proc.stdin.write('W ' + Buffer.concat([head, payload]).toString('base64') + '\n');
      return true;
    } catch {
      return false;
    }
  }

  // Send a request and wait for the reply whose body is `expect`.
  _request(body, expect, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.timer !== timer);
        reject(new Error(`no ${expect} reply`));
      }, timeoutMs);
      this.waiters.push({ body: expect, resolve, reject, timer });
      if (!this._write(body)) {
        clearTimeout(timer);
        this.waiters = this.waiters.filter((w) => w.timer !== timer);
        reject(new Error('USB helper not running'));
      }
    });
  }

  _rejectAll(err) {
    const ws = this.waiters;
    this.waiters = [];
    for (const w of ws) {
      clearTimeout(w.timer);
      w.reject(err);
    }
  }

  _onMessage(msg) {
    const body = msg.body;
    if (msg.error && msg.error.code && msg.error.code !== 'Success') {
      // Replies to things this cooler doesn't support (harmless). Wake a waiter if one is pending.
      this.log('cooler replied error:', msg.error.code, msg.error.why || '');
    }
    const w = this.waiters.find((x) => x.body === body);
    if (w) {
      this.waiters.splice(this.waiters.indexOf(w), 1);
      clearTimeout(w.timer);
      w.resolve(msg);
    }
    switch (body) {
      case 'coolerStatus':
        this.emit('coolerStatus', { fansSpeed: msg.coolerStatus.fansSpeed, pumpSpeed: msg.coolerStatus.pumpSpeed });
        break;
      case 'fileList':
        this.emit(
          'fileList',
          (msg.fileList.mediaFileList || []).map((f) => ({ filePath: f.filePath, fileExt: f.fileExt, fileSize: f.fileSize, readOnly: f.readOnly }))
        );
        break;
      case 'userConfig':
        if (!w) this.emit('userConfig', msg.userConfig);
        break;
      default:
        break;
    }
  }

  // ----- commands (same names and shapes as bridge.js) -----

  _ready() {
    return !!(this.proc && this.device);
  }

  setUserConfig(userConfig) {
    return this._ready() && this._write({ userConfig });
  }
  setRunConfig(runConfig) {
    return this._ready() && this._write({ runConfig });
  }
  updateLabels(labelGroups) {
    if (!this._ready() || this.transferring) return false;
    return this._write({ batchGroupLabelUpdate: { labelGroups } });
  }
  setFanPower(percent) {
    return this._ready() && this._write({ coolerConfig: { fanConfig: { mode: 'FixMode', fixPower: percent } } });
  }
  requestCoolerStatus() {
    if (!this._ready() || this.transferring) return false;
    return this._write({ getCoolerStatus: {} });
  }
  requestFileList() {
    if (!this._ready() || this.transferring) return false;
    return this._write({ getFileList: {} });
  }
  removeFile(fileName) {
    return this._ready() && this._write({ fileRemove: { fileName, fileType: 'media' } });
  }

  // Upload a prepared .h264_WxH file. Progress and the result arrive as 'transmit' events, like UDB.exe's.
  transmitFile(localPath, trackId) {
    if (!this._ready() || this.transferring) return false;
    this._transmit(localPath, String(trackId)).catch((e) => {
      this.log('upload failed:', e.message);
      this.emit('transmit', { trackId: String(trackId), status: 'Failed', detailInfo: e.message });
    });
    return true;
  }

  async _transmit(localPath, trackId) {
    const data = await fs.promises.readFile(localPath);
    const fileName = path.basename(localPath);
    const status = (r, step) => {
      const s = r[step]?.fileTransStatus;
      if (s !== 'OK') throw new Error(`cooler said ${s || 'nothing'} during ${step.replace(/Status$/, '').replace('fileTransmit', '').toLowerCase()}`);
    };
    this.transferring = true;
    try {
      this.emit('transmit', { trackId, status: 'Transmit', fileSize: data.length, transSize: 0 });
      status(await this._request({ fileTransmitBegin: { fileName: Buffer.from(fileName), fileSize: data.length } }, 'fileTransmitBeginStatus', 15000), 'fileTransmitBeginStatus');
      for (let off = 0; off < data.length; off += CHUNK) {
        const piece = data.subarray(off, Math.min(off + CHUNK, data.length));
        status(await this._request({ fileTransmitData: { fileData: piece } }, 'fileTransmitDataStatus', 15000), 'fileTransmitDataStatus');
        this.emit('transmit', { trackId, status: 'Transmit', fileSize: data.length, transSize: off + piece.length });
      }
      status(await this._request({ fileTransmitEnd: { fileType: Buffer.from('media'), CRC: crc32c(data) } }, 'fileTransmitEndStatus', 60000), 'fileTransmitEndStatus');
      this.emit('transmit', { trackId, status: 'Success', fileSize: data.length, transSize: data.length });
    } finally {
      this.transferring = false;
    }
  }
}

module.exports = { CoolerClient, crc32c, loadTypes };
