'use strict';

/**
 * يولّد أيقونات PNG للتطبيق بدون أي مكتبات خارجية.
 * التشغيل:  node tools/make-icons.js
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const GOLD = [201, 162, 39, 255];
const INK = [20, 16, 10, 255];

function drawIcon(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const SS = 3; // عيّنات فرعية لتنعيم الحواف

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let inked = 0;
      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const px = (x + (sx + 0.5) / SS) / size;
          const py = (y + (sy + 0.5) / SS) / size;
          if (isNote(px, py)) inked += 1;
        }
      }
      const alpha = inked / (SS * SS);
      const offset = (y * size + x) * 4;
      for (let c = 0; c < 3; c += 1) {
        pixels[offset + c] = Math.round(GOLD[c] * (1 - alpha) + INK[c] * alpha);
      }
      pixels[offset + 3] = 255;
    }
  }
  return pixels;
}

/** إحداثيات معيارية 0..1 — نوتة موسيقية بسيطة. */
function isNote(x, y) {
  // رأس النوتة
  const hx = (x - 0.44) / 0.15;
  const hy = (y - 0.70) / 0.115;
  if (hx * hx + hy * hy <= 1) return true;

  // الساق
  if (x >= 0.565 && x <= 0.625 && y >= 0.24 && y <= 0.71) return true;

  // العلم (شريط مائل)
  if (y >= 0.24 && y <= 0.42) {
    const t = (y - 0.24) / 0.18;
    const left = 0.625 - 0.02 * t;
    const right = left + 0.16 - 0.05 * t;
    if (x >= left && x <= right) return true;
  }
  return false;
}

// ------------------------------------------------------------ ترميز PNG

function crc32(buf) {
  let c;
  const table = crc32.table || (crc32.table = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
      c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })());
  let crc = -1;
  for (let i = 0; i < buf.length; i += 1) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([length, typeBuf, data, crcBuf]);
}

function encodePNG(size, pixels) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // عمق البت
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0; // نوع المرشّح: بدون
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

// ------------------------------------------------------------------ التنفيذ

/** ملف ICO لويندوز: ترويسة + مدخل واحد + صورة PNG مضمّنة (مدعوم منذ Vista). */
function encodeICO(size, pngBuffer) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // محجوز
  header.writeUInt16LE(1, 2); // النوع: أيقونة
  header.writeUInt16LE(1, 4); // عدد الصور

  const entry = Buffer.alloc(16);
  entry[0] = size >= 256 ? 0 : size; // 0 تعني 256
  entry[1] = size >= 256 ? 0 : size;
  entry[2] = 0; // عدد الألوان
  entry[3] = 0; // محجوز
  entry.writeUInt16LE(1, 4); // عدد الطبقات
  entry.writeUInt16LE(32, 6); // بت لكل بكسل
  entry.writeUInt32LE(pngBuffer.length, 8);
  entry.writeUInt32LE(header.length + entry.length, 12);

  return Buffer.concat([header, entry, pngBuffer]);
}

const targets = [
  { size: 192, file: path.join(__dirname, '..', 'src', 'web', 'icons', 'icon-192.png') },
  { size: 512, file: path.join(__dirname, '..', 'src', 'web', 'icons', 'icon-512.png') },
  { size: 256, file: path.join(__dirname, '..', 'src', 'assets', 'icon.png') }
];

for (const target of targets) {
  fs.mkdirSync(path.dirname(target.file), { recursive: true });
  fs.writeFileSync(target.file, encodePNG(target.size, drawIcon(target.size)));
  console.log(`أُنشئت ${path.relative(process.cwd(), target.file)} (${target.size}px)`);
}

// أيقونة ويندوز لاختصارات سطح المكتب
const icoFile = path.join(__dirname, '..', 'src', 'assets', 'icon.ico');
fs.writeFileSync(icoFile, encodeICO(256, encodePNG(256, drawIcon(256))));
console.log(`أُنشئت ${path.relative(process.cwd(), icoFile)} (256px, ICO)`);
