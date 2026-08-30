/**
 * 譯文快取。**只在 service worker 中使用。**
 *
 * 為什麼不放在 content script：content script 雖然跑在 isolated world，
 * 但 indexedDB 拿到的是「網頁的」儲存空間，不是擴充功能的。那會汙染網站的
 * 儲存、而且每個網域各自一份、跨站無法共用。所以快取一律由 service worker
 * 持有，content script 透過 MSG.CACHE_GET / CACHE_PUT 存取。
 */

const DB_NAME = 'readduck';
const DB_VERSION = 1;
const STORE = 'translations';
const MAX_ENTRIES = 5000;
/** 超過上限時一次刪掉這個比例的最舊資料，避免每寫一筆就修剪一次 */
const PRUNE_RATIO = 0.2;

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'k' });
        // 依最後使用時間修剪（近似 LRU）
        store.createIndex('ts', 'ts');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('indexedDB blocked'));
  }).catch((err) => {
    dbPromise = null;
    throw err;
  });
  return dbPromise;
}

function tx(db, mode) {
  return db.transaction(STORE, mode).objectStore(STORE);
}

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * 批次讀取。回傳 { key: translatedText }，未命中的 key 不會出現。
 * 命中時順手更新 ts，讓 LRU 修剪反映實際使用而非寫入時間。
 */
export async function getMany(keys) {
  if (!keys?.length) return {};
  const db = await openDb();
  const store = tx(db, 'readwrite');
  const out = {};
  const now = Date.now();
  await Promise.all(
    keys.map(async (k) => {
      const row = await reqToPromise(store.get(k)).catch(() => null);
      if (!row) return;
      out[k] = row.v;
      // 只在明顯過期時才回寫，減少寫入量
      if (now - row.ts > 60_000) store.put({ ...row, ts: now });
    })
  );
  return out;
}

/** 批次寫入。entries 形如 [{ k, v }]。 */
export async function putMany(entries) {
  if (!entries?.length) return;
  const db = await openDb();
  const store = tx(db, 'readwrite');
  const now = Date.now();
  for (const { k, v } of entries) {
    if (typeof k === 'string' && typeof v === 'string') store.put({ k, v, ts: now });
  }
  await new Promise((resolve) => { store.transaction.oncomplete = resolve; });
  await pruneIfNeeded();
}

async function pruneIfNeeded() {
  const db = await openDb();
  const count = await reqToPromise(tx(db, 'readonly').count()).catch(() => 0);
  if (count <= MAX_ENTRIES) return;

  const target = Math.ceil(count * PRUNE_RATIO);
  const store = tx(db, 'readwrite');
  const cursorReq = store.index('ts').openCursor(); // ts 由小到大 = 最舊優先
  let removed = 0;
  await new Promise((resolve, reject) => {
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (!cursor || removed >= target) return resolve();
      cursor.delete();
      removed++;
      cursor.continue();
    };
    cursorReq.onerror = () => reject(cursorReq.error);
  });
}

export async function stats() {
  try {
    const db = await openDb();
    const count = await reqToPromise(tx(db, 'readonly').count());
    let bytes = null;
    if (navigator.storage?.estimate) {
      const est = await navigator.storage.estimate();
      bytes = est.usage ?? null;
    }
    return { count, bytes, max: MAX_ENTRIES };
  } catch {
    return { count: 0, bytes: null, max: MAX_ENTRIES };
  }
}

export async function clear() {
  const db = await openDb();
  const store = tx(db, 'readwrite');
  store.clear();
  await new Promise((resolve) => { store.transaction.oncomplete = resolve; });
}
