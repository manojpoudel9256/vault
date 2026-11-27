import { deriveKeyFrom, fromB64, newKdf, seal, uid, unseal, type Kdf, type Sealed } from './crypto';
import { kvClear, kvGet, kvSetMany } from './db';
import { inferCategory, typeFor, type Category, type SecretType } from './categories';
import { cleanLogos, type PrivateLogo } from './logos';

export type { Category, SecretType };

export interface HistoryItem { value: string; changedAt: number }

export interface Entry {
  id: string;
  category: Category;
  service: string;
  account: string;
  type: SecretType;
  secret: string;
  notes: string;
  tags: string[];
  history: HistoryItem[];
  createdAt: number;
  updatedAt: number;
}

export interface Settings {
  autoLockMinutes: number;
  lastBackupAt: number | null;
  geminiEnabled: boolean;
  geminiKey: string;
  geminiModel: string;
  geminiShareAccounts: boolean;
  /** Private logos for your own services (see logos.ts). */
  logos: PrivateLogo[];
}

export interface VaultData { version: 1; entries: Entry[]; settings: Settings }

/** Stored next to the vault. v1 (PBKDF2, salt+iterations at top level) is read and upgraded to v2. */
interface Meta { version: 2; kdf: Kdf; createdAt: number }
type LegacyMeta = { version: 1; salt: string; iterations: number; createdAt: number };

/** Backup file. v1 = PBKDF2 (older app versions, restore files); v2 = any accepted KDF (Argon2id). */
export interface BackupFile {
  format: 'memo-vault-backup';
  version: 1 | 2;
  createdAt: number;
  kdf: Kdf;
  vault: Sealed;
}

function readMeta(m: Meta | LegacyMeta | undefined): Meta | null {
  if (!m) return null;
  if (m.version === 1) return { version: 2, kdf: { name: 'PBKDF2-SHA256', salt: m.salt, iterations: m.iterations }, createdAt: m.createdAt };
  return m;
}

export const defaultSettings = (): Settings => ({
  autoLockMinutes: 2,
  lastBackupAt: null,
  geminiEnabled: false,
  geminiKey: '',
  geminiModel: 'gemini-2.5-flash',
  geminiShareAccounts: false,
  logos: [],
});

let key: CryptoKey | null = null;
let meta: Meta | null = null;
let data: VaultData | null = null;

export const hasVault = async () => !!(await kvGet<Meta>('meta'));
export const isUnlocked = () => !!data;

export function vault(): VaultData {
  if (!data) throw new Error('Vault is locked');
  return data;
}

function normalize(d: VaultData): VaultData {
  const entries = (d.entries ?? []).map((e) => {
    // Entries saved before categories existed get one now.
    const oldType = e.type as SecretType | 'other';
    const category = e.category ?? inferCategory(e.service, oldType, e.secret);
    // An older build stored "Mobile" / "PC" in a separate field; keep it as a tag instead.
    const { label, ...rest } = e as Entry & { label?: string };
    const tags = [...(e.tags ?? [])];
    if (label && !tags.some((t) => t.toLowerCase() === label.toLowerCase())) tags.unshift(label);
    return { ...rest, category, type: typeFor(category, oldType), history: e.history ?? [], tags };
  });
  const settings = { ...defaultSettings(), ...(d.settings ?? {}) };
  settings.logos = cleanLogos(settings.logos); // a vault or backup never brings in malformed logos
  return { version: 1, entries, settings };
}

export async function createVault(passphrase: string): Promise<void> {
  meta = { version: 2, kdf: newKdf(), createdAt: Date.now() };
  key = await deriveKeyFrom(passphrase, meta.kdf);
  data = { version: 1, entries: [], settings: defaultSettings() };
  await kvSetMany({ meta, vault: await seal(key, data) });
}

export async function unlock(passphrase: string): Promise<boolean> {
  const m = readMeta(await kvGet<Meta | LegacyMeta>('meta'));
  const sealed = await kvGet<Sealed>('vault');
  if (!m || !sealed) throw new Error('No vault on this device');
  if (!validKdf(m.kdf)) throw new Error('The stored vault settings are damaged');
  const k = await deriveKeyFrom(passphrase, m.kdf);
  try {
    data = normalize(await unseal<VaultData>(k, sealed));
  } catch {
    return false;
  }
  key = k;
  meta = m;
  // Vaults made before Argon2id are re-encrypted with it now, with a fresh salt (one atomic write).
  // Best effort: if it fails (e.g. WebAssembly blocked), the vault stays as it was and opens anyway.
  if (m.kdf.name !== 'Argon2id') await rekey(passphrase).catch(() => {});
  return true;
}

