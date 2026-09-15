'use strict';

/**
 * يصدر ترخيصًا لجهاز عميل.
 *
 *   node tools/make-license.js <رمز-الجهاز> "<اسم العميل>" [--days 365]
 *
 * مثال:
 *   node tools/make-license.js A1B2-C3D4-E5F6-7890 "مقهى الواحة - فرع النخيل"
 *   node tools/make-license.js a1b2c3d4e5f67890 "تجربة" --days 30
 *
 * رمز الجهاز يقرؤه العميل من شاشة التفعيل ويرسله لك. الترخيص الناتج
 * يعمل على ذلك الجهاز وحده — نسخه لجهاز آخر لا ينفع.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const PRIVATE_FILE = path.join(os.homedir(), '.mara-vendor', 'private-key.pem');

const args = process.argv.slice(2);
const daysIndex = args.indexOf('--days');
let days = null;
if (daysIndex >= 0) {
  days = Number(args[daysIndex + 1]);
  args.splice(daysIndex, 2);
}

const rawCode = args[0];
const customer = args[1] || '';

if (!rawCode) {
  console.error('\n  الاستعمال:  node tools/make-license.js <رمز-الجهاز> "<اسم العميل>" [--days 365]\n');
  process.exit(1);
}

// العميل يقرأ الرمز بشرطات وحروف كبيرة — نقبله كما أرسله
const fingerprint = rawCode.replace(/[^0-9a-fA-F]/g, '').toLowerCase();
if (fingerprint.length !== 16) {
  console.error(`\n  ⚠️  رمز الجهاز يجب أن يكون 16 خانة (16 hex). وصلني ${fingerprint.length}.`);
  console.error('      اطلب من العميل رمز الجهاز كما يظهر في شاشة التفعيل.\n');
  process.exit(1);
}

if (!fs.existsSync(PRIVATE_FILE)) {
  console.error(`\n  ⚠️  لا يوجد مفتاح خاص في:\n      ${PRIVATE_FILE}`);
  console.error('\n  ولّده أولًا:  node tools/make-keys.js\n');
  process.exit(1);
}

if (days !== null && (!Number.isFinite(days) || days <= 0)) {
  console.error('\n  ⚠️  --days يجب أن يكون عددًا موجبًا.\n');
  process.exit(1);
}

const payload = {
  fp: fingerprint,
  customer: String(customer).slice(0, 80),
  issuedAt: Date.now(),
  expiresAt: days ? Date.now() + days * 86400000 : null,
  id: crypto.randomBytes(6).toString('hex')
};

const privateKey = crypto.createPrivateKey(fs.readFileSync(PRIVATE_FILE));
const body = Buffer.from(JSON.stringify(payload), 'utf8');
const signature = crypto.sign(null, body, privateKey);
const token = `${body.toString('base64url')}.${signature.toString('base64url')}`;

console.log('\n  ✅ صدر الترخيص\n');
console.log(`  الجهاز   : ${(fingerprint.match(/.{1,4}/g) || []).join('-').toUpperCase()}`);
console.log(`  العميل   : ${payload.customer || '—'}`);
console.log(`  الصلاحية : ${payload.expiresAt ? new Date(payload.expiresAt).toLocaleDateString('ar') : 'دائم'}`);
console.log(`  الرقم    : ${payload.id}`);
console.log('\n  ─── أرسل السطر التالي للعميل ليلصقه في شاشة التفعيل ───\n');
console.log(token);
console.log('');
