'use strict';

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, Tray, Menu, dialog, ipcMain, shell, powerSaveBlocker, nativeImage } = require('electron');

const { ensureDirs, DEFAULT_SETTINGS, defaultMusicDir, LOG_DIR } = require('./config');
const { readJSON, writeJSON, deepMerge } = require('./store');
const { Library } = require('./library');
const { Playlists, ALL_TRACKS_ID } = require('./playlists');
const { FxLibrary } = require('./fx');
const { License } = require('./license');
const { Player } = require('./player');
const { Scheduler } = require('./scheduler');
const { Auth } = require('./auth');
const { createServer, lanAddresses } = require('./server');

const isDev = process.argv.includes('--dev');

let settings = null;
let library = null;
let playlists = null;
let fx = null;
let license = null;
let player = null;
let scheduler = null;
let auth = null;
let server = null;
let win = null;
let tray = null;
let powerBlockerId = null;
let quitting = false;

// -------------------------------------------------------------- السجلّات

function setupLogging() {
  ensureDirs();
  const logFile = path.join(LOG_DIR, `mara-music-${new Date().toISOString().slice(0, 10)}.log`);
  const stream = fs.createWriteStream(logFile, { flags: 'a' });
  for (const level of ['log', 'warn', 'error']) {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      const line = `${new Date().toISOString()} [${level}] ${args.map(stringify).join(' ')}\n`;
      try { stream.write(line); } catch (_) { /* تجاهل */ }
      original(...args);
    };
  }
  process.on('uncaughtException', (err) => console.error('استثناء غير معالج:', err && err.stack));
  process.on('unhandledRejection', (err) => console.error('وعد مرفوض:', err));
}

function stringify(value) {
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value); } catch (_) { return String(value); }
}

// -------------------------------------------------------------- الإعدادات

function loadSettings() {
  const saved = readJSON('settings', {});
  settings = deepMerge(DEFAULT_SETTINGS, saved);
  let dirty = false;
  if (!settings.musicDir) {
    settings.musicDir = defaultMusicDir();
    dirty = true;
  }
  if (!settings.adminPin) {
    settings.adminPin = Auth.generatePin(6);
    dirty = true;
    console.log('[setup] تم توليد رمز المدير لأول مرة');
  }
  if (dirty) saveSettings();
  return settings;
}

function saveSettings() {
  try {
    writeJSON('settings', settings);
  } catch (err) {
    console.error('[settings] فشل الحفظ:', err.message);
  }
}

function applyAutoStart() {
  if (process.platform !== 'win32') return;
  try {
    // في النسخة المثبّتة يكفي مسار البرنامج نفسه، أما عند التشغيل من مجلد
    // (electron.exe مباشرة) فلا بد من تمرير مسار التطبيق وإلا فتحت نافذة فارغة.
    app.setLoginItemSettings({
      openAtLogin: settings.autoStart !== false,
      path: process.execPath,
      args: app.isPackaged ? [] : [app.getAppPath()]
    });
  } catch (err) {
    console.error('[autostart] تعذّر الضبط:', err.message);
  }
}

// ---------------------------------------------------------------- النافذة

function createWindow(port) {
  win = new BrowserWindow({
    width: 1100,
    height: 700,
    show: false,
    backgroundColor: '#0b0d12',
    autoHideMenuBar: true,
    title: 'Mara Music',
    icon: appIcon(),
    fullscreen: !isDev && settings.kiosk?.fullscreen !== false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false, // مهم: يمنع ويندوز من إبطاء الصوت عند إخفاء النافذة
      autoplayPolicy: 'no-user-gesture-required'
    }
  });

  win.loadURL(`http://127.0.0.1:${port}/player/index.html?t=${auth.internalToken}`);

  win.once('ready-to-show', () => win.show());

  // إغلاق النافذة يخفيها فقط — الموسيقى لا تتوقف
  win.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    win.hide();
    if (tray) {
      tray.displayBalloon?.({
        title: 'Mara Music',
        content: 'الموسيقى ما زالت تعمل في الخلفية. افتح البرنامج من أيقونة شريط المهام.'
      });
    }
  });

  win.webContents.on('render-process-gone', (_e, details) => {
    console.error('[window] انهار محرّك التشغيل:', details.reason, '— إعادة تحميل');
    setTimeout(() => {
      if (win && !win.isDestroyed()) win.reload();
    }, 1500);
  });

  return win;
}

function appIcon() {
  const iconPath = path.join(__dirname, '..', 'assets', 'icon.png');
  if (fs.existsSync(iconPath)) return nativeImage.createFromPath(iconPath);
  return undefined;
}

// ------------------------------------------------------------ شريط المهام

function createTray(port) {
  const icon = appIcon() || nativeImage.createEmpty();
  tray = new Tray(icon);
  tray.setToolTip('Mara Music — مشغّل مارا');
  refreshTrayMenu(port);
  tray.on('double-click', () => showWindow());
}

