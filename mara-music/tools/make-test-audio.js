'use strict';

/**
 * يولّد ملفات MP3 صامتة صالحة للاختبار المحلي فقط (بدون أي مكتبات).
 * التشغيل:  node tools/make-test-audio.js <المجلد> [عدد الملفات]
 */

const fs = require('fs');
const path = require('path');

const FRAME_BYTES = 417; // MPEG-1 Layer III, 128kbps, 44.1kHz
const FRAME_SECONDS = 1152 / 44100;

function makeMp3(seconds) {
  const frames = Math.max(1, Math.round(seconds / FRAME_SECONDS));
  const buf = Buffer.alloc(frames * FRAME_BYTES);
  for (let i = 0; i < frames; i += 1) {
    const off = i * FRAME_BYTES;
    buf[off] = 0xff;
    buf[off + 1] = 0xfb;
    buf[off + 2] = 0x90;
    buf[off + 3] = 0x40;
  }
  return buf;
}

const dir = process.argv[2] || path.join(__dirname, '..', 'test-audio');
const count = Number(process.argv[3]) || 6;
fs.mkdirSync(dir, { recursive: true });

for (let i = 1; i <= count; i += 1) {
  const seconds = 20 + i * 5;
  fs.writeFileSync(path.join(dir, `أغنية تجريبية ${i}.mp3`), makeMp3(seconds));
}
console.log(`أُنشئت ${count} ملفات اختبار في ${dir}`);
