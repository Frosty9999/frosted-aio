// Getting admin rights without a UAC prompt every time.
//
// Windows never lets an ordinary program raise itself to administrator silently. What it does allow is a
// scheduled task the user approved once, set to "run with highest privileges". So Frosted-AIO.exe starts as
// a normal program, and if it isn't elevated it asks Task Scheduler to run that task (which starts a new,
// elevated copy), then exits. You only get a UAC prompt the first time, or after moving the app, so that the
// elevated copy can register the task for its own location.

const { execFileSync, spawnSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const OPEN_TASK = 'Frosted-AIO (open)';

// Same log as the app (%APPDATA%\frosted-aio\app.log); usable before Electron is ready.
function log(...parts) {
  try {
    const file = path.join(process.env.APPDATA || '', 'frosted-aio', 'app.log');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${new Date().toISOString()} [launch] ${parts.join(' ')}\n`);
  } catch {
    /* never block start-up on logging */
  }
}

function isElevated() {
  try {
    // "net session" only succeeds for administrators.
    execFileSync('net', ['session'], { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

// The executable the open task launches, or null if the task doesn't exist.
function openTaskCommand() {
  const r = spawnSync('schtasks', ['/Query', '/TN', OPEN_TASK, '/XML'], { windowsHide: true, encoding: 'utf8' });
  if (r.status !== 0) return null;
  const m = (r.stdout || '').match(/<Command>([^<]+)<\/Command>/i);
  return m ? m[1].replace(/&amp;/g, '&').trim() : null;
}

/**
 * Call before anything else. Returns true if this process should carry on, or false if it has handed off
 * to an elevated copy and must exit.
 * @param {{ execPath: string, args: string[] }} self how to start this same app again
 */
function ensureElevated(self) {
  if (process.platform !== 'win32' || process.argv.includes('--no-elevate') || isElevated()) return true;

  // Approved task that starts *this* exe: run it, no prompt.
  const cmd = openTaskCommand();
  if (cmd && cmd.toLowerCase() === self.execPath.toLowerCase()) {
    const r = spawnSync('schtasks', ['/Run', '/TN', OPEN_TASK], { windowsHide: true });
    log('not elevated; ran the approved task, status', r.status);
    if (r.status === 0) return false;
  } else {
    log('not elevated; approved task', cmd ? `points elsewhere (${cmd})` : 'missing', '- asking for administrator rights');
  }

  // No usable task (normally the installer registers it): one UAC prompt. The elevated copy registers the
  // task for next time. A visible (minimised) PowerShell window keeps Windows from hiding the prompt.
  const quote = (s) => `'${s.replace(/'/g, "''")}'`;
  const argList = self.args.length ? ` -ArgumentList ${self.args.map((a) => quote(`"${a}"`)).join(',')}` : '';
  const r = spawnSync(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Minimized', '-Command', `Start-Process -FilePath ${quote(self.execPath)}${argList} -Verb RunAs`],
    { stdio: 'ignore' }
  );
  log('UAC request finished with status', r.status, r.status === 0 ? '(approved)' : '(declined or failed)');
  return false;
}

module.exports = { ensureElevated, isElevated, OPEN_TASK, log };
