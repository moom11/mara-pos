'use strict';

const { EventEmitter } = require('events');
const { readJSON, DebouncedWriter } = require('./store');
const { ALL_TRACKS_ID } = require('./playlists');

/**
 * محرّك التشغيل: هذا هو "مصدر الحقيقة" الوحيد.
 * الجوال والمتصفح مجرد أدوات تحكّم — إغلاقها لا يوقف الموسيقى.
 * التشغيل الفعلي للصوت يتم في نافذة Electron (renderer) عبر أوامر يرسلها هذا الملف.
 */
class Player extends EventEmitter {
  constructor({ library, playlists, settings }) {
    super();
    this.library = library;
    this.playlists = playlists;
    this.settings = settings;

    this.send = null; // تُضبط عند جاهزية نافذة المشغّل
    this.rendererReady = false;
    this.streamBase = '';

    this.state = {
      status: 'stopped', // stopped | playing | paused
      currentId: null,
      position: 0,
      duration: 0,
      volume: clamp01(settings.volume ?? 0.6),
      muted: false,
      queue: [],
      sourceId: ALL_TRACKS_ID,
      sourceName: 'كل الأغاني',
      shuffle: !!settings.shuffle,
      repeat: settings.repeat || 'all',
      autoPause: null,
      lastError: null
    };

    this.order = [];
    this.orderPos = -1;
    this.history = [];
    this.pendingNext = null;
    this.stateWriter = new DebouncedWriter('state', 3000);
    this.savedVolumeBeforeLower = null;
  }

  // ---------------------------------------------------------------- الإقلاع

  restore() {
    const saved = readJSON('state', null);
    if (!saved) {
      this.setSource(ALL_TRACKS_ID, { autoplay: false });
      return;
    }
    this.state.volume = clamp01(saved.volume ?? this.state.volume);
    this.state.shuffle = !!saved.shuffle;
    this.state.repeat = saved.repeat || 'all';
    this.state.queue = (saved.queue || []).filter((id) => this.library.tracks.has(id));
    this.state.sourceId = saved.sourceId || ALL_TRACKS_ID;

    const source = this.playlists.get(this.state.sourceId);
    this.state.sourceName = source ? source.name : 'كل الأغاني';

    const savedOrder = (saved.order || []).filter((id) => this.library.tracks.has(id));
    this.order = savedOrder.length ? savedOrder : this.buildOrder();
    this.orderPos = typeof saved.orderPos === 'number' ? saved.orderPos : -1;

    if (saved.currentId && this.library.tracks.has(saved.currentId)) {
      this.state.currentId = saved.currentId;
      this.state.position = Math.max(0, Number(saved.position) || 0);
      const idx = this.order.indexOf(saved.currentId);
      if (idx >= 0) this.orderPos = idx;
      // استئناف ما كان يعمل قبل إعادة التشغيل
      this.resumeOnBoot = saved.status === 'playing';
    }
    console.log(`[player] استُعيدت الحالة: ${this.state.currentId || 'لا شيء'} @ ${Math.round(this.state.position)}s`);
  }

  attachRenderer(sendFn, { streamBase, streamSuffix = '' }) {
    this.send = sendFn;
    this.streamBase = streamBase;
    this.streamSuffix = streamSuffix;
    this.rendererReady = true;
    this.command('volume', { value: this.effectiveVolume(), fadeMs: 0 });
    if (this.state.currentId) {
      this.command('load', {
        id: this.state.currentId,
        url: this.urlFor(this.state.currentId),
        startAt: this.state.position,
        autoplay: !!this.resumeOnBoot
      });
      if (this.resumeOnBoot) this.state.status = 'playing';
      this.resumeOnBoot = false;
      this.schedulePreload();
    }
    this.publish();
  }

  command(type, payload = {}) {
    if (!this.send) return;
    try {
      this.send({ type, ...payload });
    } catch (err) {
      console.error('[player] فشل إرسال الأمر للمشغّل:', err.message);
    }
  }

