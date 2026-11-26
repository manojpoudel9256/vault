// Generates the app icons as PNG files with no dependencies.
// Logo: a speech bubble with a keyhole cut out ("ask your vault"). Same geometry as
// public/icons/logo.svg and appLogo() in src/icons.ts (100 x 100 units).
import { deflateSync, crc32 } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';

const BG = [12, 14, 17], FG = [95, 224, 196];

// Bubble body: rounded rectangle 20..80 x 22..70, corner radius 14.
function inBody(x, y) {
  const x0 = 20, x1 = 80, y0 = 22, y1 = 70, r = 14;
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r), cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}
// Tail: triangle (36,69) (31,84) (50,69).
function inTail(x, y) {
  const [ax, ay, bx, by, cx, cy] = [36, 69, 31, 84, 50, 69];
  const d = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
  const u = ((bx - x) * (cy - y) - (cx - x) * (by - y)) / d;
  const v = ((cx - x) * (ay - y) - (ax - x) * (cy - y)) / d;
  return u >= 0 && v >= 0 && u + v <= 1;
}
// Keyhole: circle (50,42) r 8, stem widening from 4.2 to 5.5 half-width down to y 61.
function inKeyhole(x, y) {
  if ((x - 50) ** 2 + (y - 42) ** 2 <= 64) return true;
  if (y < 42 || y > 61) return false;
  const half = 4.2 + Math.max(0, y - 48.8) * (1.3 / 12.2);
  return Math.abs(x - 50) <= half;
}
const inLogo = (x, y) => (inBody(x, y) || inTail(x, y)) && !inKeyhole(x, y);

function png(size) {
  const row = size * 4 + 1, raw = Buffer.alloc(row * size), S = 4;
  for (let y = 0; y < size; y++) {
    raw[y * row] = 0;
    for (let x = 0; x < size; x++) {
      let hit = 0;
      for (let sy = 0; sy < S; sy++) for (let sx = 0; sx < S; sx++)
        if (inLogo(((x + (sx + 0.5) / S) / size) * 100, ((y + (sy + 0.5) / S) / size) * 100)) hit++;
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

export const LOGO_PATH = 'M34 22H66A14 14 0 0 1 80 36V56A14 14 0 0 1 66 70H50L31 84L36 70H34A14 14 0 0 1 20 56V36A14 14 0 0 1 34 22Z'
  + 'M45.8 48.8A8 8 0 1 1 54.2 48.8L55.5 61H44.5Z';

mkdirSync('public/icons', { recursive: true });
for (const [name, size] of [['icon-192.png', 192], ['icon-512.png', 512], ['apple-touch-icon.png', 180]])
  writeFileSync(`public/icons/${name}`, png(size));
writeFileSync('public/icons/logo.svg',
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" rx="22" fill="#0c0e11"/><path fill="#5fe0c4" fill-rule="evenodd" d="${LOGO_PATH}"/></svg>\n`);
console.log('icons written');
