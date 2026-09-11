'use strict';

const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./config');

/**
 * تخزين محلي بملفات JSON مع كتابة ذرية (temp + rename) حتى لا تتلف البيانات
 * إذا انقطعت الكهرباء أثناء الحفظ.
 */

function filePath(name) {
  return path.join(DATA_DIR, `${name}.json`);
}

function readJSON(name, fallback) {
  const file = filePath(name);
  try {
    let raw = fs.readFileSync(file, 'utf8');
    // محرّرات ويندوز (Notepad وSet-Content) تضيف علامة BOM تُفشل JSON.parse
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    return JSON.parse(raw);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error(`[store] تعذّر قراءة ${name}.json:`, err.message);
      // نحتفظ بنسخة من الملف التالف للمراجعة
      try {
        fs.renameSync(file, `${file}.corrupt-${Date.now()}`);
      } catch (_) { /* تجاهل */ }
    }
    return typeof fallback === 'function' ? fallback() : fallback;
  }
}

function writeJSON(name, data) {
  const file = filePath(name);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

/** كاتب مؤجَّل: يجمّع الكتابات المتكررة (مثل حالة التشغيل) في كتابة واحدة. */
class DebouncedWriter {
  constructor(name, delayMs = 2000) {
    this.name = name;
    this.delayMs = delayMs;
    this.timer = null;
    this.pending = null;
  }

  queue(data) {
    this.pending = data;
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), this.delayMs);
    if (this.timer.unref) this.timer.unref();
  }

  flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.pending === null) return;
    const data = this.pending;
    this.pending = null;
    try {
      writeJSON(this.name, data);
    } catch (err) {
      console.error(`[store] فشل حفظ ${this.name}.json:`, err.message);
    }
  }
}

/** دمج عميق للإعدادات: يحافظ على المفاتيح الجديدة بعد التحديثات. */
function deepMerge(base, override) {
  if (!override || typeof override !== 'object' || Array.isArray(override)) {
    return override === undefined ? base : override;
  }
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && base && typeof base[key] === 'object' && !Array.isArray(base[key])) {
      out[key] = deepMerge(base[key], value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

module.exports = { readJSON, writeJSON, DebouncedWriter, deepMerge };
