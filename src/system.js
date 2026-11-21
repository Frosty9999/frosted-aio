// Windows integration: tray icon image, start-with-Windows (Task Scheduler), and KANALI's own autostart.

const { nativeImage } = require('electron');
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TASK_NAME = 'Frosted-AIO';

const run = (file, args) =>
  new Promise((resolve) => {
    execFile(file, args, { windowsHide: true }, (err, stdout, stderr) => resolve({ ok: !err, stdout, stderr }));
  });

// The app icon: the frosted ring (build/icon.svg), pre-rendered by `npm run icon` into src/assets.
const ASSETS = path.join(__dirname, 'assets');

// Tray: 16 px, with tray@2x.png picked up automatically on high-DPI screens.
const trayIcon = () => nativeImage.createFromPath(path.join(ASSETS, 'tray.png'));

// Desktop-shortcut icon for the development copy (the installed app uses the exe's own icon).
function writeIco(file) {
  fs.copyFileSync(path.join(ASSETS, 'icon.ico'), file);
}

// ---------- start with Windows ----------
// A logon task with "highest privileges" so it starts elevated without a UAC prompt, which a
// Run-key entry can't do. No time limit and no battery restrictions (the defaults would kill it).

function taskXml(command, args, { logon = true, description = 'Starts Frosted-AIO in the tray at sign-in.', policy = 'IgnoreNew' } = {}) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const user = `${process.env.USERDOMAIN}\\${process.env.USERNAME}`;
  const triggers = logon
    ? `<Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${esc(user)}</UserId><Delay>PT15S</Delay></LogonTrigger></Triggers>`
    : '';
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>${esc(description)}</Description></RegistrationInfo>
  ${triggers}
  <Principals><Principal id="Author"><UserId>${esc(user)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>HighestAvailable</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>${policy}</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>false</StartWhenAvailable>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author"><Exec><Command>${esc(command)}</Command><Arguments>${esc(args)}</Arguments></Exec></Actions>
</Task>`;
}

async function isAutostartEnabled() {
  return (await run('schtasks', ['/Query', '/TN', TASK_NAME])).ok;
}

async function setAutostart(enable, { execPath, appPath, isPackaged }) {
  if (!enable) {
    const r = await run('schtasks', ['/Delete', '/TN', TASK_NAME, '/F']);
    return r.ok || !(await isAutostartEnabled());
  }
  const args = isPackaged ? '--hidden' : `"${appPath}" --hidden`;
  const file = path.join(os.tmpdir(), `frosted-aio-task-${Date.now()}.xml`);
  fs.writeFileSync(file, '﻿' + taskXml(execPath, args), 'utf16le');
  const r = await run('schtasks', ['/Create', '/TN', TASK_NAME, '/XML', file, '/F']);
  fs.rm(file, { force: true }, () => {});
  if (!r.ok) throw new Error(`Couldn't create the startup task: ${(r.stderr || r.stdout).trim()}`);
  return true;
}

// ---------- desktop shortcut ----------
// The shortcut runs an on-demand task (no trigger, elevated) so Frosted-AIO opens with no UAC prompt.
// If Frosted-AIO is already running, the new copy hands over to it and its window comes up.

const OPEN_TASK = 'Frosted-AIO (open)';
const SHORTCUT_NAME = 'Frosted-AIO.lnk';

// On-demand elevated task (no trigger), parallel so it can always reach the running copy.
async function ensureOpenTask({ execPath, appPath, isPackaged }) {
  const xmlFile = path.join(os.tmpdir(), `frosted-aio-open-${Date.now()}.xml`);
  const args = isPackaged ? '' : `"${appPath}"`;
  fs.writeFileSync(xmlFile, '﻿' + taskXml(execPath, args, { logon: false, policy: 'Parallel', description: 'Opens Frosted-AIO as administrator without a prompt.' }), 'utf16le');
  const t = await run('schtasks', ['/Create', '/TN', OPEN_TASK, '/XML', xmlFile, '/F']);
  fs.rm(xmlFile, { force: true }, () => {});
  if (!t.ok) throw new Error(`Couldn't create the launch task: ${(t.stderr || t.stdout).trim()}`);
}

const taskCommand = async (name) => {
  const q = await run('schtasks', ['/Query', '/TN', name, '/XML']);
  if (!q.ok) return null;
  const m = q.stdout.match(/<Command>([^<]+)<\/Command>/i);
  return m ? m[1].replace(/&amp;/g, '&').trim() : null;
};

