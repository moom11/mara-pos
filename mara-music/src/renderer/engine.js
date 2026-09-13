'use strict';

/**
 * محرّك الصوت — يعمل داخل نافذة Electron على جهاز الويندوز.
 * لا يقرّر شيئًا بنفسه: ينفّذ أوامر العملية الرئيسية ويرسل لها ما يحدث.
 * يستخدم عنصرَي صوت للمزج السلس بين الأغاني (crossfade)،
 * وعنصرًا ثالثًا مستقلًا للبث المباشر.
 */
(function () {
  const A = new Audio();
  const B = new Audio();
  // البث المباشر مصدره خارجي، ولا يجوز تمريره على معالجات الديجي:
  // الويب أوديو يُسكت أي مصدر من نطاق آخر لا يرسل ترويسات CORS.
  const S = new Audio();
  for (const el of [A, B, S]) {
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

  // ================================================================ الديجي

  const dj = {
    enabled: false,
    autoMix: true,
    mixAtSec: 12,
    skipIntroSec: 0,
    sweep: true,
    echoOnMix: true,
    dropBuildSec: 4,
    filter: 0, // -100 (مكتوم/غائر) .. 0 (طبيعي) .. +100 (رفيع/مشدود)
    echo: false
  };

  // حدود المؤثرات — مضبوطة لمقهى، لا لحفلة: لا تشويه ولا إجهاد للسماعات
  const FX = {
    hpMax: 3200, // أقصى تردد لمرشّح تمرير العالي
    lpMin: 240, // أدنى تردد لمرشّح تمرير المنخفض
    echoWet: 0.3,
    echoTail: 0.4,
    dropHp: 2400,
    sweepTo: 1500
  };

  let ctx = null;
  let nodes = null;
  let graphFailed = false;

  /**
   * يُبنى الرسم الصوتي عند أول حاجة فقط. مساره:
   *   العنصر ← كنس الانتقال ← الناقل ← (مرشّحان) ← ضاغط ← السماعات
   *                                  └── إرسال ← تأخير بتغذية راجعة ← مزيج رطب
   * الضاغط في النهاية يحمي السماعات من قمم المؤثرات.
   */
  function ensureGraph() {
    if (nodes) {
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      return nodes;
    }
    if (graphFailed) return null;
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) {
      graphFailed = true;
      return null;
    }
    try {
      ctx = new AudioCtx();

      const busIn = ctx.createGain();
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 20;
      hp.Q.value = 0.8;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 20000;
      lp.Q.value = 0.8;

      const delay = ctx.createDelay(2);
      delay.delayTime.value = 0.38;
      const feedback = ctx.createGain();
      feedback.gain.value = 0.34;
      const wet = ctx.createGain();
      wet.gain.value = 0;

      const master = ctx.createGain();
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -6;
      comp.knee.value = 12;
      comp.ratio.value = 4;
      comp.attack.value = 0.005;
      comp.release.value = 0.25;

      busIn.connect(hp);
      hp.connect(lp);
      lp.connect(master);

      busIn.connect(delay);
      delay.connect(feedback);
      feedback.connect(delay);
      delay.connect(wet);
      wet.connect(master);

      master.connect(comp);
      comp.connect(ctx.destination);

      nodes = { busIn, hp, lp, delay, feedback, wet, master, comp, per: new Map() };
      attachElement(A);
      attachElement(B);
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      return nodes;
    } catch (err) {
      console.warn('[dj] تعذّر تجهيز معالجة الصوت:', err.message);
      graphFailed = true;
      nodes = null;
      return null;
    }
  }

  function attachElement(element) {
    if (!nodes || nodes.per.has(element)) return;
    try {
      const source = ctx.createMediaElementSource(element);
      const sweep = ctx.createBiquadFilter();
      sweep.type = 'highpass';
      sweep.frequency.value = 20;
      sweep.Q.value = 0.7;
      source.connect(sweep);
      sweep.connect(nodes.busIn);
      nodes.per.set(element, { source, sweep });
    } catch (err) {
      console.warn('[dj] تعذّر ربط عنصر الصوت:', err.message);
    }
  }

  function rampFreq(param, value, seconds) {
    const target = Math.max(20, Math.min(20000, value));
    try {
      param.cancelScheduledValues(ctx.currentTime);
      param.setValueAtTime(Math.max(20, param.value), ctx.currentTime);
      param.exponentialRampToValueAtTime(target, ctx.currentTime + Math.max(0.02, seconds));
    } catch (_) {
      param.value = target;
    }
  }

  function rampGain(param, value, seconds) {
    try {
      param.cancelScheduledValues(ctx.currentTime);
      param.setValueAtTime(param.value, ctx.currentTime);
      param.linearRampToValueAtTime(value, ctx.currentTime + Math.max(0.02, seconds));
    } catch (_) {
      param.value = value;
    }
  }

  const hpForFilter = (f) => (f > 2 ? 20 * Math.pow(FX.hpMax / 20, f / 100) : 20);
  const lpForFilter = (f) => (f < -2 ? 20000 * Math.pow(FX.lpMin / 20000, Math.abs(f) / 100) : 20000);

  function applyFilter(ms = 200) {
    const n = ensureGraph();
    if (!n) return;
    rampFreq(n.hp.frequency, hpForFilter(dj.filter), ms / 1000);
    rampFreq(n.lp.frequency, lpForFilter(dj.filter), ms / 1000);
  }

  function applyEcho(ms = 300) {
    const n = ensureGraph();
    if (!n) return;
    rampGain(n.wet.gain, dj.echo ? FX.echoWet : 0, ms / 1000);
  }

  /** ذيل صدى قصير عند الانتقال — يملأ الفراغ بين الأغنيتين. */
  function echoTail() {
    const n = ensureGraph();
    if (!n || dj.echo) return;
    rampGain(n.wet.gain, FX.echoTail, 0.12);
    setTimeout(() => {
      if (!dj.echo && nodes) rampGain(nodes.wet.gain, 0, 2.4);
    }, 400);
  }

  /** كنس ترددي صاعد على الأغنية الخارجة — التوقيع المميّز لانتقال الديجي. */
  function sweepOut(element, ms) {
    const n = ensureGraph();
    if (!n) return;
    const per = n.per.get(element);
    if (!per) return;
    rampFreq(per.sweep.frequency, FX.sweepTo, ms / 1000);
  }

  function resetSweep(element) {
    if (!nodes) return;
    const per = nodes.per.get(element);
    if (!per) return;
    try {
      per.sweep.frequency.cancelScheduledValues(ctx.currentTime);
      per.sweep.frequency.setValueAtTime(20, ctx.currentTime);
    } catch (_) {
      per.sweep.frequency.value = 20;
    }
  }

  function neutralizeFx() {
    if (!nodes) return;
    rampFreq(nodes.hp.frequency, 20, 0.3);
    rampFreq(nodes.lp.frequency, 20000, 0.3);
    rampGain(nodes.wet.gain, 0, 0.3);
    resetSweep(A);
    resetSweep(B);
  }

  /** شدّ تدريجي ثم انفراج مفاجئ. */
  function drop(buildSec) {
    const n = ensureGraph();
    if (!n) return;
    const build = Math.max(1, Math.min(12, Number(buildSec) || dj.dropBuildSec || 4));
    rampFreq(n.hp.frequency, FX.dropHp, build);
    rampGain(n.wet.gain, FX.echoTail, build);
    setTimeout(() => {
      if (!nodes) return;
      rampFreq(nodes.hp.frequency, hpForFilter(dj.filter), 0.12);
      rampGain(nodes.wet.gain, dj.echo ? FX.echoWet : 0, 0.6);
    }, build * 1000);
  }

  /** طول المزج في مود الديجي: يساوي لحظة البدء حتى تنتهي الخارجة بالضبط مع دخول التالية. */
  const djBlendMs = () => Math.max(2, Math.min(20, Number(dj.mixAtSec) || 12)) * 1000;

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
    const isStream = String(id || '').startsWith('stream:');
    intent = autoplay ? 'playing' : 'paused';
    pauseSeq += 1;
    crossfading = false;
    standbyBusy = false;
    queuedPreload = null;
    preloaded = null;
    cancelFades();

    if (isStream) {
      for (const el of [A, B]) {
        el.pause();
        el.removeAttribute('src');
        el.load();
      }
      current = S;
      standby = B;
    } else {
      S.pause();
      S.removeAttribute('src');
      S.load();
      if (current === S) {
        current = A;
        standby = B;
      }
      standby.pause();
      standby.removeAttribute('src');
      standby.load();
      resetSweep(current);
    }

    currentId = id;
    current.pause();
    current.src = url;
    current.load();

    const element = current;
    const onMeta = () => {
      element.removeEventListener('loadedmetadata', onMeta);
      if (element !== current) return;
      if (startAt > 0 && startAt < (element.duration || Infinity)) {
        try { element.currentTime = startAt; } catch (_) { /* تجاهل */ }
      }
      if (autoplay) {
        element.volume = 0;
        safePlay(element);
        fadeTo(element, masterVolume, 600);
      } else {
        element.volume = masterVolume;
      }
      report();
    };
    element.addEventListener('loadedmetadata', onMeta);
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

  function startPreloadedNow({ fade, mix = false }) {
    if (!preloaded) return false;
    if (current === S) return false; // لا مزج مع البث المباشر
    const next = standby;
    const previous = current;
    const nextId = preloaded.id;

    next.volume = 0;
    if (mix && dj.skipIntroSec > 0) {
      try { next.currentTime = Math.min(dj.skipIntroSec, (next.duration || Infinity) - 5); } catch (_) { /* تجاهل */ }
    }
    resetSweep(next);
    safePlay(next);
    crossfading = true;
    intent = 'playing';
    pauseSeq += 1;

    let ms;
    if (mix) ms = djBlendMs();
    else if (fade) ms = Math.max(600, crossfadeSec * 1000);
    else ms = 250;

    if (mix && dj.sweep) sweepOut(previous, ms);
    if (mix && dj.echoOnMix) echoTail();

    standbyBusy = true;
    fadeTo(next, masterVolume, ms);
    fadeTo(previous, 0, ms).then(() => {
      previous.pause();
      try {
        previous.currentTime = 0;
      } catch (_) { /* تجاهل */ }
      previous.removeAttribute('src');
      previous.load();
      resetSweep(previous);
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
      const mix = dj.enabled && dj.autoMix && el !== S;
      const startAt = mix ? Math.max(crossfadeSec, Number(dj.mixAtSec) || 12) : crossfadeSec;
      if (startAt > 0 && remaining <= startAt && preloaded && standby.readyState >= 3 && !el.paused) {
        startPreloadedNow({ fade: true, mix });
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
  attachHandlers(S);

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

        // ------------------------------------------------------ الديجي

        case 'dj': {
          const config = command.config || {};
          const wasEnabled = dj.enabled;
          for (const key of Object.keys(dj)) {
            if (config[key] !== undefined) dj[key] = config[key];
          }
          if (!dj.enabled) {
            neutralizeFx();
          } else {
            if (!wasEnabled) ensureGraph();
            applyFilter(command.fadeMs ?? 200);
            applyEcho(command.fadeMs ?? 300);
          }
          break;
        }

        case 'dj-mix':
          // لا شيء محمّل مسبقًا (أو نحن على بثّ) — العملية الرئيسية تتولّى الانتقال العادي
          if (!startPreloadedNow({ fade: true, mix: true })) {
            emit({ type: 'dj-mix-failed', id: currentId });
          }
          break;

        case 'dj-drop':
          if (dj.enabled) drop(command.buildSec);
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
