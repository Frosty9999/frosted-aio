// The stats overlay drawn on the Panorama SE screen (2240x1080): which items exist, how they're laid out,
// and the exact label groups sent to the cooler. Shared by the main process (what the cooler gets) and
// the renderer (the preview), so the two always match. Loaded with require() in main and a <script> tag
// in the renderer (window.Overlay).

(function (root) {
  const W = 2240;
  const H = 1080;
  const MARGIN_X = 60;
  const COLUMN_Y = [179, 416, 652, 888];
  // Now Playing is one centred line, at the top between the CPU/GPU badges or at the bottom between the
  // bottom-left and bottom-right stats. Either way the stats keep their normal positions and size.
  const NP_TOP_Y = 70;
  const NP_BOTTOM_Y = 975; // level with the numbers of the bottom stat row
  const NP_SIZE = 34;
  const NP_CENTER_X = 700;
  const NP_CENTER_W = 840;

  const FONTS = {
    'roboto-regular': { name: 'Roboto', valueScale: 1 },
    // KANALI shrinks Orbitron numbers by 50/160 so they fit the same space; we do the same.
    'orbitron-regular': { name: 'Orbitron', valueScale: 1 - 50 / 160 }
  };

  const PRESETS = {
    columns: { name: 'Two columns', max: 8 },
    left: { name: 'Left column', max: 4 },
    right: { name: 'Right column', max: 4 },
    row: { name: 'Bottom row', max: 4 }
  };

  const fmtRate = (bytesPerSec) => {
    const b = Math.max(0, Number(bytesPerSec) || 0);
    if (b >= 1024 * 1024) return { value: (b / 1024 / 1024).toFixed(b >= 10 * 1024 * 1024 ? 0 : 1), unit: 'MB/s' };
    return { value: String(Math.round(b / 1024)), unit: 'KB/s' };
  };
  const temp = (c, ctx) => (ctx.unit === 'Fahrenheit' ? Math.floor(c * 1.8 + 32) : Math.round(c));
  const tempUnit = (ctx) => (ctx.unit === 'Fahrenheit' ? '°F' : '°C');

  // Every overlay item: button label, title on the screen, and how to read its value and unit.
  // `get(stats, ctx)` returns { value, unit, title? } (title only when it changes, like the date).
  const ITEMS = {
    'CPU Temperature': { short: 'CPU Temp', title: 'CPU TEMP', get: (s, c) => ({ value: temp(s.cpu.temperature, c), unit: tempUnit(c) }) },
    'CPU Usage': { short: 'CPU Usage', title: 'CPU Usage', get: (s) => ({ value: s.cpu.load, unit: '%' }) },
    'CPU Frequency': { short: 'CPU Clock', title: 'CPU Clock', get: (s) => ({ value: s.cpu.frequency, unit: 'MHz' }) },
    'CPU Power': { short: 'CPU Power', title: 'CPU Power', get: (s) => ({ value: s.cpu.power, unit: 'W' }) },
    'GPU Temperature': { short: 'GPU Temp', title: 'GPU TEMP', get: (s, c) => ({ value: temp(s.gpu.temperature, c), unit: tempUnit(c) }) },
    'GPU Usage': { short: 'GPU Usage', title: 'GPU Usage', get: (s) => ({ value: s.gpu.load, unit: '%' }) },
    'GPU Frequency': { short: 'GPU Clock', title: 'GPU Clock', get: (s) => ({ value: s.gpu.frequency, unit: 'MHz' }) },
    'GPU Power': { short: 'GPU Power', title: 'GPU Power', get: (s) => ({ value: s.gpu.power, unit: 'W' }) },
    'Memory Usage': { short: 'RAM Usage', title: 'Memory Usage', get: (s) => ({ value: s.memory.load, unit: '%' }) },
    'Memory Frequency': { short: 'RAM Clock', title: 'Memory Clock', get: (s) => ({ value: s.memory.frequency, unit: 'MHz' }) },
    'Network Down': { short: 'Download', title: 'Download', get: (s) => fmtRate(s.network?.down) },
    'Network Up': { short: 'Upload', title: 'Upload', get: (s) => fmtRate(s.network?.up) },
    'Disk Usage': { short: 'Disk C:', title: 'Disk C:', get: (s) => ({ value: s.disk?.load ?? 0, unit: '%' }) },
    'Fan Power': { short: 'Fan %', title: 'Fan', get: (s) => ({ value: s.fanPower ?? 0, unit: '%' }) },
    'Pump Speed': { short: 'Pump Speed', title: 'Pump', get: (s) => ({ value: s.cooler.pumpSpeed, unit: 'RPM' }) },
    'Fan Speed': { short: 'Fan Speed', title: 'Fans', get: (s) => ({ value: s.cooler.fansSpeed, unit: 'RPM' }) },
    Clock: {
      short: 'Clock',
      title: 'date',
      get: (_s, c) => {
        const d = c.now || new Date();
        return { title: d.toLocaleDateString(), value: d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), unit: '' };
      }
    },
    Date: {
      short: 'Date',
      title: 'weekday',
      get: (_s, c) => {
        const d = c.now || new Date();
        return { title: d.toLocaleDateString([], { weekday: 'long' }), value: d.toLocaleDateString([], { month: 'short', day: 'numeric' }), unit: '' };
      }
    },
    'Custom Text': { short: 'Custom text', title: '', get: (_s, c) => ({ value: (c.customText || '').slice(0, 24) || ' ', unit: '' }) }
  };
  const ITEM_ORDER = Object.keys(ITEMS);

  const style = (st = {}) => ({
    font: FONTS[st.font] ? st.font : 'roboto-regular',
    size: Math.max(60, Math.min(140, Number(st.size) || 100)),
    preset: PRESETS[st.preset] ? st.preset : 'columns',
    titles: st.titles !== false
  });

  // ---------- Now Playing ----------

  const NP_DEFAULTS = { enabled: true, placement: 'top', artist: true, time: true, hideWhenPaused: true, scroll: false };
  const npOptions = (o) => ({ ...NP_DEFAULTS, ...(o || {}) });

  const APP_NAMES = [
    [/spotify/i, 'Spotify'],
    [/chrome/i, 'Chrome'],
    [/msedge|edge/i, 'Edge'],
    [/308046B0AF4A39CB|firefox/i, 'Firefox'],
    [/opera/i, 'Opera'],
    [/brave/i, 'Brave'],
    [/AppleMusic|AppleInc/i, 'Apple Music'],
    [/ZuneMusic|ZuneVideo|Media\.Player/i, 'Media Player'],
    [/vlc/i, 'VLC'],
    [/foobar/i, 'foobar2000'],
    [/tidal/i, 'TIDAL'],
    [/deezer/i, 'Deezer'],
    [/amazon/i, 'Amazon Music'],
    [/youtube/i, 'YouTube Music']
  ];
  function appName(id) {
    if (!id) return '';
    for (const [re, name] of APP_NAMES) if (re.test(id)) return name;
    return String(id).split('!')[0].split('\\').pop().replace(/\.exe$/i, '').replace(/^[^.]+\./, '');
  }

  const clock = (sec) => {
    const s = Math.max(0, Math.floor(Number(sec) || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = String(s % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
  };

  // Is the Now Playing text on screen right now?
  function npVisible(settings, np) {
    const o = npOptions(settings.nowPlaying);
    if (!o.enabled || !np || !np.title) return false;
    return np.playing || (!o.hideWhenPaused && np.status === 'Paused');
  }

  // Fit text into `max` characters: cut with "..." or, with scrolling on, show a moving window.
  function fit(text, max, scroll, now) {
    const t = String(text || '').replace(/\s+/g, ' ').trim();
    if (t.length <= max) return t;
    if (!scroll) return t.slice(0, Math.max(1, max - 3)).trimEnd() + '...';
    const loop = t + '     ';
    const offset = Math.floor((now || Date.now()) / 500) % loop.length; // 2 characters a second
    return (loop + loop).slice(offset, offset + max);
  }

  // Roughly how many characters fit a width at a text size (Orbitron is wider than Roboto).
  const charsFor = (widthPx, textSize, font) => Math.floor(widthPx / (textSize * (font === 'orbitron-regular' ? 0.78 : 0.55)));

  /** Where the Now Playing line goes, in cooler pixels. */
  function npSlot(settings, st) {
    const o = npOptions(settings.nowPlaying);
    if (o.placement === 'bottom') {
      if (st.preset === 'row') {
        // The bottom row of stats fills the width, so the line sits just above it, centred.
        const sz = sizes(st);
        return { x: MARGIN_X, y: H - 70 - sz.value - sz.title - NP_SIZE - 30, width: W - MARGIN_X * 2 };
      }
      return { x: NP_CENTER_X, y: NP_BOTTOM_Y, width: NP_CENTER_W }; // between the bottom-left and bottom-right stats
    }
    const badges = settings.badges || {};
    const wide = !badges.cpu && !badges.gpu; // no badges: the whole top edge is free
    return wide ? { x: MARGIN_X, y: NP_TOP_Y, width: W - MARGIN_X * 2 } : { x: NP_CENTER_X, y: NP_TOP_Y, width: NP_CENTER_W };
  }

  /** The Now Playing line (empty when it isn't showing). Group 500, label 5001. */
  function npGroups(settings, ctx, color, font) {
    const np = ctx.nowPlaying;
    if (!npVisible(settings, np)) return [];
    const o = npOptions(settings.nowPlaying);
    const pos = npSlot(settings, style(settings.overlayStyle));
    const time = o.time && np.duration > 0 ? `${clock(np.position)} / ${clock(np.duration)}` : '';
    // Shorten (or scroll) the title, never the artist or time.
    const artist = o.artist && np.artist ? fit(np.artist, 24, false) : '';
    const room = charsFor(pos.width, NP_SIZE, font) - (time ? time.length + 3 : 0) - (artist ? artist.length + 3 : 0);
    const title = fit(np.title, Math.max(10, room), o.scroll, ctx.now?.getTime?.());
    const line = [title, artist].filter(Boolean).join(' · ') + (time ? `   ${time}` : '');
    return [{
      groupId: 500, groupX: pos.x, groupY: pos.y, groupWidth: pos.width, groupHeight: NP_SIZE, textAlign: 'Center', lineGap: 1,
      labels: [{ labelId: 5001, gapLeft: 0, line: 0, textColor: color, text: line || ' ', textSize: NP_SIZE, textFont: font }]
    }];
  }

  // Per-second text for Now Playing (matches npGroups' labels).
  function npUpdates(settings, ctx) {
    return npGroups(settings, ctx, 0, style(settings.overlayStyle).font).map((g) => ({
      groupId: g.groupId,
      labelTexts: g.labels.map((l) => ({ labelId: l.labelId, text: l.text }))
    }));
  }


  function sizes(st) {
    const k = st.size / 100;
    return {
      value: Math.round(118 * k * FONTS[st.font].valueScale),
      title: Math.max(16, Math.round(22 * k)),
      unit: Math.max(18, Math.round(27 * k))
    };
  }

  // Where slot i of n goes, in cooler pixels.
  function slot(i, n, st) {
    const sz = sizes(st);
    const ys = COLUMN_Y;
    switch (st.preset) {
      case 'left':
        return { x: MARGIN_X, y: ys[i], width: 1000, align: 'Left' };
      case 'right':
        return { x: W / 2 + MARGIN_X, y: ys[i], width: 1000, align: 'Right' };
      case 'row': {
        const cell = (W - MARGIN_X * 2) / Math.max(1, n);
        return { x: Math.round(MARGIN_X + cell * i), y: H - 70 - sz.value - sz.title, width: Math.round(cell - 20), align: 'Left' };
      }
      default:
        return i < 4 ? { x: MARGIN_X, y: ys[i], width: 1000, align: 'Left' } : { x: W / 2 + MARGIN_X, y: ys[i - 4], width: 1000, align: 'Right' };
    }
  }

  // Group/label IDs per slot: same numbering as before (100-103 left, 200-203 right).
  function ids(i) {
    const groupId = i < 4 ? 100 + i : 200 + (i - 4);
    return { groupId, title: groupId * 10 + 1, value: groupId * 10 + 2, unit: groupId * 10 + 3 };
  }

  function visibleItems(overlay, st) {
    return (overlay || []).filter((n) => ITEMS[n]).slice(0, PRESETS[st.preset].max);
  }

  function read(name, stats, ctx) {
    const item = ITEMS[name];
    const v = item.get(stats, ctx);
    return { title: v.title ?? item.title, value: String(v.value), unit: v.unit || '' };
  }

  /** Label groups for CMD_Set_RunConfig (without the CPU/GPU badges). Includes Now Playing when it shows. */
  function groups(settings, stats, ctx) {
    const st = style(settings.overlayStyle);
    const sz = sizes(st);
    const color = parseInt(String(settings.textColor || '#dcdcdc').replace('#', ''), 16) || 0xdcdcdc;
    const list = visibleItems(settings.overlay, st);
    const statGroups = list.map((name, i) => {
      const id = ids(i);
      const pos = slot(i, list.length, st);
      const v = read(name, stats, ctx);
      const label = (labelId, text, textSize, line) => ({ labelId, gapLeft: 0, line, textColor: color, text, textSize, textFont: st.font });
      const labels = [];
      if (st.titles && v.title) labels.push(label(id.title, v.title, sz.title, 1));
      labels.push(label(id.value, v.value, sz.value, 0));
      labels.push(label(id.unit, v.unit || ' ', sz.unit, 0)); // always present so units can change live (KB/s -> MB/s)
      return { groupId: id.groupId, groupX: pos.x, groupY: pos.y, groupWidth: pos.width, groupHeight: sz.value, textAlign: pos.align, lineGap: -10, labels };
    });
    return [...statGroups, ...npGroups(settings, ctx, color, st.font)];
  }

  /** Changes when the overlay's layout (not just its text) must be re-sent to the cooler. */
  function layoutKey(settings, ctx) {
    const np = ctx.nowPlaying;
    const visible = npVisible(settings, np);
    const o = npOptions(settings.nowPlaying);
    return JSON.stringify([visible, visible && o.placement, visible && o.time && np.duration > 0]);
  }

  /** Per-second text updates for CMD_Update_UIItemText. */
  function updates(settings, stats, ctx) {
    const st = style(settings.overlayStyle);
    return visibleItems(settings.overlay, st).map((name, i) => {
      const id = ids(i);
      const v = read(name, stats, ctx);
      const labelTexts = [
        { labelId: id.value, text: v.value },
        { labelId: id.unit, text: v.unit || ' ' }
      ];
      if (st.titles && (name === 'Clock' || name === 'Date')) labelTexts.push({ labelId: id.title, text: v.title });
      return { groupId: id.groupId, labelTexts };
    }).concat(npUpdates(settings, ctx));
  }

  const api = {
    W, H, FONTS, PRESETS, ITEMS, ITEM_ORDER, NP_DEFAULTS,
    style, sizes, slot, ids, visibleItems, read, groups, updates, layoutKey, npVisible, npOptions, appName, clock
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Overlay = api;
})(typeof window !== 'undefined' ? window : globalThis);
