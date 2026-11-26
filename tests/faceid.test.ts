// M-4: Face ID needs the master passphrase again after 7 days. Runs with: npm test
import 'fake-indexeddb/auto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { kvClear, kvGet, kvSetMany } from '../src/db';
import { FACE_ID_MAX_AGE_MS, faceIdState, notePassphraseUnlock, passphraseFromFaceId } from '../src/faceid';

const rec = (passAt?: number) => ({ credId: 'AA==', prfSalt: 'AA==', sealed: { iv: 'AA==', ct: 'AA==' }, ...(passAt === undefined ? {} : { passAt }) });

test('Face ID is off when not set up', async () => {
  await kvClear();
  assert.equal(await faceIdState(), 'off');
});

test('Face ID works within 7 days of typing the passphrase, then expires', async () => {
  const now = Date.now();
  await kvClear();
  await kvSetMany({ faceid: rec(now - 1000) });
  assert.equal(await faceIdState(now), 'ok');
  assert.equal(await faceIdState(now + FACE_ID_MAX_AGE_MS + 1), 'expired');
});

test('records from before this fix (no date) count as expired', async () => {
  await kvClear();
  await kvSetMany({ faceid: rec() });
  assert.equal(await faceIdState(), 'expired');
});

test('an expired Face ID refuses to release the passphrase without asking WebAuthn', async () => {
  await kvClear();
  await kvSetMany({ faceid: rec(Date.now() - FACE_ID_MAX_AGE_MS - 1) });
  await assert.rejects(passphraseFromFaceId(), /expired/);
});

test('typing the passphrase restarts the 7-day window', async () => {
  await kvClear();
  await kvSetMany({ faceid: rec(0) });
  await notePassphraseUnlock(123456);
  assert.equal((await kvGet<{ passAt: number }>('faceid'))!.passAt, 123456);
  await kvClear();
  await notePassphraseUnlock();
  assert.equal(await kvGet('faceid'), undefined, 'does nothing when Face ID is off');
});
