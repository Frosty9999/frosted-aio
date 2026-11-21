// Stats history: one CSV file per day in Documents\Frosted-AIO\History (e.g. 2026-11-12.csv).
// Plain CSV so it opens in Excel or anything else. The app reads it back for the History tab.

const fs = require('fs');
const path = require('path');

const COLUMNS = [
  ['time', 'Time'],
  ['cpu_temp_c', 'CPU temp (°C)'],
  ['cpu_load_pct', 'CPU load (%)'],
  ['cpu_clock_mhz', 'CPU clock (MHz)'],
  ['cpu_power_w', 'CPU power (W)'],
  ['gpu_temp_c', 'GPU temp (°C)'],
  ['gpu_load_pct', 'GPU load (%)'],
  ['gpu_clock_mhz', 'GPU clock (MHz)'],
  ['gpu_power_w', 'GPU power (W)'],
  ['ram_load_pct', 'RAM load (%)'],
  ['net_down_kbps', 'Download (KB/s)'],
  ['net_up_kbps', 'Upload (KB/s)'],
  ['disk_load_pct', 'Disk C: used (%)'],
  ['fan_power_pct', 'Fan power (%)']
];

const pad = (n) => String(n).padStart(2, '0');
const dayOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const timeOf = (d) => `${dayOf(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

class StatsHistory {
  constructor(dir) {
    this.dir = dir;
    this.lastWrite = 0;
    this.lastPrune = 0;
  }

  fileFor(day) {
    return path.join(this.dir, `${day}.csv`);
  }

  // Append one row if `intervalSec` has passed since the last one.
  record(stats, fanPower, intervalSec) {
    const now = Date.now();
    if (now - this.lastWrite < Math.max(1, intervalSec) * 1000 - 50) return;
    this.lastWrite = now;
    const d = new Date(now);
    const r = Math.round;
    const row = [
      timeOf(d),
      r(stats.cpu.temperature), r(stats.cpu.load), r(stats.cpu.frequency), r(stats.cpu.power),
      r(stats.gpu.temperature), r(stats.gpu.load), r(stats.gpu.frequency), r(stats.gpu.power),
      r(stats.memory.load),
      r((stats.network?.down || 0) / 1024), r((stats.network?.up || 0) / 1024),
      r(stats.disk?.load || 0),
      fanPower ?? ''
    ].join(',');
    const file = this.fileFor(dayOf(d));
    fs.mkdir(this.dir, { recursive: true }, () => {
      const header = fs.existsSync(file) ? '' : COLUMNS.map((c) => c[0]).join(',') + '\r\n';
      fs.appendFile(file, header + row + '\r\n', () => {});
    });
  }

  days() {
    try {
      return fs
        .readdirSync(this.dir)
        .filter((f) => /^\d{4}-\d{2}-\d{2}\.csv$/.test(f))
        .map((f) => f.slice(0, 10))
        .sort()
        .reverse();
    } catch {
      return [];
    }
  }

  // Rows for one day, averaged down to at most `maxPoints`, plus min/avg/max per column.
  read(day, maxPoints = 1200) {
    let text = '';
    try {
      text = fs.readFileSync(this.fileFor(day), 'utf8');
    } catch {
      return { day, columns: COLUMNS, points: [], summary: {} };
    }
    const lines = text.split(/\r?\n/).filter(Boolean);
    const header = lines.shift()?.split(',') || [];
    const idx = COLUMNS.map(([key]) => header.indexOf(key));
    const rows = [];
    for (const line of lines) {
      const cells = line.split(',');
      const t = new Date(cells[idx[0]].replace(' ', 'T')).getTime();
      if (!Number.isFinite(t)) continue;
      rows.push([t, ...idx.slice(1).map((i) => (i >= 0 && cells[i] !== '' ? Number(cells[i]) : null))]);
    }
    const summary = {};
    COLUMNS.slice(1).forEach(([key], c) => {
      const vals = rows.map((r) => r[c + 1]).filter((v) => v !== null && Number.isFinite(v));
      if (vals.length) summary[key] = { min: Math.min(...vals), max: Math.max(...vals), avg: vals.reduce((a, b) => a + b, 0) / vals.length };
    });
    let points = rows;
    if (rows.length > maxPoints) {
      const size = Math.ceil(rows.length / maxPoints);
      points = [];
      for (let i = 0; i < rows.length; i += size) {
        const chunk = rows.slice(i, i + size);
        points.push(
          chunk[0].map((_, c) => {
            if (c === 0) return chunk[Math.floor(chunk.length / 2)][0];
            const v = chunk.map((r) => r[c]).filter((x) => x !== null);
            return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
          })
        );
      }
    }
    return { day, columns: COLUMNS, points, summary, samples: rows.length };
  }

  // Delete day files older than keepDays (0 = keep everything). Runs at most hourly.
  prune(keepDays) {
    if (!keepDays || Date.now() - this.lastPrune < 3600e3) return [];
    this.lastPrune = Date.now();
    const cutoff = dayOf(new Date(Date.now() - keepDays * 864e5));
    const removed = this.days().filter((d) => d < cutoff);
    for (const d of removed) fs.rm(this.fileFor(d), { force: true }, () => {});
    return removed;
  }
}

module.exports = { StatsHistory, COLUMNS };
