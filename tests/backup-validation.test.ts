// M-2: crafted backup files are refused before any key derivation. Runs with: npm test
import 'fake-indexeddb/auto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveKey, randomBytes, seal, toB64 } from '../src/crypto';
import { createVault, destroyVault, makeBackup, openBackup, parseBackup, MAX_ITERATIONS, MIN_ITERATIONS } from '../src/vault';

async function realBackup(): Promise<Record<string, any>> {
  await destroyVault();
  await createVault('backup-pass-123');
  const f = JSON.parse(await makeBackup());
  await destroyVault();
  return f;
}
const edit = (f: Record<string, any>, change: (c: any) => void) => { const c = structuredClone(f); change(c); return JSON.stringify(c); };

test('a real backup made by the app is accepted', async () => {
  const f = await realBackup();
  assert.doesNotThrow(() => parseBackup(JSON.stringify(f)));
  assert.ok(await openBackup(parseBackup(JSON.stringify(f)), 'backup-pass-123'));
});

test('iterations below the floor are refused (weakening attack)', async () => {
  const f = await realBackup();
  for (const it of [1, 1000, MIN_ITERATIONS - 1]) assert.throws(() => parseBackup(edit(f, (c) => { c.kdf.iterations = it; })), /unsafe or damaged/);
});

test('huge iterations are refused (freeze attack)', async () => {
  const f = await realBackup();
  for (const it of [MAX_ITERATIONS + 1, 1e15, Infinity, 1.5e6 + 0.5, '600000', null]) {
    assert.throws(() => parseBackup(edit(f, (c) => { c.kdf.iterations = it; })));
  }
});

test('wrong salt, IV or ciphertext shapes are refused', async () => {
  const f = await realBackup();
  assert.throws(() => parseBackup(edit(f, (c) => { c.kdf.salt = toB64(randomBytes(8)); })));
  assert.throws(() => parseBackup(edit(f, (c) => { c.kdf.salt = 'not base64!'; })));
  assert.throws(() => parseBackup(edit(f, (c) => { c.vault.iv = toB64(randomBytes(16)); })));
  assert.throws(() => parseBackup(edit(f, (c) => { c.vault.ct = toB64(randomBytes(4)); })));
  assert.throws(() => parseBackup(edit(f, (c) => { c.version = 3; })));
  assert.throws(() => parseBackup(edit(f, (c) => { c.version = 1; })), 'Argon2id needs a v2 file');
  assert.throws(() => parseBackup(edit(f, (c) => { c.kdf.name = 'MD5'; })));
  assert.throws(() => parseBackup('{not json'));
});

test('M-1: new backups use Argon2id; weak or huge Argon2id settings are refused', async () => {
  const f = await realBackup();
  assert.equal(f.version, 2);
  assert.equal(f.kdf.name, 'Argon2id');
  for (const [k, v] of [['memoryKiB', 1024], ['memoryKiB', 4_194_304], ['iterations', 1], ['iterations', 100], ['parallelism', 0], ['parallelism', 64]] as const) {
    assert.throws(() => parseBackup(edit(f, (c) => { c.kdf[k] = v; })), /unsafe or damaged/, `${k}=${v}`);
  }
});

test('M-1: old PBKDF2 backups (v1, e.g. restore files) still open', async () => {
  const salt = randomBytes(16);
  const old = JSON.stringify({ format: 'memo-vault-backup', version: 1, createdAt: 0, kdf: { name: 'PBKDF2-SHA256', salt: toB64(salt), iterations: 600_000 },
    vault: await seal(await deriveKey('old-backup-pass', salt, 600_000), { version: 1, entries: [], settings: {} }) });
  assert.ok(await openBackup(parseBackup(old), 'old-backup-pass'));
  assert.equal(await openBackup(parseBackup(old), 'wrong'), null);
  for (const it of [1, 599_999, 5_000_001]) {
    assert.throws(() => parseBackup(old.replace('"iterations":600000', `"iterations":${it}`)), /unsafe or damaged/);
  }
});

test('openBackup also refuses bad settings even if parseBackup is skipped', async () => {
  const salt = randomBytes(16);
  const weak = { format: 'memo-vault-backup', version: 1, createdAt: 0, kdf: { name: 'PBKDF2-SHA256', salt: toB64(salt), iterations: 1 },
    vault: await seal(await deriveKey('x', salt, 1), { entries: [] }) } as any;
  assert.equal(await openBackup(weak, 'x'), null);
});
