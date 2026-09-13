'use strict';

/* واجهة التحكم من الجوال — مارا ميوزك */

const $ = (id) => document.getElementById(id);
const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const store = {
  get token() { return localStorage.getItem('mara.token'); },
  set token(v) { v ? localStorage.setItem('mara.token', v) : localStorage.removeItem('mara.token'); },
  get role() { return localStorage.getItem('mara.role') || 'staff'; },
  set role(v) { localStorage.setItem('mara.role', v); }
};

const app = {
  role: 'staff',
  maxVolume: 1,
  canPause: true,
  state: null,
  prayer: null,
  settings: null,
  playlists: [],
  streams: [],
  ws: null,
  wsRetry: 0,
  view: 'now',
  dragging: false,
  djDragging: false,
  localPosition: 0,
  library: { q: '', sort: 'title', offset: 0, limit: 60, total: 0, items: [] },
  currentPlaylist: null,
  sheetTrack: null
};

// ============================================================ نداءات الشبكة

async function api(path, { method = 'GET', body, raw } = {}) {
  const headers = { Authorization: `Bearer ${store.token || ''}` };
  if (body && !raw) headers['Content-Type'] = 'application/json';
  const res = await fetch(path, {
    method,
    headers,
    body: raw ? body : body ? JSON.stringify(body) : undefined
  });
  if (res.status === 401) {
    logout(true);
    throw new Error('انتهت الجلسة');
  }
  const data = res.headers.get('content-type')?.includes('application/json') ? await res.json() : null;
  if (!res.ok) throw new Error(data?.error || `خطأ ${res.status}`);
  return data;
}

const cmd = (action, body) => api(`/api/player/${action}`, { method: 'POST', body: body || {} });

// ================================================================ الدخول

let pinBuffer = '';

function setupKeypad() {
  const pad = $('keypad');
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'مسح', '0', '⌫'];
  for (const key of keys) {
    const btn = el('button', 'key', key);
    btn.addEventListener('click', () => {
      if (key === '⌫') pinBuffer = pinBuffer.slice(0, -1);
      else if (key === 'مسح') pinBuffer = '';
      else if (pinBuffer.length < 10) pinBuffer += key;
      paintPin();
      if (pinBuffer.length >= 4) tryLogin();
    });
    pad.appendChild(btn);
  }
  paintPin();
}

function paintPin() {
  const box = $('pin-display');
  box.textContent = '•'.repeat(pinBuffer.length) || '—';
}

let loginBusy = false;
async function tryLogin() {
  if (loginBusy) return;
  loginBusy = true;
  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: pinBuffer, device: navigator.userAgent.slice(0, 60) })
    });
    const data = await res.json();
    if (!res.ok) {
      $('login-error').textContent = data.error || 'تعذّر الدخول';
      pinBuffer = '';
      paintPin();
      return;
    }
    store.token = data.token;
    store.role = data.role;
    $('login-error').textContent = '';
    pinBuffer = '';
    await start();
  } catch (err) {
    $('login-error').textContent = 'تعذّر الاتصال بجهاز المطعم';
  } finally {
    loginBusy = false;
  }
}

function logout(silent) {
  if (!silent) api('/api/auth/logout', { method: 'POST' }).catch(() => {});
  store.token = null;
  if (app.ws) {
    try { app.ws.close(); } catch (_) { /* تجاهل */ }
  }
  $('app').hidden = true;
  $('view-login').hidden = false;
  paintPin();
}

// ================================================================ الإقلاع

async function start() {
  try {
    const me = await api('/api/me');
    app.role = me.role;
    app.maxVolume = me.maxVolume;
    app.canPause = me.canPause;
    store.role = me.role;
  } catch (err) {
    logout(true);
    return;
  }

  $('view-login').hidden = true;
  $('app').hidden = false;
  document.body.classList.toggle('is-admin', app.role === 'admin');

  connectSocket();
  await Promise.all([refreshState(), loadPlaylists(), loadStreams()]);
  loadLibrary(true);
  switchView(app.view);
}

async function refreshState() {
  try {
    applyState(await api('/api/state'));
  } catch (_) { /* تجاهل */ }
  try {
    applyPrayer(await api('/api/prayer'));
  } catch (_) { /* تجاهل */ }
}

