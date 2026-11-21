// Profiles: named snapshots of the screen, overlay and fan settings, plus the programs that switch to them
// automatically (e.g. a "Gaming" profile while cs2.exe runs). Pure helpers; main.js owns the state.

const crypto = require('crypto');
const { execFile } = require('child_process');

// What a profile remembers. Everything else (start at sign-in, night mode, alerts, updates...) is global.
const PROFILE_KEYS = ['brightness', 'media', 'layout', 'splitLeft', 'splitRight', 'overlay', 'textColor', 'badges', 'overlayStyle', 'customText', 'nowPlaying', 'fan'];

const clone = (v) => JSON.parse(JSON.stringify(v));
const newId = () => crypto.randomBytes(4).toString('hex');

function snapshot(settings) {
  const data = {};
  for (const k of PROFILE_KEYS) if (settings[k] !== undefined) data[k] = clone(settings[k]);
  return data;
}

function makeProfile(name, settings) {
  return { id: newId(), name: String(name || 'Profile').slice(0, 32), apps: [], hotkey: '', data: snapshot(settings) };
}

// Program names are compared as lower-case "name.exe".
const normApp = (a) => {
  const base = String(a || '').trim().split(/[\\/]/).pop().toLowerCase();
  if (!base) return '';
  return base.endsWith('.exe') ? base : `${base}.exe`;
};

/** Cleans a saved profile list: valid ids, names, app lists and data; never empty. */
function normalize(list, settings) {
  const out = [];
  const seen = new Set();
  for (const p of Array.isArray(list) ? list : []) {
    if (!p || typeof p !== 'object') continue;
    let id = typeof p.id === 'string' && /^[0-9a-f]{8}$/.test(p.id) ? p.id : newId();
    while (seen.has(id)) id = newId();
    seen.add(id);
    const apps = [...new Set((Array.isArray(p.apps) ? p.apps : []).map(normApp).filter(Boolean))].slice(0, 20);
    const data = { ...snapshot(settings), ...(p.data && typeof p.data === 'object' ? p.data : {}) };
    for (const k of Object.keys(data)) if (!PROFILE_KEYS.includes(k)) delete data[k];
    out.push({ id, name: String(p.name || 'Profile').slice(0, 32) || 'Profile', apps, hotkey: typeof p.hotkey === 'string' ? p.hotkey : '', data });
  }
  if (!out.length) out.push({ ...makeProfile('Default', settings) });
  return out;
}

/** The first profile (in list order) with a program that's running now, or null. */
function autoMatch(profiles, running) {
  for (const p of profiles) if (p.apps.some((a) => running.has(a))) return p;
  return null;
}

/** Lower-case names of every running program ("cs2.exe"). Uses tasklist, which is quick. */
function runningPrograms() {
  return new Promise((resolve) => {
    execFile('tasklist', ['/FO', 'CSV', '/NH'], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, out) => {
      if (err) return resolve(null);
      const set = new Set();
      for (const line of String(out).split(/\r?\n/)) {
        const m = line.match(/^"([^"]+)"/);
        if (m) set.add(m[1].toLowerCase());
      }
      resolve(set);
    });
  });
}

/** Programs with a window open right now, for the "add a program" picker: [{ exe, title }]. */
function windowedPrograms() {
  const script =
    "Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle } | " +
    'Select-Object @{n="exe";e={$_.ProcessName + ".exe"}}, @{n="title";e={$_.MainWindowTitle}} | ConvertTo-Json -Compress';
  return new Promise((resolve) => {
    execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 15000 }, (err, out) => {
      if (err) return resolve([]);
      try {
        let list = JSON.parse(String(out).trim() || '[]');
        if (!Array.isArray(list)) list = [list];
        const byExe = new Map();
        for (const p of list) {
          const exe = normApp(p.exe);
          if (exe && !byExe.has(exe)) byExe.set(exe, { exe, title: String(p.title || '').slice(0, 80) });
        }
        resolve([...byExe.values()].sort((a, b) => a.exe.localeCompare(b.exe)));
      } catch {
        resolve([]);
      }
    });
  });
}

module.exports = { PROFILE_KEYS, snapshot, makeProfile, normalize, normApp, autoMatch, runningPrograms, windowedPrograms, clone };
