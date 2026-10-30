const test = require('node:test');
const assert = require('node:assert');
const D = require('../server/db');
const { createApp } = require('../server/index');

let server, base;

async function call(method, url, body, token) {
  const res = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const type = res.headers.get('content-type') || '';
  return { status: res.status, body: type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) };
}

test.before(async () => {
  const db = D.open(':memory:');
  server = createApp(db).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

test('full workflow', async () => {
  // أول تشغيل: إنشاء المدير
  assert.equal((await call('GET', '/api/status')).body.needsSetup, true);
  const setup = await call('POST', '/api/setup', { name: 'المدير', username: 'admin', password: 'secret1' });
  assert.equal(setup.status, 200);
  const M = setup.body.token;
  assert.equal((await call('POST', '/api/setup', { name: 'x', username: 'y', password: 'zzzzzz' })).status, 403);

  // موظف بوابة
  const u = await call('POST', '/api/users', { name: 'موظف البوابة', username: 'gate', password: 'gate123', role: 'gate' }, M);
  assert.equal(u.status, 200);
  assert.equal((await call('POST', '/api/login', { username: 'gate', password: 'wrong' })).status, 401);
  const G = (await call('POST', '/api/login', { username: 'gate', password: 'gate123' })).body.token;

  const boot = (await call('GET', '/api/bootstrap', null, G)).body;
  assert.deepEqual(boot.materials.map((m) => m.name), ['دفان', 'سبيس']);
  const [dafan, sabis] = boot.materials;

  // البوابة لا تستطيع التقارير
  assert.equal((await call('GET', '/api/reports', null, G)).status, 403);

  const cust = (await call('POST', '/api/customers', { name: 'مقاولات النور', phone: '0500000000' }, G)).body;

  // خروج نقدي بدون عميل
  const t1 = await call('POST', '/api/trips', { requestId: 'r1', plate: '1234 ABD', driver: 'سالم', materialId: dafan.id, price: 300, method: 'cash' }, G);
  assert.equal(t1.status, 201);
  assert.equal(t1.body.trip.no, 1);
  assert.equal(t1.body.trip.paid, 300);
  assert.equal(t1.body.trip.user_name, 'موظف البوابة');
  assert.match(t1.body.trip.created_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);

  // نفس الطلب مرتين لا يُحفظ مرتين
  const again = await call('POST', '/api/trips', { requestId: 'r1', plate: '1234 ABD', materialId: dafan.id, price: 300, method: 'cash' }, G);
  assert.equal(again.body.repeated, true);
  assert.equal(again.body.trip.no, 1);

  // نفس اللوحة خلال وقت قصير => تنبيه
  const dup = await call('POST', '/api/trips', { requestId: 'r2', plate: '1234abd', materialId: dafan.id, price: 300, method: 'cash' }, G);
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error, 'duplicate');

  // آجل بدون عميل مرفوض
  const noCust = await call('POST', '/api/trips', { requestId: 'r3', plate: '9999 XYZ', materialId: sabis.id, price: 400, method: 'credit' }, G);
  assert.equal(noCust.status, 400);

  // تأكيد التكرار + تغيير السائق
  const t2 = await call('POST', '/api/trips', { requestId: 'r2', plate: '1234abd', driver: 'فهد', customerId: cust.id, materialId: sabis.id, price: 450, paid: 100, method: 'transfer', confirmDuplicate: true }, G);
  assert.equal(t2.status, 201);
  assert.equal(t2.body.trip.no, 2);
  assert.equal(t2.body.trip.remaining, 350);
  const t3 = await call('POST', '/api/trips', { requestId: 'r4', plate: '5555 KSA', customerId: cust.id, materialId: dafan.id, price: 320, method: 'credit' }, G);
  assert.equal(t3.body.trip.paid, 0);

  const trucks = (await call('GET', '/api/trucks', null, M)).body;
  assert.equal(trucks.length, 2);
  assert.equal(trucks.find((t) => t.plate === '1234 ABD').driver, 'فهد');
  // السجل القديم يحتفظ باسم السائق وقت العملية
  assert.equal((await call('GET', `/api/trips/${t1.body.trip.id}`, null, M)).body.driver, 'سالم');

  // تعديل اسم المادة لا يغير السجلات السابقة
  await call('PUT', `/api/materials/${dafan.id}`, { name: 'دفان أحمر' }, M);
  assert.equal((await call('GET', `/api/trips/${t1.body.trip.id}`, null, M)).body.material_name, 'دفان');

  // البوابة لا تستطيع الإلغاء أو التعديل
  assert.equal((await call('POST', `/api/trips/${t1.body.trip.id}/cancel`, { reason: 'x' }, G)).status, 403);
  // الإلغاء يتطلب سبب
  assert.equal((await call('POST', `/api/trips/${t1.body.trip.id}/cancel`, {}, M)).status, 400);
  const c = await call('POST', `/api/trips/${t1.body.trip.id}/cancel`, { reason: 'تسجيل بالخطأ' }, M);
  assert.equal(c.body.trip.status, 'cancelled');

  // تعديل بسبب
  const ed = await call('PUT', `/api/trips/${t3.body.trip.id}`, { plate: '5555 KSA', customerId: cust.id, materialId: dafan.id, price: 350, method: 'credit', reason: 'تصحيح السعر' }, M);
  assert.equal(ed.status, 200);
  assert.equal(ed.body.trip.remaining, 350);
  assert.equal(ed.body.trip.material_name, 'دفان'); // نفس المادة: يبقى الاسم المحفوظ

  // دفعة لاحقة لا تُحسب مبيعات
  const pay = await call('POST', '/api/payments', { requestId: 'p1', customerId: cust.id, amount: 200, method: 'cash' }, M);
  assert.equal(pay.status, 201);
  const st = (await call('GET', `/api/customers/${cust.id}/statement`, null, M)).body;
  assert.equal(st.totals.trips, 2);
  assert.equal(st.totals.sales, 800);
  assert.equal(st.totals.payments, 200);
  assert.equal(st.closing, 500); // 350 + 350 - 200

  const rep = (await call('GET', '/api/reports?withTrips=1', null, M)).body;
  assert.equal(rep.summary.trips, 2);
  assert.equal(rep.summary.sales, 800);
  assert.equal(rep.summary.transfer, 100);
  assert.equal(rep.summary.totalCash, 200);
  assert.equal(rep.summary.balances, 500);
  assert.equal(rep.byPlate.length, 2);

  const byPlate = (await call('GET', '/api/reports?plate=5555', null, M)).body;
  assert.equal(byPlate.summary.trips, 1);
  assert.equal(byPlate.payments, null);

  const xl = await call('GET', '/api/reports/export.xlsx', null, M);
  assert.equal(xl.status, 200);
  assert.equal(xl.body.slice(0, 2).toString(), 'PK');

  // البوابة ترى عمليات اليوم فقط
  const gateTrips = (await call('GET', '/api/trips?from=2000-01-01&status=all', null, G)).body;
  assert.equal(gateTrips.length, 3);

  const audit = (await call('GET', '/api/audit', null, M)).body;
  assert.ok(audit.some((a) => a.action === 'إلغاء' && a.reason === 'تسجيل بالخطأ'));
  assert.ok(audit.some((a) => a.action === 'تعديل' && a.entity === 'trip' && a.reason === 'تصحيح السعر'));
  assert.ok(audit.some((a) => a.summary.includes('تغيير سائق')));

  const dash = (await call('GET', '/api/dashboard', null, M)).body;
  assert.equal(dash.summary.trips, 2);
  assert.equal(dash.cancelledToday, 1);
  assert.equal(dash.outstanding, 500);
});