  urlFor(id) {
    return `${this.streamBase}${id}${this.streamSuffix || ''}`;
  }

  // ------------------------------------------------------------ ترتيب التشغيل

  buildOrder() {
    const ids = this.playlists.trackIdsOf(this.state.sourceId);
    return this.state.shuffle ? shuffled(ids) : ids.slice();
  }

  refreshOrder({ keepCurrent = true } = {}) {
    const current = this.state.currentId;
    this.order = this.buildOrder();
    if (keepCurrent && current) {
      const idx = this.order.indexOf(current);
      this.orderPos = idx;
    } else {
      this.orderPos = -1;
    }
    this.schedulePreload();
  }

  /** ينظّف ترتيب التشغيل من الأغاني المحذوفة بعد تحديث المكتبة. */
  pruneOrder() {
    const currentId = this.state.currentId;
    const before = this.order.length;
    this.order = this.order.filter((id) => this.library.tracks.has(id));
    this.state.queue = this.state.queue.filter((id) => this.library.tracks.has(id));
    if (currentId) {
      const idx = this.order.indexOf(currentId);
      if (idx >= 0) this.orderPos = idx;
    }
    if (!this.order.length) {
      this.refreshOrder({ keepCurrent: true });
    } else if (before !== this.order.length) {
      this.schedulePreload();
    }
    this.publish();
  }

  setSource(sourceId, { autoplay = true, startIndex = null } = {}) {
    const pl = this.playlists.get(sourceId);
    if (!pl) return false;
    this.state.sourceId = pl.id;
    this.state.sourceName = pl.name;
    this.order = this.buildOrder();
    this.orderPos = -1;
    if (this.order.length && autoplay) {
      let pos = 0;
      if (startIndex !== null) {
        const ids = this.playlists.trackIdsOf(sourceId);
        const wanted = ids[startIndex];
        const idx = this.order.indexOf(wanted);
        pos = idx >= 0 ? idx : 0;
      }
      this.playAt(pos);
    } else {
      this.publish();
    }
    return true;
  }

  // ------------------------------------------------------------------ أوامر

  playAt(orderPos) {
    if (!this.order.length) {
      this.order = this.buildOrder();
    }
    if (!this.order.length) {
      this.state.status = 'stopped';
      this.state.currentId = null;
      this.publish();
      return false;
    }
    const pos = ((orderPos % this.order.length) + this.order.length) % this.order.length;
    this.orderPos = pos;
    return this.startTrack(this.order[pos]);
  }

  startTrack(id, { addToHistory = true } = {}) {
    const track = this.library.get(id);
    if (!track) return false;
    if (addToHistory && this.state.currentId && this.state.currentId !== id) {
      this.history.push(this.state.currentId);
      if (this.history.length > 100) this.history.shift();
    }
    this.state.currentId = id;
    this.state.position = 0;
    this.state.duration = track.duration || 0;
    this.state.status = 'playing';
    this.state.lastError = null;
    this.clearAutoPause({ silent: true });
    this.library.markPlayed(id);
    this.command('load', { id, url: this.urlFor(id), startAt: 0, autoplay: true });
    this.schedulePreload();
    this.publish();
    return true;
  }

  play() {
    if (this.state.autoPause) this.clearAutoPause();
    if (!this.state.currentId) {
      if (!this.order.length) this.refreshOrder({ keepCurrent: false });
      return this.playAt(0);
    }
    this.state.status = 'playing';
    this.command('play', { fadeMs: 400 });
    this.schedulePreload();
    this.publish();
    return true;
  }

  pause() {
    this.state.status = 'paused';
    this.command('pause', { fadeMs: 400 });
    this.publish();
    return true;
  }

  toggle() {
    return this.state.status === 'playing' ? this.pause() : this.play();
  }

  stop() {
    this.state.status = 'stopped';
    this.state.position = 0;
    this.command('stop', {});
    this.publish();
  }

