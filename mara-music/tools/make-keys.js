'use strict';

/**
 * يولّد مفتاحَي البائع مرة واحدة فقط.
 *
 *   node tools/make-keys.js
 *
 * - المفتاح **العام** يُكتب داخل المشروع (src/main/license-key.js) ويُشحن
 *   مع كل نسخة. وظيفته التحقّق فقط — لا يستطيع صنع ترخيص.
 * - المفتاح **الخاص** يُحفظ في مجلد المستخدم خارج المستودع. هو وحده الذي
 *   يوقّع التراخيص. من يملكه يستطيع ترخيص أي جهاز، فاحتفظ به كما تحتفظ
 *   بمفاتيح المحل: نسخة احتياطية في مكان آمن، ولا يُرسل لأحد أبدًا.
 *
 * تشغيله مرة ثانية يُبطل كل التراخيص التي أصدرتها — لذلك يرفض الكتابة فوق
 * مفتاح قائم إلا بـ --force.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const KEY_DIR = path.join(os.homedir(), '.mara-vendor');
const PRIVATE_FILE = path.join(KEY_DIR, 'private-key.pem');
const PUBLIC_MODULE = path.join(__dirname, '..', 'src', 'main', 'license-key.js');

const force = process.argv.includes('--force');

if (fs.existsSync(PRIVATE_FILE) && !force) {
  console.error('\n  ⚠️  يوجد مفتاح خاص بالفعل:');
  console.error(`      ${PRIVATE_FILE}`);
  console.error('\n  توليد مفتاح جديد يُبطل كل التراخيص التي أصدرتها سابقًا،');
  console.error('  وسيتوقف البرنامج عند كل عميل حتى ترسل له ترخيصًا جديدًا.');
  console.error('\n  إن كنت متأكدًا:  node tools/make-keys.js --force\n');
  process.exit(1);
}

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');

const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' });
const publicPem = publicKey.export({ type: 'spki', format: 'pem' });

fs.mkdirSync(KEY_DIR, { recursive: true });
fs.writeFileSync(PRIVATE_FILE, privatePem, { mode: 0o600 });

const moduleSource = `'use strict';

/**
 * المفتاح العام للبائع — يتحقّق من التراخيص ولا يستطيع صنعها.
 * وُلِّد في ${new Date().toISOString()} بـ  node tools/make-keys.js
 *
 * المفتاح الخاص المقابل له محفوظ خارج المستودع، وهو وحده الذي يوقّع.
 * لتعطيل نظام التراخيص: اجعل القيمة نصًّا فارغًا.
 */
const VENDOR_PUBLIC_KEY = ${JSON.stringify(publicPem)};

module.exports = { VENDOR_PUBLIC_KEY };
`;
fs.writeFileSync(PUBLIC_MODULE, moduleSource, 'utf8');

console.log('\n  ✅ وُلِّد مفتاحا البائع.\n');
console.log(`  المفتاح الخاص (احتفظ به ولا ترسله):\n      ${PRIVATE_FILE}\n`);
console.log(`  المفتاح العام (داخل البرنامج):\n      ${path.relative(process.cwd(), PUBLIC_MODULE)}\n`);
console.log('  نظام التراخيص صار مفعّلًا. أعد بناء ملف التثبيت ليأخذ المفتاح:');
console.log('      npm run dist\n');
console.log('  ⚠️  خذ نسخة احتياطية من المفتاح الخاص الآن — فقدانه يعني');
console.log('      أنك لن تستطيع إصدار تراخيص جديدة أبدًا.\n');
