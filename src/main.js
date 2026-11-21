const { app, BrowserWindow, ipcMain, powerMonitor, dialog, Tray, Menu, shell, globalShortcut, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile, spawn } = require('child_process');
const { CoolerClient } = require('./cooler');
const { LocalSensors } = require('./sensors-local');
const { convertMedia } = require('./media');
const Overlay = require('./overlay');
const { StatsHistory } = require('./history');
const updater = require('./updater');
const system = require('./system');
const Profiles = require('./profiles');
const { RemoteServer, lanAddresses, newPin } = require('./remote');
const { ensureElevated, isElevated, log: launchLog } = require('./elevate');

// --ui-test (development only): the full app with a throwaway settings folder and no cooler connection,
// so the interface can be exercised without touching the real install.
const uiTest = !app.isPackaged && process.argv.includes('--ui-test');

// Same settings folder for the installed app and the development copy (%APPDATA%\frosted-aio).
app.setPath('userData', uiTest ? path.join(app.getPath('temp'), 'frosted-aio-ui-test') : path.join(app.getPath('appData'), 'frosted-aio'));

// The app used to be called "My Kanali". On first start under the new name, bring its settings, uploaded
// media copies and thumbnails across (copied, so the old folder stays as a backup).
function migrateFromMyKanali() {
  if (uiTest) return;
  const oldDir = path.join(app.getPath('appData'), 'my-kanali');
  const newDir = app.getPath('userData');
  if (!fs.existsSync(oldDir) || fs.existsSync(path.join(newDir, 'settings.json'))) return;
  fs.mkdirSync(newDir, { recursive: true });
  for (const item of ['settings.json', 'media', 'thumbs']) {
    const from = path.join(oldDir, item);
    if (fs.existsSync(from)) fs.cpSync(from, path.join(newDir, item), { recursive: true, force: false, errorOnExist: false });
  }
  fs.appendFileSync(path.join(newDir, 'app.log'), `${new Date().toISOString()} migrated settings and media from ${oldDir}\n`);
}
try {
  migrateFromMyKanali();
} catch {
  /* start anyway with defaults */
}

const startHidden = process.argv.includes('--hidden');
const selfLaunch = { execPath: process.execPath, args: app.isPackaged ? [] : [app.getAppPath()] };

// Run by the installer (which is already elevated): point the no-prompt tasks at this exe, then exit.
const registering = process.argv.includes('--register-tasks');
if (registering) {
  const opts = { execPath: process.execPath, appPath: app.getAppPath(), isPackaged: app.isPackaged };
  const done = (code, msg) => {
    launchLog('register-tasks:', msg);
    process.exit(code);
  };
  if (!isElevated()) done(1, 'not elevated, nothing changed');
  // --enable-autostart: the installer saw the old "My Kanali" start at sign-in, so keep that on.
  const enableAutostart = process.argv.includes('--enable-autostart');
  system
    .syncTasks(opts, { force: true })
    .then(async (changed) => {
      if (enableAutostart) {
        await system.setAutostart(true, opts);
        changed.push('start at sign-in kept on (was on in My Kanali)');
      }
      done(0, `ok (${changed.join(', ') || 'already current'})`);
    })
    .catch((e) => done(1, `failed: ${e.message}`));
}

// Not elevated? Hand off to the approved admin task (no prompt) and stop here.
if (!registering) {
  if (!uiTest && !ensureElevated(selfLaunch)) process.exit(0);
  if (!app.requestSingleInstanceLock()) app.exit(0);
}

// ---------- settings ----------

const DEFAULTS = {
  unit: 'Celsius',
  screenOn: true,
  brightness: 70,
  standby: true, // show the standby animation while the PC sleeps
  media: '', // device file name, e.g. 2026-11-11_22-40-37-836.mp4.h264_2240x1080
  layout: 'single', // 'single' (one full-screen file) or 'dual' (split screen)
  splitLeft: '', // device file names, e.g. 2026-11-09_23-20-37-282.png.h264_1120x1080
  splitRight: '',
  poweronMedia: 'default_poweron.mp4.h264_2240x1080',
  standbyMedia: 'default_standby.mp4.h264_2240x1080',
  overlay: ['CPU Temperature', 'CPU Usage', 'CPU Power', 'Memory Usage', 'GPU Temperature', 'GPU Usage', 'GPU Power', 'Clock'],
  textColor: '#dcdcdc',
  badges: { cpu: true, gpu: true }, // CPU/GPU name pills at the top of the screen, like KANALI
  overlayStyle: { font: 'roboto-regular', size: 100, preset: 'columns', titles: true },
  customText: 'My PC',
  // Now Playing: the song Windows' media controls report, as a top line or a bottom bar (stat slots stay).
  nowPlaying: { ...Overlay.NP_DEFAULTS },
  // Night mode: dim (or turn off, brightness 0) the pump screen on a schedule and/or when the PC is idle.
  night: { schedule: false, start: '22:00', end: '07:00', brightness: 15, idle: false, idleMinutes: 10, idleBrightness: 10 },
  // Stats history: one CSV per day in Documents\Frosted-AIO\History. keepDays 0 = keep forever.
  history: { enabled: true, interval: 5, keepDays: 0 },
  // Updates: check GitHub Releases shortly after start and every 12 hours.
  updates: { auto: true },
  // Profiles (see profiles.js): snapshots of screen/overlay/fan settings. Edits save into the active one.
  profiles: [],
  activeProfile: '',
  autoSwitch: true, // switch profiles when one of their programs is running
  autoFrom: '', // the profile to go back to when the program that switched us closes
  profileToasts: true, // Windows notification when a program or hotkey switches profile
  // Temperature alerts: after `seconds` at or over the limit (°C); clears 5 °C below it.
  alerts: { enabled: true, cpu: 95, gpu: 88, seconds: 5, notify: true, fanBoost: true, redText: true },
  // Global keyboard shortcuts (Electron accelerators, '' = off). Profile shortcuts live on each profile.
  hotkeys: { toggleScreen: '', nextProfile: '', toggleNight: '', fanBoost: '', brightnessUp: '', brightnessDown: '', playPause: '' },
  // Phone remote: web page on the home network, signed in with a 6-digit PIN.
  remote: { enabled: false, port: 8457, pin: '' },
  closeToTray: true,
  fan: {
    mode: 'Smart Mode',
    smartMode: [[0, 10], [10, 20], [30, 30], [50, 40], [65, 55], [80, 70], [90, 100], [100, 100]],
    fixedMode: 50
  }
};

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');

// Bundled open-source parts: ffmpeg (video conversion) and LibreHardwareMonitor (sensors).
// resources\<name> when installed, vendor\<name> in the project. No TRYX software is used.
const vendorDir = (name) => (app.isPackaged ? path.join(process.resourcesPath, name) : path.join(app.getAppPath(), 'vendor', name));
const ffmpegDir = () => vendorDir('ffmpeg');
let settings = { ...DEFAULTS };

// Small rolling log at %APPDATA%\frosted-aio\app.log for troubleshooting.
function log(...parts) {
  try {
    const file = path.join(app.getPath('userData'), 'app.log');
    if (fs.existsSync(file) && fs.statSync(file).size > 1024 * 1024) fs.renameSync(file, file + '.old');
    const line = parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ');
    fs.appendFileSync(file, `${new Date().toISOString()} ${line}\n`);
  } catch {
    /* logging must never break the app */
  }
}

const firstFileName = (v) => (Array.isArray(v) ? firstFileName(v[0]) : typeof v === 'string' ? v : '');