function refreshTrayMenu(port) {
  if (!tray) return;
  const url = remoteUrl(port);
  const menu = Menu.buildFromTemplate([
    { label: `Mara Music ${app.getVersion()}`, enabled: false },
    { type: 'separator' },
    { label: 'إظهار شاشة المشغّل', click: () => showWindow() },
    { label: `فتح صفحة التحكم (${url})`, click: () => shell.openExternal(url) },
    { label: 'نسخ رابط التحكم', click: () => require('electron').clipboard.writeText(url) },
    { type: 'separator' },
    {
      label: 'إظهار رمز المدير',
      click: () => {
        dialog.showMessageBox({
          type: 'info',
          title: 'رمز المدير',
          message: `رمز المدير: ${settings.adminPin}`,
          detail: `رمز الموظف: ${settings.staffPin}\n\nرابط التحكم: ${url}\n\nلا تشارك رمز المدير مع الموظفين.`,
          buttons: ['إغلاق']
        });
      }
    },
    { label: 'فتح مجلد الموسيقى', click: () => shell.openPath(settings.musicDir) },
    { label: 'فتح مجلد السجلّات', click: () => shell.openPath(LOG_DIR) },
    { type: 'separator' },
    { label: player?.state.status === 'playing' ? 'إيقاف مؤقت' : 'تشغيل', click: () => player?.toggle() },
    { label: 'الأغنية التالية', click: () => player?.next({ manual: true }) },
    { label: 'تحديث المكتبة', click: () => library?.scan({ full: false }) },
    { type: 'separator' },
    {
      label: 'إغلاق البرنامج نهائيًا',
      click: async () => {
        const { response } = await dialog.showMessageBox({
          type: 'warning',
          title: 'إغلاق Mara Music',
          message: 'سيتوقف تشغيل الموسيقى في المطعم. متأكد؟',
          buttons: ['إلغاء', 'إغلاق'],
          defaultId: 0,
          cancelId: 0
        });
        if (response === 1) {
          quitting = true;
          app.quit();
        }
      }
    }
  ]);
  tray.setContextMenu(menu);
}

function showWindow() {
  if (!win || win.isDestroyed()) return;
  win.show();
  win.focus();
}

function remoteUrl(port) {
  const addresses = lanAddresses();
  const host = addresses.length ? addresses[0].address : '127.0.0.1';
  return `http://${host}:${port}`;
}

// ------------------------------------------------------------ شاشة الجهاز

let qrCache = { url: null, dataUrl: null };

async function screenPayload(port) {
  const url = remoteUrl(port);
  if (settings.kiosk?.showQr !== false && qrCache.url !== url) {
    try {
      const QRCode = require('qrcode');
      qrCache = { url, dataUrl: await QRCode.toDataURL(url, { margin: 1, width: 260, color: { dark: '#0b0d12', light: '#ffffff' } }) };
    } catch (err) {
      qrCache = { url, dataUrl: null };
    }
  }
  return {
    state: player.publicState(),
    prayer: scheduler.prayerSummary(),
    network: { url, qr: settings.kiosk?.showQr !== false ? qrCache.dataUrl : null },
    staffPin: settings.staffPin,
    staffCanPause: settings.kiosk?.staffCanPause !== false
  };
}

function pushScreen(port) {
  if (!win || win.isDestroyed()) return;
  screenPayload(port)
    .then((payload) => {
      if (win && !win.isDestroyed()) win.webContents.send('screen-update', payload);
    })
    .catch(() => {});
}

// ------------------------------------------------------------------ الإقلاع

