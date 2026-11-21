// Frosted-AIO phone remote. Talks to the PC over the home network (see src/remote.js).
const $ = (id) => document.getElementById(id);
let token = '';
try {
  token = localStorage.getItem('frosted-token') || '';
} catch {
  /* private mode: sign in each time */
}
let state = null;
let pollTimer = null;
let busyUntil = 0; // ignore polled values briefly after a tap, so sliders don't jump back

function setToken(t) {
  token = t;
  try {
    t ? localStorage.setItem('frosted-token', t) : localStorage.removeItem('frosted-token');
  } catch {
    /* ignore */
  }
}

async function api(path, body) {
  const res = await fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    cache: 'no-store'
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/api/login') {
    setToken('');
    showLogin();
  }
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  return data;
}

function showLogin(msg = '') {
  clearInterval(pollTimer);
  $('main').hidden = true;
  $('login').hidden = false;
  $('loginErr').textContent = msg;
  setConn(null);
}

async function login(pin) {
  try {
    const { token: t } = await api('/api/login', { pin });
    setToken(t);
    start();
  } catch (e) {
    showLogin(e.message);
  }
}

$('loginForm').onsubmit = (e) => {
  e.preventDefault();
  login($('pin').value.trim());
};
$('signOut').onclick = () => {
  setToken('');
  showLogin();
};

function setConn(s) {
  const c = $('conn');
  c.className = `conn ${s == null ? '' : s.connected ? 'on' : 'off'}`;
  $('connText').textContent = s == null ? 'Signed out' : s.connected ? s.device || 'Cooler connected' : 'Cooler not connected';
}

async function refresh() {
  try {
    render(await api('/api/state'));
  } catch (e) {
    if (token) $('connText').textContent = "Can't reach the PC";
    $('conn').className = 'conn off';
  }
}

function start() {
  $('login').hidden = true;
  $('main').hidden = false;
  refresh();
  clearInterval(pollTimer);
  pollTimer = setInterval(() => document.visibilityState === 'visible' && refresh(), 2000);
}
document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && token && refresh());

async function act(action, value) {
  busyUntil = Date.now() + 1500;
  try {
    render(await api('/api/action', { action, value }), true);
  } catch (e) {
    alert(e.message);
  }
}

const heat = (el, c) => {
  el.classList.toggle('warm', c >= 70 && c < 85);
  el.classList.toggle('hot', c >= 85);
};

function render(s, fromAction = false) {
  state = s;
  setConn(s);
  const st = s.stats;
  $('cpuTemp').textContent = `${st.cpuTemp}${st.unit}`;
  $('gpuTemp').textContent = `${st.gpuTemp}${st.unit}`;
  heat($('cpuTemp'), st.cpuTempC);
  heat($('gpuTemp'), st.gpuTempC);
  $('cpuLoad').textContent = `${st.cpuLoad}% load`;
  $('gpuLoad').textContent = `${st.gpuLoad}% load`;
  $('fan').textContent = st.fanPower == null ? '--' : `${st.fanPower}%`;
  $('fanNote').textContent = s.fanBoost ? 'boost' : st.pump ? `pump ${st.pump} rpm` : '';

  $('alert').hidden = !s.alerts.length;
  $('alert').textContent = s.alerts.length ? `Temperature alert: ${s.alerts.join(' and ')} over the limit.` : '';

  $('profiles').replaceChildren(
    ...s.profiles.map((p) => {
      const b = document.createElement('button');
      b.textContent = p.name;
      b.className = p.id === s.activeProfile ? 'on' : '';
      b.onclick = () => act('profile', p.id);
      return b;
    })
  );

  const quiet = !fromAction && Date.now() < busyUntil;
  if (!quiet) {
    $('screenOn').checked = s.screenOn;
    if (document.activeElement !== $('bright')) $('bright').value = s.brightness;
    $('brightVal').textContent = `${s.brightness}%`;
  }
  $('night').classList.toggle('on', s.night.active);
  $('night').textContent = s.night.active ? 'Night mode on' : 'Night mode';
  $('boost').classList.toggle('on', s.fanBoost);
  $('boost').textContent = s.fanBoost ? 'Fan boost on' : 'Fan boost';

  const np = s.nowPlaying;
  $('np').hidden = !np.title;
  $('npTitle').textContent = np.title || '';
  $('npArtist').textContent = [np.artist, np.playing ? '' : 'paused'].filter(Boolean).join(' · ');

  $('splitNote').hidden = s.layout !== 'dual';
  const key = JSON.stringify([s.media, s.current, s.layout]);
  if (key !== $('media').dataset.key) {
    $('media').dataset.key = key;
    $('media').replaceChildren(
      ...(s.media.length
        ? s.media.map((m) => {
            const b = document.createElement('button');
            b.className = m.fileName === s.current && s.layout !== 'dual' ? 'on' : '';
            if (m.thumb) b.style.backgroundImage = `url("/api/thumb?f=${encodeURIComponent(m.fileName)}&t=${token}")`;
            else {
              const ph = document.createElement('div');
              ph.className = 'ph';
              ph.textContent = 'No preview';
              b.append(ph);
            }
            const n = document.createElement('span');
            n.textContent = m.name;
            b.append(n);
            b.onclick = () => act('show', m.fileName);
            return b;
          })
        : [Object.assign(document.createElement('p'), { textContent: 'No videos on the cooler.' })])
    );
  }
}

$('screenOn').onchange = (e) => act('screen', e.target.checked);
let brightTimer;
$('bright').oninput = (e) => {
  $('brightVal').textContent = `${e.target.value}%`;
  busyUntil = Date.now() + 1500;
  clearTimeout(brightTimer);
  brightTimer = setTimeout(() => act('brightness', Number(e.target.value)), 200);
};
$('night').onclick = () => act('night');
$('boost').onclick = () => act('fanBoost');
document.querySelectorAll('[data-media]').forEach((b) => (b.onclick = () => act('media', b.dataset.media)));

// The QR code in Frosted-AIO opens this page with #pin=123456: sign in with it, then drop it from the address.
const fromHash = (location.hash.match(/pin=(\d{6})/) || [])[1];
if (fromHash) {
  history.replaceState(null, '', '/');
  login(fromHash);
} else if (token) start();
else showLogin();
