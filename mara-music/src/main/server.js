'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const os = require('os');
const express = require('express');
const multer = require('multer');
const { WebSocketServer } = require('ws');

const { COVERS_DIR, AUDIO_EXTENSIONS } = require('./config');
const { Scheduler } = require('./scheduler');
const { ALL_TRACKS_ID } = require('./playlists');

const WEB_DIR = path.join(__dirname, '..', 'web');
const PLAYER_DIR = path.join(__dirname, '..', 'renderer');

const MIME_BY_EXT = {
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.wma': 'audio/x-ms-wma'
};

function createServer(ctx) {
  const { player, library, playlists, auth, scheduler, settings, saveSettings, appInfo } = ctx;
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));

  // ------------------------------------------------------------ المصادقة

  function tokenFrom(req) {
    const header = req.get('authorization') || '';
    if (header.startsWith('Bearer ')) return header.slice(7).trim();
    if (req.query && req.query.t) return String(req.query.t);
    return null;
  }

  function attachUser(req, _res, next) {
    req.user = auth.verify(tokenFrom(req));
    next();
  }
  app.use(attachUser);

  function requireAuth(req, res, next) {
    if (!req.user) return res.status(401).json({ error: 'يلزم تسجيل الدخول' });
    next();
  }

  function requireAdmin(req, res, next) {
    if (!req.user) return res.status(401).json({ error: 'يلزم تسجيل الدخول' });
    if (req.user.role !== 'admin' && req.user.role !== 'internal') {
      return res.status(403).json({ error: 'هذه الصلاحية للمدير فقط' });
    }
    next();
  }

  const isLocal = (req) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.ip);

  // ----------------------------------------------------------- الدخول

  app.post('/api/auth/login', (req, res) => {
    const result = auth.login(req.body?.pin, { device: req.body?.device, ip: req.ip });
    if (!result.ok) return res.status(401).json(result);
    res.json({ ok: true, token: result.token, role: result.role });
  });

  app.post('/api/auth/logout', requireAuth, (req, res) => {
    auth.logout(tokenFrom(req));
    res.json({ ok: true });
  });

  app.get('/api/me', requireAuth, (req, res) => {
    res.json({
      role: req.user.role,
      maxVolume: req.user.role === 'admin' ? 1 : Number(settings().maxStaffVolume ?? 0.85),
      canPause: req.user.role === 'admin' || settings().kiosk?.staffCanPause !== false,
      appVersion: appInfo.version
    });
  });

  // ---------------------------------------------------------- التشغيل

  app.get('/api/state', requireAuth, (_req, res) => res.json(player.publicState()));

  // ما يُسمح للموظف به: التحكم البسيط فقط — لا تغيير للقوائم ولا للمكتبة
  const staffAllowed = new Set(['play', 'pause', 'toggle', 'next', 'previous', 'volume', 'mute']);
  const staffPauseGated = new Set(['play', 'pause', 'toggle', 'mute']);

  app.post('/api/player/:action', requireAuth, (req, res) => {
    const action = req.params.action;
    const isAdmin = req.user.role === 'admin' || req.user.role === 'internal';
    if (!isAdmin && !staffAllowed.has(action)) {
      return res.status(403).json({ error: 'هذه الصلاحية للمدير فقط' });
    }
    if (!isAdmin && staffPauseGated.has(action) && settings().kiosk?.staffCanPause === false) {
      return res.status(403).json({ error: 'التحكم بالتشغيل متاح للمدير فقط' });
    }

    switch (action) {
      case 'play':
        player.play();
        break;
      case 'pause':
        player.pause();
        break;
      case 'toggle':
        player.toggle();
        break;
      case 'next':
        player.next({ manual: true });
        break;
      case 'previous':
        player.previous();
        break;
      case 'stop':
        player.stop();
        break;
      case 'seek':
        player.seek(req.body?.sec);
        break;
      case 'volume': {
        const max = isAdmin ? 1 : Number(settings().maxStaffVolume ?? 0.85);
        player.setVolume(Math.min(Number(req.body?.value), max));
        saveSettings();
        break;
      }
      case 'mute':
        player.setMuted(req.body?.muted);
        break;
      case 'shuffle':
        player.setShuffle(req.body?.on);
        saveSettings();
        break;
      case 'repeat':
        player.setRepeat(req.body?.mode);
        saveSettings();
        break;
      case 'source': {
        const ok = player.setSource(String(req.body?.playlistId || ALL_TRACKS_ID), {
          autoplay: req.body?.autoplay !== false,
          startIndex: typeof req.body?.startIndex === 'number' ? req.body.startIndex : null
        });
        if (!ok) return res.status(404).json({ error: 'القائمة غير موجودة' });
        break;
      }
      case 'play-now':
        if (!player.playNow(String(req.body?.trackId))) return res.status(404).json({ error: 'الأغنية غير موجودة' });
        break;
      case 'play-stream': {
        const stream = (settings().streams || []).find((s) => s.id === String(req.body?.streamId));
        if (!stream) return res.status(404).json({ error: 'رابط البث غير موجود' });
        player.playStream(stream);
        break;
      }
      case 'play-next':
        if (!player.enqueueNext(String(req.body?.trackId))) return res.status(404).json({ error: 'الأغنية غير موجودة' });
        break;
      case 'enqueue':
        player.enqueue(req.body?.trackIds || req.body?.trackId);
        break;
      case 'queue-remove':
        player.removeFromQueue(Number(req.body?.index));
        break;
      case 'queue-move':
        player.moveInQueue(Number(req.body?.from), Number(req.body?.to));
        break;
      case 'queue-clear':
        player.clearQueue();
        break;
      case 'resume-now':
        player.clearAutoPause({ resume: true });
        break;
      default:
        return res.status(400).json({ error: 'أمر غير معروف' });
    }
    res.json({ ok: true, state: player.publicState() });
  });

  // ---------------------------------------------------------- المكتبة

  app.get('/api/library', requireAuth, (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 200, 1000);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const result = library.search(String(req.query.q || ''), {
      limit,
      offset,
      sort: String(req.query.sort || 'title')
    });
    res.json({
      total: result.total,
      offset,
      limit,
      items: result.items.map((t) => ({
        id: t.id,
        title: t.title,
        artist: t.artist,
        album: t.album,
        duration: t.duration,
        cover: t.cover ? `/api/cover/${t.id}` : null,
        playCount: t.playCount || 0,
        addedAt: t.addedAt
      }))
    });
  });

  app.post('/api/library/scan', requireAdmin, async (_req, res) => {
    const result = await library.scan({ full: false });
    res.json({ ok: true, ...result });
  });

  app.post('/api/library/rescan-full', requireAdmin, async (_req, res) => {
    const result = await library.scan({ full: true });
    res.json({ ok: true, ...result });
  });

  app.delete('/api/library/:id', requireAdmin, async (req, res) => {
    const ok = await library.deleteTrack(req.params.id);
    if (!ok) return res.status(404).json({ error: 'الأغنية غير موجودة' });
    res.json({ ok: true });
  });

  app.get('/api/cover/:id', (req, res) => {
    const track = library.get(req.params.id);
    if (!track || !track.cover) return res.status(404).end();
    const file = path.join(COVERS_DIR, track.cover);
    res.setHeader('Cache-Control', 'public, max-age=604800');
    res.sendFile(file, (err) => {
      if (err && !res.headersSent) res.status(404).end();
    });
  });

  // بثّ الملف الصوتي مع دعم Range (ضروري للتقديم والتأخير)
  app.get('/api/stream/:id', requireAuth, (req, res) => {
    const track = library.get(req.params.id);
    if (!track) return res.status(404).json({ error: 'الأغنية غير موجودة' });
    let stat;
    try {
      stat = fs.statSync(track.path);
    } catch (err) {
      return res.status(404).json({ error: 'الملف غير موجود على القرص' });
    }

    const mime = MIME_BY_EXT[path.extname(track.path).toLowerCase()] || 'application/octet-stream';
    const range = req.headers.range;
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Type', mime);
    res.setHeader('Cache-Control', 'no-store');

    if (range) {
      const match = /bytes=(\d*)-(\d*)/.exec(range);
      let start = match && match[1] ? parseInt(match[1], 10) : 0;
      let end = match && match[2] ? parseInt(match[2], 10) : stat.size - 1;
      if (Number.isNaN(start) || start < 0) start = 0;
      if (Number.isNaN(end) || end >= stat.size) end = stat.size - 1;
      if (start > end) {
        res.status(416).setHeader('Content-Range', `bytes */${stat.size}`);
        return res.end();
      }
      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
      res.setHeader('Content-Length', end - start + 1);
      return fs.createReadStream(track.path, { start, end }).pipe(res);
    }

    res.setHeader('Content-Length', stat.size);
    return fs.createReadStream(track.path).pipe(res);
  });

  // ---------------------------------------------------------- القوائم

  app.get('/api/playlists', requireAuth, (_req, res) => res.json({ items: playlists.list() }));

  app.get('/api/playlists/:id', requireAuth, (req, res) => {
    const pl = playlists.get(req.params.id);
    if (!pl) return res.status(404).json({ error: 'القائمة غير موجودة' });
    const ids = playlists.trackIdsOf(pl.id);
    res.json({
      id: pl.id,
      name: pl.name,
      builtin: !!pl.builtin,
      tracks: ids.map((id) => library.get(id)).filter(Boolean).map((t) => ({
        id: t.id,
        title: t.title,
        artist: t.artist,
        duration: t.duration,
        cover: t.cover ? `/api/cover/${t.id}` : null
      }))
    });
  });

  app.post('/api/playlists', requireAdmin, (req, res) => {
    const pl = playlists.create(req.body?.name);
    broadcast({ type: 'playlists' });
    res.json(pl);
  });

  app.patch('/api/playlists/:id', requireAdmin, (req, res) => {
    let pl = null;
    if (typeof req.body?.name === 'string') pl = playlists.rename(req.params.id, req.body.name);
    if (Array.isArray(req.body?.trackIds)) pl = playlists.setTracks(req.params.id, req.body.trackIds);
    if (!pl) return res.status(404).json({ error: 'القائمة غير موجودة' });
    if (player.state.sourceId === pl.id) player.refreshOrder({ keepCurrent: true });
    broadcast({ type: 'playlists' });
    res.json(pl);
  });

  app.delete('/api/playlists/:id', requireAdmin, (req, res) => {
    if (!playlists.remove(req.params.id)) return res.status(404).json({ error: 'القائمة غير موجودة' });
    if (player.state.sourceId === req.params.id) player.setSource(ALL_TRACKS_ID, { autoplay: false });
    broadcast({ type: 'playlists' });
    res.json({ ok: true });
  });

  app.post('/api/playlists/:id/tracks', requireAdmin, (req, res) => {
    const ids = Array.isArray(req.body?.trackIds) ? req.body.trackIds : [req.body?.trackId].filter(Boolean);
    const pl = playlists.addTracks(req.params.id, ids);
    if (!pl) return res.status(404).json({ error: 'القائمة غير موجودة' });
    if (player.state.sourceId === pl.id) player.refreshOrder({ keepCurrent: true });
    broadcast({ type: 'playlists' });
    res.json({ ok: true, count: pl.trackIds.length });
  });

  app.delete('/api/playlists/:id/tracks/:trackId', requireAdmin, (req, res) => {
    const pl = playlists.removeTrack(req.params.id, req.params.trackId);
    if (!pl) return res.status(404).json({ error: 'القائمة غير موجودة' });
    if (player.state.sourceId === pl.id) player.refreshOrder({ keepCurrent: true });
    broadcast({ type: 'playlists' });
    res.json({ ok: true });
  });

  app.post('/api/playlists/:id/reorder', requireAdmin, (req, res) => {
    const pl = playlists.reorder(req.params.id, Number(req.body?.from), Number(req.body?.to));
    if (!pl) return res.status(404).json({ error: 'القائمة غير موجودة' });
    if (player.state.sourceId === pl.id) player.refreshOrder({ keepCurrent: true });
    broadcast({ type: 'playlists' });
    res.json({ ok: true });
  });

  // ------------------------------------------------- الرفع من الجوال

  const upload = multer({
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => {
        const dir = path.join(settings().musicDir, 'Uploads');
        fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
      },
      filename: (_req, file, cb) => {
        const original = Buffer.from(file.originalname, 'latin1').toString('utf8');
        cb(null, uniqueName(path.join(settings().musicDir, 'Uploads'), sanitize(original)));
      }
    }),
    limits: { fileSize: 80 * 1024 * 1024, files: 25 },
    fileFilter: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, AUDIO_EXTENSIONS.has(ext));
    }
  });

  app.post('/api/upload', requireAdmin, upload.array('files', 25), async (req, res) => {
    const files = req.files || [];
    if (!files.length) return res.status(400).json({ error: 'لم يتم رفع أي ملف صوتي صالح' });
    const before = new Set(library.tracks.keys());
    await library.scan({ full: false });
    const added = library.list().filter((t) => !before.has(t.id));
    broadcast({ type: 'library' });
    res.json({
      ok: true,
      uploaded: files.length,
      added: added.map((t) => ({ id: t.id, title: t.title, artist: t.artist, duration: t.duration }))
    });
  });

  // ------------------------------------------------------- البث المباشر

  app.get('/api/streams', requireAuth, (_req, res) => res.json({ items: settings().streams || [] }));

  app.post('/api/streams', requireAdmin, (req, res) => {
    const name = String(req.body?.name || '').trim().slice(0, 60);
    const url = String(req.body?.url || '').trim();
    if (!name) return res.status(400).json({ error: 'اكتب اسمًا للمحطة' });
    let parsed;
    try {
      parsed = new URL(url);
    } catch (err) {
      return res.status(400).json({ error: 'الرابط غير صالح' });
    }
    // روابط الويب فقط — لا مسارات ملفات محلية ولا بروتوكولات أخرى
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return res.status(400).json({ error: 'يجب أن يبدأ الرابط بـ http أو https' });
    }
    const s = settings();
    const stream = { id: crypto.randomBytes(5).toString('hex'), name, url: parsed.toString(), addedAt: Date.now() };
    s.streams = [...(s.streams || []), stream];
    saveSettings();
    broadcast({ type: 'streams' });
    res.json(stream);
  });

  app.delete('/api/streams/:id', requireAdmin, (req, res) => {
    const s = settings();
    const before = (s.streams || []).length;
    s.streams = (s.streams || []).filter((item) => item.id !== req.params.id);
    if (s.streams.length === before) return res.status(404).json({ error: 'رابط البث غير موجود' });
    saveSettings();
    broadcast({ type: 'streams' });
    res.json({ ok: true });
  });

  // ------------------------------------------------------------ الإعدادات

  app.get('/api/settings', requireAdmin, (_req, res) => {
    const s = settings();
    res.json({
      ...s,
      adminPin: undefined,
      staffPin: s.staffPin,
      hasAdminPin: !!s.adminPin
    });
  });

  app.patch('/api/settings', requireAdmin, async (req, res) => {
    const patch = req.body || {};
    const s = settings();
    const oldMusicDir = s.musicDir;

    if (typeof patch.musicDir === 'string' && patch.musicDir.trim()) s.musicDir = patch.musicDir.trim();
    if (typeof patch.crossfadeSec === 'number') s.crossfadeSec = Math.max(0, Math.min(12, patch.crossfadeSec));
    if (typeof patch.maxStaffVolume === 'number') s.maxStaffVolume = Math.max(0.1, Math.min(1, patch.maxStaffVolume));
    if (typeof patch.adminPin === 'string' && /^\d{4,10}$/.test(patch.adminPin)) s.adminPin = patch.adminPin;
    if (typeof patch.staffPin === 'string' && /^\d{4,10}$/.test(patch.staffPin)) s.staffPin = patch.staffPin;
    if (typeof patch.autoStart === 'boolean') s.autoStart = patch.autoStart;
    if (patch.kiosk && typeof patch.kiosk === 'object') s.kiosk = { ...s.kiosk, ...patch.kiosk };
    if (patch.prayer && typeof patch.prayer === 'object') {
      s.prayer = {
        ...s.prayer,
        ...patch.prayer,
        durations: { ...s.prayer.durations, ...(patch.prayer.durations || {}) },
        offsetsMin: { ...s.prayer.offsetsMin, ...(patch.prayer.offsetsMin || {}) },
        enabledPrayers: { ...s.prayer.enabledPrayers, ...(patch.prayer.enabledPrayers || {}) }
      };
    }

    saveSettings();
    ctx.onSettingsApplied?.(patch);

    if (s.musicDir !== oldMusicDir) {
      await library.setMusicDir(s.musicDir);
      player.refreshOrder({ keepCurrent: true });
      broadcast({ type: 'library' });
    }
    player.command('volume', { value: player.effectiveVolume(), fadeMs: 200 });
    broadcast({ type: 'settings' });
    res.json({ ok: true });
  });

  app.get('/api/prayer', requireAuth, (_req, res) => res.json(scheduler.prayerSummary()));

  app.get('/api/schedules', requireAdmin, (_req, res) => res.json({ items: settings().schedules || [] }));

  app.post('/api/schedules', requireAdmin, (req, res) => {
    const s = settings();
    const rule = Scheduler.normalizeRule(req.body || {});
    s.schedules = [...(s.schedules || []), rule];
    saveSettings();
    broadcast({ type: 'settings' });
    res.json(rule);
  });

  app.patch('/api/schedules/:id', requireAdmin, (req, res) => {
    const s = settings();
    const idx = (s.schedules || []).findIndex((r) => r.id === req.params.id);
    if (idx < 0) return res.status(404).json({ error: 'القاعدة غير موجودة' });
    s.schedules[idx] = Scheduler.normalizeRule({ ...s.schedules[idx], ...req.body, id: req.params.id });
    saveSettings();
    broadcast({ type: 'settings' });
    res.json(s.schedules[idx]);
  });

  app.delete('/api/schedules/:id', requireAdmin, (req, res) => {
    const s = settings();
    const before = (s.schedules || []).length;
    s.schedules = (s.schedules || []).filter((r) => r.id !== req.params.id);
    if (s.schedules.length === before) return res.status(404).json({ error: 'القاعدة غير موجودة' });
    saveSettings();
    broadcast({ type: 'settings' });
    res.json({ ok: true });
  });

  // ------------------------------------------------------------ النظام

  app.get('/api/system', requireAdmin, (_req, res) => {
    res.json({
      version: appInfo.version,
      hostname: os.hostname(),
      addresses: lanAddresses(),
      port: settings().port,
      musicDir: settings().musicDir,
      libraryCount: library.tracks.size,
      uptimeSec: Math.round(process.uptime()),
      scanning: library.scanning,
      lastScanAt: library.lastScanAt,
      devices: auth.devices()
    });
  });

  app.post('/api/system/revoke-devices', requireAdmin, (req, res) => {
    auth.revokeAll({ keepToken: tokenFrom(req) });
    broadcast({ type: 'revoked' });
    res.json({ ok: true });
  });

  // ------------------------------------------------------- الملفات الثابتة

  // صفحة المشغّل الداخلية — لا تُقدَّم إلا لجهاز الويندوز نفسه
  app.use('/player', (req, res, next) => {
    if (!isLocal(req)) return res.status(403).end();
    next();
  }, express.static(PLAYER_DIR));

  // بدون تخزين طويل: تحديث البرنامج يجب أن يصل للأجهزة فورًا (ETag يمنع النقل المكرر)
  app.use(express.static(WEB_DIR, { index: 'index.html', maxAge: 0 }));
  app.get('*', (req, res) => {
    if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'غير موجود' });
    res.sendFile(path.join(WEB_DIR, 'index.html'));
  });

  app.use((err, _req, res, _next) => {
    console.error('[server]', err);
    if (res.headersSent) return;
    res.status(500).json({ error: err.message || 'خطأ في الخادم' });
  });

  // ----------------------------------------------------------- WebSocket

  const httpServer = http.createServer(app);
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });
  const clients = new Set();

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'http://localhost');
    const user = auth.verify(url.searchParams.get('t'));
    if (!user) {
      ws.close(4001, 'unauthorized');
      return;
    }
    ws.role = user.role;
    ws.isAlive = true;
    clients.add(ws);
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('close', () => clients.delete(ws));
    ws.on('error', () => clients.delete(ws));
    ws.send(JSON.stringify({ type: 'state', data: player.publicState() }));
    ws.send(JSON.stringify({ type: 'prayer', data: scheduler.prayerSummary() }));
  });

  const heartbeat = setInterval(() => {
    for (const ws of clients) {
      if (!ws.isAlive) {
        ws.terminate();
        clients.delete(ws);
        continue;
      }
      ws.isAlive = false;
      try { ws.ping(); } catch (_) { /* تجاهل */ }
    }
  }, 30000);
  if (heartbeat.unref) heartbeat.unref();

  function broadcast(message) {
    const payload = JSON.stringify(message);
    for (const ws of clients) {
      if (ws.readyState === 1) {
        try { ws.send(payload); } catch (_) { /* تجاهل */ }
      }
    }
  }

  player.on('state', (state) => broadcast({ type: 'state', data: state }));
  player.on('tick', (tick) => broadcast({ type: 'tick', data: tick }));
  library.on('changed', () => broadcast({ type: 'library' }));
  player.on('auto-pause', () => broadcast({ type: 'prayer', data: scheduler.prayerSummary() }));

  const prayerBroadcast = setInterval(() => broadcast({ type: 'prayer', data: scheduler.prayerSummary() }), 60000);
  if (prayerBroadcast.unref) prayerBroadcast.unref();

  return { app, httpServer, broadcast, clients };
}

function sanitize(name) {
  return String(name)
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || `track-${Date.now()}.mp3`;
}

function uniqueName(dir, name) {
  const ext = path.extname(name);
  const base = path.basename(name, ext);
  let candidate = name;
  let i = 1;
  while (fs.existsSync(path.join(dir, candidate))) {
    candidate = `${base} (${i})${ext}`;
    i += 1;
  }
  return candidate;
}

function lanAddresses() {
  const out = [];
  const nets = os.networkInterfaces();
  for (const [name, addrs] of Object.entries(nets)) {
    for (const addr of addrs || []) {
      if (addr.family === 'IPv4' && !addr.internal) out.push({ name, address: addr.address });
    }
  }
  return out;
}

module.exports = { createServer, lanAddresses };
