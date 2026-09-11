'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const chokidar = require('chokidar');

const { AUDIO_EXTENSIONS, COVERS_DIR } = require('./config');
const { readJSON, writeJSON } = require('./store');

let mmPromise = null;
function loadMusicMetadata() {
  // music-metadata حزمة ESM، لذلك نستوردها ديناميكيًا من داخل CommonJS
  if (!mmPromise) mmPromise = import('music-metadata');
  return mmPromise;
}

function trackId(relPath) {
  return crypto.createHash('sha1').update(relPath.toLowerCase()).digest('hex').slice(0, 16);
}

function cleanTitle(fileName) {
  return fileName
    .replace(/\.[^.]+$/, '')
    .replace(/^\d{1,3}[\s._-]+/, '')
    .replace(/[_]+/g, ' ')
    .trim();
}

class Library extends EventEmitter {
  constructor() {
    super();
    this.tracks = new Map(); // id -> track
    this.musicDir = null;
    this.scanning = false;
    this.rescanQueued = false;
    this.watcher = null;
    this.lastScanAt = 0;
    // فهارس محسوبة مسبقًا: الفرز العربي وتطبيع نصوص البحث مكلفان،
    // فنحسبهما مرة واحدة ونبطلهما عند تغيّر المكتبة فقط.
    this.sortCache = new Map(); // sort -> [tracks]
    this.idsCache = new Map(); // sort -> [ids]
    this.searchIndex = new Map(); // id -> نص مطبّع للبحث
  }

  invalidateCaches() {
    this.sortCache.clear();
    this.idsCache.clear();
    this.searchIndex.clear();
  }

  /** قائمة مفروزة ومخزّنة — لا تُعدّل النتيجة مباشرة. */
  sortedList(sort = 'title') {
    let cached = this.sortCache.get(sort);
    if (!cached) {
      cached = this.list().sort(comparator(sort));
      this.sortCache.set(sort, cached);
    }
    return cached;
  }

  /** معرّفات الأغاني مفروزة ومخزّنة — يستخدمها محرّك التشغيل عند بناء الترتيب. */
  sortedIds(sort = 'title') {
    let cached = this.idsCache.get(sort);
    if (!cached) {
      cached = this.sortedList(sort).map((t) => t.id);
      this.idsCache.set(sort, cached);
    }
    return cached;
  }

  searchKeyFor(track) {
    let key = this.searchIndex.get(track.id);
    if (key === undefined) {
      key = normalize(`${track.title} ${track.artist} ${track.album} ${track.relPath}`);
      this.searchIndex.set(track.id, key);
    }
    return key;
  }

  load(musicDir) {
    this.musicDir = musicDir;
    const saved = readJSON('library', { tracks: [] });
    for (const t of saved.tracks || []) {
      if (t && t.id) this.tracks.set(t.id, t);
    }
    console.log(`[library] حُمّلت ${this.tracks.size} أغنية من الذاكرة`);
  }

  persist() {
    writeJSON('library', { tracks: [...this.tracks.values()], savedAt: Date.now() });
  }

  list() {
    return [...this.tracks.values()];
  }

  get(id) {
    return this.tracks.get(id) || null;
  }

  exists(id) {
    const t = this.tracks.get(id);
    return !!t && fs.existsSync(t.path);
  }

  /** بحث بسيط بالعربي والإنجليزي على العنوان والفنان والألبوم واسم الملف. */
  search(query, { limit = 300, offset = 0, sort = 'title' } = {}) {
    const q = normalize(query || '');
    // القائمة المفروزة مخزّنة، و filter يُنتج نسخة جديدة فلا نعبث بالمخزَّن
    let items = this.sortedList(sort);
    if (q) {
      const terms = q.split(/\s+/).filter(Boolean);
      items = items.filter((t) => {
        const haystack = this.searchKeyFor(t);
        return terms.every((term) => haystack.includes(term));
      });
    }
    return { total: items.length, items: items.slice(offset, offset + limit) };
  }

  async setMusicDir(dir) {
    this.musicDir = dir;
    await fsp.mkdir(dir, { recursive: true });
    await this.scan({ full: true });
    this.watch();
  }

