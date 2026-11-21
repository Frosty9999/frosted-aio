// Renderer for Frosted-AIO. Talks to the main process only through window.kanali (see preload.js).
// When opened in a plain browser (no Electron), a small mock stands in so the UI can be previewed.

const api = window.kanali || createMock();
const $ = (id) => document.getElementById(id);

// Overlay items and layout come from ../overlay.js (window.Overlay), the same code that builds the cooler's screen.
const OVERLAY_ITEMS = Overlay.ITEM_ORDER;
const SWATCHES = ['#dcdcdc', '#ffffff', '#7dd3c0', '#8ab4ff', '#f0a46b', '#ff7aa2', '#c9a7ff'];
const CURVES = {
  quiet: [[0, 10], [10, 15], [30, 20], [50, 30], [65, 45], [80, 65], [90, 100], [100, 100]],
  balanced: [[0, 10], [10, 20], [30, 30], [50, 40], [65, 55], [80, 70], [90, 100], [100, 100]],
  performance: [[0, 10], [10, 20], [30, 50], [40, 70], [55, 85], [70, 90], [90, 100], [100, 100]]
};

let s = null; // settings
let lastStats = null;
let media = [];
const history = { cpu: [], gpu: [] };

// ---------- helpers ----------

const fmtTemp = (c) => (s?.unit === 'Fahrenheit' ? Math.round(c * 1.8 + 32) : Math.round(c));
const unitSym = () => (s?.unit === 'Fahrenheit' ? '°F' : '°C');
const fileUrl = (p) => 'file:///' + encodeURI(p.replace(/\\/g, '/')).replace(/#/g, '%23');
const prettyName = (f) => f.replace(/\.h264_\d+x\d+$/, '').replace(/\.(mp4|mov|gif|png|jpg)$/i, '');

async function save(section, patch) {
  s = await api.setSettings(section, patch);
  render();
}

function seg(el, value, onPick) {
  el.querySelectorAll('button').forEach((b) => {
    b.classList.toggle('on', b.dataset.v === value);
    b.onclick = () => onPick(b.dataset.v);
  });
}

// ---------- navigation ----------

$('rail').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  document.querySelectorAll('.rail button').forEach((x) => x.classList.toggle('active', x === b));
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${b.dataset.view}`));
  if (b.dataset.view === 'cooling') drawCurve();
  if (b.dataset.view === 'screen') api.listMedia().then(setMedia);
  if (b.dataset.view === 'history') loadHistory();
});

// ---------- connection status ----------

function showStatus({ status, detail, device }) {
  $('conn').dataset.state = status;
  $('connText').textContent =
    status === 'connected' ? 'Cooler connected' :
    status === 'blocked' ? 'KANALI is running' :
    status === 'error' ? 'Not connected' : 'Connecting…';
  const problem = status === 'blocked' || status === 'error';
  $('banner').hidden = !problem;
  $('bannerText').textContent = detail || '';
  $('devName').textContent = device ? `Panorama ${device.productName === 'PASE' ? 'SE' : device.productName}` : '--';
}
$('retry').onclick = () => api.retry();
api.onStatus(showStatus);

// ---------- overview ----------

function spark(canvas, data) {
  const ctx = canvas.getContext('2d');
  const w = (canvas.width = canvas.clientWidth * devicePixelRatio);
  const h = (canvas.height = canvas.clientHeight * devicePixelRatio);
  ctx.clearRect(0, 0, w, h);
  if (data.length < 2) return;
  const lo = Math.min(...data) - 3;
  const hi = Math.max(Math.max(...data) + 3, lo + 10);
  const x = (i) => (i / 59) * w;
  const y = (v) => h - ((v - lo) / (hi - lo)) * (h - 6) - 3;
  const off = 60 - data.length;
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, 'rgba(125,211,192,0.22)');
  grad.addColorStop(1, 'rgba(125,211,192,0)');
  ctx.beginPath();
  data.forEach((v, i) => (i ? ctx.lineTo(x(i + off), y(v)) : ctx.moveTo(x(i + off), y(v))));
  ctx.lineTo(x(59), h);
  ctx.lineTo(x(off), h);
  ctx.fillStyle = grad;
  ctx.fill();
  ctx.beginPath();
  data.forEach((v, i) => (i ? ctx.lineTo(x(i + off), y(v)) : ctx.moveTo(x(i + off), y(v))));
  ctx.strokeStyle = '#7dd3c0';
  ctx.lineWidth = 1.5 * devicePixelRatio;
  ctx.stroke();
}

function heat(el, c) {
  el.classList.toggle('warm', c >= 70 && c < 85);
  el.classList.toggle('hot', c >= 85);
}

api.onStats((st) => {
  lastStats = st;
  history.cpu = [...history.cpu, st.cpu.temperature].slice(-60);
  history.gpu = [...history.gpu, st.gpu.temperature].slice(-60);

  $('cpuTemp').textContent = fmtTemp(st.cpu.temperature);
  $('gpuTemp').textContent = fmtTemp(st.gpu.temperature);
  heat($('cpuTemp').parentElement, st.cpu.temperature);
  heat($('gpuTemp').parentElement, st.gpu.temperature);
  $('cpuLoad').textContent = `${st.cpu.load}%`;
  $('cpuClock').textContent = `${(st.cpu.frequency / 1000).toFixed(2)} GHz`;
  $('cpuPower').textContent = `${st.cpu.power} W`;
  $('gpuLoad').textContent = `${st.gpu.load}%`;
  $('gpuClock').textContent = `${st.gpu.frequency} MHz`;
  $('gpuPower').textContent = `${st.gpu.power} W`;
  $('memLoad').textContent = `${st.memory.load}%`;
  $('pumpRpm').textContent = st.cooler.pumpSpeed ? `${st.cooler.pumpSpeed} rpm` : '--';
  $('fanRpm').textContent = st.cooler.fansSpeed ? `${st.cooler.fansSpeed} rpm` : '--';
  spark($('cpuSpark'), history.cpu);
  spark($('gpuSpark'), history.gpu);
  if ($('view-cooling').classList.contains('active')) drawCurve();
  if ($('view-screen').classList.contains('active')) {
    renderOverlayPreview();
    showTrack();
  }
  showNight(st.night);
  showAlerts(st);
});

// ---------- night mode ----------

function showNight(n) {
  const el = $('nightStatus');
  if (!n) return;
  el.classList.toggle('on', n.active);
  el.textContent = n.active
    ? `${n.brightness === 0 ? 'Screen off' : `Dimmed to ${n.brightness}%`} (${n.reasons.map((r) => ({ idle: 'PC idle', manual: 'turned on by you' })[r] || 'schedule').join(' + ')})`
    : n.overridden ? 'Turned off by you for now' : 'Not active';
}

function renderNight() {
  const n = s.night;
  $('nightSchedule').checked = n.schedule;
  $('nightStart').value = n.start;
  $('nightEnd').value = n.end;
  $('nightBrightness').value = n.brightness;
  $('nightBrightnessVal').textContent = n.brightness ? `${n.brightness}%` : 'Off';
  $('nightIdle').checked = n.idle;
  $('nightIdleMinutes').value = String(n.idleMinutes);
  $('nightIdleBrightness').value = n.idleBrightness;
  $('nightIdleBrightnessVal').textContent = n.idleBrightness ? `${n.idleBrightness}%` : 'Off';
  $('nightSchedule').closest('.night-rule').classList.toggle('off', !n.schedule);
  $('nightIdle').closest('.night-rule').classList.toggle('off', !n.idle);
  if (!n.schedule && !n.idle) showNight({ active: false });
}

const saveNight = (patch) => save('night', { night: { ...s.night, ...patch } });
$('nightSchedule').onchange = (e) => saveNight({ schedule: e.target.checked });
$('nightIdle').onchange = (e) => saveNight({ idle: e.target.checked });
$('nightStart').onchange = (e) => e.target.value && saveNight({ start: e.target.value });
$('nightEnd').onchange = (e) => e.target.value && saveNight({ end: e.target.value });
$('nightIdleMinutes').onchange = (e) => saveNight({ idleMinutes: Number(e.target.value) });
for (const [id, key] of [['nightBrightness', 'brightness'], ['nightIdleBrightness', 'idleBrightness']]) {
  let t;
  $(id).oninput = (e) => {
    const v = Number(e.target.value);
    $(`${id}Val`).textContent = v ? `${v}%` : 'Off';
    clearTimeout(t);
    t = setTimeout(() => saveNight({ [key]: v }), 250);
  };
}

// ---------- history ----------

const HIST_METRICS = [
  { key: 'cpu_temp_c', label: 'CPU temp', unit: '°C', color: '#7dd3c0', on: true },
  { key: 'gpu_temp_c', label: 'GPU temp', unit: '°C', color: '#8ab4ff', on: true },
  { key: 'cpu_load_pct', label: 'CPU load', unit: '%', color: '#f0a46b' },
  { key: 'gpu_load_pct', label: 'GPU load', unit: '%', color: '#ff7aa2' },
  { key: 'cpu_power_w', label: 'CPU power', unit: 'W', color: '#ffd166' },
  { key: 'gpu_power_w', label: 'GPU power', unit: 'W', color: '#c9a7ff' },
  { key: 'ram_load_pct', label: 'RAM', unit: '%', color: '#a3e635' },
  { key: 'fan_power_pct', label: 'Fan', unit: '%', color: '#94a3b8' },
  { key: 'net_down_kbps', label: 'Download', unit: 'KB/s', color: '#38bdf8' }
];
let histData = null;
let histOn = new Set(HIST_METRICS.filter((m) => m.on).map((m) => m.key));

async function loadHistory(day) {
  const { dir, days } = await api.historyDays();
  $('histPath').textContent = `Saved as one CSV file per day in ${dir}.`;
  const sel = $('histDay');
  const today = new Date().toISOString().slice(0, 10);
  const list = days.length ? days : [today];
  const pick = day || sel.value || list[0];
  sel.replaceChildren(
    ...list.map((d) => {
      const o = document.createElement('option');
      o.value = d;
      o.textContent = d === list[0] && days.length ? `${d} (latest)` : d;
      return o;
    })
  );
  sel.value = list.includes(pick) ? pick : list[0];
  histData = await api.historyRead(sel.value);
  drawHistory();
}
$('histDay').onchange = (e) => loadHistory(e.target.value);
$('histOpen').onclick = () => api.historyOpen();

function renderHistoryControls() {
  $('histMetrics').replaceChildren(
    ...HIST_METRICS.map((m) => {
      const b = document.createElement('button');
      const i = document.createElement('i');
      i.style.background = m.color;
      b.append(i, m.label);
      b.className = histOn.has(m.key) ? 'on' : '';
      b.onclick = () => {
        histOn.has(m.key) ? histOn.delete(m.key) : histOn.add(m.key);
        renderHistoryControls();
        drawHistory();
      };
      return b;
    })
  );
  $('histEnabled').checked = s.history.enabled;
  $('histInterval').value = String(s.history.interval);
  $('histKeep').value = String(s.history.keepDays);
}
$('histEnabled').onchange = (e) => save('history', { history: { ...s.history, enabled: e.target.checked } });
$('histInterval').onchange = (e) => save('history', { history: { ...s.history, interval: Number(e.target.value) } });
$('histKeep').onchange = (e) => {
  const keepDays = Number(e.target.value);
  if (keepDays && !confirm(`Delete history files older than ${keepDays} days from your Documents folder, now and from now on?`)) {
    e.target.value = String(s.history.keepDays);
    return;
  }
  save('history', { history: { ...s.history, keepDays } });
};

let histGeom = null;
function drawHistory() {
  const canvas = $('histCanvas');
  const ctx = canvas.getContext('2d');
  const dpr = devicePixelRatio;
  const w = (canvas.width = canvas.clientWidth * dpr);
  const h = (canvas.height = canvas.clientHeight * dpr);
  ctx.clearRect(0, 0, w, h);
  const pts = histData?.points || [];
  $('histEmpty').hidden = pts.length > 1;
  renderHistorySummary();
  if (pts.length < 2) return (histGeom = null);
  const cols = histData.columns.map((c) => c[0]);
  const metrics = HIST_METRICS.filter((m) => histOn.has(m.key));
  // Temperatures, %, W and KB/s share one axis, scaled to the largest visible value.
  let hi = 0;
  for (const m of metrics) {
    const c = cols.indexOf(m.key);
    for (const p of pts) if (p[c] != null) hi = Math.max(hi, p[c]);
  }
  hi = Math.max(10, Math.ceil((hi * 1.08) / 10) * 10);
  const pad = { l: 44 * dpr, r: 10 * dpr, t: 10 * dpr, b: 24 * dpr };
  const t0 = pts[0][0];
  const t1 = pts[pts.length - 1][0];
  const X = (t) => pad.l + ((t - t0) / Math.max(1, t1 - t0)) * (w - pad.l - pad.r);
  const Y = (v) => h - pad.b - (v / hi) * (h - pad.t - pad.b);
  ctx.font = `${11 * dpr}px Segoe UI, sans-serif`;
  ctx.fillStyle = '#5b606a';
  ctx.strokeStyle = '#23262e';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const v = (hi / 4) * i;
    ctx.beginPath();
    ctx.moveTo(pad.l, Y(v));
    ctx.lineTo(w - pad.r, Y(v));
    ctx.stroke();
    ctx.fillText(String(Math.round(v)), 6 * dpr, Y(v) + 4 * dpr);
  }
  const hours = Math.max(1, Math.round((t1 - t0) / 36e5 / 6));
  for (let t = Math.ceil(t0 / (hours * 36e5)) * hours * 36e5; t <= t1; t += hours * 36e5) {
    const d = new Date(t);
    ctx.fillText(d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), X(t) - 16 * dpr, h - 6 * dpr);
  }
  for (const m of metrics) {
    const c = cols.indexOf(m.key);
    ctx.beginPath();
    let started = false;
    for (const p of pts) {
      if (p[c] == null) {
        started = false;
        continue;
      }
      started ? ctx.lineTo(X(p[0]), Y(p[c])) : ctx.moveTo(X(p[0]), Y(p[c]));
      started = true;
    }
    ctx.strokeStyle = m.color;
    ctx.lineWidth = 1.5 * dpr;
    ctx.stroke();
  }
  histGeom = { X, t0, t1, pad, w, dpr, cols, metrics, pts };
}

function renderHistorySummary() {
  const sum = histData?.summary || {};
  $('histSummary').replaceChildren(
    ...HIST_METRICS.filter((m) => histOn.has(m.key) && sum[m.key]).map((m) => {
      const v = sum[m.key];
      const d = document.createElement('div');
      d.innerHTML = '<span><i></i></span><b></b><small></small>';
      d.querySelector('i').style.background = m.color;
      d.querySelector('span').append(m.label);
      d.querySelector('b').textContent = `${Math.round(v.avg)} ${m.unit} avg`;
      d.querySelector('small').textContent = `min ${Math.round(v.min)} · max ${Math.round(v.max)}`;
      return d;
    })
  );
}

$('histCanvas').onmousemove = (e) => {
  const g = histGeom;
  const tip = $('histTip');
  if (!g) return (tip.hidden = true);
  const r = e.currentTarget.getBoundingClientRect();
  const x = (e.clientX - r.left) * g.dpr;
  const t = g.t0 + ((x - g.pad.l) / (g.w - g.pad.l - g.pad.r)) * (g.t1 - g.t0);
  let best = g.pts[0];
  for (const p of g.pts) if (Math.abs(p[0] - t) < Math.abs(best[0] - t)) best = p;
  tip.replaceChildren();
  const head = document.createElement('b');
  head.textContent = new Date(best[0]).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  tip.append(head);
  for (const m of g.metrics) {
    const v = best[g.cols.indexOf(m.key)];
    if (v == null) continue;
    const row = document.createElement('div');
    const sw = document.createElement('i');
    sw.style.background = m.color;
    row.append(sw, `${m.label}: ${Math.round(v)} ${m.unit}`);
    tip.append(row);
  }
  tip.hidden = false;
  const left = Math.min(e.clientX - r.left + 14, r.width - tip.offsetWidth - 4);
  tip.style.left = `${left + 10}px`;
  tip.style.top = `${e.clientY - r.top + 10}px`;
};
$('histCanvas').onmouseleave = () => ($('histTip').hidden = true);
window.addEventListener('resize', () => $('view-history').classList.contains('active') && drawHistory());

// ---------- screen ----------

$('screenOn').onchange = (e) => save('screen', { screenOn: e.target.checked });

let brightTimer;
$('brightness').oninput = (e) => {
  $('brightnessVal').textContent = `${e.target.value}%`;
  clearTimeout(brightTimer);
  brightTimer = setTimeout(() => save('screen', { brightness: Number(e.target.value) }), 150);
};

function setMedia(list) {
  media = list || [];
  renderMedia();
}
api.onMedia(setMedia);

let activeSide = 'left';
const isStill = (p) => /\.(png|jpe?g|bmp|webp|gif)$/i.test(p);

// A still preview: the cached thumbnail, or the file itself for small images. Never a live video,
// so nothing keeps decoding in the background.
function stillEl(m) {
  const src = m.thumb || (m.preview && isStill(m.preview) && !/\.gif$/i.test(m.preview) ? m.preview : null);
  if (!src) return null;
  const img = document.createElement('img');
  img.className = 'fill';
  img.loading = 'lazy';
  img.decoding = 'async';
  img.src = fileUrl(src);
  return img;
}

// Play the real clip only while the pointer is over the tile, then throw the player away.
function hoverPlay(tile, m) {
  if (!m.preview || (isStill(m.preview) && !/\.gif$/i.test(m.preview))) return;
  let el = null;
  tile.onmouseenter = () => {
    if (el) return;
    if (/\.gif$/i.test(m.preview)) {
      el = document.createElement('img');
      el.src = fileUrl(m.preview);
    } else {
      el = document.createElement('video');
      Object.assign(el, { src: fileUrl(m.preview), muted: true, loop: true, autoplay: true, playsInline: true, preload: 'auto' });
    }
    el.className = 'fill live';
    tile.prepend(el);
  };
  tile.onmouseleave = () => {
    if (!el) return;
    if (el.tagName === 'VIDEO') {
      el.pause();
      el.removeAttribute('src');
      el.load(); // release the decoder
    }
    el.remove();
    el = null;
  };
}

async function deleteItem(m) {
  const inUse = [s.media, s.splitLeft, s.splitRight].includes(m.fileName);
  const msg =
    `Delete "${prettyName(m.fileName)}" from your cooler?\n\nThis permanently removes it from the cooler and can't be undone.` +
    (inUse ? '\nIt is on screen now, so the screen will switch to another item.' : '');
  if (!confirm(msg)) return;
  try {
    s = await api.deleteMedia(m.fileName);
    render();
  } catch (err) {
    alert(err.message || err);
  }
}