/** Re-encrypts the unlocked vault under `passphrase` with a fresh Argon2id salt. */
async function rekey(passphrase: string, extra: Record<string, unknown> = {}): Promise<void> {
  if (!data) throw new Error('Vault is locked');
  const m: Meta = { version: 2, kdf: newKdf(), createdAt: meta?.createdAt ?? Date.now() };
  const k = await deriveKeyFrom(passphrase, m.kdf);
  await kvSetMany({ meta: m, vault: await seal(k, data), ...extra });
  key = k;
  meta = m;
}

export function lock(): void {
  key = null;
  data = null;
}

export async function save(): Promise<void> {
  if (!key || !data) throw new Error('Vault is locked');
  await kvSetMany({ vault: await seal(key, data) });
}

export async function checkPassphrase(passphrase: string): Promise<boolean> {
  if (!meta) return false;
  const sealed = await kvGet<Sealed>('vault');
  if (!sealed) return false;
  const k = await deriveKeyFrom(passphrase, meta.kdf);
  try { await unseal(k, sealed); return true; } catch { return false; }
}

export async function changePassphrase(current: string, next: string): Promise<boolean> {
  if (!data || !meta || !(await checkPassphrase(current))) return false;
  // Face ID stored the old passphrase, so it has to be turned on again.
  await rekey(next, { faceid: null });
  return true;
}

export async function destroyVault(): Promise<void> {
  lock();
  meta = null;
  await kvClear();
}

// ---------- entries ----------

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

export function findExisting(service: string, account: string, type: SecretType): Entry | undefined {
  return vault().entries.find((e) => same(e.service, service) && same(e.account, account) && e.type === type);
}

export type EntryInput = Pick<Entry, 'category' | 'service' | 'account' | 'type' | 'secret' | 'notes' | 'tags'>;

/** Creates or updates an entry. A changed secret moves the old value into history. */
export function upsertEntry(input: EntryInput, id?: string): { entry: Entry; created: boolean; changed: boolean } {
  const now = Date.now();
  const existing = id ? vault().entries.find((e) => e.id === id) : undefined;
  if (existing) {
    const changed = existing.secret !== input.secret;
    if (changed && existing.secret) existing.history.unshift({ value: existing.secret, changedAt: existing.updatedAt });
    Object.assign(existing, input, { updatedAt: now });
    return { entry: existing, created: false, changed };
  }
  const entry: Entry = { ...input, id: uid(), history: [], createdAt: now, updatedAt: now };
  vault().entries.push(entry);
  return { entry, created: true, changed: true };
}

/** Passwords and PINs count for reuse checks (not card numbers, CVVs, IDs or addresses). */
const reusable = (e: Entry) => (e.type === 'password' || e.type === 'pin') && e.category !== 'card' && !!e.secret;

/** Other entries that use exactly the same password or PIN as this one. */
export function reusedBy(e: Entry, entries: Entry[] = vault().entries): Entry[] {
  if (!reusable(e)) return [];
  return entries.filter((o) => o.id !== e.id && reusable(o) && o.secret === e.secret);
}

/** Every entry whose password or PIN is also used by another entry. */
export function reusedEntries(entries: Entry[] = vault().entries): Entry[] {
  const count = new Map<string, number>();
  for (const e of entries) if (reusable(e)) count.set(e.secret, (count.get(e.secret) ?? 0) + 1);
  return entries.filter((e) => reusable(e) && (count.get(e.secret) ?? 0) > 1);
}

export function deleteEntry(id: string): void {
  const v = vault();
  v.entries = v.entries.filter((e) => e.id !== id);
}

// ---------- backup / restore ----------

export async function makeBackup(): Promise<string> {
  if (!key || !data || !meta) throw new Error('Vault is locked');
  data.settings.lastBackupAt = Date.now();
  await save();
  // Never put the Gemini API key into backup files.
  const copy: VaultData = { ...data, settings: { ...data.settings, geminiKey: '' } };
  const file: BackupFile = {
    format: 'memo-vault-backup',
    version: 2,
    createdAt: Date.now(),
    kdf: meta.kdf,
    vault: await seal(key, copy),
  };
  return JSON.stringify(file);
}

// Accepted key-derivation costs for backups and the stored vault. Below the floor would weaken the
// vault; far above it would freeze the app (a crafted file could ask for 10^15 rounds or 1 TB of memory).
export const MIN_ITERATIONS = 600_000; // PBKDF2 (older vaults and backups)
export const MAX_ITERATIONS = 5_000_000;
export const ARGON2_LIMITS = { minMemoryKiB: 19_456, maxMemoryKiB: 262_144, minIterations: 2, maxIterations: 10, maxParallelism: 4 } as const;

