'use strict';

const crypto = require('crypto');
const { prayerTimes, PRAYER_NAMES_AR, formatMinutes } = require('./prayer');

const TICK_MS = 15000;
const PRAYER_KEYS = ['fajr', 'dhuhr', 'asr', 'maghrib', 'isha'];

/**
 * يتولّى أمرين:
 *  1) الإيقاف/الخفض التلقائي في أوقات الصلاة.
 *  2) قواعد الجدولة الزمنية (تغيير القائمة أو مستوى الصوت حسب الوقت واليوم).
 */
class Scheduler {
  constructor({ player, playlists, getSettings, onSettingsChanged }) {
    this.player = player;
    this.playlists = playlists;
    this.getSettings = getSettings;
    this.onSettingsChanged = onSettingsChanged || (() => {});
    this.timer = null;
    this.firedKeys = new Set();
    this.lastDayKey = null;
  }

  start() {
    this.stop();
    this.tick();
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  now() {
    const d = new Date();
    return { date: d, minutes: d.getHours() * 60 + d.getMinutes(), day: d.getDay() };
  }

  todayPrayerTimes(date = new Date()) {
    const settings = this.getSettings();
    return prayerTimes(date, settings.prayer || {});
  }

  /** ملخّص أوقات الصلاة لعرضه في الواجهة. */
  prayerSummary() {
    const settings = this.getSettings();
    const conf = settings.prayer || {};
    const times = this.todayPrayerTimes();
    const { minutes } = this.now();
    const list = PRAYER_KEYS.map((key) => {
      const at = times[key];
      const duration = this.durationFor(key);
      return {
        key,
        name: PRAYER_NAMES_AR[key],
        at,
        time: formatMinutes(at),
        durationMin: duration,
        enabled: !!(conf.enabledPrayers && conf.enabledPrayers[key]),
        active: minutes >= at && minutes < at + duration,
        passed: minutes >= at + duration
      };
    });
    let next = null;
    const upcoming = list.find((p) => !p.passed);
    if (upcoming) {
      next = { key: upcoming.key, name: upcoming.name, time: upcoming.time, inMin: Math.max(0, upcoming.at - minutes) };
    } else {
      // انتهت صلوات اليوم — نعرض فجر الغد
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      const fajr = this.todayPrayerTimes(tomorrow).fajr;
      next = {
        key: 'fajr',
        name: PRAYER_NAMES_AR.fajr,
        time: formatMinutes(fajr),
        inMin: 1440 - minutes + fajr,
        tomorrow: true
      };
    }

    return {
      enabled: !!conf.enabled,
      mode: conf.mode || 'pause',
      sunrise: formatMinutes(times.sunrise),
      prayers: list,
      next
    };
  }

  durationFor(key) {
    const conf = this.getSettings().prayer || {};
    const durations = conf.durations || {};
    const isFriday = new Date().getDay() === 5;
    if (key === 'dhuhr' && isFriday) return num(durations.jumuah, 60);
    return num(durations[key], 20);
  }

  tick() {
    try {
      this.checkPrayer();
      this.checkSchedules();
    } catch (err) {
      console.error('[scheduler] خطأ:', err.message);
    }
  }

  // -------------------------------------------------------------- الصلاة

  checkPrayer() {
    const settings = this.getSettings();
    const conf = settings.prayer || {};
    const state = this.player.state;

    if (!conf.enabled) {
      if (state.autoPause && state.autoPause.reason === 'prayer') {
        this.player.clearAutoPause({ resume: true });
      }
      return;
    }

    const times = this.todayPrayerTimes();
    const { minutes } = this.now();
    let activePrayer = null;

    for (const key of PRAYER_KEYS) {
      if (!(conf.enabledPrayers && conf.enabledPrayers[key])) continue;
      const at = times[key];
      const duration = this.durationFor(key);
      if (minutes >= at && minutes < at + duration) {
        activePrayer = { key, at, duration };
        break;
      }
    }

    if (activePrayer) {
      const current = state.autoPause;
      if (current && current.reason === 'prayer' && current.key === activePrayer.key) return;
      this.player.setAutoPause({
        reason: 'prayer',
        key: activePrayer.key,
        label: `وقت صلاة ${PRAYER_NAMES_AR[activePrayer.key]}`,
        mode: conf.mode || 'pause',
        until: formatMinutes(activePrayer.at + activePrayer.duration)
      });
      this.player.state.autoPause.key = activePrayer.key;
      console.log(`[scheduler] إيقاف تلقائي: صلاة ${PRAYER_NAMES_AR[activePrayer.key]} حتى ${formatMinutes(activePrayer.at + activePrayer.duration)}`);
    } else if (state.autoPause && state.autoPause.reason === 'prayer') {
      console.log('[scheduler] انتهى وقت الصلاة — استئناف الموسيقى');
      this.player.clearAutoPause({ resume: true });
    }
  }

  // ------------------------------------------------------------- الجدولة

  checkSchedules() {
    const settings = this.getSettings();
    const rules = settings.schedules || [];
    if (!rules.length) return;
    const { minutes, day, date } = this.now();
    const dayKey = date.toDateString();
    if (dayKey !== this.lastDayKey) {
      this.firedKeys.clear();
      this.lastDayKey = dayKey;
    }

    for (const rule of rules) {
      if (!rule || !rule.enabled) continue;
      if (Array.isArray(rule.days) && rule.days.length && !rule.days.includes(day)) continue;
      const at = parseTime(rule.time);
      if (at === null) continue;
      // ينطلق خلال الدقيقة المحدّدة فقط، ومرة واحدة في اليوم
      if (minutes !== at) continue;
      const fireKey = `${dayKey}|${rule.id}|${at}`;
      if (this.firedKeys.has(fireKey)) continue;
      this.firedKeys.add(fireKey);
      this.applyRule(rule);
    }
  }

  applyRule(rule) {
    const action = rule.action || {};
    console.log(`[scheduler] تنفيذ قاعدة "${rule.name}" (${action.type})`);
    switch (action.type) {
      case 'playlist': {
        const pl = this.playlists.get(action.value);
        if (!pl) return;
        this.player.setSource(pl.id, { autoplay: true });
        if (typeof action.volume === 'number') this.player.setVolume(action.volume, { fadeMs: 4000 });
        break;
      }
      case 'stream': {
        const stream = (this.getSettings().streams || []).find((s) => s.id === action.value);
        if (!stream) {
          console.warn(`[scheduler] رابط البث غير موجود: ${action.value}`);
          return;
        }
        this.player.playStream(stream);
        if (typeof action.volume === 'number') this.player.setVolume(action.volume, { fadeMs: 4000 });
        break;
      }
      case 'volume':
        this.player.setVolume(Number(action.value), { fadeMs: 4000 });
        break;
      case 'pause':
        this.player.pause();
        break;
      case 'resume':
      case 'play':
        this.player.play();
        break;
      case 'stop':
        this.player.stop();
        break;
      default:
        break;
    }
    this.player.emit('schedule-fired', { rule });
  }

  // -------------------------------------------------------- إدارة القواعد

  static normalizeRule(input) {
    const days = Array.isArray(input.days) ? input.days.map(Number).filter((d) => d >= 0 && d <= 6) : [];
    return {
      id: input.id || crypto.randomBytes(5).toString('hex'),
      name: String(input.name || 'قاعدة').slice(0, 60),
      enabled: input.enabled !== false,
      days,
      time: /^\d{1,2}:\d{2}$/.test(String(input.time)) ? String(input.time) : '08:00',
      action: {
        type: ['playlist', 'stream', 'volume', 'pause', 'resume', 'play', 'stop'].includes(input.action?.type) ? input.action.type : 'volume',
        value: input.action?.value ?? 0.5,
        volume: typeof input.action?.volume === 'number' ? input.action.volume : undefined
      }
    };
  }
}

function parseTime(text) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(text || ''));
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

module.exports = { Scheduler, PRAYER_KEYS };