function tileFor(m, { selected, onPick, badge }) {
  const t = document.createElement('div');
  t.className = 'tile' + (selected ? ' on' : '');
  const still = stillEl(m);
  if (still) {
    t.append(still);
  } else {
    const ph = document.createElement('div');
    ph.className = 'ph';
    ph.textContent = m.readOnly ? 'Built-in' : m.preview ? 'Making preview…' : 'No preview';
    t.append(ph);
  }
  hoverPlay(t, m);
  if (badge) {
    const b = document.createElement('span');
    b.className = 'badge';
    b.textContent = badge;
    t.append(b);
  }
  const name = document.createElement('div');
  name.className = 'name';
  name.textContent = prettyName(m.fileName);
  t.append(name);
  if (!m.readOnly) {
    const x = document.createElement('button');
    x.className = 'x';
    x.textContent = '×';
    x.title = 'Delete from cooler';
    x.onclick = (e) => {
      e.stopPropagation();
      deleteItem(m);
    };
    t.append(x);
  }
  t.onclick = onPick;
  return t;
}

function emptyHint(text) {
  const p = document.createElement('p');
  p.className = 'hint';
  p.textContent = $('conn').dataset.state === 'connected' ? text : 'Waiting for the cooler…';
  return p;
}

function renderSlot(side) {
  const slot = document.querySelector(`.side[data-side="${side}"] .slot`);
  const file = side === 'left' ? s.splitLeft : s.splitRight;
  const m = media.find((x) => x.fileName === file);
  const still = m && stillEl(m);
  if (still) slot.replaceChildren(still);
  else slot.textContent = file ? prettyName(file) : 'Empty';
}