const b64Len = (s: unknown): number => {
  if (typeof s !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(s)) return -1;
  try { return fromB64(s).length; } catch { return -1; }
};
const intIn = (v: unknown, lo: number, hi: number) => Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;

/** True when the key-derivation settings are one this app writes, within safe bounds. */
export function validKdf(kdf: Partial<Kdf> | undefined): boolean {
  if (!kdf || b64Len(kdf.salt) !== 16) return false;
  if (kdf.name === 'PBKDF2-SHA256') return intIn(kdf.iterations, MIN_ITERATIONS, MAX_ITERATIONS);
  if (kdf.name === 'Argon2id') {
    const L = ARGON2_LIMITS;
    return intIn(kdf.memoryKiB, L.minMemoryKiB, L.maxMemoryKiB) && intIn(kdf.iterations, L.minIterations, L.maxIterations)
      && intIn(kdf.parallelism, 1, L.maxParallelism);
  }
  return false;
}
const validSealed = (s: Partial<Sealed> | undefined): boolean => b64Len(s?.iv) === 12 && b64Len(s?.ct) >= 16;

export function parseBackup(text: string): BackupFile {
  const bad = 'This is not a MEMO Vault backup file.';
  let f: BackupFile;
  try { f = JSON.parse(text); } catch { throw new Error(bad); }
  const knownKdf = f?.kdf?.name === 'PBKDF2-SHA256' || (f?.version === 2 && f?.kdf?.name === 'Argon2id');
  if (f?.format !== 'memo-vault-backup' || (f.version !== 1 && f.version !== 2) || !knownKdf || !validSealed(f.vault)) throw new Error(bad);
  if (!validKdf(f.kdf)) throw new Error('This backup file has unsafe or damaged settings, so it was not opened.');
  return f;
}

/** Decrypts a backup with the passphrase used when it was made. Returns null if the passphrase is wrong. */
export async function openBackup(file: BackupFile, passphrase: string): Promise<{ data: VaultData; key: CryptoKey } | null> {
  if (!validKdf(file.kdf)) return null;
  const k = await deriveKeyFrom(passphrase, file.kdf);
  try { return { data: normalize(await unseal<VaultData>(k, file.vault)), key: k }; } catch { return null; }
}

/**
 * First-run restore. The backup is opened with its own passphrase, then re-encrypted for this
 * device with a NEW master passphrase, a fresh salt and the default KDF cost. Nothing from the
 * backup's key settings is kept (a shared or one-time backup passphrase never becomes the master).
 */
export async function restoreAsNewVault(file: BackupFile, backupPassphrase: string, newPassphrase: string): Promise<boolean> {
  const opened = await openBackup(file, backupPassphrase);
  if (!opened) return false;
  data = opened.data;
  meta = null;
  await rekey(newPassphrase, { faceid: null });
  return true;
}

/** Restore into the unlocked vault. "replace" swaps everything; "merge" keeps the newest version of each entry. */
export async function restoreInto(incoming: VaultData, mode: 'merge' | 'replace'): Promise<{ added: number; updated: number }> {
  const v = vault();
  if (mode === 'replace') {
    v.entries = incoming.entries;
    v.settings = { ...incoming.settings, geminiKey: v.settings.geminiKey };
    await save();
    return { added: incoming.entries.length, updated: 0 };
  }
  let added = 0;
  let updated = 0;
  for (const inc of incoming.entries) {
    const mine = v.entries.find((e) => e.id === inc.id) ?? findExisting(inc.service, inc.account, inc.type);
    if (!mine) { v.entries.push(inc); added++; continue; }
    if (inc.updatedAt > mine.updatedAt) {
      if (mine.secret !== inc.secret) mine.history.unshift({ value: mine.secret, changedAt: mine.updatedAt });
      Object.assign(mine, {
        category: inc.category,
        service: inc.service, account: inc.account, type: inc.type, secret: inc.secret,
        notes: inc.notes, tags: inc.tags, updatedAt: inc.updatedAt,
      });
      updated++;
    }
    const known = new Set([mine.secret, ...mine.history.map((h) => h.value)]);
    for (const h of [{ value: inc.secret, changedAt: inc.updatedAt }, ...inc.history]) {
      if (!known.has(h.value)) { mine.history.push(h); known.add(h.value); }
    }
    mine.history.sort((a, b) => b.changedAt - a.changedAt);
  }
  if (!v.settings.logos.length && incoming.settings.logos?.length) v.settings.logos = cleanLogos(incoming.settings.logos);
  await save();
  return { added, updated };
}