  watch() {
    if (this.watcher) {
      this.watcher.close().catch(() => {});
      this.watcher = null;
    }
    if (!this.musicDir) return;
    this.watcher = chokidar.watch(this.musicDir, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 3000, pollInterval: 500 },
      depth: 8
    });
    const trigger = debounce(() => this.scan().catch((e) => console.error('[library]', e)), 4000);
    this.watcher.on('add', trigger).on('unlink', trigger).on('change', trigger);
  }

  async scan({ full = false } = {}) {
    if (this.scanning) {
      this.rescanQueued = true;
      return { queued: true };
    }
    this.scanning = true;
    this.emit('scan-start');
    const started = Date.now();
    let added = 0;
    let removed = 0;
    let updated = 0;

    try {
      await fsp.mkdir(this.musicDir, { recursive: true });
      const files = [];
      await walk(this.musicDir, files, 0);

      const byRelPath = new Map();
      for (const t of this.tracks.values()) byRelPath.set(t.relPath, t);
      const seen = new Set();

      for (const file of files) {
        const relPath = path.relative(this.musicDir, file.path).split(path.sep).join('/');
        seen.add(relPath);
        const existing = byRelPath.get(relPath);
        if (!full && existing && existing.size === file.size && existing.mtime === file.mtime && existing.duration) {
          // لم يتغيّر الملف — نتخطاه
          if (existing.path !== file.path) {
            existing.path = file.path;
            updated++;
          }
          continue;
        }
        const track = await this.readTrack(file, relPath, existing);
        this.tracks.set(track.id, track);
        if (existing) updated++;
        else added++;
      }

      for (const [relPath, track] of byRelPath) {
        if (!seen.has(relPath)) {
          this.tracks.delete(track.id);
          removed++;
        }
      }

      this.invalidateCaches();
      this.persist();
      this.lastScanAt = Date.now();
      const result = { added, removed, updated, total: this.tracks.size, ms: Date.now() - started };
      console.log(`[library] فحص المكتبة: ${JSON.stringify(result)}`);
      this.emit('changed', result);
      return result;
    } finally {
      this.scanning = false;
      this.emit('scan-end');
      if (this.rescanQueued) {
        this.rescanQueued = false;
        setTimeout(() => this.scan().catch(() => {}), 1000);
      }
    }
  }

  async readTrack(file, relPath, existing) {
    const id = existing ? existing.id : trackId(relPath);
    const base = {
      id,
      relPath,
      path: file.path,
      size: file.size,
      mtime: file.mtime,
      title: cleanTitle(path.basename(relPath)),
      artist: '',
      album: '',
      duration: 0,
      cover: null,
      addedAt: existing ? existing.addedAt : Date.now(),
      playCount: existing ? existing.playCount || 0 : 0,
      lastPlayedAt: existing ? existing.lastPlayedAt || null : null
    };

    try {
      const mm = await loadMusicMetadata();
      const meta = await mm.parseFile(file.path, { duration: true, skipPostHeaders: true });
      const common = meta.common || {};
      if (common.title) base.title = String(common.title).trim();
      base.artist = String(common.artist || common.albumartist || '').trim();
      base.album = String(common.album || '').trim();
      base.duration = Math.round(meta.format?.duration || 0);
      const picture = common.picture && common.picture[0];
      if (picture && picture.data) {
        const coverFile = path.join(COVERS_DIR, `${id}.jpg`);
        await fsp.writeFile(coverFile, Buffer.from(picture.data));
        base.cover = `${id}.jpg`;
      }
    } catch (err) {
      console.warn(`[library] تعذّرت قراءة بيانات ${relPath}: ${err.message}`);
    }
    return base;
  }

  markPlayed(id) {
    const t = this.tracks.get(id);
    if (!t) return;
    t.playCount = (t.playCount || 0) + 1;
    t.lastPlayedAt = Date.now();
    // ترتيب "الأكثر تشغيلًا" وحده هو الذي تغيّر
    this.sortCache.delete('most-played');
    this.idsCache.delete('most-played');
  }

  /** يحذف ملف أغنية من القرص (للمدير فقط). */
  async deleteTrack(id) {
    const t = this.tracks.get(id);
    if (!t) return false;
    await fsp.rm(t.path, { force: true });
    this.tracks.delete(id);
    if (t.cover) await fsp.rm(path.join(COVERS_DIR, t.cover), { force: true });
    this.invalidateCaches();
    this.persist();
    this.emit('changed', { removed: 1, total: this.tracks.size });
    return true;
  }
}

function comparator(sort) {
  switch (sort) {
    case 'newest':
      return (a, b) => (b.addedAt || 0) - (a.addedAt || 0);
    case 'most-played':
      return (a, b) => (b.playCount || 0) - (a.playCount || 0);
    case 'artist':
      return (a, b) => (a.artist || '').localeCompare(b.artist || '', 'ar') || (a.title || '').localeCompare(b.title || '', 'ar');
    default:
      return (a, b) => (a.title || '').localeCompare(b.title || '', 'ar');
  }
}

function normalize(text) {
  return String(text)
    .toLowerCase()
    .replace(/[ً-ٰٟ]/g, '') // التشكيل
    .replace(/[أإآ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/[ـ]/g, '')
    .replace(/[\-_.]+/g, ' ');
}

async function walk(dir, out, depth) {
  if (depth > 8) return;
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (err) {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.startsWith('.')) continue;
      await walk(full, out, depth + 1);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (!AUDIO_EXTENSIONS.has(ext)) continue;
      try {
        const stat = await fsp.stat(full);
        out.push({ path: full, size: stat.size, mtime: Math.round(stat.mtimeMs) });
      } catch (_) { /* تجاهل */ }
    }
  }
}

function debounce(fn, ms) {
  let timer = null;
  return (...args) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

module.exports = { Library, AUDIO_EXTENSIONS };