function loadSettings() {
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
  } catch (e) {
    let listing = [];
    try {
      listing = fs.readdirSync(path.dirname(settingsFile()));
    } catch (e2) {
      listing = ['readdir failed: ' + e2.code];
    }
    log('could not read settings:', e.code, 'dir has:', listing, 'user=', process.env.USERNAME, 'appdata=', process.env.APPDATA);
  }
  // Keep only known keys (drops leftovers from the first version of the app).
  settings = { ...DEFAULTS };
  for (const k of Object.keys(DEFAULTS)) if (k in saved) settings[k] = saved[k];
  // Grouped settings: fill in any options added since the file was saved.
  for (const k of ['badges', 'overlayStyle', 'night', 'history', 'fan', 'nowPlaying', 'updates', 'alerts', 'hotkeys', 'remote']) settings[k] = { ...DEFAULTS[k], ...(saved[k] || {}) };
  settings.media = firstFileName(settings.media);
  settings.splitLeft = firstFileName(settings.splitLeft);
  settings.splitRight = firstFileName(settings.splitRight);
  if (!['single', 'dual'].includes(settings.layout)) settings.layout = 'single';
  // First start with profiles: today's settings become the "Default" profile.
  settings.profiles = Profiles.normalize(settings.profiles, settings);
  if (!settings.profiles.some((p) => p.id === settings.activeProfile)) settings.activeProfile = settings.profiles[0].id;
  if (!/^\d{6}$/.test(settings.remote.pin)) settings.remote.pin = newPin();
  const port = Number(settings.remote.port);
  settings.remote.port = Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : DEFAULTS.remote.port;
  // Keep the new profile ids and PIN stable from the first start.
  if (!Array.isArray(saved.profiles) || !saved.profiles.length || saved.remote?.pin !== settings.remote.pin) {
    try {
      saveSettings();
    } catch (e) {
      log('could not save settings:', e.message);
    }
  }
  log('loaded settings from', settingsFile(), 'keys=', Object.keys(saved).length, 'saved.media=', saved.media, 'media=', settings.media);
}

function saveSettings() {
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2));
}

// ---------- state ----------

let win = null;
let bridge = null;
let sensors = null;
let tickTimer = null;
let status = { status: 'idle', detail: '', device: null };
let deviceMedia = [];
let lastFanPower = null;
let smoothTemp = null;
let haveTemp = false;
const stats = {
  cpu: { load: 0, temperature: 0, frequency: 0, power: 0 },
  gpu: { load: 0, temperature: 0, frequency: 0, power: 0 },
  memory: { load: 0, frequency: 0 },
  network: { down: 0, up: 0 }, // bytes per second
  disk: { load: 0 }, // C: drive, % used
  cooler: { fansSpeed: 0, pumpSpeed: 0 }
};

function setStatus(s, detail = '') {
  status = { status: s, detail, device: bridge?.device || null };
  win?.webContents.send('status', status);
  buildTrayMenu();
}

// ---------- screen config (Panorama SE / Panorama, 2240x1080) ----------

function userConfig() {
  return {
    poweronConfig: { mediaFile: settings.poweronMedia },
    standbyConfig: { enable: settings.standby, mediaFile: settings.standbyMedia },
    workConfig: {
      mediaMode: settings.layout === 'dual' ? 'MediaMode_Dual' : 'MediaMode_Single',
      singleModeMediaFile: settings.media,
      dualModeLeftMediaFile: settings.splitLeft,
      dualModeRightMediaFile: settings.splitRight,
      loopMode: 'LoopMode_Single'
    },
    displayConfig: {
      backlightBrightness: (sentBrightness = effectiveBrightness()),
      backlightEnable: settings.screenOn && sentBrightness > 0, // night mode at 0% turns the screen off
      mirror: false,
      uiRotation: 0,
      mediaRotation: 0
    }
  };
}

// ---------- stats overlay (layout and items live in overlay.js, shared with the preview) ----------

const overlayCtx = () => ({ unit: settings.unit, customText: settings.customText, now: new Date(), nowPlaying });

// ---------- Now Playing helper ----------
// A small PowerShell script (src/nowplaying.ps1) reads Windows' media controls and prints a JSON line per second.
// It sits outside the app's archive (asarUnpack) so PowerShell can read it.

let nowPlaying = { playing: false, status: 'None' };
let npProc = null;
let npRetry = null;
const npScript = () => path.join(__dirname, 'nowplaying.ps1').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);

function startNowPlaying() {
  if (npProc || !settings.nowPlaying.enabled || quitting) return;
  clearTimeout(npRetry);
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', npScript()];
  npProc = spawn('powershell', args, { windowsHide: true });
  let buf = '';
  npProc.stdout.on('data', (d) => {
    buf += d.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      try {
        const next = JSON.parse(line);
        if (next.error && next.error !== nowPlaying.error) log('now playing:', next.error);
        nowPlaying = next;
      } catch {
        /* ignore partial lines */
      }
    }
  });
  npProc.stderr.on('data', (d) => log('now playing helper:', String(d).trim().slice(0, 300)));
  npProc.on('exit', (code) => {
    npProc = null;
    nowPlaying = { playing: false, status: 'None' };
    if (settings.nowPlaying.enabled && !quitting) {
      log('now playing helper exited', code, '- restarting in 10 s');
      npRetry = setTimeout(startNowPlaying, 10000);
    }
  });
}

function stopNowPlaying() {
  clearTimeout(npRetry);
  const p = npProc;
  npProc = null;
  p?.kill();
  nowPlaying = { playing: false, status: 'None' };
}

function mediaCommand(cmd) {
  if (!['play-pause', 'next', 'previous'].includes(cmd)) return;
  spawn('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', npScript(), '-Command', cmd], { windowsHide: true });
}

// During a temperature alert (with "red text" on) the overlay is drawn in red.
const ALERT_COLOR = '#ff4d4d';
const overlaySettings = () => (alertActive().length && settings.alerts.redText ? { ...settings, textColor: ALERT_COLOR } : settings);

function runConfig() {
  const labelGroups = Overlay.groups(overlaySettings(), overlayStats(), overlayCtx());
  labelGroups.push(...badgeGroups());
  return { labelGroups };
}

const overlayStats = () => ({ ...stats, fanPower: lastFanPower ?? 0 });

// ---------- CPU / GPU badges ----------
// The hardware-name pills KANALI drew at the top of the screen: white text on a horizontal gradient in
// the brand's colors, CPU top-left (group 300), GPU top-right (group 400). Values copied from KANALI 2.6.0.

const BRAND_COLORS = {
  intel: { backgroundColor: 26805, gradientColor: 5664152 },
  amd: { backgroundColor: 11087660, gradientColor: 13328950 },
  nvidia: { backgroundColor: 6461952, gradientColor: 7973713 }
};
const NEUTRAL_BADGE = { backgroundColor: 0x2b2f36, gradientColor: 0x4a505a }; // any other brand

let hwNames = { cpu: '', gpu: '' };

function brandOf(name) {
  const n = String(name).toLowerCase();
  if (n.includes('intel')) return 'intel';
  if (n.includes('nvidia') || n.includes('geforce')) return 'nvidia';
  if (n.includes('amd') || n.includes('radeon') || n.includes('ryzen')) return 'amd';
  return null;
}

function badgeLabel(labelId, name) {
  const colors = BRAND_COLORS[brandOf(name)] || NEUTRAL_BADGE;
  return {
    labelId,
    text: `  ${name}  `,
    background: 'BackGround_GardientHorizontal', // TRYX's spelling
    ...colors,
    textSize: 30,
    textColor: 14474460,
    gapLeft: 0,
    textFont: 'roboto-regular'
  };
}

function badgeGroups() {
  const groups = [];
  const b = settings.badges || {};
  if (b.cpu && hwNames.cpu) {
    groups.push({ groupId: 300, groupX: 70, groupY: 70, groupWidth: 1000, textAlign: 'Left', lineGap: 1, labels: [badgeLabel(301, hwNames.cpu)] });
  }
  if (b.gpu && hwNames.gpu) {
    groups.push({ groupId: 400, groupX: 1180, groupY: 70, groupWidth: 1000, textAlign: 'Right', lineGap: 1, labels: [badgeLabel(402, hwNames.gpu)] });
  }
  return groups;
}