function connectSocket() {
  if (app.ws) {
    try { app.ws.close(); } catch (_) { /* تجاهل */ }
  }
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws?t=${encodeURIComponent(store.token)}`);
  app.ws = ws;

  ws.onopen = () => {
    app.wsRetry = 0;
    setOffline(false);
  };
  ws.onmessage = (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch (_) { return; }
    if (msg.type === 'state') applyState(msg.data);
    else if (msg.type === 'tick') applyTick(msg.data);
    else if (msg.type === 'prayer') applyPrayer(msg.data);
    else if (msg.type === 'library') loadLibrary(true);
    else if (msg.type === 'playlists') loadPlaylists();
    else if (msg.type === 'streams') loadStreams();
    else if (msg.type === 'revoked') logout(true);
  };
  ws.onclose = (e) => {
    setOffline(true);
    if (e.code === 4001) {
      logout(true);
      return;
    }
    app.wsRetry = Math.min(app.wsRetry + 1, 10);
    setTimeout(connectSocket, Math.min(1000 * app.wsRetry, 8000));
  };
  ws.onerror = () => { /* onclose يتكفّل بإعادة المحاولة */ };
}

// ================================================================ العرض

function applyState(state) {
  if (!state) return;
  app.state = state;
  if (!app.dragging) app.localPosition = state.position || 0;
  renderNow();
  // لا نعيد بناء القوائم إلا إذا تغيّرت فعلًا — أهم سبب لثقل الواجهة على الجوال
  const signature = JSON.stringify([
    state.queue.map((t) => t.id),
    state.upNext.map((t) => t.id),
    state.source && state.source.id
  ]);
  if (signature !== app.queueSignature) {
    app.queueSignature = signature;
    renderQueue();
  }
  const liveId = state.stream ? state.stream.id : null;
  if (liveId !== app.liveStreamId) {
    app.liveStreamId = liveId;
    renderStreams();
  }
}

/** تحديث خفيف كل ثانية: الموضع فقط، بلا إعادة بناء لأي قائمة. */
function applyTick(tick) {
  if (!tick) return;
  if (!app.state) return refreshState();
  const currentId = app.state.track ? app.state.track.id : null;
  if (tick.trackId !== currentId) return refreshState(); // تغيّرت الأغنية — نطلب الحالة الكاملة

  const statusChanged = app.state.status !== tick.status;
  app.state.status = tick.status;
  app.state.duration = tick.duration || app.state.duration;
  app.state.position = tick.position;
  if (!app.dragging) app.localPosition = tick.position;

  if (statusChanged) {
    const glyph = tick.status === 'playing' ? '❚❚' : '▶';
    $('btn-play').textContent = glyph;
    $('mini-play').textContent = glyph;
  }
  paintProgress();
}

function paintProgress() {
  const duration = app.state ? app.state.duration || 0 : 0;
  const ratio = duration ? app.localPosition / duration : 0;
  $('mini-fill').style.width = `${Math.min(100, ratio * 100)}%`;
  if (app.dragging) return;
  $('seek').value = Math.round(ratio * 1000);
  $('now-position').textContent = fmt(app.localPosition);
  $('now-duration').textContent = fmt(duration);
}

/** شريط التشغيل المصغّر: يظهر في كل التبويبات عدا "الآن". */
function renderMiniBar() {
  const s = app.state;
  const bar = $('minibar');
  const hasTrack = !!(s && s.track);
  bar.hidden = !hasTrack || app.view === 'now';
  document.body.classList.toggle('has-mini', !bar.hidden);
  if (!hasTrack) return;
  $('mini-title').textContent = s.track.title || 'بدون عنوان';
  $('mini-sub').textContent = s.track.artist || (s.source ? s.source.name : '');
  $('mini-play').textContent = s.status === 'playing' ? '❚❚' : '▶';
  const thumb = $('mini-thumb');
  if (s.track.cover) {
    if (thumb.dataset.cover !== s.track.cover) {
      thumb.dataset.cover = s.track.cover;
      thumb.style.backgroundImage = `url(${s.track.cover})`;
      thumb.textContent = '';
    }
  } else {
    thumb.style.backgroundImage = '';
    thumb.textContent = '♪';
    delete thumb.dataset.cover;
  }
}

function setOffline(isOffline) {
  document.body.classList.toggle('offline', isOffline);
  $('offline-pill').hidden = !isOffline;
}

function applyPrayer(prayer) {
  app.prayer = prayer;
  renderPrayerStrip();
}

function renderNow() {
  const s = app.state;
  if (!s) return;
  const track = s.track;

  renderDj();
  $('now-source').textContent = s.source ? s.source.name : '';
  $('now-title').textContent = track ? track.title : (s.libraryCount ? 'متوقف' : 'المكتبة فارغة');
  $('now-artist').textContent = track ? track.artist || '' : '';

  const cover = $('now-cover');
  if (track && track.cover) {
    if (cover.getAttribute('src') !== track.cover) cover.src = track.cover;
    cover.hidden = false;
    $('now-cover-fallback').hidden = true;
  } else {
    cover.hidden = true;
    $('now-cover-fallback').hidden = false;
  }

  $('btn-play').textContent = s.status === 'playing' ? '❚❚' : '▶';
  $('btn-shuffle').classList.toggle('on', !!s.shuffle);
  $('btn-repeat').classList.toggle('on', s.repeat !== 'off');
  $('btn-repeat').textContent = s.repeat === 'one' ? '🔂' : '🔁';

  const isLive = !!(track && track.live);
  $('seek-block').hidden = isLive;
  if (isLive) $('now-artist').textContent = '● بثّ مباشر';
  paintProgress();

  const volPct = Math.round((s.volume || 0) * 100);
  if (document.activeElement !== $('volume')) $('volume').value = volPct;
  $('volume-value').textContent = `${volPct}%`;
  $('btn-mute').textContent = s.muted ? '🔇' : volPct === 0 ? '🔈' : volPct < 50 ? '🔉' : '🔊';

  // بانر الإيقاف التلقائي
  const banner = $('auto-banner');
  if (s.autoPause) {
    banner.hidden = false;
    $('auto-banner-text').textContent =
      `${s.autoPause.label} — ${s.autoPause.mode === 'lower' ? 'الصوت منخفض' : 'الموسيقى متوقفة'}${s.autoPause.until ? ` حتى ${s.autoPause.until}` : ''}`;
    $('auto-banner-resume').hidden = app.role !== 'admin';
  } else {
    banner.hidden = true;
  }

  // تعطيل الأزرار للموظف عند المنع
  const disabled = app.role !== 'admin' && !app.canPause;
  for (const id of ['btn-play', 'btn-next', 'btn-prev', 'mini-play', 'mini-next']) $(id).disabled = disabled;
  for (const id of ['btn-shuffle', 'btn-repeat']) $(id).disabled = app.role !== 'admin';
  $('volume').disabled = false;

  renderMiniBar();
}

/** لوحة الديجي — تعكس حالة الجهاز، ولا تُحدَّث أثناء سحب الفلتر. */
function renderDj() {
  if (app.role !== 'admin') return;
  const dj = (app.state && app.state.dj) || null;
  if (!dj) return;
  const block = $('dj-block');
  block.classList.toggle('on', !!dj.enabled);
  $('dj-state').textContent = dj.enabled ? 'يعمل' : 'مطفأ';
  $('dj-panel').hidden = !dj.enabled;
  $('dj-echo').classList.toggle('on', !!dj.echo);
  $('dj-automix').classList.toggle('on', !!dj.autoMix);
  if (!app.djDragging) {
    $('dj-filter').value = dj.filter || 0;
    $('dj-filter-value').textContent = filterLabel(dj.filter || 0);
  }
}

function filterLabel(value) {
  const v = Number(value) || 0;
  if (v > 2) return `مشدود ${v}%`;
  if (v < -2) return `غائر ${Math.abs(v)}%`;
  return 'طبيعي';
}

function renderPrayerStrip() {
  const box = $('prayer-strip');
  box.innerHTML = '';
  const p = app.prayer;
  if (!p || !p.enabled) return;
  for (const item of p.prayers) {
    const chip = el('div', `chip ${item.active ? 'active' : ''} ${item.enabled ? '' : 'off'}`);
    chip.appendChild(el('b', null, item.name));
    chip.appendChild(el('span', null, item.time));
    box.appendChild(chip);
  }
}

function renderQueue() {
  const s = app.state;
  if (!s) return;
  const list = $('queue-list');
  list.innerHTML = '';
  const queueFragment = document.createDocumentFragment();
  if (!s.queue.length) {
    queueFragment.appendChild(el('li', 'empty', 'لا توجد أغانٍ مضافة يدويًا'));
  }
  s.queue.forEach((track, index) => {
    const li = el('li', 'track');
    li.appendChild(trackInfo(track));
    if (app.role === 'admin') {
      const actions = el('div', 'row-actions');
      const up = el('button', 'mini', '↑');
      up.onclick = () => cmd('queue-move', { from: index, to: Math.max(0, index - 1) });
      const down = el('button', 'mini', '↓');
      down.onclick = () => cmd('queue-move', { from: index, to: Math.min(s.queue.length - 1, index + 1) });
      const rm = el('button', 'mini danger', '✕');
      rm.onclick = () => cmd('queue-remove', { index });
      actions.append(up, down, rm);
      li.appendChild(actions);
    }
    queueFragment.appendChild(li);
  });
  list.appendChild(queueFragment);

  $('queue-source').textContent = s.source ? s.source.name : '';
  const upnext = $('upnext-list');
  upnext.innerHTML = '';
  const upFragment = document.createDocumentFragment();
  if (!s.upNext.length) upFragment.appendChild(el('li', 'empty', '—'));
  for (const track of s.upNext) {
    const li = el('li', 'track');
    li.appendChild(trackInfo(track));
    upFragment.appendChild(li);
  }
  upnext.appendChild(upFragment);
}

function trackInfo(track) {
  const wrap = el('div', 'track-info');
  let img;
  if (track.cover) {
    // صورة كسولة: لا تُحمَّل إلا عند ظهورها على الشاشة — أسرع بكثير في القوائم الطويلة
    img = el('img', 'thumb');
    img.loading = 'lazy';
    img.decoding = 'async';
    img.alt = '';
    img.src = track.cover;
  } else {
    img = el('div', 'thumb');
    img.textContent = '♪';
  }
  const text = el('div', 'track-text');
  text.appendChild(el('div', 'track-title', track.title || 'بدون عنوان'));
  text.appendChild(el('div', 'track-sub', [track.artist, track.duration ? fmt(track.duration) : null].filter(Boolean).join(' • ')));
  wrap.append(img, text);
  return wrap;
}

// ================================================================ المكتبة

let searchTimer = null;

async function loadLibrary(reset) {
  if (reset) {
    app.library.offset = 0;
    app.library.items = [];
  }
  const { q, sort, offset, limit } = app.library;
  try {
    const data = await api(`/api/library?q=${encodeURIComponent(q)}&sort=${sort}&offset=${offset}&limit=${limit}`);
    app.library.total = data.total;
    app.library.items = offset === 0 ? data.items : [...app.library.items, ...data.items];
    renderLibrary({ appendOnly: offset > 0 });
  } catch (err) {
    toast(err.message);
  }
}

/**
 * عند "عرض المزيد" نضيف الجديد فقط بدل إعادة بناء القائمة كلها،
 * وكل الإضافات تتم دفعة واحدة (DocumentFragment) لتقليل إعادة التخطيط.
 */
function renderLibrary({ appendOnly = false } = {}) {
  const list = $('library-list');
  $('library-count').textContent = app.library.total ? `(${app.library.total})` : '';

  let items = app.library.items;
  if (appendOnly) {
    items = app.library.items.slice(app.library.rendered || 0);
  } else {
    list.innerHTML = '';
    app.library.rendered = 0;
    if (!app.library.items.length) {
      list.appendChild(el('li', 'empty', app.library.q ? 'لا توجد نتائج' : 'المكتبة فارغة — ارفع أغانٍ أو ضعها في مجلد الموسيقى'));
    }
  }

  const fragment = document.createDocumentFragment();
  for (const track of items) {
    const li = el('li', 'track tappable');
    li.appendChild(trackInfo(track));
    const play = el('button', 'mini primary', '▶');
    play.onclick = (e) => {
      e.stopPropagation();
      if (app.role !== 'admin') return toast('التشغيل المباشر للمدير فقط');
      cmd('play-now', { trackId: track.id }).then(() => toast('يشتغل الآن'));
    };
    li.appendChild(play);
    li.onclick = () => openSheet(track);
    fragment.appendChild(li);
  }
  list.appendChild(fragment);
  app.library.rendered = app.library.items.length;
  $('btn-more').hidden = app.library.items.length >= app.library.total;
}

// ================================================================ القوائم

async function loadPlaylists() {
  try {
    const data = await api('/api/playlists');
    app.playlists = data.items;
    renderPlaylists();
  } catch (_) { /* تجاهل */ }
}

function renderPlaylists() {
  const list = $('playlist-list');
  list.innerHTML = '';
  for (const pl of app.playlists) {
    const li = el('li', 'playlist');
    const info = el('div', 'pl-info');
    info.appendChild(el('div', 'pl-name', pl.name));
    info.appendChild(el('div', 'pl-count', `${pl.count} أغنية`));
    li.appendChild(info);

    const actions = el('div', 'row-actions');
    const play = el('button', 'mini primary', '▶');
    play.onclick = (e) => {
      e.stopPropagation();
      if (app.role !== 'admin') return toast('تغيير القائمة للمدير فقط');
      cmd('source', { playlistId: pl.id, autoplay: true }).then(() => {
        toast(`تشغيل: ${pl.name}`);
        switchView('now');
      });
    };
    actions.appendChild(play);
    li.appendChild(actions);
    li.onclick = () => openPlaylist(pl.id);
    list.appendChild(li);
  }
}

// ------------------------------------------------------------ البث المباشر

async function loadStreams() {
  try {
    const data = await api('/api/streams');
    app.streams = data.items || [];
    renderStreams();
  } catch (_) { /* تجاهل */ }
}

function renderStreams() {
  const list = $('stream-list');
  list.innerHTML = '';
  const fragment = document.createDocumentFragment();
  if (!app.streams.length) {
    fragment.appendChild(el('li', 'empty', 'لا توجد محطات بعد'));
  }
  const liveId = app.state && app.state.stream ? app.state.stream.id : null;
  for (const stream of app.streams) {
    const li = el('li', `playlist ${stream.id === liveId ? 'live' : ''}`);
    const info = el('div', 'pl-info');
    info.appendChild(el('div', 'pl-name', stream.name));
    info.appendChild(el('div', 'pl-count', stream.id === liveId ? '● يعمل الآن' : 'بثّ مباشر'));
    li.appendChild(info);

    const actions = el('div', 'row-actions');
    const play = el('button', 'mini primary', '▶');
    play.onclick = (e) => {
      e.stopPropagation();
      if (app.role !== 'admin') return toast('للمدير فقط');
      cmd('play-stream', { streamId: stream.id })
        .then(() => {
          toast(`تشغيل: ${stream.name}`);
          switchView('now');
        })
        .catch((err) => toast(err.message));
    };
    actions.appendChild(play);
    if (app.role === 'admin') {
      const rm = el('button', 'mini danger', '✕');
      rm.onclick = async (e) => {
        e.stopPropagation();
        if (!confirm(`حذف محطة "${stream.name}"؟`)) return;
        await api(`/api/streams/${stream.id}`, { method: 'DELETE' });
        loadStreams();
      };
      actions.appendChild(rm);
    }
    li.appendChild(actions);
    fragment.appendChild(li);
  }
  list.appendChild(fragment);
}

async function addStream() {
  const name = prompt('اسم المحطة (مثلاً: إذاعة هادئة):');
  if (!name) return;
  const url = prompt('رابط البث (يبدأ بـ http أو https):');
  if (!url) return;
  try {
    await api('/api/streams', { method: 'POST', body: { name, url } });
    toast('أُضيفت المحطة');
    loadStreams();
  } catch (err) {
    toast(err.message);
  }
}

async function openPlaylist(id) {
  try {
    const pl = await api(`/api/playlists/${id}`);
    app.currentPlaylist = pl;
    $('playlist-detail').hidden = false;
    $('playlist-list').hidden = true;
    $('streams-block').hidden = true;
    $('playlist-name').textContent = pl.name;
    $('btn-delete-playlist').hidden = pl.builtin || app.role !== 'admin';

    const list = $('playlist-tracks');
    list.innerHTML = '';
    if (!pl.tracks.length) list.appendChild(el('li', 'empty', 'القائمة فارغة'));
    pl.tracks.forEach((track, index) => {
      const li = el('li', 'track');
      li.appendChild(trackInfo(track));
      const actions = el('div', 'row-actions');
      const play = el('button', 'mini primary', '▶');
      play.onclick = () => {
        if (app.role !== 'admin') return toast('للمدير فقط');
        cmd('source', { playlistId: pl.id, autoplay: true, startIndex: index }).then(() => switchView('now'));
      };
      actions.appendChild(play);
      if (!pl.builtin && app.role === 'admin') {
        const up = el('button', 'mini', '↑');
        up.onclick = () => api(`/api/playlists/${pl.id}/reorder`, { method: 'POST', body: { from: index, to: Math.max(0, index - 1) } }).then(() => openPlaylist(pl.id));
        const rm = el('button', 'mini danger', '✕');
        rm.onclick = () => api(`/api/playlists/${pl.id}/tracks/${track.id}`, { method: 'DELETE' }).then(() => openPlaylist(pl.id));
        actions.append(up, rm);
      }
      li.appendChild(actions);
      list.appendChild(li);
    });
  } catch (err) {
    toast(err.message);
  }
}

function closePlaylist() {
  $('playlist-detail').hidden = true;
  $('playlist-list').hidden = false;
  $('streams-block').hidden = false;
  app.currentPlaylist = null;
}

// ============================================================ ورقة الإجراءات

function openSheet(track) {
  app.sheetTrack = track;
  $('sheet-title').textContent = track.title;
  $('sheet-backdrop').hidden = false;
}

function closeSheet() {
  $('sheet-backdrop').hidden = true;
  app.sheetTrack = null;
}

async function handleSheetAction(action) {
  const track = app.sheetTrack;
  if (!track) return closeSheet();
  if (action === 'cancel') return closeSheet();
  if (app.role !== 'admin') {
    closeSheet();
    return toast('هذه الصلاحية للمدير فقط');
  }
  try {
    switch (action) {
      case 'play-now':
        await cmd('play-now', { trackId: track.id });
        toast('يشتغل الآن');
        break;
      case 'play-next':
        await cmd('play-next', { trackId: track.id });
        toast('أُضيفت لتشتغل بعد الحالية');
        break;
      case 'enqueue':
        await cmd('enqueue', { trackIds: [track.id] });
        toast('أُضيفت لآخر القائمة');
        break;
      case 'add-playlist': {
        const options = app.playlists.filter((p) => !p.builtin);
        if (!options.length) {
          toast('أنشئ قائمة أولًا من تبويب القوائم');
          break;
        }
        const names = options.map((p, i) => `${i + 1}. ${p.name}`).join('\n');
        const answer = prompt(`اختر رقم القائمة:\n${names}`);
        const idx = Number(answer) - 1;
        if (options[idx]) {
          await api(`/api/playlists/${options[idx].id}/tracks`, { method: 'POST', body: { trackIds: [track.id] } });
          toast(`أُضيفت إلى ${options[idx].name}`);
        }
        break;
      }
      case 'delete':
        if (confirm(`حذف "${track.title}" من جهاز المطعم نهائيًا؟`)) {
          await api(`/api/library/${track.id}`, { method: 'DELETE' });
          toast('حُذفت');
          loadLibrary(true);
        }
        break;
      default:
        break;
    }
  } catch (err) {
    toast(err.message);
  }
  closeSheet();
}

// ================================================================ الرفع

const UPLOAD_BATCH = 20;

/**
 * الرفع على دفعات مع نسبة تقدّم حقيقية.
 * الدفعات تمنع سقوط رفعة كبيرة كاملة بسبب انقطاع لحظي في شبكة المحل.
 */
async function uploadFiles(files) {
  if (!files.length) return;
  const box = $('upload-progress');
  box.hidden = false;

  const batches = [];
  for (let i = 0; i < files.length; i += UPLOAD_BATCH) batches.push(files.slice(i, i + UPLOAD_BATCH));

  let uploaded = 0;
  let added = 0;
  try {
    for (let b = 0; b < batches.length; b += 1) {
      const batch = batches[b];
      const done = uploaded;
      const data = await uploadBatch(batch, (ratio) => {
        const total = done + batch.length * ratio;
        box.textContent = `جارٍ الرفع… ${Math.round((total / files.length) * 100)}% (${Math.round(total)} من ${files.length})`;
      });
      uploaded += data.uploaded;
      added += data.added.length;
    }
    box.textContent = added
      ? `تم رفع ${uploaded} ملف — أُضيفت ${added} أغنية للمكتبة`
      : `تم رفع ${uploaded} ملف — لا جديد (موجودة مسبقًا)`;
    setTimeout(() => { box.hidden = true; }, 5000);
    loadLibrary(true);
  } catch (err) {
    box.textContent = `تعذّر الرفع: ${err.message}${uploaded ? ` — نجح ${uploaded} ملف قبل التوقّف` : ''}`;
  }
}

function uploadBatch(batch, onProgress) {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    for (const file of batch) form.append('files', file);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload');
    xhr.setRequestHeader('Authorization', `Bearer ${store.token}`);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      let data = null;
      try { data = JSON.parse(xhr.responseText); } catch (_) { /* تجاهل */ }
      if (xhr.status >= 200 && xhr.status < 300 && data) resolve(data);
      else reject(new Error((data && data.error) || `خطأ ${xhr.status}`));
    };
    xhr.onerror = () => reject(new Error('انقطع الاتصال بجهاز المحل'));
    xhr.send(form);
  });
}

// ================================================================ الإعدادات

async function renderSettings() {
  if (app.role !== 'admin') return;
  const body = $('settings-body');
  body.innerHTML = '<div class="loading">جارٍ التحميل…</div>';
  let settings;
  let system;
  try {
    settings = await api('/api/settings');
    system = await api('/api/system');
  } catch (err) {
    body.innerHTML = `<div class="empty">${err.message}</div>`;
    return;
  }
  app.settings = settings;
  body.innerHTML = '';

  // --- التشغيل
  body.appendChild(card('التشغيل', [
    numberRow('مدة المزج بين الأغاني (ثانية)', 'crossfadeSec', settings.crossfadeSec, 0, 12, 0.5),
    numberRow('أقصى صوت يسمح به للموظف (%)', 'maxStaffVolume', Math.round(settings.maxStaffVolume * 100), 10, 100, 5),
    toggleRow('السماح للموظف بالإيقاف والتشغيل', 'kiosk.staffCanPause', settings.kiosk?.staffCanPause !== false),
    toggleRow('شاشة كاملة على جهاز المطعم', 'kiosk.fullscreen', settings.kiosk?.fullscreen !== false),
    toggleRow('عرض رمز QR على الشاشة', 'kiosk.showQr', settings.kiosk?.showQr !== false),
    toggleRow('تشغيل البرنامج تلقائيًا مع ويندوز', 'autoStart', settings.autoStart !== false)
  ]));

  // --- الديجي
  const djSettings = settings.dj || {};
  body.appendChild(card('مود مارا ديجي', [
    toggleRow('تفعيل المود', 'dj.enabled', djSettings.enabled === true),
    toggleRow('مزج تلقائي بين الأغاني', 'dj.autoMix', djSettings.autoMix !== false),
    numberRow('يبدأ المزج قبل النهاية بـ (ثانية)', 'dj.mixAtSec', djSettings.mixAtSec ?? 12, 2, 20, 1),
    numberRow('تجاوز بداية الأغنية القادمة (ثانية)', 'dj.skipIntroSec', djSettings.skipIntroSec ?? 0, 0, 30, 1),
    toggleRow('كنس ترددي عند الانتقال', 'dj.sweep', djSettings.sweep !== false),
    toggleRow('ذيل صدى عند الانتقال', 'dj.echoOnMix', djSettings.echoOnMix !== false),
    numberRow('مدة الشدّ قبل الدروب (ثانية)', 'dj.dropBuildSec', djSettings.dropBuildSec ?? 4, 1, 12, 1)
  ]));

  // --- الصلاة
  const prayerRows = [
    toggleRow('تفعيل الإيقاف التلقائي وقت الصلاة', 'prayer.enabled', settings.prayer.enabled),
    selectRow('طريقة التعامل', 'prayer.mode', settings.prayer.mode, [
      { value: 'pause', label: 'إيقاف الموسيقى' },
      { value: 'lower', label: 'خفض الصوت فقط' }
    ]),
    numberRow('خط العرض', 'prayer.lat', settings.prayer.lat, -90, 90, 0.0001),
    numberRow('خط الطول', 'prayer.lng', settings.prayer.lng, -180, 180, 0.0001),
    numberRow('فرق التوقيت عن غرينتش', 'prayer.tz', settings.prayer.tz, -12, 14, 0.5)
  ];
  const names = { fajr: 'الفجر', dhuhr: 'الظهر', asr: 'العصر', maghrib: 'المغرب', isha: 'العشاء' };
  for (const [key, label] of Object.entries(names)) {
    prayerRows.push(prayerRow(label, key, settings.prayer.enabledPrayers[key], settings.prayer.durations[key]));
  }
  prayerRows.push(numberRow('مدة صلاة الجمعة (دقيقة)', 'prayer.durations.jumuah', settings.prayer.durations.jumuah, 10, 180, 5));
  body.appendChild(card('أوقات الصلاة', prayerRows));

  // --- الجدولة
  body.appendChild(schedulesCard(settings.schedules || []));

  // --- الأمان
  body.appendChild(card('الأمان والأجهزة', [
    textRow('رمز المدير الجديد (4-10 أرقام)', 'adminPin', '', 'اتركه فارغًا لعدم التغيير'),
    textRow('رمز الموظف', 'staffPin', settings.staffPin, ''),
    buttonRow('إخراج كل الأجهزة الأخرى', async () => {
      if (!confirm('سيتم إخراج كل الأجهزة عدا هذا الجهاز. متابعة؟')) return;
      await api('/api/system/revoke-devices', { method: 'POST' });
      toast('تم إخراج الأجهزة');
      renderSettings();
    }),
    infoRow('الأجهزة المتصلة', String(system.devices.length))
  ]));

  // --- المكتبة والنظام
  body.appendChild(card('المكتبة والنظام', [
    textRow('مجلد الموسيقى على الجهاز', 'musicDir', settings.musicDir, ''),
    infoRow('عدد الأغاني', String(system.libraryCount)),
    infoRow('رابط التحكم', system.addresses.map((a) => `http://${a.address}:${system.port}`).join(' — ') || '—'),
    infoRow('إصدار البرنامج', system.version),
    buttonRow('تحديث المكتبة الآن', async () => {
      toast('جارٍ الفحص…');
      const r = await api('/api/library/scan', { method: 'POST' });
      toast(`تمت الإضافة: ${r.added} — الحذف: ${r.removed}`);
      loadLibrary(true);
    }),
    buttonRow('إعادة قراءة كل بيانات الأغاني', async () => {
      toast('جارٍ الفحص الكامل…');
      const r = await api('/api/library/rescan-full', { method: 'POST' });
      toast(`اكتمل — ${r.total} أغنية`);
      loadLibrary(true);
    })
  ]));

  const save = el('button', 'wide-btn save', 'حفظ الإعدادات');
  save.onclick = saveSettings;
  body.appendChild(save);
}

