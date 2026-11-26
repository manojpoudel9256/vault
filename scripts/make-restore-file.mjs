// Makes an encrypted MEMO Vault restore file from entries given on stdin (JSON array).
// The file is encrypted exactly like the app's own backups (AES-256-GCM, PBKDF2-SHA256 600k)
// with a ONE-TIME passphrase that is printed once. Plain values are never written to disk.
//
// Usage:  node scripts/make-restore-file.mjs <output.json> < entries.json
// Entry:  { category, service, account?, type, secret, notes?, tags?, history?: string[] (older values, newest first) }

import { webcrypto as crypto } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const out = process.argv[2];
if (!out) { console.error('Give an output file path.'); process.exit(1); }

const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const input = JSON.parse(Buffer.concat(chunks).toString('utf8').replace(/^﻿/, ''));

const CATS = ['login', 'bank', 'card', 'id', 'phone', 'address', 'wifi', 'note'];
const TYPES = { login: ['password'], bank: ['pin', 'password', 'number'], card: ['number', 'pin'], id: ['text'], phone: ['number'], address: ['text'], wifi: ['password'], note: ['text'] };
const now = Date.now();
const uid = () => Array.from(crypto.getRandomValues(new Uint8Array(9)), (b) => b.toString(36).padStart(2, '0')).join('');

const entries = input.map((e, i) => {
  if (!CATS.includes(e.category)) throw new Error(`Entry ${i + 1}: unknown category ${e.category}`);
  if (!e.service || !e.secret) throw new Error(`Entry ${i + 1}: needs a name and a value`);
  const type = TYPES[e.category].includes(e.type) ? e.type : TYPES[e.category][0];
  if (type === 'pin' && !/^\d{3,12}$/.test(e.secret)) throw new Error(`Entry ${i + 1}: a PIN must be digits`);
  return {
    id: uid(), category: e.category, service: String(e.service).trim(), account: String(e.account ?? '').trim(),
    type, secret: String(e.secret), notes: String(e.notes ?? '').trim(), tags: (e.tags ?? []).map(String),
    // Older values (newest first) become the entry's password history.
    history: (e.history ?? []).map((v, j) => ({ value: String(v), changedAt: now - (j + 1) * 86_400_000 })),
    createdAt: now, updatedAt: now,
  };
});

// One-time passphrase: 5 groups of 4 characters from an unambiguous alphabet (about 100 bits).
const ALPHA = 'abcdefghjkmnpqrstuvwxyz23456789';
const pick = () => { let n; do { n = crypto.getRandomValues(new Uint8Array(1))[0]; } while (n >= 248); return ALPHA[n % ALPHA.length]; };
// VAULT_PASSPHRASE lets you choose it (used for the public demo file); otherwise a random one is made.
const passphrase = process.env.VAULT_PASSPHRASE || Array.from({ length: 5 }, () => Array.from({ length: 4 }, pick).join('')).join('-');

const enc = new TextEncoder();
const b64 = (u8) => Buffer.from(u8).toString('base64');
const salt = crypto.getRandomValues(new Uint8Array(16));
const iterations = 600_000;
const base = await crypto.subtle.importKey('raw', enc.encode(passphrase.normalize('NFKC')), 'PBKDF2', false, ['deriveKey']);
const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
const vault = {
  version: 1,
  entries,
  settings: { autoLockMinutes: 2, lastBackupAt: null, geminiEnabled: false, geminiKey: '', geminiModel: 'gemini-2.5-flash', geminiShareAccounts: false },
};
const iv = crypto.getRandomValues(new Uint8Array(12));
const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode('memo-vault:v1') }, key, enc.encode(JSON.stringify(vault)));

writeFileSync(out, JSON.stringify({
  format: 'memo-vault-backup', version: 1, createdAt: now,
  kdf: { name: 'PBKDF2-SHA256', salt: b64(salt), iterations },
  vault: { iv: b64(iv), ct: b64(new Uint8Array(ct)) },
}));

const counts = {};
for (const e of entries) counts[e.category] = (counts[e.category] ?? 0) + 1;
console.log(`Wrote ${entries.length} entries to ${out}`);
console.log('By category:', JSON.stringify(counts));
console.log(`ONE-TIME PASSPHRASE: ${passphrase}`);
