'use strict';

const { EventEmitter } = require('events');
const { readJSON, DebouncedWriter } = require('./store');
const { ALL_TRACKS_ID } = require('./playlists');

/** مستوى الجهارة المستهدف للتسوية — نخفض الأعلى منه ولا نرفع الأدنى تفاديًا للتشويه. */
const AUTO_LEVEL_TARGET_DB = -16;

const DJ_DEFAULTS = {
  enabled: false,
  autoMix: true,
  analyze: true, // تحليل الموجة الصوتية في الخلفية
  autoLevel: true, // تسوية جهارة الأغاني اعتمادًا على التحليل
  smartMix: true, // استخدام نقاط التحليل بدل الأرقام الثابتة
  everyMin: 0, // 0 = معطّل؛ وإلا أقصى مدة تُعزف من أي أغنية قبل الانتقال
  mixAtSec: 12,
  skipIntroSec: 0,
  sweep: true,
  echoOnMix: true,
  dropBuildSec: 4
};

/** ما يُحفَظ في الإعدادات — دون الفلتر والصدى اللحظيين. */
const DJ_PERSISTED = Object.keys(DJ_DEFAULTS);

/**
 * محرّك التشغيل: هذا هو "مصدر الحقيقة" الوحيد.
 * الجوال والمتصفح مجرد أدوات تحكّم — إغلاقها لا يوقف الموسيقى.
 * التشغيل الفعلي للصوت يتم في نافذة Electron (renderer) عبر أوامر يرسلها هذا الملف.
 */
class Player extends EventEmitter {
  constructor({ library, playlists, settings, fx = null }) {
    super();
    this.library = library;
    this.playlists = playlists;
    this.settings = settings;
    this.fx = fx;
    this.activeFx = new Set();

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
      stream: null, // بث مباشر قيد التشغيل: {id, name, url}
      loop: null, // لوب مقطع داخل الأغنية الحالية: {start, end|null}
      lastError: null
    };

    // تحليل الأغاني: طابور خلفي يعمل أغنية واحدة في كل مرة
    this.analysisQueue = [];
    this.analysisBusy = false;
    this.library.on('changed', () => {
      setTimeout(() => this.startAnalysis(), 2000);
    });
    this.streamRetries = 0;

