'use strict';

const crypto = require('crypto');
const { readJSON, writeJSON } = require('./store');

const TOKEN_TTL_MS = 120 * 24 * 60 * 60 * 1000; // 120 يومًا
const MAX_ATTEMPTS = 8;
const LOCKOUT_MS = 5 * 60 * 1000;

class Auth {
  constructor(getSettings) {
    this.getSettings = getSettings;
    this.tokens = new Map();
    this.attempts = new Map(); // ip -> {count, until}
    // رمز داخلي لنافذة المشغّل حتى تستطيع بثّ الملفات الصوتية محليًا
    this.internalToken = crypto.randomBytes(24).toString('hex');
  }

  load() {
    const saved = readJSON('tokens', { tokens: [] });
    const now = Date.now();
    for (const t of saved.tokens || []) {
      if (t && t.token && now - t.createdAt < TOKEN_TTL_MS) this.tokens.set(t.token, t);
    }
  }

  persist() {
    writeJSON('tokens', { tokens: [...this.tokens.values()] });
  }

  login(pin, { device = '', ip = '' } = {}) {
    const lock = this.attempts.get(ip);
    if (lock && lock.until > Date.now()) {
      return { ok: false, error: 'محاولات كثيرة — انتظر قليلًا ثم أعد المحاولة', lockedMs: lock.until - Date.now() };
    }

    const settings = this.getSettings();
    const clean = String(pin || '').trim();
    let role = null;
    if (clean && settings.adminPin && safeEqual(clean, String(settings.adminPin))) role = 'admin';
    else if (clean && settings.staffPin && safeEqual(clean, String(settings.staffPin))) role = 'staff';

    if (!role) {
      const entry = this.attempts.get(ip) || { count: 0, until: 0 };
      entry.count += 1;
      if (entry.count >= MAX_ATTEMPTS) {
        entry.until = Date.now() + LOCKOUT_MS;
        entry.count = 0;
      }
      this.attempts.set(ip, entry);
      return { ok: false, error: 'الرمز غير صحيح' };
    }

    this.attempts.delete(ip);
    const token = crypto.randomBytes(24).toString('hex');
    const record = {
      token,
      role,
      device: String(device || '').slice(0, 60),
      ip,
      createdAt: Date.now(),
      lastSeen: Date.now()
    };
    this.tokens.set(token, record);
    this.persist();
    return { ok: true, token, role };
  }

  verify(token) {
    if (!token) return null;
    if (token === this.internalToken) return { role: 'internal' };
    const record = this.tokens.get(token);
    if (!record) return null;
    if (Date.now() - record.createdAt > TOKEN_TTL_MS) {
      this.tokens.delete(token);
      return null;
    }
    record.lastSeen = Date.now();
    return record;
  }

  logout(token) {
    if (this.tokens.delete(token)) this.persist();
  }

  /** إبطال كل الأجهزة (مفيد لو ضاع جوال موظف). */
  revokeAll({ keepToken = null } = {}) {
    for (const token of [...this.tokens.keys()]) {
      if (token !== keepToken) this.tokens.delete(token);
    }
    this.persist();
  }

  devices() {
    return [...this.tokens.values()].map((t) => ({
      token: `${t.token.slice(0, 6)}…`,
      fullToken: t.token,
      role: t.role,
      device: t.device,
      ip: t.ip,
      createdAt: t.createdAt,
      lastSeen: t.lastSeen
    }));
  }

  static generatePin(digits = 6) {
    let pin = '';
    while (pin.length < digits) {
      pin += String(crypto.randomInt(0, 10));
    }
    return pin;
  }
}

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

module.exports = { Auth };
