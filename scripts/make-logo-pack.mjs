// Builds a private logo pack for Vault: Settings > Private logos > Import logo pack.
//
//   node scripts/make-logo-pack.mjs [folder]      (default folder: private-logos)
//
// The folder (git-ignored) holds logos.json and the image files it names:
//   [{ "name": "mybank", "match": "my ?bank", "file": "mybank.png", "full": false, "bg": "#ffffff" }]
//   match = case-insensitive pattern tested against the entry's service name
//   full  = the icon is already a filled square (shown edge to edge); otherwise it sits on bg
// Each image is resized to 96x96 PNG with ffmpeg (must be on PATH) and embedded in
// <folder>/vault-logos.json. Copy that file to the iPhone (iCloud Drive or Files) and import it.
// The logos are then stored encrypted inside the vault, never in the website's code.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const dir = resolve(process.argv[2] ?? 'private-logos');
const list = JSON.parse(readFileSync(join(dir, 'logos.json'), 'utf8'));
const tmp = mkdtempSync(join(tmpdir(), 'vault-logos-'));

/** ICO files hold several sizes as separate streams: use the largest. */
function largestStream(file) {
  const out = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v', '-show_entries', 'stream=index,width', '-of', 'csv=p=0', file], { encoding: 'utf8' });
  const streams = out.trim().split(/\r?\n/).map((l) => l.split(',').map(Number));
  return streams.sort((a, b) => b[1] - a[1])[0][0];
}

const logos = [];
try {
  for (const l of list) {
    const input = join(dir, l.file);
    const png = join(tmp, `${l.name}.png`);
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', input, '-map', `0:${largestStream(input)}`, '-frames:v', '1',
      '-vf', 'scale=96:96:force_original_aspect_ratio=decrease:flags=lanczos,format=rgba,pad=96:96:(ow-iw)/2:(oh-ih)/2:color=0x00000000',
      png]);
    const img = 'data:image/png;base64,' + readFileSync(png).toString('base64');
    new RegExp(l.match, 'i'); // fail early on a broken pattern
    logos.push({ name: l.name, match: l.match, img, full: !!l.full, bg: l.bg ?? '#ffffff' });
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

const outFile = join(dir, 'vault-logos.json');
writeFileSync(outFile, JSON.stringify({ format: 'memo-vault-logos', version: 1, logos }));
console.log(`${logos.length} logos -> ${outFile} (${Math.round(readFileSync(outFile).length / 1024)} KB)`);
