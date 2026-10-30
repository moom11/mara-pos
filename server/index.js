// خادم نظام تسجيل خروج القلابات
process.env.TZ = process.env.TZ || 'Asia/Riyadh';

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const D = require('./db');
const { buildXlsx } = require('./xlsx');

const METHODS = { cash: 'نقد', transfer: 'تحويل', credit: 'آجل' };
const SESSION_DAYS = 30;

class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}
const bad = (msg, extra) => { throw new HttpError(400, msg, extra); };

const round2 = (n) => Math.round(n * 100) / 100;
const str = (v, max = 200) => String(v ?? '').trim().slice(0, max);
function amount(v) {
  const n = Number(String(v ?? '').replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d)).replace(',', '.'));
  return isFinite(n) ? round2(n) : NaN;
}
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));

function createApp(db) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '3mb' }));
  app.use(express.static(path.join(__dirname, '..', 'public')));

  const settings = () => D.getSettings(db);

  function audit(user, action, entity, entityId, summary, before, after, reason) {
    db.prepare(`INSERT INTO audit (at, user_id, user_name, action, entity, entity_id, summary, before, after, reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      D.localDateTime(), user ? user.id : null, user ? user.name : 'النظام', action, entity, entityId ?? null, summary || '',
      before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null, reason || null,
    );
  }

  // ---------- الدخول والصلاحيات ----------
  const failedLogins = new Map();

  function auth(req, res, next) {
    const token = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
    const row = token && db.prepare(`SELECT u.id, u.name, u.username, u.role FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token = ? AND s.expires_ts > ? AND u.active = 1`).get(token, Date.now());
    if (!row) return res.status(401).json({ error: 'انتهت الجلسة، سجّل الدخول مرة أخرى' });
    req.user = row;
    req.token = token;
    next();
  }
  const manager = (req, res, next) => (req.user.role === 'manager' ? next() : res.status(403).json({ error: 'هذه العملية للمدير فقط' }));
  const route = (fn) => (req, res, next) => {
    try {
      const out = fn(req, res);
      if (out !== undefined && !res.headersSent) res.json(out);
    } catch (e) {
      next(e);
    }
  };

  function createSession(userId) {
    const token = crypto.randomBytes(32).toString('hex');
    db.prepare('DELETE FROM sessions WHERE expires_ts < ?').run(Date.now());
    db.prepare('INSERT INTO sessions (token, user_id, expires_ts) VALUES (?, ?, ?)').run(token, userId, Date.now() + SESSION_DAYS * 864e5);
    return token;
  }

  const needsSetup = () => !db.prepare('SELECT COUNT(*) c FROM users').get().c;

  app.get('/api/status', route(() => ({ needsSetup: needsSetup() })));

  // إنشاء حساب المدير الأول عند أول تشغيل
  app.post('/api/setup', route((req) => {
    if (!needsSetup()) throw new HttpError(403, 'تم الإعداد مسبقاً');
    const b = req.body || {};
    const name = str(b.name, 60), username = str(b.username, 40), password = String(b.password || '');
    if (!name || !username) bad('أدخل الاسم واسم المستخدم');
    if (password.length < 6) bad('كلمة المرور يجب أن تكون 6 أحرف على الأقل');
    const id = db.prepare('INSERT INTO users (username, name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(username, name, D.hashPassword(password), 'manager', D.localDateTime()).lastInsertRowid;
    const user = { id, name, username, role: 'manager' };
    audit(user, 'إنشاء', 'user', id, `إنشاء حساب المدير ${name}`);
    return { token: createSession(id), user };
  }));

  app.post('/api/login', route((req) => {
    const ip = req.ip;
    const f = failedLogins.get(ip);
    if (f && f.count >= 10 && Date.now() - f.ts < 15 * 60e3) throw new HttpError(429, 'محاولات كثيرة، حاول بعد 15 دقيقة');
    const b = req.body || {};
    const u = db.prepare('SELECT * FROM users WHERE username = ? AND active = 1').get(str(b.username, 40));
    if (!u || !D.checkPassword(String(b.password || ''), u.password_hash)) {
      failedLogins.set(ip, { count: (f && Date.now() - f.ts < 15 * 60e3 ? f.count : 0) + 1, ts: Date.now() });
      throw new HttpError(401, 'اسم المستخدم أو كلمة المرور غير صحيحة');
    }
    failedLogins.delete(ip);
    return { token: createSession(u.id), user: { id: u.id, name: u.name, username: u.username, role: u.role } };
  }));

  app.post('/api/logout', auth, route((req) => {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(req.token);
    return { ok: true };
  }));

  // البيانات الأساسية التي تحتاجها الواجهة
  app.get('/api/bootstrap', auth, route((req) => {
    const lastPrices = {};
    for (const r of db.prepare(`SELECT material_id, price FROM trips WHERE id IN
      (SELECT MAX(id) FROM trips WHERE status = 'active' GROUP BY material_id)`).all()) lastPrices[r.material_id] = r.price;
    return {
      user: req.user,
      settings: settings(),
      materials: db.prepare('SELECT * FROM materials ORDER BY sort, id').all(),
      customers: db.prepare('SELECT id, name, phone, notes, active FROM customers ORDER BY name').all(),
      trucks: db.prepare(`SELECT t.*, (SELECT MAX(ts) FROM trips WHERE truck_id = t.id) AS last_ts FROM trucks t ORDER BY plate`).all(),
      lastPrices,
      today: D.localDate(),
    };
  }));

  // ---------- العملاء ----------
  const balanceSql = `
    COALESCE((SELECT SUM(remaining) FROM trips WHERE customer_id = c.id AND status = 'active' AND date <= @to), 0)
    - COALESCE((SELECT SUM(amount) FROM payments WHERE customer_id = c.id AND status = 'active' AND date <= @to), 0)`;

  app.get('/api/customers', auth, route(() => db.prepare(`SELECT c.*, ROUND(${balanceSql}, 2) AS balance,
      (SELECT COUNT(*) FROM trips WHERE customer_id = c.id AND status = 'active') AS trips
      FROM customers c ORDER BY c.name`).all({ to: '9999-12-31' })));

  function customerInput(b) {
    const rec = { name: str(b.name, 80), phone: str(b.phone, 30), notes: str(b.notes, 300) };
    if (!rec.name) bad('أدخل اسم العميل');
    return rec;
  }

  app.post('/api/customers', auth, route((req) => {
    const rec = customerInput(req.body || {});
    const dup = db.prepare('SELECT id FROM customers WHERE name = ?').get(rec.name);
    if (dup) bad('يوجد عميل بنفس الاسم');
    const id = db.prepare('INSERT INTO customers (name, phone, notes, created_at) VALUES (@name, @phone, @notes, @at)')
      .run({ ...rec, at: D.localDateTime() }).lastInsertRowid;
    audit(req.user, 'إضافة', 'customer', id, `إضافة عميل: ${rec.name}`, null, rec);
    return db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
  }));

  app.put('/api/customers/:id', auth, manager, route((req) => {
    const before = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id);
    if (!before) throw new HttpError(404, 'العميل غير موجود');
    const rec = customerInput(req.body || {});
    rec.active = req.body.active === false || req.body.active === 0 ? 0 : 1;
    db.prepare('UPDATE customers SET name = @name, phone = @phone, notes = @notes, active = @active WHERE id = @id').run({ ...rec, id: before.id });
    audit(req.user, 'تعديل', 'customer', before.id, `تعديل عميل: ${rec.name}`, before, rec);
    return db.prepare('SELECT * FROM customers WHERE id = ?').get(before.id);
  }));

  // كشف حساب العميل
  app.get('/api/customers/:id/statement', auth, manager, route((req) => {
    const c = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id);
    if (!c) throw new HttpError(404, 'العميل غير موجود');
    const from = isDate(req.query.from) ? req.query.from : '0000-01-01';
    const to = isDate(req.query.to) ? req.query.to : '9999-12-31';
    const before = db.prepare(`SELECT
      COALESCE((SELECT SUM(remaining) FROM trips WHERE customer_id = @id AND status = 'active' AND date < @from), 0)
      - COALESCE((SELECT SUM(amount) FROM payments WHERE customer_id = @id AND status = 'active' AND date < @from), 0) AS v`)
      .get({ id: c.id, from }).v;
    const trips = db.prepare(`SELECT * FROM trips WHERE customer_id = ? AND status = 'active' AND date BETWEEN ? AND ? ORDER BY ts`).all(c.id, from, to);
    const payments = db.prepare(`SELECT * FROM payments WHERE customer_id = ? AND status = 'active' AND date BETWEEN ? AND ? ORDER BY ts`).all(c.id, from, to);
    const entries = [
      ...trips.map((t) => ({
        kind: 'trip', ts: t.ts, at: t.created_at, no: t.no, desc: `رد — ${t.material_name} — لوحة ${t.plate}${t.driver ? ' — ' + t.driver : ''}`,
        sale: t.price, paid: t.paid, method: t.method,
      })),
      ...payments.map((p) => ({ kind: 'payment', ts: p.ts, at: p.created_at, no: p.no, desc: `سداد${p.notes ? ' — ' + p.notes : ''}`, sale: 0, paid: p.amount, method: p.method })),
    ].sort((a, b) => a.ts - b.ts);
    let bal = round2(before);
    for (const e of entries) e.balance = bal = round2(bal + e.sale - e.paid);
    const sum = (arr, f) => round2(arr.reduce((a, x) => a + f(x), 0));
    return {
      customer: c, from, to, opening: round2(before), closing: bal, entries,
      totals: {
        trips: trips.length,
        sales: sum(trips, (t) => t.price),
        paidAtExit: sum(trips, (t) => t.paid),
        payments: sum(payments, (p) => p.amount),
      },
    };
  }));

  // ---------- القلابات ----------
  function truckInput(b) {
    const rec = { plate: str(b.plate, 20).toUpperCase().replace(/\s+/g, ' '), driver: str(b.driver, 60), driver_phone: str(b.driver_phone, 30), type: str(b.type, 40), notes: str(b.notes, 300) };
    rec.plate_norm = D.normPlate(rec.plate);
    if (!rec.plate_norm) bad('أدخل رقم اللوحة');
    return rec;
  }

  app.get('/api/trucks', auth, route(() => db.prepare(`SELECT t.*,
    (SELECT COUNT(*) FROM trips WHERE truck_id = t.id AND status = 'active') AS trips,
    (SELECT MAX(created_at) FROM trips WHERE truck_id = t.id) AS last_trip
    FROM trucks t ORDER BY t.plate`).all()));

  app.post('/api/trucks', auth, route((req) => {
    const rec = truckInput(req.body || {});
    if (db.prepare('SELECT id FROM trucks WHERE plate_norm = ?').get(rec.plate_norm)) bad('هذه اللوحة مسجلة مسبقاً');
    const id = db.prepare(`INSERT INTO trucks (plate, plate_norm, driver, driver_phone, type, notes, created_at)
      VALUES (@plate, @plate_norm, @driver, @driver_phone, @type, @notes, @at)`).run({ ...rec, at: D.localDateTime() }).lastInsertRowid;
    audit(req.user, 'إضافة', 'truck', id, `إضافة قلاب: ${rec.plate}`, null, rec);
    return db.prepare('SELECT * FROM trucks WHERE id = ?').get(id);
  }));

  app.put('/api/trucks/:id', auth, manager, route((req) => {
    const before = db.prepare('SELECT * FROM trucks WHERE id = ?').get(req.params.id);
    if (!before) throw new HttpError(404, 'القلاب غير موجود');
    const rec = truckInput(req.body || {});
    const dup = db.prepare('SELECT id FROM trucks WHERE plate_norm = ? AND id != ?').get(rec.plate_norm, before.id);
    if (dup) bad('هذه اللوحة مسجلة لقلاب آخر');
    rec.active = req.body.active === false || req.body.active === 0 ? 0 : 1;
    db.prepare(`UPDATE trucks SET plate = @plate, plate_norm = @plate_norm, driver = @driver, driver_phone = @driver_phone,
      type = @type, notes = @notes, active = @active WHERE id = @id`).run({ ...rec, id: before.id });
    audit(req.user, 'تعديل', 'truck', before.id, `تعديل قلاب: ${rec.plate}`, before, rec);
    return db.prepare('SELECT * FROM trucks WHERE id = ?').get(before.id);
  }));

  // ---------- عمليات الخروج (الردود) ----------
  const getTrip = (id) => db.prepare('SELECT * FROM trips WHERE id = ?').get(id);

  // التحقق من بيانات العملية وحساب المتبقي
  function tripInput(b) {
    const plate = str(b.plate, 20).toUpperCase().replace(/\s+/g, ' ');
    const plateNorm = D.normPlate(plate);
    if (!plateNorm) bad('أدخل رقم اللوحة');
    const material = db.prepare('SELECT * FROM materials WHERE id = ?').get(b.materialId);
    if (!material) bad('اختر نوع المادة');
    const price = amount(b.price);
    if (!(price > 0)) bad('أدخل سعر الرد');
    const method = METHODS[b.method] ? b.method : null;
    if (!method) bad('اختر طريقة الدفع');
    const paid = method === 'credit' ? 0 : amount(b.paid === '' || b.paid === undefined ? price : b.paid);
    if (!(paid >= 0)) bad('المبلغ المدفوع غير صحيح');
    if (paid > price) bad('المبلغ المدفوع أكبر من سعر الرد');
    let customer = null;
    if (b.customerId) {
      customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(b.customerId);
      if (!customer) bad('العميل غير موجود');
    }
    const remaining = round2(price - paid);
    if (remaining > 0 && !customer) bad('اختر العميل لأن عليه مبلغاً متبقياً');
    return { plate, plateNorm, material, price, paid, remaining, method, customer, driver: str(b.driver, 60), notes: str(b.notes, 300) };
  }

  function ensureTruck(user, plate, plateNorm, driver) {
    let truck = db.prepare('SELECT * FROM trucks WHERE plate_norm = ?').get(plateNorm);
    if (!truck) {
      const id = db.prepare(`INSERT INTO trucks (plate, plate_norm, driver, created_at) VALUES (?, ?, ?, ?)`)
        .run(plate, plateNorm, driver, D.localDateTime()).lastInsertRowid;
      truck = db.prepare('SELECT * FROM trucks WHERE id = ?').get(id);
      audit(user, 'إضافة', 'truck', id, `إضافة قلاب جديد عند الخروج: ${plate}`, null, { plate, driver });
    } else if (driver && driver !== truck.driver) {
      // اسم السائق يُحفظ مع القلاب ويمكن تغييره من شاشة الخروج
      db.prepare('UPDATE trucks SET driver = ? WHERE id = ?').run(driver, truck.id);
      audit(user, 'تعديل', 'truck', truck.id, `تغيير سائق القلاب ${truck.plate}: ${truck.driver || '-'} ← ${driver}`, { driver: truck.driver }, { driver });
      truck.driver = driver;
    }
    return truck;
  }

  app.post('/api/trips', auth, route((req, res) => {
    const b = req.body || {};
    const requestId = str(b.requestId, 64) || null;
    // منع تكرار الحفظ عند الضغط على الزر أكثر من مرة
    if (requestId) {
      const existing = db.prepare('SELECT * FROM trips WHERE request_id = ?').get(requestId);
      if (existing) return { trip: existing, repeated: true };
    }
    const x = tripInput(b);
    const now = Date.now();
    const mins = settings().duplicateMinutes;
    if (mins > 0 && !b.confirmDuplicate) {
      const last = db.prepare(`SELECT no, ts, created_at FROM trips WHERE plate_norm = ? AND status = 'active' ORDER BY ts DESC LIMIT 1`).get(x.plateNorm);
      if (last && now - last.ts < mins * 60e3) {
        res.status(409).json({
          error: 'duplicate',
          message: `اللوحة ${x.plate} سُجل لها خروج قبل ${Math.max(1, Math.round((now - last.ts) / 60e3))} دقيقة (سند رقم ${last.no})`,
          last,
        });
        return;
      }
    }
    const trip = db.transaction(() => {
      const truck = ensureTruck(req.user, x.plate, x.plateNorm, x.driver);
      const no = D.nextNumber(db, 'trip');
      const at = D.localDateTime(new Date(now));
      const id = db.prepare(`INSERT INTO trips (no, request_id, ts, created_at, date, truck_id, plate, plate_norm, driver, truck_type,
        customer_id, customer_name, material_id, material_name, price, paid, remaining, method, notes, user_id, user_name)
        VALUES (@no, @requestId, @ts, @at, @date, @truckId, @plate, @plateNorm, @driver, @truckType, @customerId, @customerName,
        @materialId, @materialName, @price, @paid, @remaining, @method, @notes, @userId, @userName)`).run({
        no, requestId, ts: now, at, date: at.slice(0, 10), truckId: truck.id, plate: truck.plate, plateNorm: x.plateNorm,
        driver: x.driver || truck.driver, truckType: truck.type, customerId: x.customer ? x.customer.id : null,
        customerName: x.customer ? x.customer.name : '', materialId: x.material.id, materialName: x.material.name,
        price: x.price, paid: x.paid, remaining: x.remaining, method: x.method, notes: x.notes, userId: req.user.id, userName: req.user.name,
      }).lastInsertRowid;
      const t = getTrip(id);
      audit(req.user, 'تسجيل خروج', 'trip', id, `سند ${no} — ${t.plate} — ${t.material_name} — ${t.price}`, null, t);
      return t;
    })();
    res.status(201);
    return { trip };
  }));

  function tripFilters(q, user) {
    const where = [];
    const p = {};
    let from = isDate(q.from) ? q.from : null;
    let to = isDate(q.to) ? q.to : null;
    if (user.role === 'gate') from = to = D.localDate(); // موظف البوابة يرى عمليات اليوم فقط
    if (from) { where.push('t.date >= @from'); p.from = from; }
    if (to) { where.push('t.date <= @to'); p.to = to; }
    if (q.plate) { where.push('t.plate_norm LIKE @plate'); p.plate = `%${D.normPlate(q.plate)}%`; }
    if (q.customerId) { where.push('t.customer_id = @customerId'); p.customerId = Number(q.customerId); }
    if (q.materialId) { where.push('t.material_id = @materialId'); p.materialId = Number(q.materialId); }
    if (q.method && METHODS[q.method]) { where.push('t.method = @method'); p.method = q.method; }
    if (q.status === 'cancelled') where.push("t.status = 'cancelled'");
    else if (q.status !== 'all') where.push("t.status = 'active'");
    if (q.q) {
      where.push(`(CAST(t.no AS TEXT) = @qExact OR t.plate_norm LIKE @qPlate OR t.driver LIKE @qLike OR t.customer_name LIKE @qLike
        OR t.notes LIKE @qLike OR t.user_name LIKE @qLike)`);
      p.qExact = str(q.q, 40);
      p.qPlate = `%${D.normPlate(q.q)}%`;
      p.qLike = `%${str(q.q, 40)}%`;
    }
    return { sql: where.length ? 'WHERE ' + where.join(' AND ') : '', params: p, from, to };
  }

  app.get('/api/trips', auth, route((req) => {
    const f = tripFilters(req.query, req.user);
    const limit = Math.min(Number(req.query.limit) || 500, 5000);
    return db.prepare(`SELECT t.* FROM trips t ${f.sql} ORDER BY t.ts DESC LIMIT ${limit}`).all(f.params);
  }));

  app.get('/api/trips/:id', auth, route((req) => {
    const t = getTrip(req.params.id);
    if (!t) throw new HttpError(404, 'العملية غير موجودة');
    if (req.user.role === 'gate' && t.date !== D.localDate()) throw new HttpError(403, 'غير مسموح');
    return t;
  }));

  app.put('/api/trips/:id', auth, manager, route((req) => {
    const before = getTrip(req.params.id);
    if (!before) throw new HttpError(404, 'العملية غير موجودة');
    if (before.status !== 'active') bad('لا يمكن تعديل عملية ملغاة');
    const b = req.body || {};
    const reason = str(b.reason, 300);
    if (!reason) bad('اكتب سبب التعديل');
    const x = tripInput(b);
    const trip = db.transaction(() => {
      let truck = db.prepare('SELECT * FROM trucks WHERE plate_norm = ?').get(x.plateNorm);
      if (!truck) truck = ensureTruck(req.user, x.plate, x.plateNorm, x.driver);
      db.prepare(`UPDATE trips SET truck_id = @truckId, plate = @plate, plate_norm = @plateNorm, driver = @driver,
        truck_type = @truckType, customer_id = @customerId, customer_name = @customerName, material_id = @materialId,
        material_name = @materialName, price = @price, paid = @paid, remaining = @remaining, method = @method, notes = @notes,
        updated_at = @at WHERE id = @id`).run({
        id: before.id, truckId: truck.id, plate: truck.plate, plateNorm: x.plateNorm, driver: x.driver,
        truckType: truck.id === before.truck_id ? before.truck_type : truck.type,
        customerId: x.customer ? x.customer.id : null,
        customerName: x.customer ? (x.customer.id === before.customer_id ? before.customer_name : x.customer.name) : '',
        materialId: x.material.id, materialName: x.material.id === before.material_id ? before.material_name : x.material.name,
        price: x.price, paid: x.paid, remaining: x.remaining, method: x.method, notes: x.notes, at: D.localDateTime(),
      });
      const after = getTrip(before.id);
      audit(req.user, 'تعديل', 'trip', before.id, `تعديل سند ${before.no}`, before, after, reason);
      return after;
    })();
    return { trip };
  }));

  app.post('/api/trips/:id/cancel', auth, manager, route((req) => {
    const before = getTrip(req.params.id);
    if (!before) throw new HttpError(404, 'العملية غير موجودة');
    if (before.status !== 'active') bad('العملية ملغاة مسبقاً');
    const reason = str((req.body || {}).reason, 300);
    if (!reason) bad('اكتب سبب الإلغاء');
    db.prepare(`UPDATE trips SET status = 'cancelled', cancel_reason = ?, cancelled_by = ?, cancelled_at = ? WHERE id = ?`)
      .run(reason, req.user.name, D.localDateTime(), before.id);
    audit(req.user, 'إلغاء', 'trip', before.id, `إلغاء سند ${before.no} — ${before.plate}`, before, null, reason);
    return { trip: getTrip(before.id) };
  }));

  // ---------- دفعات العملاء (سداد) ----------
  app.post('/api/payments', auth, manager, route((req, res) => {
    const b = req.body || {};
    const requestId = str(b.requestId, 64) || null;
    if (requestId) {
      const existing = db.prepare('SELECT * FROM payments WHERE request_id = ?').get(requestId);
      if (existing) return { payment: existing, repeated: true };
    }
    const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(b.customerId);
    if (!customer) bad('اختر العميل');
    const amt = amount(b.amount);
    if (!(amt > 0)) bad('أدخل مبلغ الدفعة');
    const method = b.method === 'transfer' ? 'transfer' : b.method === 'cash' ? 'cash' : null;
    if (!method) bad('اختر طريقة الدفع');
    const now = new Date();
    const at = D.localDateTime(now);
    const date = isDate(b.date) ? b.date : at.slice(0, 10);
    const payment = db.transaction(() => {
      const no = D.nextNumber(db, 'payment');
      const id = db.prepare(`INSERT INTO payments (no, request_id, ts, created_at, date, customer_id, customer_name, amount, method, notes, user_id, user_name)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(no, requestId, now.getTime(), at, date, customer.id, customer.name, amt, method,
        str(b.notes, 300), req.user.id, req.user.name).lastInsertRowid;
      const p = db.prepare('SELECT * FROM payments WHERE id = ?').get(id);
      audit(req.user, 'سداد', 'payment', id, `سداد ${no} — ${customer.name} — ${amt}`, null, p);
      return p;
    })();
    res.status(201);
    return { payment };
  }));

  app.get('/api/payments', auth, manager, route((req) => {
    const q = req.query;
    const where = [];
    const p = {};
    if (isDate(q.from)) { where.push('date >= @from'); p.from = q.from; }
    if (isDate(q.to)) { where.push('date <= @to'); p.to = q.to; }
    if (q.customerId) { where.push('customer_id = @customerId'); p.customerId = Number(q.customerId); }
    if (q.status !== 'all') where.push("status = 'active'");
    return db.prepare(`SELECT * FROM payments ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ts DESC LIMIT 2000`).all(p);
  }));

  app.post('/api/payments/:id/cancel', auth, manager, route((req) => {
    const before = db.prepare('SELECT * FROM payments WHERE id = ?').get(req.params.id);
    if (!before) throw new HttpError(404, 'الدفعة غير موجودة');
    if (before.status !== 'active') bad('الدفعة ملغاة مسبقاً');
    const reason = str((req.body || {}).reason, 300);
    if (!reason) bad('اكتب سبب الإلغاء');
    db.prepare(`UPDATE payments SET status = 'cancelled', cancel_reason = ?, cancelled_by = ?, cancelled_at = ? WHERE id = ?`)
      .run(reason, req.user.name, D.localDateTime(), before.id);
    audit(req.user, 'إلغاء', 'payment', before.id, `إلغاء سداد ${before.no} — ${before.customer_name}`, before, null, reason);
    return { ok: true };
  }));

  // ---------- التقارير ----------
  function report(q, user) {
    const f = tripFilters({ ...q, status: 'active', q: '' }, user);
    const trips = db.prepare(`SELECT t.* FROM trips t ${f.sql} ORDER BY t.ts`).all(f.params);
    const sum = (arr, fn) => round2(arr.reduce((a, x) => a + fn(x), 0));
    const totals = (list) => ({
      trips: list.length,
      sales: sum(list, (t) => t.price),
      cash: sum(list, (t) => (t.method === 'cash' ? t.paid : 0)),
      transfer: sum(list, (t) => (t.method === 'transfer' ? t.paid : 0)),
      remaining: sum(list, (t) => t.remaining),
    });
    const group = (keyFn, labelFn) => {
      const m = new Map();
      for (const t of trips) {
        const k = keyFn(t);
        if (!m.has(k)) m.set(k, { key: k, label: labelFn(t), list: [] });
        m.get(k).list.push(t);
      }
      return [...m.values()].map((g) => ({ key: g.key, label: g.label, ...totals(g.list) })).sort((a, b) => b.sales - a.sales);
    };

    // الدفعات اللاحقة لا ترتبط بلوحة أو مادة، لذا تظهر فقط عند عدم التصفية بهما
    let payments = null;
    if (!q.plate && !q.materialId) {
      const pw = ["status = 'active'"];
      const pp = {};
      if (f.from) { pw.push('date >= @from'); pp.from = f.from; }
      if (f.to) { pw.push('date <= @to'); pp.to = f.to; }
      if (q.customerId) { pw.push('customer_id = @customerId'); pp.customerId = Number(q.customerId); }
      const list = db.prepare(`SELECT * FROM payments WHERE ${pw.join(' AND ')} ORDER BY ts`).all(pp);
      payments = {
        list,
        count: list.length,
        cash: sum(list, (p) => (p.method === 'cash' ? p.amount : 0)),
        transfer: sum(list, (p) => (p.method === 'transfer' ? p.amount : 0)),
      };
    }

    const balances = db.prepare(`SELECT c.id, c.name, c.phone, ROUND(${balanceSql}, 2) AS balance FROM customers c
      ${q.customerId ? 'WHERE c.id = @cid' : ''} ORDER BY balance DESC`)
      .all({ to: f.to || '9999-12-31', ...(q.customerId ? { cid: Number(q.customerId) } : {}) })
      .filter((c) => Math.abs(c.balance) > 0.001);

    const summary = totals(trips);
    summary.paymentsCash = payments ? payments.cash : 0;
    summary.paymentsTransfer = payments ? payments.transfer : 0;
    summary.totalCash = round2(summary.cash + summary.paymentsCash);
    summary.totalTransfer = round2(summary.transfer + summary.paymentsTransfer);
    summary.balances = sum(balances, (c) => c.balance);

    return {
      from: f.from, to: f.to, summary, trips, payments, balances,
      byDay: group((t) => t.date, (t) => t.date).sort((a, b) => a.key.localeCompare(b.key)),
      byPlate: group((t) => t.plate_norm, (t) => t.plate),
      byCustomer: group((t) => t.customer_id || 0, (t) => t.customer_name || 'نقدي (بدون عميل)'),
      byMaterial: group((t) => t.material_id, (t) => t.material_name),
    };
  }

  app.get('/api/reports', auth, manager, route((req) => {
    const r = report(req.query, req.user);
    if (req.query.withTrips !== '1') delete r.trips;
    return r;
  }));

  app.get('/api/dashboard', auth, manager, route((req) => {
    const today = D.localDate();
    const r = report({ from: today, to: today }, req.user);
    const outstanding = db.prepare(`SELECT ROUND(SUM(b), 2) v FROM (SELECT ${balanceSql} AS b FROM customers c) WHERE b > 0`).get({ to: '9999-12-31' }).v || 0;
    return {
      today, summary: r.summary, byMaterial: r.byMaterial, byPlate: r.byPlate.slice(0, 10),
      latest: db.prepare('SELECT * FROM trips WHERE date = ? ORDER BY ts DESC LIMIT 15').all(today),
      cancelledToday: db.prepare("SELECT COUNT(*) c FROM trips WHERE date = ? AND status = 'cancelled'").get(today).c,
      outstanding,
    };
  }));

  app.get('/api/reports/export.xlsx', auth, manager, (req, res, next) => {
    try {
      const r = report(req.query, req.user);
      const st = settings();
      const groupCols = (title) => [
        { header: title, width: 26 }, { header: 'عدد الردود', width: 12 }, { header: 'المبيعات', width: 14 },
        { header: 'نقد', width: 14 }, { header: 'تحويل', width: 14 }, { header: 'المتبقي (آجل)', width: 16 },
      ];
      const groupRows = (list) => [
        ...list.map((g) => [g.label, g.trips, g.sales, g.cash, g.transfer, g.remaining]),
        { bold: true, values: ['الإجمالي', r.summary.trips, r.summary.sales, r.summary.cash, r.summary.transfer, r.summary.remaining] },
      ];
      const s = r.summary;
      const sheets = [
        {
          name: 'الملخص',
          columns: [{ header: 'البند', width: 34 }, { header: 'القيمة', width: 20 }],
          rows: [
            ['الشركة', st.companyName], ['الفترة', `${r.from || 'البداية'} إلى ${r.to || 'الآن'}`],
            ['عدد الردود', s.trips], ['المبيعات', s.sales], ['نقد عند الخروج', s.cash], ['تحويل عند الخروج', s.transfer],
            ['متبقي آجل من ردود الفترة', s.remaining], ['سدادات نقد', s.paymentsCash], ['سدادات تحويل', s.paymentsTransfer],
            { bold: true, values: ['إجمالي التحصيل النقدي', s.totalCash] }, { bold: true, values: ['إجمالي التحويلات', s.totalTransfer] },
            { bold: true, values: ['أرصدة العملاء المتبقية', s.balances] },
          ],
        },
        {
          name: 'الردود',
          columns: [
            { header: 'رقم السند', width: 10 }, { header: 'التاريخ والوقت', width: 20 }, { header: 'اللوحة', width: 14 },
            { header: 'السائق', width: 18 }, { header: 'العميل', width: 22 }, { header: 'المادة', width: 12 }, { header: 'السعر', width: 12 },
            { header: 'المدفوع', width: 12 }, { header: 'طريقة الدفع', width: 12 }, { header: 'المتبقي', width: 12 },
            { header: 'الموظف', width: 16 }, { header: 'ملاحظات', width: 30 },
          ],
          rows: [
            ...r.trips.map((t) => [t.no, t.created_at, t.plate, t.driver, t.customer_name || 'نقدي', t.material_name, t.price, t.paid,
              METHODS[t.method], t.remaining, t.user_name, t.notes]),
            { bold: true, values: ['الإجمالي', '', '', '', '', `${s.trips} رد`, s.sales, round2(s.cash + s.transfer), '', s.remaining] },
          ],
        },
        { name: 'حسب اللوحة', columns: groupCols('اللوحة'), rows: groupRows(r.byPlate) },
        { name: 'حسب العميل', columns: groupCols('العميل'), rows: groupRows(r.byCustomer) },
        { name: 'حسب المادة', columns: groupCols('المادة'), rows: groupRows(r.byMaterial) },
        { name: 'حسب اليوم', columns: groupCols('اليوم'), rows: groupRows(r.byDay) },
      ];
      if (r.payments) {
        sheets.push({
          name: 'السدادات',
          columns: [{ header: 'رقم', width: 8 }, { header: 'التاريخ', width: 20 }, { header: 'العميل', width: 24 }, { header: 'المبلغ', width: 14 },
            { header: 'الطريقة', width: 10 }, { header: 'الموظف', width: 16 }, { header: 'ملاحظات', width: 30 }],
          rows: r.payments.list.map((p) => [p.no, p.created_at, p.customer_name, p.amount, METHODS[p.method], p.user_name, p.notes]),
        });
      }
      sheets.push({
        name: 'أرصدة العملاء',
        columns: [{ header: 'العميل', width: 26 }, { header: 'الجوال', width: 16 }, { header: 'الرصيد المتبقي', width: 16 }],
        rows: [...r.balances.map((c) => [c.name, c.phone, c.balance]), { bold: true, values: ['الإجمالي', '', s.balances] }],
      });
      const buf = buildXlsx(sheets);
      const name = `report_${r.from || 'all'}_${r.to || 'all'}.xlsx`;
      res.set({
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${name}"`,
      });
      res.send(buf);
    } catch (e) {
      next(e);
    }
  });

  // ---------- المواد والإعدادات والمستخدمين ----------
  app.post('/api/materials', auth, manager, route((req) => {
    const name = str((req.body || {}).name, 40);
    if (!name) bad('أدخل اسم المادة');
    if (db.prepare('SELECT id FROM materials WHERE name = ?').get(name)) bad('المادة موجودة مسبقاً');
    const sort = (db.prepare('SELECT MAX(sort) m FROM materials').get().m || 0) + 1;
    const id = db.prepare('INSERT INTO materials (name, sort) VALUES (?, ?)').run(name, sort).lastInsertRowid;
    audit(req.user, 'إضافة', 'material', id, `إضافة مادة: ${name}`);
    return db.prepare('SELECT * FROM materials WHERE id = ?').get(id);
  }));

  app.put('/api/materials/:id', auth, manager, route((req) => {
    const before = db.prepare('SELECT * FROM materials WHERE id = ?').get(req.params.id);
    if (!before) throw new HttpError(404, 'المادة غير موجودة');
    const name = str(req.body.name, 40) || before.name;
    const active = req.body.active === false || req.body.active === 0 ? 0 : 1;
    db.prepare('UPDATE materials SET name = ?, active = ? WHERE id = ?').run(name, active, before.id);
    audit(req.user, 'تعديل', 'material', before.id, `تعديل مادة: ${before.name} ← ${name}${active ? '' : ' (إيقاف)'}`, before, { name, active });
    return db.prepare('SELECT * FROM materials WHERE id = ?').get(before.id);
  }));

  app.put('/api/settings', auth, manager, route((req) => {
    const b = req.body || {};
    const before = settings();
    const allowed = ['companyName', 'city', 'phone', 'currency', 'voucherTitle', 'voucherSize', 'duplicateMinutes', 'logo'];
    const upd = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    for (const k of allowed) {
      if (b[k] === undefined) continue;
      let v = k === 'logo' ? String(b[k]).slice(0, 2_000_000) : str(b[k], 120);
      if (k === 'duplicateMinutes') v = String(Math.max(0, Math.min(1440, Number(v) || 0)));
      if (k === 'voucherSize' && !['a5', '80mm'].includes(v)) v = 'a5';
      if (k === 'logo' && v && !/^data:image\/(png|jpeg|webp|gif);base64,/.test(v)) bad('صيغة الشعار غير مدعومة');
      upd.run(k, v);
    }
    const after = settings();
    const strip = (s) => ({ ...s, logo: s.logo ? '[صورة]' : '' });
    audit(req.user, 'تعديل', 'settings', null, 'تعديل الإعدادات', strip(before), strip(after));
    return after;
  }));

  app.get('/api/users', auth, manager, route(() => db.prepare('SELECT id, username, name, role, active, created_at FROM users ORDER BY id').all()));

  app.post('/api/users', auth, manager, route((req) => {
    const b = req.body || {};
    const rec = { username: str(b.username, 40), name: str(b.name, 60), role: b.role === 'manager' ? 'manager' : 'gate' };
    if (!rec.username || !rec.name) bad('أدخل الاسم واسم المستخدم');
    if (String(b.password || '').length < 6) bad('كلمة المرور يجب أن تكون 6 أحرف على الأقل');
    if (db.prepare('SELECT id FROM users WHERE username = ?').get(rec.username)) bad('اسم المستخدم مستخدم مسبقاً');
    const id = db.prepare('INSERT INTO users (username, name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(rec.username, rec.name, D.hashPassword(b.password), rec.role, D.localDateTime()).lastInsertRowid;
    audit(req.user, 'إضافة', 'user', id, `إضافة مستخدم: ${rec.name} (${rec.role === 'manager' ? 'مدير' : 'موظف بوابة'})`, null, rec);
    return { id, ...rec, active: 1 };
  }));

  app.put('/api/users/:id', auth, manager, route((req) => {
    const before = db.prepare('SELECT id, username, name, role, active FROM users WHERE id = ?').get(req.params.id);
    if (!before) throw new HttpError(404, 'المستخدم غير موجود');
    const b = req.body || {};
    const rec = {
      name: str(b.name, 60) || before.name,
      role: b.role === 'manager' ? 'manager' : b.role === 'gate' ? 'gate' : before.role,
      active: b.active === undefined ? before.active : b.active ? 1 : 0,
    };
    if (before.id === req.user.id && (rec.role !== 'manager' || !rec.active)) bad('لا يمكنك إيقاف حسابك أو تغيير صلاحيته');
    db.prepare('UPDATE users SET name = ?, role = ?, active = ? WHERE id = ?').run(rec.name, rec.role, rec.active, before.id);
    if (b.password) {
      if (String(b.password).length < 6) bad('كلمة المرور يجب أن تكون 6 أحرف على الأقل');
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(D.hashPassword(b.password), before.id);
      db.prepare('DELETE FROM sessions WHERE user_id = ? AND token != ?').run(before.id, req.token);
    }
    if (!rec.active) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(before.id);
    audit(req.user, 'تعديل', 'user', before.id, `تعديل مستخدم: ${rec.name}${b.password ? ' (تغيير كلمة المرور)' : ''}`, before, rec);
    return { ...before, ...rec };
  }));

  app.get('/api/audit', auth, manager, route((req) => {
    const where = [];
    const p = {};
    if (req.query.entity) { where.push('entity = @entity'); p.entity = str(req.query.entity, 20); }
    if (req.query.entityId) { where.push('entity_id = @entityId'); p.entityId = Number(req.query.entityId); }
    if (req.query.q) { where.push('(summary LIKE @q OR user_name LIKE @q OR reason LIKE @q)'); p.q = `%${str(req.query.q, 40)}%`; }
    return db.prepare(`SELECT * FROM audit ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT 500`).all(p);
  }));

  // ---------- الأصول ----------
  const ASSET_STATUS = ['active', 'maintenance', 'idle', 'sold'];
  function assetInput(b) {
    const rec = {
      name: str(b.name, 80), type: str(b.type, 40), identifier: str(b.identifier, 40),
      purchase_date: isDate(b.purchase_date) ? b.purchase_date : null, cost: amount(b.cost) || 0,
      life_years: amount(b.life_years) || 0, salvage: amount(b.salvage) || 0,
      status: ASSET_STATUS.includes(b.status) ? b.status : 'active', location: str(b.location, 80), notes: str(b.notes, 300),
    };
    if (!rec.name) bad('أدخل اسم الأصل');
    return rec;
  }
  app.get('/api/assets', auth, manager, route(() => db.prepare('SELECT * FROM assets ORDER BY id').all()));
  app.post('/api/assets', auth, manager, route((req) => {
    const rec = assetInput(req.body || {});
    const id = db.prepare(`INSERT INTO assets (name, type, identifier, purchase_date, cost, life_years, salvage, status, location, notes)
      VALUES (@name, @type, @identifier, @purchase_date, @cost, @life_years, @salvage, @status, @location, @notes)`).run(rec).lastInsertRowid;
    audit(req.user, 'إضافة', 'asset', id, `تسجيل أصل: ${rec.name}`, null, rec);
    return db.prepare('SELECT * FROM assets WHERE id = ?').get(id);
  }));
  app.put('/api/assets/:id', auth, manager, route((req) => {
    const before = db.prepare('SELECT * FROM assets WHERE id = ?').get(req.params.id);
    if (!before) throw new HttpError(404, 'الأصل غير موجود');
    const rec = assetInput(req.body || {});
    db.prepare(`UPDATE assets SET name = @name, type = @type, identifier = @identifier, purchase_date = @purchase_date, cost = @cost,
      life_years = @life_years, salvage = @salvage, status = @status, location = @location, notes = @notes WHERE id = @id`).run({ ...rec, id: before.id });
    audit(req.user, 'تعديل', 'asset', before.id, `تعديل أصل: ${rec.name}`, before, rec);
    return db.prepare('SELECT * FROM assets WHERE id = ?').get(before.id);
  }));

  // نسخة احتياطية كاملة من قاعدة البيانات
  app.get('/api/backup', auth, manager, (req, res, next) => {
    try {
      const buf = db.serialize();
      audit(req.user, 'نسخ احتياطي', 'system', null, 'تنزيل نسخة احتياطية من قاعدة البيانات');
      res.set({ 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="mara-backup-${D.localDate()}.db"` });
      res.send(buf);
    } catch (e) {
      next(e);
    }
  });

  app.use('/api', (req, res) => res.status(404).json({ error: 'غير موجود' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, ...(err.extra || {}) });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'الملف كبير جداً' });
    console.error(err);
    res.status(500).json({ error: 'حدث خطأ في الخادم' });
  });

  return app;
}

if (require.main === module) {
  const file = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'mara.db');
  const db = D.open(file);
  const port = Number(process.env.PORT) || 3000;
  createApp(db).listen(port, '0.0.0.0', () => {
    console.log(`النظام يعمل على: http://localhost:${port}`);
    const nets = require('os').networkInterfaces();
    for (const list of Object.values(nets)) {
      for (const n of list || []) if (n.family === 'IPv4' && !n.internal) console.log(`من الجوال على نفس الشبكة: http://${n.address}:${port}`);
    }
    console.log(`قاعدة البيانات: ${file}`);
  });
}

module.exports = { createApp };