    // مود الديجي — الفلتر والصدى لحظيان: لا يُحفظان حتى لا يبدأ اليوم بصوت مكتوم
    this.dj = {
      ...DJ_DEFAULTS,
      ...(settings.dj || {}),
      filter: 0,
      echo: false
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

    // بثّ كان يعمل قبل إعادة التشغيل — نستأنفه كما هو
    if (saved.stream && saved.stream.url && saved.currentId && String(saved.currentId).startsWith('stream:')) {
      this.state.stream = saved.stream;
      this.state.currentId = saved.currentId;
      this.state.duration = 0;
      this.state.position = 0;
      this.resumeOnBoot = saved.status === 'playing';
      console.log(`[player] استُعيد البث المباشر: ${saved.stream.name}`);
      return;
    }

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

  attachRenderer(sendFn, { streamBase, streamSuffix = '', fxBase = '' }) {
    this.send = sendFn;
    this.streamBase = streamBase;
    this.streamSuffix = streamSuffix;
    this.fxBase = fxBase;
    this.rendererReady = true;
    this.command('volume', { value: this.effectiveVolume(), fadeMs: 0 });
    this.command('dj', { config: this.dj, fadeMs: 0 });
    this.pushFx();
    if (this.state.currentId) {
      this.command('load', {
        id: this.state.currentId,
        url: this.currentUrl(),
        startAt: this.state.stream ? 0 : this.state.position,
        autoplay: !!this.resumeOnBoot,
        gain: this.gainFor(this.library.get(this.state.currentId))
      });
      if (this.resumeOnBoot) this.state.status = 'playing';
      this.resumeOnBoot = false;
      this.schedulePreload();
    }
    // التحليل ينتظر حتى يستقر التشغيل — الإقلاع أولى بالمعالج
    setTimeout(() => this.startAnalysis(), 8000);
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

  /** رابط ما يُشغَّل الآن: ملف محلي أو بث مباشر. */
  currentUrl() {
    if (this.state.stream) return this.state.stream.url;
    return this.urlFor(this.state.currentId);
  }

  // ------------------------------------------------------------ البث المباشر

  /**
   * تشغيل بث مباشر (إذاعة أو خدمة بث). لا مساحة تخزين ولا مزج،
   * ومع انقطاع الشبكة يُعاد الاتصال تلقائيًا ثم تُستأنف المكتبة المحلية.
   */
  playStream(stream) {
    if (!stream || !stream.url) return false;
    this.state.stream = { id: stream.id, name: stream.name, url: stream.url };
    this.state.currentId = `stream:${stream.id}`;
    this.state.position = 0;
    this.state.duration = 0;
    this.state.status = 'playing';
    this.state.lastError = null;
    this.streamRetries = 0;
    this.pendingNext = null;
    this.clearAutoPause({ silent: true });
    this.command('load', { id: this.state.currentId, url: stream.url, startAt: 0, autoplay: true });
    this.command('preload', { id: null, url: null, crossfadeSec: 0 }); // لا مزج مع البث
    this.resetMixTimer(); // البث لا سقف زمني له
    this.publish();
    return true;
  }

  /** يترك البث ويعود للمكتبة المحلية. */
  leaveStream() {
    if (!this.state.stream) return false;
    this.state.stream = null;
    this.streamRetries = 0;
    return true;
  }

  handleStreamFailure(message) {
    if (!this.state.stream) return;
    this.streamRetries += 1;
    if (this.streamRetries > 5) {
      console.warn(`[player] تعذّر الاتصال بالبث "${this.state.stream.name}" — العودة للمكتبة المحلية`);
      this.state.lastError = { message: `انقطع البث "${this.state.stream.name}" — رجعنا للمكتبة`, at: Date.now() };
      this.leaveStream();
      this.next({ manual: false });
      return;
    }
    const delay = Math.min(30000, 2000 * this.streamRetries);
    console.warn(`[player] انقطع البث (${message}) — إعادة المحاولة بعد ${delay / 1000}s`);
    setTimeout(() => {
      if (!this.state.stream) return;
      this.command('load', { id: this.state.currentId, url: this.state.stream.url, startAt: 0, autoplay: true });
    }, delay);
  }

  /** استئناف التشغيل: البث يُعاد تحميله لأن ما خُزّن منه صار قديمًا. */
  resumePlayback(fadeMs = 400) {
    if (this.state.stream) {
      this.command('load', { id: this.state.currentId, url: this.state.stream.url, startAt: 0, autoplay: true });
    } else {
      this.command('play', { fadeMs });
    }
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
    this.leaveStream();
    if (addToHistory && this.state.currentId && this.state.currentId !== id) {
      this.history.push(this.state.currentId);
      if (this.history.length > 100) this.history.shift();
    }
    this.state.currentId = id;
    this.state.position = 0;
    this.state.duration = track.duration || 0;
    this.state.status = 'playing';
    this.state.lastError = null;
    this.state.loop = null; // اللوب يخص أغنية بعينها
    this.clearAutoPause({ silent: true });
    this.library.markPlayed(id);
    this.command('load', { id, url: this.urlFor(id), startAt: 0, autoplay: true, gain: this.gainFor(track) });
    this.schedulePreload();
    this.resetMixTimer();
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
    this.resumePlayback(400);
    if (!this.state.stream) this.schedulePreload();
    this.resetMixTimer();
    this.publish();
    return true;
  }

  pause() {
    this.state.status = 'paused';
    this.command('pause', { fadeMs: 400 });
    this.resetMixTimer();
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
    this.resetMixTimer();
    this.publish();
  }

  next({ manual = true } = {}) {
    // 1) قائمة "التالي" لها الأولوية دائمًا
    if (this.state.queue.length) {
      const id = this.state.queue.shift();
      this.pendingNext = null;
      return this.startTrack(id);
    }
    // 2) لو كان يعمل بثّ مباشر، "التالي" يعني العودة للمكتبة المحلية
    if (this.state.stream) {
      this.leaveStream();
      return this.playAt(this.orderPos >= 0 ? this.orderPos : 0);
    }
    // 3) تكرار الأغنية نفسها (عند الانتهاء الطبيعي فقط)
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
      if (this.state.shuffle) this.order = this.reshuffleAvoidingCurrent();
      return this.playAt(0);
    }
    return this.playAt(nextPos);
  }

  previous() {
    if (this.state.stream) {
      this.leaveStream();
      return this.playAt(this.orderPos >= 0 ? this.orderPos : 0);
    }
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

  // ---------------------------------------------------------- مود الديجي

  /**
   * يضبط إعدادات الديجي ويبلّغ المحرّك بها.
   * الفلتر والصدى لحظيّان (لا يُحفظان)؛ البقية تُحفظ في الإعدادات.
   */
  setDj(patch = {}) {
    const before = this.dj.enabled;
    if (typeof patch.enabled === 'boolean') this.dj.enabled = patch.enabled;
    if (typeof patch.autoMix === 'boolean') this.dj.autoMix = patch.autoMix;
    if (typeof patch.analyze === 'boolean') this.dj.analyze = patch.analyze;
    if (typeof patch.autoLevel === 'boolean') this.dj.autoLevel = patch.autoLevel;
    if (typeof patch.smartMix === 'boolean') this.dj.smartMix = patch.smartMix;
    if (typeof patch.sweep === 'boolean') this.dj.sweep = patch.sweep;
    if (typeof patch.echoOnMix === 'boolean') this.dj.echoOnMix = patch.echoOnMix;
    if (typeof patch.echo === 'boolean') this.dj.echo = patch.echo;
    if (patch.everyMin !== undefined) this.dj.everyMin = clampRange(patch.everyMin, 0, 30, 0);
    if (patch.mixAtSec !== undefined) this.dj.mixAtSec = clampRange(patch.mixAtSec, 2, 20, 12);
    if (patch.skipIntroSec !== undefined) this.dj.skipIntroSec = clampRange(patch.skipIntroSec, 0, 30, 0);
    if (patch.dropBuildSec !== undefined) this.dj.dropBuildSec = clampRange(patch.dropBuildSec, 1, 12, 4);
    if (patch.filter !== undefined) this.dj.filter = clampRange(patch.filter, -100, 100, 0);

    // إطفاء المود يُرجع الصوت طبيعيًا فورًا — لا يترك المحل على فلتر مكتوم
    if (before && !this.dj.enabled) {
      this.dj.filter = 0;
      this.dj.echo = false;
    }

    const persisted = { ...(this.settings.dj || {}) };
    for (const key of DJ_PERSISTED) persisted[key] = this.dj[key];
    this.settings.dj = persisted;
    this.command('dj', { config: this.dj });
    if (this.dj.analyze !== false) setTimeout(() => this.startAnalysis(), 500);
    this.resetMixTimer();
    this.emit('settings-changed');
    this.publish();
    return this.dj;
  }

  /**
   * سقف زمني لكل أغنية: بعد `everyMin` دقيقة من بدايتها ينتقل حتمًا،
   * فلا تُعزف أغنية طويلة كاملة. المؤقّت يُحسب من موضع التشغيل الحالي
   * حتى يبقى صحيحًا بعد الإيقاف والاستئناف والتقديم.
   */
  resetMixTimer() {
    if (this.mixTimer) {
      clearTimeout(this.mixTimer);
      this.mixTimer = null;
    }
    const minutes = Number(this.dj.everyMin) || 0;
    if (!this.dj.enabled || minutes <= 0) return;
    if (this.state.stream || this.state.status !== 'playing') return;
    if (this.state.loop) return; // لوب مقصود لا يقطعه مؤقّت

    const remaining = minutes * 60000 - Math.max(0, this.state.position * 1000);
    this.mixTimer = setTimeout(() => {
      this.mixTimer = null;
      this.djNext();
    }, Math.max(1000, remaining));
    if (this.mixTimer.unref) this.mixTimer.unref();
  }

  /** انتقال ممزوج بمؤثرات. يسقط تلقائيًا لانتقال عادي إن لم يكن المود مفعّلًا. */
  djNext() {
    if (!this.dj.enabled || this.state.stream || !this.pendingNext) {
      return this.next({ manual: true });
    }
    this.command('dj-mix', {});
    return true;
  }

  djDrop() {
    if (!this.dj.enabled) return false;
    this.command('dj-drop', { buildSec: this.dj.dropBuildSec });
    return true;
  }

  // ------------------------------------------------------- تحليل الأغاني

  /**
   * يحلّل أغنية واحدة في كل مرة في الخلفية. التحليل يفكّ ترميز الملف كاملًا،
   * فتشغيل عدة تحليلات معًا يلتهم الذاكرة ويربك الصوت على جهاز ضعيف.
   */
  startAnalysis() {
    if (this.analysisBusy || !this.rendererReady) return;
    if (this.dj.analyze === false) return;

    if (!this.analysisQueue.length) {
      this.analysisQueue = this.library.pendingAnalysis();
      if (!this.analysisQueue.length) return;
      console.log(`[analysis] ${this.analysisQueue.length} أغنية بانتظار التحليل`);
    }

    while (this.analysisQueue.length) {
      const id = this.analysisQueue.shift();
      if (!this.library.get(id)) continue;
      this.analysisBusy = true;
      this.command('analyze', { id, url: this.urlFor(id) });
      return;
    }
  }

  onAnalysis(event) {
    this.analysisBusy = false;
    if (event.busy) {
      // المحرّك كان مشغولًا — نعيدها للطابور بدل تسجيلها كفاشلة
      this.analysisQueue.unshift(event.id);
    } else if (event.ok) {
      this.library.setAnalysis(event.id, event.data);
      // الأغنية قيد التشغيل أو التالية تأثّرت نقاط مزجها
      this.schedulePreload();
    } else {
      console.warn(`[analysis] تعذّر تحليل ${event.id}: ${event.message}`);
      this.library.setAnalysis(event.id, null);
    }
    setTimeout(() => this.startAnalysis(), event.busy ? 4000 : 1200);
  }

  /** معامل تسوية الجهارة لأغنية — نخفض العالية ولا نرفع الخافتة. */
  gainFor(track) {
    if (this.dj.autoLevel === false) return 1;
    const analysis = track && track.analysis;
    if (!analysis || analysis.failed || !Number.isFinite(analysis.loudnessDb)) return 1;
    const gain = Math.pow(10, (AUTO_LEVEL_TARGET_DB - analysis.loudnessDb) / 20);
    return Math.min(1, Math.max(0.4, Math.round(gain * 100) / 100));
  }

  /** تحليل صالح لأغنية، أو null إن لم يوجد أو عُطّل المزج الذكي. */
  analysisOf(id) {
    if (this.dj.smartMix === false) return null;
    const track = id ? this.library.get(id) : null;
    const analysis = track && track.analysis;
    return analysis && !analysis.failed ? analysis : null;
  }

  // ---------------------------------------------------------- لوب المقطع

  /**
   * زر واحد يدور: تحديد البداية ← تحديد النهاية وتشغيل اللوب ← خروج.
   * المنطق هنا لا في الجوال، فكل الأجهزة ترى نفس الحالة.
   */
  toggleLoopPoint() {
    if (this.state.stream || !this.state.currentId) return false;
    const position = Math.round(Math.max(0, this.state.position) * 10) / 10;
    const loop = this.state.loop;

    if (!loop) {
      this.state.loop = { start: position, end: null };
    } else if (loop.end === null) {
      if (position - loop.start < 1) return false; // مقطع أقصر من ثانية بلا معنى
      loop.end = position;
      this.command('loop-set', { start: loop.start, end: loop.end });
    } else {
      return this.clearLoop();
    }
    this.resetMixTimer();
    this.publish();
    return true;
  }

  clearLoop({ silent = false } = {}) {
    if (!this.state.loop) return false;
    this.state.loop = null;
    this.command('loop-clear', {});
    if (!silent) {
      this.resetMixTimer();
      this.publish();
    }
    return true;
  }

  // ---------------------------------------------------------- مؤثرات مارا

  /** يسلّم المحرّك قائمة المؤثرات ليجهّزها في الذاكرة قبل أول ضغطة. */
  pushFx() {
    if (!this.fx) return;
    this.command('fx-set', {
      items: this.fx.list().map((item) => ({
        id: item.id,
        name: item.name,
        kind: item.kind,
        loop: item.loop,
        gain: item.gain,
        url: `${this.fxBase}${item.id}/audio${this.streamSuffix || ''}`
      }))
    });
  }

  playFx(id) {
    if (!this.fx || !this.fx.get(id)) return false;
    this.command('fx-play', { id });
    return true;
  }

  stopFx(id) {
    this.command('fx-stop', { id });
    return true;
  }

  stopAllFx() {
    this.command('fx-stop-all', {});
    if (this.activeFx.size) {
      this.activeFx.clear();
      this.publish();
    }
    return true;
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
      this.resumePlayback(3000);
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
        // البث المباشر لا "ينتهي" — انتهاؤه يعني انقطاع الشبكة
        if (this.state.stream) {
          this.handleStreamFailure('انتهى البث');
          break;
        }
        if (this.pendingNext && this.pendingNext.id) {
          this.commitPending();
        } else {
          this.next({ manual: false });
        }
        break;
      }
      case 'analysis': {
        this.onAnalysis(event);
        break;
      }
      case 'fx-started': {
        if (event.id && !this.activeFx.has(event.id)) {
          this.activeFx.add(event.id);
          this.publish();
        }
        break;
      }
      case 'fx-ended':
      case 'fx-error': {
        if (event.message) console.warn(`[fx] ${event.id}: ${event.message}`);
        if (event.id && this.activeFx.delete(event.id)) this.publish();
        break;
      }
      case 'dj-mix-failed': {
        // الأغنية التالية لم تكن جاهزة — ننتقل بالطريقة العادية بدل ترك الصمت
        this.next({ manual: true });
        break;
      }
      case 'error': {
        console.error(`[player] خطأ في تشغيل ${event.id}: ${event.message}`);
        if (this.state.stream) {
          this.handleStreamFailure(event.message);
          this.publish();
          break;
        }
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
    this.state.loop = null;
    this.library.markPlayed(pending.id);
    this.schedulePreload();
    this.resetMixTimer();
    this.publish();
  }

  /** يخبر المشغّل بالأغنية التالية ليجهّزها ويمزجها بسلاسة. */
  schedulePreload() {
    if (this.state.stream) {
      // لا تحميل مسبق ولا مزج أثناء البث المباشر
      this.pendingNext = null;
      this.command('preload', { id: null, url: null, crossfadeSec: 0 });
      return;
    }
    const next = this.peekNext();
    this.pendingNext = next;
    const crossfade = Number(this.settings.crossfadeSec) || 0;
    const currentAnalysis = this.analysisOf(this.state.currentId);
    const nextAnalysis = next ? this.analysisOf(next.id) : null;
    this.command('preload', {
      id: next ? next.id : null,
      url: next ? this.urlFor(next.id) : null,
      crossfadeSec: crossfade,
      gain: next ? this.gainFor(this.library.get(next.id)) : 1,
      // نقطة هبوط الأغنية الحالية، وموضع بدء القادمة بعد مقدمتها
      mixAtSec: currentAnalysis ? currentAnalysis.outroStartSec : 0,
      nextStartAt: nextAnalysis ? nextAnalysis.introEndSec : 0
    });
  }

  /**
   * خلط جديد عند نهاية القائمة، مع ضمان ألا يبدأ بالأغنية الحالية.
   * بدون هذا الضمان تُعزف الأغنية نفسها مرتين متتاليتين كلما صادف الخلط
   * أن وضعها أولًا — يلاحظه الزبون ويبدو عطلًا.
   */
  reshuffleAvoidingCurrent() {
    const ids = shuffled(this.playlists.trackIdsOf(this.state.sourceId));
    if (ids.length > 1 && ids[0] === this.state.currentId) {
      const swapAt = 1 + Math.floor(Math.random() * (ids.length - 1));
      [ids[0], ids[swapAt]] = [ids[swapAt], ids[0]];
    }
    return ids;
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
    const reshuffled = this.state.shuffle ? this.reshuffleAvoidingCurrent() : this.order;
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
      stream: this.state.stream,
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
    const live = this.state.stream
      ? {
        id: this.state.currentId,
        title: this.state.stream.name,
        artist: 'بثّ مباشر',
        album: '',
        duration: 0,
        cover: null,
        live: true
      }
      : null;
    return {
      status: this.state.status,
      track: live || (track ? publicTrack(track) : null),
      stream: this.state.stream,
      position: Math.round(this.state.position * 10) / 10,
      duration: this.state.duration || (track ? track.duration : 0),
      volume: this.state.volume,
      muted: this.state.muted,
      shuffle: this.state.shuffle,
      repeat: this.state.repeat,
      source: { id: this.state.sourceId, name: this.state.sourceName },
      dj: { ...this.dj },
      loop: this.state.loop,
      analysisPending: this.analysisQueue.length + (this.analysisBusy ? 1 : 0),
      activeFx: [...this.activeFx],
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

function clampRange(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
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
