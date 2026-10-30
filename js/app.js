/* نظام تنظيم وحساب وتخزين بيانات مشروع بيع مواد الجبل (دفان - صبيز)
 * يعمل بالكامل داخل المتصفح بدون إنترنت، والبيانات محفوظة في المتصفح (localStorage)
 * مع إمكانية التصدير والاستيراد كنسخة احتياطية.
 */
(function () {
  'use strict';

  const STORAGE_KEY = 'mara-pos-db-v1';

  const UNITS = { trip: 'رد', m3: 'متر مكعب', ton: 'طن' };
  const PAY_TYPES = { cash: 'نقدي', credit: 'آجل', transfer: 'تحويل' };
  const ASSET_TYPES = ['شيول', 'حفار', 'قلاب', 'بلدوزر', 'كسارة', 'مولد كهرباء', 'سيارة', 'أرض / موقع', 'مبنى / مكتب', 'أخرى'];
  const ASSET_STATUS = { active: 'يعمل', maintenance: 'في الصيانة', idle: 'متوقف', sold: 'مباع' };
  const TRUCK_TYPES = ['سكس', 'تريلا', 'قلاب 10 ويل', 'قلاب 12 ويل', 'دينا', 'لوري'];
  const OWNERSHIP = { own: 'ملك المؤسسة', external: 'خارجي / مستأجر' };
  const EXPENSE_CATS = ['ديزل / وقود', 'رواتب وأجور', 'صيانة وقطع غيار', 'إيجار معدات', 'رسوم وتصاريح', 'أخرى'];

  // ---------- قاعدة البيانات ----------
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const todayStr = () => new Date().toISOString().slice(0, 10);

  function defaultDb() {
    return {
      settings: { name: 'شركة متعب', phone: '+966 54 646 1965', address: 'المدينة المنورة', currency: 'ريال', vat: 0, slipTitle: 'قسيمة ذات رد واحد فقط', logo: '' },
      seq: { sale: 0 },
      materials: [
        { id: uid(), name: 'دفان', unit: 'trip', price: 0 },
        { id: uid(), name: 'صبيز', unit: 'trip', price: 0 },
      ],
      customers: [],
      trucks: [],
      sales: [],
      payments: [],
      expenses: [],
      assets: [],
    };
  }

  function loadDb() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) return mergeDb(JSON.parse(raw));
    } catch (e) {
      console.error(e);
    }
    return defaultDb();
  }

  // دمج البيانات المحفوظة مع القيم الافتراضية (لإضافة الحقول الجديدة للنسخ القديمة)
  function mergeDb(data) {
    const d = defaultDb();
    return Object.assign(d, data, { settings: Object.assign(d.settings, data.settings) });
  }

  let db = loadDb();

  function save() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(db));
  }

  const byId = (list, id) => db[list].find((x) => x.id === id);
  const nameOf = (list, id, fallback = '-') => (byId(list, id) || {}).name || fallback;

  // ---------- أدوات مساعدة ----------
  const $ = (sel) => document.querySelector(sel);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = (v) => {
    const n = parseFloat(String(v ?? '').replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d)).replace(',', '.'));
    return isFinite(n) ? n : 0;
  };
  const round2 = (n) => Math.round(n * 100) / 100;
  // توحيد رقم اللوحة للمقارنة (إزالة المسافات وتحويل الأرقام العربية)
  const normPlate = (p) => String(p || '').replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d)).replace(/[\s\-_.|]/g, '').toUpperCase();
  const findTruckByPlate = (plate) => {
    const n = normPlate(plate);
    return n ? db.trucks.find((t) => normPlate(t.plate) === n) : null;
  };
  const fmt = (n) => num(n).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  const money = (n) => fmt(n) + ' ' + esc(db.settings.currency);
  const sum = (arr, f) => arr.reduce((a, x) => a + num(f(x)), 0);
  const tripCount = (sales) => sum(sales, (s) => (s.unit === 'trip' ? s.qty : 1));
  const inRange = (d, from, to) => (!from || d >= from) && (!to || d <= to);
  const monthStart = () => todayStr().slice(0, 8) + '01';

  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.remove('show'), 2200);
  }

  function options(list, selected, placeholder) {
    let html = placeholder !== undefined ? `<option value="">${esc(placeholder)}</option>` : '';
    for (const x of list) html += `<option value="${esc(x.id)}" ${x.id === selected ? 'selected' : ''}>${esc(x.name)}</option>`;
    return html;
  }
  function mapOptions(map, selected) {
    return Object.entries(map).map(([k, v]) => `<option value="${k}" ${k === selected ? 'selected' : ''}>${v}</option>`).join('');
  }

  // ---------- الحسابات ----------
  function customerBalance(customerId) {
    const sales = db.sales.filter((s) => s.customerId === customerId);
    const pays = db.payments.filter((p) => p.customerId === customerId);
    return round2(sum(sales, (s) => s.total - s.paid) - sum(pays, (p) => p.amount));
  }

  function summary(from, to) {
    const sales = db.sales.filter((s) => inRange(s.date, from, to));
    const payments = db.payments.filter((p) => inRange(p.date, from, to));
    const expenses = db.expenses.filter((e) => inRange(e.date, from, to));
    const salesTotal = sum(sales, (s) => s.total);
    const vatTotal = sum(sales, (s) => s.vat);
    const collected = sum(sales, (s) => s.paid) + sum(payments, (p) => p.amount);
    const expensesTotal = sum(expenses, (e) => e.amount);
    return {
      sales, payments, expenses,
      trips: tripCount(sales),
      salesTotal, vatTotal, collected, expensesTotal,
      profit: salesTotal - vatTotal - expensesTotal,
      cashNet: collected - expensesTotal,
    };
  }

  // ---------- النافذة المنبثقة (النماذج) ----------
  let modalHandler = null;
  function openModal(title, bodyHtml, onSave, afterRender) {
    $('#modalTitle').textContent = title;
    $('#modalBody').innerHTML = bodyHtml;
    modalHandler = onSave;
    $('#modal').showModal();
    if (afterRender) afterRender($('#modalBody'));
    const first = $('#modalBody').querySelector('input, select');
    if (first) first.focus();
  }
  $('#modalForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData($('#modalForm')).entries());
    if (modalHandler && modalHandler(data) !== false) {
      save();
      $('#modal').close();
      render();
    }
  });
  $('#modalCancel').addEventListener('click', () => $('#modal').close());

  const field = (label, inner, full) => `<div class="${full ? 'full' : ''}"><label>${label}</label>${inner}</div>`;

  function confirmDelete(list, id, msg) {
    if (!confirm(msg || 'هل أنت متأكد من الحذف؟')) return;
    db[list] = db[list].filter((x) => x.id !== id);
    save();
    render();
    toast('تم الحذف');
  }

  // ---------- المبيعات ----------
  function saleForm(sale) {
    const s = sale || { date: todayStr(), qty: 1, payType: 'cash', unit: 'trip' };
    const vatRate = sale ? num(sale.vatRate) : num(db.settings.vat);
    const body = `<div class="form-grid">
      ${field('التاريخ', `<input type="date" name="date" value="${esc(s.date)}" required>`)}
      ${field('العميل', `<select name="customerId">${options(db.customers, s.customerId, '— عميل نقدي —')}</select>`)}
      ${field('المادة', `<select name="materialId" id="f-mat" required>${options(db.materials, s.materialId, '— اختر —')}</select>`)}
      ${field('الوحدة', `<select name="unit" id="f-unit">${mapOptions(UNITS, s.unit)}</select>`)}
      ${field('الكمية', `<input name="qty" id="f-qty" inputmode="decimal" value="${esc(s.qty)}" required>`)}
      ${field('سعر الوحدة', `<input name="price" id="f-price" inputmode="decimal" value="${esc(s.price ?? '')}" required>`)}
      ${field('القلاب', `<select name="truckId" id="f-truck">${options(db.trucks, s.truckId, '— قلاب غير مسجل —')}</select>`)}
      ${field('رقم اللوحة', plateInputHtml(s.plate, 'f-plate'))}
      ${field('نوع القلاب', `<input name="truckType" id="f-ttype" list="truckTypes" value="${esc(s.truckType)}" placeholder="سكس، تريلا...">`)}
      ${field('اسم السائق', `<input name="driver" id="f-driver" value="${esc(s.driver)}">`)}
      ${field('موقع التوصيل', `<input name="site" value="${esc(s.site)}">`)}
      ${field('طريقة الدفع', `<select name="payType" id="f-pay">${mapOptions(PAY_TYPES, s.payType)}</select>`)}
      ${field('المبلغ المدفوع', `<input name="paid" id="f-paid" inputmode="decimal" value="${esc(s.paid ?? '')}">`)}
      ${field('ملاحظات', `<input name="notes" value="${esc(s.notes)}">`, true)}
      <div class="full calc-box" id="f-calc"></div>
    </div>`;

    openModal(sale ? 'تعديل رد / قسيمة' : 'رد جديد (قسيمة)', body, (d) => {
      if (!d.materialId) { alert('اختر المادة'); return false; }
      const subtotal = round2(num(d.qty) * num(d.price));
      const vat = round2(subtotal * vatRate / 100);
      const total = round2(subtotal + vat);
      let paid = d.payType === 'credit' ? num(d.paid) : (d.paid === '' ? total : num(d.paid));
      if (!d.customerId && paid < total) { alert('البيع الآجل أو الدفع الجزئي يحتاج اختيار عميل'); return false; }
      paid = Math.min(round2(paid), total);
      const rec = {
        date: d.date, customerId: d.customerId, materialId: d.materialId, unit: d.unit,
        qty: num(d.qty), price: num(d.price), subtotal, vatRate, vat, total, paid,
        truckId: d.truckId, plate: d.plate.trim(), truckType: d.truckType.trim(), driver: d.driver.trim(), site: d.site.trim(), payType: d.payType, notes: d.notes.trim(),
      };
      // ربط اللوحة بالقلاب: إن لم يُختر قلاب نبحث عنه باللوحة أو نسجله تلقائياً
      if (rec.plate && !rec.truckId) {
        let t = findTruckByPlate(rec.plate);
        if (!t) {
          t = { id: uid(), name: 'قلاب ' + rec.plate, plate: rec.plate, type: rec.truckType, driver: rec.driver, driverPhone: '', ownership: 'external' };
          db.trucks.push(t);
        }
        rec.truckId = t.id;
      }
      const tr = byId('trucks', rec.truckId);
      if (tr) {
        // نكمل بيانات القلاب الناقصة من القسيمة والعكس
        rec.plate = rec.plate || tr.plate || '';
        if (!tr.type && rec.truckType) tr.type = rec.truckType;
        if (!tr.driver && rec.driver) tr.driver = rec.driver;
      }
      if (sale) Object.assign(sale, rec);
      else {
        db.seq.sale = (db.seq.sale || 0) + 1;
        db.sales.push(Object.assign({ id: uid(), no: db.seq.sale }, rec));
      }
      toast('تم الحفظ');
    }, (root) => {
      const mat = root.querySelector('#f-mat'), unit = root.querySelector('#f-unit'), price = root.querySelector('#f-price');
      const qty = root.querySelector('#f-qty'), pay = root.querySelector('#f-pay'), paid = root.querySelector('#f-paid');
      const calc = () => {
        const sub = num(qty.value) * num(price.value);
        const total = round2(sub * (1 + vatRate / 100));
        const p = pay.value === 'credit' ? num(paid.value) : (paid.value === '' ? total : num(paid.value));
        root.querySelector('#f-calc').innerHTML =
          `الإجمالي: ${money(total)}${vatRate ? ` (شامل ضريبة ${vatRate}%)` : ''} — المتبقي على العميل: ${money(Math.max(0, total - p))}`;
      };
      mat.addEventListener('change', () => {
        const m = byId('materials', mat.value);
        if (m) { unit.value = m.unit; price.value = m.price || ''; }
        calc();
      });
      const truck = root.querySelector('#f-truck'), plate = root.querySelector('#f-plate');
      const ttype = root.querySelector('#f-ttype'), driver = root.querySelector('#f-driver');
      const fillTruck = (t) => {
        if (!t) return;
        truck.value = t.id;
        plate.value = t.plate || '';
        if (t.type) ttype.value = t.type;
        if (t.driver) driver.value = t.driver;
      };
      truck.addEventListener('change', () => fillTruck(byId('trucks', truck.value)));
      plate.addEventListener('change', () => fillTruck(findTruckByPlate(plate.value)));
      bindPlateCamera(root, plate, root.querySelector('#f-plate-status'), (found) => fillTruck(findTruckByPlate(found)));
      pay.addEventListener('change', () => { if (pay.value === 'credit') paid.value = '0'; else paid.value = ''; calc(); });
      [qty, price, paid].forEach((el) => el.addEventListener('input', calc));
      calc();
    });
  }

  function printHtml(html) {
    $('#printArea').innerHTML = html;
    const imgs = [...$('#printArea').querySelectorAll('img')].filter((i) => !i.complete);
    Promise.all(imgs.map((i) => new Promise((r) => { i.onload = i.onerror = r; }))).then(() => {
      document.body.classList.add('printing');
      window.print();
      document.body.classList.remove('printing');
    });
  }

  // ---------- تفقيط المبلغ (كتابته بالحروف) ----------
  const ONES = ['', 'واحد', 'اثنان', 'ثلاثة', 'أربعة', 'خمسة', 'ستة', 'سبعة', 'ثمانية', 'تسعة', 'عشرة',
    'أحد عشر', 'اثنا عشر', 'ثلاثة عشر', 'أربعة عشر', 'خمسة عشر', 'ستة عشر', 'سبعة عشر', 'ثمانية عشر', 'تسعة عشر'];
  const TENS = ['', '', 'عشرون', 'ثلاثون', 'أربعون', 'خمسون', 'ستون', 'سبعون', 'ثمانون', 'تسعون'];
  const HUNDREDS = ['', 'مائة', 'مائتان', 'ثلاثمائة', 'أربعمائة', 'خمسمائة', 'ستمائة', 'سبعمائة', 'ثمانمائة', 'تسعمائة'];

  function below1000(n) {
    const h = Math.floor(n / 100), r = n % 100;
    let rest = '';
    if (r < 20) rest = ONES[r];
    else rest = r % 10 ? `${ONES[r % 10]} و${TENS[Math.floor(r / 10)]}` : TENS[Math.floor(r / 10)];
    return [HUNDREDS[h], rest].filter(Boolean).join(' و');
  }

  // كلمة مع العدد حسب قواعد التمييز: [مفرد, مثنى, جمع 3-10, منصوب 11-99]
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
    const millions = Math.floor(n / 1e6), thousands = Math.floor((n % 1e6) / 1000), rest = n % 1000;
    if (millions) parts.push(counted(millions, ['مليون', 'مليونان', 'ملايين', 'مليوناً']));
    if (thousands) parts.push(counted(thousands, ['ألف', 'ألفان', 'آلاف', 'ألفاً']));
    if (rest) parts.push(below1000(rest));
    return parts.join(' و');
  }

  function amountInWords(amount) {
    const total = Math.round(num(amount) * 100);
    const whole = Math.floor(total / 100), frac = total % 100;
    const cur = db.settings.currency || 'ريال';
    const isRiyal = cur === 'ريال';
    let text;
    if (isRiyal && whole === 1) text = 'ريال واحد';
    else if (isRiyal && whole === 2) text = 'ريالان';
    else {
      const r = whole % 100;
      const curWord = !isRiyal ? cur : r >= 3 && r <= 10 && whole >= 3 ? 'ريالات' : r >= 11 ? 'ريالاً' : 'ريال';
      // قبل اسم العملة: مائتان => مائتا، ألفان => ألفا، ألفاً => ألف
      const words = numberToWords(whole).replace(/(مائتا|ألفا|مليونا)ن$/, '$1').replace(/(ألف|مليون)اً$/, '$1');
      text = `${words} ${curWord}`;
    }
    if (frac) text += ` و${numberToWords(frac)} ${isRiyal ? 'هللة' : ''}`.trimEnd();
    return `فقط ${text} لا غير`;
  }

  const logoSrc = () => db.settings.logo || 'img/logo.png';
  const slipDate = (d) => { const [y, m, day] = String(d).split('-'); return `${day} / ${m} / ${y}م`; };

  function slipHtml(sale, part, parts) {
    const st = db.settings;
    const t = byId('trucks', sale.truckId) || {};
    const single = parts > 1;
    const amount = single ? round2(sale.total / parts) : sale.total;
    const count = single ? '1' : `${fmt(sale.qty)}${sale.unit === 'trip' ? '' : ' ' + UNITS[sale.unit]}`;
    const truckType = [sale.truckType || t.type, sale.plate ? `<bdi dir="ltr">${esc(sale.plate)}</bdi>` : ''].filter(Boolean).join(' — لوحة: ');
    const row = (label, value) => `<div class="slip-row"><span class="slip-label">${label} :</span><span class="slip-val">${value || ''}</span></div>`;
    return `<div class="slip">
      <div class="slip-head">
        <div class="slip-co"><div class="slip-co-name">${esc(st.name)}</div><div class="slip-city">${esc(st.address)}</div>
          <div class="slip-phone">هاتف: <bdi dir="ltr">${esc(st.phone)}</bdi></div></div>
        <div class="slip-sep"></div>
        <img class="slip-logo" src="${esc(logoSrc())}" alt="">
      </div>
      <div class="slip-title">${esc(st.slipTitle)}</div>
      <div class="slip-no">رقم: ${sale.no}${single ? ` (${part} / ${parts})` : ''}</div>
      ${row('التاريخ', slipDate(sale.date))}
      ${row('المبلغ', `${money(amount)} <span class="slip-words">(${esc(amountInWords(amount))})</span>`)}
      ${row('عدد الردود', count)}
      ${row('نوع القلاب', truckType)}
      ${row('نوع الحمولة', esc(nameOf('materials', sale.materialId, '')))}
      ${row('الموقع', esc(sale.site))}
      ${row('توقيع السائق', '')}
      ${row('توقيع المهندس المسؤول', '')}
      <div class="slip-foot">
        <div><div class="slip-label">المستلم :</div>${row('الاسم', '')}${row('التوقيع', '')}</div>
        <div class="slip-label">الختم الرسمي</div>
        <div class="slip-label">مدير المشروع</div>
      </div>
    </div>`;
  }

  function printSlip(sale) {
    let parts = 1;
    if (sale.unit === 'trip' && sale.qty > 1 && Number.isInteger(sale.qty) &&
        confirm(`هذه القسيمة فيها ${sale.qty} ردود.\nموافق = طباعة قسيمة مستقلة لكل رد (${sale.qty} قسائم)\nإلغاء = قسيمة واحدة بعدد الردود`)) {
      parts = sale.qty;
    }
    const pages = [];
    for (let i = 1; i <= parts; i++) pages.push(slipHtml(sale, i, parts));
    printHtml(pages.join(''));
  }

  const salesFilter = { from: monthStart(), to: todayStr(), customerId: '', materialId: '', q: '' };

  function pageSales() {
    const f = salesFilter;
    const q = f.q.trim();
    const rows = db.sales
      .filter((s) => inRange(s.date, f.from, f.to))
      .filter((s) => !f.customerId || s.customerId === f.customerId)
      .filter((s) => !f.materialId || s.materialId === f.materialId)
      .filter((s) => !q || [s.no, s.site, s.notes, s.plate, nameOf('customers', s.customerId, ''), nameOf('trucks', s.truckId, '')].join(' ').includes(q))
      .sort((a, b) => (b.date + String(b.no).padStart(8, '0')).localeCompare(a.date + String(a.no).padStart(8, '0')));

    return `<h2>المبيعات (الردود)</h2>
      <div class="toolbar">
        <button class="btn primary" data-act="new-sale">+ رد جديد</button>
        <span class="spacer"></span>
        <input type="date" data-filter="from" value="${f.from}"> إلى
        <input type="date" data-filter="to" value="${f.to}">
        <select data-filter="customerId">${options(db.customers, f.customerId, 'كل العملاء')}</select>
        <select data-filter="materialId">${options(db.materials, f.materialId, 'كل المواد')}</select>
        <input placeholder="بحث..." data-filter="q" value="${esc(f.q)}">
        <button class="btn" data-act="export-sales">تصدير Excel</button>
      </div>
      <div class="card table-wrap"><table>
        <thead><tr><th>#</th><th>التاريخ</th><th>العميل</th><th>المادة</th><th>الكمية</th><th class="num">السعر</th><th class="num">الإجمالي</th><th class="num">المدفوع</th><th class="num">المتبقي</th><th>الدفع</th><th>القلاب</th><th>اللوحة</th><th>الموقع</th><th></th></tr></thead>
        <tbody>${rows.map((s) => `<tr>
          <td>${s.no}</td><td>${esc(s.date)}</td><td>${esc(nameOf('customers', s.customerId, 'نقدي'))}</td>
          <td>${esc(nameOf('materials', s.materialId))}</td><td>${fmt(s.qty)} ${UNITS[s.unit]}</td>
          <td class="num">${fmt(s.price)}</td><td class="num">${fmt(s.total)}</td><td class="num">${fmt(s.paid)}</td>
          <td class="num ${s.total - s.paid > 0 ? 'pos' : ''}">${fmt(s.total - s.paid)}</td>
          <td><span class="badge ${s.payType}">${PAY_TYPES[s.payType]}</span></td>
          <td>${esc(nameOf('trucks', s.truckId, ''))}</td><td><bdi dir="ltr">${esc(s.plate)}</bdi></td><td>${esc(s.site)}</td>
          <td><button class="btn sm" data-act="print-sale" data-id="${s.id}" title="طباعة القسيمة">🖨️ قسيمة</button>
              <button class="btn sm" data-act="edit-sale" data-id="${s.id}">تعديل</button>
              <button class="btn sm danger" data-act="del-sale" data-id="${s.id}">حذف</button></td>
        </tr>`).join('') || '<tr><td colspan="14" class="empty">لا توجد ردود في هذه الفترة</td></tr>'}</tbody>
        ${rows.length ? `<tfoot><tr><td colspan="4">المجموع (${rows.length} رد)</td><td>${fmt(sum(rows, (s) => s.qty))}</td><td></td>
          <td class="num">${fmt(sum(rows, (s) => s.total))}</td><td class="num">${fmt(sum(rows, (s) => s.paid))}</td>
          <td class="num">${fmt(sum(rows, (s) => s.total - s.paid))}</td><td colspan="5"></td></tr></tfoot>` : ''}
      </table></div>`;
  }

  // ---------- العملاء ----------
  function customerForm(c) {
    const x = c || {};
    openModal(c ? 'تعديل عميل' : 'عميل جديد', `<div class="form-grid">
      ${field('اسم العميل', `<input name="name" value="${esc(x.name)}" required>`)}
      ${field('الجوال', `<input name="phone" value="${esc(x.phone)}" inputmode="tel">`)}
      ${field('ملاحظات', `<input name="notes" value="${esc(x.notes)}">`, true)}
    </div>`, (d) => {
      const rec = { name: d.name.trim(), phone: d.phone.trim(), notes: d.notes.trim() };
      if (c) Object.assign(c, rec); else db.customers.push(Object.assign({ id: uid() }, rec));
      toast('تم الحفظ');
    });
  }

  let statementCustomer = null;

  function pageCustomers() {
    if (statementCustomer && byId('customers', statementCustomer)) return customerStatement(statementCustomer);
    const rows = db.customers.map((c) => ({ c, bal: customerBalance(c.id), trips: tripCount(db.sales.filter((s) => s.customerId === c.id)) }));
    const totalDue = sum(rows, (r) => Math.max(0, r.bal));
    return `<h2>العملاء والحسابات</h2>
      <div class="stats">
        <div class="stat"><div class="label">عدد العملاء</div><div class="value">${rows.length}</div></div>
        <div class="stat bad"><div class="label">إجمالي الديون على العملاء</div><div class="value">${money(totalDue)}</div></div>
      </div>
      <div class="toolbar"><button class="btn primary" data-act="new-customer">+ عميل جديد</button></div>
      <div class="card table-wrap"><table>
        <thead><tr><th>العميل</th><th>الجوال</th><th>عدد الردود</th><th class="num">الرصيد المستحق</th><th></th></tr></thead>
        <tbody>${rows.map(({ c, bal, trips }) => `<tr>
          <td>${esc(c.name)}</td><td>${esc(c.phone)}</td><td>${trips}</td>
          <td class="num ${bal > 0 ? 'pos' : 'neg'}">${money(bal)}</td>
          <td><button class="btn sm" data-act="statement" data-id="${c.id}">كشف حساب</button>
              <button class="btn sm" data-act="new-payment" data-id="${c.id}">سند قبض</button>
              <button class="btn sm" data-act="edit-customer" data-id="${c.id}">تعديل</button>
              <button class="btn sm danger" data-act="del-customer" data-id="${c.id}">حذف</button></td>
        </tr>`).join('') || '<tr><td colspan="5" class="empty">لا يوجد عملاء بعد</td></tr>'}</tbody>
      </table></div>`;
  }

  function statementEntries(customerId) {
    const entries = [];
    for (const s of db.sales.filter((x) => x.customerId === customerId)) {
      entries.push({ date: s.date, desc: `قسيمة ${s.no} — ${nameOf('materials', s.materialId)} ${fmt(s.qty)} ${UNITS[s.unit]}${s.site ? ' — ' + s.site : ''}`, debit: s.total, credit: 0 });
      if (s.paid) entries.push({ date: s.date, desc: `دفعة مع قسيمة ${s.no}`, debit: 0, credit: s.paid });
    }
    for (const p of db.payments.filter((x) => x.customerId === customerId)) {
      entries.push({ date: p.date, desc: `سند قبض${p.notes ? ' — ' + p.notes : ''}`, debit: 0, credit: p.amount });
    }
    entries.sort((a, b) => a.date.localeCompare(b.date));
    let bal = 0;
    for (const e of entries) { bal = round2(bal + e.debit - e.credit); e.balance = bal; }
    return entries;
  }

  function customerStatement(id) {
    const c = byId('customers', id);
    const entries = statementEntries(id);
    const bal = customerBalance(id);
    return `<h2>كشف حساب: ${esc(c.name)}</h2>
      <div class="toolbar">
        <button class="btn" data-act="back-customers">→ رجوع للعملاء</button>
        <button class="btn primary" data-act="new-payment" data-id="${c.id}">+ سند قبض</button>
        <button class="btn" data-act="print-statement" data-id="${c.id}">🖨️ طباعة الكشف</button>
      </div>
      <div class="stats">
        <div class="stat"><div class="label">إجمالي المسحوبات</div><div class="value">${money(sum(entries, (e) => e.debit))}</div></div>
        <div class="stat ok"><div class="label">إجمالي المدفوع</div><div class="value">${money(sum(entries, (e) => e.credit))}</div></div>
        <div class="stat ${bal > 0 ? 'bad' : 'ok'}"><div class="label">الرصيد المستحق</div><div class="value">${money(bal)}</div></div>
      </div>
      <div class="card table-wrap">${statementTable(entries)}</div>`;
  }

  function statementTable(entries) {
    return `<table>
      <thead><tr><th>التاريخ</th><th>البيان</th><th class="num">مدين (عليه)</th><th class="num">دائن (دفع)</th><th class="num">الرصيد</th></tr></thead>
      <tbody>${entries.map((e) => `<tr><td>${esc(e.date)}</td><td>${esc(e.desc)}</td>
        <td class="num">${e.debit ? fmt(e.debit) : ''}</td><td class="num">${e.credit ? fmt(e.credit) : ''}</td>
        <td class="num">${fmt(e.balance)}</td></tr>`).join('') || '<tr><td colspan="5" class="empty">لا توجد حركات</td></tr>'}</tbody>
    </table>`;
  }

  function printStatement(id) {
    const c = byId('customers', id);
    printHtml(`<div class="invoice">
      <div class="head"><div><h1>${esc(db.settings.name)}</h1><div>${esc(db.settings.phone)}</div></div>
      <div><strong>كشف حساب عميل</strong><div>${todayStr()}</div></div></div>
      <p>العميل: <strong>${esc(c.name)}</strong> ${esc(c.phone)}</p>
      ${statementTable(statementEntries(id))}
      <p><strong>الرصيد المستحق: ${money(customerBalance(id))}</strong></p></div>`);
  }

  // ---------- سندات القبض ----------
  function paymentForm(p, customerId) {
    const x = p || { date: todayStr(), customerId, method: 'cash' };
    const methods = { cash: 'نقدي', transfer: 'تحويل' };
    openModal(p ? 'تعديل سند قبض' : 'سند قبض جديد', `<div class="form-grid">
      ${field('التاريخ', `<input type="date" name="date" value="${esc(x.date)}" required>`)}
      ${field('العميل', `<select name="customerId" required>${options(db.customers, x.customerId, '— اختر —')}</select>`)}
      ${field('المبلغ', `<input name="amount" inputmode="decimal" value="${esc(x.amount ?? '')}" required>`)}
      ${field('الطريقة', `<select name="method">${mapOptions(methods, x.method)}</select>`)}
      ${field('ملاحظات', `<input name="notes" value="${esc(x.notes)}">`, true)}
      ${x.customerId ? `<div class="full calc-box">الرصيد الحالي للعميل: ${money(customerBalance(x.customerId))}</div>` : ''}
    </div>`, (d) => {
      if (!d.customerId) { alert('اختر العميل'); return false; }
      if (num(d.amount) <= 0) { alert('أدخل مبلغاً صحيحاً'); return false; }
      const rec = { date: d.date, customerId: d.customerId, amount: round2(num(d.amount)), method: d.method, notes: d.notes.trim() };
      if (p) Object.assign(p, rec); else db.payments.push(Object.assign({ id: uid() }, rec));
      toast('تم حفظ السند');
    });
  }

  function pagePayments() {
    const rows = [...db.payments].sort((a, b) => b.date.localeCompare(a.date));
    return `<h2>سندات القبض</h2>
      <div class="toolbar"><button class="btn primary" data-act="new-payment">+ سند قبض</button></div>
      <div class="card table-wrap"><table>
        <thead><tr><th>التاريخ</th><th>العميل</th><th class="num">المبلغ</th><th>الطريقة</th><th>ملاحظات</th><th></th></tr></thead>
        <tbody>${rows.map((p) => `<tr><td>${esc(p.date)}</td><td>${esc(nameOf('customers', p.customerId))}</td>
          <td class="num">${money(p.amount)}</td><td>${p.method === 'transfer' ? 'تحويل' : 'نقدي'}</td><td>${esc(p.notes)}</td>
          <td><button class="btn sm" data-act="edit-payment" data-id="${p.id}">تعديل</button>
              <button class="btn sm danger" data-act="del-payment" data-id="${p.id}">حذف</button></td></tr>`).join('')
          || '<tr><td colspan="6" class="empty">لا توجد سندات</td></tr>'}</tbody>
      </table></div>`;
  }

  // ---------- المصروفات ----------
  function expenseForm(e) {
    const x = e || { date: todayStr(), category: EXPENSE_CATS[0] };
    openModal(e ? 'تعديل مصروف' : 'مصروف جديد', `<div class="form-grid">
      ${field('التاريخ', `<input type="date" name="date" value="${esc(x.date)}" required>`)}
      ${field('البند', `<select name="category">${EXPENSE_CATS.map((c) => `<option ${c === x.category ? 'selected' : ''}>${c}</option>`).join('')}</select>`)}
      ${field('المبلغ', `<input name="amount" inputmode="decimal" value="${esc(x.amount ?? '')}" required>`)}
      ${field('الأصل / المعدة', `<select name="assetId">${options(db.assets, x.assetId, '— مصروف عام —')}</select>`)}
      ${field('البيان', `<input name="notes" value="${esc(x.notes)}">`, true)}
    </div>`, (d) => {
      if (num(d.amount) <= 0) { alert('أدخل مبلغاً صحيحاً'); return false; }
      const rec = { date: d.date, category: d.category, amount: round2(num(d.amount)), assetId: d.assetId, notes: d.notes.trim() };
      if (e) Object.assign(e, rec); else db.expenses.push(Object.assign({ id: uid() }, rec));
      toast('تم الحفظ');
    });
  }

  const expFilter = { from: monthStart(), to: todayStr() };

  function pageExpenses() {
    const rows = db.expenses.filter((e) => inRange(e.date, expFilter.from, expFilter.to)).sort((a, b) => b.date.localeCompare(a.date));
    return `<h2>المصروفات</h2>
      <div class="toolbar">
        <button class="btn primary" data-act="new-expense">+ مصروف جديد</button>
        <span class="spacer"></span>
        <input type="date" data-efilter="from" value="${expFilter.from}"> إلى
        <input type="date" data-efilter="to" value="${expFilter.to}">
      </div>
      <div class="card table-wrap"><table>
        <thead><tr><th>التاريخ</th><th>البند</th><th>الأصل</th><th>البيان</th><th class="num">المبلغ</th><th></th></tr></thead>
        <tbody>${rows.map((e) => `<tr><td>${esc(e.date)}</td><td>${esc(e.category)}</td><td>${esc(nameOf('assets', e.assetId, 'عام'))}</td>
          <td>${esc(e.notes)}</td><td class="num">${money(e.amount)}</td>
          <td><button class="btn sm" data-act="edit-expense" data-id="${e.id}">تعديل</button>
              <button class="btn sm danger" data-act="del-expense" data-id="${e.id}">حذف</button></td></tr>`).join('')
          || '<tr><td colspan="6" class="empty">لا توجد مصروفات في هذه الفترة</td></tr>'}</tbody>
        ${rows.length ? `<tfoot><tr><td colspan="4">المجموع</td><td class="num">${money(sum(rows, (e) => e.amount))}</td><td></td></tr></tfoot>` : ''}
      </table></div>`;
  }

  // ---------- المواد ----------
  function materialForm(m) {
    const x = m || { unit: 'trip' };
    openModal(m ? 'تعديل مادة' : 'مادة جديدة', `<div class="form-grid">
      ${field('اسم المادة', `<input name="name" value="${esc(x.name)}" required>`)}
      ${field('الوحدة الافتراضية', `<select name="unit">${mapOptions(UNITS, x.unit)}</select>`)}
      ${field('السعر الافتراضي للوحدة', `<input name="price" inputmode="decimal" value="${esc(x.price ?? '')}">`)}
    </div>`, (d) => {
      const rec = { name: d.name.trim(), unit: d.unit, price: num(d.price) };
      if (m) Object.assign(m, rec); else db.materials.push(Object.assign({ id: uid() }, rec));
      toast('تم الحفظ');
    });
  }

  function pageMaterials() {
    return `<h2>المواد والأسعار</h2>
      <div class="toolbar"><button class="btn primary" data-act="new-material">+ مادة جديدة</button></div>
      <div class="card table-wrap"><table>
        <thead><tr><th>المادة</th><th>الوحدة</th><th class="num">السعر الافتراضي</th><th>عدد الردود</th><th class="num">إجمالي المبيعات</th><th></th></tr></thead>
        <tbody>${db.materials.map((m) => {
          const s = db.sales.filter((x) => x.materialId === m.id);
          return `<tr><td>${esc(m.name)}</td><td>${UNITS[m.unit]}</td><td class="num">${money(m.price)}</td>
            <td>${fmt(tripCount(s))}</td><td class="num">${money(sum(s, (x) => x.total))}</td>
            <td><button class="btn sm" data-act="edit-material" data-id="${m.id}">تعديل</button>
                <button class="btn sm danger" data-act="del-material" data-id="${m.id}">حذف</button></td></tr>`;
        }).join('') || '<tr><td colspan="6" class="empty">لا توجد مواد</td></tr>'}</tbody>
      </table></div>`;
  }

  // ---------- قراءة رقم اللوحة من الصورة ----------
  // يستخدم مكتبة Tesseract.js (تُحمّل عند أول استخدام وتحتاج إنترنت لأول مرة فقط)
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

  // تكبير الصورة وتحويلها لأبيض وأسود لتحسين دقة القراءة
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
          const g = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
          const v = g > 130 ? 255 : 0;
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

  // استخراج اللوحة من النص: أرقام (1-4) + حروف لاتينية (1-3) كما في اللوحات السعودية
  function parsePlate(text) {
    const t = String(text).replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d)).toUpperCase().replace(/[^0-9A-Z\n ]/g, ' ')
      .replace(/\bKSA\b/g, ' ')                 // شعار المملكة الموجود على اللوحة
      .replace(/\b([A-Z]) +(?=[A-Z]\b)/g, '$1'); // دمج الحروف المتباعدة: B J D => BJD
    let m = t.match(/(\d{1,4})\s*([A-Z]{1,3})\b/) || t.match(/\b([A-Z]{1,3})\s*(\d{1,4})/);
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

  function bindPlateCamera(root, plateInput, statusEl, onFound) {
    root.querySelector('input[type=file][data-plate-img]').addEventListener('change', async (ev) => {
      const file = ev.target.files[0];
      if (!file) return;
      try {
        const found = await readPlateFromImage(file, (m) => { statusEl.textContent = m; });
        if (found) {
          plateInput.value = found;
          statusEl.textContent = 'تم استخراج اللوحة — تأكد منها قبل الحفظ';
          if (onFound) onFound(found);
        } else statusEl.textContent = 'لم يتم التعرف على اللوحة، اكتبها يدوياً';
      } catch (err) {
        console.error(err);
        statusEl.textContent = 'تعذر قراءة الصورة (تحتاج اتصال إنترنت لأول مرة). اكتب اللوحة يدوياً';
      }
      ev.target.value = '';
    });
  }

  const plateInputHtml = (value, id) => `<div class="plate-row"><input name="plate" id="${id}" value="${esc(value)}" placeholder="مثال: 1234 ABD">
    <label class="btn sm cam-btn" title="استخراج اللوحة من صورة">📷<input type="file" data-plate-img accept="image/*" capture="environment" hidden></label></div>
    <div class="hint" id="${id}-status"></div>`;

  // ---------- القلابات ----------
  function truckForm(t) {
    const x = t || { ownership: 'external' };
    openModal(t ? 'تعديل قلاب' : 'قلاب جديد', `<div class="form-grid">
      ${field('رقم اللوحة', plateInputHtml(x.plate, 't-plate'))}
      ${field('نوع القلاب', `<input name="type" list="truckTypes" value="${esc(x.type)}" placeholder="سكس، تريلا...">`)}
      ${field('اسم / وصف القلاب', `<input name="name" value="${esc(x.name)}" placeholder="مثال: مرسيدس أبيض">`)}
      ${field('اسم السائق', `<input name="driver" value="${esc(x.driver)}">`)}
      ${field('جوال السائق', `<input name="driverPhone" value="${esc(x.driverPhone)}" inputmode="tel">`)}
      ${field('الملكية', `<select name="ownership">${mapOptions(OWNERSHIP, x.ownership)}</select>`)}
      ${field('الحمولة (م³)', `<input name="capacity" inputmode="decimal" value="${esc(x.capacity ?? '')}">`)}
    </div>`, (d) => {
      if (!d.plate.trim() && !d.name.trim()) { alert('أدخل رقم اللوحة أو اسم القلاب'); return false; }
      const dup = findTruckByPlate(d.plate);
      if (dup && dup !== t) { alert('هذه اللوحة مسجلة مسبقاً باسم: ' + dup.name); return false; }
      const rec = {
        name: d.name.trim() || 'قلاب ' + d.plate.trim(), plate: d.plate.trim(), driver: d.driver.trim(),
        driverPhone: d.driverPhone.trim(), ownership: d.ownership, capacity: num(d.capacity), type: d.type.trim(),
      };
      if (t) Object.assign(t, rec); else db.trucks.push(Object.assign({ id: uid() }, rec));
      toast('تم الحفظ');
    }, (root) => bindPlateCamera(root, root.querySelector('#t-plate'), root.querySelector('#t-plate-status')));
  }

  const truckFilter = { from: monthStart(), to: todayStr() };
  let statementTruck = null;

  function truckTrips(id) {
    return db.sales.filter((s) => s.truckId === id && inRange(s.date, truckFilter.from, truckFilter.to))
      .sort((a, b) => a.date.localeCompare(b.date) || a.no - b.no);
  }

  const rangeInputs = (attr, f) => `من <input type="date" ${attr}="from" value="${f.from}"> إلى <input type="date" ${attr}="to" value="${f.to}">`;

  function pageTrucks() {
    if (statementTruck && byId('trucks', statementTruck)) return truckStatement(statementTruck);
    return `<h2>القلابات</h2>
      <div class="toolbar">
        <button class="btn primary" data-act="new-truck">+ قلاب جديد</button>
        <button class="btn" data-act="print-trucks">🖨️ طباعة كشف جميع القلابات</button>
        <span class="spacer"></span>${rangeInputs('data-tfilter', truckFilter)}
      </div>
      <div class="card table-wrap"><table>
        <thead><tr><th>اللوحة</th><th>النوع</th><th>القلاب</th><th>السائق</th><th>الجوال</th><th>الملكية</th><th>عدد الردود</th><th>الكمية</th><th class="num">قيمة الردود</th><th></th></tr></thead>
        <tbody>${db.trucks.map((t) => {
          const s = truckTrips(t.id);
          return `<tr><td><strong><bdi dir="ltr">${esc(t.plate)}</bdi></strong></td><td>${esc(t.type)}</td><td>${esc(t.name)}</td><td>${esc(t.driver)}</td><td>${esc(t.driverPhone)}</td>
            <td>${OWNERSHIP[t.ownership] || ''}</td><td>${fmt(tripCount(s))}</td><td>${fmt(sum(s, (x) => x.qty))}</td><td class="num">${money(sum(s, (x) => x.total))}</td>
            <td><button class="btn sm" data-act="truck-statement" data-id="${t.id}">كشف</button>
                <button class="btn sm" data-act="edit-truck" data-id="${t.id}">تعديل</button>
                <button class="btn sm danger" data-act="del-truck" data-id="${t.id}">حذف</button></td></tr>`;
        }).join('') || '<tr><td colspan="10" class="empty">لا توجد قلابات. تُسجَّل تلقائياً عند كتابة اللوحة في الرد</td></tr>'}</tbody>
      </table></div>`;
  }

  function truckTripsTable(trips) {
    return `<table>
      <thead><tr><th>#</th><th>التاريخ</th><th>العميل</th><th>المادة</th><th>الكمية</th><th>الموقع</th><th class="num">القيمة</th></tr></thead>
      <tbody>${trips.map((s) => `<tr><td>${s.no}</td><td>${esc(s.date)}</td><td>${esc(nameOf('customers', s.customerId, 'نقدي'))}</td>
        <td>${esc(nameOf('materials', s.materialId))}</td><td>${fmt(s.qty)} ${UNITS[s.unit]}</td><td>${esc(s.site)}</td>
        <td class="num">${fmt(s.total)}</td></tr>`).join('') || '<tr><td colspan="7" class="empty">لا توجد ردود في هذه الفترة</td></tr>'}</tbody>
      ${trips.length ? `<tfoot><tr><td colspan="4">المجموع: ${fmt(tripCount(trips))} رد</td><td>${fmt(sum(trips, (s) => s.qty))}</td><td></td>
        <td class="num">${fmt(sum(trips, (s) => s.total))}</td></tr></tfoot>` : ''}
    </table>`;
  }

  function truckStatement(id) {
    const t = byId('trucks', id);
    const trips = truckTrips(id);
    return `<h2>كشف قلاب: <bdi dir="ltr">${esc(t.plate)}</bdi> — ${esc(t.name)}</h2>
      <div class="toolbar">
        <button class="btn" data-act="back-trucks">→ رجوع للقلابات</button>
        <button class="btn primary" data-act="print-truck" data-id="${id}">🖨️ طباعة الكشف</button>
        <span class="spacer"></span>${rangeInputs('data-tfilter', truckFilter)}
      </div>
      <div class="stats">
        <div class="stat"><div class="label">السائق</div><div class="value">${esc(t.driver || '-')}</div></div>
        <div class="stat"><div class="label">عدد الردود</div><div class="value">${fmt(tripCount(trips))}</div></div>
        <div class="stat"><div class="label">قيمة الردود</div><div class="value">${money(sum(trips, (s) => s.total))}</div></div>
      </div>
      <div class="card table-wrap">${truckTripsTable(trips)}</div>`;
  }

  function printTrucks(ids) {
    const pages = ids.map((id) => {
      const t = byId('trucks', id);
      return `<div class="invoice page-break">
        <div class="head"><div><h1>${esc(db.settings.name)}</h1><div>${esc(db.settings.phone)}</div></div>
        <div><strong>كشف ردود قلاب</strong><div>من ${truckFilter.from} إلى ${truckFilter.to}</div></div></div>
        <p>رقم اللوحة: <strong class="plate-box"><bdi dir="ltr">${esc(t.plate)}</bdi></strong> &nbsp; القلاب: ${esc(t.name)} &nbsp; السائق: ${esc(t.driver || '-')} ${esc(t.driverPhone)}</p>
        ${truckTripsTable(truckTrips(id))}
        <div class="sign"><span>توقيع السائق: ............</span><span>توقيع المؤسسة: ............</span></div></div>`;
    });
    printHtml(pages.join(''));
  }

  // ---------- الأصول ----------
  function assetDepreciation(a, at) {
    const cost = num(a.cost), salvage = num(a.salvage), life = num(a.lifeYears);
    if (!a.purchaseDate || !life || cost <= salvage) return { yearly: 0, accumulated: 0, book: cost };
    const years = Math.max(0, (new Date(at || todayStr()) - new Date(a.purchaseDate)) / (365.25 * 864e5));
    const yearly = (cost - salvage) / life;
    const accumulated = Math.min(cost - salvage, yearly * years);
    return { yearly: round2(yearly), accumulated: round2(accumulated), book: round2(cost - accumulated) };
  }

  function assetForm(a) {
    const x = a || { type: ASSET_TYPES[0], status: 'active', purchaseDate: todayStr(), lifeYears: 5 };
    openModal(a ? 'تعديل أصل' : 'تسجيل أصل جديد', `<div class="form-grid">
      ${field('اسم الأصل', `<input name="name" value="${esc(x.name)}" placeholder="مثال: شيول كاتربيلر 950" required>`)}
      ${field('النوع', `<select name="type">${ASSET_TYPES.map((c) => `<option ${c === x.type ? 'selected' : ''}>${c}</option>`).join('')}</select>`)}
      ${field('رقم اللوحة / الرقم التسلسلي', plateInputHtml(x.plate, 'a-plate'))}
      ${field('الموديل / سنة الصنع', `<input name="model" value="${esc(x.model)}">`)}
      ${field('تاريخ الشراء / التملك', `<input type="date" name="purchaseDate" value="${esc(x.purchaseDate)}">`)}
      ${field('قيمة الشراء', `<input name="cost" inputmode="decimal" value="${esc(x.cost ?? '')}" required>`)}
      ${field('العمر الإنتاجي (سنوات)', `<input name="lifeYears" inputmode="decimal" value="${esc(x.lifeYears ?? '')}">`)}
      ${field('القيمة المتبقية (الخردة)', `<input name="salvage" inputmode="decimal" value="${esc(x.salvage ?? '')}">`)}
      ${field('الحالة', `<select name="status">${mapOptions(ASSET_STATUS, x.status)}</select>`)}
      ${field('الموقع / المسؤول', `<input name="location" value="${esc(x.location)}">`)}
      ${field('ملاحظات (التأمين، الاستمارة...)', `<input name="notes" value="${esc(x.notes)}">`, true)}
    </div>`, (d) => {
      const rec = {
        name: d.name.trim(), type: d.type, plate: d.plate.trim(), model: d.model.trim(), purchaseDate: d.purchaseDate,
        cost: num(d.cost), lifeYears: num(d.lifeYears), salvage: num(d.salvage), status: d.status,
        location: d.location.trim(), notes: d.notes.trim(),
      };
      if (a) Object.assign(a, rec); else db.assets.push(Object.assign({ id: uid() }, rec));
      toast('تم حفظ الأصل');
    }, (root) => bindPlateCamera(root, root.querySelector('#a-plate'), root.querySelector('#a-plate-status')));
  }

  function assetsTable(withActions) {
    const rows = db.assets.map((a) => ({ a, dep: assetDepreciation(a), exp: sum(db.expenses.filter((e) => e.assetId === a.id), (e) => e.amount) }));
    return `<table>
      <thead><tr><th>الأصل</th><th>النوع</th><th>اللوحة / التسلسلي</th><th>تاريخ الشراء</th><th class="num">قيمة الشراء</th>
        <th class="num">الإهلاك السنوي</th><th class="num">مجمع الإهلاك</th><th class="num">القيمة الدفترية</th><th class="num">مصاريف الصيانة</th><th>الحالة</th>${withActions ? '<th></th>' : ''}</tr></thead>
      <tbody>${rows.map(({ a, dep, exp }) => `<tr><td>${esc(a.name)}${a.model ? ' <small>(' + esc(a.model) + ')</small>' : ''}</td><td>${esc(a.type)}</td>
        <td><bdi dir="ltr">${esc(a.plate)}</bdi></td><td>${esc(a.purchaseDate)}</td><td class="num">${fmt(a.cost)}</td><td class="num">${fmt(dep.yearly)}</td>
        <td class="num">${fmt(dep.accumulated)}</td><td class="num"><strong>${fmt(dep.book)}</strong></td><td class="num">${fmt(exp)}</td>
        <td>${ASSET_STATUS[a.status] || ''}</td>
        ${withActions ? `<td><button class="btn sm" data-act="edit-asset" data-id="${a.id}">تعديل</button>
          <button class="btn sm danger" data-act="del-asset" data-id="${a.id}">حذف</button></td>` : ''}</tr>`).join('')
        || `<tr><td colspan="${withActions ? 11 : 10}" class="empty">لم يتم تسجيل أصول بعد</td></tr>`}</tbody>
      ${rows.length ? `<tfoot><tr><td colspan="4">الإجمالي (${rows.length} أصل)</td><td class="num">${fmt(sum(rows, (r) => r.a.cost))}</td>
        <td class="num">${fmt(sum(rows, (r) => r.dep.yearly))}</td><td class="num">${fmt(sum(rows, (r) => r.dep.accumulated))}</td>
        <td class="num">${fmt(sum(rows, (r) => r.dep.book))}</td><td class="num">${fmt(sum(rows, (r) => r.exp))}</td><td colspan="${withActions ? 2 : 1}"></td></tr></tfoot>` : ''}
    </table>`;
  }

  function pageAssets() {
    const active = db.assets.filter((a) => a.status !== 'sold');
    return `<h2>الأصول والمعدات</h2>
      <div class="stats">
        <div class="stat"><div class="label">عدد الأصول</div><div class="value">${active.length}</div></div>
        <div class="stat"><div class="label">إجمالي قيمة الشراء</div><div class="value">${money(sum(active, (a) => a.cost))}</div></div>
        <div class="stat ok"><div class="label">القيمة الدفترية الحالية</div><div class="value">${money(sum(active, (a) => assetDepreciation(a).book))}</div></div>
      </div>
      <div class="toolbar">
        <button class="btn primary" data-act="new-asset">+ تسجيل أصل</button>
        <button class="btn" data-act="print-assets">🖨️ طباعة سجل الأصول</button>
      </div>
      <div class="card table-wrap">${assetsTable(true)}</div>
      <p class="hint">الإهلاك محسوب بطريقة القسط الثابت: (قيمة الشراء − القيمة المتبقية) ÷ العمر الإنتاجي. مصاريف الصيانة تُربط بالأصل من صفحة المصروفات.</p>`;
  }

  // ---------- الرئيسية ----------
  function pageDashboard() {
    const t = summary(todayStr(), todayStr());
    const m = summary(monthStart(), todayStr());
    const debts = sum(db.customers, (c) => Math.max(0, customerBalance(c.id)));
    const recent = [...db.sales].sort((a, b) => b.no - a.no).slice(0, 8);
    const statBlock = (s) => `<div class="stats">
      <div class="stat"><div class="label">عدد الردود</div><div class="value">${s.trips}</div></div>
      <div class="stat"><div class="label">المبيعات</div><div class="value">${money(s.salesTotal)}</div></div>
      <div class="stat ok"><div class="label">المحصّل (نقدي + سندات)</div><div class="value">${money(s.collected)}</div></div>
      <div class="stat warn"><div class="label">المصروفات</div><div class="value">${money(s.expensesTotal)}</div></div>
      <div class="stat ${s.profit >= 0 ? 'ok' : 'bad'}"><div class="label">صافي الربح</div><div class="value">${money(s.profit)}</div></div>
    </div>`;
    return `<h2>الرئيسية</h2>
      <div class="toolbar">
        <button class="btn primary" data-act="new-sale">+ رد جديد</button>
        <button class="btn" data-act="new-payment">+ سند قبض</button>
        <button class="btn" data-act="new-expense">+ مصروف</button>
      </div>
      <h3>اليوم</h3>${statBlock(t)}
      <h3>هذا الشهر</h3>${statBlock(m)}
      <div class="stats"><div class="stat bad"><div class="label">إجمالي الديون المستحقة على العملاء</div><div class="value">${money(debts)}</div></div></div>
      <h3>آخر الردود</h3>
      <div class="card table-wrap"><table>
        <thead><tr><th>#</th><th>التاريخ</th><th>العميل</th><th>المادة</th><th>الكمية</th><th class="num">الإجمالي</th><th>الدفع</th></tr></thead>
        <tbody>${recent.map((s) => `<tr><td>${s.no}</td><td>${esc(s.date)}</td><td>${esc(nameOf('customers', s.customerId, 'نقدي'))}</td>
          <td>${esc(nameOf('materials', s.materialId))}</td><td>${fmt(s.qty)} ${UNITS[s.unit]}</td><td class="num">${money(s.total)}</td>
          <td><span class="badge ${s.payType}">${PAY_TYPES[s.payType]}</span></td></tr>`).join('')
          || '<tr><td colspan="7" class="empty">ابدأ بإضافة المواد والعملاء ثم سجّل أول رد</td></tr>'}</tbody>
      </table></div>`;
  }

  // ---------- التقارير ----------
  const repFilter = { from: monthStart(), to: todayStr() };

  function groupTable(title, items, keyFn, labelFn, valueFns) {
    const groups = {};
    for (const it of items) {
      const k = keyFn(it) || '';
      (groups[k] = groups[k] || []).push(it);
    }
    const rows = Object.entries(groups).map(([k, list]) => ({ label: labelFn(k), list }));
    return `<div class="card"><h3>${title}</h3><div class="table-wrap"><table>
      <thead><tr><th>البند</th>${valueFns.map((v) => `<th class="num">${v[0]}</th>`).join('')}</tr></thead>
      <tbody>${rows.map((r) => `<tr><td>${esc(r.label)}</td>${valueFns.map((v) => `<td class="num">${fmt(v[1](r.list))}</td>`).join('')}</tr>`).join('')
        || `<tr><td colspan="${valueFns.length + 1}" class="empty">لا توجد بيانات</td></tr>`}</tbody>
    </table></div></div>`;
  }

  function pageReports() {
    const s = summary(repFilter.from, repFilter.to);
    const salesCols = [['الردود', tripCount], ['الكمية', (l) => sum(l, (x) => x.qty)], ['المبيعات', (l) => sum(l, (x) => x.total)], ['المتبقي', (l) => sum(l, (x) => x.total - x.paid)]];
    return `<h2>التقارير</h2>
      <div class="toolbar">
        من <input type="date" data-rfilter="from" value="${repFilter.from}">
        إلى <input type="date" data-rfilter="to" value="${repFilter.to}">
        <button class="btn sm" data-act="range" data-range="today">اليوم</button>
        <button class="btn sm" data-act="range" data-range="month">هذا الشهر</button>
        <button class="btn sm" data-act="range" data-range="year">هذه السنة</button>
        <span class="spacer"></span>
        <button class="btn" data-act="print-report">🖨️ طباعة</button>
      </div>
      <div id="reportBody">
      <div class="stats">
        <div class="stat"><div class="label">عدد الردود</div><div class="value">${s.trips}</div></div>
        <div class="stat"><div class="label">إجمالي المبيعات</div><div class="value">${money(s.salesTotal)}</div></div>
        ${s.vatTotal ? `<div class="stat"><div class="label">منها ضريبة</div><div class="value">${money(s.vatTotal)}</div></div>` : ''}
        <div class="stat ok"><div class="label">المحصّل</div><div class="value">${money(s.collected)}</div></div>
        <div class="stat warn"><div class="label">المصروفات</div><div class="value">${money(s.expensesTotal)}</div></div>
        <div class="stat ${s.profit >= 0 ? 'ok' : 'bad'}"><div class="label">صافي الربح</div><div class="value">${money(s.profit)}</div></div>
        <div class="stat ${s.cashNet >= 0 ? 'ok' : 'bad'}"><div class="label">صافي النقد (محصّل − مصروف)</div><div class="value">${money(s.cashNet)}</div></div>
      </div>
      <div class="two-col">
        ${groupTable('المبيعات حسب المادة', s.sales, (x) => x.materialId, (k) => nameOf('materials', k), salesCols)}
        ${groupTable('الردود حسب القلاب', s.sales, (x) => x.truckId, (k) => { const t = byId('trucks', k); return t ? `${t.plate} — ${t.name}` : 'بدون قلاب'; }, salesCols)}
        ${groupTable('المبيعات حسب العميل', s.sales, (x) => x.customerId, (k) => nameOf('customers', k, 'عملاء نقديون'), salesCols)}
        ${groupTable('المصروفات حسب البند', s.expenses, (x) => x.category, (k) => k, [['العدد', (l) => l.length], ['المبلغ', (l) => sum(l, (x) => x.amount)]])}
        ${groupTable('المبيعات اليومية', s.sales, (x) => x.date, (k) => k, salesCols)}
      </div></div>`;
  }

  // ---------- الإعدادات ----------
  function pageSettings() {
    const st = db.settings;
    return `<h2>الإعدادات والنسخ الاحتياطي</h2>
      <div class="card"><form id="settingsForm" class="form-grid">
        ${field('اسم الشركة', `<input name="name" value="${esc(st.name)}">`)}
        ${field('الهاتف', `<input name="phone" value="${esc(st.phone)}" dir="ltr">`)}
        ${field('المدينة / العنوان', `<input name="address" value="${esc(st.address)}">`)}
        ${field('عنوان القسيمة', `<input name="slipTitle" value="${esc(st.slipTitle)}">`)}
        ${field('العملة', `<input name="currency" value="${esc(st.currency)}">`)}
        ${field('نسبة الضريبة % (0 = بدون ضريبة)', `<input name="vat" inputmode="decimal" value="${esc(st.vat)}">`)}
        <div class="full"><label>الشعار</label><div class="toolbar">
          <img src="${esc(logoSrc())}" alt="" class="logo-preview">
          <label class="btn" style="margin:0;color:inherit">تغيير الشعار<input type="file" id="logoFile" accept="image/*" hidden></label>
          ${st.logo ? '<button type="button" class="btn danger" data-act="reset-logo">الشعار الافتراضي</button>' : ''}
        </div></div>
        <div class="full"><button class="btn primary" type="submit">حفظ الإعدادات</button>
          <button type="button" class="btn" data-act="sample-slip">🖨️ معاينة قسيمة فارغة</button></div>
      </form></div>
      <div class="card">
        <h3>النسخ الاحتياطي</h3>
        <p>البيانات محفوظة في هذا المتصفح على هذا الجهاز. ننصح بأخذ نسخة احتياطية بشكل دوري وحفظها في مكان آمن.</p>
        <div class="toolbar">
          <button class="btn primary" data-act="backup">⬇️ تنزيل نسخة احتياطية</button>
          <label class="btn" style="margin:0;color:inherit">⬆️ استعادة نسخة احتياطية
            <input type="file" id="restoreFile" accept=".json,application/json" hidden></label>
          <span class="spacer"></span>
          <button class="btn danger" data-act="reset">مسح جميع البيانات</button>
        </div>
      </div>`;
  }

  // ---------- التصدير ----------
  function download(filename, content, type) {
    const blob = new Blob([content], { type });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  function exportSalesCsv() {
    const head = ['رقم', 'التاريخ', 'العميل', 'المادة', 'الوحدة', 'الكمية', 'السعر', 'الضريبة', 'الإجمالي', 'المدفوع', 'المتبقي', 'الدفع', 'القلاب', 'اللوحة', 'الموقع', 'ملاحظات'];
    const f = salesFilter;
    const rows = db.sales.filter((s) => inRange(s.date, f.from, f.to)).map((s) => [
      s.no, s.date, nameOf('customers', s.customerId, 'نقدي'), nameOf('materials', s.materialId), UNITS[s.unit], s.qty, s.price,
      s.vat, s.total, s.paid, round2(s.total - s.paid), PAY_TYPES[s.payType], nameOf('trucks', s.truckId, ''), s.plate, s.site, s.notes,
    ]);
    const csv = [head, ...rows].map((r) => r.map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
    download(`مبيعات_${f.from}_${f.to}.csv`, '﻿' + csv, 'text/csv;charset=utf-8');
  }

  // ---------- التوجيه والأحداث ----------
  const PAGES = {
    dashboard: pageDashboard, sales: pageSales, customers: pageCustomers, payments: pagePayments,
    expenses: pageExpenses, materials: pageMaterials, trucks: pageTrucks, assets: pageAssets, reports: pageReports, settings: pageSettings,
  };

  function currentPage() {
    const p = location.hash.slice(1);
    return PAGES[p] ? p : 'dashboard';
  }

  function render() {
    const page = currentPage();
    $('#app').innerHTML = PAGES[page]();
    document.querySelectorAll('.sidebar a').forEach((a) => a.classList.toggle('active', a.dataset.page === page));
    $('#bizName').textContent = db.settings.name || 'نظام مبيعات مواد الجبل';
    const types = new Set([...TRUCK_TYPES, ...db.trucks.map((t) => t.type).filter(Boolean)]);
    $('#truckTypes').innerHTML = [...types].map((t) => `<option value="${esc(t)}">`).join('');
    $('#today').textContent = new Date().toLocaleDateString('ar-SA-u-ca-gregory', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  }

  window.addEventListener('hashchange', () => {
    if (currentPage() !== 'customers') statementCustomer = null;
    if (currentPage() !== 'trucks') statementTruck = null;
    $('#sidebar').classList.remove('open');
    if ($('#modal').open) $('#modal').close();
    render();
  });
  $('#menuBtn').addEventListener('click', () => $('#sidebar').classList.toggle('open'));

  const actions = {
    'new-sale': () => {
      if (!db.materials.length) { alert('أضف مادة أولاً من صفحة المواد'); return; }
      saleForm();
    },
    'edit-sale': (id) => saleForm(byId('sales', id)),
    'del-sale': (id) => confirmDelete('sales', id, 'حذف هذا الرد / القسيمة؟'),
    'print-sale': (id) => printSlip(byId('sales', id)),
    'export-sales': exportSalesCsv,
    'new-customer': () => customerForm(),
    'edit-customer': (id) => customerForm(byId('customers', id)),
    'del-customer': (id) => {
      if (db.sales.some((s) => s.customerId === id) || db.payments.some((p) => p.customerId === id)) {
        alert('لا يمكن حذف عميل لديه حركات. احذف حركاته أولاً.');
        return;
      }
      confirmDelete('customers', id);
    },
    statement: (id) => { statementCustomer = id; render(); },
    'back-customers': () => { statementCustomer = null; render(); },
    'print-statement': (id) => printStatement(id),
    'new-payment': (id) => {
      if (!db.customers.length) { alert('أضف عميلاً أولاً'); return; }
      paymentForm(null, id);
    },
    'edit-payment': (id) => paymentForm(byId('payments', id)),
    'del-payment': (id) => confirmDelete('payments', id, 'حذف سند القبض؟'),
    'new-expense': () => expenseForm(),
    'edit-expense': (id) => expenseForm(byId('expenses', id)),
    'del-expense': (id) => confirmDelete('expenses', id),
    'new-material': () => materialForm(),
    'edit-material': (id) => materialForm(byId('materials', id)),
    'del-material': (id) => {
      if (db.sales.some((s) => s.materialId === id)) { alert('لا يمكن حذف مادة مستخدمة في قسائم.'); return; }
      confirmDelete('materials', id);
    },
    'new-truck': () => truckForm(),
    'truck-statement': (id) => { statementTruck = id; render(); },
    'back-trucks': () => { statementTruck = null; render(); },
    'print-truck': (id) => printTrucks([id]),
    'print-trucks': () => {
      const ids = db.trucks.filter((t) => truckTrips(t.id).length).map((t) => t.id);
      if (!ids.length) { alert('لا توجد ردود للقلابات في هذه الفترة'); return; }
      printTrucks(ids);
    },
    'new-asset': () => assetForm(),
    'edit-asset': (id) => assetForm(byId('assets', id)),
    'del-asset': (id) => {
      if (db.expenses.some((e) => e.assetId === id)) { alert('لا يمكن حذف أصل مرتبط بمصروفات. غيّر حالته إلى "مباع" بدلاً من ذلك.'); return; }
      confirmDelete('assets', id, 'حذف هذا الأصل؟');
    },
    'print-assets': () => printHtml(`<div class="invoice wide"><div class="head"><div><h1>${esc(db.settings.name)}</h1></div>
      <div><strong>سجل الأصول</strong><div>${todayStr()}</div></div></div>${assetsTable(false)}</div>`),
    'edit-truck': (id) => truckForm(byId('trucks', id)),
    'del-truck': (id) => {
      if (db.sales.some((s) => s.truckId === id)) {
        alert('لا يمكن حذف قلاب مرتبط بردود.');
        return;
      }
      confirmDelete('trucks', id);
    },
    range: (_, el) => {
      const r = el.dataset.range, t = todayStr();
      repFilter.to = t;
      repFilter.from = r === 'today' ? t : r === 'month' ? monthStart() : t.slice(0, 5) + '01-01';
      render();
    },
    'print-report': () => {
      printHtml(`<div class="invoice"><h1>${esc(db.settings.name)}</h1>
        <p>تقرير الفترة من ${repFilter.from} إلى ${repFilter.to}</p>${$('#reportBody').innerHTML}</div>`);
    },
    'reset-logo': () => { db.settings.logo = ''; save(); render(); },
    'sample-slip': () => printHtml(slipHtml({ no: '', date: '    -    -    ', total: 0, qty: '', unit: 'trip' }, 1, 1)
      .replace(/<span class="slip-val">[^<]*(<bdi[^>]*>[^<]*<\/bdi>)?[^<]*<\/span>/g, '<span class="slip-val"></span>')),
    backup: () => download(`نسخة_احتياطية_${todayStr()}.json`, JSON.stringify(db, null, 2), 'application/json'),
    reset: () => {
      if (!confirm('سيتم مسح جميع البيانات نهائياً. هل أخذت نسخة احتياطية؟')) return;
      if (prompt('اكتب كلمة: مسح') !== 'مسح') return;
      db = defaultDb();
      save();
      render();
      toast('تم مسح البيانات');
    },
  };

  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-act]');
    if (!el || !actions[el.dataset.act]) return;
    actions[el.dataset.act](el.dataset.id, el);
  });

  document.addEventListener('change', (e) => {
    const el = e.target;
    if (el.dataset.filter) { salesFilter[el.dataset.filter] = el.value; render(); }
    else if (el.dataset.efilter) { expFilter[el.dataset.efilter] = el.value; render(); }
    else if (el.dataset.tfilter) { truckFilter[el.dataset.tfilter] = el.value; render(); }
    else if (el.dataset.rfilter) { repFilter[el.dataset.rfilter] = el.value; render(); }
    else if (el.id === 'logoFile' && el.files[0]) {
      const reader = new FileReader();
      reader.onload = () => { db.settings.logo = reader.result; save(); render(); toast('تم تغيير الشعار'); };
      reader.readAsDataURL(el.files[0]);
    }
    else if (el.id === 'restoreFile' && el.files[0]) {
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const data = JSON.parse(reader.result);
          if (!data || !Array.isArray(data.sales) || !data.settings) throw new Error('bad file');
          if (!confirm('سيتم استبدال البيانات الحالية بالنسخة الاحتياطية. متابعة؟')) return;
          db = mergeDb(data);
          save();
          render();
          toast('تمت الاستعادة بنجاح');
        } catch (err) {
          alert('الملف غير صالح');
        }
      };
      reader.readAsText(el.files[0]);
    }
  });

  document.addEventListener('submit', (e) => {
    if (e.target.id !== 'settingsForm') return;
    e.preventDefault();
    const d = Object.fromEntries(new FormData(e.target).entries());
    Object.assign(db.settings, {
      name: d.name.trim(), phone: d.phone.trim(), address: d.address.trim(), slipTitle: d.slipTitle.trim(),
      currency: d.currency.trim() || 'ريال', vat: num(d.vat),
    });
    save();
    render();
    toast('تم حفظ الإعدادات');
  });

  render();
})();
