'use strict';

/**
 * اختبار تشغيلي شامل بدون Electron: يشغّل الخادم الحقيقي ومحرّك الحالة،
 * ويستبدل نافذة الصوت بمشغّل وهمي يحاكي انتهاء الأغاني.
 *
 * التشغيل:  node tools/smoke-test.js
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const Module = require('module');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mara-test-'));
const MUSIC_DIR = process.argv[2] || path.join(TMP, 'music');

// --- استبدال وحدة electron قبل تحميل أي ملف من المشروع
const fakeElectron = {
  app: {
    getPath: (name) => {
      const dir = path.join(TMP, name);
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    },
    getVersion: () => '1.0.0-test'
  }
};
const originalLoad = Module._load;
Module._load = function patched(request, parent, isMain) {
  if (request === 'electron') return fakeElectron;
  return originalLoad.call(this, request, parent, isMain);
};

const { ensureDirs, DEFAULT_SETTINGS } = require('../src/main/config');
const { deepMerge } = require('../src/main/store');
const { Library } = require('../src/main/library');
const { Playlists, ALL_TRACKS_ID } = require('../src/main/playlists');
const { Player } = require('../src/main/player');
const { Scheduler } = require('../src/main/scheduler');
const { Auth } = require('../src/main/auth');
const { createServer } = require('../src/main/server');
const { prayerTimes, formatMinutes } = require('../src/main/prayer');

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  ✅ ${name}`);
  } else {
    failed += 1;
    failures.push(name);
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function section(title) {
  console.log(`\n▶ ${title}`);
}

async function main() {
  ensureDirs();
  if (!fs.existsSync(MUSIC_DIR)) {
    fs.mkdirSync(MUSIC_DIR, { recursive: true });
    require('child_process').execFileSync(process.execPath, [path.join(__dirname, 'make-test-audio.js'), MUSIC_DIR, '6']);
  }

  const settings = deepMerge(DEFAULT_SETTINGS, {
    musicDir: MUSIC_DIR,
    adminPin: '123456',
    staffPin: '1111',
    port: 0,
    crossfadeSec: 2
  });

  const library = new Library();
  library.load(MUSIC_DIR);
  const playlists = new Playlists(library);
  playlists.load();
  const auth = new Auth(() => settings);
  const player = new Player({ library, playlists, settings });
  const scheduler = new Scheduler({ player, playlists, getSettings: () => settings });

  const server = createServer({
    player,
    library,
    playlists,
    auth,
    scheduler,
    settings: () => settings,
    saveSettings: () => {},
    appInfo: { version: '1.0.0-test' }
  });

  await new Promise((resolve) => server.httpServer.listen(0, '127.0.0.1', resolve));
  const port = server.httpServer.address().port;
  const base = `http://127.0.0.1:${port}`;

  // --- مشغّل وهمي: يسجّل الأوامر ويحاكي التشغيل الفعلي
  const commands = [];
  const fake = { playing: false, id: null, preloaded: null };
  player.attachRenderer(
    (command) => {
      commands.push(command);
      if (command.type === 'load') {
        fake.id = command.id;
        fake.playing = !!command.autoplay;
      } else if (command.type === 'preload') {
        fake.preloaded = command.id;
      } else if (command.type === 'play') {
        fake.playing = true;
      } else if (command.type === 'pause' || command.type === 'stop') {
        fake.playing = false;
      }
    },
    { streamBase: `${base}/api/stream/`, streamSuffix: `?t=${auth.internalToken}` }
  );

  /** يحاكي انتهاء الأغنية الحالية طبيعيًا. */
  function simulateEnd() {
    player.onRendererEvent({ type: 'ended', id: player.state.currentId });
  }

  let token = null;
  const call = async (pathname, { method = 'GET', body, headers = {}, tokenOverride } = {}) => {
    const res = await fetch(base + pathname, {
      method,
      headers: {
        Authorization: `Bearer ${tokenOverride !== undefined ? tokenOverride : token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...headers
      },
      body: body ? JSON.stringify(body) : undefined
    });
    let data = null;
    const type = res.headers.get('content-type') || '';
    if (type.includes('application/json')) data = await res.json();
    return { status: res.status, data, res };
  };

  // ==================================================== 1) المكتبة

  section('المكتبة');
  const scan = await library.scan({ full: true });
  check('فحص المكتبة يجد الملفات', scan.total === 6, `العدد: ${scan.total}`);
  const tracks = library.list();
  check('يقرأ المدة من ملف MP3', tracks.every((t) => t.duration > 0), JSON.stringify(tracks.map((t) => t.duration)));
  check('العنوان يُشتق من اسم الملف العربي', tracks.some((t) => t.title.includes('أغنية تجريبية')));
  const searchAr = library.search('تجريبيه'); // بحث بلا تشكيل وبهاء بدل التاء المربوطة
  check('البحث العربي يتجاهل الفروق الإملائية', searchAr.total === 6, `النتائج: ${searchAr.total}`);
  check('البحث عن نص غير موجود يعيد صفرًا', library.search('زززز').total === 0);

  // الفهرسة: الفرز العربي مكلف، فيجب أن يُحسب مرة واحدة ويُعاد استخدامه
  const idsFirst = library.sortedIds('title');
  check('الفهرس المفروز يُخزَّن ولا يُعاد حسابه', library.sortedIds('title') === idsFirst);
  check('قائمة "كل الأغاني" تستخدم الفهرس نفسه', playlists.trackIdsOf(ALL_TRACKS_ID) === idsFirst);
  check('البحث لا يفسد الفهرس المخزَّن', library.search('تجريبية').items.length === 6 && library.sortedIds('title') === idsFirst);
  await library.scan({ full: false });
  check('الفهرس يُبطَل عند تغيّر المكتبة', library.sortedIds('title') !== idsFirst);
  check('الفهرس الجديد يحمل نفس العدد', library.sortedIds('title').length === 6);

  // ==================================================== 2) الدخول

  section('الدخول والصلاحيات');
  const badLogin = await call('/api/auth/login', { method: 'POST', body: { pin: '000000' }, tokenOverride: '' });
  check('رفض الرمز الخاطئ', badLogin.status === 401);

  const adminLogin = await call('/api/auth/login', { method: 'POST', body: { pin: '123456', device: 'اختبار' }, tokenOverride: '' });
  check('قبول رمز المدير', adminLogin.status === 200 && adminLogin.data.role === 'admin');
  token = adminLogin.data.token;

  const staffLogin = await call('/api/auth/login', { method: 'POST', body: { pin: '1111' }, tokenOverride: '' });
  check('قبول رمز الموظف', staffLogin.status === 200 && staffLogin.data.role === 'staff');
  const staffToken = staffLogin.data.token;

  const noToken = await call('/api/state', { tokenOverride: '' });
  check('منع الوصول بدون رمز', noToken.status === 401);

  const staffSettings = await call('/api/settings', { tokenOverride: staffToken });
  check('منع الموظف من الإعدادات', staffSettings.status === 403);

  const staffPlayNow = await call('/api/player/play-now', { method: 'POST', body: { trackId: tracks[0].id }, tokenOverride: staffToken });
  check('منع الموظف من اختيار أغنية محدّدة', staffPlayNow.status === 403);

  const staffPause = await call('/api/player/toggle', { method: 'POST', tokenOverride: staffToken });
  check('السماح للموظف بالإيقاف/التشغيل', staffPause.status === 200);
  player.pause();

  // ==================================================== 3) التشغيل

  section('التشغيل والانتقال بين الأغاني');
  player.setSource(ALL_TRACKS_ID, { autoplay: false });
  const first = await call('/api/player/play-now', { method: 'POST', body: { trackId: tracks[0].id } });
  check('تشغيل أغنية محدّدة', first.status === 200 && player.state.currentId === tracks[0].id);
  check('أُرسل أمر التحميل للمشغّل', commands.some((c) => c.type === 'load' && c.id === tracks[0].id));
  check('رابط البث يحمل الرمز الداخلي', commands.find((c) => c.type === 'load').url.includes('?t='));
  check('جُهّزت الأغنية التالية مسبقًا', !!fake.preloaded && fake.preloaded !== tracks[0].id);

  const beforeNext = player.state.currentId;
  simulateEnd();
  check('الانتقال التلقائي عند انتهاء الأغنية', player.state.currentId !== beforeNext);
  check('الحالة تبقى "يعمل" بعد الانتقال', player.state.status === 'playing');

  await call('/api/player/pause', { method: 'POST' });
  check('الإيقاف المؤقت', player.state.status === 'paused');
  await call('/api/player/play', { method: 'POST' });
  check('استئناف التشغيل', player.state.status === 'playing');

  await call('/api/player/volume', { method: 'POST', body: { value: 0.35 } });
  check('ضبط الصوت', Math.abs(player.state.volume - 0.35) < 0.001);

  const staffVolume = await call('/api/player/volume', { method: 'POST', body: { value: 1 }, tokenOverride: staffToken });
  check(
    'سقف الصوت للموظف مطبَّق',
    staffVolume.status === 200 && Math.abs(player.state.volume - settings.maxStaffVolume) < 0.001,
    `الحالة: ${staffVolume.status} القيمة: ${player.state.volume}`
  );
  player.setVolume(0.6);

  // ==================================================== 4) قائمة التالي

  section('قائمة "التالي"');
  await call('/api/player/queue-clear', { method: 'POST' });
  const target = tracks[4];
  await call('/api/player/play-next', { method: 'POST', body: { trackId: target.id } });
  check('إضافة أغنية لتشتغل بعد الحالية', player.state.queue[0] === target.id);
  check('التحميل المسبق يتبع قائمة التالي', fake.preloaded === target.id);

  simulateEnd();
  check('الأغنية المضافة تشتغل بعد الحالية', player.state.currentId === target.id, player.state.currentId);
  check('أُزيلت من قائمة التالي بعد تشغيلها', !player.state.queue.includes(target.id));

  await call('/api/player/enqueue', { method: 'POST', body: { trackIds: [tracks[0].id, tracks[1].id] } });
  check('إضافة عدة أغانٍ لآخر القائمة', player.state.queue.length === 2);
  await call('/api/player/queue-move', { method: 'POST', body: { from: 0, to: 1 } });
  check('إعادة ترتيب قائمة التالي', player.state.queue[0] === tracks[1].id);
  await call('/api/player/queue-remove', { method: 'POST', body: { index: 0 } });
  check('حذف عنصر من قائمة التالي', player.state.queue.length === 1);
  await call('/api/player/queue-clear', { method: 'POST' });
  check('تفريغ قائمة التالي', player.state.queue.length === 0);

  // ==================================================== 5) القوائم

  section('قوائم التشغيل');
  const created = await call('/api/playlists', { method: 'POST', body: { name: 'هدوء الصباح' } });
  check('إنشاء قائمة', created.status === 200 && created.data.id);
  const plId = created.data.id;

  await call(`/api/playlists/${plId}/tracks`, { method: 'POST', body: { trackIds: [tracks[0].id, tracks[1].id, tracks[2].id] } });
  const detail = await call(`/api/playlists/${plId}`);
  check('إضافة أغانٍ للقائمة', detail.data.tracks.length === 3);

  await call(`/api/playlists/${plId}/reorder`, { method: 'POST', body: { from: 0, to: 2 } });
  const reordered = await call(`/api/playlists/${plId}`);
  check('إعادة ترتيب القائمة', reordered.data.tracks[2].id === tracks[0].id);

  const switched = await call('/api/player/source', { method: 'POST', body: { playlistId: plId, autoplay: true } });
  check('التبديل إلى القائمة يشغّل منها', switched.status === 200 && detail.data.tracks.some((t) => t.id === player.state.currentId));
  check('اسم المصدر يظهر في الحالة', player.publicState().source.name === 'هدوء الصباح');

  await call(`/api/playlists/${plId}/tracks/${tracks[1].id}`, { method: 'DELETE' });
  const afterRemove = await call(`/api/playlists/${plId}`);
  check('حذف أغنية من القائمة', afterRemove.data.tracks.length === 2);

  const listed = await call('/api/playlists');
  check('قائمة "كل الأغاني" مدمجة', listed.data.items[0].id === ALL_TRACKS_ID && listed.data.items[0].count === 6);

  // ==================================================== 6) البث

  section('بثّ الملفات الصوتية');
  const streamPath = `/api/stream/${tracks[0].id}?t=${auth.internalToken}`;
  const full = await fetch(base + streamPath);
  check('تحميل الملف كاملًا', full.status === 200 && Number(full.headers.get('content-length')) > 1000);
  check('نوع المحتوى صحيح', full.headers.get('content-type') === 'audio/mpeg');
  const partial = await fetch(base + streamPath, { headers: { Range: 'bytes=100-199' } });
  check('دعم الطلب الجزئي (Range) للتقديم', partial.status === 206 && Number(partial.headers.get('content-length')) === 100);
  const unauth = await fetch(`${base}/api/stream/${tracks[0].id}`);
  check('منع البث بدون رمز', unauth.status === 401);

  // ==================================================== 6ب) الرفع من الجوال

  section('الرفع من الجوال');
  const uploadForm = new FormData();
  const sample = fs.readFileSync(library.get(tracks[0].id).path);
  uploadForm.append('files', new Blob([sample], { type: 'audio/mpeg' }), 'أغنية مرفوعة من الجوال.mp3');
  uploadForm.append('files', new Blob([Buffer.from('نص')], { type: 'text/plain' }), 'ملف-ممنوع.txt');
  const uploadRes = await fetch(`${base}/api/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: uploadForm
  });
  const uploadData = await uploadRes.json();
  check('رفع ملف صوتي من الجوال', uploadRes.status === 200 && uploadData.uploaded === 1, JSON.stringify(uploadData));
  check('رفض الملفات غير الصوتية', uploadData.uploaded === 1);
  check('الأغنية المرفوعة تدخل المكتبة', uploadData.added.length === 1 && library.tracks.size === 7);
  check('الملف حُفظ في مجلد Uploads', fs.existsSync(path.join(MUSIC_DIR, 'Uploads')));

  const staffUpload = await fetch(`${base}/api/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${staffToken}` },
    body: (() => {
      const f = new FormData();
      f.append('files', new Blob([sample], { type: 'audio/mpeg' }), 'x.mp3');
      return f;
    })()
  });
  check('منع الموظف من الرفع', staffUpload.status === 403);

  // ==================================================== 6ج) البثّ اللحظي

  section('التحديث اللحظي (WebSocket)');
  const { WebSocket } = require('ws');
  const messages = [];
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?t=${token}`);
  ws.on('message', (raw) => {
    try { messages.push(JSON.parse(raw.toString())); } catch (_) { /* تجاهل */ }
  });
  await new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
    setTimeout(() => reject(new Error('انتهت المهلة')), 3000);
  });
  await new Promise((r) => setTimeout(r, 200));
  check('إرسال الحالة فور الاتصال', messages.some((m) => m.type === 'state'));

  const countBefore = messages.filter((m) => m.type === 'state').length;
  player.setVolume(0.44);
  await new Promise((r) => setTimeout(r, 200));
  check('بثّ التغييرات لحظيًا لكل الأجهزة', messages.filter((m) => m.type === 'state').length > countBefore);
  check('الحالة المبثوثة تحمل القيمة الجديدة', messages.filter((m) => m.type === 'state').pop().data.volume === 0.44);

  // تحديث الموضع كل ثانية يجب أن يكون رسالة خفيفة، لا حالة كاملة
  const fullStatesBefore = messages.filter((m) => m.type === 'state').length;
  player.onRendererEvent({ type: 'status', id: player.state.currentId, status: 'playing', position: 12.5, duration: 200 });
  await new Promise((r) => setTimeout(r, 200));
  const tick = messages.filter((m) => m.type === 'tick').pop();
  check('تحديث الموضع يُرسل كرسالة خفيفة', !!tick && tick.data.position === 12.5);
  check('التحديث الخفيف لا يعيد إرسال الحالة الكاملة', messages.filter((m) => m.type === 'state').length === fullStatesBefore);
  check('الرسالة الخفيفة لا تحمل القوائم', !!tick && tick.data.queue === undefined && tick.data.upNext === undefined);
  ws.close();

  const badWs = new WebSocket(`ws://127.0.0.1:${port}/ws?t=رمز-خاطئ`);
  const closeCode = await new Promise((resolve) => {
    badWs.on('close', (code) => resolve(code));
    badWs.on('error', () => resolve(-1));
    setTimeout(() => resolve(0), 2000);
  });
  check('رفض الاتصال اللحظي بدون رمز صحيح', closeCode === 4001, `الرمز: ${closeCode}`);
  player.setVolume(0.6);

  // ==================================================== 6د) البث المباشر

  section('البث المباشر');
  const badUrl = await call('/api/streams', { method: 'POST', body: { name: 'خطر', url: 'file:///C:/Windows/System32' } });
  check('رفض الروابط غير http/https', badUrl.status === 400);
  const noName = await call('/api/streams', { method: 'POST', body: { name: '', url: 'http://example.com/s' } });
  check('رفض محطة بلا اسم', noName.status === 400);

  const newStream = await call('/api/streams', { method: 'POST', body: { name: 'إذاعة الصباح', url: 'http://example.com/stream.mp3' } });
  check('إضافة محطة بث', newStream.status === 200 && !!newStream.data.id);
  const streamId = newStream.data.id;

  const staffStream = await call('/api/streams', { method: 'POST', body: { name: 'x', url: 'http://a.b/c' }, tokenOverride: staffToken });
  check('منع الموظف من إضافة محطات', staffStream.status === 403);

  const playStream = await call('/api/player/play-stream', { method: 'POST', body: { streamId } });
  check('تشغيل البث المباشر', playStream.status === 200 && player.state.stream && player.state.stream.id === streamId);
  check('رابط البث يُرسل للمشغّل كما هو', commands.filter((c) => c.type === 'load').pop().url === 'http://example.com/stream.mp3');
  check('لا تحميل مسبق ولا مزج أثناء البث', commands.filter((c) => c.type === 'preload').pop().id === null);
  const liveState = player.publicState();
  check('الحالة تعرض البث كأنه أغنية', liveState.track.live === true && liveState.track.title === 'إذاعة الصباح');
  check('مدة البث صفر (غير محدودة)', liveState.duration === 0);

  // الصلاة أثناء البث: إيقاف ثم إعادة اتصال — لا استئناف لبثّ قديم
  player.setAutoPause({ reason: 'prayer', key: 'asr', label: 'وقت صلاة العصر', mode: 'pause', until: '16:20' });
  check('البث يتوقف وقت الصلاة', player.state.status === 'paused');
  const loadsBeforeResume = commands.filter((c) => c.type === 'load').length;
  player.clearAutoPause({ resume: true });
  check('بعد الصلاة يُعاد الاتصال بالبث لا استئناف المخزَّن', commands.filter((c) => c.type === 'load').length === loadsBeforeResume + 1);

  // انقطاع الشبكة: إعادة محاولة، ثم عودة للمكتبة المحلية
  for (let i = 0; i < 6; i += 1) {
    player.onRendererEvent({ type: 'error', id: player.state.currentId, message: 'انقطاع' });
  }
  check('العودة للمكتبة المحلية بعد فشل البث المتكرر', !player.state.stream && library.tracks.has(player.state.currentId));

  await call('/api/player/play-stream', { method: 'POST', body: { streamId } });
  await call('/api/player/next', { method: 'POST' });
  check('"التالي" يخرج من البث إلى المكتبة', !player.state.stream && library.tracks.has(player.state.currentId));

  // استعادة البث بعد إعادة تشغيل الجهاز
  await call('/api/player/play-stream', { method: 'POST', body: { streamId } });
  player.saveState();
  player.flush();
  const afterReboot = new Player({ library, playlists, settings });
  afterReboot.restore();
  check('استعادة البث بعد إعادة تشغيل الجهاز', !!afterReboot.state.stream && afterReboot.state.stream.id === streamId);
  player.leaveStream();
  player.playNow(tracks[0].id);

  const delStream = await call(`/api/streams/${streamId}`, { method: 'DELETE' });
  check('حذف محطة البث', delStream.status === 200 && (settings.streams || []).length === 0);

  // ==================================================== 7) أوقات الصلاة

  section('أوقات الصلاة');
  const riyadh = { lat: 24.7136, lng: 46.6753, tz: 3, fajrAngle: 18.5, ishaOffsetMin: 90, asrFactor: 1 };
  const june = prayerTimes(new Date('2026-06-15T12:00:00Z'), riyadh);
  const december = prayerTimes(new Date('2026-12-15T12:00:00Z'), riyadh);
  check('ترتيب أوقات الصلاة منطقي', june.fajr < june.sunrise && june.sunrise < june.dhuhr && june.dhuhr < june.asr && june.asr < june.maghrib && june.maghrib < june.isha);
  check('ظهر الرياض قرب 11:50-12:30', june.dhuhr > 700 && june.dhuhr < 760, formatMinutes(june.dhuhr));
  check('مغرب الرياض صيفًا قرب 19:00', Math.abs(june.maghrib - 19 * 60) < 25, formatMinutes(june.maghrib));
  check('مغرب الرياض شتاءً قرب 17:15', Math.abs(december.maghrib - (17 * 60 + 15)) < 25, formatMinutes(december.maghrib));
  check('العشاء بعد المغرب بـ 90 دقيقة', june.isha - june.maghrib === 90);

  const summary = scheduler.prayerSummary();
  check('ملخّص الصلاة يعمل', summary.prayers.length === 5 && !!summary.next);

  // ==================================================== 8) الإيقاف التلقائي

  section('الإيقاف التلقائي وقت الصلاة');
  player.play();
  const wasPlaying = player.state.status === 'playing';
  player.setAutoPause({ reason: 'prayer', key: 'asr', label: 'وقت صلاة العصر', mode: 'pause', until: '16:20' });
  check('الموسيقى تتوقف عند الصلاة', wasPlaying && player.state.status === 'paused');
  check('سبب الإيقاف ظاهر في الحالة', player.publicState().autoPause.label.includes('العصر'));
  player.clearAutoPause({ resume: true });
  check('استئناف تلقائي بعد الصلاة', player.state.status === 'playing' && !player.state.autoPause);

  player.pause();
  player.setAutoPause({ reason: 'prayer', key: 'asr', label: 'وقت صلاة العصر', mode: 'pause', until: '16:20' });
  player.clearAutoPause({ resume: true });
  check('لا تُشغَّل الموسيقى إن كانت متوقفة أصلًا قبل الصلاة', player.state.status === 'paused');

  settings.prayer.mode = 'lower';
  player.play();
  player.setAutoPause({ reason: 'prayer', key: 'maghrib', label: 'وقت صلاة المغرب', mode: 'lower', until: '18:10' });
  check('وضع خفض الصوت يبقي التشغيل', player.state.status === 'playing');
  check('الصوت الفعلي منخفض', player.effectiveVolume() === settings.prayer.lowerVolume);
  player.clearAutoPause({ resume: false });
  check('عودة الصوت لطبيعته', player.effectiveVolume() === player.state.volume);
  settings.prayer.mode = 'pause';

  // ==================================================== 9) الجدولة

  section('الجدولة الزمنية');
  const now = new Date();
  const ruleTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const rule = await call('/api/schedules', {
    method: 'POST',
    body: { name: 'اختبار', time: ruleTime, days: [], enabled: true, action: { type: 'volume', value: 0.2 } }
  });
  check('إنشاء قاعدة جدولة', rule.status === 200 && rule.data.id);
  scheduler.checkSchedules();
  check('القاعدة تنفَّذ في وقتها', Math.abs(player.state.volume - 0.2) < 0.001, String(player.state.volume));
  player.setVolume(0.6);
  scheduler.checkSchedules();
  check('لا تتكرّر القاعدة في نفس الدقيقة', Math.abs(player.state.volume - 0.6) < 0.001);
  const del = await call(`/api/schedules/${rule.data.id}`, { method: 'DELETE' });
  check('حذف القاعدة', del.status === 200 && settings.schedules.length === 0);

  // ==================================================== 10) الإعدادات

  section('الإعدادات');
  const patch = await call('/api/settings', {
    method: 'PATCH',
    body: { crossfadeSec: 5, staffPin: '2222', prayer: { durations: { asr: 30 } } }
  });
  check('حفظ الإعدادات', patch.status === 200 && settings.crossfadeSec === 5 && settings.staffPin === '2222');
  check('الدمج العميق لا يمسح بقية القيم', settings.prayer.durations.asr === 30 && settings.prayer.durations.maghrib === 15);
  const settingsRead = await call('/api/settings');
  check('رمز المدير لا يُرسل للواجهة', settingsRead.data.adminPin === undefined && settingsRead.data.hasAdminPin === true);

  const sys = await call('/api/system');
  check('معلومات النظام متاحة للمدير', sys.status === 200 && sys.data.libraryCount === 7);

  // ==================================================== 11) المتانة

  section('المتانة');
  const brokenId = tracks[3].id;
  player.playNow(brokenId);
  const beforeError = player.state.currentId;
  player.onRendererEvent({ type: 'error', id: brokenId, message: 'ملف تالف' });
  await new Promise((r) => setTimeout(r, 700));
  check('تخطّي الملف التالف تلقائيًا', player.state.currentId !== beforeError, player.state.currentId);

  const missing = await call('/api/player/play-now', { method: 'POST', body: { trackId: 'غير-موجود' } });
  check('رفض معرّف أغنية غير موجود', missing.status === 404);

  // حذف ملف من القرص ثم إعادة الفحص
  const victim = library.get(tracks[5].id);
  fs.rmSync(victim.path);
  await library.scan({ full: false });
  player.pruneOrder();
  check('اختفاء الملف من المكتبة بعد حذفه', !library.tracks.has(tracks[5].id) && library.tracks.size === 6);
  check('ترتيب التشغيل نُظّف من المحذوف', !player.order.includes(tracks[5].id));

  // استعادة الحالة بعد إعادة التشغيل
  player.state.currentId = tracks[0].id;
  player.state.position = 42;
  player.state.status = 'playing';
  player.saveState();
  player.flush();
  const restored = new Player({ library, playlists, settings });
  restored.restore();
  check('استعادة الأغنية والموضع بعد إعادة التشغيل', restored.state.currentId === tracks[0].id && Math.round(restored.state.position) === 42);
  check('استئناف التشغيل تلقائيًا بعد إعادة التشغيل', restored.resumeOnBoot === true);

  // ==================================================== 12) الواجهة

  section('ملفات الواجهة');
  const page = await fetch(`${base}/`);
  const html = await page.text();
  check('صفحة التحكم تُقدَّم', page.status === 200 && html.includes('مارا ميوزك'));
  // حارس ضد خطأ تكرّر: قواعد display تتغلّب على السمة hidden فتظهر عناصر مخفية
  const webCss = await (await fetch(`${base}/style.css`)).text();
  check('تنسيق الجوال يفرض إخفاء عناصر hidden', /\[hidden\]\s*\{\s*display:\s*none\s*!important/.test(webCss));
  const screenCss = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'screen.css'), 'utf8');
  check('تنسيق شاشة الجهاز يفرض إخفاء عناصر hidden', /\[hidden\]\s*\{\s*display:\s*none\s*!important/.test(screenCss));

  const manifest = await fetch(`${base}/manifest.webmanifest`);
  check('ملف PWA موجود', manifest.status === 200);
  const icon = await fetch(`${base}/icons/icon-192.png`);
  check('الأيقونة موجودة', icon.status === 200);
  const spa = await fetch(`${base}/settings`);
  check('أي مسار يعيد التطبيق (SPA)', spa.status === 200);
  const api404 = await fetch(`${base}/api/nope`);
  check('مسار API غير معروف يعيد 404', api404.status === 404);

  // ==================================================== النتيجة

  server.httpServer.close();
  if (library.watcher) await library.watcher.close();
  scheduler.stop();

  console.log(`\n${'='.repeat(48)}`);
  console.log(`الناجحة: ${passed}   الفاشلة: ${failed}`);
  if (failed) {
    console.log(`\nفشلت الاختبارات التالية:\n- ${failures.join('\n- ')}`);
  }
  console.log('='.repeat(48));
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('\n💥 انهار الاختبار:', err);
  process.exit(1);
});
