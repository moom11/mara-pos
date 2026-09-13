'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const { FX_DIR, AUDIO_EXTENSIONS } = require('./config');
const { readJSON, writeJSON } = require('./store');

/**
 * مؤثرات مارا: مقاطع قصيرة يرفعها المدير — عبارات بصوته أو إيقاعات.
 *
 * تعيش في مجلد مستقل عن الموسيقى عمدًا: لو وُضعت داخل مجلد الأغاني
 * لالتقطها فاحص المكتبة وظهرت كأغانٍ في القوائم وتشغّلت في الترتيب.
 *
 * أي ملف يُلقى في المجلد يدويًا يُلتقط تلقائيًا عند التحميل، فلا يُشترط
 * الرفع من الجوال.
 */
class FxLibrary extends EventEmitter {
  constructor() {
    super();
    this.items = new Map();
  }

  load() {
    fs.mkdirSync(FX_DIR, { recursive: true });
    const saved = readJSON('fx', { items: [] });
    const byFile = new Map();
    for (const item of saved.items || []) {
      if (item && item.file) byFile.set(item.file, item);
    }

    this.items.clear();
    let found = 0;
    for (const entry of fs.readdirSync(FX_DIR, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (!AUDIO_EXTENSIONS.has(ext)) continue;
      found += 1;
      const existing = byFile.get(entry.name);
      this.items.set(idFor(entry.name), normalize(existing, entry.name));
    }

    console.log(`[fx] ${found} مؤثرًا في ${FX_DIR}`);
    this.persist();
    return found;
  }

  persist() {
    writeJSON('fx', { items: [...this.items.values()] });
  }

  list() {
    return [...this.items.values()].sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'tag' ? -1 : 1;
      return a.name.localeCompare(b.name, 'ar');
    });
  }

  get(id) {
    return this.items.get(id) || null;
  }

  pathOf(id) {
    const item = this.get(id);
    return item ? path.join(FX_DIR, item.file) : null;
  }

  /** يُستدعى بعد أن يكتب multer الملف في المجلد. */
  register(fileName) {
    const id = idFor(fileName);
    this.items.set(id, normalize(this.items.get(id), fileName));
    this.persist();
    this.emit('changed');
    return this.items.get(id);
  }

  update(id, patch = {}) {
    const item = this.get(id);
    if (!item) return null;
    if (typeof patch.name === 'string' && patch.name.trim()) item.name = patch.name.trim().slice(0, 40);
    if (patch.kind === 'tag' || patch.kind === 'pad') item.kind = patch.kind;
    if (typeof patch.loop === 'boolean') item.loop = patch.loop;
    if (patch.gain !== undefined) {
      const gain = Number(patch.gain);
      if (Number.isFinite(gain)) item.gain = Math.min(1, Math.max(0.05, gain));
    }
    this.persist();
    this.emit('changed');
    return item;
  }

  remove(id) {
    const item = this.get(id);
    if (!item) return false;
    try {
      fs.unlinkSync(path.join(FX_DIR, item.file));
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.error('[fx] تعذّر حذف الملف:', err.message);
        return false;
      }
    }
    this.items.delete(id);
    this.persist();
    this.emit('changed');
    return true;
  }
}

/** معرّف ثابت مشتق من اسم الملف — يبقى كما هو لو نُسخ المجلد لجهاز آخر. */
function idFor(fileName) {
  return crypto.createHash('sha1').update(fileName).digest('hex').slice(0, 12);
}

function normalize(existing, fileName) {
  const base = path.basename(fileName, path.extname(fileName));
  return {
    id: idFor(fileName),
    file: fileName,
    name: (existing && existing.name) || base.replace(/[_-]+/g, ' ').trim().slice(0, 40) || base,
    kind: existing && existing.kind === 'tag' ? 'tag' : 'pad',
    // التكرار مطفأ افتراضيًا: مقطع يدور بلا نهاية فوق الأغاني أسوأ من صمته
    loop: !!(existing && existing.loop),
    gain: existing && Number.isFinite(existing.gain) ? existing.gain : 0.7
  };
}

module.exports = { FxLibrary, FX_ID_FOR: idFor };
