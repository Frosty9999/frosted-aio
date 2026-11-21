// In-app updates from GitHub Releases (public repo, no sign-in).
// Asks GitHub for the latest release, compares its version with ours, and can download the
// Frosted-AIO-Setup-<version>.exe asset (checked against GitHub's SHA-256 digest when present) and run it.
// Nothing about the user or this PC is sent; the request carries only a generic app User-Agent.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const REPO = 'Frosty9999/frosted-aio';
const API = `https://api.github.com/repos/${REPO}/releases/latest`;
const ASSET = /^Frosted-AIO-Setup-(\d+\.\d+\.\d+)\.exe$/i;
const HEADERS = { 'User-Agent': 'Frosted-AIO-updater', Accept: 'application/vnd.github+json' };

// "2.0.10" > "2.0.9"; ignores a leading "v" and anything after a "-".
function newer(a, b) {
  const p = (v) => String(v).replace(/^v/i, '').split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);
  const [x, y] = [p(a), p(b)];
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
}

async function checkForUpdate(currentVersion) {
  const res = await fetch(API, { headers: HEADERS });
  if (res.status === 404) return { available: false, current: currentVersion, note: 'No releases published yet.' };
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
  const rel = await res.json();
  const version = String(rel.tag_name || '').replace(/^v/i, '');
  const asset = (rel.assets || []).find((a) => ASSET.test(a.name));
  return {
    available: !!asset && newer(version, currentVersion),
    current: currentVersion,
    version,
    notes: rel.body || '',
    page: rel.html_url,
    asset: asset ? { name: asset.name, url: asset.browser_download_url, size: asset.size, sha256: (asset.digest || '').replace(/^sha256:/i, '') } : null
  };
}

async function downloadUpdate(info, destDir, onProgress = () => {}) {
  if (!info?.asset) throw new Error('No installer in that release.');
  fs.mkdirSync(destDir, { recursive: true });
  const file = path.join(destDir, info.asset.name);
  const res = await fetch(info.asset.url, { headers: { 'User-Agent': HEADERS['User-Agent'] } });
  if (!res.ok || !res.body) throw new Error(`Download failed (${res.status})`);
  const total = Number(res.headers.get('content-length')) || info.asset.size || 0;
  const hash = crypto.createHash('sha256');
  const out = fs.createWriteStream(file);
  let got = 0;
  let lastPct = -1;
  try {
    for await (const chunk of res.body) {
      hash.update(chunk);
      got += chunk.length;
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
      const pct = total ? Math.floor((got / total) * 100) : 0;
      if (pct !== lastPct) onProgress((lastPct = pct));
    }
  } finally {
    await new Promise((r) => out.end(r));
  }
  if (info.asset.size && got !== info.asset.size) throw new Error('The download was incomplete.');
  const digest = hash.digest('hex');
  if (info.asset.sha256 && digest.toLowerCase() !== info.asset.sha256.toLowerCase()) {
    fs.rmSync(file, { force: true });
    throw new Error("The download didn't match GitHub's fingerprint, so it wasn't installed.");
  }
  return file;
}

// Start the installer on its own (it closes this app, installs, then starts the new version).
function runInstaller(file) {
  spawn(file, [], { detached: true, stdio: 'ignore' }).unref();
}

module.exports = { checkForUpdate, downloadUpdate, runInstaller, newer, REPO };
