'use strict';

const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const { readJSON, writeJSON } = require('./store');
const { VENDOR_PUBLIC_KEY } = require('./license-key');

const TRIAL_DAYS = 14;

/**
 * ترخيص مرتبط بالجهاز.
 *
 * الفكرة: البرنامج يحمل المفتاح **العام** فقط. الترخيص ملف موقّع بالمفتاح
 * **الخاص** الذي يبقى عندك وحدك، فلا يستطيع مشترٍ توليد ترخيص لجهاز آخر
 * مهما فتح ملفات البرنامج — لا يوجد داخلها ما يوقّع.
 *
 * حدّ أقوله صراحة: أي حماية تعمل على جهاز المشتري يمكن تجاوزها بمن يملك
 * المهارة والوقت — البرنامج في يده. هذا يوقف النسخ العابر (فرع ثانٍ،
 * صديق يطلب نسخة)، وهو التهديد الواقعي، لا المحترف المصمِّم على كسرها.
 */
class License {
  constructor({ fingerprint = null, publicKey = VENDOR_PUBLIC_KEY } = {}) {
    this.overrideFingerprint = fingerprint;
    this.publicKey = publicKey;
    this.data = null;
    this.cachedFingerprint = null;
  }

  /** نظام التراخيص مطفأ ما لم يُولَّد مفتاح للبائع. */
  get enforced() {
    return !!this.publicKey;
  }

  load() {
    this.data = readJSON('license', null) || {};
    if (!this.data.firstRunAt) {
      this.data.firstRunAt = Date.now();
      this.persist();
    }
    const status = this.status();
    console.log(`[license] ${this.enforced ? status.state : 'غير مفعّل'} — رمز الجهاز ${this.displayCode}`);
    return status;
  }

  persist() {
    writeJSON('license', this.data);
  }

  // ------------------------------------------------------------ بصمة الجهاز

  /**
   * بصمة ثابتة للجهاز. على ويندوز نعتمد MachineGuid لأنه يبقى عبر إعادة
   * التشغيل وتغيير اسم الجهاز والشبكة، ويتغيّر بإعادة تثبيت النظام.
   */
  get fingerprint() {
    if (this.overrideFingerprint) return this.overrideFingerprint;
    if (this.cachedFingerprint) return this.cachedFingerprint;

    const parts = [];
    if (process.platform === 'win32') {
      try {
        const out = execFileSync(
          'reg',
          ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid', '/reg:64'],
          { encoding: 'utf8', timeout: 5000, windowsHide: true }
        );
        const match = /MachineGuid\s+REG_SZ\s+([0-9a-fA-F-]+)/.exec(out);
        if (match) parts.push(match[1].toLowerCase());
      } catch (err) {
        console.warn('[license] تعذّرت قراءة معرّف الجهاز:', err.message);
      }
    }

    if (!parts.length) {
      // احتياطي: عناوين الشبكة الثابتة مرتّبة حتى لا تتغيّر البصمة بترتيبها
      const macs = [];
      for (const list of Object.values(os.networkInterfaces())) {
        for (const addr of list || []) {
          if (!addr.internal && addr.mac && addr.mac !== '00:00:00:00:00:00') macs.push(addr.mac);
        }
      }
      parts.push(os.platform(), os.arch(), ...macs.sort());
    }

    this.cachedFingerprint = crypto.createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 16);
    return this.cachedFingerprint;
  }

  /** الشكل الذي يقرأه العميل ويرسله لك: AAAA-BBBB-CCCC-DDDD */
  get displayCode() {
    return (this.fingerprint.match(/.{1,4}/g) || []).join('-').toUpperCase();
  }

  // --------------------------------------------------------------- التحقّق

  verifyToken(token) {
    if (!this.publicKey) return { ok: false, error: 'نظام التراخيص غير مفعّل' };
    const raw = String(token || '').trim().replace(/\s+/g, '');
    const dot = raw.indexOf('.');
    if (dot < 1) return { ok: false, error: 'صيغة الترخيص غير صحيحة' };

    let payload;
    try {
      const body = Buffer.from(raw.slice(0, dot), 'base64url');
      const signature = Buffer.from(raw.slice(dot + 1), 'base64url');
      const key = crypto.createPublicKey(this.publicKey);
      if (!crypto.verify(null, body, key, signature)) {
        return { ok: false, error: 'الترخيص غير صالح أو مُعدَّل' };
      }
      payload = JSON.parse(body.toString('utf8'));
    } catch (err) {
      return { ok: false, error: 'تعذّرت قراءة الترخيص' };
    }

    if (payload.fp !== this.fingerprint) {
      return { ok: false, error: 'هذا الترخيص صادر لجهاز آخر' };
    }
    if (payload.expiresAt && Date.now() > payload.expiresAt) {
      return { ok: false, error: 'انتهت صلاحية الترخيص' };
    }
    return { ok: true, payload };
  }

  activate(token) {
    const result = this.verifyToken(token);
    if (!result.ok) return result;
    this.data.token = String(token).trim().replace(/\s+/g, '');
    this.persist();
    console.log(`[license] فُعِّل الترخيص للعميل: ${result.payload.customer || 'بلا اسم'}`);
    return { ok: true, payload: result.payload };
  }

  deactivate() {
    delete this.data.token;
    this.persist();
  }

  // ---------------------------------------------------------------- الحالة

  trialEndsAt() {
    return (this.data?.firstRunAt || Date.now()) + TRIAL_DAYS * 86400000;
  }

  status() {
    const base = {
      fingerprint: this.fingerprint,
      code: this.displayCode,
      enforced: this.enforced,
      trialDays: TRIAL_DAYS
    };
    if (!this.enforced) return { ...base, state: 'off', allowed: true };

    if (this.data && this.data.token) {
      const result = this.verifyToken(this.data.token);
      if (result.ok) {
        return {
          ...base,
          state: 'licensed',
          allowed: true,
          customer: result.payload.customer || '',
          expiresAt: result.payload.expiresAt || null
        };
      }
      return { ...base, state: 'invalid', allowed: false, error: result.error };
    }

    const endsAt = this.trialEndsAt();
    if (Date.now() < endsAt) {
      return {
        ...base,
        state: 'trial',
        allowed: true,
        trialEndsAt: endsAt,
        daysLeft: Math.max(0, Math.ceil((endsAt - Date.now()) / 86400000))
      };
    }
    return { ...base, state: 'expired', allowed: false, trialEndsAt: endsAt };
  }

  allowsPlayback() {
    return this.status().allowed;
  }
}

module.exports = { License, TRIAL_DAYS };
