import { defineConfig, type Plugin } from 'vite';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

// Same security headers as production (vercel.json), applied to `npm run preview`
// so the Content-Security-Policy can be tested locally.
const vercel = JSON.parse(readFileSync(new URL('./vercel.json', import.meta.url), 'utf8'));
const previewHeaders: Record<string, string> = {};
for (const h of vercel.headers[0].headers) previewHeaders[h.key] = h.value;
// upgrade-insecure-requests breaks plain-http local preview
previewHeaders['Content-Security-Policy'] = previewHeaders['Content-Security-Policy'].replace('; upgrade-insecure-requests', '');
delete previewHeaders['Strict-Transport-Security'];

// Emits /sw.js with the list of built files, so the app works offline after the first visit.
function serviceWorker(): Plugin {
  return {
    name: 'memo-vault-sw',
    apply: 'build',
    generateBundle(_opts, bundle) {
      const files = Object.keys(bundle).map((f) => '/' + f);
      const precache = ['/', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/apple-touch-icon.png', ...files];
      const version = createHash('sha256').update(precache.join('|')).digest('hex').slice(0, 12);
      const src = readFileSync(new URL('./sw/sw.js', import.meta.url), 'utf8')
        .replace('__PRECACHE__', JSON.stringify(precache))
        .replace('__VERSION__', version);
      this.emitFile({ type: 'asset', fileName: 'sw.js', source: src });
    },
  };
}

export default defineConfig({
  plugins: [serviceWorker()],
  build: { target: 'es2022', sourcemap: false, assetsInlineLimit: 0 },
  preview: { headers: previewHeaders },
});