// Run at every elevated start: keep both tasks pointing at the copy that's running now
// (e.g. after installing, they move from the development copy to Program Files).
// The app used to be called "My Kanali" and registered tasks under that name. Replace them once: keep
// start-at-sign-in on if it was on, then delete the old tasks (they point at the old program).
const OLD_TASK_NAMES = ['My Kanali', 'My Kanali (open)'];
async function migrateOldTasks(opts) {
  const changes = [];
  const oldLogon = await taskCommand(OLD_TASK_NAMES[0]);
  if (oldLogon && !(await taskCommand(TASK_NAME))) {
    await setAutostart(true, opts);
    changes.push('sign-in task carried over from My Kanali');
  }
  for (const name of OLD_TASK_NAMES) {
    if (await taskCommand(name)) {
      await run('schtasks', ['/Delete', '/TN', name, '/F']);
      changes.push(`removed old "${name}" task`);
    }
  }
  return changes;
}

async function syncTasks(opts, { force = false } = {}) {
  const changes = await migrateOldTasks(opts);
  const same = (cmd) => !!cmd && cmd.toLowerCase() === opts.execPath.toLowerCase();
  if (force || !same(await taskCommand(OPEN_TASK))) {
    await ensureOpenTask(opts);
    changes.push('open task');
  }
  const logonCmd = await taskCommand(TASK_NAME);
  if (logonCmd && (force || !same(logonCmd))) {
    await setAutostart(true, opts);
    changes.push('sign-in task');
  }
  return changes;
}

async function createDesktopShortcut({ execPath, appPath, isPackaged, userData, desktop }) {
  const lnk = path.join(desktop, SHORTCUT_NAME);
  if (isPackaged) {
    // The installed exe hands itself to the admin task, so the shortcut can point straight at it.
    await ensureOpenTask({ execPath, appPath, isPackaged });
    await makeShortcut({ lnk, target: execPath, args: '', icon: execPath, dir: path.dirname(execPath) });
    return lnk;
  }

  // Development copy: same idea through a hidden script.
  await ensureOpenTask({ execPath, appPath, isPackaged });

  // Icon, and a tiny script that runs the task without flashing a console window.
  fs.mkdirSync(userData, { recursive: true });
  const ico = path.join(userData, 'frosted-aio.ico');
  writeIco(ico);
  const vbs = path.join(userData, 'open-frosted-aio.vbs');
  fs.writeFileSync(vbs, `CreateObject("WScript.Shell").Run "schtasks /Run /TN ""${OPEN_TASK}""", 0, False\r\n`);

  await makeShortcut({ lnk, target: path.join(process.env.WINDIR || 'C:\\Windows', 'System32', 'wscript.exe'), args: `"${vbs}"`, icon: ico, dir: userData });
  return lnk;
}

async function makeShortcut({ lnk, target, args, icon, dir }) {
  const ps = [
    '$s = (New-Object -ComObject WScript.Shell).CreateShortcut($env:MK_LNK)',
    '$s.TargetPath = $env:MK_TARGET',
    '$s.Arguments = $env:MK_ARGS',
    '$s.IconLocation = $env:MK_ICO + ",0"',
    '$s.Description = "Open Frosted-AIO"',
    '$s.WorkingDirectory = $env:MK_DIR',
    '$s.Save()'
  ].join('; ');
  const r = await new Promise((resolve) => {
    execFile(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', ps],
      { windowsHide: true, env: { ...process.env, MK_LNK: lnk, MK_TARGET: target, MK_ARGS: args, MK_ICO: icon, MK_DIR: dir } },
      (err, _out, stderr) => resolve({ ok: !err, stderr })
    );
  });
  if (!r.ok || !fs.existsSync(lnk)) throw new Error(`Couldn't create the desktop shortcut: ${(r.stderr || '').trim()}`);
}

// After installing, remove the development copy's desktop icon (it ran a script via wscript.exe);
// the installer adds its own "Frosted-AIO" icon for the installed exe.
// Also removes the old "My Kanali" icon (from before the rename) if it points at the old program.
async function removeDevShortcut(desktop) {
  let removed = false;
  for (const name of [SHORTCUT_NAME, 'My Kanali.lnk']) {
    const lnk = path.join(desktop, name);
    if (!fs.existsSync(lnk)) continue;
    const target = await new Promise((resolve) => {
      execFile(
        'powershell',
        ['-NoProfile', '-NonInteractive', '-Command', '(New-Object -ComObject WScript.Shell).CreateShortcut($env:MK_LNK).TargetPath'],
        { windowsHide: true, env: { ...process.env, MK_LNK: lnk } },
        (err, out) => resolve(err ? '' : String(out).trim())
      );
    });
    const stale = /\\wscript\.exe$/i.test(target) || (name !== SHORTCUT_NAME && /\\My Kanali\\/i.test(target));
    if (stale) {
      fs.rmSync(lnk, { force: true });
      removed = true;
    }
  }
  return removed;
}

