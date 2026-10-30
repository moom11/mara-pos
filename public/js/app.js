/* مارا — تسجيل خروج القلابات ومبيعات مواد الجبل
 * الواجهة تتصل بالخادم، وجميع البيانات محفوظة في قاعدة بيانات دائمة على الخادم.
 */
(function () {
  'use strict';

  const METHODS = { cash: 'نقد', transfer: 'تحويل', credit: 'آجل' };
  const ASSET_TYPES = ['شيول', 'حفار', 'قلاب', 'بلدوزر', 'كسارة', 'مولد كهرباء', 'سيارة', 'أرض / موقع', 'مبنى / مكتب', 'أخرى'];
  const ASSET_STATUS = { active: 'يعمل', maintenance: 'في الصيانة', idle: 'متوقف', sold: 'مباع' };
  const TRUCK_TYPES = ['سكس', 'تريلا', 'قلاب 10 ويل', 'قلاب 12 ويل', 'دينا', 'لوري'];
  const TOKEN_KEY = 'mara-token';

  const S = { token: null, user: null, boot: null };

  // ---------- أدوات ----------
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const toNum = (v) => {
    const n = parseFloat(String(v ?? '').replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d)).replace(/,/g, '.'));
    return isFinite(n) ? n : 0;
  };
  const round2 = (n) => Math.round(n * 100) / 100;
  const fmt = (n) => toNum(n).toLocaleString('en-US', { maximumFractionDigits: 2 });
  const cur = () => (S.boot ? S.boot.settings.currency : 'ريال');
  const money = (n) => `${fmt(n)} ${esc(cur())}`;
  const plateHtml = (p) => `<span class="plate-txt">${esc(p)}</span>`;
  const normPlate = (p) => String(p || '').replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d)).replace(/[\s\-_.|/]/g, '').toUpperCase();
  const today = () => (S.boot && S.boot.today) || new Date().toISOString().slice(0, 10);
  const monthStart = () => today().slice(0, 8) + '01';
  const newRequestId = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
  const methodBadge = (m) => `<span class="badge ${m}">${METHODS[m] || m}</span>`;
  const timeOf = (at) => String(at || '').slice(11, 16);

  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toast.t);
    toast.t = setTimeout(() => t.classList.remove('show'), 2600);
  }

  async function api(method, url, body) {
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json', ...(S.token ? { Authorization: 'Bearer ' + S.token } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      const err = new Error('تعذر الاتصال بالخادم. تأكد من الاتصال بالشبكة وحاول مرة أخرى');
      err.network = true;
      throw err;
    }
    const data = (res.headers.get('content-type') || '').includes('json') ? await res.json() : null;
    if (res.status === 401 && S.token) {
      logout(true);
    }
    if (!res.ok) {
      const err = new Error((data && (data.message || data.error)) || 'حدث خطأ');
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  async function download(url, filename) {
    const res = await fetch(url, { headers: { Authorization: 'Bearer ' + S.token } });
    if (!res.ok) throw new Error('تعذر التنزيل');
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  const qs = (obj) => Object.entries(obj).filter(([, v]) => v !== '' && v !== null && v !== undefined).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');

  // ---------- النافذة المنبثقة ----------
  let modalSubmit = null;
  function openModal({ title, body, actions, onSubmit, onOpen }) {
    $('#modalTitle').textContent = title;
    $('#modalBody').innerHTML = body;
    $('#modalActions').innerHTML = actions !== undefined ? actions
      : '<button type="submit" class="btn red">حفظ</button><button type="button" class="btn ghost" data-close>إلغاء</button>';
    modalSubmit = onSubmit || null;
    const dlg = $('#modal');
    if (!dlg.open) dlg.showModal();
    if (onOpen) onOpen($('#modalBody'));
    const first = $('#modalBody input:not([type=hidden]):not([readonly]), #modalBody select, #modalBody textarea');
    if (first && window.innerWidth > 700) first.focus();
  }
  const closeModal = () => { if ($('#modal').open) $('#modal').close(); };

  $('#modalForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!modalSubmit) return closeModal();
    const btn = $('#modalActions [type=submit]');
    if (btn && btn.disabled) return;
    const data = Object.fromEntries(new FormData($('#modalForm')).entries());
    if (btn) btn.disabled = true;
    try {
      const keep = await modalSubmit(data, e.submitter);
      if (keep !== false) closeModal();
    } catch (err) {
      showModalError(err.message);
    } finally {
      if (btn) btn.disabled = false;
    }
  });
  document.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) closeModal(); });

  function showModalError(msg) {
    let box = $('#modalBody .error-box');
    if (!box) {
      box = document.createElement('div');
      box.className = 'error-box';
      $('#modalBody').prepend(box);
    }
    box.textContent = msg;
  }

  // نافذة طلب سبب (للإلغاء والتعديل)
  function askReason(title, label) {
    return new Promise((resolve) => {
      let done = false;
      openModal({
        title,
        body: `<div class="field"><label class="lbl">${label}</label><textarea name="reason" required></textarea></div>`,
        actions: '<button type="submit" class="btn red">تأكيد</button><button type="button" class="btn ghost" data-close>رجوع</button>',
        onSubmit: (d) => {
          if (!d.reason.trim()) { showModalError('السبب مطلوب'); return false; }
          done = true;
          resolve(d.reason.trim());
        },
      });
      $('#modal').addEventListener('close', () => { if (!done) resolve(null); }, { once: true });
    });
  }

  const field = (label, inner, hint) => `<div class="field"><label class="lbl">${label}</label>${inner}${hint ? `<div class="hint">${hint}</div>` : ''}</div>`;
  const opt = (v, label, sel) => `<option value="${esc(v)}" ${String(v) === String(sel ?? '') ? 'selected' : ''}>${esc(label)}</option>`;

  // ---------- الطباعة ----------
  function printHtml(html) {
    $('#printArea').innerHTML = html;
    const imgs = $$('#printArea img').filter((i) => !i.complete);
    Promise.all(imgs.map((i) => new Promise((r) => { i.onload = i.onerror = r; }))).then(() => {
      document.body.classList.add('printing');
      window.print();
      document.body.classList.remove('printing');
    });
  }

  function printDoc(title, subtitle, content, asPdf) {
    const st = S.boot.settings;
    printHtml(`<div class="print-doc">
      <div class="doc-head"><div><h1>${esc(st.companyName)}</h1><div>${esc(st.city)} — <bdi dir="ltr">${esc(st.phone)}</bdi></div></div>
      <div style="text-align:left"><strong>${esc(title)}</strong><div>${esc(subtitle || '')}</div><div>طُبع: ${esc(new Date().toLocaleString('en-GB'))}</div></div></div>
      ${content}</div>`);
    if (asPdf) toast('اختر «حفظ بتنسيق PDF» من نافذة الطباعة');
  }

  // ---------- تفقيط المبلغ ----------
  const ONES = ['', 'واحد', 'اثنان', 'ثلاثة', 'أربعة', 'خمسة', 'ستة', 'سبعة', 'ثمانية', 'تسعة', 'عشرة',
    'أحد عشر', 'اثنا عشر', 'ثلاثة عشر', 'أربعة عشر', 'خمسة عشر', 'ستة عشر', 'سبعة عشر', 'ثمانية عشر', 'تسعة عشر'];
  const TENS = ['', '', 'عشرون', 'ثلاثون', 'أربعون', 'خمسون', 'ستون', 'سبعون', 'ثمانون', 'تسعون'];
  const HUNDREDS = ['', 'مائة', 'مائتان', 'ثلاثمائة', 'أربعمائة', 'خمسمائة', 'ستمائة', 'سبعمائة', 'ثمانمائة', 'تسعمائة'];
  function below1000(n) {
    const h = Math.floor(n / 100), r = n % 100;
    const rest = r < 20 ? ONES[r] : r % 10 ? `${ONES[r % 10]} و${TENS[Math.floor(r / 10)]}` : TENS[Math.floor(r / 10)];
    return [HUNDREDS[h], rest].filter(Boolean).join(' و');
  }
  function counted(n, forms) {
    if (n === 1) return forms[0];
    if (n === 2) return forms[1];
    const words = below1000(n).replace(/مائتان$/, 'مائتا');
    const r = n % 100;
    if (r >= 3 && r <= 10) return `${words} ${forms[2]}`;
    if (r >= 11) return `${words} ${forms[3]}`;
    return `${words} ${forms[0]}`;
  }
  function numberToWords(n) {
    if (!n) return 'صفر';
    const parts = [];
    const m = Math.floor(n / 1e6), t = Math.floor((n % 1e6) / 1000), r = n % 1000;
    if (m) parts.push(counted(m, ['مليون', 'مليونان', 'ملايين', 'مليوناً']));
    if (t) parts.push(counted(t, ['ألف', 'ألفان', 'آلاف', 'ألفاً']));
    if (r) parts.push(below1000(r));
    return parts.join(' و');
  }
  function amountInWords(amount) {
    const total = Math.round(toNum(amount) * 100);
    const whole = Math.floor(total / 100), frac = total % 100;
    const c = cur();
    const isRiyal = c === 'ريال';
    let text;
    if (isRiyal && whole === 1) text = 'ريال واحد';
    else if (isRiyal && whole === 2) text = 'ريالان';
    else {
      const r = whole % 100;
      const w = !isRiyal ? c : r >= 3 && r <= 10 && whole >= 3 ? 'ريالات' : r >= 11 ? 'ريالاً' : 'ريال';
      const words = numberToWords(whole).replace(/(مائتا|ألفا|مليونا)ن$/, '$1').replace(/(ألف|مليون)اً$/, '$1');
      text = `${words} ${w}`;
    }
    if (frac) text += ` و${numberToWords(frac)} ${isRiyal ? 'هللة' : ''}`.trimEnd();
    return `فقط ${text} لا غير`;
  }

  // ---------- سند الخروج ----------
  const logoSrc = () => S.boot.settings.logo || 'img/logo.png';
  function voucherHtml(t) {
    const st = S.boot.settings;
    const [y, m, d] = t.created_at.slice(0, 10).split('-');
    const row = (label, value) => `<div class="v-row"><span class="v-label">${label} :</span><span class="v-val">${value || ''}</span></div>`;
    return `<div class="voucher ${st.voucherSize === '80mm' ? 'r80' : ''}">
      ${t.status === 'cancelled' ? '<div class="v-cancel">ملغي</div>' : ''}
      <div class="v-head">
        <div class="v-co"><div class="v-co-name">${esc(st.companyName)}</div><div class="v-city">${esc(st.city)}</div>
          <div class="v-phone">هاتف: <bdi dir="ltr">${esc(st.phone)}</bdi></div></div>
        <div class="v-sep"></div>
        <img class="v-logo" src="${esc(logoSrc())}" alt="">
      </div>
      <div class="v-title"><b>سند خروج</b><span>${esc(st.voucherTitle)}</span></div>
      <div class="v-no"><span>رقم السند: ${t.no}</span><span>${d} / ${m} / ${y}م — ${timeOf(t.created_at)}</span></div>
      ${row('رقم اللوحة', `<bdi dir="ltr"><b>${esc(t.plate)}</b></bdi>${t.truck_type ? ' — ' + esc(t.truck_type) : ''}`)}
      ${row('اسم السائق', esc(t.driver))}
      ${row('العميل', esc(t.customer_name || 'نقدي'))}
      ${row('نوع الحمولة', esc(t.material_name))}
      ${row('المبلغ', `<b>${money(t.price)}</b> <span class="v-words">(${esc(amountInWords(t.price))})</span>`)}
      ${row('المدفوع', `${money(t.paid)} — ${METHODS[t.method]}${t.remaining > 0 ? ` &nbsp; | &nbsp; <b>المتبقي: ${money(t.remaining)}</b>` : ''}`)}
      ${t.notes ? row('ملاحظات', esc(t.notes)) : ''}
      ${row('الموظف', esc(t.user_name))}
      ${row('توقيع السائق', '')}
      ${row('توقيع المهندس المسؤول', '')}
      <div class="v-foot">
        <div><div class="v-label">المستلم :</div>${row('الاسم', '')}${row('التوقيع', '')}</div>
        <div class="v-label">الختم الرسمي</div>
        <div class="v-label">مدير المشروع</div>
      </div>
    </div>`;
  }
  const printVoucher = (t) => printHtml(voucherHtml(t));

  // ---------- قراءة اللوحة من الصورة ----------
  let tesseractLoading = null;
  function loadTesseract() {
    if (window.Tesseract) return Promise.resolve(window.Tesseract);
    if (!tesseractLoading) {
      tesseractLoading = new Promise((resolve, reject) => {
        const sc = document.createElement('script');
        sc.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
        sc.onload = () => resolve(window.Tesseract);
        sc.onerror = () => { tesseractLoading = null; reject(new Error('load failed')); };
        document.head.appendChild(sc);
      });
    }
    return tesseractLoading;
  }
  function prepareImage(file) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(2, 1600 / Math.max(img.width, img.height)) || 1;
        const c = document.createElement('canvas');
        c.width = Math.round(img.width * scale);
        c.height = Math.round(img.height * scale);
        const ctx = c.getContext('2d');
        ctx.drawImage(img, 0, 0, c.width, c.height);
        const data = ctx.getImageData(0, 0, c.width, c.height);
        const px = data.data;
        for (let i = 0; i < px.length; i += 4) {
          const v = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2] > 130 ? 255 : 0;
          px[i] = px[i + 1] = px[i + 2] = v;
        }
        ctx.putImageData(data, 0, 0);
        URL.revokeObjectURL(img.src);
        resolve(c);
      };
      img.onerror = reject;
      img.src = URL.createObjectURL(file);
    });
  }
  // اللوحات السعودية: أرقام (1-4) + حروف لاتينية (1-3)
  function parsePlate(text) {
    const t = String(text).replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d)).toUpperCase().replace(/[^0-9A-Z\n ]/g, ' ')
      .replace(/\bKSA\b/g, ' ')
      .replace(/\b([A-Z]) +(?=[A-Z]\b)/g, '$1');
    const m = t.match(/(\d{1,4})\s*([A-Z]{1,3})\b/) || t.match(/\b([A-Z]{1,3})\s*(\d{1,4})/);
    if (m) {
      const digits = /\d/.test(m[1]) ? m[1] : m[2];
      const letters = /\d/.test(m[1]) ? m[2] : m[1];
      return `${digits} ${letters}`;
    }
    const digits = t.match(/\d{2,7}/);
    return digits ? digits[0] : '';
  }
  async function readPlateFromImage(file, onStatus) {
    onStatus('جاري تحميل أداة القراءة...');
    const T = await loadTesseract();
    const canvas = await prepareImage(file);
    onStatus('جاري قراءة اللوحة...');
    const { data } = await T.recognize(canvas, 'eng', {
      logger: (m) => { if (m.status === 'recognizing text') onStatus(`جاري القراءة ${Math.round(m.progress * 100)}%`); },
    });
    return parsePlate(data.text);
  }

  // ---------- الدخول ----------
  function renderLogin(needsSetup, error) {
    document.body.classList.remove('has-nav');
    $('#topbar').hidden = true;
    $('#drawer').hidden = true;
    $('#app').innerHTML = `<div class="login"><form class="box" id="loginForm">
      <div class="logo"><span class="brand-mark">M</span><h1 style="margin:0">مارا</h1></div>
      <p class="sub">${needsSetup ? 'أول تشغيل: أنشئ حساب المدير' : 'تسجيل خروج القلابات'}</p>
      ${error ? `<div class="error-box">${esc(error)}</div>` : ''}
      ${needsSetup ? field('الاسم', '<input name="name" required autocomplete="name">') : ''}
      ${field('اسم المستخدم', '<input name="username" required autocomplete="username" autocapitalize="off">')}
      ${field('كلمة المرور', `<input name="password" type="password" required autocomplete="${needsSetup ? 'new-password' : 'current-password'}">`, needsSetup ? '6 أحرف على الأقل' : '')}
      <button class="btn red block xl" type="submit">${needsSetup ? 'إنشاء الحساب' : 'دخول'}</button>
    </form></div>`;
    $('#loginForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = e.target.querySelector('button');
      btn.disabled = true;
      const d = Object.fromEntries(new FormData(e.target).entries());
      try {
        const r = await api('POST', needsSetup ? '/api/setup' : '/api/login', d);
        S.token = r.token;
        try { localStorage.setItem(TOKEN_KEY, r.token); } catch (_) { /* ignore */ }
        await start();
      } catch (err) {
        renderLogin(needsSetup, err.message);
      }
    });
  }

  function logout(expired) {
    if (S.token && !expired) api('POST', '/api/logout').catch(() => {});
    S.token = null;
    S.user = null;
    S.boot = null;
    try { localStorage.removeItem(TOKEN_KEY); } catch (_) { /* ignore */ }
    location.hash = '';
    renderLogin(false, expired ? 'انتهت الجلسة، سجّل الدخول مرة أخرى' : '');
  }

  async function loadBoot() {
    S.boot = await api('GET', '/api/bootstrap');
    S.user = S.boot.user;
    $('#plateList').innerHTML = S.boot.trucks.filter((t) => t.active).map((t) => `<option value="${esc(t.plate)}">${esc(t.driver || '')}</option>`).join('');
    const types = new Set([...TRUCK_TYPES, ...S.boot.trucks.map((t) => t.type).filter(Boolean)]);
    $('#truckTypes').innerHTML = [...types].map((t) => `<option value="${esc(t)}">`).join('');
  }

  // ---------- التنقل ----------
  const isManager = () => S.user && S.user.role === 'manager';
  const NAV = [
    { id: 'dashboard', label: 'الرئيسية', ico: '🏠', manager: true },
    { id: 'exit', label: 'تسجيل خروج', ico: '🚚' },
    { id: 'today', label: 'خروج اليوم', ico: '📋', gateOnly: true },
    { id: 'trips', label: 'العمليات', ico: '📋', manager: true },
    { id: 'customers', label: 'العملاء والحسابات', ico: '👥', manager: true },
    { id: 'payments', label: 'سداد العملاء', ico: '💵', manager: true },
    { id: 'trucks', label: 'القلابات والسائقين', ico: '🚛', manager: true },
    { id: 'reports', label: 'التقارير', ico: '📊', manager: true },
    { id: 'audit', label: 'سجل التغييرات', ico: '🕘', manager: true },
    { id: 'assets', label: 'الأصول', ico: '🏗️', manager: true },
    { id: 'settings', label: 'الإعدادات', ico: '⚙️', manager: true },
  ];
  const navItems = () => NAV.filter((n) => (isManager() ? !n.gateOnly : !n.manager));

  function renderShell() {
    document.body.classList.add('has-nav');
    $('#topbar').hidden = false;
    $('#brandName').textContent = S.boot.settings.companyName || 'مارا';
    $('#who').innerHTML = `${esc(S.user.name)}<br><small>${isManager() ? 'مدير' : 'موظف بوابة'}</small>`;
    $('#drawer').innerHTML = `<div class="drawer-head"><strong>${esc(S.user.name)}</strong><small>${isManager() ? 'مدير' : 'موظف بوابة'}</small></div>
      ${navItems().map((n) => `<a href="#${n.id}" data-nav="${n.id}"><span class="ico">${n.ico}</span>${n.label}</a>`).join('')}
      <button class="nav-link" data-act="logout"><span class="ico">⏻</span>تسجيل الخروج من الحساب</button>`;
    $('#drawer').hidden = window.innerWidth < 1000;
  }

  const toggleDrawer = (open) => {
    if (window.innerWidth >= 1000) return;
    $('#drawer').hidden = !open;
    $('#scrim').hidden = !open;
  };
  $('#menuBtn').addEventListener('click', () => toggleDrawer($('#drawer').hidden));
  $('#scrim').addEventListener('click', () => toggleDrawer(false));
  window.addEventListener('resize', () => { if (S.user) { $('#drawer').hidden = window.innerWidth < 1000; $('#scrim').hidden = true; } });

  function parseRoute() {
    const [page, arg] = location.hash.slice(1).split('/');
    const allowed = navItems().map((n) => n.id).concat(isManager() ? ['customer'] : []);
    if (!allowed.includes(page)) return { page: isManager() ? 'dashboard' : 'exit' };
    return { page, arg };
  }

  async function render() {
    if (!S.user) return;
    const { page, arg } = parseRoute();
    $$('#drawer [data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === page || (page === 'customer' && a.dataset.nav === 'customers')));
    toggleDrawer(false);
    closeModal();
    const view = VIEWS[page];
    try {
      // تحديث البيانات الأساسية (عملاء/قلابات أضافها مستخدم آخر)
      await loadBoot();
      await view(arg);
    } catch (err) {
      $('#app').innerHTML = `<div class="error-box">${esc(err.message)}</div>`;
    }
    window.scrollTo(0, 0);
  }
  window.addEventListener('hashchange', render);

  // ========== شاشة تسجيل الخروج ==========
  const X = { requestId: newRequestId(), materialId: null, method: 'cash', price: '', paidTouched: false, driverAuto: true, submitting: false };

  function viewExit() {
    const b = S.boot;
    const materials = b.materials.filter((m) => m.active);
    if (!X.materialId || !materials.some((m) => m.id === X.materialId)) X.materialId = materials[0] ? materials[0].id : null;
    if (X.price === '' && X.materialId && b.lastPrices[X.materialId]) X.price = b.lastPrices[X.materialId];
    const recent = b.trucks.filter((t) => t.active && t.last_ts).sort((a, c) => c.last_ts - a.last_ts).slice(0, 10);

    $('#app').innerHTML = `<div class="exit-wrap"><form id="exitForm" autocomplete="off">
      <h1>تسجيل خروج قلاب</h1>
      <div class="card">
        ${field('رقم لوحة القلاب', `<div class="row">
            <input class="grow big plate" name="plate" id="x-plate" list="plateList" placeholder="1234 ABD" required>
            <button type="button" class="btn ghost" data-act="pick-truck" title="اختيار قلاب محفوظ">📋</button>
            <label class="btn ghost" title="قراءة اللوحة من صورة" style="margin:0">📷<input type="file" id="x-cam" accept="image/*" capture="environment" hidden></label>
          </div><div class="hint" id="x-plate-hint">اكتب اللوحة أو اختر قلاباً محفوظاً</div>
          ${recent.length ? `<div class="chips">${recent.map((t) => `<button type="button" class="chip" data-act="use-truck" data-id="${t.id}">${esc(t.plate)}${t.driver ? ` <small>${esc(t.driver)}</small>` : ''}</button>`).join('')}</div>` : ''}`)}
        ${field('اسم السائق', '<input name="driver" id="x-driver" placeholder="اسم السائق">', 'يُحفظ مع القلاب ويمكن تغييره')}
        ${field('العميل', `<div class="row"><select class="grow" name="customerId" id="x-customer">
            <option value="">— بدون عميل (نقدي) —</option>${b.customers.filter((c) => c.active).map((c) => opt(c.id, c.name)).join('')}
          </select><button type="button" class="btn ghost" data-act="new-customer-exit">+ جديد</button></div>`)}
      </div>
      <div class="card">
        ${field('نوع المادة', `<div class="choices" id="x-materials">${materials.map((m) => `<button type="button" class="choice ${m.id === X.materialId ? 'on' : ''}" data-material="${m.id}">${esc(m.name)}</button>`).join('') || '<div class="hint warn">أضف المواد من الإعدادات</div>'}</div>`)}
        ${field('سعر الرد', `<input class="big money" name="price" id="x-price" inputmode="decimal" value="${esc(X.price)}" placeholder="0" required>`)}
        ${field('طريقة الدفع', `<div class="choices" id="x-methods">${Object.entries(METHODS).map(([k, v]) => `<button type="button" class="choice ${k} ${k === X.method ? 'on' : ''}" data-method="${k}">${v}</button>`).join('')}</div>`)}
        ${field('المبلغ المدفوع', '<input class="big money" name="paid" id="x-paid" inputmode="decimal" placeholder="0">')}
        <div class="remaining-box" id="x-remaining"><span>المتبقي</span><span class="v">0</span></div>
      </div>
      <div class="card">${field('ملاحظات (اختياري)', '<input name="notes" id="x-notes">')}</div>
      <div class="sticky-submit"><button type="submit" class="btn red block xl" id="x-submit">✔ تأكيد الخروج</button></div>
    </form></div>`;

    const form = $('#exitForm');
    const plate = $('#x-plate'), driver = $('#x-driver'), price = $('#x-price'), paid = $('#x-paid');

    const update = () => {
      const p = toNum(price.value);
      if (X.method === 'credit') { paid.value = '0'; paid.readOnly = true; }
      else {
        paid.readOnly = false;
        if (!X.paidTouched) paid.value = price.value;
      }
      const rem = round2(p - (X.method === 'credit' ? 0 : toNum(paid.value)));
      const box = $('#x-remaining');
      box.classList.toggle('due', rem > 0);
      box.querySelector('.v').textContent = `${fmt(Math.max(rem, 0))} ${cur()}`;
    };

    const syncTruck = () => {
      const t = S.boot.trucks.find((x) => normPlate(x.plate) === normPlate(plate.value));
      const hint = $('#x-plate-hint');
      if (!normPlate(plate.value)) { hint.className = 'hint'; hint.textContent = 'اكتب اللوحة أو اختر قلاباً محفوظاً'; return; }
      if (t) {
        hint.className = 'hint ok';
        hint.textContent = `✓ قلاب محفوظ${t.type ? ' — ' + t.type : ''}`;
        if (X.driverAuto || !driver.value.trim()) { driver.value = t.driver || ''; X.driverAuto = true; }
      } else {
        hint.className = 'hint warn';
        hint.textContent = 'قلاب جديد — سيُحفظ تلقائياً عند التأكيد';
        if (X.driverAuto) driver.value = '';
      }
    };

    plate.addEventListener('input', syncTruck);
    driver.addEventListener('input', () => { X.driverAuto = false; });
    price.addEventListener('input', () => { X.price = price.value; update(); });
    paid.addEventListener('input', () => { X.paidTouched = true; update(); });

    $('#x-materials').addEventListener('click', (e) => {
      const b2 = e.target.closest('[data-material]');
      if (!b2) return;
      X.materialId = Number(b2.dataset.material);
      $$('#x-materials .choice').forEach((c) => c.classList.toggle('on', c === b2));
      const last = S.boot.lastPrices[X.materialId];
      if (last && !price.value) { price.value = last; X.price = last; }
      update();
    });
    $('#x-methods').addEventListener('click', (e) => {
      const b2 = e.target.closest('[data-method]');
      if (!b2) return;
      X.method = b2.dataset.method;
      X.paidTouched = false;
      $$('#x-methods .choice').forEach((c) => c.classList.toggle('on', c === b2));
      update();
    });

    $('#x-cam').addEventListener('change', async (ev) => {
      const file = ev.target.files[0];
      if (!file) return;
      const hint = $('#x-plate-hint');
      hint.className = 'hint';
      try {
        const found = await readPlateFromImage(file, (m) => { hint.textContent = m; });
        if (found) { plate.value = found; syncTruck(); toast('تم استخراج اللوحة — تأكد منها'); }
        else { hint.className = 'hint warn'; hint.textContent = 'لم يتم التعرف على اللوحة، اكتبها يدوياً'; }
      } catch (err) {
        hint.className = 'hint warn';
        hint.textContent = 'تعذرت قراءة الصورة (تحتاج إنترنت). اكتب اللوحة يدوياً';
      }
      ev.target.value = '';
    });

    form.addEventListener('submit', (e) => { e.preventDefault(); submitExit(false); });
    update();
    if (window.innerWidth > 700) plate.focus();
  }

  async function submitExit(confirmDuplicate) {
    if (X.submitting) return; // منع تكرار الحفظ
    const form = $('#exitForm');
    const d = Object.fromEntries(new FormData(form).entries());
    const errors = [];
    if (!normPlate(d.plate)) errors.push('أدخل رقم اللوحة');
    if (!X.materialId) errors.push('اختر نوع المادة');
    if (!(toNum(d.price) > 0)) errors.push('أدخل سعر الرد');
    const paid = X.method === 'credit' ? 0 : toNum(d.paid);
    if (paid > toNum(d.price)) errors.push('المدفوع أكبر من السعر');
    if (round2(toNum(d.price) - paid) > 0 && !d.customerId) errors.push('اختر العميل لأن عليه مبلغاً متبقياً');
    if (errors.length) { toast(errors[0]); return; }

    X.submitting = true;
    const btn = $('#x-submit');
    btn.disabled = true;
    btn.textContent = 'جاري الحفظ...';
    try {
      const r = await api('POST', '/api/trips', {
        requestId: X.requestId, plate: d.plate, driver: d.driver, customerId: d.customerId || null, materialId: X.materialId,
        price: d.price, paid: X.method === 'credit' ? 0 : d.paid, method: X.method, notes: d.notes, confirmDuplicate,
      });
      const trip = r.trip;
      X.requestId = newRequestId();
      X.paidTouched = false;
      X.driverAuto = true;
      S.boot.lastPrices[trip.material_id] = trip.price;
      loadBoot().catch(() => {});
      openModal({
        title: 'تم تسجيل الخروج',
        body: `<div class="success-big"><div class="check">✓</div><div>سند خروج رقم</div><div class="num">${trip.no}</div>
          <div>${plateHtml(trip.plate)} — ${esc(trip.material_name)} — ${money(trip.price)}</div>
          ${trip.remaining > 0 ? `<div class="due" style="margin-top:6px">متبقي على ${esc(trip.customer_name)}: ${money(trip.remaining)}</div>` : ''}</div>`,
        actions: `<button type="button" class="btn red xl" data-act="print-trip-obj">🖨️ طباعة السند</button><button type="button" class="btn ghost xl" data-act="new-exit">خروج جديد</button>`,
      });
      S.lastTrip = trip;
    } catch (err) {
      if (err.status === 409 && err.data && err.data.error === 'duplicate') {
        X.submitting = false;
        btn.disabled = false;
        btn.textContent = '✔ تأكيد الخروج';
        openModal({
          title: '⚠️ تنبيه: لوحة مكررة',
          body: `<div class="error-box">${esc(err.data.message)}</div><p>هل أنت متأكد أن هذا خروج جديد لنفس القلاب؟</p>`,
          actions: '<button type="button" class="btn red" data-act="confirm-dup">نعم، سجّل الخروج</button><button type="button" class="btn ghost" data-close>إلغاء</button>',
        });
        return;
      }
      toast(err.message);
    }
    X.submitting = false;
    const b2 = $('#x-submit');
    if (b2) { b2.disabled = false; b2.textContent = '✔ تأكيد الخروج'; }
  }

  function pickTruckModal() {
    const list = S.boot.trucks.filter((t) => t.active);
    openModal({
      title: 'اختيار قلاب محفوظ',
      body: `<input id="pick-q" placeholder="بحث باللوحة أو السائق...">
        <div class="pick-list" id="pick-list"></div>`,
      actions: '',
      onOpen: (root) => {
        const draw = () => {
          const q = $('#pick-q', root).value.trim();
          const items = list.filter((t) => !q || normPlate(t.plate).includes(normPlate(q)) || (t.driver || '').includes(q));
          $('#pick-list', root).innerHTML = items.map((t) => `<button type="button" class="pick-item" data-act="use-truck" data-id="${t.id}">
            ${plateHtml(t.plate)}<span>${esc(t.driver || '—')}${t.type ? ` <small>(${esc(t.type)})</small>` : ''}</span></button>`).join('')
            || '<div class="empty">لا توجد قلابات مطابقة</div>';
        };
        $('#pick-q', root).addEventListener('input', draw);
        draw();
      },
    });
  }

  function useTruck(id) {
    const t = S.boot.trucks.find((x) => x.id === Number(id));
    if (!t || !$('#x-plate')) return;
    closeModal();
    $('#x-plate').value = t.plate;
    $('#x-driver').value = t.driver || '';
    X.driverAuto = true;
    $('#x-plate').dispatchEvent(new Event('input'));
  }

  function customerModal(c, onSaved) {
    const x = c || {};
    openModal({
      title: c ? 'تعديل عميل' : 'عميل جديد',
      body: `${field('اسم العميل', `<input name="name" value="${esc(x.name)}" required>`)}
        ${field('الجوال', `<input name="phone" value="${esc(x.phone)}" inputmode="tel" dir="ltr">`)}
        ${field('ملاحظات', `<input name="notes" value="${esc(x.notes)}">`)}
        ${c ? field('الحالة', `<select name="active">${opt(1, 'نشط', x.active)}${opt(0, 'موقوف', x.active)}</select>`) : ''}`,
      onSubmit: async (d) => {
        const saved = c ? await api('PUT', `/api/customers/${c.id}`, { ...d, active: d.active !== '0' }) : await api('POST', '/api/customers', d);
        await loadBoot();
        toast('تم حفظ العميل');
        if (onSaved) onSaved(saved);
      },
    });
  }

  // ========== خروج اليوم (موظف البوابة) ==========
  async function viewToday() {
    const trips = await api('GET', '/api/trips?status=all');
    S.tripsCache = trips;
    const active = trips.filter((t) => t.status === 'active');
    $('#app').innerHTML = `<div class="page-head"><h1>خروج اليوم</h1><a class="btn red" href="#exit">+ تسجيل خروج</a></div>
      <div class="stats"><div class="stat red"><div class="l">عدد الردود اليوم</div><div class="v">${active.length}</div></div></div>
      <input id="today-q" placeholder="بحث باللوحة أو رقم السند..." style="margin-bottom:12px">
      <div class="trip-cards" id="today-list"></div>`;
    const draw = () => {
      const q = $('#today-q').value.trim();
      const list = trips.filter((t) => !q || String(t.no) === q || normPlate(t.plate).includes(normPlate(q)) || (t.driver || '').includes(q));
      $('#today-list').innerHTML = list.map(tripCard).join('') || '<div class="empty card">لا توجد عمليات</div>';
    };
    $('#today-q').addEventListener('input', draw);
    draw();
  }

  const tripCard = (t) => `<div class="trip-card ${t.status}">
    <div class="top"><span class="no">#${t.no} — ${plateHtml(t.plate)}</span><span>${timeOf(t.created_at)}</span></div>
    <div>${esc(t.material_name)} — <b>${money(t.price)}</b> ${methodBadge(t.method)} ${t.status === 'cancelled' ? '<span class="badge cancelled">ملغي</span>' : ''}</div>
    <div class="meta">${esc(t.driver || '—')} · ${esc(t.customer_name || 'نقدي')}${t.remaining > 0 ? ` · <span class="due">متبقي ${money(t.remaining)}</span>` : ''}</div>
    <div class="actions"><button class="btn sm" data-act="print-trip" data-id="${t.id}">🖨️ طباعة السند</button></div>
  </div>`;

  // ========== الرئيسية (ملخص اليوم) ==========
  async function viewDashboard() {
    const d = await api('GET', '/api/dashboard');
    const s = d.summary;
    $('#app').innerHTML = `<div class="page-head"><h1>ملخص اليوم <small style="font-weight:400;color:var(--muted)">${esc(d.today)}</small></h1>
        <a class="btn red" href="#exit">+ تسجيل خروج</a></div>
      <div class="stats">
        <div class="stat red"><div class="l">عدد الردود</div><div class="v">${s.trips}</div></div>
        <div class="stat"><div class="l">المبيعات</div><div class="v">${money(s.sales)}</div></div>
        <div class="stat ok"><div class="l">التحصيل النقدي</div><div class="v">${money(s.totalCash)}</div></div>
        <div class="stat blue"><div class="l">التحويلات</div><div class="v">${money(s.totalTransfer)}</div></div>
        <div class="stat red"><div class="l">آجل اليوم</div><div class="v">${money(s.remaining)}</div></div>
        <div class="stat red"><div class="l">إجمالي أرصدة العملاء</div><div class="v">${money(d.outstanding)}</div></div>
      </div>
      ${s.paymentsCash || s.paymentsTransfer ? `<div class="hint" style="margin:-6px 0 12px">التحصيل يشمل سدادات العملاء اليوم: نقد ${money(s.paymentsCash)} · تحويل ${money(s.paymentsTransfer)}</div>` : ''}
      ${d.cancelledToday ? `<div class="hint warn" style="margin-bottom:12px">عمليات ملغاة اليوم: ${d.cancelledToday}</div>` : ''}
      <div class="grid2">
        <div>${groupTable('حسب المادة', d.byMaterial, 'المادة')}</div>
        <div>${groupTable('أكثر القلابات اليوم', d.byPlate, 'اللوحة', true)}</div>
      </div>
      <h3>آخر العمليات</h3>
      ${tripsTable(d.latest, { compact: true })}`;
  }

  function groupTable(title, rows, keyLabel, plate) {
    return `<h3>${title}</h3><div class="table-wrap"><table>
      <thead><tr><th>${keyLabel}</th><th class="n">الردود</th><th class="n">المبيعات</th><th class="n">نقد</th><th class="n">تحويل</th><th class="n">متبقي</th></tr></thead>
      <tbody>${rows.map((g) => `<tr><td>${plate ? plateHtml(g.label) : esc(g.label)}</td><td class="n">${g.trips}</td><td class="n">${fmt(g.sales)}</td>
        <td class="n">${fmt(g.cash)}</td><td class="n">${fmt(g.transfer)}</td><td class="n ${g.remaining > 0 ? 'due' : ''}">${fmt(g.remaining)}</td></tr>`).join('')
        || '<tr><td colspan="6" class="empty">لا توجد بيانات</td></tr>'}</tbody>
      ${rows.length > 1 ? `<tfoot><tr><td>الإجمالي</td><td class="n">${rows.reduce((a, g) => a + g.trips, 0)}</td>
        <td class="n">${fmt(rows.reduce((a, g) => a + g.sales, 0))}</td><td class="n">${fmt(rows.reduce((a, g) => a + g.cash, 0))}</td>
        <td class="n">${fmt(rows.reduce((a, g) => a + g.transfer, 0))}</td><td class="n">${fmt(rows.reduce((a, g) => a + g.remaining, 0))}</td></tr></tfoot>` : ''}
    </table></div>`;
  }

  function tripsTable(trips, opts = {}) {
    S.tripsCache = trips;
    return `<div class="table-wrap"><table>
      <thead><tr><th>السند</th><th>الوقت</th><th>اللوحة</th><th>السائق</th><th>العميل</th><th>المادة</th><th class="n">السعر</th><th class="n">المدفوع</th><th>الدفع</th><th class="n">المتبقي</th>${opts.compact ? '' : '<th>الموظف</th><th>ملاحظات</th>'}<th></th></tr></thead>
      <tbody>${trips.map((t) => `<tr class="${t.status}">
        <td><b>${t.no}</b></td><td>${opts.compact ? timeOf(t.created_at) : esc(t.created_at.slice(0, 16))}</td><td>${plateHtml(t.plate)}</td>
        <td>${esc(t.driver)}</td><td>${esc(t.customer_name || 'نقدي')}</td><td>${esc(t.material_name)}</td><td class="n">${fmt(t.price)}</td>
        <td class="n">${fmt(t.paid)}</td><td class="keep">${methodBadge(t.method)}</td><td class="n ${t.remaining > 0 ? 'due' : ''}">${fmt(t.remaining)}</td>
        ${opts.compact ? '' : `<td>${esc(t.user_name)}</td><td>${esc(t.notes)}</td>`}
        <td class="keep">${t.status === 'cancelled' ? `<span class="badge cancelled" title="${esc(t.cancel_reason)}">ملغي: ${esc(t.cancel_reason)}</span> ` : ''}
          <button class="btn sm" data-act="print-trip" data-id="${t.id}" title="طباعة السند">🖨️</button>
          ${isManager() && t.status === 'active' ? `<button class="btn sm" data-act="edit-trip" data-id="${t.id}">تعديل</button>
          <button class="btn sm danger" data-act="cancel-trip" data-id="${t.id}">إلغاء</button>` : ''}
          ${isManager() ? `<button class="btn sm ghost" data-act="trip-history" data-id="${t.id}" title="سجل التغييرات">🕘</button>` : ''}</td>
      </tr>`).join('') || `<tr><td colspan="13" class="empty">لا توجد عمليات</td></tr>`}</tbody>
    </table></div>`;
  }

  // ========== العمليات (بحث وتعديل وإلغاء) ==========
  const tripsF = { from: '', to: '', q: '', plate: '', customerId: '', materialId: '', method: '', status: 'active' };

  async function viewTrips() {
    if (!tripsF.from) tripsF.from = tripsF.to = today();
    const trips = await api('GET', '/api/trips?' + qs({ ...tripsF, limit: 2000 }));
    const active = trips.filter((t) => t.status === 'active');
    const sum = (f) => active.reduce((a, t) => a + f(t), 0);
    $('#app').innerHTML = `<div class="page-head"><h1>العمليات</h1></div>
      <div class="card"><form class="toolbar" id="tripsFilter">
        <div class="f"><label>بحث</label><input name="q" value="${esc(tripsF.q)}" placeholder="رقم سند، لوحة، سائق، عميل"></div>
        <div class="f"><label>من</label><input type="date" name="from" value="${tripsF.from}"></div>
        <div class="f"><label>إلى</label><input type="date" name="to" value="${tripsF.to}"></div>
        <div class="f"><label>العميل</label><select name="customerId"><option value="">الكل</option>${S.boot.customers.map((c) => opt(c.id, c.name, tripsF.customerId)).join('')}</select></div>
        <div class="f"><label>المادة</label><select name="materialId"><option value="">الكل</option>${S.boot.materials.map((m) => opt(m.id, m.name, tripsF.materialId)).join('')}</select></div>
        <div class="f"><label>الدفع</label><select name="method"><option value="">الكل</option>${Object.entries(METHODS).map(([k, v]) => opt(k, v, tripsF.method)).join('')}</select></div>
        <div class="f"><label>الحالة</label><select name="status">${opt('active', 'سارية', tripsF.status)}${opt('cancelled', 'ملغاة', tripsF.status)}${opt('all', 'الكل', tripsF.status)}</select></div>
        <button class="btn black" type="submit">بحث</button>
      </form></div>
      <div class="stats">
        <div class="stat red"><div class="l">الردود</div><div class="v">${active.length}</div></div>
        <div class="stat"><div class="l">المبيعات</div><div class="v">${money(sum((t) => t.price))}</div></div>
        <div class="stat ok"><div class="l">نقد</div><div class="v">${money(sum((t) => (t.method === 'cash' ? t.paid : 0)))}</div></div>
        <div class="stat blue"><div class="l">تحويل</div><div class="v">${money(sum((t) => (t.method === 'transfer' ? t.paid : 0)))}</div></div>
        <div class="stat red"><div class="l">متبقي</div><div class="v">${money(sum((t) => t.remaining))}</div></div>
      </div>
      ${tripsTable(trips)}`;
    $('#tripsFilter').addEventListener('submit', (e) => {
      e.preventDefault();
      Object.assign(tripsF, Object.fromEntries(new FormData(e.target).entries()));
      viewTrips();
    });
  }

  async function findTrip(id) {
    const cached = (S.tripsCache || []).find((t) => t.id === Number(id));
    return cached || api('GET', `/api/trips/${id}`);
  }

  async function editTrip(id) {
    const t = await api('GET', `/api/trips/${id}`);
    await loadBoot();
    const b = S.boot;
    openModal({
      title: `تعديل سند ${t.no}`,
      body: `<div class="grid2">
        ${field('رقم اللوحة', `<input class="plate" name="plate" value="${esc(t.plate)}" list="plateList" required>`)}
        ${field('اسم السائق', `<input name="driver" value="${esc(t.driver)}">`)}
        ${field('العميل', `<select name="customerId"><option value="">— نقدي —</option>${b.customers.map((c) => opt(c.id, c.name, t.customer_id)).join('')}</select>`)}
        ${field('المادة', `<select name="materialId">${b.materials.map((m) => opt(m.id, m.name, t.material_id)).join('')}</select>`)}
        ${field('سعر الرد', `<input class="money" name="price" inputmode="decimal" value="${t.price}">`)}
        ${field('طريقة الدفع', `<select name="method">${Object.entries(METHODS).map(([k, v]) => opt(k, v, t.method)).join('')}</select>`)}
        ${field('المدفوع', `<input class="money" name="paid" inputmode="decimal" value="${t.paid}">`)}
        ${field('ملاحظات', `<input name="notes" value="${esc(t.notes)}">`)}
        </div>
        ${field('سبب التعديل', '<textarea name="reason" required></textarea>', 'يُحفظ في سجل التغييرات')}`,
      onSubmit: async (d) => {
        if (!d.reason.trim()) { showModalError('اكتب سبب التعديل'); return false; }
        await api('PUT', `/api/trips/${id}`, { ...d, paid: d.method === 'credit' ? 0 : d.paid });
        toast('تم حفظ التعديل');
        render();
      },
    });
  }

  async function cancelTrip(id) {
    const t = await findTrip(id);
    const reason = await askReason(`إلغاء سند ${t.no} — ${t.plate}`, 'سبب الإلغاء');
    if (!reason) return;
    await api('POST', `/api/trips/${id}/cancel`, { reason });
    toast('تم إلغاء العملية');
    render();
  }

  async function showHistory(entity, id, title) {
    const rows = await api('GET', '/api/audit?' + qs({ entity, entityId: id }));
    openModal({ title, body: auditList(rows), actions: '<button type="button" class="btn ghost" data-close>إغلاق</button>' });
  }

  // ========== العملاء ==========
  async function viewCustomers() {
    const list = await api('GET', '/api/customers');
    const due = list.reduce((a, c) => a + Math.max(0, c.balance), 0);
    $('#app').innerHTML = `<div class="page-head"><h1>العملاء والحسابات</h1><button class="btn red" data-act="new-customer">+ عميل جديد</button></div>
      <div class="stats"><div class="stat"><div class="l">عدد العملاء</div><div class="v">${list.length}</div></div>
        <div class="stat red"><div class="l">إجمالي المتبقي على العملاء</div><div class="v">${money(due)}</div></div></div>
      <input id="cust-q" placeholder="بحث بالاسم أو الجوال..." style="margin-bottom:12px">
      <div class="table-wrap"><table><thead><tr><th>العميل</th><th>الجوال</th><th class="n">الردود</th><th class="n">الرصيد المتبقي</th><th></th></tr></thead>
      <tbody id="cust-body"></tbody></table></div>`;
    const draw = () => {
      const q = $('#cust-q').value.trim();
      $('#cust-body').innerHTML = list.filter((c) => !q || c.name.includes(q) || (c.phone || '').includes(q)).map((c) => `<tr>
        <td><a href="#customer/${c.id}"><b>${esc(c.name)}</b></a>${c.active ? '' : ' <span class="badge cancelled">موقوف</span>'}</td>
        <td dir="ltr">${esc(c.phone)}</td><td class="n">${c.trips}</td><td class="n ${c.balance > 0 ? 'due' : 'paid'}">${fmt(c.balance)}</td>
        <td><a class="btn sm" href="#customer/${c.id}">كشف حساب</a> <button class="btn sm" data-act="pay-customer" data-id="${c.id}">+ سداد</button>
          <button class="btn sm ghost" data-act="edit-customer" data-id="${c.id}">تعديل</button></td></tr>`).join('')
        || '<tr><td colspan="5" class="empty">لا يوجد عملاء</td></tr>';
    };
    $('#cust-q').addEventListener('input', draw);
    draw();
  }

  const stmtF = { from: '', to: '' };
  async function viewCustomer(id) {
    const st = await api('GET', `/api/customers/${id}/statement?` + qs(stmtF));
    const c = st.customer;
    S.statement = st;
    $('#app').innerHTML = `<div class="page-head"><h1>كشف حساب: ${esc(c.name)}</h1>
        <a class="btn ghost" href="#customers">→ العملاء</a>
        <button class="btn red" data-act="pay-customer" data-id="${c.id}">+ تسجيل سداد</button></div>
      <div class="card"><form class="toolbar" id="stmtFilter">
        <div class="f"><label>من</label><input type="date" name="from" value="${stmtF.from}"></div>
        <div class="f"><label>إلى</label><input type="date" name="to" value="${stmtF.to}"></div>
        <button class="btn black" type="submit">عرض</button>
        <button class="btn" type="button" data-act="print-statement">🖨️ طباعة</button>
        <button class="btn" type="button" data-act="pdf-statement">PDF</button>
      </form></div>
      <div id="stmtBody">${statementBody(st)}</div>`;
    $('#stmtFilter').addEventListener('submit', (e) => {
      e.preventDefault();
      Object.assign(stmtF, Object.fromEntries(new FormData(e.target).entries()));
      viewCustomer(id);
    });
  }

  function statementBody(st) {
    const t = st.totals;
    return `<div class="stats">
        <div class="stat"><div class="l">عدد الردود</div><div class="v">${t.trips}</div></div>
        <div class="stat"><div class="l">المبيعات</div><div class="v">${money(t.sales)}</div></div>
        <div class="stat ok"><div class="l">المدفوع عند الخروج</div><div class="v">${money(t.paidAtExit)}</div></div>
        <div class="stat ok"><div class="l">السدادات</div><div class="v">${money(t.payments)}</div></div>
        <div class="stat red"><div class="l">المتبقي</div><div class="v">${money(st.closing)}</div></div>
      </div>
      <div class="table-wrap"><table>
        <thead><tr><th>التاريخ</th><th>رقم</th><th>البيان</th><th class="n">المبيعات</th><th class="n">المدفوع</th><th>الطريقة</th><th class="n">الرصيد</th></tr></thead>
        <tbody>${st.from !== '0000-01-01' ? `<tr><td colspan="6">رصيد سابق</td><td class="n">${fmt(st.opening)}</td></tr>` : ''}
        ${st.entries.map((e) => `<tr><td>${esc(e.at.slice(0, 16))}</td><td>${e.kind === 'trip' ? 'سند ' : 'سداد '}${e.no}</td><td>${esc(e.desc)}</td>
          <td class="n">${e.sale ? fmt(e.sale) : ''}</td><td class="n">${e.paid ? fmt(e.paid) : ''}</td><td>${e.paid ? methodBadge(e.method) : ''}</td>
          <td class="n ${e.balance > 0 ? 'due' : ''}">${fmt(e.balance)}</td></tr>`).join('') || '<tr><td colspan="7" class="empty">لا توجد حركات</td></tr>'}</tbody>
        <tfoot><tr><td colspan="3">الإجمالي</td><td class="n">${fmt(t.sales)}</td><td class="n">${fmt(t.paidAtExit + t.payments)}</td><td></td><td class="n">${fmt(st.closing)}</td></tr></tfoot>
      </table></div>`;
  }

  function paymentModal(customerId) {
    const requestId = newRequestId();
    const list = S.boot.customers.filter((c) => c.active || String(c.id) === String(customerId));
    openModal({
      title: 'تسجيل سداد من عميل',
      body: `${field('العميل', `<select name="customerId" id="pay-cust" required><option value="">— اختر —</option>${list.map((c) => opt(c.id, c.name, customerId)).join('')}</select>`)}
        <div class="hint" id="pay-bal" style="margin:-8px 0 12px"></div>
        ${field('المبلغ', '<input class="big money" name="amount" inputmode="decimal" required>')}
        ${field('طريقة الدفع', `<select name="method">${opt('cash', 'نقد')}${opt('transfer', 'تحويل')}</select>`)}
        ${field('التاريخ', `<input type="date" name="date" value="${today()}">`)}
        ${field('ملاحظات', '<input name="notes">')}
        <div class="hint">السداد يخصم من رصيد العميل ولا يُحسب مبيعات جديدة.</div>`,
      onOpen: (root) => {
        const sel = $('#pay-cust', root);
        const show = async () => {
          if (!sel.value) { $('#pay-bal', root).textContent = ''; return; }
          const all = await api('GET', '/api/customers');
          const c = all.find((x) => String(x.id) === sel.value);
          if (c) $('#pay-bal', root).innerHTML = `الرصيد الحالي: <b class="${c.balance > 0 ? 'due' : ''}">${money(c.balance)}</b>`;
        };
        sel.addEventListener('change', show);
        show();
      },
      onSubmit: async (d) => {
        if (!d.customerId) { showModalError('اختر العميل'); return false; }
        if (!(toNum(d.amount) > 0)) { showModalError('أدخل المبلغ'); return false; }
        await api('POST', '/api/payments', { ...d, requestId });
        toast('تم تسجيل السداد');
        render();
      },
    });
  }

  // ========== السدادات ==========
  const payF = { from: '', to: '', customerId: '' };
  async function viewPayments() {
    if (!payF.from) { payF.from = monthStart(); payF.to = today(); }
    const list = await api('GET', '/api/payments?' + qs({ ...payF, status: 'all' }));
    const active = list.filter((p) => p.status === 'active');
    $('#app').innerHTML = `<div class="page-head"><h1>سداد العملاء</h1><button class="btn red" data-act="pay-customer">+ تسجيل سداد</button></div>
      <div class="card"><form class="toolbar" id="payFilter">
        <div class="f"><label>من</label><input type="date" name="from" value="${payF.from}"></div>
        <div class="f"><label>إلى</label><input type="date" name="to" value="${payF.to}"></div>
        <div class="f"><label>العميل</label><select name="customerId"><option value="">الكل</option>${S.boot.customers.map((c) => opt(c.id, c.name, payF.customerId)).join('')}</select></div>
        <button class="btn black" type="submit">عرض</button></form></div>
      <div class="stats"><div class="stat ok"><div class="l">نقد</div><div class="v">${money(active.filter((p) => p.method === 'cash').reduce((a, p) => a + p.amount, 0))}</div></div>
        <div class="stat blue"><div class="l">تحويل</div><div class="v">${money(active.filter((p) => p.method === 'transfer').reduce((a, p) => a + p.amount, 0))}</div></div></div>
      <div class="table-wrap"><table><thead><tr><th>رقم</th><th>التاريخ</th><th>العميل</th><th class="n">المبلغ</th><th>الطريقة</th><th>الموظف</th><th>ملاحظات</th><th></th></tr></thead>
      <tbody>${list.map((p) => `<tr class="${p.status}"><td>${p.no}</td><td>${esc(p.date)} ${timeOf(p.created_at)}</td><td>${esc(p.customer_name)}</td>
        <td class="n">${fmt(p.amount)}</td><td class="keep">${methodBadge(p.method)}</td><td>${esc(p.user_name)}</td><td>${esc(p.notes)}</td>
        <td class="keep">${p.status === 'active' ? `<button class="btn sm danger" data-act="cancel-payment" data-id="${p.id}">إلغاء</button>` : `<span class="badge cancelled">ملغي: ${esc(p.cancel_reason)}</span>`}</td></tr>`).join('')
        || '<tr><td colspan="8" class="empty">لا توجد سدادات</td></tr>'}</tbody></table></div>`;
    $('#payFilter').addEventListener('submit', (e) => {
      e.preventDefault();
      Object.assign(payF, Object.fromEntries(new FormData(e.target).entries()));
      viewPayments();
    });
  }

  // ========== القلابات ==========
  async function viewTrucks() {
    const list = await api('GET', '/api/trucks');
    S.trucksCache = list;
    $('#app').innerHTML = `<div class="page-head"><h1>القلابات والسائقين</h1><button class="btn red" data-act="new-truck">+ قلاب جديد</button></div>
      <input id="truck-q" placeholder="بحث باللوحة أو السائق..." style="margin-bottom:12px">
      <div class="table-wrap"><table><thead><tr><th>اللوحة</th><th>السائق</th><th>جوال السائق</th><th>النوع</th><th class="n">الردود</th><th>آخر خروج</th><th></th></tr></thead>
      <tbody id="truck-body"></tbody></table></div>`;
    const draw = () => {
      const q = $('#truck-q').value.trim();
      $('#truck-body').innerHTML = list.filter((t) => !q || normPlate(t.plate).includes(normPlate(q)) || (t.driver || '').includes(q)).map((t) => `<tr>
        <td>${plateHtml(t.plate)}${t.active ? '' : ' <span class="badge cancelled">موقوف</span>'}</td><td>${esc(t.driver)}</td><td dir="ltr">${esc(t.driver_phone)}</td>
        <td>${esc(t.type)}</td><td class="n">${t.trips}</td><td>${esc((t.last_trip || '').slice(0, 16))}</td>
        <td><button class="btn sm" data-act="truck-report" data-plate="${esc(t.plate)}">كشف</button>
          <button class="btn sm ghost" data-act="edit-truck" data-id="${t.id}">تعديل</button></td></tr>`).join('')
        || '<tr><td colspan="7" class="empty">لا توجد قلابات. تُسجل تلقائياً عند أول خروج</td></tr>';
    };
    $('#truck-q').addEventListener('input', draw);
    draw();
  }

  function truckModal(t) {
    const x = t || {};
    openModal({
      title: t ? `تعديل قلاب ${t.plate}` : 'قلاب جديد',
      body: `${field('رقم اللوحة', `<input class="plate big" name="plate" value="${esc(x.plate)}" required>`)}
        <div class="grid2">${field('اسم السائق', `<input name="driver" value="${esc(x.driver)}">`)}
        ${field('جوال السائق', `<input name="driver_phone" value="${esc(x.driver_phone)}" inputmode="tel" dir="ltr">`)}</div>
        ${field('نوع القلاب', `<input name="type" list="truckTypes" value="${esc(x.type)}" placeholder="سكس، تريلا...">`)}
        ${field('ملاحظات', `<input name="notes" value="${esc(x.notes)}">`)}
        ${t ? field('الحالة', `<select name="active">${opt(1, 'نشط', x.active)}${opt(0, 'موقوف', x.active)}</select>`) : ''}`,
      onSubmit: async (d) => {
        if (t) await api('PUT', `/api/trucks/${t.id}`, { ...d, active: d.active !== '0' });
        else await api('POST', '/api/trucks', d);
        await loadBoot();
        toast('تم الحفظ');
        render();
      },
    });
  }

  // ========== التقارير ==========
  const repF = { from: '', to: '', plate: '', customerId: '', materialId: '' };

  async function viewReports() {
    if (!repF.from) { repF.from = monthStart(); repF.to = today(); }
    const r = await api('GET', '/api/reports?' + qs({ ...repF, withTrips: 1 }));
    S.report = r;
    $('#app').innerHTML = `<div class="page-head"><h1>التقارير</h1></div>
      <div class="card"><form class="toolbar" id="repFilter">
        <div class="f"><label>من</label><input type="date" name="from" value="${repF.from}"></div>
        <div class="f"><label>إلى</label><input type="date" name="to" value="${repF.to}"></div>
        <div class="f"><label>اللوحة</label><input name="plate" class="plate" list="plateList" value="${esc(repF.plate)}"></div>
        <div class="f"><label>العميل</label><select name="customerId"><option value="">الكل</option>${S.boot.customers.map((c) => opt(c.id, c.name, repF.customerId)).join('')}</select></div>
        <div class="f"><label>المادة</label><select name="materialId"><option value="">الكل</option>${S.boot.materials.map((m) => opt(m.id, m.name, repF.materialId)).join('')}</select></div>
        <button class="btn black" type="submit">عرض</button>
      </form>
      <div class="toolbar" style="margin:0">
        <button class="btn sm" data-act="range" data-r="today">اليوم</button>
        <button class="btn sm" data-act="range" data-r="week">آخر 7 أيام</button>
        <button class="btn sm" data-act="range" data-r="month">هذا الشهر</button>
        <button class="btn sm" data-act="range" data-r="year">هذه السنة</button>
        <span style="flex:1"></span>
        <button class="btn sm black" data-act="print-report">🖨️ طباعة</button>
        <button class="btn sm black" data-act="pdf-report">PDF</button>
        <button class="btn sm red" data-act="excel-report">Excel</button>
      </div></div>
      <div id="reportBody">${reportBody(r)}</div>`;
    $('#repFilter').addEventListener('submit', (e) => {
      e.preventDefault();
      Object.assign(repF, Object.fromEntries(new FormData(e.target).entries()));
      viewReports();
    });
  }

  function reportBody(r) {
    const s = r.summary;
    const filters = [
      repF.plate && `اللوحة: ${repF.plate}`,
      repF.customerId && `العميل: ${(S.boot.customers.find((c) => String(c.id) === String(repF.customerId)) || {}).name}`,
      repF.materialId && `المادة: ${(S.boot.materials.find((m) => String(m.id) === String(repF.materialId)) || {}).name}`,
    ].filter(Boolean).join(' — ');
    return `<p><b>الفترة:</b> ${esc(r.from)} إلى ${esc(r.to)}${filters ? ` — ${esc(filters)}` : ''}</p>
      <div class="stats">
        <div class="stat red"><div class="l">عدد الردود</div><div class="v">${s.trips}</div></div>
        <div class="stat"><div class="l">المبيعات</div><div class="v">${money(s.sales)}</div></div>
        <div class="stat ok"><div class="l">التحصيل النقدي</div><div class="v">${money(s.totalCash)}</div></div>
        <div class="stat blue"><div class="l">التحويلات</div><div class="v">${money(s.totalTransfer)}</div></div>
        <div class="stat red"><div class="l">آجل من ردود الفترة</div><div class="v">${money(s.remaining)}</div></div>
        <div class="stat red"><div class="l">الأرصدة المتبقية</div><div class="v">${money(s.balances)}</div></div>
      </div>
      <div class="hint" style="margin:-6px 0 12px">التحصيل = المدفوع عند الخروج (نقد ${money(s.cash)} · تحويل ${money(s.transfer)})${r.payments ? ` + سدادات العملاء (نقد ${money(s.paymentsCash)} · تحويل ${money(s.paymentsTransfer)})` : ' — السدادات لا تظهر عند التصفية باللوحة أو المادة'}</div>
      <div class="grid2">
        <div>${groupTable('حسب نوع المادة', r.byMaterial, 'المادة')}</div>
        <div>${groupTable('حسب العميل', r.byCustomer, 'العميل')}</div>
      </div>
      ${groupTable('حسب اللوحة', r.byPlate, 'اللوحة', true)}
      ${groupTable('حسب اليوم', r.byDay, 'اليوم')}
      <h3>أرصدة العملاء المتبقية (حتى ${esc(r.to)})</h3>
      <div class="table-wrap"><table><thead><tr><th>العميل</th><th>الجوال</th><th class="n">الرصيد</th></tr></thead>
        <tbody>${r.balances.map((c) => `<tr><td>${esc(c.name)}</td><td dir="ltr">${esc(c.phone)}</td><td class="n ${c.balance > 0 ? 'due' : ''}">${fmt(c.balance)}</td></tr>`).join('')
          || '<tr><td colspan="3" class="empty">لا توجد أرصدة متبقية</td></tr>'}</tbody></table></div>
      <h3>تفاصيل الردود</h3>
      <div class="table-wrap"><table><thead><tr><th>السند</th><th>التاريخ</th><th>اللوحة</th><th>السائق</th><th>العميل</th><th>المادة</th><th class="n">السعر</th><th class="n">المدفوع</th><th>الدفع</th><th class="n">المتبقي</th></tr></thead>
        <tbody>${r.trips.map((t) => `<tr><td>${t.no}</td><td>${esc(t.created_at.slice(0, 16))}</td><td>${plateHtml(t.plate)}</td><td>${esc(t.driver)}</td>
          <td>${esc(t.customer_name || 'نقدي')}</td><td>${esc(t.material_name)}</td><td class="n">${fmt(t.price)}</td><td class="n">${fmt(t.paid)}</td>
          <td>${methodBadge(t.method)}</td><td class="n">${fmt(t.remaining)}</td></tr>`).join('') || '<tr><td colspan="10" class="empty">لا توجد ردود</td></tr>'}</tbody></table></div>`;
  }

  function setRange(r) {
    const t = today();
    const d = new Date(t + 'T00:00:00');
    repF.to = t;
    if (r === 'today') repF.from = t;
    else if (r === 'week') { d.setDate(d.getDate() - 6); repF.from = d.toISOString().slice(0, 10); }
    else if (r === 'month') repF.from = monthStart();
    else repF.from = t.slice(0, 5) + '01-01';
    viewReports();
  }

  // ========== سجل التغييرات ==========
  const LABELS = {
    plate: 'اللوحة', driver: 'السائق', customer_name: 'العميل', material_name: 'المادة', price: 'السعر', paid: 'المدفوع',
    remaining: 'المتبقي', method: 'الدفع', notes: 'ملاحظات', name: 'الاسم', phone: 'الجوال', type: 'النوع', active: 'نشط',
    role: 'الصلاحية', amount: 'المبلغ', companyName: 'اسم الشركة', city: 'المدينة', voucherTitle: 'عنوان السند',
    voucherSize: 'حجم السند', duplicateMinutes: 'مدة تنبيه التكرار', currency: 'العملة', driver_phone: 'جوال السائق', status: 'الحالة',
  };
  function diffHtml(a) {
    if (!a.before || !a.after) return '';
    const b = JSON.parse(a.before), c = JSON.parse(a.after);
    const lines = Object.keys(LABELS).filter((k) => k in c && k in b && String(b[k] ?? '') !== String(c[k] ?? ''))
      .map((k) => `<div><b>${LABELS[k]}:</b> ${esc(k === 'method' ? METHODS[b[k]] : b[k])} ← ${esc(k === 'method' ? METHODS[c[k]] : c[k])}</div>`);
    return lines.length ? `<div class="diff">${lines.join('')}</div>` : '';
  }
  const auditList = (rows) => `<div class="table-wrap"><table><thead><tr><th>الوقت</th><th>المستخدم</th><th>العملية</th><th>التفاصيل</th></tr></thead>
    <tbody>${rows.map((a) => `<tr><td>${esc(a.at.slice(0, 16))}</td><td>${esc(a.user_name)}</td><td><b>${esc(a.action)}</b></td>
      <td style="white-space:normal">${esc(a.summary)}${a.reason ? `<div class="due">السبب: ${esc(a.reason)}</div>` : ''}${diffHtml(a)}</td></tr>`).join('')
      || '<tr><td colspan="4" class="empty">لا يوجد سجل</td></tr>'}</tbody></table></div>`;

  async function viewAudit() {
    const q = S.auditQ || '';
    const rows = await api('GET', '/api/audit?' + qs({ q }));
    $('#app').innerHTML = `<div class="page-head"><h1>سجل التغييرات</h1></div>
      <form class="toolbar" id="auditF"><div class="f"><input name="q" value="${esc(q)}" placeholder="بحث (رقم سند، مستخدم، سبب...)"></div><button class="btn black">بحث</button></form>
      ${auditList(rows)}`;
    $('#auditF').addEventListener('submit', (e) => { e.preventDefault(); S.auditQ = e.target.q.value; viewAudit(); });
  }

  // ========== الأصول ==========
  function depreciation(a) {
    const cost = toNum(a.cost), salvage = toNum(a.salvage), life = toNum(a.life_years);
    if (!a.purchase_date || !life || cost <= salvage) return { yearly: 0, acc: 0, book: cost };
    const years = Math.max(0, (new Date(today()) - new Date(a.purchase_date)) / (365.25 * 864e5));
    const yearly = (cost - salvage) / life;
    const acc = Math.min(cost - salvage, yearly * years);
    return { yearly: round2(yearly), acc: round2(acc), book: round2(cost - acc) };
  }

  async function viewAssets() {
    const list = await api('GET', '/api/assets');
    S.assetsCache = list;
    const live = list.filter((a) => a.status !== 'sold');
    $('#app').innerHTML = `<div class="page-head"><h1>الأصول</h1><button class="btn red" data-act="new-asset">+ تسجيل أصل</button>
        <button class="btn" data-act="print-assets">🖨️ طباعة</button></div>
      <div class="stats"><div class="stat"><div class="l">عدد الأصول</div><div class="v">${live.length}</div></div>
        <div class="stat"><div class="l">قيمة الشراء</div><div class="v">${money(live.reduce((a, x) => a + x.cost, 0))}</div></div>
        <div class="stat ok"><div class="l">القيمة الدفترية</div><div class="v">${money(live.reduce((a, x) => a + depreciation(x).book, 0))}</div></div></div>
      <div id="assetsTable">${assetsTable(list, true)}</div>
      <div class="hint">الإهلاك بطريقة القسط الثابت: (قيمة الشراء − القيمة المتبقية) ÷ العمر الإنتاجي.</div>`;
  }

  const assetsTable = (list, actions) => `<div class="table-wrap"><table><thead><tr><th>الأصل</th><th>النوع</th><th>اللوحة / التسلسلي</th><th>تاريخ الشراء</th>
    <th class="n">قيمة الشراء</th><th class="n">الإهلاك السنوي</th><th class="n">مجمع الإهلاك</th><th class="n">القيمة الدفترية</th><th>الحالة</th>${actions ? '<th></th>' : ''}</tr></thead>
    <tbody>${list.map((a) => {
      const d = depreciation(a);
      return `<tr><td><b>${esc(a.name)}</b></td><td>${esc(a.type)}</td><td>${plateHtml(a.identifier)}</td><td>${esc(a.purchase_date || '')}</td>
        <td class="n">${fmt(a.cost)}</td><td class="n">${fmt(d.yearly)}</td><td class="n">${fmt(d.acc)}</td><td class="n"><b>${fmt(d.book)}</b></td>
        <td>${ASSET_STATUS[a.status] || ''}</td>${actions ? `<td><button class="btn sm ghost" data-act="edit-asset" data-id="${a.id}">تعديل</button></td>` : ''}</tr>`;
    }).join('') || `<tr><td colspan="10" class="empty">لم تُسجل أصول بعد</td></tr>`}</tbody></table></div>`;

  function assetModal(a) {
    const x = a || { status: 'active', life_years: 5, purchase_date: today() };
    openModal({
      title: a ? 'تعديل أصل' : 'تسجيل أصل',
      body: `${field('اسم الأصل', `<input name="name" value="${esc(x.name)}" required placeholder="مثال: شيول كاتربيلر 950">`)}
        <div class="grid2">${field('النوع', `<select name="type">${ASSET_TYPES.map((t) => opt(t, t, x.type)).join('')}</select>`)}
        ${field('اللوحة / الرقم التسلسلي', `<input name="identifier" value="${esc(x.identifier)}" dir="ltr">`)}
        ${field('تاريخ الشراء', `<input type="date" name="purchase_date" value="${esc(x.purchase_date || '')}">`)}
        ${field('قيمة الشراء', `<input class="money" name="cost" inputmode="decimal" value="${esc(x.cost ?? '')}">`)}
        ${field('العمر الإنتاجي (سنوات)', `<input class="money" name="life_years" inputmode="decimal" value="${esc(x.life_years ?? '')}">`)}
        ${field('القيمة المتبقية (الخردة)', `<input class="money" name="salvage" inputmode="decimal" value="${esc(x.salvage ?? '')}">`)}
        ${field('الحالة', `<select name="status">${Object.entries(ASSET_STATUS).map(([k, v]) => opt(k, v, x.status)).join('')}</select>`)}
        ${field('الموقع / المسؤول', `<input name="location" value="${esc(x.location)}">`)}</div>
        ${field('ملاحظات', `<input name="notes" value="${esc(x.notes)}">`)}`,
      onSubmit: async (d) => {
        if (a) await api('PUT', `/api/assets/${a.id}`, d); else await api('POST', '/api/assets', d);
        toast('تم الحفظ');
        render();
      },
    });
  }

  // ========== الإعدادات ==========
  async function viewSettings() {
    const st = S.boot.settings;
    const users = await api('GET', '/api/users');
    S.usersCache = users;
    $('#app').innerHTML = `<h1>الإعدادات</h1>
      <div class="card"><h2>بيانات الشركة والسند</h2><br>
        <form id="settingsForm">
          <div class="grid2">
            ${field('اسم الشركة', `<input name="companyName" value="${esc(st.companyName)}">`)}
            ${field('المدينة', `<input name="city" value="${esc(st.city)}">`)}
            ${field('الهاتف', `<input name="phone" value="${esc(st.phone)}" dir="ltr">`)}
            ${field('العملة', `<input name="currency" value="${esc(st.currency)}">`)}
            ${field('العنوان الفرعي للسند', `<input name="voucherTitle" value="${esc(st.voucherTitle)}">`)}
            ${field('حجم السند', `<select name="voucherSize">${opt('a5', 'A5 (نموذج الشركة)', st.voucherSize)}${opt('80mm', 'طابعة إيصالات 80 ملم', st.voucherSize)}</select>`)}
            ${field('تنبيه تكرار اللوحة خلال (دقيقة)', `<input class="money" name="duplicateMinutes" inputmode="numeric" value="${esc(st.duplicateMinutes)}">`, '0 = إيقاف التنبيه')}
          </div>
          <div class="field"><label class="lbl">الشعار</label><div class="row" style="align-items:center">
            <img src="${esc(logoSrc())}" alt="" style="height:64px;border:1px solid var(--line);border-radius:8px;padding:4px;background:#fff">
            <label class="btn ghost" style="margin:0">تغيير الشعار<input type="file" id="logoFile" accept="image/png,image/jpeg,image/webp" hidden></label>
            ${st.logo ? '<button type="button" class="btn ghost danger" data-act="reset-logo">الشعار الافتراضي</button>' : ''}
          </div></div>
          <div class="row"><button class="btn red" type="submit">حفظ الإعدادات</button>
            <button type="button" class="btn ghost" data-act="sample-voucher">معاينة السند</button></div>
        </form></div>

      <div class="card"><div class="page-head"><h2 style="flex:1">أنواع المواد</h2><button class="btn sm red" data-act="new-material">+ مادة</button></div>
        <div class="table-wrap"><table><tbody>${S.boot.materials.map((m) => `<tr><td><b>${esc(m.name)}</b>${m.active ? '' : ' <span class="badge cancelled">موقوفة</span>'}</td>
          <td style="text-align:left"><button class="btn sm ghost" data-act="edit-material" data-id="${m.id}">تعديل</button></td></tr>`).join('')}</tbody></table></div>
        <div class="hint">تغيير اسم المادة لا يغير السندات السابقة.</div></div>

      <div class="card"><div class="page-head"><h2 style="flex:1">المستخدمين والصلاحيات</h2><button class="btn sm red" data-act="new-user">+ مستخدم</button></div>
        <div class="table-wrap"><table><thead><tr><th>الاسم</th><th>اسم المستخدم</th><th>الصلاحية</th><th>الحالة</th><th></th></tr></thead>
        <tbody>${users.map((u) => `<tr><td>${esc(u.name)}</td><td dir="ltr">${esc(u.username)}</td>
          <td><span class="badge ${u.role}">${u.role === 'manager' ? 'مدير' : 'موظف بوابة'}</span></td><td>${u.active ? 'نشط' : '<span class="badge cancelled">موقوف</span>'}</td>
          <td><button class="btn sm ghost" data-act="edit-user" data-id="${u.id}">تعديل</button></td></tr>`).join('')}</tbody></table></div>
        <div class="hint">موظف البوابة: تسجيل الخروج وطباعة سندات اليوم فقط. المدير: كل الصلاحيات (التقارير، التعديل، الإلغاء، الإعدادات).</div></div>

      <div class="card"><h2>النسخ الاحتياطي</h2>
        <p class="hint">البيانات محفوظة في قاعدة بيانات دائمة على الخادم. للاحتياط، نزّل نسخة بشكل دوري واحفظها في مكان آخر.</p>
        <button class="btn black" data-act="backup">⬇️ تنزيل نسخة احتياطية</button></div>`;

    $('#settingsForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await api('PUT', '/api/settings', Object.fromEntries(new FormData(e.target).entries()));
        await loadBoot();
        renderShell();
        toast('تم حفظ الإعدادات');
        render();
      } catch (err) { toast(err.message); }
    });
    $('#logoFile').addEventListener('change', (e) => {
      const f = e.target.files[0];
      if (!f) return;
      if (f.size > 1.4e6) { toast('حجم الشعار كبير (الحد 1.4 ميجا)'); return; }
      const reader = new FileReader();
      reader.onload = async () => {
        try {
          await api('PUT', '/api/settings', { logo: reader.result });
          await loadBoot();
          toast('تم تغيير الشعار');
          render();
        } catch (err) { toast(err.message); }
      };
      reader.readAsDataURL(f);
    });
  }

  function materialModal(m) {
    openModal({
      title: m ? 'تعديل مادة' : 'مادة جديدة',
      body: `${field('اسم المادة', `<input name="name" value="${esc(m ? m.name : '')}" required>`)}
        ${m ? field('الحالة', `<select name="active">${opt(1, 'نشطة', m.active)}${opt(0, 'موقوفة (لا تظهر في شاشة الخروج)', m.active)}</select>`) : ''}`,
      onSubmit: async (d) => {
        if (m) await api('PUT', `/api/materials/${m.id}`, { name: d.name, active: d.active !== '0' });
        else await api('POST', '/api/materials', d);
        await loadBoot();
        toast('تم الحفظ');
        render();
      },
    });
  }

  function userModal(u) {
    openModal({
      title: u ? `تعديل مستخدم: ${u.name}` : 'مستخدم جديد',
      body: `${field('الاسم', `<input name="name" value="${esc(u ? u.name : '')}" required>`)}
        ${u ? '' : field('اسم المستخدم (للدخول)', '<input name="username" required dir="ltr" autocapitalize="off">')}
        ${field(u ? 'كلمة مرور جديدة (اتركها فارغة لعدم التغيير)' : 'كلمة المرور', `<input name="password" type="text" ${u ? '' : 'required'} dir="ltr" autocomplete="new-password">`, '6 أحرف على الأقل')}
        ${field('الصلاحية', `<select name="role">${opt('gate', 'موظف بوابة (تسجيل فقط)', u && u.role)}${opt('manager', 'مدير (تقارير وتعديل وإلغاء)', u && u.role)}</select>`)}
        ${u ? field('الحالة', `<select name="active">${opt(1, 'نشط', u.active)}${opt(0, 'موقوف', u.active)}</select>`) : ''}`,
      onSubmit: async (d) => {
        if (u) await api('PUT', `/api/users/${u.id}`, { ...d, active: d.active !== '0' });
        else await api('POST', '/api/users', d);
        toast('تم الحفظ');
        render();
      },
    });
  }

  // ---------- الأحداث العامة ----------
  const ACTIONS = {
    logout: () => logout(false),
    'pick-truck': pickTruckModal,
    'use-truck': (el) => useTruck(el.dataset.id),
    'new-customer-exit': () => customerModal(null, (c) => {
      const sel = $('#x-customer');
      if (sel) {
        sel.insertAdjacentHTML('beforeend', opt(c.id, c.name));
        sel.value = c.id;
      }
    }),
    'confirm-dup': () => { closeModal(); submitExit(true); },
    'print-trip-obj': () => S.lastTrip && printVoucher(S.lastTrip),
    'new-exit': () => {
      closeModal();
      X.price = $('#x-price') ? $('#x-price').value : X.price;
      viewExit();
    },
    'print-trip': async (el) => printVoucher(await api('GET', `/api/trips/${el.dataset.id}`)),
    'edit-trip': (el) => editTrip(el.dataset.id),
    'cancel-trip': (el) => cancelTrip(el.dataset.id),
    'trip-history': (el) => showHistory('trip', el.dataset.id, 'سجل تغييرات العملية'),
    'new-customer': () => customerModal(null, () => render()),
    'edit-customer': async (el) => {
      const c = S.boot.customers.find((x) => x.id === Number(el.dataset.id));
      customerModal(c, () => render());
    },
    'pay-customer': (el) => paymentModal(el.dataset.id || ''),
    'cancel-payment': async (el) => {
      const reason = await askReason('إلغاء سداد', 'سبب الإلغاء');
      if (!reason) return;
      await api('POST', `/api/payments/${el.dataset.id}/cancel`, { reason });
      toast('تم إلغاء السداد');
      render();
    },
    'print-statement': () => printDoc(`كشف حساب: ${S.statement.customer.name}`, `${S.statement.from === '0000-01-01' ? 'من البداية' : S.statement.from} — ${S.statement.to === '9999-12-31' ? 'حتى الآن' : S.statement.to}`, statementBody(S.statement)),
    'pdf-statement': () => printDoc(`كشف حساب: ${S.statement.customer.name}`, '', statementBody(S.statement), true),
    'new-truck': () => truckModal(),
    'edit-truck': (el) => truckModal(S.trucksCache.find((t) => t.id === Number(el.dataset.id))),
    'truck-report': (el) => {
      Object.assign(repF, { plate: el.dataset.plate, customerId: '', materialId: '', from: monthStart(), to: today() });
      location.hash = 'reports';
    },
    range: (el) => setRange(el.dataset.r),
    'print-report': () => printDoc('تقرير المبيعات', `${S.report.from} — ${S.report.to}`, reportBody(S.report)),
    'pdf-report': () => printDoc('تقرير المبيعات', `${S.report.from} — ${S.report.to}`, reportBody(S.report), true),
    'excel-report': () => download('/api/reports/export.xlsx?' + qs(repF), `تقرير_${repF.from}_${repF.to}.xlsx`).catch((e) => toast(e.message)),
    'new-asset': () => assetModal(),
    'edit-asset': (el) => assetModal(S.assetsCache.find((a) => a.id === Number(el.dataset.id))),
    'print-assets': () => printDoc('سجل الأصول', today(), assetsTable(S.assetsCache, false)),
    'new-material': () => materialModal(),
    'edit-material': (el) => materialModal(S.boot.materials.find((m) => m.id === Number(el.dataset.id))),
    'new-user': () => userModal(),
    'edit-user': (el) => userModal(S.usersCache.find((u) => u.id === Number(el.dataset.id))),
    'reset-logo': async () => { await api('PUT', '/api/settings', { logo: '' }); await loadBoot(); render(); },
    'sample-voucher': () => printVoucher({
      no: 123, created_at: `${today()} 10:30:00`, plate: '1234 ABD', truck_type: 'سكس', driver: 'اسم السائق', customer_name: 'اسم العميل',
      material_name: (S.boot.materials[0] || {}).name || 'دفان', price: 350, paid: 350, remaining: 0, method: 'cash', notes: '', user_name: S.user.name, status: 'active',
    }),
    backup: () => download('/api/backup', `mara-backup-${today()}.db`).catch((e) => toast(e.message)),
  };

  document.addEventListener('click', async (e) => {
    const el = e.target.closest('[data-act]');
    if (!el || !ACTIONS[el.dataset.act]) return;
    e.preventDefault();
    try {
      await ACTIONS[el.dataset.act](el);
    } catch (err) {
      toast(err.message);
    }
  });

  const VIEWS = {
    exit: viewExit, today: viewToday, dashboard: viewDashboard, trips: viewTrips, customers: viewCustomers, customer: viewCustomer,
    payments: viewPayments, trucks: viewTrucks, reports: viewReports, audit: viewAudit, assets: viewAssets, settings: viewSettings,
  };

  async function start() {
    await loadBoot();
    renderShell();
    await render();
  }

  (async function init() {
    try { S.token = localStorage.getItem(TOKEN_KEY); } catch (_) { S.token = null; }
    try {
      if (S.token) {
        await start();
        return;
      }
      const st = await api('GET', '/api/status');
      renderLogin(st.needsSetup);
    } catch (err) {
      if (!S.user) {
        try {
          const st = await api('GET', '/api/status');
          renderLogin(st.needsSetup);
        } catch (e2) {
          $('#app').innerHTML = `<div class="login"><div class="box"><div class="error-box">${esc(e2.message)}</div></div></div>`;
        }
      }
    }
  })();
})();
