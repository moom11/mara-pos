'use strict';

/**
 * محرّك الصوت — يعمل داخل نافذة Electron على جهاز الويندوز.
 * لا يقرّر شيئًا بنفسه: ينفّذ أوامر العملية الرئيسية ويرسل لها ما يحدث.
 * يستخدم عنصرَي صوت للمزج السلس بين الأغاني (crossfade).
 */
(function () {
  const A = new Audio();
  const B = new Audio();
  for (const el of [A, B]) {
    el.preload = 'auto';
    el.volume = 0;
  }

  let current = A;
  let standby = B;
  let currentId = null;
  let preloaded = null; // {id, url}
  let crossfadeSec = 3;
  let masterVolume = 0.6;
  let crossfading = false;
  let standbyBusy = false; // العنصر الاحتياطي ما زال يتلاشى من أغنية سابقة
  let queuedPreload = null;
  let fadeTimers = new Map();
  let intent = 'stopped'; // ما طُلب منّا فعله — يمنع اهتزاز الحالة أثناء التلاشي
  let pauseSeq = 0;

  const emit = (event) => window.mara && window.mara.emit(event);

  // --------------------------------------------------------------- التلاشي

  function fadeTo(el, target, ms) {
    const existing = fadeTimers.get(el);
    if (existing) clearInterval(existing);
    if (ms <= 0) {
      el.volume = clamp(target);
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const start = el.volume;
      const startedAt = performance.now();
      const timer = setInterval(() => {
        const t = Math.min(1, (performance.now() - startedAt) / ms);
        el.volume = clamp(start + (target - start) * t);
        if (t >= 1) {
          clearInterval(timer);
          fadeTimers.delete(el);
          resolve();
        }
      }, 40);
      fadeTimers.set(el, timer);
    });
  }

  function clamp(v) {
    return Math.min(1, Math.max(0, Number(v) || 0));
  }

  // ---------------------------------------------------------------- التشغيل

  function safePlay(el) {
    const promise = el.play();
    if (promise && promise.catch) {
      promise.catch((err) => {
        console.warn('تعذّر بدء التشغيل:', err.message);
        emit({ type: 'error', id: currentId, message: err.message });
      });
    }
  }

  function loadTrack({ id, url, startAt = 0, autoplay = true }) {
    intent = autoplay ? 'playing' : 'paused';
    pauseSeq += 1;
    crossfading = false;
    standbyBusy = false;
    queuedPreload = null;
    preloaded = null;
    cancelFades();
    standby.pause();
    standby.removeAttribute('src');
    standby.load();

    currentId = id;
    current.pause();
    current.src = url;
    current.load();

    const onMeta = () => {
      current.removeEventListener('loadedmetadata', onMeta);
      if (startAt > 0 && startAt < (current.duration || Infinity)) {
        try { current.currentTime = startAt; } catch (_) { /* تجاهل */ }
      }
      if (autoplay) {
        current.volume = 0;
        safePlay(current);
        fadeTo(current, masterVolume, 600);
      } else {
        current.volume = masterVolume;
      }
      report();
    };
    current.addEventListener('loadedmetadata', onMeta);
  }

  function applyPreload(command) {
    crossfadeSec = Number(command.crossfadeSec) || 0;
    if (!command.id || !command.url) {
      preloaded = null;
      standby.removeAttribute('src');
      standby.load();
      return;
    }
    if (preloaded && preloaded.id === command.id && standby.src) return;
    preloaded = { id: command.id, url: command.url };
    standby.volume = 0;
    standby.src = command.url;
    standby.load();
  }

  function cancelFades() {
    for (const timer of fadeTimers.values()) clearInterval(timer);
    fadeTimers.clear();
  }

  function startPreloadedNow({ fade }) {
    if (!preloaded) return false;
    const next = standby;
    const previous = current;
    const nextId = preloaded.id;

    next.volume = 0;
    safePlay(next);
    crossfading = true;
    intent = 'playing';
    pauseSeq += 1;

    const ms = fade ? Math.max(600, crossfadeSec * 1000) : 250;
    standbyBusy = true;
    fadeTo(next, masterVolume, ms);
    fadeTo(previous, 0, ms).then(() => {
      previous.pause();
      try {
        previous.currentTime = 0;
      } catch (_) { /* تجاهل */ }
      previous.removeAttribute('src');
      previous.load();
      crossfading = false;
      standbyBusy = false;
      // الأمر الذي وصل أثناء المزج يُطبَّق الآن بأمان
      if (queuedPreload) {
        const command = queuedPreload;
        queuedPreload = null;
        applyPreload(command);
      }
    });

    // تبديل الأدوار
    current = next;
    standby = previous;
    currentId = nextId;
    preloaded = null;
    emit({ type: 'started', id: nextId });
    report();
    return true;
  }

  // ------------------------------------------------------------ المراقبة

  function attachHandlers(el) {
    el.addEventListener('ended', () => {
      if (el !== current) return;
      if (crossfading) return; // المزج تكفّل بالانتقال
      if (preloaded && standby.src && standby.readyState >= 2) {
        startPreloadedNow({ fade: false });
      } else {
        emit({ type: 'ended', id: currentId });
      }
    });

    el.addEventListener('timeupdate', () => {
      if (el !== current || crossfading) return;
      const duration = el.duration;
      if (!Number.isFinite(duration) || duration <= 0) return;
      const remaining = duration - el.currentTime;
      if (crossfadeSec > 0 && remaining <= crossfadeSec && preloaded && standby.readyState >= 3 && !el.paused) {
        startPreloadedNow({ fade: true });
      }
    });

    el.addEventListener('error', () => {
      if (el !== current) return;
      const code = el.error ? el.error.code : 0;
      emit({ type: 'error', id: currentId, message: `تعذّر تشغيل الملف (رمز ${code})` });
    });
  }

  attachHandlers(A);
  attachHandlers(B);

  function report() {
    emit({
      type: 'status',
      id: currentId,
      status: intent === 'playing' ? (current.paused ? 'paused' : 'playing') : intent,
      position: Number.isFinite(current.currentTime) ? current.currentTime : 0,
      duration: Number.isFinite(current.duration) ? current.duration : 0
    });
  }

  setInterval(report, 1000);

  // ------------------------------------------------------------- الأوامر

  window.mara &&
    window.mara.onCommand((command) => {
      if (!command || !command.type) return;
      switch (command.type) {
        case 'load':
          loadTrack(command);
          break;

        case 'preload':
          if (standbyBusy) {
            queuedPreload = command;
            return;
          }
          applyPreload(command);
          break;

        case 'play':
          if (!current.src) {
            emit({ type: 'error', id: currentId, message: 'لا يوجد ملف محمّل' });
            return;
          }
          intent = 'playing';
          pauseSeq += 1;
          current.volume = 0;
          safePlay(current);
          fadeTo(current, masterVolume, command.fadeMs ?? 400);
          report();
          break;

        case 'pause': {
          intent = 'paused';
          const seq = (pauseSeq += 1);
          report();
          fadeTo(current, 0, command.fadeMs ?? 400).then(() => {
            if (seq !== pauseSeq) return; // وصل أمر تشغيل أثناء التلاشي
            current.pause();
            report();
          });
          break;
        }

        case 'stop':
          intent = 'stopped';
          pauseSeq += 1;
          cancelFades();
          current.pause();
          standby.pause();
          try { current.currentTime = 0; } catch (_) { /* تجاهل */ }
          report();
          break;

        case 'seek':
          try {
            current.currentTime = Math.max(0, Number(command.sec) || 0);
          } catch (_) { /* تجاهل */ }
          report();
          break;

        case 'volume':
          masterVolume = clamp(command.value);
          // العنصر المتوقّف يبقى عند صفر — أمر التشغيل يرفعه تدريجيًا
          if (!current.paused) fadeTo(current, masterVolume, command.fadeMs ?? 250);
          break;

        default:
          break;
      }
    });

  let announced = false;
  function announceReady() {
    if (announced) return;
    announced = true;
    window.mara && window.mara.ready();
  }
  window.addEventListener('DOMContentLoaded', announceReady);
  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    announceReady();
  }
})();
