// Backup & restore. A backup is a .zip:
//   manifest.json   what's inside (format, app version, date, file lists)
//   settings.json   every setting, including profiles, shortcuts and alerts
//   thumbs/*.jpg    preview images (small)
//   media/*         your original images, GIFs and videos (optional; these can be large)
// Zipping uses .NET's System.IO.Compression through PowerShell, so nothing extra is bundled.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const FORMAT = 1;
const SAFE_NAME = /^[\w][\w .()\-]*\.[\w]+$/; // plain file names only: no folders, no "..": e.g. 2026-11-12_13-45-25-295.mp4

function runPs(script, env, onLine) {
  return new Promise((resolve, reject) => {
    const p = spawn('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      windowsHide: true,
      env: { ...process.env, ...env }
    });
    let err = '';
    let buf = '';
    p.stdout.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) onLine?.(line);
      }
    });
    p.stderr.on('data', (d) => (err += d.toString()));
    p.on('error', reject);
    // PowerShell's first error line says what went wrong ("...: Access to the path ... is denied.").
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error((err.trim().split('\n')[0] || `PowerShell exited with ${code}`).replace(/^.*?: "?|"?\s*$/g, '')))));
  });
}

const ZIP_TYPES = 'Add-Type -AssemblyName System.IO.Compression; Add-Type -AssemblyName System.IO.Compression.FileSystem;';

const listFiles = (dir) => {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isFile() && SAFE_NAME.test(d.name)).map((d) => d.name);
  } catch {
    return [];
  }
};

const dirBytes = (dir) => listFiles(dir).reduce((n, f) => n + fs.statSync(path.join(dir, f)).size, 0);

/**
 * Writes a backup zip.
 * @param {object} o
 * @param {string} o.outFile
 * @param {object} o.settings
 * @param {string} o.mediaDir
 * @param {string} o.thumbDir
 * @param {boolean} o.includeMedia
 * @param {string} o.appVersion
 * @param {(pct:number)=>void} [o.onProgress]
 */
async function createBackup({ outFile, settings, mediaDir, thumbDir, includeMedia, appVersion, onProgress }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'frosted-backup-'));
  try {
    const thumbs = listFiles(thumbDir);
    const media = includeMedia ? listFiles(mediaDir).filter((f) => !/\.h264_\d+x\d+$/.test(f)) : [];
    const manifest = {
      app: 'Frosted-AIO',
      format: FORMAT,
      appVersion,
      created: new Date().toISOString(),
      profiles: (settings.profiles || []).map((p) => p.name),
      includesMedia: !!includeMedia,
      media,
      thumbs
    };
    const { autoFrom, ...saved } = settings; // which profile a game switched from only makes sense on this PC right now
    fs.writeFileSync(path.join(tmp, 'manifest.json'), JSON.stringify(manifest, null, 2));
    fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify({ ...saved, autoFrom: '' }, null, 2));
    const entries = [
      { path: path.join(tmp, 'manifest.json'), name: 'manifest.json', level: 'Optimal' },
      { path: path.join(tmp, 'settings.json'), name: 'settings.json', level: 'Optimal' },
      ...thumbs.map((f) => ({ path: path.join(thumbDir, f), name: `thumbs/${f}`, level: 'NoCompression' })),
      ...media.map((f) => ({ path: path.join(mediaDir, f), name: `media/${f}`, level: 'NoCompression' })) // already compressed
    ];
    const listFile = path.join(tmp, 'list.json');
    fs.writeFileSync(listFile, JSON.stringify(entries));
    const partial = `${outFile}.partial`;
    fs.rmSync(partial, { force: true });
    const script = `${ZIP_TYPES}
      $ErrorActionPreference = 'Stop'
      $list = Get-Content -LiteralPath $env:FA_LIST -Raw -Encoding UTF8 | ConvertFrom-Json
      $z = [IO.Compression.ZipFile]::Open($env:FA_DST, 'Create')
      try {
        $n = 0
        foreach ($i in $list) {
          [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($z, $i.path, $i.name, [IO.Compression.CompressionLevel]$i.level) | Out-Null
          $n++
          [Console]::Out.WriteLine("P $n")
        }
      } finally { $z.Dispose() }`;
    await runPs(script, { FA_LIST: listFile, FA_DST: partial }, (line) => {
      const m = line.match(/^P (\d+)/);
      if (m) onProgress?.(Math.round((Number(m[1]) / entries.length) * 100));
    });
    fs.rmSync(outFile, { force: true });
    fs.renameSync(partial, outFile);
    return { file: outFile, bytes: fs.statSync(outFile).size, media: media.length, thumbs: thumbs.length };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * Unpacks a backup into a temporary folder and checks it. Only the expected files are extracted
 * (manifest.json, settings.json, thumbs/<name>, media/<name>); anything else in the zip is ignored.
 * Returns { dir, manifest, settings }. Call discard(dir) when finished.
 */
async function openBackup(file) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frosted-restore-'));
  const script = `${ZIP_TYPES}
    $ErrorActionPreference = 'Stop'
    $dest = [IO.Path]::GetFullPath($env:FA_DST).TrimEnd('\\') + '\\'
    $z = [IO.Compression.ZipFile]::OpenRead($env:FA_SRC)
    try {
      foreach ($e in $z.Entries) {
        $name = $e.FullName -replace '\\\\', '/'
        if ($name -notmatch '^(manifest\\.json|settings\\.json|(thumbs|media)/[\\w][\\w .()\\-]*\\.[\\w]+)$') { continue }
        $target = [IO.Path]::GetFullPath([IO.Path]::Combine($dest, $name))
        if (-not $target.StartsWith($dest, [StringComparison]::OrdinalIgnoreCase)) { continue }
        [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target)) | Out-Null
        [IO.Compression.ZipFileExtensions]::ExtractToFile($e, $target, $true)
      }
    } finally { $z.Dispose() }`;
  try {
    await runPs(script, { FA_SRC: file, FA_DST: dir });
  } catch (e) {
    discard(dir);
    throw new Error("That file couldn't be opened. Choose a .zip saved by Frosted-AIO's Back up button.");
  }
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    if (manifest.app !== 'Frosted-AIO') throw new Error('not a Frosted-AIO backup');
    if (manifest.format > FORMAT) throw new Error('it was made by a newer version of Frosted-AIO. Update first, then restore');
    const settings = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('its settings are damaged');
    return { dir, manifest, settings };
  } catch (e) {
    discard(dir);
    throw new Error(`That isn't a usable Frosted-AIO backup (${e.message}).`);
  }
}

/** Copies the backup's thumbs/media into the app's folders, never overwriting files already there. */
function copyLibrary(dir, { mediaDir, thumbDir, includeMedia }) {
  let copied = 0;
  const pairs = [['thumbs', thumbDir], ...(includeMedia ? [['media', mediaDir]] : [])];
  for (const [sub, to] of pairs) {
    const from = path.join(dir, sub);
    fs.mkdirSync(to, { recursive: true });
    for (const f of listFiles(from)) {
      const dst = path.join(to, f);
      if (fs.existsSync(dst)) continue;
      fs.copyFileSync(path.join(from, f), dst);
      copied++;
    }
  }
  return copied;
}

function discard(dir) {
  fs.rm(dir, { recursive: true, force: true }, () => {});
}

module.exports = { createBackup, openBackup, copyLibrary, discard, dirBytes, SAFE_NAME };