async function boot() {
  setupLogging();

  // هوية التطبيق في ويندوز: بدونها يظهر باسم Electron في شريط المهام
  // ولا يُثبَّت عليه بشكل صحيح، حتى مع وجود أيقونة للنافذة.
  if (process.platform === 'win32') app.setAppUserModelId('sa.mara.music');
  loadSettings();

  library = new Library();
  library.load(settings.musicDir);

  playlists = new Playlists(library);
  playlists.load();

  auth = new Auth(() => settings);
  auth.load();

  fx = new FxLibrary();
  fx.load();

  license = new License();
  license.load();

  player = new Player({ library, playlists, settings, fx });
  player.restore();
  // بلا ترخيص لا استئناف تلقائي — وإلا عاد التشغيل مع كل إقلاع رغم المنع
  if (!license.allowsPlayback()) player.resumeOnBoot = false;
  player.on('settings-changed', saveSettings);

  scheduler = new Scheduler({
    player,
    playlists,
    getSettings: () => settings
  });

  const port = Number(settings.port) || 8787;
  server = createServer({
    player,
    library,
    playlists,
    auth,
    scheduler,
    fx,
    license,
    settings: () => settings,
    saveSettings,
    appInfo: { version: app.getVersion() },
    onSettingsApplied: (patch) => {
      if (patch && typeof patch.autoStart === 'boolean') applyAutoStart();
      if (patch && patch.kiosk && win && !win.isDestroyed()) {
        win.setFullScreen(settings.kiosk?.fullscreen !== false);
      }
    }
  });

  await new Promise((resolve, reject) => {
    server.httpServer.once('error', reject);
    server.httpServer.listen(port, '0.0.0.0', resolve);
  });
  console.log(`[server] يعمل على المنفذ ${port} — ${remoteUrl(port)}`);

  createWindow(port);
  createTray(port);
  applyAutoStart();

  // منع ويندوز من تعليق البرنامج أثناء التشغيل
  powerBlockerId = powerSaveBlocker.start('prevent-app-suspension');

  // فحص المكتبة في الخلفية بعد الإقلاع حتى تظهر الشاشة بسرعة
  setTimeout(async () => {
    await library.setMusicDir(settings.musicDir);
    player.pruneOrder();
    writeMusicFolderReadme();
  }, 1200);

  library.on('changed', () => player.pruneOrder());

  scheduler.start();

  // تحديث شاشة الجهاز
  player.on('state', () => pushScreen(port));
  const screenTimer = setInterval(() => pushScreen(port), 5000);
  if (screenTimer.unref) screenTimer.unref();
  const trayTimer = setInterval(() => refreshTrayMenu(port), 15000);
  if (trayTimer.unref) trayTimer.unref();

  // انتهاء الفترة التجريبية أثناء العمل: نفحص دوريًا وإلا استمر التشغيل
  // إلى ما لا نهاية ما دام البرنامج لم يُغلق.
  let lastAllowed = license.allowsPlayback();
  const licenseTimer = setInterval(() => {
    const allowed = license.allowsPlayback();
    if (allowed === lastAllowed) return;
    lastAllowed = allowed;
    if (!allowed) {
      console.warn('[license] سقط الترخيص — إيقاف التشغيل');
      player.stop();
    }
    server.broadcast({ type: 'license' });
  }, 30 * 60 * 1000);
  if (licenseTimer.unref) licenseTimer.unref();

  // ------------------------------------------------------------- IPC

  ipcMain.on('player-ready', () => {
    console.log('[player] محرّك الصوت جاهز');
    player.attachRenderer(
      (command) => {
        if (win && !win.isDestroyed()) win.webContents.send('player-command', command);
      },
      {
        streamBase: `http://127.0.0.1:${port}/api/stream/`,
        streamSuffix: `?t=${auth.internalToken}`,
        fxBase: `http://127.0.0.1:${port}/api/fx/`
      }
    );
    pushScreen(port);
  });

  ipcMain.on('player-event', (_event, payload) => {
    if (payload && typeof payload === 'object') player.onRendererEvent(payload);
  });

  ipcMain.on('screen-request', () => pushScreen(port));

  ipcMain.on('staff-action', (_event, action) => {
    if (settings.kiosk?.staffCanPause === false) return;
    if (action === 'toggle') player.toggle();
    else if (action === 'next') player.next({ manual: true });
  });

  console.log('[boot] Mara Music جاهز');
}

function writeMusicFolderReadme() {
  try {
    const file = path.join(settings.musicDir, 'اقرأني.txt');
    if (fs.existsSync(file)) return;
    fs.writeFileSync(
      file,
      [
        'مجلد موسيقى مارا',
        '=================',
        '',
        'ضع ملفات MP3 هنا (أو في مجلدات فرعية) وسيلتقطها البرنامج تلقائيًا خلال ثوانٍ.',
        'الصيغ المدعومة: mp3, m4a, aac, flac, wav, ogg, opus, wma',
        '',
        'مجلد Uploads يحتوي الأغاني المرفوعة من الجوال.',
        'لا تحذف ملفات أثناء التشغيل — البرنامج سيتخطى الملف الناقص تلقائيًا.'
      ].join('\r\n'),
      'utf8'
    );
  } catch (err) {
    console.warn('[setup] تعذّرت كتابة ملف التعليمات:', err.message);
  }
}

// -------------------------------------------------------------- دورة الحياة

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());

  app.whenReady().then(boot).catch((err) => {
    console.error('[boot] فشل الإقلاع:', err);
    dialog.showErrorBox('Mara Music', `تعذّر تشغيل البرنامج:\n${err.message}`);
    app.quit();
  });

  app.on('window-all-closed', () => {
    // لا نغلق البرنامج — يبقى في شريط المهام والموسيقى تعمل
  });

  app.on('before-quit', () => {
    quitting = true;
    try {
      player?.flush();
      saveSettings();
      auth?.persist();
      scheduler?.stop();
      if (powerBlockerId !== null) powerSaveBlocker.stop(powerBlockerId);
      server?.httpServer.close();
    } catch (err) {
      console.error('[quit]', err.message);
    }
  });
}