function card(title, rows) {
  const box = el('section', 'card');
  box.appendChild(el('h4', null, title));
  for (const row of rows) box.appendChild(row);
  return box;
}

function row(label) {
  const r = el('div', 'row');
  r.appendChild(el('label', null, label));
  return r;
}

function numberRow(label, key, value, min, max, step) {
  const r = row(label);
  const input = el('input');
  input.type = 'number';
  input.value = value;
  input.min = min;
  input.max = max;
  input.step = step;
  input.dataset.key = key;
  r.appendChild(input);
  return r;
}

function textRow(label, key, value, placeholder) {
  const r = row(label);
  const input = el('input');
  input.type = 'text';
  input.value = value || '';
  input.placeholder = placeholder || '';
  input.dataset.key = key;
  r.appendChild(input);
  return r;
}

function toggleRow(label, key, value) {
  const r = row(label);
  const input = el('input');
  input.type = 'checkbox';
  input.checked = !!value;
  input.dataset.key = key;
  input.className = 'switch';
  r.appendChild(input);
  return r;
}

function selectRow(label, key, value, options) {
  const r = row(label);
  const select = el('select');
  select.dataset.key = key;
  for (const opt of options) {
    const o = el('option', null, opt.label);
    o.value = opt.value;
    if (opt.value === value) o.selected = true;
    select.appendChild(o);
  }
  r.appendChild(select);
  return r;
}