async function hasDesktopShortcut(desktop) {
  // The installer puts its icon on the all-users desktop.
  const publicDesktop = path.join(process.env.PUBLIC || 'C:\\Users\\Public', 'Desktop', SHORTCUT_NAME);
  const exists = fs.existsSync(path.join(desktop, SHORTCUT_NAME)) || fs.existsSync(publicDesktop);
  return exists && (await run('schtasks', ['/Query', '/TN', OPEN_TASK])).ok;
}

// ---------- service processes ----------
// Stop copies of a TRYX service that run from anywhere other than our bundled folder (for example KANALI's own,
// left over from before), so Frosted-AIO always talks to the copy it ships with.
async function stopForeignService(imageName, expectedPath) {
  const name = path.parse(imageName).name;
  // An empty expectedPath stops every copy.
  const ps = `Get-Process -Name '${name}' -ErrorAction SilentlyContinue | Where-Object { $_.Path -and (-not $env:MK_EXPECTED -or $_.Path -ne $env:MK_EXPECTED) } | ForEach-Object { $_.Path; Stop-Process -Id $_.Id -Force }`;
  return new Promise((resolve) => {
    execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, env: { ...process.env, MK_EXPECTED: expectedPath } }, (err, out) =>
      resolve(err ? [] : String(out).split(/\r?\n/).filter(Boolean))
    );
  });
}

// ---------- KANALI's own autostart ----------
// KANALI starts itself two ways, and both are switched reversibly without deleting anything:
//   1. HKCU Run entry "KANALI": toggled through StartupApproved, exactly like Task Manager's Startup tab.
//   2. Scheduled task "KANALIRunTask" (at system start-up, elevated): enabled/disabled with schtasks /Change.

const APPROVED = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run';
const RUNKEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const KANALI_TASK = 'KANALIRunTask';

async function kanaliRunEntry() {
  const hasRun = (await run('reg', ['query', RUNKEY, '/v', 'KANALI'])).ok;
  if (!hasRun) return { present: false, enabled: false };
  const q = await run('reg', ['query', APPROVED, '/v', 'KANALI']);
  const m = q.stdout?.match(/REG_BINARY\s+([0-9A-F]{2})/i);
  // No StartupApproved entry, or an even first byte, means enabled.
  return { present: true, enabled: !m || parseInt(m[1], 16) % 2 === 0 };
}

async function kanaliTask() {
  const q = await run('schtasks', ['/Query', '/TN', KANALI_TASK, '/XML']);
  if (!q.ok) return { present: false, enabled: false };
  // Look only inside <Settings>; a missing <Enabled> there means the task is enabled (the default).
  const settingsBlock = (q.stdout.match(/<Settings>([\s\S]*?)<\/Settings>/i) || [])[1] || '';
  const m = settingsBlock.match(/<Enabled>(true|false)<\/Enabled>/i);
  return { present: true, enabled: !m || m[1].toLowerCase() === 'true' };
}

async function kanaliAutostart() {
  const [runEntry, task] = await Promise.all([kanaliRunEntry(), kanaliTask()]);
  return {
    present: runEntry.present || task.present,
    enabled: (runEntry.present && runEntry.enabled) || (task.present && task.enabled),
    runEntry,
    task
  };
}

async function setKanaliAutostart(enable) {
  const { runEntry, task } = await kanaliAutostart();
  const errors = [];
  if (runEntry.present) {
    const data = enable ? '020000000000000000000000' : '030000000000000000000000';
    const r = await run('reg', ['add', APPROVED, '/v', 'KANALI', '/t', 'REG_BINARY', '/d', data, '/f']);
    if (!r.ok) errors.push(`startup entry: ${(r.stderr || '').trim()}`);
  }
  if (task.present) {
    const r = await run('schtasks', ['/Change', '/TN', KANALI_TASK, enable ? '/ENABLE' : '/DISABLE']);
    if (!r.ok) errors.push(`startup task: ${(r.stderr || r.stdout || '').trim()}`);
  }
  if (errors.length) throw new Error(`Couldn't change KANALI's startup: ${errors.join('; ')}`);
  return kanaliAutostart();
}

module.exports = {
  trayIcon,
  writeIco,
  isAutostartEnabled,
  setAutostart,
  createDesktopShortcut,
  hasDesktopShortcut,
  removeDevShortcut,
  syncTasks,
  stopForeignService,
  kanaliAutostart,
  setKanaliAutostart
};