// Rebuild the grids only when something they show has changed.
let lastMediaKey = '';
function renderMedia() {
  const key = JSON.stringify([
    media.map((m) => [m.fileName, m.thumb, m.preview, m.readOnly]),
    s.layout, s.media, s.splitLeft, s.splitRight, activeSide, $('conn').dataset.state === 'connected'
  ]);
  if (key === lastMediaKey) return;
  lastMediaKey = key;
  drawMedia();
}

function drawMedia() {
  const dual = s.layout === 'dual';
  $('fullBlock').hidden = dual;
  $('splitBlock').hidden = !dual;

  const full = media.filter((m) => !m.half);
  $('media').replaceChildren(
    ...(full.length
      ? full.map((m) => tileFor(m, { selected: s.media === m.fileName, onPick: () => save('screen', { media: m.fileName }) }))
      : [emptyHint('No videos found on the cooler.')])
  );

  document.querySelectorAll('.side').forEach((el) => el.classList.toggle('active', el.dataset.side === activeSide));
  renderSlot('left');
  renderSlot('right');
  const half = media.filter((m) => m.half);
  $('halfMedia').replaceChildren(
    ...(half.length
      ? half.map((m) => {
          const where = [m.fileName === s.splitLeft && 'L', m.fileName === s.splitRight && 'R'].filter(Boolean).join(' ');
          return tileFor(m, {
            selected: !!where,
            badge: where,
            onPick: () => save('screen', activeSide === 'left' ? { splitLeft: m.fileName } : { splitRight: m.fileName })
          });
        })
      : [emptyHint('No split-screen items yet. Upload one for each side.')])
  );
}

document.querySelectorAll('.side').forEach((el) => {
  el.onclick = () => {
    activeSide = el.dataset.side;
    renderMedia();
  };
});

// Slot badge for the i-th picked item, depending on the layout preset.
function slotTag(i, preset) {
  if (preset === 'columns') return i < 4 ? `L${i + 1}` : `R${i - 3}`;
  if (preset === 'left') return `L${i + 1}`;
  if (preset === 'right') return `R${i + 1}`;
  return `${i + 1}`;
}
const PRESET_HINTS = {
  columns: 'Picked in order: L1–L4 fill the left column, R1–R4 the right.',
  left: 'Up to 4 stats, top to bottom in the left column.',
  right: 'Up to 4 stats, top to bottom in the right column.',
  row: 'Up to 4 stats across the bottom, left to right.'
};

function renderOverlay() {
  const st = Overlay.style(s.overlayStyle);
  const max = Overlay.PRESETS[st.preset].max;
  const shown = s.overlay.filter((n) => Overlay.ITEMS[n]).slice(0, max);
  $('overlay').replaceChildren(
    ...OVERLAY_ITEMS.map((name) => {
      const b = document.createElement('button');
      const idx = shown.indexOf(name);
      const on = idx >= 0;
      const n = document.createElement('span');
      n.className = 'n';
      n.textContent = on ? slotTag(idx, st.preset) : '+';
      const label = document.createElement('span');
      label.className = 'label';
      label.textContent = Overlay.ITEMS[name].short;
      b.append(n, label);
      b.title = name;
      b.className = on ? 'on' : '';
      b.disabled = !on && shown.length >= max;
      b.onclick = () => save('overlay', { overlay: on ? shown.filter((x) => x !== name) : [...shown, name] });
      return b;
    })
  );
  $('overlayCount').textContent = `${shown.length} / ${max}`;
  $('overlayHint').textContent = PRESET_HINTS[st.preset];
  $('customTextCell').hidden = !shown.includes('Custom Text');
  renderBadgeToggles();
  renderNowPlayingPanel();
  renderOverlayStyle(st);
  renderOverlayPreview();
}

function renderOverlayStyle(st) {
  seg($('ovPreset'), st.preset, (v) => {
    // Switching to a 4-item layout keeps the first 4 picks.
    const max = Overlay.PRESETS[v].max;
    save('overlay', { overlayStyle: { ...st, preset: v }, overlay: s.overlay.slice(0, max) });
  });
  seg($('ovFont'), st.font, (v) => save('overlay', { overlayStyle: { ...st, font: v } }));
  $('ovSize').value = st.size;
  $('ovSizeVal').textContent = `${st.size}%`;
  $('ovTitles').checked = st.titles;
  if (document.activeElement !== $('customText')) $('customText').value = s.customText || '';
}

let sizeTimer;
$('ovSize').oninput = (e) => {
  const size = Number(e.target.value);
  $('ovSizeVal').textContent = `${size}%`;
  s.overlayStyle = { ...Overlay.style(s.overlayStyle), size };
  renderOverlayPreview();
  clearTimeout(sizeTimer);
  sizeTimer = setTimeout(() => save('overlay', { overlayStyle: s.overlayStyle }), 250);
};
$('ovTitles').onchange = (e) => save('overlay', { overlayStyle: { ...Overlay.style(s.overlayStyle), titles: e.target.checked } });
let textTimer;
$('customText').oninput = (e) => {
  s.customText = e.target.value;
  renderOverlayPreview();
  clearTimeout(textTimer);
  textTimer = setTimeout(() => save('overlay', { customText: s.customText }), 400);
};