// CPU from Windows' processor name; GPU from the video adapters, preferring a discrete card.
function detectHardwareNames() {
  const cpu = (require('os').cpus()[0]?.model || '').replace(/\s+/g, ' ').trim();
  return new Promise((resolve) => {
    execFile(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', '(Get-CimInstance Win32_VideoController).Name'],
      { windowsHide: true },
      (err, out) => {
        const gpus = err ? [] : String(out).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
        const discrete = gpus.find((g) => /nvidia|geforce|radeon rx|radeon pro|arc a|arc b/i.test(g));
        resolve({ cpu, gpu: discrete || gpus.find((g) => !/basic display|virtual|remote/i.test(g)) || '' });
      }
    );
  });
}

const labelUpdates = () => Overlay.updates(settings, overlayStats(), overlayCtx());

// ---------- fan ----------

function curveAt(points, t) {
  if (t <= points[0][0]) return points[0][1];
  for (let i = 1; i < points.length; i++) {
    const [t1, v1] = points[i];
    const [t0, v0] = points[i - 1];
    if (t <= t1) return Math.round(v0 + ((t - t0) / Math.max(1, t1 - t0)) * (v1 - v0));
  }
  return points[points.length - 1][1];
}

function applyFan(force = false) {
  if (!bridge?.device) return;
  let p;
  if (fanBoost || (settings.alerts.fanBoost && alertActive().length)) {
    p = 100; // fan boost (hotkey/tray/phone) or a temperature alert
  } else if (settings.fan.mode === 'Fixed Mode') {
    p = settings.fan.fixedMode;
  } else {
    // No reading yet: leave the cooler on whatever it was doing rather than drive it from 0 °C.
    if (!haveTemp) return;
    // Smooth CPU temperature (it spikes by several degrees from second to second).
    const raw = stats.cpu.temperature;
    smoothTemp = smoothTemp === null ? raw : smoothTemp * 0.8 + raw * 0.2;
    p = curveAt(settings.fan.smartMode, smoothTemp);
    // Only slow down once it's 3 °C cooler than needed for the current speed, so fans don't flutter.
    if (lastFanPower !== null && p < lastFanPower) p = Math.min(lastFanPower, curveAt(settings.fan.smartMode, smoothTemp + 3));
  }
  p = Math.max(0, Math.min(100, Math.round(p)));
  if (force || p !== lastFanPower) {
    bridge.setFanPower(p);
    lastFanPower = p;
  }
}

// ---------- device push ----------

// Only send screen settings once there's something to show, so we never blank or confuse the cooler.
const screenReady = () => (settings.layout === 'dual' ? !!(settings.splitLeft || settings.splitRight) : !!settings.media);

const appliers = {
  screen: () => screenReady() && bridge.setUserConfig(userConfig()),
  overlay: () => {
    lastLayoutKey = Overlay.layoutKey(settings, overlayCtx());
    bridge.setRunConfig(runConfig());
  },
  fan: () => applyFan(true),
  unit: () => bridge.setRunConfig(runConfig())
};

// Turning Now Playing on/off starts/stops the helper; any of its options can change the layout.
function applyNowPlayingSetting() {
  settings.nowPlaying.enabled ? startNowPlaying() : stopNowPlaying();
  if (bridge?.device) appliers.overlay();
}

function pushAll() {
  const sent = screenReady() ? bridge.setUserConfig(userConfig()) : 'skipped (nothing chosen yet)';
  log('pushAll layout=', settings.layout, 'media=', settings.media, 'left=', settings.splitLeft, 'right=', settings.splitRight, 'sent=', sent);
  setTimeout(() => bridge?.setRunConfig(runConfig()), 300);
  setTimeout(() => applyFan(true), 500);
  bridge.requestFileList();
}

// ---------- loop ----------

let busy = false;
let loggedRaw = false;
let lastDiskCheck = 0;
let history = null;

async function tick() {
  if (busy) return;
  busy = true;
  try {
    if (sensors) {
      const { raw, ...r } = await sensors.read();
      Object.assign(stats, r);
      if (r.cpu.temperature > 0) haveTemp = true;
      if (!loggedRaw && raw) {
        loggedRaw = true;
        log('sensor sample (raw keys and values):', raw);
      }
    }
  } catch {
    /* skip this tick */
  }
  busy = false;
  if (Date.now() - lastDiskCheck > 30000) {
    lastDiskCheck = Date.now();
    fs.promises
      .statfs('C:\\')
      .then((s) => (stats.disk = { load: Math.round((1 - s.bavail / s.blocks) * 100) }))
      .catch(() => {});
  }
  if (bridge?.device) {
    // Now Playing appearing/disappearing changes the layout (bar, compact rows): re-send it. Otherwise just text.
    const key = Overlay.layoutKey(settings, overlayCtx());
    if (key !== lastLayoutKey) {
      lastLayoutKey = key;
      bridge.setRunConfig(runConfig());
    } else {
      bridge.updateLabels(labelUpdates());
    }
    bridge.requestCoolerStatus();
  }
  checkAlerts();
  if (bridge?.device) {
    applyFan();
    applyNight();
  }
  if (settings.history.enabled && haveTemp) {
    history ||= new StatsHistory(historyDir());
    history.record(stats, lastFanPower, settings.history.interval);
    const removed = history.prune(settings.history.keepDays);
    if (removed.length) log('history: removed old days', removed);
  }
  win?.webContents.send('stats', liveStats());
}

const liveStats = () => ({ ...stats, fanPower: lastFanPower, night: nightState(), nowPlaying, alerts: alertActive(), fanBoost });

let lastLayoutKey = null;

// ---------- temperature alerts ----------
// A sensor is "in alert" after settings.alerts.seconds at or over its limit, and leaves it 5 °C below.
// While any alert is on: a Windows notification (at most every 5 minutes per sensor), fans at 100% and
// red overlay text, each optional.

const alertState = { cpu: { over: 0, active: false, notified: 0 }, gpu: { over: 0, active: false, notified: 0 } };
const alertActive = () => Object.keys(alertState).filter((k) => alertState[k].active).map((k) => k.toUpperCase());

function checkAlerts() {
  const a = settings.alerts;
  const before = alertActive().join();
  for (const kind of ['cpu', 'gpu']) {
    const s = alertState[kind];
    const limit = Number(a[kind]) || 0;
    const t = stats[kind].temperature;
    if (!a.enabled || !limit || !haveTemp || !(t > 0)) {
      s.over = 0;
      s.active = false;
      continue;
    }
    s.over = t >= limit ? s.over + 1 : 0;
    if (!s.active && s.over >= Math.max(1, a.seconds)) {
      s.active = true;
      log(`alert: ${kind} at ${t} °C (limit ${limit})`);
      if (a.notify && Date.now() - s.notified > 5 * 60 * 1000) {
        s.notified = Date.now();
        const shown = settings.unit === 'Fahrenheit' ? `${Math.round(t * 1.8 + 32)} °F` : `${Math.round(t)} °C`;
        toast(`${kind.toUpperCase()} is at ${shown}`, `That's over your ${kind.toUpperCase()} alert limit.${a.fanBoost ? ' Fans are at full speed until it cools down.' : ''}`);
      }
    } else if (s.active && t < limit - 5) {
      s.active = false;
      log(`alert: ${kind} back to ${t} °C`);
    }
  }
  if (alertActive().join() !== before && bridge?.device) {
    bridge.setRunConfig(runConfig()); // red text on/off
    applyFan(true);
  }
}

