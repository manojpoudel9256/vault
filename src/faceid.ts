// Face ID unlock, using a passkey with the WebAuthn PRF extension (Safari on iOS 18 and later).
//
// How it works:
// - Turning it on creates a passkey for this site. The passkey can hand out a secret (the "PRF"
//   output), but only after Face ID succeeds.
// - That secret is turned into an AES-256 key, which encrypts the master passphrase.
//   Only this encrypted copy is stored, in this device's IndexedDB.
// - Unlocking with Face ID gets the secret again, decrypts the passphrase, and opens the vault
//   the normal way. Nothing is sent over the network; the passphrase still works on its own.
import { fromB64, randomBytes, seal, toB64, unseal, type Sealed } from './crypto';
import { kvGet, kvSetMany } from './db';

/** passAt: last time the master passphrase was typed (Face ID stops working 7 days after it). */
interface FaceIdRecord { credId: string; prfSalt: string; sealed: Sealed; passAt?: number }
const KEY = 'faceid';
/** iPhone accepts the device passcode in place of Face ID, so the master passphrase is asked for again weekly. */
export const FACE_ID_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** 'off' = not set up, 'expired' = passphrase needed (7 days), 'ok' = Face ID can be used. */
export async function faceIdState(now = Date.now()): Promise<'off' | 'expired' | 'ok'> {
  const rec = await kvGet<FaceIdRecord | null>(KEY);
  if (!rec) return 'off';
  return now - (rec.passAt ?? 0) > FACE_ID_MAX_AGE_MS ? 'expired' : 'ok';
}

/** Call after the master passphrase was typed and accepted: restarts the 7-day Face ID window. */
export async function notePassphraseUnlock(now = Date.now()): Promise<void> {
  const rec = await kvGet<FaceIdRecord | null>(KEY);
  if (rec) await kvSetMany({ [KEY]: { ...rec, passAt: now } });
}
const enc = new TextEncoder();

/** True when this device has Face ID / Touch ID available to websites. */
export async function faceIdAvailable(): Promise<boolean> {
  try {
    return !!window.PublicKeyCredential && await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch {
    return false;
  }
}

export async function faceIdEnabled(): Promise<boolean> {
  return !!(await kvGet<FaceIdRecord | null>(KEY));
}

export async function disableFaceId(): Promise<void> {
  await kvSetMany({ [KEY]: null });
}

async function keyFromPrf(prf: ArrayBuffer): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', prf, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: enc.encode('memo-vault:faceid'), info: enc.encode('passphrase-wrap') },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  );
}

/** Asks for Face ID and returns the passkey's secret for this salt. */
async function prfSecret(credId: Uint8Array<ArrayBuffer>, salt: Uint8Array<ArrayBuffer>): Promise<ArrayBuffer> {
  const cred = await navigator.credentials.get({
    publicKey: {
      challenge: randomBytes(32),
      rpId: location.hostname,
      allowCredentials: [{ type: 'public-key', id: credId }],
      userVerification: 'required',
      timeout: 60_000,
      extensions: { prf: { eval: { first: salt } } } as AuthenticationExtensionsClientInputs,
    },
  }) as PublicKeyCredential | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const out = (cred?.getClientExtensionResults() as any)?.prf?.results?.first as ArrayBuffer | undefined;
  if (!out) throw new Error('unsupported');
  return out;
}

/** A passkey that was just made; its secret may come back now or need one more Face ID. */
export interface PendingPasskey { credId: Uint8Array<ArrayBuffer>; salt: Uint8Array<ArrayBuffer>; prf: ArrayBuffer | null }

/** Step 1: make the passkey (shows Face ID). Throws 'unsupported' or 'cancelled'. */
export async function createFacePasskey(): Promise<PendingPasskey> {
  const salt = randomBytes(32);
  try {
    const cred = await navigator.credentials.create({
      publicKey: {
        challenge: randomBytes(32),
        rp: { id: location.hostname, name: 'MEMO Vault' },
        user: { id: randomBytes(16), name: 'MEMO Vault', displayName: 'MEMO Vault' },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
        authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'required' },
        timeout: 60_000,
        extensions: { prf: { eval: { first: salt } } } as AuthenticationExtensionsClientInputs,
      },
    }) as PublicKeyCredential | null;
    if (!cred) throw new Error('cancelled');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const prf = (cred.getClientExtensionResults() as any)?.prf;
    if (!prf || prf.enabled === false) throw new Error('unsupported');
    return { credId: new Uint8Array(cred.rawId), salt, prf: (prf.results?.first as ArrayBuffer | undefined) ?? null };
  } catch (e) {
    throw new Error(reason(e));
  }
}

/**
 * Step 2: store the passphrase encrypted with the passkey's secret. If the secret did not come
 * back in step 1, this asks for Face ID once more (iPhone may need a second tap for that).
 * Call only with a passphrase that was just checked.
 */
export async function finishFaceId(passphrase: string, p: PendingPasskey): Promise<void> {
  try {
    const key = await keyFromPrf(p.prf ?? await prfSecret(p.credId, p.salt));
    const record: FaceIdRecord = { credId: toB64(p.credId), prfSalt: toB64(p.salt), sealed: await seal(key, passphrase), passAt: Date.now() };
    await kvSetMany({ [KEY]: record });
  } catch (e) {
    throw new Error(reason(e));
  }
}

/** Face ID, then the stored passphrase. Throws 'cancelled', 'unsupported' or 'failed'. */
export async function passphraseFromFaceId(): Promise<string> {
  const rec = await kvGet<FaceIdRecord | null>(KEY);
  if (!rec) throw new Error('failed');
  if (Date.now() - (rec.passAt ?? 0) > FACE_ID_MAX_AGE_MS) throw new Error('expired');
  try {
    const key = await keyFromPrf(await prfSecret(fromB64(rec.credId), fromB64(rec.prfSalt)));
    return await unseal<string>(key, rec.sealed);
  } catch (e) {
    throw new Error(reason(e));
  }
}

function reason(e: unknown): string {
  const name = (e as { name?: string })?.name;
  const msg = (e as { message?: string })?.message;
  if (msg === 'unsupported' || msg === 'cancelled' || msg === 'expired') return msg;
  if (name === 'NotAllowedError' || name === 'AbortError') return 'cancelled';
  if (name === 'NotSupportedError') return 'unsupported';
  return 'failed';
}
