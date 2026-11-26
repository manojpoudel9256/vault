// Vault flows against a real (in-memory) IndexedDB. Runs with: npm test
import 'fake-indexeddb/auto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveKey, KDF_ITERATIONS, randomBytes, seal, toB64 } from '../src/crypto';
import { kvGet, kvSetMany } from '../src/db';
import {
  createVault, destroyVault, lock, makeBackup, parseBackup, restoreAsNewVault, save, unlock, upsertEntry, vault,
} from '../src/vault';

async function backupWith(passphrase: string): Promise<string> {
  await destroyVault();
  await createVault(passphrase);
  upsertEntry({ category: 'login', service: 'Example', account: 'me@example.com', type: 'password', secret: 'fake-secret-1', notes: '', tags: [] });
  await save();
  const text = await makeBackup();
  await destroyVault();
  return text;
}

test('H-1: restore re-keys with the NEW passphrase; the backup passphrase no longer unlocks', async () => {
  const text = await backupWith('one-time-backup-pass');
  const file = parseBackup(text);
  assert.equal(await restoreAsNewVault(file, 'one-time-backup-pass', 'my-new-master-pass'), true);
  const meta = await kvGet<{ kdf: { name: string; salt: string } }>('meta');
  assert.notEqual(meta!.kdf.salt, file.kdf.salt, 'salt must be fresh');
  assert.equal(meta!.kdf.name, 'Argon2id');
  lock();
  assert.equal(await unlock('one-time-backup-pass'), false);
  assert.equal(await unlock('my-new-master-pass'), true);
  assert.equal(vault().entries[0].secret, 'fake-secret-1');
});

test('H-1: wrong backup passphrase restores nothing', async () => {
  const text = await backupWith('one-time-backup-pass');
  assert.equal(await restoreAsNewVault(parseBackup(text), 'wrong-pass', 'my-new-master-pass'), false);
  assert.equal(await kvGet('meta'), undefined);
});

test('M-1: new vaults use Argon2id (64 MiB, 3 passes) with a 16-byte salt', async () => {
  await destroyVault();
  await createVault('master-pass-123');
  const meta = await kvGet<{ version: number; kdf: Record<string, unknown> }>('meta');
  assert.equal(meta!.version, 2);
  assert.equal(meta!.kdf.name, 'Argon2id');
  assert.equal(meta!.kdf.memoryKiB, 65536);
  assert.equal(meta!.kdf.iterations, 3);
  assert.equal(Buffer.from(String(meta!.kdf.salt), 'base64').length, 16);
});

test('M-1: an old PBKDF2 vault still unlocks and is upgraded to Argon2id on that unlock', async () => {
  await destroyVault();
  // Write a vault exactly as the previous app version did (meta v1 + PBKDF2-SHA256 600k).
  const salt = randomBytes(16);
  const oldKey = await deriveKey('legacy-master-1', salt, KDF_ITERATIONS);
  const vaultData = { version: 1, entries: [], settings: {} };
  await kvSetMany({ meta: { version: 1, salt: toB64(salt), iterations: KDF_ITERATIONS, createdAt: 1 }, vault: await seal(oldKey, vaultData) });

  assert.equal(await unlock('wrong-pass-000'), false);
  assert.deepEqual(await kvGet('meta'), { version: 1, salt: toB64(salt), iterations: KDF_ITERATIONS, createdAt: 1 }, 'a failed unlock must not change anything');

  assert.equal(await unlock('legacy-master-1'), true);
  const meta = await kvGet<{ version: number; kdf: { name: string; salt: string }; createdAt: number }>('meta');
  assert.equal(meta!.version, 2);
  assert.equal(meta!.kdf.name, 'Argon2id');
  assert.notEqual(meta!.kdf.salt, toB64(salt));
  assert.equal(meta!.createdAt, 1);
  lock();
  assert.equal(await unlock('legacy-master-1'), true, 'same passphrase works after the upgrade');
  assert.equal(await unlock('wrong-pass-000'), false);
});

test('M-1: if the Argon2id upgrade fails, the old vault still opens and is left unchanged', async () => {
  await destroyVault();
  const salt = randomBytes(16);
  const legacy = { version: 1, salt: toB64(salt), iterations: KDF_ITERATIONS, createdAt: 1 };
  await kvSetMany({ meta: legacy, vault: await seal(await deriveKey('legacy-master-1', salt, KDF_ITERATIONS), { version: 1, entries: [], settings: {} }) });
  const real = WebAssembly.instantiate;
  (WebAssembly as any).instantiate = () => Promise.reject(new Error('blocked'));
  try {
    assert.equal(await unlock('legacy-master-1'), true);
  } finally {
    (WebAssembly as any).instantiate = real;
  }
  assert.deepEqual(await kvGet('meta'), legacy);
});

test('H-1: restore turns Face ID off (it held the old passphrase)', async () => {
  const text = await backupWith('one-time-backup-pass');
  await kvSetMany({ faceid: { credId: 'x', prfSalt: 'x', sealed: { iv: 'x', ct: 'x' } } });
  assert.equal(await restoreAsNewVault(parseBackup(text), 'one-time-backup-pass', 'my-new-master-pass'), true);
  assert.equal(await kvGet('faceid'), null);
});