function toast(title, body, { silent = false } = {}) {
  try {
    if (!Notification.isSupported()) return;
    const n = new Notification({ title, body, silent, icon: path.join(__dirname, 'assets', 'icon-256.png') });
    n.on('click', showWindow);
    n.show();
  } catch (e) {
    log('notification failed:', e.message);
  }
}

const historyDir = () => path.join(app.getPath('documents'), 'Frosted-AIO', 'History');

// History used to live in Documents\My Kanali; rename that folder once so nothing is lost.
function migrateHistoryFolder() {
  if (uiTest) return;
  const oldDir = path.join(app.getPath('documents'), 'My Kanali');
  const newDir = path.join(app.getPath('documents'), 'Frosted-AIO');
  if (!fs.existsSync(oldDir) || fs.existsSync(newDir)) return;
  try {
    fs.renameSync(oldDir, newDir);
    log('moved history from', oldDir, 'to', newDir);
  } catch (e) {
    log('could not move history folder:', e.message);
  }
}

// ---------- night mode ----------
// Lowers the pump screen's brightness on a schedule and/or after the PC has been idle for a while.
// Your normal brightness setting is untouched; it comes back by itself when night mode ends.

const toMinutes = (hhmm) => {
  const [h, m] = String(hhmm || '0:0').split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
};

// Night mode toggled by hotkey, tray or phone: 'on' forces it on, 'off' cancels it until the schedule/idle
// rule that turned it on ends, null follows the rules.
let nightOverride = null;
let fanBoost = false;

function nightState() {
  const base = nightRules();
  if (nightOverride === 'off') {
    if (!base.active) nightOverride = null;
    else return { active: false, reasons: [], overridden: true, brightness: settings.brightness };
  }
  if (nightOverride === 'on') {
    const brightness = Math.min(base.brightness, settings.night.brightness, settings.brightness);
    return { active: true, reasons: [...base.reasons, 'manual'], brightness };
  }
  return base;
}

function nightRules() {
  const n = settings.night;
  const reasons = [];
  let level = Infinity;
  if (n.schedule) {
    const now = new Date();
    const t = now.getHours() * 60 + now.getMinutes();
    const a = toMinutes(n.start);
    const b = toMinutes(n.end);
    const inWindow = a === b ? false : a < b ? t >= a && t < b : t >= a || t < b; // window may cross midnight
    if (inWindow) {
      reasons.push('schedule');
      level = Math.min(level, n.brightness);
    }
  }
  if (n.idle && powerMonitor.getSystemIdleTime() >= n.idleMinutes * 60) {
    reasons.push('idle');
    level = Math.min(level, n.idleBrightness);
  }
  return reasons.length ? { active: true, reasons, brightness: Math.min(settings.brightness, level) } : { active: false, reasons, brightness: settings.brightness };
}

let sentBrightness = null;
const effectiveBrightness = () => nightState().brightness;

function applyNight() {
  const b = effectiveBrightness();
  if (b === sentBrightness || !screenReady()) return;
  log('night mode:', nightState().active ? `dimming to ${b}%` : `back to ${b}%`);
  bridge.setUserConfig(userConfig());
  buildTrayMenu(); // the tray's "Night mode" tick
}

// ---------- connection ----------

function kanaliRunning() {
  return new Promise((resolve) => {
    execFile('tasklist', ['/FI', 'IMAGENAME eq KANALI.exe', '/NH'], { windowsHide: true }, (err, out) =>
      resolve(!err && out.toLowerCase().includes('kanali.exe'))
    );
  });
}

const mediaDir = () => path.join(app.getPath('userData'), 'media');
const localPreview = (fileName) => {
  const base = fileName.replace(/\.h264_\d+x\d+$/, '');
  for (const dir of [mediaDir(), path.join(app.getPath('appData'), 'kanali', 'media')]) {
    const p = path.join(dir, base);
    if (fs.existsSync(p)) return p;
  }
  return null;
};

// ---------- thumbnails ----------
// Small still images for the media grid, cached in %APPDATA%\frosted-aio\thumbs. They're keyed by the
// file's name on the cooler (without the .h264_WxH suffix), so they keep working even after the source
// file is gone, e.g. KANALI's own copies, which its uninstaller deleted. Made at upload time, and in the
// background for anything that has a local source but no thumbnail yet.

const thumbDir = () => path.join(app.getPath('userData'), 'thumbs');
const thumbKey = (fileName) => fileName.replace(/\.h264_\d+x\d+$/, '');
const thumbPath = (fileName) => path.join(thumbDir(), thumbKey(fileName) + '.jpg');
const thumbFor = (fileName) => (fileName && fs.existsSync(thumbPath(fileName)) ? thumbPath(fileName) : null);

function runFfmpeg(args, timeoutMs = 30000) {
  return new Promise((resolve) => {
    const ffmpeg = path.join(ffmpegDir(), 'ffmpeg.exe');
    execFile(ffmpeg, ['-nostdin', ...args], { windowsHide: true, timeout: timeoutMs }, (err, _o, stderr) =>
      resolve(err ? (String(stderr).trim().split('\n').pop() || err.message) : null)
    );
  });
}

// Writes the thumbnail for `fileName` from `source`. Returns null on success, or an error message.
async function makeThumb(fileName, source) {
  fs.mkdirSync(thumbDir(), { recursive: true });
  const out = thumbPath(fileName);
  const still = /\.(png|jpe?g|bmp|webp)$/i.test(source);
  const tail = ['-i', source, '-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', '4', out];
  let err = await runFfmpeg(['-y', '-v', 'error', ...(still ? [] : ['-ss', '1']), ...tail]);
  if (!fs.existsSync(out) && !still) err = await runFfmpeg(['-y', '-v', 'error', ...tail]); // clips under 1 s
  return fs.existsSync(out) ? null : err || 'no image written';
}

let thumbQueue = [];
let thumbBusy = false;

function queueThumbs(list) {
  for (const m of list) {
    if (m.preview && !m.thumb && !thumbQueue.some((q) => q.fileName === m.fileName)) thumbQueue.push({ fileName: m.fileName, source: m.preview });
  }
  if (!thumbBusy) drainThumbs();
}

async function drainThumbs() {
  thumbBusy = true;
  try {
    while (thumbQueue.length) {
      const { fileName, source } = thumbQueue.shift();
      if (thumbFor(fileName)) continue;
      const err = await makeThumb(fileName, source);
      if (err) {
        log('thumbnail failed for', fileName, err);
        continue;
      }
      const t = thumbFor(fileName);
      let changed = false;
      for (const m of deviceMedia) if (m.fileName === fileName && m.thumb !== t) (m.thumb = t), (changed = true);
      if (changed) win?.webContents.send('media', deviceMedia);
    }
  } catch (e) {
    log('thumbnail queue error:', e.message);
  } finally {
    thumbBusy = false;
  }
}

function disconnect() {
  clearInterval(tickTimer);
  tickTimer = null;
  bridge?.removeAllListeners();
  bridge?.stop();
  sensors?.stop();
  bridge = null;
  sensors = null;
  lastFanPower = null;
  smoothTemp = null;
  haveTemp = false;
}

