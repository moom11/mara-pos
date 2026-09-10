'use strict';

/** شاشة الجهاز في المطعم: بسيطة، للعرض فقط (مع زرَّي تشغيل/تالي إن سُمح للموظف). */
(function () {
  const $ = (id) => document.getElementById(id);

  const els = {
    clock: $('clock'),
    liveDot: $('live-dot'),
    banner: $('banner'),
    bannerText: $('banner-text'),
    cover: $('cover'),
    coverFallback: $('cover-fallback'),
    sourceName: $('source-name'),
    title: $('title'),
    artist: $('artist'),
    fill: $('progress-fill'),
    position: $('time-position'),
    duration: $('time-duration'),
    controls: $('controls'),
    btnToggle: $('btn-toggle'),
    btnNext: $('btn-next'),
    upnext: $('upnext-list'),
    remoteUrl: $('remote-url'),
    staffPin: $('staff-pin'),
    qr: $('qr'),
    prayerNext: $('prayer-next')
  };

  let lastState = null;
  let localPosition = 0;
  let localDuration = 0;
  let playing = false;

  function tickClock() {
    const now = new Date();
    els.clock.textContent = now.toLocaleTimeString('ar-SA', { hour: '2-digit', minute: '2-digit', hour12: true });
  }
  setInterval(tickClock, 1000);
  tickClock();

  // تحريك شريط التقدّم بسلاسة بين التحديثات
  setInterval(() => {
    if (playing && localDuration > 0) {
      localPosition = Math.min(localDuration, localPosition + 0.25);
      paintProgress();
    }
  }, 250);

  function paintProgress() {
    const pct = localDuration > 0 ? (localPosition / localDuration) * 100 : 0;
    els.fill.style.width = `${Math.min(100, pct)}%`;
    els.position.textContent = formatTime(localPosition);
    els.duration.textContent = formatTime(localDuration);
  }

  function render(payload) {
    if (!payload) return;
    const state = payload.state;
    lastState = state;
    playing = state.status === 'playing';
    localPosition = state.position || 0;
    localDuration = state.duration || 0;

    els.liveDot.className = `dot ${playing ? 'on' : 'off'}`;
    els.sourceName.textContent = state.source ? state.source.name : '';

    const track = state.track;
    if (track) {
      els.title.textContent = track.title || 'بدون عنوان';
      els.artist.textContent = track.artist || '';
      if (track.cover) {
        els.cover.src = track.cover;
        els.cover.hidden = false;
        els.coverFallback.hidden = true;
      } else {
        els.cover.hidden = true;
        els.coverFallback.hidden = false;
      }
    } else {
      els.title.textContent = state.libraryCount ? 'متوقف' : 'المكتبة فارغة — أضف ملفات MP3';
      els.artist.textContent = '';
      els.cover.hidden = true;
      els.coverFallback.hidden = false;
    }
    paintProgress();

    // البانر: الصلاة أو أخطاء
    if (state.autoPause) {
      els.banner.hidden = false;
      els.banner.className = 'banner prayer';
      els.bannerText.textContent = `${state.autoPause.label} — ${state.autoPause.mode === 'lower' ? 'خفض الصوت' : 'إيقاف مؤقت'} حتى ${state.autoPause.until || ''}`;
    } else if (!state.libraryCount) {
      els.banner.hidden = false;
      els.banner.className = 'banner warn';
      els.bannerText.textContent = 'لا توجد أغانٍ في المكتبة بعد.';
    } else {
      els.banner.hidden = true;
    }

    // التالي
    const upcoming = [...(state.queue || []), ...(state.upNext || [])].slice(0, 4);
    els.upnext.innerHTML = '';
    if (!upcoming.length) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = '—';
      els.upnext.appendChild(li);
    } else {
      for (const t of upcoming) {
        const li = document.createElement('li');
        li.textContent = t.artist ? `${t.title} — ${t.artist}` : t.title;
        els.upnext.appendChild(li);
      }
    }

    // معلومات الاتصال
    if (payload.network) {
      els.remoteUrl.textContent = payload.network.url || '';
      if (payload.network.qr) {
        els.qr.src = payload.network.qr;
        els.qr.hidden = false;
      } else {
        els.qr.hidden = true;
      }
    }
    els.staffPin.textContent = payload.staffPin || '----';

    els.controls.hidden = !payload.staffCanPause;
    els.btnToggle.textContent = playing ? 'إيقاف مؤقت' : 'تشغيل';

    if (payload.prayer && payload.prayer.next) {
      const next = payload.prayer.next;
      els.prayerNext.textContent = `${next.name} — ${next.time}${next.tomorrow ? ' (غدًا)' : ''}`;
    } else {
      els.prayerNext.textContent = '—';
    }
  }

  els.btnToggle.addEventListener('click', () => window.mara.staffAction('toggle'));
  els.btnNext.addEventListener('click', () => window.mara.staffAction('next'));

  window.mara.onScreen(render);
  window.mara.requestScreen();

  function formatTime(seconds) {
    const s = Math.max(0, Math.floor(Number(seconds) || 0));
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${m}:${String(r).padStart(2, '0')}`;
  }
})();
