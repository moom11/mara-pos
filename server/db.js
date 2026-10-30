// قاعدة البيانات الدائمة (SQLite) — ملف واحد داخل مجلد data
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('gate', 'manager')),
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  expires_ts INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS materials (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS trucks (
  id INTEGER PRIMARY KEY,
  plate TEXT NOT NULL,
  plate_norm TEXT NOT NULL UNIQUE,
  driver TEXT NOT NULL DEFAULT '',
  driver_phone TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
-- كل عملية خروج = رد واحد. الأسماء والأسعار محفوظة داخل العملية نفسها
-- حتى لا تتغير السجلات السابقة عند تعديل البيانات الأساسية
CREATE TABLE IF NOT EXISTS trips (
  id INTEGER PRIMARY KEY,
  no INTEGER NOT NULL UNIQUE,
  request_id TEXT UNIQUE,
  ts INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  date TEXT NOT NULL,
  truck_id INTEGER REFERENCES trucks(id),
  plate TEXT NOT NULL,
  plate_norm TEXT NOT NULL,
  driver TEXT NOT NULL DEFAULT '',
  truck_type TEXT NOT NULL DEFAULT '',
  customer_id INTEGER REFERENCES customers(id),
  customer_name TEXT NOT NULL DEFAULT '',
  material_id INTEGER REFERENCES materials(id),
  material_name TEXT NOT NULL,
  price REAL NOT NULL,
  paid REAL NOT NULL,
  remaining REAL NOT NULL,
  method TEXT NOT NULL CHECK (method IN ('cash', 'transfer', 'credit')),
  notes TEXT NOT NULL DEFAULT '',
  user_id INTEGER REFERENCES users(id),
  user_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cancelled')),
  cancel_reason TEXT,
  cancelled_by TEXT,
  cancelled_at TEXT,
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS trips_date ON trips(date);
CREATE INDEX IF NOT EXISTS trips_plate ON trips(plate_norm, ts);
CREATE INDEX IF NOT EXISTS trips_customer ON trips(customer_id);
-- دفعات لاحقة لتسديد رصيد العميل (ليست مبيعات)
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY,
  no INTEGER NOT NULL UNIQUE,
  request_id TEXT UNIQUE,
  ts INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  date TEXT NOT NULL,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  customer_name TEXT NOT NULL,
  amount REAL NOT NULL,
  method TEXT NOT NULL CHECK (method IN ('cash', 'transfer')),
  notes TEXT NOT NULL DEFAULT '',
  user_id INTEGER REFERENCES users(id),
  user_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cancelled')),
  cancel_reason TEXT,
  cancelled_by TEXT,
  cancelled_at TEXT
);
CREATE INDEX IF NOT EXISTS payments_customer ON payments(customer_id);
CREATE INDEX IF NOT EXISTS payments_date ON payments(date);
-- سجل التغييرات
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  user_id INTEGER,
  user_name TEXT NOT NULL,
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id INTEGER,
  summary TEXT NOT NULL DEFAULT '',
  before TEXT,
  after TEXT,
  reason TEXT
);
CREATE TABLE IF NOT EXISTS assets (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT '',
  identifier TEXT NOT NULL DEFAULT '',
  purchase_date TEXT,
  cost REAL NOT NULL DEFAULT 0,
  life_years REAL NOT NULL DEFAULT 0,
  salvage REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  location TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT ''
);
`;

const DEFAULT_SETTINGS = {
  companyName: 'شركة متعب',
  city: 'المدينة المنورة',
  phone: '+966 54 646 1965',
  currency: 'ريال',
  voucherTitle: 'قسيمة ذات رد واحد فقط',
  voucherSize: 'a5',
  duplicateMinutes: '15',
  logo: '',
};

const pad = (n) => String(n).padStart(2, '0');
function localDateTime(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
const localDate = (d = new Date()) => localDateTime(d).slice(0, 10);

// توحيد رقم اللوحة للمقارنة: إزالة المسافات والرموز وتحويل الأرقام العربية
function normPlate(p) {
  return String(p || '')
    .replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d))
    .replace(/[\s\-_.|/]/g, '')
    .toUpperCase();
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function checkPassword(password, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const test = crypto.scryptSync(String(password), salt, 64);
  return crypto.timingSafeEqual(test, Buffer.from(hash, 'hex'));
}

function open(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);

  const insSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) insSetting.run(k, v);
  db.prepare("INSERT OR IGNORE INTO counters (name, value) VALUES ('trip', 0), ('payment', 0)").run();
  if (!db.prepare('SELECT COUNT(*) c FROM materials').get().c) {
    const ins = db.prepare('INSERT INTO materials (name, sort) VALUES (?, ?)');
    ins.run('دفان', 1);
    ins.run('سبيس', 2);
  }
  return db;
}

function nextNumber(db, name) {
  db.prepare('UPDATE counters SET value = value + 1 WHERE name = ?').run(name);
  return db.prepare('SELECT value FROM counters WHERE name = ?').get(name).value;
}

function getSettings(db) {
  const out = { ...DEFAULT_SETTINGS };
  for (const r of db.prepare('SELECT key, value FROM settings').all()) out[r.key] = r.value;
  out.duplicateMinutes = Number(out.duplicateMinutes) || 0;
  return out;
}

module.exports = { open, nextNumber, getSettings, normPlate, hashPassword, checkPassword, localDateTime, localDate, DEFAULT_SETTINGS };