function prayerRow(label, key, enabled, duration) {
  const r = el('div', 'row prayer-row');
  r.appendChild(el('label', null, label));
  const group = el('div', 'inline');
  const check = el('input');
  check.type = 'checkbox';
  check.className = 'switch';
  check.checked = !!enabled;
  check.dataset.key = `prayer.enabledPrayers.${key}`;
  const mins = el('input');
  mins.type = 'number';
  mins.min = 5;
  mins.max = 120;
  mins.step = 5;
  mins.value = duration;
  mins.dataset.key = `prayer.durations.${key}`;
  mins.className = 'small';
  group.append(check, mins, el('span', 'unit', 'دقيقة'));
  r.appendChild(group);
  return r;
}

function infoRow(label, value) {
  const r = el('div', 'row info');
  r.appendChild(el('label', null, label));
  r.appendChild(el('span', 'value', value));
  return r;
}

function buttonRow(label, handler) {
  const r = el('div', 'row');
  const btn = el('button', 'row-btn', label);
  btn.onclick = async () => {
    btn.disabled = true;
    try { await handler(); } catch (err) { toast(err.message); }
    btn.disabled = false;
  };
  r.appendChild(btn);
  return r;
}

function schedulesCard(schedules) {
  const box = el('section', 'card');
  box.appendChild(el('h4', null, 'الجدولة الزمنية'));
  const dayNames = ['الأحد', 'الإثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];

  for (const rule of schedules) {
    const item = el('div', 'schedule');
    const head = el('div', 'schedule-head');
    head.appendChild(el('b', null, `${rule.time} — ${rule.name}`));
    const del = el('button', 'mini danger', '✕');
    del.onclick = async () => {
      await api(`/api/schedules/${rule.id}`, { method: 'DELETE' });
      renderSettings();
    };
    head.appendChild(del);
    item.appendChild(head);
    const daysText = rule.days.length ? rule.days.map((d) => dayNames[d]).join('، ') : 'كل يوم';
    item.appendChild(el('div', 'schedule-sub', `${daysText} • ${describeAction(rule.action)}`));
    box.appendChild(item);
  }
  if (!schedules.length) box.appendChild(el('div', 'empty', 'لا توجد قواعد بعد'));

  // نموذج إضافة
  const form = el('div', 'schedule-form');
  const name = el('input');
  name.placeholder = 'اسم القاعدة (مثلاً: هدوء الصباح)';
  const time = el('input');
  time.type = 'time';
  time.value = '08:00';

  const daysBox = el('div', 'days');
  const dayChecks = dayNames.map((label, index) => {
    const chip = el('label', 'day-chip');
    const check = el('input');
    check.type = 'checkbox';
    check.value = index;
    chip.append(check, el('span', null, label));
    daysBox.appendChild(chip);
    return check;
  });

  const type = el('select');
  for (const [value, label] of Object.entries({
    playlist: 'تشغيل قائمة',
    stream: 'تشغيل بثّ مباشر',
    volume: 'ضبط مستوى الصوت',
    pause: 'إيقاف الموسيقى',
    resume: 'تشغيل الموسيقى'
  })) {
    const o = el('option', null, label);
    o.value = value;
    type.appendChild(o);
  }

  const valueSelect = el('select');
  for (const pl of app.playlists) {
    const o = el('option', null, pl.name);
    o.value = pl.id;
    valueSelect.appendChild(o);
  }
  const streamSelect = el('select');
  for (const st of app.streams) {
    const o = el('option', null, st.name);
    o.value = st.id;
    streamSelect.appendChild(o);
  }
  streamSelect.hidden = true;

  const valueNumber = el('input');
  valueNumber.type = 'number';
  valueNumber.min = 0;
  valueNumber.max = 100;
  valueNumber.step = 5;
  valueNumber.value = 50;
  valueNumber.hidden = true;

  type.onchange = () => {
    valueSelect.hidden = type.value !== 'playlist';
    streamSelect.hidden = type.value !== 'stream';
    valueNumber.hidden = type.value !== 'volume';
  };

  const add = el('button', 'row-btn', 'إضافة القاعدة');
  add.onclick = async () => {
    const days = dayChecks.filter((c) => c.checked).map((c) => Number(c.value));
    const action = { type: type.value };
    if (type.value === 'playlist') action.value = valueSelect.value;
    if (type.value === 'stream') action.value = streamSelect.value;
    if (type.value === 'volume') action.value = Number(valueNumber.value) / 100;
    try {
      await api('/api/schedules', {
        method: 'POST',
        body: { name: name.value || 'قاعدة', time: time.value, days, enabled: true, action }
      });
      renderSettings();
    } catch (err) {
      toast(err.message);
    }
  };

  form.append(name, time, daysBox, type, valueSelect, streamSelect, valueNumber, add);
  box.appendChild(form);
  return box;
}

function describeAction(action) {
  switch (action.type) {
    case 'playlist': {
      const pl = app.playlists.find((p) => p.id === action.value);
      return `تشغيل قائمة "${pl ? pl.name : action.value}"`;
    }
    case 'stream': {
      const st = app.streams.find((x) => x.id === action.value);
      return `تشغيل بث "${st ? st.name : action.value}"`;
    }
    case 'volume':
      return `ضبط الصوت على ${Math.round(action.value * 100)}%`;
    case 'pause':
      return 'إيقاف الموسيقى';
    default:
      return 'تشغيل الموسيقى';
  }
}

async function saveSettings() {
  const patch = {};
  for (const input of $('settings-body').querySelectorAll('[data-key]')) {
    const key = input.dataset.key;
    let value;
    if (input.type === 'checkbox') value = input.checked;
    else if (input.type === 'number') value = Number(input.value);
    else value = input.value;

    if (key === 'maxStaffVolume') value = Number(value) / 100;
    if (key === 'adminPin' && !String(value).trim()) continue;
    setDeep(patch, key, value);
  }
  try {
    await api('/api/settings', { method: 'PATCH', body: patch });
    toast('حُفظت الإعدادات');
    renderSettings();
    refreshState();
  } catch (err) {
    toast(err.message);
  }
}

function setDeep(target, path, value) {
  const parts = path.split('.');
  let node = target;
  for (let i = 0; i < parts.length - 1; i += 1) {
    node[parts[i]] = node[parts[i]] || {};
    node = node[parts[i]];
  }
  node[parts[parts.length - 1]] = value;
}

// ================================================================ التبويبات

function switchView(view) {
  app.view = view;
  for (const section of document.querySelectorAll('.view')) section.hidden = true;
  $(`view-${view}`).hidden = false;
  for (const btn of $('tabs').children) btn.classList.toggle('active', btn.dataset.view === view);
  window.scrollTo(0, 0);
  renderMiniBar();
  if (view === 'settings') renderSettings();
  if (view === 'playlists') {
    closePlaylist();
    loadPlaylists();
    loadStreams();
  }
}

// ================================================================ أدوات

function fmt(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

let toastTimer = null;
function toast(message) {
  const box = $('toast');
  box.textContent = message;
  box.hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { box.hidden = true; }, 2600);
}

function throttle(fn, ms) {
  let last = 0;
  let timer = null;
  return (...args) => {
    const now = Date.now();
    if (now - last >= ms) {
      last = now;
      fn(...args);
    } else {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        last = Date.now();
        fn(...args);
      }, ms - (now - last));
    }
  };
}

