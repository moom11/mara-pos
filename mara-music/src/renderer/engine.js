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

  // تسوية الصوت: معامل لكل أغنية تحسبه العملية الرئيسية من تحليلها
  let currentGain = 1;
  let standbyGain = 1;
  // نقاط مشتقّة من التحليل: أين يبدأ المزج، ومن أين تبدأ الأغنية القادمة
  let mixAtAbs = 0;
  let nextStartAt = 0;
  /*
    قصّ الأغنية: نهاية مبكّرة تُعامل معاملة نهاية الملف. نحفظها للأغنية
    الحالية وللمجهّزة معًا، فالأدوار تتبادل عند المزج ولو كانت واحدة
    لحملت الأغنية القادمة نهاية سابقتها.
  */
  let endAtCurrent = 0;
  let endAtNext = 0;
  let trimEnded = false;
  // لوب المقطع: {start, end} داخل الأغنية الحالية
  let loop = null;

  const levelOf = (el) => (el === current ? currentGain : standbyGain);
  const targetVol = (el) => clamp(masterVolume * levelOf(el));

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
    echo: false,
    pan: false, // تمرير الصوت بين الجانبين
    panSec: 4 // زمن الدورة الكاملة: يسار ← يمين ← يسار
  };

  // حدود المؤثرات — مضبوطة لمقهى، لا لحفلة: لا تشويه ولا إجهاد للسماعات
  const FX = {
    hpMax: 3200, // أقصى تردد لمرشّح تمرير العالي
    lpMin: 240, // أدنى تردد لمرشّح تمرير المنخفض
    echoWet: 0.3,
    echoTail: 0.4,
    dropHp: 2400,
    sweepTo: 1500,
    /*
      لا نمرّر إلى أقصى الجانبين: التمرير الكامل يُسكت جانبًا من الصالة
      تمامًا في نصف الدورة. 0.85 حركة واضحة تُسمع ولا تُفقد أحدًا الموسيقى.
    */
    panDepth: 0.85
  };

  let ctx = null;
  let nodes = null;
  let graphFailed = false;

  // ======================================================= توازن الجانبين

  /*
    سماعات المطعم موزّعة على جانبي الصالة، فجانب قد يحتاج صوتًا أقل من
    الآخر. القيم نسبة لكل جانب، و mono يرسل المزيج كاملًا للجانبين.

    mono ليس ترفًا: مع سماعتين متباعدتين يسمع من يجلس قرب إحداهما نصف
    المزيج فقط — آلة هنا وصوت هناك. جمع القناتين يعطي كل طاولة المزيج
    كاملًا، وهذا ما تفعله أنظمة الصوت في المحال.
  */
  const balance = { left: 1, right: 1, mono: false };

  /** يضبط مصفوفة 2×2: من أي قناة مصدر إلى أي سماعة، وبأي نسبة. */
  function applyBalance(ms = 120) {
    if (!nodes) return;
    const { left, right, mono } = balance;
    // في المونو نقسم على 2: جمع قناتين بكامل نسبتهما يقصّ القمم
    const matrix = mono
      ? { LL: left * 0.5, RL: left * 0.5, LR: right * 0.5, RR: right * 0.5 }
      : { LL: left, RL: 0, LR: 0, RR: right };
    rampGain(nodes.gLL.gain, matrix.LL, ms / 1000);
    rampGain(nodes.gRL.gain, matrix.RL, ms / 1000);
    rampGain(nodes.gLR.gain, matrix.LR, ms / 1000);
    rampGain(nodes.gRR.gain, matrix.RR, ms / 1000);
  }

  function setBalance(config = {}, fadeMs = 120) {
    if (typeof config.left === 'number') balance.left = clamp(config.left);
    if (typeof config.right === 'number') balance.right = clamp(config.right);
    if (typeof config.mono === 'boolean') balance.mono = config.mono;
    // لا جدوى من بناء الرسم الصوتي لإعداد محايد: الوضع الطبيعي أصلًا
    if (!nodes && balance.left === 1 && balance.right === 1 && !balance.mono) return;
    if (!ensureGraph()) return;
    applyBalance(fadeMs);
  }

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

      // ناقل الموسيقى منفصل عن ناقل المؤثرات: الخفض للعبارات يمسّ الموسيقى وحدها
      const musicGain = ctx.createGain();
      const fxGain = ctx.createGain();
      const master = ctx.createGain();
      const comp = ctx.createDynamicsCompressor();
      /*
        حدّاد قمم لا ضاغط عريض.

        كان هنا ضاغط عند -6 بنسبة 4:1 ورُكبة 12، وهذا يعمل على الموسيقى
        العادية طول الوقت لا على القمم وحدها: يخفض كل ما يعلو ثم يرجعه،
        فتضيع حِدّة الطبلة ويبهت الفرق بين الهادئ والقوي — وهو عين ما
        يُسمّيه السامع "صوت مضغوط" مقابل "صفاء".

        غرض هذه الحلقة حماية السماعات من قمم المؤثرات فقط. فالحدّ قريب من
        السقف ونسبته عالية ورُكبته صفر: لا يمسّ الموسيقى إلا حين تقترب
        فعلًا من القصّ. وتسوية الجهارة تُبقي الأغاني أصلًا دون ذلك بكثير،
        فهذه الحلقة تكاد لا تعمل في الليلة العادية.
      */
      comp.threshold.value = -1.5;
      comp.knee.value = 0;
      comp.ratio.value = 20;
      comp.attack.value = 0.003;
      comp.release.value = 0.12;

      // توازن القاعتين: مصفوفة 2×2 بعد الضاغط، فلا يردّ الضاغط على خفض جانب
      const splitter = ctx.createChannelSplitter(2);
      const merger = ctx.createChannelMerger(2);
      const gLL = ctx.createGain();
      const gLR = ctx.createGain();
      const gRL = ctx.createGain();
      const gRR = ctx.createGain();
      gLR.gain.value = 0;
      gRL.gain.value = 0;

      busIn.connect(hp);
      hp.connect(lp);
      lp.connect(musicGain);

      busIn.connect(delay);
      delay.connect(feedback);
      feedback.connect(delay);
      delay.connect(wet);
      wet.connect(musicGain); // الصدى جزء من الموسيقى، فيُخفَض معها

      musicGain.connect(master);
      fxGain.connect(master);
      master.connect(comp);

      comp.connect(splitter);
      splitter.connect(gLL, 0);
      splitter.connect(gLR, 0);
      splitter.connect(gRL, 1);
      splitter.connect(gRR, 1);
      gLL.connect(merger, 0, 0);
      gRL.connect(merger, 0, 0);
      gLR.connect(merger, 0, 1);
      gRR.connect(merger, 0, 1);

      /*
        التمرير بين الجانبين (أوتو بان) آخر حلقة قبل السماعات: يحرّك
        الصوت وحده يمينًا ويسارًا. موضعه بعد مصفوفة التوازن فيبقى
        التوازن محفوظًا: الحركة تُضاف إلى معايرة القاعة لا تُلغيها.
      */
      const panner = ctx.createStereoPanner();
      merger.connect(panner);
      panner.connect(ctx.destination);

      nodes = {
        busIn, hp, lp, delay, feedback, wet, musicGain, fxGain, master, comp,
        splitter, merger, gLL, gLR, gRL, gRR, panner,
        per: new Map()
      };
      applyBalance(0);
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

  // موضع التمرير ليس جهارة، لكن الترقيق نفسه لازم: أي تغيير فوري يُسمع نقرة
  const rampParam = rampGain;

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

  /*
    التمرير بين الجانبين: مذبذب جيبي يحرّك موضع الصوت.

    المذبذب يُنشأ عند التشغيل ويُوقف عند الإطفاء، لأن المذبذب في الويب
    أوديو لا يُعاد تشغيله بعد الإيقاف. ونُخفض العمق تدريجيًا قبل إيقافه
    حتى لا يقفز الصوت إلى الوسط قفزة مسموعة.
  */
  let panLfo = null;
  let panDepthNode = null;

  function stopPanLfo(afterMs) {
    const lfo = panLfo;
    const depth = panDepthNode;
    panLfo = null;
    panDepthNode = null;
    if (!lfo) return;
    setTimeout(() => {
      try { lfo.stop(); } catch (_) { /* تجاهل */ }
      try { lfo.disconnect(); } catch (_) { /* تجاهل */ }
      try { depth.disconnect(); } catch (_) { /* تجاهل */ }
    }, afterMs);
  }

  function applyPan(ms = 400) {
    // الإطفاء لا يستحق بناء الرسم الصوتي: لا شيء يُطفأ أصلًا
    if (!dj.pan && !nodes) return;
    const n = ensureGraph();
    if (!n) return;
    const seconds = Math.max(1, Math.min(12, Number(dj.panSec) || 4));

    if (!dj.pan) {
      if (panDepthNode) rampGain(panDepthNode.gain, 0, ms / 1000);
      rampParam(n.panner.pan, 0, ms / 1000);
      stopPanLfo(ms + 60);
      return;
    }

    if (!panLfo) {
      try {
        panLfo = ctx.createOscillator();
        panLfo.type = 'sine';
        panDepthNode = ctx.createGain();
        panDepthNode.gain.value = 0;
        panLfo.connect(panDepthNode);
        panDepthNode.connect(n.panner.pan);
        panLfo.start();
      } catch (err) {
        console.warn('[dj] تعذّر تجهيز التمرير:', err.message);
        panLfo = null;
        panDepthNode = null;
        return;
      }
    }
    panLfo.frequency.value = 1 / seconds;
    rampGain(panDepthNode.gain, FX.panDepth, ms / 1000);
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
    dj.pan = false;
    applyPan(300);
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

  // ============================================================ مؤثرات مارا

  const DUCK_LEVEL = 0.32; // مستوى الموسيقى أثناء العبارة الصوتية
  const fxItems = new Map(); // id -> {url, kind, loop, gain, name}
  const fxBuffers = new Map(); // id -> AudioBuffer
  const fxActive = new Map(); // id -> {source, gain}
  let duckCount = 0;
  let preloading = false;

  async function fetchBuffer(id) {
    if (fxBuffers.has(id)) return fxBuffers.get(id);
    const item = fxItems.get(id);
    if (!item) return null;
    const n = ensureGraph();
    if (!n) return null;
    const response = await fetch(item.url);
    if (!response.ok) throw new Error(`تعذّر تحميل المؤثر (${response.status})`);
    const bytes = await response.arrayBuffer();
    const buffer = await ctx.decodeAudioData(bytes);
    fxBuffers.set(id, buffer);
    return buffer;
  }

  /** تحميل مسبق هادئ بالتسلسل — أول ضغطة على الزر تكون فورية. */
  async function preloadFx() {
    if (preloading) return;
    preloading = true;
    try {
      for (const id of fxItems.keys()) {
        if (fxBuffers.has(id)) continue;
        try {
          await fetchBuffer(id);
        } catch (err) {
          console.warn(`[fx] تعذّر تجهيز ${id}:`, err.message);
        }
      }
    } finally {
      preloading = false;
    }
  }

  function setDuck(on) {
    const n = ensureGraph();
    if (!n) return;
    duckCount = Math.max(0, duckCount + (on ? 1 : -1));
    rampGain(n.musicGain.gain, duckCount > 0 ? DUCK_LEVEL : 1, duckCount > 0 ? 0.18 : 0.5);
  }

  async function playFx(id) {
    const item = fxItems.get(id);
    if (!item) return;
    const n = ensureGraph();
    if (!n) return;

    // الضغط على مؤثر يعمل يوقفه — الزر مفتاح لا مشغّل متراكم
    if (fxActive.has(id)) {
      stopFx(id);
      return;
    }

    let buffer;
    try {
      buffer = await fetchBuffer(id);
    } catch (err) {
      emit({ type: 'fx-error', id, message: err.message });
      return;
    }
    if (!buffer || fxActive.has(id)) return;

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = !!item.loop;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    source.connect(gain);
    gain.connect(n.fxGain);

    const ducks = item.kind === 'tag';
    if (ducks) setDuck(true);

    source.onended = () => {
      if (fxActive.get(id) !== entry) return;
      fxActive.delete(id);
      if (ducks) setDuck(false);
      try { gain.disconnect(); } catch (_) { /* تجاهل */ }
      emit({ type: 'fx-ended', id });
    };

    const entry = { source, gain, ducks };
    fxActive.set(id, entry);
    source.start();
    rampGain(gain.gain, item.gain, 0.05);
    emit({ type: 'fx-started', id });
  }

  function stopFx(id) {
    const entry = fxActive.get(id);
    if (!entry) return;
    fxActive.delete(id);
    if (entry.ducks) setDuck(false);
    rampGain(entry.gain.gain, 0, 0.25);
    // إيقاف المصدر بعد التلاشي يمنع الطقطقة المسموعة عند القطع المفاجئ
    setTimeout(() => {
      try { entry.source.onended = null; entry.source.stop(); } catch (_) { /* تجاهل */ }
      try { entry.gain.disconnect(); } catch (_) { /* تجاهل */ }
    }, 280);
    emit({ type: 'fx-ended', id });
  }

  function stopAllFx() {
    for (const id of [...fxActive.keys()]) stopFx(id);
  }

  // ====================================================== تحليل الأغاني

  let analyzeCtx = null;
  let analyzing = false;

  /**
   * سياق مستقل للتحليل فقط — لا يُوصَل بالسماعات ولا يمسّ مسار التشغيل.
   * تردّد منخفض عمدًا: منحنى الطاقة لا يحتاج دقة عالية، والذاكرة تنتصف.
   */
  function getAnalyzeCtx() {
    if (analyzeCtx) return analyzeCtx;
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return null;
    try {
      analyzeCtx = new AudioCtx({ sampleRate: 22050 });
    } catch (_) {
      analyzeCtx = new AudioCtx();
    }
    return analyzeCtx;
  }

  async function analyzeTrack(id, url) {
    if (analyzing) {
      emit({ type: 'analysis', id, ok: false, busy: true, message: 'التحليل مشغول' });
      return;
    }
    const actx = getAnalyzeCtx();
    if (!actx) {
      emit({ type: 'analysis', id, ok: false, message: 'الجهاز لا يدعم التحليل' });
      return;
    }
    analyzing = true;
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`رمز ${response.status}`);
      const bytes = await response.arrayBuffer();
      const buffer = await actx.decodeAudioData(bytes);
      emit({ type: 'analysis', id, ok: true, data: envelopeStats(buffer) });
    } catch (err) {
      emit({ type: 'analysis', id, ok: false, message: err.message });
    } finally {
      analyzing = false;
    }
  }

  /**
   * منحنى الطاقة: جذر متوسط المربعات لكل ربع ثانية، ثم نستخرج منه
   * نهاية المقدمة وبداية الخاتمة وأقوى مقطع ومتوسط الجهارة.
   */
  function envelopeStats(buffer) {
    const rate = buffer.sampleRate;
    const duration = buffer.duration;
    const win = Math.max(1, Math.round(rate * 0.25));
    const left = buffer.getChannelData(0);
    const right = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : null;
    const count = Math.floor(left.length / win);
    if (count < 8) return { duration, loudnessDb: -20, introEndSec: 0, outroStartSec: Math.max(0, duration - 8), peakSec: 0 };

    const env = new Float32Array(count);
    let totalSq = 0;
    for (let i = 0; i < count; i += 1) {
      const start = i * win;
      let acc = 0;
      for (let j = 0; j < win; j += 1) {
        const s = right ? (left[start + j] + right[start + j]) * 0.5 : left[start + j];
        acc += s * s;
      }
      env[i] = Math.sqrt(acc / win);
      totalSq += acc;
    }

    const overall = Math.sqrt(totalSq / (count * win)) || 0.00001;
    let peak = 0;
    for (let i = 0; i < count; i += 1) if (env[i] > peak) peak = env[i];
    const threshold = peak * 0.35;
    const secPerWin = win / rate;

    // المقدمة: أول لحظة ترتفع فيها الطاقة وتثبت ثانيتين — لا مجرد نبضة عابرة
    const sustain = Math.max(1, Math.round(2 / secPerWin));
    let introEnd = 0;
    for (let i = 0; i < count - sustain; i += 1) {
      if (env[i] < threshold) continue;
      let holds = true;
      for (let j = i; j < i + sustain; j += 1) {
        if (env[j] < threshold * 0.7) { holds = false; break; }
      }
      if (holds) { introEnd = i * secPerWin; break; }
    }

    // الخاتمة: آخر لحظة كانت الطاقة فيها عالية
    let outroStart = duration;
    for (let i = count - 1; i >= 0; i -= 1) {
      if (env[i] >= threshold) { outroStart = (i + 1) * secPerWin; break; }
    }

    // أقوى مقطع: متوسط متحرك عشر ثوانٍ يتجاهل القمم اللحظية
    const span = Math.max(1, Math.round(10 / secPerWin));
    let best = -1;
    let bestAt = 0;
    let running = 0;
    for (let i = 0; i < count; i += 1) {
      running += env[i];
      if (i >= span) running -= env[i - span];
      if (i >= span && running > best) { best = running; bestAt = (i - span / 2) * secPerWin; }
    }

    return {
      duration: Math.round(duration * 10) / 10,
      loudnessDb: Math.round(20 * Math.log10(overall) * 10) / 10,
      // حدود أمان: لا نقفز أكثر من ربع الأغنية ولا 45 ثانية مهما قال المنحنى
      introEndSec: Math.round(Math.min(introEnd, 45, duration * 0.25) * 10) / 10,
      outroStartSec: Math.round(Math.max(duration * 0.5, Math.min(outroStart, duration - 3)) * 10) / 10,
      peakSec: Math.round(Math.max(0, bestAt) * 10) / 10
    };
  }

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

  function loadTrack({ id, url, startAt = 0, autoplay = true, gain = 1, endAt = 0 }) {
    const isStream = String(id || '').startsWith('stream:');
    intent = autoplay ? 'playing' : 'paused';
    pauseSeq += 1;
    crossfading = false;
    standbyBusy = false;
    queuedPreload = null;
    preloaded = null;
    loop = null; // اللوب يخص أغنية بعينها
    currentGain = Number.isFinite(gain) ? gain : 1;
    standbyGain = 1;
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
    endAtCurrent = Number(endAt) || 0;
    trimEnded = false;
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
        fadeTo(element, targetVol(element), 600);
      } else {
        element.volume = targetVol(element);
      }
      report();
    };
    element.addEventListener('loadedmetadata', onMeta);
  }

  function applyPreload(command) {
    crossfadeSec = Number(command.crossfadeSec) || 0;
    // نقاط التحليل تصل مع التحميل المسبق لأن العملية الرئيسية تعرف الأغنيتين حينها
    mixAtAbs = Number(command.mixAtSec) || 0;
    nextStartAt = Number(command.nextStartAt) || 0;
    endAtNext = Number(command.endAt) || 0;
    standbyGain = Number.isFinite(command.gain) ? command.gain : 1;
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
    // نقطة البداية من التحليل أدقّ من رقم ثابت، فإن وُجدت قُدِّمت عليه
    const skipTo = nextStartAt > 0 ? nextStartAt : (mix ? dj.skipIntroSec : 0);
    if (skipTo > 0) {
      try { next.currentTime = Math.min(skipTo, (next.duration || Infinity) - 5); } catch (_) { /* تجاهل */ }
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
    fadeTo(next, clamp(masterVolume * standbyGain), ms);
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
    currentGain = standbyGain;
    standbyGain = 1;
    mixAtAbs = 0;
    nextStartAt = 0;
    endAtCurrent = endAtNext;
    endAtNext = 0;
    trimEnded = false;
    loop = null;
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

      // اللوب يسبق كل شيء: ما دام فعّالًا لا انتقال ولا مزج
      if (loop) {
        if (el.currentTime >= loop.end) {
          try { el.currentTime = loop.start; } catch (_) { /* تجاهل */ }
        }
        return;
      }

      const duration = el.duration;
      if (!Number.isFinite(duration) || duration <= 0) return;
      const mix = dj.enabled && dj.autoMix && el !== S;
      // نهاية الأغنية عندنا هي نهاية القصّ إن وُجدت، لا نهاية الملف
      const endsAt = endAtCurrent > 0 ? Math.min(endAtCurrent, duration) : duration;

      let shouldMix;
      if (mix && mixAtAbs > 0) {
        // نقطة هبوط الأغنية من التحليل — أدقّ من عدّ الثواني من النهاية
        // ولا تتجاوز القصّ: المزج يجب أن ينتهي قبل نقطة النهاية لا بعدها
        shouldMix = el.currentTime >= Math.min(mixAtAbs, Math.max(0, endsAt - crossfadeSec));
      } else {
        const startAt = mix ? Math.max(crossfadeSec, Number(dj.mixAtSec) || 12) : crossfadeSec;
        shouldMix = startAt > 0 && endsAt - el.currentTime <= startAt;
      }

      if (shouldMix && preloaded && standby.readyState >= 3 && !el.paused) {
        startPreloadedNow({ fade: true, mix });
        return;
      }

      // لا أغنية مجهّزة: القصّ ينهي الأغنية كما لو انتهى ملفها
      if (endAtCurrent > 0 && !trimEnded && el.currentTime >= endsAt) {
        trimEnded = true;
        el.pause();
        emit({ type: 'ended', id: currentId });
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
          fadeTo(current, targetVol(current), command.fadeMs ?? 400);
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
          stopAllFx();
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
          if (!current.paused) fadeTo(current, targetVol(current), command.fadeMs ?? 250);
          break;

        // ------------------------------------------- التحليل واللوب

        case 'analyze':
          analyzeTrack(command.id, command.url);
          break;

        case 'loop-set': {
          const start = Math.max(0, Number(command.start) || 0);
          const end = Number(command.end) || 0;
          if (end - start < 1) {
            loop = null;
            break;
          }
          loop = { start, end };
          // القفز للبداية فورًا لو كنا خارج المقطع، وإلا سمعنا ما بعده قبل أول دورة
          if (current.currentTime < start || current.currentTime > end) {
            try { current.currentTime = start; } catch (_) { /* تجاهل */ }
          }
          break;
        }

        case 'loop-clear':
          loop = null;
          break;

        // ------------------------------------------------------ الديجي

        case 'trim-set':
          // تغيّر القصّ أثناء التشغيل: نرفع الحدّ بلا إعادة تحميل
          endAtCurrent = Number(command.endAt) || 0;
          trimEnded = false;
          break;

        case 'balance':
          setBalance(command.config || {}, command.fadeMs ?? 120);
          break;

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
            applyPan(command.fadeMs ?? 400);
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

        // ------------------------------------------------ مؤثرات مارا

        case 'fx-set': {
          const items = Array.isArray(command.items) ? command.items : [];
          const ids = new Set(items.map((item) => item.id));
          // مؤثر حُذف من المكتبة يجب أن يتوقف ويُفرَّغ من الذاكرة
          for (const id of [...fxActive.keys()]) if (!ids.has(id)) stopFx(id);
          for (const id of [...fxBuffers.keys()]) if (!ids.has(id)) fxBuffers.delete(id);
          fxItems.clear();
          for (const item of items) fxItems.set(item.id, item);
          if (items.length) preloadFx();
          break;
        }

        case 'fx-play':
          playFx(command.id);
          break;

        case 'fx-stop':
          stopFx(command.id);
          break;

        case 'fx-stop-all':
          stopAllFx();
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