// Sample numbers for the preview before the first real reading arrives.
const PREVIEW_STATS = {
  cpu: { temperature: 55, load: 26, frequency: 4620, power: 64 },
  gpu: { temperature: 63, load: 35, frequency: 1850, power: 142 },
  memory: { load: 41, frequency: 6000 },
  network: { down: 3.4 * 1024 * 1024, up: 180 * 1024 },
  disk: { load: 63 },
  cooler: { fansSpeed: 0, pumpSpeed: 0 },
  fanPower: 38
};

// ---------- CPU / GPU badges ----------

let hw = { cpu: '', gpu: '' };
// Same brand colors the cooler uses (24-bit RGB values from KANALI).
const BRAND = {
  intel: [26805, 5664152],
  amd: [11087660, 13328950],
  nvidia: [6461952, 7973713]
};
const toHex = (n) => '#' + n.toString(16).padStart(6, '0');
function brandColors(name) {
  const n = name.toLowerCase();
  const key = n.includes('intel') ? 'intel' : /nvidia|geforce/.test(n) ? 'nvidia' : /amd|radeon|ryzen/.test(n) ? 'amd' : null;
  return key ? BRAND[key].map(toHex) : ['#2b2f36', '#4a505a'];
}

function badgePills() {
  const pills = [];
  const b = s.badges || {};
  for (const [kind, side] of [['cpu', 'l'], ['gpu', 'r']]) {
    if (!b[kind] || !hw[kind]) continue;
    const [from, to] = brandColors(hw[kind]);
    const p = document.createElement('div');
    p.className = `badge-pill ${side}`;
    p.textContent = `  ${hw[kind]}  `;
    p.style.background = `linear-gradient(90deg, ${from}, ${to})`;
    pills.push(p);
  }
  return pills;
}

function renderBadgeToggles() {
  const b = s.badges || {};
  for (const [kind, id] of [['cpu', 'badgeCpu'], ['gpu', 'badgeGpu']]) {
    const btn = $(id);
    btn.classList.toggle('on', !!b[kind]);
    btn.disabled = !hw[kind];
    btn.title = hw[kind] || `No ${kind.toUpperCase()} name found`;
    $(`${id}Name`).textContent = hw[kind] ? shortHw(hw[kind]) : `${kind.toUpperCase()} badge`;
    btn.onclick = () => save('overlay', { badges: { ...b, [kind]: !b[kind] } });
  }
}
// "Intel(R) Core(TM) Ultra 7 270K Plus" -> "Core Ultra 7 270K Plus" for the button label only.
const shortHw = (n) => n.replace(/\((R|TM)\)/gi, '').replace(/^(Intel|AMD|NVIDIA)\s+/i, '').replace(/\s+/g, ' ').trim();

api.getHardwareNames?.().then((n) => {
  hw = n || hw;
  if (s) render();
});
api.onHardwareNames?.((n) => {
  hw = n;
  if (s) render();
});

// ---------- Now Playing ----------

// Shown in the preview when nothing is playing, so the placement can still be set up.
const SAMPLE_TRACK = { playing: true, status: 'Playing', app: 'Spotify.exe', title: 'Midnight City', artist: 'M83', position: 102, duration: 243, sample: true };
const currentTrack = () => lastStats?.nowPlaying || { playing: false, status: 'None' };

function previewTrack() {
  const t = currentTrack();
  return Overlay.npVisible(s, t) ? t : SAMPLE_TRACK;
}

function renderNowPlayingPanel() {
  const o = Overlay.npOptions(s.nowPlaying);
  $('npEnabled').checked = o.enabled;
  document.querySelector('.np-card').classList.toggle('off', !o.enabled);
  seg($('npPlacement'), o.placement, (v) => saveNp({ placement: v }));
  $('npArtist').checked = o.artist;
  $('npTime').checked = o.time;
  $('npHide').checked = o.hideWhenPaused;
  $('npScroll').checked = o.scroll;
  showTrack();
}

function showTrack() {
  const t = currentTrack();
  if (t.title) {
    const app = Overlay.appName(t.app);
    $('npTitle').textContent = t.title;
    $('npSub').textContent = [t.artist, app, t.status === 'Paused' ? 'paused' : ''].filter(Boolean).join(' · ');
  } else {
    $('npTitle').textContent = 'Nothing playing';
    $('npSub').textContent = t.status === 'Error' ? "Couldn't read Windows media controls." : 'The preview shows a sample.';
  }
}

const saveNp = (patch) => save('nowPlaying', { nowPlaying: { ...Overlay.npOptions(s.nowPlaying), ...patch } });
$('npEnabled').onchange = (e) => saveNp({ enabled: e.target.checked });
$('npArtist').onchange = (e) => saveNp({ artist: e.target.checked });
$('npTime').onchange = (e) => saveNp({ time: e.target.checked });
$('npHide').onchange = (e) => saveNp({ hideWhenPaused: e.target.checked });
$('npScroll').onchange = (e) => saveNp({ scroll: e.target.checked });
document.querySelectorAll('[data-media]').forEach((b) => (b.onclick = () => api.mediaControl?.(b.dataset.media)));

// Draws exactly the label groups the cooler gets (Overlay.groups), scaled from 2240x1080 to the preview.
function renderOverlayPreview(color = s.textColor) {
  const box = $('overlayPreview');
  const st = Overlay.style(s.overlayStyle);
  box.className = `overlay-preview ${st.font === 'orbitron-regular' ? 'f-orbitron' : 'f-roboto'}`;
  box.style.color = color;
  const stats = lastStats ? { ...PREVIEW_STATS, ...lastStats } : PREVIEW_STATS;
  const groups = Overlay.groups({ ...s, textColor: color }, stats, { unit: s.unit, customText: s.customText, now: new Date(), nowPlaying: previewTrack() });
  const pct = (px, total) => `${(px / total) * 100}%`;
  const cq = (px) => `${(px / Overlay.W) * 100}cqw`;
  box.replaceChildren(
    ...badgePills(),
    ...groups.map((g) => {
      const d = document.createElement('div');
      d.className = 'ov-group';
      d.style.left = pct(g.groupX, Overlay.W);
      d.style.top = pct(g.groupY, Overlay.H);
      d.style.width = pct(g.groupWidth, Overlay.W);
      d.style.textAlign = g.textAlign.toLowerCase();
      const byLine = (line) => g.labels.filter((l) => (l.line ?? 0) === line);
      for (const l of byLine(1)) {
        const t = document.createElement('span');
        t.className = 'ov-title';
        t.style.fontSize = cq(l.textSize);
        t.textContent = l.text;
        d.append(t);
      }
      byLine(0).forEach((l, k) => {
        const span = document.createElement('span');
        span.className = k ? 'ov-unit' : 'ov-value';
        span.style.fontSize = cq(l.textSize);
        span.textContent = l.text;
        d.append(span);
      });
      return d;
    })
  );
}