async function connect() {
  disconnect();
  if (await kanaliRunning()) {
    return setStatus('blocked', 'KANALI is running and is using the cooler. Quit KANALI from the system tray, then click Retry.');
  }
  setStatus('starting', 'Starting…');
  // TRYX's own services (from KANALI or older Frosted-AIO builds) would compete for the cooler: stop them.
  for (const img of ['UDB.exe', 'Screen.exe']) {
    const stopped = await system.stopForeignService(img, '');
    if (stopped.length) log('stopped TRYX service', img, stopped);
  }
  if (bridge || sensors) return; // a newer connect() started while we waited
  sensors = new LocalSensors({ libDir: vendorDir('sensors'), log });
  bridge = new CoolerClient({ log });
  bridge.on('waiting', (m) => setStatus('connecting', m));

  bridge.on('online', (d) => {
    setStatus('connected', `${d.productName} · ${d.sn}`);
    pushAll();
  });
  bridge.on('offline', () => setStatus('connecting', 'The cooler went offline. Waiting for it to come back…'));
  bridge.on('lost', (why) => setStatus('error', `${why} Click Retry.`));
  bridge.on('coolerStatus', (c) => {
    if (c.fansSpeed <= 3700) stats.cooler.fansSpeed = c.fansSpeed;
    stats.cooler.pumpSpeed = c.pumpSpeed ?? stats.cooler.pumpSpeed;
  });
  bridge.on('userConfig', (u) => {
    // First run: adopt what's already on the cooler instead of overwriting it.
    // The cooler may report this as a string, a (possibly empty) array, or nested arrays.
    const current = firstFileName(u?.workConfig?.singleModeMediaFile);
    log('cooler userConfig: media=', current, 'ours=', settings.media);
    if (!settings.media && current) {
      settings.media = current;
      if (u.displayConfig?.backlightBrightness != null) settings.brightness = u.displayConfig.backlightBrightness;
      saveSettings();
      win?.webContents.send('settings', settings);
    }
  });
  bridge.on('fileList', (list) => {
    deviceMedia = list
      .map((f) => {
        const fileName = path.posix.basename(f.filePath || '');
        const size = (fileName.match(/\.h264_(\d+)x(\d+)$/) || [])[1];
        return {
          fileName,
          bytes: f.fileSize,
          readOnly: !!f.readOnly || /^\/userdata\/default\//.test(f.filePath || ''),
          half: size === '1120', // split-screen side media
          preview: localPreview(fileName)
        };
      })
      .filter((m) => m.fileName && !/^default_(poweron|standby)/.test(m.fileName));
    for (const m of deviceMedia) m.thumb = thumbFor(m.fileName);
    win?.webContents.send('media', deviceMedia);
    queueThumbs(deviceMedia);
  });

  try {
    await sensors.start();
  } catch (e) {
    sensors = null; // the screen still works without live stats
    console.warn(e.message);
  }
  try {
    setStatus('connecting', 'Connecting to the cooler…');
    await bridge.start();
    setTimeout(() => {
      if (bridge && !bridge.device) setStatus('connecting', 'Waiting for the cooler to show up on USB…');
    }, 4000);
  } catch (e) {
    return setStatus('error', e.message);
  }
  tickTimer = setInterval(tick, 1000);
}

// ---------- adding videos ----------

let uploading = false;
const sendUpload = (u) => win?.webContents.send('upload', u);

function waitForTransmit(trackId, onPct) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => done(new Error('The cooler stopped responding during the transfer.')), 15 * 60 * 1000);
    const onT = (s) => {
      if (s.trackId !== trackId) return;
      if (s.fileSize) onPct(Math.min(100, Math.round((s.transSize / s.fileSize) * 100)));
      if (s.status === 'Success') done();
      else if (['Canceled', 'PreProcessFail', 'Failed'].includes(s.status)) done(new Error(`The cooler reported "${s.status}" ${s.detailInfo || ''}`.trim()));
    };
    const onLost = () => done(new Error('Lost the connection to the cooler during the transfer.'));
    const done = (err) => {
      clearTimeout(timer);
      bridge?.off('transmit', onT);
      bridge?.off('lost', onLost);
      err ? reject(err) : resolve();
    };
    bridge.on('transmit', onT);
    bridge.on('lost', onLost);
  });
}

// target: 'full' (whole screen) or 'left' / 'right' (one half of split screen)
async function addMedia(target = 'full') {
  if (uploading) throw new Error('Something is already being added.');
  if (!bridge?.device) throw new Error('The cooler is not connected.');
  const side = target === 'left' || target === 'right';
  const pick = await dialog.showOpenDialog(win, {
    title: side ? `Add an image, GIF or video for the ${target} side` : 'Add a video to your cooler',
    properties: ['openFile'],
    filters: side
      ? [{ name: 'Images, GIFs and videos', extensions: ['png', 'jpg', 'jpeg', 'bmp', 'webp', 'gif', 'mp4', 'mov', 'mkv', 'webm', 'avi'] }]
      : [{ name: 'Videos and GIFs', extensions: ['mp4', 'mov', 'mkv', 'webm', 'avi', 'gif'] }]
  });
  if (pick.canceled) return null;
  uploading = true;
  let h264Path;
  try {
    sendUpload({ stage: 'convert', pct: 0, target });
    const out = await convertMedia({
      ffmpegDir: ffmpegDir(),
      src: pick.filePaths[0],
      size: side ? 'half' : 'full',
      outDir: mediaDir(),
      onProgress: (pct) => sendUpload({ stage: 'convert', pct, target })
    });
    h264Path = out.h264Path;
    // Thumbnail now, while the source is certainly here.
    const thumbErr = await makeThumb(out.deviceName, out.previewPath);
    if (thumbErr) log('thumbnail failed for', out.deviceName, thumbErr);
    sendUpload({ stage: 'send', pct: 0, target });
    const trackId = String(Date.now() % 1e6);
    const wait = waitForTransmit(trackId, (pct) => sendUpload({ stage: 'send', pct, target }));
    if (!bridge.transmitFile(h264Path, trackId)) throw new Error('The cooler is not connected.');
    await wait;
    if (target === 'left') Object.assign(settings, { splitLeft: out.deviceName, layout: 'dual' });
    else if (target === 'right') Object.assign(settings, { splitRight: out.deviceName, layout: 'dual' });
    else Object.assign(settings, { media: out.deviceName, layout: 'single' });
    saveSettings();
    log('added', target, out.deviceName);
    appliers.screen();
    setTimeout(() => bridge?.requestFileList(), 500);
    sendUpload({ stage: 'done', pct: 100, target });
    return settings;
  } catch (e) {
    sendUpload({ stage: 'error', pct: 0, message: e.message, target });
    throw e;
  } finally {
    uploading = false;
    // The cooler keeps its own copy; the large H.264 intermediate isn't needed here.
    if (h264Path) fs.rm(h264Path, { force: true }, () => {});
  }
}

// ---------- window, tray, IPC ----------

let tray = null;
let quitting = false;

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function quitApp() {
  quitting = true;
  stopNowPlaying();
  try {
    disconnect();
  } catch {
    /* quitting anyway */
  }
  tray?.destroy();
  tray = null;
  app.quit();
  setTimeout(() => app.exit(0), 2000); // never leave a hidden instance behind
}

function createWindow() {
  win = new BrowserWindow({
    icon: path.join(__dirname, 'assets', 'icon.ico'), // taskbar/window icon when running from source
    width: 1180,
    height: 780,
    minWidth: 900,
    minHeight: 620,
    show: !startHidden,
    backgroundColor: '#0c0d10',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0c0d10', symbolColor: '#8b909a', height: 44 },
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  // Page warnings and errors go to app.log too.
  win.webContents.on('console-message', (_e, level, message, line, source) => {
    if (level >= 2) log('page', level === 3 ? 'error' : 'warn', message, `${path.basename(source || '')}:${line}`);
  });
  win.on('close', (e) => {
    if (!quitting && settings.closeToTray) {
      e.preventDefault();
      win.hide();
    }
  });
}

function buildTrayMenu() {
  if (!tray) return;
  tray.setToolTip(status.status === 'connected' ? 'Frosted-AIO · cooler connected' : 'Frosted-AIO · not connected');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open Frosted-AIO', click: showWindow },
      ...(updateState.phase === 'available'
        ? [{ label: `Update to ${updateState.version}…`, click: () => { showWindow(); win?.webContents.send('show-view', 'settings'); } }]
        : []),
      { type: 'separator' },
      {
        label: 'Profile',
        submenu: settings.profiles.map((p) => ({
          label: p.name.replace(/&/g, '&&'),
          type: 'radio',
          checked: p.id === settings.activeProfile,
          click: () => activateProfile(p.id, 'manual')
        }))
      },
      { label: 'Pump screen on', type: 'checkbox', checked: settings.screenOn, click: (item) => actions.screen(item.checked) },
      { label: 'Night mode', type: 'checkbox', checked: nightState().active, click: () => actions.toggleNight() },
      { label: 'Fan boost (100%)', type: 'checkbox', checked: fanBoost, click: (item) => actions.fanBoost(item.checked) },
      { type: 'separator' },
      { label: 'Quit', click: quitApp }
    ])
  );
}

