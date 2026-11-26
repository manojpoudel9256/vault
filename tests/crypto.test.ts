// Core crypto guarantees (audit Phase 6). Runs with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveKey, randomBytes, seal, unseal } from '../src/crypto';

const salt = randomBytes(16);

test('wrong passphrase cannot decrypt', async () => {
  const sealed = await seal(await deriveKey('correct horse battery', salt), { a: 1 });
  await assert.rejects(unseal(await deriveKey('correct horse batterY', salt), sealed));
});

test('tampered ciphertext is rejected', async () => {
  const key = await deriveKey('correct horse battery', salt);
  const sealed = await seal(key, { a: 1 });
  const ct = Buffer.from(sealed.ct, 'base64');
  ct[ct.length - 1] ^= 1;
  await assert.rejects(unseal(key, { iv: sealed.iv, ct: ct.toString('base64') }));
});

test('tampered IV is rejected', async () => {
  const key = await deriveKey('correct horse battery', salt);
  const sealed = await seal(key, { a: 1 });
  const iv = Buffer.from(sealed.iv, 'base64');
  iv[0] ^= 1;
  await assert.rejects(unseal(key, { iv: iv.toString('base64'), ct: sealed.ct }));
});

test('IVs are 12 random bytes and never repeat', async () => {
  const key = await deriveKey('correct horse battery', salt);
  const seen = new Set<string>();
  for (let i = 0; i < 5000; i++) {
    const { iv } = await seal(key, i);
    assert.equal(Buffer.from(iv, 'base64').length, 12);
    assert.ok(!seen.has(iv), 'IV repeated');
    seen.add(iv);
  }
});
