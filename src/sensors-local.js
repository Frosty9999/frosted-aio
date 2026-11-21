// Runs sensors.ps1 (LibreHardwareMonitor, open source) and keeps its latest reading.
// Same interface as sensors.js (the Screen.exe client): start(), read(), stop().

const path = require('path');
const { spawn } = require('child_process');

const unpacked = (p) => p.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);

class LocalSensors {
  constructor({ libDir, log = () => {} }) {
    this.libDir = libDir;
    this.log = log;
    this.proc = null;
    this.latest = null;
    this.stopped = false;
    this.buf = '';
  }

  start() {
    this.stopped = false;
    this._spawn();
    return Promise.resolve();
  }

  _spawn() {
    const script = unpacked(path.join(__dirname, 'sensors.ps1'));
    this.proc = spawn('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-LibDir', this.libDir], { windowsHide: true });
    this.proc.stdout.on('data', (d) => {
      this.buf += d.toString('utf8');
      let i;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i).trim();
        this.buf = this.buf.slice(i + 1);
        if (!line) continue;
        if (line.startsWith('INFO')) this.log('sensors:', line.slice(5));
        else {
          try {
            this.latest = JSON.parse(line);
          } catch {
            /* partial line */
          }
        }
      }
    });
    this.proc.stderr.on('data', (d) => this.log('sensor reader:', String(d).trim().slice(0, 400)));
    this.proc.on('exit', (code) => {
      this.proc = null;
      if (this.stopped) return;
      this.log('sensor reader exited', code, '- restarting in 5 s');
      setTimeout(() => !this.stopped && this._spawn(), 5000);
    });
  }

  // Latest reading in the shape main.js expects (raw: the same object, for the one-time log line).
  read() {
    return this.latest ? Promise.resolve({ ...this.latest, raw: this.latest }) : Promise.reject(new Error('no sensor reading yet'));
  }

  stop() {
    this.stopped = true;
    this.proc?.kill();
    this.proc = null;
  }
}

module.exports = { LocalSensors };