  next({ manual = true } = {}) {
    // 1) قائمة "التالي" لها الأولوية دائمًا
    if (this.state.queue.length) {
      const id = this.state.queue.shift();
      this.pendingNext = null;
      return this.startTrack(id);
    }
    // 2) تكرار الأغنية نفسها (عند الانتهاء الطبيعي فقط)
    if (!manual && this.state.repeat === 'one' && this.state.currentId) {
      return this.startTrack(this.state.currentId, { addToHistory: false });
    }
    if (!this.order.length) this.refreshOrder({ keepCurrent: false });
    if (!this.order.length) {
      this.stop();
      return false;
    }
    const nextPos = this.orderPos + 1;
    if (nextPos >= this.order.length) {
      if (this.state.repeat === 'off' && !manual) {
        this.stop();
        return false;
      }
      // نهاية القائمة: نعيد الخلط ونبدأ من جديد
      if (this.state.shuffle) this.order = shuffled(this.playlists.trackIdsOf(this.state.sourceId));
      return this.playAt(0);
    }
    return this.playAt(nextPos);
  }

  previous() {
    if (this.state.position > 4) {
      this.seek(0);
      return true;
    }
    if (this.history.length) {
      const id = this.history.pop();
      const idx = this.order.indexOf(id);
      if (idx >= 0) this.orderPos = idx;
      return this.startTrack(id, { addToHistory: false });
    }
    return this.playAt(this.orderPos - 1);
  }

  seek(seconds) {
    const sec = Math.max(0, Number(seconds) || 0);
    this.state.position = sec;
    this.command('seek', { sec });
    this.publish();
  }

  setVolume(value, { fadeMs = 250 } = {}) {
    this.state.volume = clamp01(value);
    this.settings.volume = this.state.volume;
    this.command('volume', { value: this.effectiveVolume(), fadeMs });
    this.emit('settings-changed');
    this.publish();
  }

  setMuted(muted) {
    this.state.muted = !!muted;
    this.command('volume', { value: this.effectiveVolume(), fadeMs: 200 });
    this.publish();
  }

  effectiveVolume() {
    if (this.state.muted) return 0;
    if (this.state.autoPause && this.state.autoPause.mode === 'lower') {
      return clamp01(this.settings.prayer?.lowerVolume ?? 0.12);
    }
    return this.state.volume;
  }

  setShuffle(on) {
    this.state.shuffle = !!on;
    this.settings.shuffle = this.state.shuffle;
    this.refreshOrder({ keepCurrent: true });
    this.emit('settings-changed');
    this.publish();
  }

  setRepeat(mode) {
    if (!['off', 'all', 'one'].includes(mode)) return;
    this.state.repeat = mode;
    this.settings.repeat = mode;
    this.emit('settings-changed');
    this.publish();
  }

  // ------------------------------------------------------------ قائمة التالي

  playNow(trackId) {
    if (!this.library.tracks.has(trackId)) return false;
    const idx = this.order.indexOf(trackId);
    if (idx >= 0) this.orderPos = idx;
    return this.startTrack(trackId);
  }

  enqueueNext(trackId) {
    if (!this.library.tracks.has(trackId)) return false;
    this.state.queue.unshift(trackId);
    this.schedulePreload();
    this.publish();
    return true;
  }

  enqueue(trackIds) {
    const ids = (Array.isArray(trackIds) ? trackIds : [trackIds]).filter((id) => this.library.tracks.has(id));
    this.state.queue.push(...ids);
    this.schedulePreload();
    this.publish();
    return ids.length;
  }

  removeFromQueue(index) {
    if (index < 0 || index >= this.state.queue.length) return false;
    this.state.queue.splice(index, 1);
    this.schedulePreload();
    this.publish();
    return true;
  }

  moveInQueue(from, to) {
    const q = this.state.queue;
    if (from < 0 || from >= q.length || to < 0 || to >= q.length) return false;
    const [moved] = q.splice(from, 1);
    q.splice(to, 0, moved);
    this.schedulePreload();
    this.publish();
    return true;
  }

