// IndexedDB TLE cache for CelesTrak responses.
// Records: {group: string, fetchedAt: number, raw: string}.

const DB_NAME = 'orbitarium';
const DB_VERSION = 1;
const STORE = 'tles';

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = window.indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'group' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('IndexedDB open blocked'));
  });
  return dbPromise;
}

/** Read a cached record. Returns null if absent. */
export async function get(group) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(group);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}

/** Write a record. fetchedAt set to Date.now() automatically. */
export async function put(group, raw) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const req = tx.objectStore(STORE).put({ group, fetchedAt: Date.now(), raw });
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

/** True if fetchedAt is within maxAgeMs of now. */
export function isFresh(fetchedAt, maxAgeMs = 6 * 60 * 60 * 1000) {
  return Date.now() - fetchedAt < maxAgeMs;
}