// ================================================================ الأحداث

function wireEvents() {
  $('btn-play').onclick = () => cmd('toggle').catch((e) => toast(e.message));
  $('btn-next').onclick = () => cmd('next').catch((e) => toast(e.message));
  $('btn-prev').onclick = () => cmd('previous').catch((e) => toast(e.message));
  $('btn-shuffle').onclick = () => cmd('shuffle', { on: !(app.state && app.state.shuffle) }).catch((e) => toast(e.message));
  $('btn-repeat').onclick = () => {
    const order = ['all', 'one', 'off'];
    const current = app.state ? app.state.repeat : 'all';
    const next = order[(order.indexOf(current) + 1) % order.length];
    cmd('repeat', { mode: next }).catch((e) => toast(e.message));
  };
  $('btn-mute').onclick = () => cmd('mute', { muted: !(app.state && app.state.muted) }).catch(() => {});
  $('btn-logout').onclick = () => logout();

  // شريط التشغيل المصغّر
  $('mini-play').onclick = () => cmd('toggle').catch((e) => toast(e.message));
  $('mini-next').onclick = () => cmd('next').catch((e) => toast(e.message));
  $('mini-open').onclick = () => switchView('now');
  $('auto-banner-resume').onclick = () => cmd('resume-now').catch((e) => toast(e.message));

  const sendVolume = throttle((value) => {
    cmd('volume', { value }).catch((e) => toast(e.message));
  }, 250);
  $('volume').addEventListener('input', (e) => {
    const pct = Number(e.target.value);
    $('volume-value').textContent = `${pct}%`;
    sendVolume(pct / 100);
  });

  // ------------------------------------------------------------ الديجي
  const dj = (body) => cmd('dj', body).catch((e) => toast(e.message));

  $('dj-toggle').onclick = () => {
    const on = !!(app.state && app.state.dj && app.state.dj.enabled);
    dj({ enabled: !on });
  };
  $('dj-next').onclick = () => cmd('dj-next').catch((e) => toast(e.message));
  $('dj-drop').onclick = () => cmd('dj-drop').catch((e) => toast(e.message));
  $('dj-echo').onclick = () => dj({ echo: !(app.state && app.state.dj && app.state.dj.echo) });
  $('dj-automix').onclick = () => dj({ autoMix: !(app.state && app.state.dj && app.state.dj.autoMix) });
  $('dj-reset').onclick = () => {
    $('dj-filter').value = 0;
    $('dj-filter-value').textContent = filterLabel(0);
    dj({ filter: 0, echo: false });
  };

  const sendFilter = throttle((value) => dj({ filter: value }), 150);
  const djFilter = $('dj-filter');
  djFilter.addEventListener('pointerdown', () => { app.djDragging = true; });
  djFilter.addEventListener('input', (e) => {
    const value = Number(e.target.value);
    $('dj-filter-value').textContent = filterLabel(value);
    sendFilter(value);
  });
  const endFilterDrag = () => { app.djDragging = false; };
  djFilter.addEventListener('pointerup', endFilterDrag);
  djFilter.addEventListener('change', endFilterDrag);

  const seek = $('seek');
  seek.addEventListener('pointerdown', () => { app.dragging = true; });
  seek.addEventListener('input', () => {
    const duration = app.state ? app.state.duration : 0;
    $('now-position').textContent = fmt((seek.value / 1000) * duration);
  });
  const commitSeek = () => {
    if (!app.dragging) return;
    app.dragging = false;
    const duration = app.state ? app.state.duration : 0;
    const sec = (seek.value / 1000) * duration;
    app.localPosition = sec;
    cmd('seek', { sec }).catch((e) => toast(e.message));
  };
  seek.addEventListener('change', commitSeek);
  seek.addEventListener('pointerup', commitSeek);

  for (const btn of $('tabs').children) {
    btn.onclick = () => switchView(btn.dataset.view);
  }

  $('search').addEventListener('input', (e) => {
    app.library.q = e.target.value;
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => loadLibrary(true), 300);
  });
  $('sort').addEventListener('change', (e) => {
    app.library.sort = e.target.value;
    loadLibrary(true);
  });
  $('btn-more').onclick = () => {
    app.library.offset += app.library.limit;
    loadLibrary(false);
  };

  $('btn-upload').onclick = () => {
    if (app.role !== 'admin') return toast('الرفع للمدير فقط');
    $('file-input').click();
  };
  $('file-input').addEventListener('change', (e) => {
    uploadFiles([...e.target.files]);
    e.target.value = '';
  });

  $('btn-clear-queue').onclick = () => {
    if (app.role !== 'admin') return toast('للمدير فقط');
    cmd('queue-clear').catch((e) => toast(e.message));
  };

  $('btn-new-playlist').onclick = async () => {
    if (app.role !== 'admin') return toast('للمدير فقط');
    const name = prompt('اسم القائمة الجديدة:');
    if (!name) return;
    await api('/api/playlists', { method: 'POST', body: { name } });
    loadPlaylists();
  };
  $('btn-add-stream').onclick = () => {
    if (app.role !== 'admin') return toast('للمدير فقط');
    addStream();
  };
  $('btn-back-playlists').onclick = closePlaylist;
  $('btn-delete-playlist').onclick = async () => {
    if (!app.currentPlaylist || !confirm(`حذف قائمة "${app.currentPlaylist.name}"؟`)) return;
    await api(`/api/playlists/${app.currentPlaylist.id}`, { method: 'DELETE' });
    closePlaylist();
    loadPlaylists();
  };
  $('btn-play-playlist').onclick = () => {
    if (!app.currentPlaylist) return;
    if (app.role !== 'admin') return toast('للمدير فقط');
    cmd('source', { playlistId: app.currentPlaylist.id, autoplay: true }).then(() => switchView('now'));
  };

  $('sheet-backdrop').addEventListener('click', (e) => {
    if (e.target.id === 'sheet-backdrop') closeSheet();
  });
  for (const btn of $('sheet').querySelectorAll('button')) {
    btn.onclick = () => handleSheetAction(btn.dataset.act);
  }

  // تقدّم محلي سلس — يعمل فقط عند عرض شاشة "الآن"
  setInterval(() => {
    if (app.view !== 'now') return;
    if (!app.state || app.state.status !== 'playing' || app.dragging) return;
    app.localPosition = Math.min(app.state.duration || 0, app.localPosition + 0.5);
    paintProgress();
  }, 500);

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && store.token) {
      refreshState();
      if (!app.ws || app.ws.readyState > 1) connectSocket();
    }
  });
}

// ================================================================ البداية

setupKeypad();
wireEvents();

if (store.token) {
  // نخفي شاشة الرمز فورًا حتى لا تومض قبل التحقق من الجلسة
  $('view-login').hidden = true;
  start();
} else {
  $('view-login').hidden = false;
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
