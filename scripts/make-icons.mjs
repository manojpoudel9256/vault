// Generates the app icons (a padlock) as PNG files with no dependencies.
import { deflateSync, crc32 } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';

const BG = [12, 14, 17], FG = [95, 224, 196];

function inLock(x, y) {
  // x, y in 0..1
  const bx0 = 0.29, bx1 = 0.71, by0 = 0.44, by1 = 0.78, r = 0.06;
  const cx = Math.min(Math.max(x, bx0 + r), bx1 - r), cy = Math.min(Math.max(y, by0 + r), by1 - r);
  const inBody = x >= bx0 && x <= bx1 && y >= by0 && y <= by1 && (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
  const d = Math.hypot(x - 0.5, y - 0.44);
  const inShackle = y <= 0.46 && d <= 0.155 && d >= 0.1;
  const keyHole = Math.hypot(x - 0.5, y - 0.585) <= 0.038 || (Math.abs(x - 0.5) <= 0.016 && y >= 0.585 && y <= 0.68);
  return (inBody && !keyHole) || inShackle;
}

function png(size) {
  const row = size * 4 + 1, raw = Buffer.alloc(row * size), S = 4;
  for (let y = 0; y < size; y++) {
    raw[y * row] = 0;
    for (let x = 0; x < size; x++) {
      let hit = 0;
      for (let sy = 0; sy < S; sy++) for (let sx = 0; sx < S; sx++)
        if (inLock((x + (sx + 0.5) / S) / size, (y + (sy + 0.5) / S) / size)) hit++;
      const t = hit / (S * S), o = y * row + 1 + x * 4;
      for (let c = 0; c < 3; c++) raw[o + c] = Math.round(BG[c] * (1 - t) + FG[c] * t);
      raw[o + 3] = 255;
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

mkdirSync('public/icons', { recursive: true });
for (const [name, size] of [['icon-192.png', 192], ['icon-512.png', 512], ['apple-touch-icon.png', 180]])
  writeFileSync(`public/icons/${name}`, png(size));
console.log('icons written');