function createTray() {
  tray = new Tray(system.trayIcon());
  tray.on('click', showWindow);
  buildTrayMenu();
}

const autostartOpts = () => ({ execPath: process.execPath, appPath: app.getAppPath(), isPackaged: app.isPackaged });

ipcMain.handle('media:add', (_e, target) => addMedia(target));

// Permanently removes a file from the cooler, after the renderer has confirmed with the user.
ipcMain.handle('media:delete', (_e, fileName) => {
  const item = deviceMedia.find((m) => m.fileName === fileName);
  if (!item) throw new Error('That file is no longer on the cooler.');
  if (item.readOnly) throw new Error("That's one of TRYX's built-in videos and can't be deleted.");
  if (!bridge?.device) throw new Error('The cooler is not connected.');

  // If it's on screen right now, switch to something else first so the screen never points at a missing file.
  const fullFallback = deviceMedia.find((m) => !m.half && m.fileName !== fileName)?.fileName || 'default_01.mp4.h264_2240x1080';
  let changed = false;
  if (settings.media === fileName) (settings.media = fullFallback), (changed = true);
  if (settings.splitLeft === fileName) (settings.splitLeft = ''), (changed = true);
  if (settings.splitRight === fileName) (settings.splitRight = ''), (changed = true);
  if (settings.layout === 'dual' && !settings.splitLeft && !settings.splitRight) (settings.layout = 'single'), (changed = true);
  // Other profiles may use it too: point them at the same fallback.
  for (const p of settings.profiles) {
    const d = p.data;
    if (d.media === fileName) d.media = fullFallback;
    if (d.splitLeft === fileName) d.splitLeft = '';
    if (d.splitRight === fileName) d.splitRight = '';
    if (d.layout === 'dual' && !d.splitLeft && !d.splitRight) d.layout = 'single';
    if (p.id === settings.activeProfile) Object.assign(d, { media: settings.media, splitLeft: settings.splitLeft, splitRight: settings.splitRight, layout: settings.layout });
  }
  saveSettings();
  if (changed) {
    saveSettings();
    bridge.setUserConfig(userConfig());
  }

  bridge.removeFile(fileName);
  log('deleted', fileName, 'switched screen:', changed);
  const local = localPreview(fileName);
  if (local && local.startsWith(mediaDir())) fs.rm(local, { force: true }, () => {});
  fs.rm(thumbPath(fileName), { force: true }, () => {});
  deviceMedia = deviceMedia.filter((m) => m.fileName !== fileName);
  win?.webContents.send('media', deviceMedia);
  setTimeout(() => bridge?.requestFileList(), 600);
  return settings;
});
ipcMain.handle('app:quit', () => quitApp());
ipcMain.handle('system:shortcut', async () => {
  try {
    const lnk = await system.createDesktopShortcut({ ...autostartOpts(), userData: app.getPath('userData'), desktop: app.getPath('desktop') });
    log('desktop shortcut created at', lnk);
    return lnk;
  } catch (e) {
    log('desktop shortcut failed:', e.message);
    throw e;
  }
});

ipcMain.handle('system:get', async () => {
  const r = {
    autostart: await system.isAutostartEnabled(),
    shortcut: await system.hasDesktopShortcut(app.getPath('desktop')),
    kanali: await system.kanaliAutostart()
  };
  log('system state:', r);
  return r;
});
ipcMain.handle('system:autostart', async (_e, on) => {
  log('Frosted-AIO start-with-Windows switch flipped to', on);
  await system.setAutostart(on, autostartOpts());
  return system.isAutostartEnabled();
});
ipcMain.handle('system:kanaliAutostart', async (_e, on) => {
  log('KANALI autostart switch flipped to', on);
  try {
    const r = await system.setKanaliAutostart(on);
    log('KANALI autostart set to', on, 'now:', r);
    return r;
  } catch (e) {
    log('KANALI autostart change failed:', e.message);
    throw e;
  }
});

ipcMain.handle('settings:get', () => settings);
ipcMain.handle('settings:set', (_e, section, patch) => changeSettings(section, patch));

// The one place settings change: from the window, the tray, hotkeys and the phone.
// notify: also tell the window (it already knows when it made the change itself).
function changeSettings(section, patch, { notify = false } = {}) {
  if (section === 'profiles' && patch.profiles) {
    // The window may rename, reorder and edit program lists; each profile's saved settings stay as they are here.
    const byId = new Map(settings.profiles.map((p) => [p.id, p]));
    const merged = patch.profiles.filter((p) => byId.has(p?.id)).map((p) => ({ ...p, data: byId.get(p.id).data }));
    patch = { ...patch, profiles: Profiles.normalize(merged, settings) };
  }
  if (section === 'remote' && patch.remote) {
    const port = Number(patch.remote.port);
    patch = { ...patch, remote: { ...settings.remote, enabled: !!patch.remote.enabled, port: Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : settings.remote.port } };
  }
  settings = { ...settings, ...patch };
  settings.media = firstFileName(settings.media);
  // Profile settings are saved into the active profile as well.
  const active = settings.profiles.find((p) => p.id === settings.activeProfile);
  if (active) for (const k of Object.keys(patch)) if (Profiles.PROFILE_KEYS.includes(k)) active.data[k] = Profiles.clone(settings[k]);
  saveSettings();
  if (section === 'nowPlaying') applyNowPlayingSetting();
  else if (section === 'updates') scheduleUpdateChecks();
  else if (section === 'alerts') checkAlerts();
  else if (section === 'hotkeys' || section === 'profiles') registerHotkeys();
  else if (section === 'remote') applyRemote();
  else if (section === 'night' && bridge?.device) applyNight();
  else if (bridge?.device && appliers[section]) appliers[section]();
  if (section === 'profiles') scheduleAutoSwitch();
  buildTrayMenu();
  if (notify) win?.webContents.send('settings', settings);
  return settings;
}

// ---------- profiles ----------

// how: 'manual' (window/tray/phone), 'hotkey', 'auto' (a program started), 'auto-end' (it closed)
function activateProfile(id, how = 'manual') {
  const p = settings.profiles.find((x) => x.id === id);
  if (!p) throw new Error('That profile no longer exists.');
  if (how === 'manual' || how === 'hotkey') {
    // Picked by hand while a program's profile is on: stay on this one until that program closes.
    if (autoMatchId) autoSuppressed = autoMatchId;
    settings.autoFrom = '';
  }
  if (settings.activeProfile === id) {
    saveSettings();
    return settings;
  }
  const prevNp = settings.nowPlaying?.enabled;
  settings = { ...settings, ...Profiles.clone(p.data), activeProfile: id };
  saveSettings();
  log(`profile: ${p.name} (${how})`);
  if (bridge?.device) {
    appliers.screen();
    appliers.overlay();
    applyFan(true);
  }
  if (settings.nowPlaying?.enabled !== prevNp) applyNowPlayingSetting();
  win?.webContents.send('settings', settings);
  buildTrayMenu();
  if (settings.profileToasts && how !== 'manual') {
    const why = how === 'auto' ? 'A program on its list started.' : how === 'auto-end' ? 'The program that switched it closed.' : 'Keyboard shortcut.';
    toast(`Profile: ${p.name}`, why, { silent: true });
  }
  return settings;
}

