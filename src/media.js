// Converts videos, GIFs and images into the raw H.264 stream the Panorama SE plays, using the ffmpeg
// build that ships with KANALI. KANALI names these files "<name>.h264_<W>x<H>":
//   full screen: 2240x1080, split-screen side: 1120x1080.

const path = require('path');
const fs = require('fs');
const { execFile, spawn } = require('child_process');

const SIZES = { full: [2240, 1080], half: [1120, 1080] };
const IMAGE_EXT = ['.png', '.jpg', '.jpeg', '.bmp', '.webp'];
const IMAGE_SECONDS = 2; // a still image becomes a short clip the cooler loops

function stamp() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}-${p(d.getMilliseconds(), 3)}`;
}

function probe(ffprobe, file) {
  return new Promise((resolve) => {
    execFile(
      ffprobe,
      ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=r_frame_rate:format=duration', '-of', 'json', file],
      { windowsHide: true },
      (err, out) => {
        try {
          const j = JSON.parse(out);
          const [a, b] = String(j.streams?.[0]?.r_frame_rate || '30/1').split('/').map(Number);
          resolve({ fps: b ? a / b : 30, duration: Number(j.format?.duration) || 0, ok: !err && !!j.streams?.length });
        } catch {
          resolve({ fps: 30, duration: 0, ok: false });
        }
      }
    );
  });
}

const kindOf = (file) => {
  const ext = path.extname(file).toLowerCase();
  return ext === '.gif' ? 'gif' : IMAGE_EXT.includes(ext) ? 'image' : 'video';
};

/**
 * @param {object} o
 * @param {string} o.ffmpegDir    folder holding ffmpeg.exe and ffprobe.exe
 * @param {string} o.src        source image, GIF or video
 * @param {'full'|'half'} o.size
 * @param {string} o.outDir     where to write the converted file and a preview copy
 * @param {(pct:number)=>void} o.onProgress  0-100 for the conversion step
 */
async function convertMedia({ ffmpegDir, src, size = 'full', outDir, onProgress }) {
  const bin = ffmpegDir;
  const ffmpeg = path.join(bin, 'ffmpeg.exe');
  const ffprobe = path.join(bin, 'ffprobe.exe');
  if (!fs.existsSync(ffmpeg)) throw new Error(`Couldn't find ffmpeg at ${ffmpeg}`);

  const kind = kindOf(src);
  const info = await probe(ffprobe, src);
  if (!info.ok) throw new Error("That file doesn't look like an image, GIF or video ffmpeg can read.");
  // KANALI encodes images and GIFs at 30 fps; videos keep their own rate up to 60.
  const fps = kind === 'video' ? Math.max(1, Math.min(60, Math.round(info.fps))) : 30;
  const duration = kind === 'image' ? IMAGE_SECONDS : info.duration;

  const [W, H] = SIZES[size];
  fs.mkdirSync(outDir, { recursive: true });
  const base = `${stamp()}${path.extname(src).toLowerCase() || '.mp4'}`;
  const previewPath = path.join(outDir, base);
  const deviceName = `${base}.h264_${W}x${H}`;
  const h264Path = path.join(outDir, deviceName);
  fs.copyFileSync(src, previewPath);

  const input = kind === 'image' ? ['-loop', '1', '-t', String(IMAGE_SECONDS), '-i', src] : ['-i', src];
  const args = [
    '-y', '-hide_banner', '-nostats', '-progress', 'pipe:1',
    ...input,
    '-an',
    // Fill the area: scale up to cover, then crop the overflow from the centre.
    '-vf', `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},fps=${fps},format=yuv420p`,
    '-c:v', 'libx264', '-preset', 'medium', '-crf', kind === 'video' ? '20' : '18',
    '-profile:v', 'main', '-level:v', '5.1', '-bf', '0', '-g', String(fps),
    '-f', 'h264', h264Path
  ];

  await new Promise((resolve, reject) => {
    const p = spawn(ffmpeg, args, { windowsHide: true });
    let errTail = '';
    p.stdout.on('data', (b) => {
      const m = b.toString().match(/out_time_us=(\d+)/g);
      if (m && duration) {
        const us = Number(m[m.length - 1].split('=')[1]);
        onProgress?.(Math.min(99, Math.round((us / 1e6 / duration) * 100)));
      }
    });
    p.stderr.on('data', (b) => (errTail = (errTail + b.toString()).slice(-600)));
    p.on('error', reject);
    p.on('close', (code) => {
      if (code === 0) return resolve();
      fs.rm(h264Path, { force: true }, () => {});
      fs.rm(previewPath, { force: true }, () => {});
      reject(new Error(`Conversion failed (ffmpeg exit ${code}). ${errTail.trim().split('\n').pop() || ''}`));
    });
  });
  onProgress?.(100);
  return { h264Path, deviceName, previewPath, kind };
}

module.exports = { convertMedia, kindOf };
