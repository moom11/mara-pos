'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { app } = require('electron');

const DATA_DIR = path.join(app.getPath('userData'), 'data');
const COVERS_DIR = path.join(DATA_DIR, 'covers');
const LOG_DIR = path.join(app.getPath('userData'), 'logs');

function defaultMusicDir() {
  try {
    return path.join(app.getPath('music'), 'MaraMusic');
  } catch (e) {
    return path.join(os.homedir(), 'Music', 'MaraMusic');
  }
}

const AUDIO_EXTENSIONS = new Set(['.mp3', '.m4a', '.aac', '.flac', '.wav', '.ogg', '.opus', '.wma']);

const DEFAULT_SETTINGS = {
  // المكتبة
  musicDir: null, // يُملأ عند أول تشغيل
  // الشبكة
  port: 8787,
  // التشغيل
  volume: 0.6,
  maxStaffVolume: 0.85,
  crossfadeSec: 3,
  shuffle: true,
  repeat: 'all', // off | all | one
  // أوقات الصلاة
  prayer: {
    enabled: true,
    mode: 'pause', // pause | lower
    lowerVolume: 0.12,
    lat: 24.7136,
    lng: 46.6753,
    tz: 3,
    fajrAngle: 18.5,
    ishaOffsetMin: 90,
    asrFactor: 1,
    offsetsMin: { fajr: 0, dhuhr: 0, asr: 0, maghrib: 0, isha: 0 },
    durations: { fajr: 25, dhuhr: 25, asr: 20, maghrib: 15, isha: 20, jumuah: 60 },
    enabledPrayers: { fajr: false, dhuhr: true, asr: true, maghrib: true, isha: true }
  },
  // الجدولة الزمنية
  schedules: [],
  // شاشة الجهاز
  kiosk: {
    fullscreen: true,
    showQr: true,
    staffCanPause: true
  },
  // الأمان
  adminPin: null, // يُولَّد عشوائيًا عند أول تشغيل
  staffPin: '1111',
  // بدء تلقائي مع ويندوز
  autoStart: true
};

function ensureDirs() {
  for (const dir of [DATA_DIR, COVERS_DIR, LOG_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

module.exports = {
  DATA_DIR,
  COVERS_DIR,
  LOG_DIR,
  AUDIO_EXTENSIONS,
  DEFAULT_SETTINGS,
  defaultMusicDir,
  ensureDirs
};