function nextProfile() {
  const list = settings.profiles;
  const i = list.findIndex((p) => p.id === settings.activeProfile);
  return activateProfile(list[(i + 1) % list.length].id, 'hotkey');
}

// Auto-switch: every 4 seconds, look for a running program from any profile's list.
let autoTimer = null;
let autoMatchId = null; // the profile whose program is running now
let autoSuppressed = null; // ...but the user picked another profile by hand while it ran
let autoBusy = false;

function scheduleAutoSwitch() {
  const needed = settings.autoSwitch && (settings.profiles.some((p) => p.apps.length) || settings.autoFrom);
  if (needed && !autoTimer) {
    autoTimer = setInterval(checkAutoSwitch, 4000);
    checkAutoSwitch();
  } else if (!needed && autoTimer) {
    clearInterval(autoTimer);
    autoTimer = null;
  }
}

async function checkAutoSwitch() {
  if (autoBusy || !settings.autoSwitch) return;
  autoBusy = true;
  try {
    const running = await Profiles.runningPrograms();
    if (!running) return;
    const match = Profiles.autoMatch(settings.profiles, running);
    autoMatchId = match?.id || null;
    if (autoSuppressed && autoSuppressed !== autoMatchId) autoSuppressed = null;
    if (match && match.id !== autoSuppressed) {
      if (settings.activeProfile !== match.id) {
        if (!settings.autoFrom) settings.autoFrom = settings.activeProfile;
        activateProfile(match.id, 'auto');
      }
    } else if (!match && settings.autoFrom) {
      const back = settings.autoFrom;
      settings.autoFrom = '';
      if (settings.profiles.some((p) => p.id === back) && back !== settings.activeProfile) activateProfile(back, 'auto-end');
      else saveSettings();
    }
  } catch (e) {
    log('auto-switch failed:', e.message);
  } finally {
    autoBusy = false;
  }
}

ipcMain.handle('profile:activate', (_e, id) => activateProfile(id, 'manual'));
ipcMain.handle('profile:create', (_e, name) => {
  const p = Profiles.makeProfile(name || `Profile ${settings.profiles.length + 1}`, settings);
  settings.profiles = [...settings.profiles, p];
  saveSettings();
  activateProfile(p.id, 'manual');
  buildTrayMenu();
  return settings;
});
ipcMain.handle('profile:delete', (_e, id) => {
  if (settings.profiles.length <= 1) throw new Error("You can't delete the last profile.");
  const list = settings.profiles.filter((p) => p.id !== id);
  if (settings.activeProfile === id) activateProfile(list[0].id, 'manual');
  if (settings.autoFrom === id) settings.autoFrom = '';
  return changeSettings('profiles', { profiles: list });
});
ipcMain.handle('profile:programs', () => Profiles.windowedPrograms());
ipcMain.handle('profile:pickExe', async () => {
  const pick = await dialog.showOpenDialog(win, { title: 'Choose a game or program', properties: ['openFile'], filters: [{ name: 'Programs', extensions: ['exe'] }] });
  return pick.canceled ? null : Profiles.normApp(pick.filePaths[0]);
});

// ---------- actions (tray, hotkeys, phone) ----------

const clampPct = (v) => Math.max(0, Math.min(100, Math.round(Number(v) || 0)));

const actions = {
  toggleScreen: () => changeSettings('screen', { screenOn: !settings.screenOn }, { notify: true }),
  screen: (on) => changeSettings('screen', { screenOn: !!on }, { notify: true }),
  brightness: (v) => changeSettings('screen', { brightness: clampPct(v) }, { notify: true }),
  brightnessUp: () => actions.brightness(settings.brightness + 10),
  brightnessDown: () => actions.brightness(settings.brightness - 10),
  nextProfile: () => nextProfile(),
  profile: (id) => activateProfile(String(id), 'manual'),
  toggleNight: () => {
    nightOverride = nightState().active ? 'off' : 'on';
    log('night mode toggled:', nightOverride);
    if (bridge?.device) applyNight();
    buildTrayMenu();
  },
  fanBoost: (on) => {
    fanBoost = typeof on === 'boolean' ? on : !fanBoost;
    log('fan boost:', fanBoost);
    applyFan(true);
    buildTrayMenu();
  },
  playPause: () => mediaCommand('play-pause'),
  media: (cmd) => mediaCommand(cmd),
  show: (fileName) => {
    const m = deviceMedia.find((x) => x.fileName === fileName && !x.half);
    if (!m) throw new Error('That video is no longer on the cooler.');
    return changeSettings('screen', { media: m.fileName, layout: 'single' }, { notify: true });
  }
};

// ---------- global hotkeys ----------

const HOTKEY_ACTIONS = ['toggleScreen', 'nextProfile', 'toggleNight', 'fanBoost', 'brightnessUp', 'brightnessDown', 'playPause'];
let hotkeyFailed = []; // keys of shortcuts Windows wouldn't give us (in use by another program, or a duplicate)
let hotkeysPaused = false;

function registerHotkeys() {
  globalShortcut.unregisterAll();
  hotkeyFailed = [];
  if (hotkeysPaused) return;
  const used = new Set();
  const add = (key, accel, fn) => {
    if (!accel) return;
    const norm = accel.toLowerCase();
    let ok = false;
    try {
      ok = !used.has(norm) && globalShortcut.register(accel, () => {
        try {
          fn();
        } catch (e) {
          log('hotkey action failed:', key, e.message);
        }
      });
    } catch {
      ok = false;
    }
    used.add(norm);
    if (!ok) hotkeyFailed.push(key);
  };
  for (const a of HOTKEY_ACTIONS) add(a, settings.hotkeys[a], () => actions[a]());
  for (const p of settings.profiles) add(`profile:${p.id}`, p.hotkey, () => activateProfile(p.id, 'hotkey'));
  if (hotkeyFailed.length) log('hotkeys not available:', hotkeyFailed);
  win?.webContents.send('hotkeys', hotkeyFailed);
}

ipcMain.handle('hotkeys:status', () => hotkeyFailed);
// While the window records a new shortcut, our own shortcuts are switched off so the keys reach it.
ipcMain.handle('hotkeys:pause', (_e, paused) => {
  hotkeysPaused = !!paused;
  registerHotkeys();
  return hotkeyFailed;
});

// ---------- phone remote ----------

const remote = new RemoteServer({
  log,
  host: uiTest ? '127.0.0.1' : '0.0.0.0', // UI tests stay on this PC (no firewall prompt)
  getState: () => remoteState(),
  thumbFile: (fileName) => (deviceMedia.some((m) => m.fileName === fileName) ? thumbFor(fileName) : null),
  act: (action, value) => {
    const ok = ['screen', 'brightness', 'profile', 'toggleNight', 'night', 'fanBoost', 'media', 'show'];
    if (!ok.includes(action)) throw new Error('Unknown action.');
    log('remote action:', action, value ?? '');
    if (action === 'night') return actions.toggleNight();
    if (action === 'media' && !['play-pause', 'next', 'previous'].includes(value)) throw new Error('Unknown media command.');
    return actions[action](value);
  }
});
let remoteError = null;

