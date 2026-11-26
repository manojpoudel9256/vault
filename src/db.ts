// Tiny IndexedDB key-value store. Only encrypted blobs and non-secret KDF parameters are written here.
const DB = 'memo-vault';
const STORE = 'kv';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const r = fn(t.objectStore(STORE));
    t.oncomplete = () => { db.close(); resolve(r ? r.result : undefined); };
    t.onerror = () => { db.close(); reject(t.error); };
    t.onabort = () => { db.close(); reject(t.error); };
  });
}

export const kvGet = <T>(key: string) => tx<T>('readonly', (s) => s.get(key) as IDBRequest<T>);

/** Writes several keys in one atomic transaction. */
export const kvSetMany = (items: Record<string, unknown>) =>
  tx('readwrite', (s) => { for (const [k, v] of Object.entries(items)) s.put(v, k); });

export const kvClear = () => tx('readwrite', (s) => { s.clear(); });