  clearQueue() {
    this.state.queue = [];
    this.schedulePreload();
    this.publish();
  }

  // ------------------------------------------------------- الإيقاف التلقائي

  /** إيقاف/خفض تلقائي (الصلاة أو الجدولة). */
  setAutoPause({ reason, label, until, mode }) {
    const useMode = mode || 'pause';
    this.state.autoPause = {
      reason,
      label,
      until,
      mode: useMode,
      startedAt: Date.now(),
      wasPlaying: this.state.status === 'playing'
    };
    if (useMode === 'lower') {
      this.command('volume', { value: this.effectiveVolume(), fadeMs: 3000 });
    } else if (this.state.status === 'playing') {
      this.state.status = 'paused';
      this.command('pause', { fadeMs: 3000 });
    }
    this.publish();
    this.emit('auto-pause', this.state.autoPause);
  }

  clearAutoPause({ resume = false, silent = false } = {}) {
    if (!this.state.autoPause) return;
    const was = this.state.autoPause;
    this.state.autoPause = null;
    this.command('volume', { value: this.effectiveVolume(), fadeMs: 3000 });
    if (resume && was.mode === 'pause' && was.wasPlaying && this.state.currentId) {
      this.state.status = 'playing';
      this.command('play', { fadeMs: 3000 });
    }
    if (!silent) this.publish();
  }

  // -------------------------------------------------- أحداث قادمة من المشغّل

  onRendererEvent(event) {
    switch (event.type) {
      case 'status': {
        if (typeof event.position === 'number') this.state.position = event.position;
        if (event.duration) this.state.duration = event.duration;
        if (event.id && event.id === this.state.currentId && event.status) {
          if (event.status === 'playing' || event.status === 'paused') this.state.status = event.status;
        }
        this.saveState();
        this.publish({ light: true });
        break;
      }
      case 'started': {
        // انتقلت الأغنية المحمّلة مسبقًا (crossfade)
        if (this.pendingNext && this.pendingNext.id === event.id) {
          this.commitPending();
        }
        break;
      }
      case 'ended': {
        if (this.pendingNext && this.pendingNext.id) {
          this.commitPending();
        } else {
          this.next({ manual: false });
        }
        break;
      }
      case 'error': {
        console.error(`[player] خطأ في تشغيل ${event.id}: ${event.message}`);
        this.state.lastError = { id: event.id, message: event.message, at: Date.now() };
        this.publish();
        // نتجاوز الملف التالف حتى لا تتوقف الموسيقى
        setTimeout(() => this.next({ manual: false }), 500);
        break;
      }
      default:
        break;
    }
  }

  commitPending() {
    const pending = this.pendingNext;
    this.pendingNext = null;
    if (!pending) return;
    if (pending.fromQueue) {
      const idx = this.state.queue.indexOf(pending.id);
      if (idx >= 0) this.state.queue.splice(idx, 1);
    } else if (typeof pending.orderPos === 'number') {
      this.orderPos = pending.orderPos;
      if (pending.reshuffle) this.order = pending.reshuffledOrder;
    }
    if (this.state.currentId) {
      this.history.push(this.state.currentId);
      if (this.history.length > 100) this.history.shift();
    }
    const track = this.library.get(pending.id);
    this.state.currentId = pending.id;
    this.state.position = 0;
    this.state.duration = track ? track.duration || 0 : 0;
    this.state.status = 'playing';
    this.library.markPlayed(pending.id);
    this.schedulePreload();
    this.publish();
  }

  /** يخبر المشغّل بالأغنية التالية ليجهّزها ويمزجها بسلاسة. */
  schedulePreload() {
    const next = this.peekNext();
    this.pendingNext = next;
    const crossfade = Number(this.settings.crossfadeSec) || 0;
    this.command('preload', {
      id: next ? next.id : null,
      url: next ? this.urlFor(next.id) : null,
      crossfadeSec: crossfade
    });
  }