function remoteState() {
  const t = (c) => (settings.unit === 'Fahrenheit' ? Math.round(c * 1.8 + 32) : Math.round(c));
  return {
    connected: status.status === 'connected',
    device: status.device ? `Panorama ${status.device.productName === 'PASE' ? 'SE' : status.device.productName}` : '',
    stats: {
      cpuTemp: t(stats.cpu.temperature), cpuTempC: stats.cpu.temperature, cpuLoad: stats.cpu.load,
      gpuTemp: t(stats.gpu.temperature), gpuTempC: stats.gpu.temperature, gpuLoad: stats.gpu.load,
      fanPower: lastFanPower, pump: stats.cooler.pumpSpeed, unit: settings.unit === 'Fahrenheit' ? '°F' : '°C'
    },
    screenOn: settings.screenOn,
    brightness: settings.brightness,
    night: { active: nightState().active },
    fanBoost,
    alerts: alertActive(),
    profiles: settings.profiles.map((p) => ({ id: p.id, name: p.name })),
    activeProfile: settings.activeProfile,
    layout: settings.layout,
    current: settings.media,
    media: deviceMedia.filter((m) => !m.half).map((m) => ({ fileName: m.fileName, name: m.fileName.replace(/\.h264_\d+x\d+$/, '').replace(/\.(mp4|mov|gif|png|jpg|mkv|webm)$/i, ''), thumb: !!m.thumb })),
    nowPlaying: nowPlaying.title ? { title: nowPlaying.title, artist: nowPlaying.artist || '', playing: !!nowPlaying.playing } : {}
  };
}

async function applyRemote() {
  const r = settings.remote;
  remoteError = r.enabled ? await remote.start(r.port, r.pin) : (await remote.stop(), null);
  win?.webContents.send('remote', remoteInfo());
}

function remoteInfo() {
  const r = settings.remote;
  const urls = lanAddresses().map((ip) => `http://${ip}:${r.port}`);
  let qr = '';
  if (r.enabled && urls.length) {
    try {
      const qrcode = require('qrcode-generator');
      const q = qrcode(0, 'M');
      q.addData(`${urls[0]}/#pin=${r.pin}`);
      q.make();
      qr = q.createDataURL(5, 2);
    } catch (e) {
      log('QR code failed:', e.message);
    }
  }
  return { enabled: r.enabled, running: remote.running, port: r.port, pin: r.pin, urls, qr, error: remoteError };
}

ipcMain.handle('remote:info', () => remoteInfo());
ipcMain.handle('remote:newPin', async () => {
  settings.remote = { ...settings.remote, pin: newPin() };
  saveSettings();
  await applyRemote(); // signs out every phone
  return remoteInfo();
});
ipcMain.handle('device:retry', () => connect());
ipcMain.handle('media:control', (_e, cmd) => mediaCommand(cmd));
ipcMain.handle('device:status', () => status);
ipcMain.handle('hw:names', () => hwNames);

// ---------- updates (GitHub Releases) ----------

let updateState = { phase: 'idle', current: app.getVersion() };
let updateTimer = null;

function setUpdate(next) {
  updateState = { current: app.getVersion(), ...next };
  win?.webContents.send('update', updateState);
  buildTrayMenu();
}

async function checkUpdates() {
  if (['checking', 'downloading'].includes(updateState.phase)) return updateState;
  setUpdate({ phase: 'checking' });
  try {
    const info = await updater.checkForUpdate(app.getVersion());
    if (info.available) log('update available:', info.version);
    setUpdate({ phase: info.available ? 'available' : 'none', version: info.version, page: info.page, notes: info.notes, note: info.note, info });
  } catch (e) {
    log('update check failed:', e.message);
    setUpdate({ phase: 'error', message: "Couldn't reach GitHub to check for updates." });
  }
  return updateState;
}

function scheduleUpdateChecks() {
  clearInterval(updateTimer);
  updateTimer = null;
  if (uiTest || !app.isPackaged || !settings.updates.auto) return;
  setTimeout(checkUpdates, 30 * 1000);
  updateTimer = setInterval(checkUpdates, 12 * 3600 * 1000);
}

ipcMain.handle('update:get', () => updateState);
ipcMain.handle('update:check', () => checkUpdates());
ipcMain.handle('update:page', () => {
  const page = updateState.page || `https://github.com/${updater.REPO}/releases`;
  if (page.startsWith(`https://github.com/${updater.REPO}/`)) shell.openExternal(page);
});
ipcMain.handle('update:install', async () => {
  if (updateState.phase !== 'available' || !updateState.info) throw new Error('No update to install.');
  const info = updateState.info;
  try {
    setUpdate({ ...updateState, phase: 'downloading', pct: 0 });
    const file = await updater.downloadUpdate(info, path.join(app.getPath('temp'), 'frosted-aio-update'), (pct) =>
      win?.webContents.send('update', { ...updateState, phase: 'downloading', pct })
    );
    log('update downloaded:', file, '- starting the installer');
    updater.runInstaller(file);
    setTimeout(quitApp, 1500); // the installer replaces the app and starts the new version
  } catch (e) {
    log('update install failed:', e.message);
    setUpdate({ ...updateState, phase: 'available', message: e.message });
    throw e;
  }
});
ipcMain.handle('history:days', () => {
  history ||= new StatsHistory(historyDir());
  return { dir: historyDir(), days: history.days() };
});
ipcMain.handle('history:read', (_e, day) => {
  history ||= new StatsHistory(historyDir());
  return history.read(day);
});
ipcMain.handle('history:open', () => {
  fs.mkdirSync(historyDir(), { recursive: true });
  return shell.openPath(historyDir());
});
ipcMain.handle('media:list', () => {
  bridge?.requestFileList();
  return deviceMedia;
});

app.on('second-instance', showWindow);

app.whenReady().then(() => {
  if (registering) return; // installer mode: no window, exits when the tasks are written
  app.setAppUserModelId('io.github.frosty9999.frosted-aio'); // Windows notifications show as Frosted-AIO
  loadSettings();
  log('started', app.isPackaged ? 'installed' : 'development', 'copy:', process.execPath, 'version', app.getVersion());
  migrateHistoryFolder();
  // Keep the no-prompt admin tasks pointing at this copy, and tidy up after installing.
  if (!uiTest) system
    .syncTasks(autostartOpts())
    .then((changed) => changed.length && log('updated tasks for this copy:', changed))
    .catch((e) => log('task sync failed:', e.message));
  if (app.isPackaged) {
    system
      .removeDevShortcut(app.getPath('desktop'))
      .then((removed) => removed && log('removed the development copy desktop icon'))
      .catch(() => {});
  }
  createWindow();
  detectHardwareNames().then((names) => {
    hwNames = names;
    log('hardware names:', names);
    win?.webContents.send('hw', names);
    if (bridge?.device) appliers.overlay(); // add the badges if the cooler connected first
  });
  createTray();
  startNowPlaying();
  scheduleUpdateChecks();
  registerHotkeys();
  scheduleAutoSwitch();
  if (settings.remote.enabled) applyRemote();
  if (uiTest) {
    // Feed the page sample stats every second, like a connected cooler would.
    setInterval(() => {
      Object.assign(stats, {
        cpu: { load: 25, temperature: 50 + Math.round(Math.random() * 10), frequency: 4800, power: 70 },
        gpu: { load: 30, temperature: 60, frequency: 1800, power: 140 },
        memory: { load: 40, frequency: 6000 },
        network: { down: 1.5e6, up: 2e5 }
      });
      if (process.env.FROSTED_HOT) stats.cpu.temperature = Number(process.env.FROSTED_HOT); // try the alerts
      haveTemp = true;
      checkAlerts();
      win?.webContents.send('stats', { ...liveStats(), fanPower: 40 });
    }, 1000);
    return log('UI test mode: not connecting to the cooler');
  }
  win.webContents.once('did-finish-load', () => connect());
  powerMonitor.on('resume', () => setTimeout(() => connect(), 3000));
});

app.on('will-quit', () => globalShortcut.unregisterAll());

app.on('before-quit', () => {
  quitting = true;
  remote.stop();
  stopNowPlaying();
  try {
    disconnect();
  } catch {
    /* quitting anyway */
  }
});

app.on('window-all-closed', () => {
  if (quitting || !settings.closeToTray) app.quit();
});
