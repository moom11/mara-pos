'use strict';

/**
 * حساب أوقات الصلاة محليًا (بدون إنترنت) بالخوارزمية الفلكية المعتادة.
 * الإعداد الافتراضي: طريقة أم القرى (الفجر 18.5 درجة، العشاء بعد المغرب بـ 90 دقيقة)
 * والعصر على مذهب الجمهور (ظل المثل).
 */

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

const sin = (d) => Math.sin(d * D2R);
const cos = (d) => Math.cos(d * D2R);
const tan = (d) => Math.tan(d * D2R);
const arcsin = (x) => Math.asin(x) * R2D;
const arccos = (x) => Math.acos(x) * R2D;
const arctan2 = (y, x) => Math.atan2(y, x) * R2D;
const arccot = (x) => Math.atan(1 / x) * R2D;

function fixAngle(a) {
  return ((a % 360) + 360) % 360;
}

function fixHour(h) {
  return ((h % 24) + 24) % 24;
}

function julianDate(year, month, day) {
  let y = year;
  let m = month;
  if (m <= 2) {
    y -= 1;
    m += 12;
  }
  const a = Math.floor(y / 100);
  const b = 2 - a + Math.floor(a / 4);
  return Math.floor(365.25 * (y + 4716)) + Math.floor(30.6001 * (m + 1)) + day + b - 1524.5;
}

function sunPosition(jd) {
  const d = jd - 2451545.0;
  const g = fixAngle(357.529 + 0.98560028 * d); // شذوذ الشمس المتوسط
  const q = fixAngle(280.459 + 0.98564736 * d); // خط الطول المتوسط
  const l = fixAngle(q + 1.915 * sin(g) + 0.020 * sin(2 * g)); // خط الطول الظاهري
  const e = 23.439 - 0.00000036 * d; // ميل فلك البروج
  const ra = fixHour(arctan2(cos(e) * sin(l), cos(l)) / 15); // المطلع المستقيم
  const decl = arcsin(sin(e) * sin(l)); // الميل
  const eqt = q / 15 - ra; // معادلة الزمن بالساعات
  return { decl, eqt };
}

/**
 * @returns {{fajr:number,sunrise:number,dhuhr:number,asr:number,maghrib:number,isha:number}}
 * القيم بالدقائق من منتصف الليل بالتوقيت المحلي.
 */
function prayerTimes(date, opts = {}) {
  const lat = num(opts.lat, 24.7136);
  const lng = num(opts.lng, 46.6753);
  const tz = num(opts.tz, 3);
  const fajrAngle = num(opts.fajrAngle, 18.5);
  const ishaOffsetMin = num(opts.ishaOffsetMin, 90);
  const asrFactor = num(opts.asrFactor, 1);
  const offsets = opts.offsetsMin || {};

  const jd = julianDate(date.getFullYear(), date.getMonth() + 1, date.getDate()) - lng / (15 * 24);
  const { decl, eqt } = sunPosition(jd);

  // زاوية الساعة اللازمة للوصول إلى ارتفاع معيّن للشمس
  const hourAngle = (altitude) => {
    const cosH = (sin(altitude) - sin(lat) * sin(decl)) / (cos(lat) * cos(decl));
    if (cosH > 1 || cosH < -1) return null; // لا يحدث في خطوط العرض المعتدلة
    return arccos(cosH) / 15;
  };

  const dhuhr = fixHour(12 + tz - lng / 15 - eqt);
  const sunAngle = -0.833; // انكسار الضوء + نصف قطر الشمس

  const tSunrise = hourAngle(sunAngle);
  const tFajr = hourAngle(-fajrAngle);
  const asrAltitude = arccot(asrFactor + tan(Math.abs(lat - decl)));
  const tAsr = hourAngle(asrAltitude);

  const sunrise = tSunrise === null ? dhuhr - 6 : dhuhr - tSunrise;
  const maghrib = tSunrise === null ? dhuhr + 6 : dhuhr + tSunrise;
  const fajr = tFajr === null ? sunrise - 1.5 : dhuhr - tFajr;
  const asr = tAsr === null ? dhuhr + 3.5 : dhuhr + tAsr;
  const isha = maghrib + ishaOffsetMin / 60;

  const toMinutes = (hours, key) => Math.round(fixHour(hours) * 60) + num(offsets[key], 0);

  return {
    fajr: toMinutes(fajr, 'fajr'),
    sunrise: toMinutes(sunrise, 'sunrise'),
    dhuhr: toMinutes(dhuhr, 'dhuhr'),
    asr: toMinutes(asr, 'asr'),
    maghrib: toMinutes(maghrib, 'maghrib'),
    isha: toMinutes(isha, 'isha')
  };
}

const PRAYER_NAMES_AR = {
  fajr: 'الفجر',
  sunrise: 'الشروق',
  dhuhr: 'الظهر',
  asr: 'العصر',
  maghrib: 'المغرب',
  isha: 'العشاء'
};

function formatMinutes(minutes) {
  const m = ((Math.round(minutes) % 1440) + 1440) % 1440;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

module.exports = { prayerTimes, PRAYER_NAMES_AR, formatMinutes };