// '#abc' or 'abc' or '#aabbcc' -> '#aabbcc'; anything else -> null
function normalizeHex(v) {
  let h = String(v || '').trim().toLowerCase().replace(/^#/, '');
  if (/^[0-9a-f]{3}$/.test(h)) h = h.split('').map((c) => c + c).join('');
  return /^[0-9a-f]{6}$/.test(h) ? `#${h}` : null;
}

function renderSwatches() {
  const current = (normalizeHex(s.textColor) || '#dcdcdc').toLowerCase();
  const isPreset = SWATCHES.includes(current);
  $('swatches').replaceChildren(
    ...SWATCHES.map((c) => {
      const b = document.createElement('button');
      b.style.background = c;
      b.title = c;
      b.className = current === c ? 'on' : '';
      b.onclick = () => save('overlay', { textColor: c });
      return b;
    })
  );
  // The custom swatch shows the rainbow until a custom color is chosen, then that color.
  const custom = $('customSwatch');
  custom.classList.toggle('on', !isPreset);
  custom.style.setProperty('--custom', current);
  $('customColor').value = current;
  if (document.activeElement !== $('hexColor')) $('hexColor').value = current;
  $('hexColor').classList.remove('bad');
}

// Custom color: preview live while dragging, save when the picker closes (or a valid hex is entered).
$('customColor').oninput = (e) => {
  const c = e.target.value.toLowerCase();
  $('customSwatch').classList.add('on');
  $('customSwatch').style.setProperty('--custom', c);
  $('hexColor').value = c;
  renderOverlayPreview(c);
};
$('customColor').onchange = (e) => save('overlay', { textColor: e.target.value.toLowerCase() });

$('hexColor').oninput = (e) => {
  const c = normalizeHex(e.target.value);
  e.target.classList.toggle('bad', !c && e.target.value.trim() !== '');
  if (c) renderOverlayPreview(c);
};
const commitHex = (e) => {
  const c = normalizeHex(e.target.value);
  if (c) {
    if (c !== s.textColor) save('overlay', { textColor: c });
  } else {
    e.target.value = s.textColor;
    e.target.classList.remove('bad');
    renderOverlayPreview();
  }
};
$('hexColor').onchange = commitHex;
$('hexColor').onkeydown = (e) => e.key === 'Enter' && e.target.blur();

// ---------- cooling ----------

const W = 640, H = 300, PAD = { l: 44, r: 16, t: 16, b: 30 };
const cx = (t) => PAD.l + (t / 100) * (W - PAD.l - PAD.r);
const cy = (v) => H - PAD.b - (v / 100) * (H - PAD.t - PAD.b);
let dragIdx = -1;

function drawCurve() {
  const svg = $('curve');
  const pts = s.fan.smartMode;
  const ns = 'http://www.w3.org/2000/svg';
  const mk = (tag, attrs) => {
    const e = document.createElementNS(ns, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  };
  const grid = mk('g', { class: 'grid' });
  for (let i = 0; i <= 100; i += 25) {
    grid.append(mk('line', { x1: cx(0), x2: cx(100), y1: cy(i), y2: cy(i) }));
    const ty = mk('text', { x: 8, y: cy(i) + 4 });
    ty.textContent = `${i}%`;
    grid.append(ty);
    const tx = mk('text', { x: cx(i) - 10, y: H - 8 });
    tx.textContent = `${fmtTemp(i)}°`;
    grid.append(tx);
  }
  const line = pts.map(([t, v], i) => `${i ? 'L' : 'M'}${cx(t)},${cy(v)}`).join(' ');
  const children = [grid, mk('path', { class: 'area', d: `${line} L${cx(100)},${cy(0)} L${cx(0)},${cy(0)} Z` }), mk('path', { class: 'path', d: line })];
  if (lastStats) {
    const t = Math.min(100, lastStats.cpu.temperature);
    children.push(mk('line', { class: 'now', x1: cx(t), x2: cx(t), y1: cy(0), y2: cy(100) }));
  }
  pts.forEach(([t, v], i) => {
    const c = mk('circle', { class: 'pt' + (i === dragIdx ? ' drag' : ''), cx: cx(t), cy: cy(v), r: 7 });
    c.onpointerdown = (e) => {
      dragIdx = i;
      svg.setPointerCapture(e.pointerId);
    };
    children.push(c);
  });
  svg.replaceChildren(...children);
}

$('curve').onpointermove = (e) => {
  if (dragIdx < 0) return;
  const r = $('curve').getBoundingClientRect();
  const px = ((e.clientX - r.left) / r.width) * W;
  const py = ((e.clientY - r.top) / r.height) * H;
  const pts = s.fan.smartMode.map((p) => [...p]);
  const lo = dragIdx === 0 ? 0 : pts[dragIdx - 1][0] + 1;
  const hi = dragIdx === pts.length - 1 ? 100 : pts[dragIdx + 1][0] - 1;
  let t = Math.round(((px - PAD.l) / (W - PAD.l - PAD.r)) * 100);
  let v = Math.round(((H - PAD.b - py) / (H - PAD.t - PAD.b)) * 100);
  t = Math.max(lo, Math.min(hi, t));
  v = Math.max(0, Math.min(100, v));
  pts[dragIdx] = [t, v];
  s.fan = { ...s.fan, smartMode: pts };
  drawCurve();
};
$('curve').onpointerup = () => {
  if (dragIdx < 0) return;
  dragIdx = -1;
  save('fan', { fan: s.fan });
};

document.querySelectorAll('[data-curve]').forEach((b) => {
  b.onclick = () => save('fan', { fan: { ...s.fan, smartMode: CURVES[b.dataset.curve].map((p) => [...p]) } });
});

let fixedTimer;
$('fixed').oninput = (e) => {
  $('fixedVal').textContent = `${e.target.value}%`;
  clearTimeout(fixedTimer);
  fixedTimer = setTimeout(() => save('fan', { fan: { ...s.fan, fixedMode: Number(e.target.value) } }), 200);
};

// ---------- adding videos ----------

let uploadHideTimer;
function showUpload({ stage, pct, message, target }) {
  const box = $('upload');
  clearTimeout(uploadHideTimer);
  box.hidden = false;
  box.classList.toggle('error', stage === 'error');
  const where = target === 'left' || target === 'right' ? `the ${target} side (1120×1080)` : 'the 2240×1080 screen';
  $('uploadLabel').textContent =
    stage === 'convert' ? `Converting for ${where}…` :
    stage === 'send' ? 'Sending to the cooler…' :
    stage === 'done' ? 'Added and now showing' : `Couldn't add it: ${message}`;
  $('uploadPct').textContent = stage === 'error' ? '' : `${pct}%`;
  $('uploadBar').style.width = `${stage === 'error' ? 0 : pct}%`;
  const busy = stage === 'convert' || stage === 'send';
  document.querySelectorAll('#addVideo, [data-upload]').forEach((b) => (b.disabled = busy));
  if (stage === 'done') uploadHideTimer = setTimeout(() => (box.hidden = true), 4000);
}
api.onUpload?.(showUpload);

async function upload(target) {
  try {
    const next = await api.addMedia(target);
    if (next) {
      s = next;
      render();
    }
  } catch {
    /* shown in the upload box */
  }
}
$('addVideo').onclick = () => upload('full');
document.querySelectorAll('[data-upload]').forEach((b) => {
  b.onclick = (e) => {
    e.stopPropagation();
    activeSide = b.dataset.upload;
    renderMedia();
    upload(b.dataset.upload);
  };
});

// ---------- settings ----------

$('autostart').onchange = async (e) => {
  try {
    e.target.checked = await api.setAutostart(e.target.checked);
  } catch (err) {
    e.target.checked = !e.target.checked;
    alert(err.message || err);
  }
};
$('quitApp').onclick = () => api.quit?.();

// ---------- updates ----------

let upd = { phase: 'idle' };
function showUpdate(u) {
  upd = u || upd;
  const t = $('updText');
  const btn = $('updBtn');
  t.classList.toggle('avail', upd.phase === 'available' || upd.phase === 'downloading');
  t.classList.toggle('err', upd.phase === 'error' || !!upd.message);
  const cur = upd.current || '';
  const text = {
    idle: `You have version ${cur}.`,
    checking: 'Checking GitHub for updates…',
    none: upd.note || `You're up to date (version ${cur}).`,
    available: `Version ${upd.version} is available (you have ${cur}).`,
    downloading: `Downloading version ${upd.version}… ${upd.pct ?? 0}%`,
    error: upd.message || "Couldn't check for updates."
  }[upd.phase] || `Version ${cur}.`;
  t.textContent = upd.message && upd.phase === 'available' ? `${text} Last try failed: ${upd.message}` : text;
  btn.textContent = upd.phase === 'available' ? 'Download and install' : upd.phase === 'downloading' ? 'Downloading…' : 'Check now';
  btn.disabled = upd.phase === 'checking' || upd.phase === 'downloading';
  $('updPage').hidden = !(upd.phase === 'available' || upd.phase === 'downloading');
}
$('updBtn').onclick = async () => {
  try {
    if (upd.phase === 'available') {
      if (!confirm(`Download and install Frosted-AIO ${upd.version}?\n\nFrosted-AIO will close while the installer runs, then start again. Your settings are kept.`)) return;
      await api.installUpdate();
    } else showUpdate(await api.checkUpdate());
  } catch (err) {
    showUpdate({ ...upd, message: err.message || String(err) });
  }
};
$('updPage').onclick = () => api.openUpdatePage?.();
$('updAuto').onchange = (e) => save('updates', { updates: { ...s.updates, auto: e.target.checked } });
api.onUpdate?.(showUpdate);
api.getUpdate?.().then(showUpdate);
api.onShowView?.((v) => document.querySelector(`.rail [data-view="${v}"]`)?.click());
$('createShortcut').onclick = async () => {
  const b = $('createShortcut');
  b.disabled = true;
  try {
    await api.createShortcut();
    b.textContent = 'Re-create';
    $('shortcutHint').textContent = 'The Frosted-AIO icon is on your desktop. Double-click it to open the app.';
  } catch (err) {
    alert(err.message || err);
  } finally {
    b.disabled = false;
  }
};
$('closeToTray').onchange = (e) => save('none', { closeToTray: e.target.checked });
$('kanaliAutostart').onchange = async (e) => {
  try {
    const k = await api.setKanaliAutostart(e.target.checked);
    e.target.checked = k.enabled;
  } catch (err) {
    e.target.checked = !e.target.checked;
    alert(err.message || err);
  }
};

async function loadSystem() {
  if (!api.getSystem) return;
  const sys = await api.getSystem();
  $('autostart').checked = sys.autostart;
  if (sys.shortcut) {
    $('createShortcut').textContent = 'Re-create';
    $('shortcutHint').textContent = 'The Frosted-AIO icon is on your desktop. Double-click it to open the app.';
  }
  $('kanaliRow').hidden = !sys.kanali.present;
  $('kanaliAutostart').checked = sys.kanali.enabled;
  if (sys.kanali.enabled) $('kanaliHint').textContent = 'KANALI is set to start at boot and will take the cooler before Frosted-AIO can. Turn this off.';
}

$('standby').onchange = (e) => save('screen', { standby: e.target.checked });

// ---------- title bar: active profile and alerts ----------

function renderTopChips() {
  const p = (s.profiles || []).find((x) => x.id === s.activeProfile);
  $('profileChip').hidden = !p || s.profiles.length < 2;
  $('profileChip').textContent = p ? `Profile: ${p.name}${s.autoFrom ? ' (auto)' : ''}` : '';
}
$('profileChip').onclick = () => document.querySelector('.rail [data-view="profiles"]').click();

function showAlerts(st) {
  const list = st.alerts || [];
  const chip = $('alertChip');
  chip.hidden = !list.length;
  if (list.length) {
    chip.textContent = list.map((k) => `${k} ${fmtTemp(st[k.toLowerCase()].temperature)}${unitSym()}`).join(' · ') + ' — too hot';
  }
  const status = $('alertStatus');
  status.classList.toggle('alert-on', !!list.length);
  status.textContent = list.length ? `Alert: ${list.join(' + ')} over the limit` : st.fanBoost ? 'Fan boost on' : 'No alert';
}

// ---------- temperature alerts ----------

// Limits are stored in °C and shown in the chosen unit.
const toShown = (c) => (s.unit === 'Fahrenheit' ? Math.round(c * 1.8 + 32) : c);
const fromShown = (v) => (s.unit === 'Fahrenheit' ? Math.round((v - 32) / 1.8) : Math.round(v));

function renderAlerts() {
  const a = s.alerts;
  $('alertsOn').checked = a.enabled;
  document.querySelector('.alerts').classList.toggle('off', !a.enabled);
  for (const [id, key] of [['alertCpu', 'cpu'], ['alertGpu', 'gpu']]) {
    if (document.activeElement !== $(id)) $(id).value = toShown(a[key]);
    $(id).min = toShown(40);
    $(id).max = toShown(120);
  }
  $('alertSeconds').value = String(a.seconds);
  $('alertNotify').checked = a.notify;
  $('alertFan').checked = a.fanBoost;
  $('alertRed').checked = a.redText;
}
const saveAlerts = (patch) => save('alerts', { alerts: { ...s.alerts, ...patch } });
$('alertsOn').onchange = (e) => saveAlerts({ enabled: e.target.checked });
$('alertNotify').onchange = (e) => saveAlerts({ notify: e.target.checked });
$('alertFan').onchange = (e) => saveAlerts({ fanBoost: e.target.checked });
$('alertRed').onchange = (e) => saveAlerts({ redText: e.target.checked });
$('alertSeconds').onchange = (e) => saveAlerts({ seconds: Number(e.target.value) });
for (const [id, key] of [['alertCpu', 'cpu'], ['alertGpu', 'gpu']]) {
  $(id).onchange = (e) => {
    const c = Math.max(40, Math.min(120, fromShown(Number(e.target.value))));
    if (!Number.isFinite(c)) return renderAlerts();
    saveAlerts({ [key]: c });
  };
}

// ---------- profiles ----------

function profileSummary(p) {
  const d = p.data || {};
  const video = d.layout === 'dual' ? 'Split screen' : d.media ? prettyName(d.media) : 'No video';
  const stats = Overlay.visibleItems(d.overlay, Overlay.style(d.overlayStyle)).length;
  const fan = d.fan?.mode === 'Fixed Mode' ? `Fan fixed at ${d.fan.fixedMode}%` : 'Fan curve';
  return [video, `${d.brightness ?? s.brightness}% brightness`, `${stats} overlay stats`, fan].join(' · ');
}

const saveProfiles = (list) => save('profiles', { profiles: list });

let lastProfKey = '';
function renderProfiles(force = false) {
  $('autoSwitch').checked = s.autoSwitch;
  $('profileToasts').checked = s.profileToasts;
  const key = JSON.stringify([s.profiles, s.activeProfile, s.autoFrom]);
  if (!force && key === lastProfKey) return;
  const typing = document.activeElement;
  if (!force && $('profList').contains(typing) && typing.tagName === 'INPUT' && typing.value !== typing.defaultValue) return; // mid-rename
  lastProfKey = key;
  $('profList').replaceChildren(...s.profiles.map(profileCard));
}

function profileCard(p) {
  const card = document.createElement('div');
  const active = p.id === s.activeProfile;
  card.className = 'prof' + (active ? ' on' : '');

  const head = document.createElement('div');
  head.className = 'prof-head';
  const name = document.createElement('input');
  name.className = 'text-in';
  name.maxLength = 32;
  name.spellcheck = false;
  name.defaultValue = p.name;
  name.onchange = () => {
    const v = name.value.trim() || p.name;
    saveProfiles(s.profiles.map((x) => (x.id === p.id ? { ...x, name: v } : x)));
  };
  name.onkeydown = (e) => e.key === 'Enter' && name.blur();
  head.append(name);
  if (active) {
    const tag = document.createElement('span');
    tag.className = 'prof-tag' + (s.autoFrom ? ' auto' : '');
    tag.textContent = s.autoFrom ? 'Active (switched automatically)' : 'Active';
    head.append(tag);
  }
  const spacer = document.createElement('span');
  spacer.className = 'spacer';
  head.append(spacer);
  if (!active) {
    const use = document.createElement('button');
    use.className = 'ghost';
    use.textContent = 'Use';
    use.onclick = async () => {
      s = await api.activateProfile(p.id);
      render();
    };
    head.append(use);
  }
  if (s.profiles.length > 1) {
    const del = document.createElement('button');
    del.className = 'ghost danger';
    del.textContent = 'Delete';
    del.onclick = async () => {
      if (!confirm(`Delete the profile "${p.name}"?\n\nIts saved settings are removed. Videos stay on the cooler.`)) return;
      try {
        s = await api.deleteProfile(p.id);
        render();
      } catch (err) {
        alert(err.message || err);
      }
    };
    head.append(del);
  }
  card.append(head);

  const sum = document.createElement('p');
  sum.className = 'prof-sum';
  sum.textContent = profileSummary(p);
  card.append(sum);

  const apps = document.createElement('div');
  apps.className = 'prof-apps';
  const lbl = document.createElement('span');
  lbl.className = 'color-label';
  lbl.textContent = 'Switch to this while running:';
  apps.append(lbl);
  for (const a of p.apps) {
    const chip = document.createElement('span');
    chip.className = 'app-chip';
    chip.append(a);
    const x = document.createElement('button');
    x.textContent = '×';
    x.title = `Remove ${a}`;
    x.onclick = () => saveProfiles(s.profiles.map((y) => (y.id === p.id ? { ...y, apps: y.apps.filter((z) => z !== a) } : y)));
    chip.append(x);
    apps.append(chip);
  }
  if (!p.apps.length) {
    const none = document.createElement('span');
    none.className = 'hint inline';
    none.textContent = 'no programs';
    apps.append(none);
  }
  const add = document.createElement('button');
  add.className = 'ghost small';
  add.textContent = '+ Add program';
  add.onclick = () => openProgramPicker(p, add);
  apps.append(add);
  card.append(apps);
  return card;
}

function addProgram(p, exe) {
  if (!exe) return;
  const others = s.profiles.find((x) => x.id !== p.id && x.apps.includes(exe));
  if (others && !confirm(`${exe} already switches to "${others.name}". Move it to "${p.name}"?`)) return renderProfiles(true);
  saveProfiles(s.profiles.map((x) => (x.id === p.id ? { ...x, apps: [...new Set([...x.apps, exe])] } : { ...x, apps: x.apps.filter((a) => a !== exe) })));
}

async function openProgramPicker(p, button) {
  button.disabled = true;
  button.textContent = 'Looking for open programs…';
  const list = await api.runningPrograms();
  const sel = document.createElement('select');
  const opt = (value, text) => Object.assign(document.createElement('option'), { value, textContent: text });
  sel.append(opt('', 'Choose an open program…'));
  for (const prog of list) sel.append(opt(prog.exe, `${prog.exe}  —  ${prog.title}`));
  sel.append(opt('__browse', 'Browse for a .exe file…'));
  sel.onchange = async () => {
    if (sel.value === '__browse') addProgram(p, await api.pickProgram());
    else addProgram(p, sel.value);
  };
  sel.onblur = () => setTimeout(() => sel.isConnected && renderProfiles(true), 200);
  button.replaceWith(sel);
  sel.focus();
}

$('profNew').onclick = async () => {
  s = await api.createProfile(`Profile ${s.profiles.length + 1}`);
  render();
  // Put the cursor in the new profile's name.
  const inputs = $('profList').querySelectorAll('.prof-head input');
  inputs[inputs.length - 1]?.select();
};
$('autoSwitch').onchange = (e) => save('profiles', { autoSwitch: e.target.checked });
$('profileToasts').onchange = (e) => save('none', { profileToasts: e.target.checked });

// ---------- keyboard shortcuts ----------

const HOTKEYS = [
  ['toggleScreen', 'Pump screen on / off'],
  ['nextProfile', 'Next profile'],
  ['toggleNight', 'Night mode on / off'],
  ['fanBoost', 'Fan boost (100%) on / off'],
  ['brightnessUp', 'Brightness up 10%'],
  ['brightnessDown', 'Brightness down 10%'],
  ['playPause', 'Play / pause music']
];
let hotkeyFailed = [];
let recording = null; // key being recorded

const KEY_NAMES = {
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Space: 'Space', Home: 'Home', End: 'End',
  PageUp: 'PageUp', PageDown: 'PageDown', Insert: 'Insert', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']',
  Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Backslash: '\\', Backquote: '`',
  NumpadAdd: 'numadd', NumpadSubtract: 'numsub', NumpadMultiply: 'nummult', NumpadDivide: 'numdiv', NumpadDecimal: 'numdec'
};

// A keydown -> Electron accelerator ("Ctrl+Alt+S"), '' for "not finished yet", null for "not allowed".
function accelFrom(e) {
  const mods = [];
  if (e.ctrlKey) mods.push('Ctrl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  if (e.metaKey) mods.push('Super');
  const c = e.code;
  let key = null;
  if (/^Key[A-Z]$/.test(c)) key = c.slice(3);
  else if (/^Digit\d$/.test(c)) key = c.slice(5);
  else if (/^F([1-9]|1\d|2[0-4])$/.test(c)) key = c;
  else if (/^Numpad\d$/.test(c)) key = `num${c.slice(6)}`;
  else key = KEY_NAMES[c] || null;
  if (!key) return /Control|Alt|Shift|Meta/.test(c) ? '' : null;
  const fKey = /^F\d+$/.test(key);
  if (!fKey && !mods.some((m) => m !== 'Shift')) return null; // a plain letter would break typing everywhere
  return [...mods, key].join('+');
}
const showAccel = (a) => a.split('+').join(' + ');

function hotkeyRows() {
  const rows = HOTKEYS.map(([key, label]) => ({ key, label, accel: s.hotkeys[key] || '' }));
  for (const p of s.profiles) rows.push({ key: `profile:${p.id}`, label: `Switch to "${p.name}"`, accel: p.hotkey || '' });
  return rows;
}

function setHotkey(key, accel) {
  // One shortcut per action: take it away from anything else using it.
  const hotkeys = { ...s.hotkeys };
  for (const k of Object.keys(hotkeys)) if (accel && hotkeys[k] === accel) hotkeys[k] = '';
  let profiles = s.profiles.map((p) => (accel && p.hotkey === accel ? { ...p, hotkey: '' } : p));
  if (key.startsWith('profile:')) {
    const id = key.slice(8);
    profiles = profiles.map((p) => (p.id === id ? { ...p, hotkey: accel } : p));
  } else hotkeys[key] = accel;
  return api.setSettings('hotkeys', { hotkeys }).then(() => api.setSettings('profiles', { profiles }));
}

let lastHotkeyKey = '';
function renderHotkeys(force = false) {
  const rows = hotkeyRows();
  const key = JSON.stringify([rows, hotkeyFailed, recording]);
  if (!force && key === lastHotkeyKey) return;
  lastHotkeyKey = key;
  $('hotkeyList').replaceChildren(
    ...rows.map((r) => {
      const item = document.createElement('div');
      item.className = 'item';
      const text = document.createElement('div');
      const b = document.createElement('b');
      b.textContent = r.label;
      text.append(b);
      const failed = hotkeyFailed.includes(r.key) && r.accel;
      if (failed) {
        const p = document.createElement('p');
        p.className = 'bad';
        p.textContent = "Windows wouldn't give Frosted-AIO this shortcut. Another program is probably using it; pick a different one.";
        text.append(p);
      }
      const keys = document.createElement('div');
      keys.className = 'key-row';
      const btn = document.createElement('button');
      const rec = recording === r.key;
      btn.className = 'keybtn' + (rec ? ' rec' : r.accel ? '' : ' empty') + (failed ? ' bad' : '');
      btn.textContent = rec ? 'Press the keys…' : r.accel ? showAccel(r.accel) : 'Not set';
      btn.onclick = () => startRecording(r.key);
      keys.append(btn);
      if (r.accel && !rec) {
        const x = document.createElement('button');
        x.className = 'x';
        x.textContent = '×';
        x.title = 'Clear';
        x.onclick = () => setHotkey(r.key, '').then(refreshSettings);
        keys.append(x);
      }
      item.append(text, keys);
      return item;
    })
  );
}

async function refreshSettings() {
  s = await api.getSettings();
  render();
}

async function startRecording(key) {
  if (recording) return;
  recording = key;
  renderHotkeys();
  await api.pauseHotkeys?.(true);
}

async function stopRecording(accel) {
  const key = recording;
  recording = null;
  if (accel !== undefined) await setHotkey(key, accel);
  hotkeyFailed = (await api.pauseHotkeys?.(false)) || [];
  await refreshSettings();
  renderHotkeys(true);
}

window.addEventListener(
  'keydown',
  (e) => {
    if (!recording) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.code === 'Escape') return stopRecording();
    if ((e.code === 'Backspace' || e.code === 'Delete') && !e.ctrlKey && !e.altKey) return stopRecording('');
    const accel = accelFrom(e);
    if (accel === '') return; // only modifiers so far
    if (accel === null) {
      const btn = $('hotkeyList').querySelector('.keybtn.rec');
      if (btn) btn.textContent = 'Add Ctrl or Alt (or use an F-key)';
      return;
    }
    stopRecording(accel);
  },
  true
);
// Clicking elsewhere cancels recording.
document.addEventListener('mousedown', (e) => recording && !e.target.closest('.keybtn') && stopRecording());
api.onHotkeys?.((failed) => {
  hotkeyFailed = failed || [];
  renderHotkeys();
});

// ---------- phone remote ----------

let remote = null;
function renderRemote(info) {
  remote = info || remote;
  if (!remote) return;
  $('remoteOn').checked = remote.enabled;
  $('remoteCard').hidden = !remote.enabled;
  if (!remote.enabled) return;
  $('remoteQr').hidden = !remote.qr;
  if (remote.qr) $('remoteQr').src = remote.qr;
  $('remoteUrl').replaceChildren(
    ...(remote.urls.length ? remote.urls : ['No network connection found']).map((u, i) => {
      const d = document.createElement('div');
      d.textContent = i ? `or ${u}` : u;
      return d;
    })
  );
  $('remotePin').textContent = remote.pin;
  if (document.activeElement !== $('remotePort')) $('remotePort').value = remote.port;
  $('remoteErr').hidden = !remote.error;
  $('remoteErr').textContent = remote.error || '';
}
$('remoteOn').onchange = (e) => save('remote', { remote: { ...s.remote, enabled: e.target.checked } });
$('remotePort').onchange = (e) => save('remote', { remote: { ...s.remote, port: Number(e.target.value) } });
$('remoteNewPin').onclick = async () => {
  if (!confirm('Make a new PIN? Every phone that is signed in now will need the new one.')) return;
  renderRemote(await api.remoteNewPin());
};
api.onRemote?.(renderRemote);
document.querySelector('.rail [data-view="controls"]').addEventListener('click', async () => {
  renderRemote(await api.remoteInfo?.());
  hotkeyFailed = (await api.hotkeyStatus?.()) || [];
  renderHotkeys(true);
});

// ---------- render ----------

function render() {
  $('screenOn').checked = s.screenOn;
  $('brightness').value = s.brightness;
  $('brightnessVal').textContent = `${s.brightness}%`;
  seg($('layout'), s.layout, (v) => save('screen', { layout: v }));
  renderMedia();
  renderOverlay();
  renderSwatches();
  seg($('fanMode'), s.fan.mode, (v) => save('fan', { fan: { ...s.fan, mode: v } }));
  $('curveBlock').hidden = s.fan.mode !== 'Smart Mode';
  $('fixedBlock').hidden = s.fan.mode !== 'Fixed Mode';
  $('fixed').value = s.fan.fixedMode;
  $('fixedVal').textContent = `${s.fan.fixedMode}%`;
  seg($('unit'), s.unit, (v) => save('unit', { unit: v }));
  document.querySelectorAll('.unit').forEach((u) => (u.textContent = unitSym()));
  $('standby').checked = s.standby;
  $('closeToTray').checked = s.closeToTray !== false;
  $('updAuto').checked = s.updates?.auto !== false;
  renderNight();
  renderHistoryControls();
  renderAlerts();
  renderProfiles();
  renderHotkeys();
  renderTopChips();
  drawCurve();
}

api.onSettings?.((next) => {
  s = next;
  render();
});

(async () => {
  s = await api.getSettings();
  render();
  showStatus(await api.getStatus());
  setMedia(await api.listMedia());
  loadSystem();
})();

// ---------- browser preview mock ----------

function createMock() {
  let settings = {
    unit: 'Celsius', screenOn: true, brightness: 70, standby: true,
    media: 'sample-a.mp4.h264_2240x1080', textColor: '#dcdcdc', layout: 'dual', badges: { cpu: true, gpu: true },
    splitLeft: 'side-a.png.h264_1120x1080', splitRight: '',
    overlay: ['CPU Temperature', 'CPU Usage', 'CPU Power', 'Memory Usage', 'GPU Temperature', 'GPU Usage', 'GPU Power', 'Clock'],
    // (CURVES isn't defined yet when the mock is created, so the balanced curve is spelled out.)
    fan: { mode: 'Smart Mode', smartMode: [[0, 10], [10, 20], [30, 30], [50, 40], [65, 55], [80, 70], [90, 100], [100, 100]], fixedMode: 50 },
    overlayStyle: { font: 'roboto-regular', size: 100, preset: 'columns', titles: true },
    customText: 'My PC',
    night: { schedule: true, start: '22:00', end: '07:00', brightness: 15, idle: false, idleMinutes: 10, idleBrightness: 10 },
    history: { enabled: true, interval: 5, keepDays: 0 },
    nowPlaying: { enabled: true, placement: 'top', artist: true, time: true, hideWhenPaused: true, scroll: false },
    alerts: { enabled: true, cpu: 95, gpu: 88, seconds: 5, notify: true, fanBoost: true, redText: true },
    hotkeys: { toggleScreen: 'Ctrl+Alt+S', nextProfile: 'Ctrl+Alt+P', toggleNight: '', fanBoost: 'Ctrl+Alt+F', brightnessUp: '', brightnessDown: '', playPause: '' },
    remote: { enabled: true, port: 8457, pin: '482913' },
    autoSwitch: true, autoFrom: '', profileToasts: true, activeProfile: 'a1b2c3d4',
    profiles: [
      { id: 'a1b2c3d4', name: 'Default', apps: [], hotkey: '', data: { media: 'sample-a.mp4.h264_2240x1080', layout: 'single', brightness: 70, overlay: ['CPU Temperature', 'GPU Temperature'], fan: { mode: 'Smart Mode' } } },
      { id: 'e5f6a7b8', name: 'Gaming', apps: ['cs2.exe', 'eldenring.exe'], hotkey: 'Ctrl+Alt+G', data: { media: 'default_01.mp4.h264_2240x1080', layout: 'single', brightness: 100, overlay: ['GPU Temperature', 'GPU Usage', 'GPU Power', 'CPU Temperature'], fan: { mode: 'Fixed Mode', fixedMode: 80 } } }
    ]
  };
  const h = { stats: [], status: [] };
  let t = 0;
  setInterval(() => {
    t++;
    const st = {
      cpu: { load: 20 + Math.round(15 * Math.sin(t / 7)), temperature: Math.round(52 + 9 * Math.sin(t / 9)), frequency: 4620, power: 64 },
      gpu: { load: 35, temperature: Math.round(61 + 6 * Math.sin(t / 11)), frequency: 1850, power: 142 },
      memory: { load: 41, frequency: 6000 },
      network: { down: 2.6 * 1024 * 1024, up: 140 * 1024 },
      disk: { load: 63 },
      cooler: { fansSpeed: 1240, pumpSpeed: 2650 },
      fanPower: 38,
      night: { active: true, reasons: ['schedule'], brightness: 15 }
    };
    h.stats.forEach((f) => f(st));
  }, 1000);
  // A fake day of history for the preview: one sample per minute from 09:00 to 23:00.
  const fakeDay = () => {
    const points = [];
    const start = new Date('2026-11-12T09:00:00').getTime();
    for (let m = 0; m < 14 * 60; m++) {
      const g = m > 600 && m < 780 ? 1 : 0; // a gaming session in the evening
      points.push([start + m * 6e4, 45 + 8 * Math.sin(m / 50) + g * 22, 18 + g * 40, 4600, 40 + g * 70, 38 + g * 30, 5 + g * 85, 1800, 20 + g * 230, 40 + g * 25, 300 + 900 * Math.random(), 40, 63, 30 + g * 35]);
    }
    const summary = {};
    ['cpu_temp_c', 'gpu_temp_c', 'cpu_load_pct', 'gpu_load_pct', 'cpu_power_w', 'gpu_power_w'].forEach((k, i) => {
      const c = [1, 5, 2, 6, 4, 8][i];
      const v = points.map((p) => p[c]);
      summary[k] = { min: Math.min(...v), max: Math.max(...v), avg: v.reduce((a, b) => a + b, 0) / v.length };
    });
    const columns = ['time', 'cpu_temp_c', 'cpu_load_pct', 'cpu_clock_mhz', 'cpu_power_w', 'gpu_temp_c', 'gpu_load_pct', 'gpu_clock_mhz', 'gpu_power_w', 'ram_load_pct', 'net_down_kbps', 'net_up_kbps', 'disk_load_pct', 'fan_power_pct'].map((k) => [k, k]);
    return { day: '2026-11-12', columns, points, summary };
  };
  setTimeout(() => h.status.forEach((f) => f({ status: 'connected', device: { productName: 'PASE' } })), 600);
  return {
    getSettings: async () => settings,
    setSettings: async (_sec, patch) => (settings = { ...settings, ...patch }),
    retry: async () => true,
    getStatus: async () => ({ status: 'connecting' }),
    listMedia: async () => [
      { fileName: 'sample-a.mp4.h264_2240x1080', preview: null },
      { fileName: 'default_01.mp4.h264_2240x1080', preview: null, readOnly: true },
      { fileName: 'side-a.png.h264_1120x1080', preview: null, half: true },
      { fileName: 'side-b.gif.h264_1120x1080', preview: null, half: true }
    ],
    getHardwareNames: async () => ({ cpu: 'Intel(R) Core(TM) Ultra 7 270K Plus', gpu: 'NVIDIA GeForce RTX 5070 Ti' }),
    historyDays: async () => ({ dir: 'C:\\Users\\you\\Documents\\Frosted-AIO\\History', days: ['2026-11-12', '2026-11-11'] }),
    historyRead: async () => fakeDay(),
    historyOpen: async () => '',
    addMedia: async () => null,
    deleteMedia: async () => settings,
    activateProfile: async (id) => (settings = { ...settings, activeProfile: id }),
    createProfile: async () => settings,
    deleteProfile: async () => settings,
    runningPrograms: async () => [{ exe: 'spotify.exe', title: 'Spotify Premium' }, { exe: 'cs2.exe', title: 'Counter-Strike 2' }],
    pickProgram: async () => null,
    remoteInfo: async () => ({ enabled: true, running: true, port: 8457, pin: '482913', urls: ['http://192.168.1.20:8457'], qr: '', error: null }),
    onStatus: (cb) => h.status.push(cb),
    onStats: (cb) => h.stats.push(cb),
    onMedia: () => {},
    onSettings: () => {}
  };
}