  peekNext() {
    if (this.state.queue.length) {
      return { id: this.state.queue[0], fromQueue: true };
    }
    if (this.state.repeat === 'one' && this.state.currentId) {
      return { id: this.state.currentId, orderPos: this.orderPos, repeatOne: true };
    }
    if (!this.order.length) return null;
    const nextPos = this.orderPos + 1;
    if (nextPos < this.order.length) {
      return { id: this.order[nextPos], orderPos: nextPos };
    }
    if (this.state.repeat === 'off') return null;
    const reshuffled = this.state.shuffle ? shuffled(this.playlists.trackIdsOf(this.state.sourceId)) : this.order;
    if (!reshuffled.length) return null;
    return { id: reshuffled[0], orderPos: 0, reshuffle: this.state.shuffle, reshuffledOrder: reshuffled };
  }

  // ------------------------------------------------------------------ النشر

  /**
   * التحديث الخفيف (كل ثانية أثناء التشغيل) يرسل الموضع فقط — بضع عشرات من البايتات.
   * الحالة الكاملة تُرسل فقط عند تغيّر حقيقي: أغنية جديدة، أو تعديل قائمة، أو صوت.
   * بدون هذا التفريق كان الجوال يعيد بناء كل القوائم ستين مرة في الدقيقة.
   */
  publish({ light = false } = {}) {
    if (light) {
      this.emit('tick', {
        status: this.state.status,
        position: Math.round(this.state.position * 10) / 10,
        duration: this.state.duration,
        trackId: this.state.currentId
      });
      return;
    }
    this.emit('state', this.publicState());
    this.saveState(true);
  }

  saveState(throttled = true) {
    const snapshot = {
      status: this.state.status,
      currentId: this.state.currentId,
      position: Math.round(this.state.position),
      volume: this.state.volume,
      shuffle: this.state.shuffle,
      repeat: this.state.repeat,
      queue: this.state.queue,
      sourceId: this.state.sourceId,
      order: this.order,
      orderPos: this.orderPos,
      savedAt: Date.now()
    };
    if (throttled) this.stateWriter.queue(snapshot);
    else this.stateWriter.queue(snapshot);
  }

  flush() {
    this.stateWriter.flush();
    this.library.persist();
  }

  publicState() {
    const track = this.state.currentId ? this.library.get(this.state.currentId) : null;
    return {
      status: this.state.status,
      track: track ? publicTrack(track) : null,
      position: Math.round(this.state.position * 10) / 10,
      duration: this.state.duration || (track ? track.duration : 0),
      volume: this.state.volume,
      muted: this.state.muted,
      shuffle: this.state.shuffle,
      repeat: this.state.repeat,
      source: { id: this.state.sourceId, name: this.state.sourceName },
      queue: this.state.queue.map((id) => {
        const t = this.library.get(id);
        return t ? publicTrack(t) : { id, title: 'ملف مفقود', missing: true };
      }),
      upNext: this.upNextPreview(),
      autoPause: this.state.autoPause,
      libraryCount: this.library.tracks.size,
      lastError: this.state.lastError
    };
  }

  /** الأغاني القادمة من القائمة الحالية (بعد قائمة "التالي"). */
  upNextPreview(count = 12) {
    const out = [];
    for (let i = 1; i <= count; i += 1) {
      const pos = this.orderPos + i;
      if (pos >= this.order.length) break;
      const t = this.library.get(this.order[pos]);
      if (t) out.push(publicTrack(t));
    }
    return out;
  }
}

function publicTrack(t) {
  return {
    id: t.id,
    title: t.title,
    artist: t.artist,
    album: t.album,
    duration: t.duration,
    cover: t.cover ? `/api/cover/${t.id}` : null,
    playCount: t.playCount || 0
  };
}

function clamp01(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0.5;
  return Math.min(1, Math.max(0, n));
}

function shuffled(list) {
  const arr = list.slice();
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

module.exports = { Player, publicTrack };
