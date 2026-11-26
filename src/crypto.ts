// All encryption happens here, on the device. AES-256-GCM (Web Crypto) for data.
// The key comes from the master passphrase with Argon2id (memory-hard, via the hash-wasm library).
// PBKDF2-SHA256 is still accepted for vaults and backups made before Argon2id; those vaults are
// upgraded on the next unlock.
import { argon2id } from 'hash-wasm';

const enc = new TextEncoder();
const dec = new TextDecoder();

export const KDF_ITERATIONS = 600_000;
const AAD = enc.encode('memo-vault:v1');

export interface Sealed {
  iv: string;
  ct: string;
}

export function randomBytes(n: number): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(n));
}

export function toB64(u8: Uint8Array): string {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromB64(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function deriveKey(passphrase: string, salt: Uint8Array<ArrayBuffer>, iterations = KDF_ITERATIONS): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', enc.encode(passphrase.normalize('NFKC')), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false, // the key can never be exported out of the browser
    ['encrypt', 'decrypt'],
  );
}

/** How a key is derived from the passphrase. Stored next to the encrypted data (not secret). */
export type Kdf =
  | { name: 'PBKDF2-SHA256'; salt: string; iterations: number }
  | { name: 'Argon2id'; salt: string; memoryKiB: number; iterations: number; parallelism: number };

/** Argon2id cost for new vaults: 64 MiB, 3 passes (above OWASP's minimum of 19 MiB x 2). */
export const ARGON2 = { memoryKiB: 65_536, iterations: 3, parallelism: 1 } as const;

export function newKdf(): Kdf {
  return { name: 'Argon2id', salt: toB64(randomBytes(16)), ...ARGON2 };
}

/** Derives the non-extractable AES-256-GCM key described by `kdf`. */
export async function deriveKeyFrom(passphrase: string, kdf: Kdf): Promise<CryptoKey> {
  if (kdf.name === 'PBKDF2-SHA256') return deriveKey(passphrase, fromB64(kdf.salt), kdf.iterations);
  const out = await argon2id({
    password: passphrase.normalize('NFKC'), salt: fromB64(kdf.salt),
    memorySize: kdf.memoryKiB, iterations: kdf.iterations, parallelism: kdf.parallelism,
    hashLength: 32, outputType: 'binary',
  });
  const raw = new Uint8Array(out); // own ArrayBuffer copy for Web Crypto
  out.fill(0);
  try {
    return await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  } finally {
    raw.fill(0); // the raw key bytes are not needed once the key is inside Web Crypto
  }
}

export async function seal(key: CryptoKey, data: unknown): Promise<Sealed> {
  const iv = randomBytes(12);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: AAD }, key, enc.encode(JSON.stringify(data)));
  return { iv: toB64(iv), ct: toB64(new Uint8Array(ct)) };
}

/** Throws if the key is wrong or the data was tampered with. */
export async function unseal<T>(key: CryptoKey, sealed: Sealed): Promise<T> {
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(sealed.iv), additionalData: AAD }, key, fromB64(sealed.ct));
  return JSON.parse(dec.decode(pt)) as T;
}

export function uid(): string {
  return Array.from(randomBytes(9), (b) => b.toString(36).padStart(2, '0')).join('');
}
