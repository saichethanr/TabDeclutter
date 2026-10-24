// Constants and pure helpers shared by the service worker and the popup.

export const STORAGE_KEYS = Object.freeze({
  /** chrome.storage.local — { [tabId]: lastAccessedMs } */
  ACCESS: 'tabAccess',
  /** chrome.storage.local — { [groupId]: { key, title, windowId, tabCount, overloaded } } for groups this extension created */
  AUTO_GROUPS: 'autoGroups',
  /** chrome.storage.local — [{ title, url, closedAt, reason }], newest first */
  ARCHIVE: 'archive',
  /** chrome.storage.local — timestamp of the last cleanup notification */
  LAST_NUDGE: 'lastNudgeAt',
  /** chrome.storage.local — true while page memory is paused */
  MEMORY_PAUSED: 'memoryPaused',
});

/** A background tab is "stale" after this much time without focus. */
export const STALE_AFTER_MS = 2 * 60 * 60 * 1000;
/** An auto-created group with more tabs than this is "overloaded". */
export const OVERLOAD_THRESHOLD = 7;
/** Maximum number of archived tabs kept in history. */
export const ARCHIVE_LIMIT = 500;

// Public suffixes where the registrable domain has three labels (e.g. bbc.co.uk, user.github.io).
const MULTI_PART_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.au', 'net.au', 'org.au', 'co.in', 'net.in', 'org.in',
  'co.jp', 'ne.jp', 'co.nz', 'co.za', 'co.kr', 'com.br', 'com.mx', 'com.sg', 'com.cn', 'com.tr',
  'github.io', 'gitlab.io', 'vercel.app', 'netlify.app', 'pages.dev', 'herokuapp.com', 'blogspot.com',
]);

/** Returns the registrable root domain of an http(s) URL ("gist.github.com" -> "github.com"), or null. */
export function getRootDomain(url) {
  let host;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return null;
  }
  if (!host) return null;
  if (host.startsWith('[') || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return host; // IP literals
  const labels = host.split('.');
  if (labels.length <= 2) return host;
  const lastTwo = labels.slice(-2).join('.');
  return MULTI_PART_SUFFIXES.has(lastTwo) ? labels.slice(-3).join('.') : lastTwo;
}

export function tabUrl(tab) {
  return tab.url || tab.pendingUrl || '';
}

/** Last time the tab was in the foreground: the tracked timestamp, falling back to Chrome's own. */
export function getLastAccessed(tab, accessMap) {
  return accessMap?.[tab.id] ?? (typeof tab.lastAccessed === 'number' ? tab.lastAccessed : null);
}

/** Active, pinned, and audible tabs are never stale, so they are never offered for closing. */
export function isStale(tab, accessMap, now = Date.now()) {
  if (tab.active || tab.pinned || tab.audible) return false;
  const last = getLastAccessed(tab, accessMap);
  return last !== null && now - last > STALE_AFTER_MS;
}

export function countTabsByGroup(tabs) {
  const counts = new Map();
  for (const tab of tabs) counts.set(tab.groupId, (counts.get(tab.groupId) ?? 0) + 1);
  return counts;
}

// ---------------------------------------------------------------------------------------------
// Text helpers, shared so indexed keywords and search queries are normalized the same way.
// ---------------------------------------------------------------------------------------------

export const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'these', 'those', 'your', 'you', 'are', 'was',
  'were', 'not', 'but', 'how', 'what', 'why', 'when', 'where', 'who', 'which', 'can', 'could', 'does',
  'did', 'get', 'got', 'use', 'using', 'used', 'into', 'out', 'about', 'all', 'any', 'its', 'has',
  'have', 'had', 'will', 'would', 'should', 'more', 'most', 'one', 'our', 'their', 'there', 'they',
  'them', 'then', 'than', 'also', 'just', 'like', 'some', 'such', 'only', 'very', 'over', 'here',
  'been', 'being', 'each', 'other', 'his', 'her', 'she', 'him', 'via', 'per', 'may', 'might', 'must',
  'shall', 'yes', 'yet', 'too', 'off', 'own', 'same', 'both', 'few', 'many', 'much', 'every', 'while',
  'after', 'before', 'because', 'between', 'during', 'without', 'within', 'upon', 'onto', 'www', 'com',
  'http', 'https', 'html', 'php', 'org', 'net',
]);

export function tokenize(text) {
  return (text ?? '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/** Light suffix stripping so "videos"/"video" and "watching"/"watch" meet. */
export function stem(word) {
  if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.length > 5 && word.endsWith('ing')) return word.slice(0, -3);
  if (word.length > 4 && word.endsWith('ed')) return word.slice(0, -2);
  if (word.length > 4 && /(ss|x|z|ch|sh)es$/.test(word)) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

/** Stems of the meaningful words in `text`. */
export function contentStems(text) {
  return tokenize(text)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w) && !/^\d+$/.test(w))
    .map(stem);
}

/** Pages are remembered per URL without the #fragment. */
export function normalizeUrl(url) {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    return parsed.href;
  } catch {
    return url;
  }
}

// ---------------------------------------------------------------------------------------------
// Page memory: an IndexedDB store of what visited pages were about, so closed pages stay findable.
// Record: { url, title, host, favIconUrl, description, headings, keywords: string[], firstSeen, lastVisited }
// ---------------------------------------------------------------------------------------------

export const PAGE_MEMORY_LIMIT = 3000;
const DB_NAME = 'tabdeclutter';
const PAGE_STORE = 'pages';
let dbPromise = null;

function openDb() {
  dbPromise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore(PAGE_STORE, { keyPath: 'url' });
      store.createIndex('lastVisited', 'lastVisited');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return dbPromise;
}

/** Runs `work(store)` in one transaction and resolves with the value it returns once committed. */
async function withStore(mode, work) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(PAGE_STORE, mode);
    let result;
    Promise.resolve(work(transaction.objectStore(PAGE_STORE))).then((value) => (result = value));
    transaction.oncomplete = () => resolve(result);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

const requestValue = (request) =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

export const pageMemory = {
  getAll: () => withStore('readonly', (store) => requestValue(store.getAll())),
  count: () => withStore('readonly', (store) => requestValue(store.count())),
  clear: () => withStore('readwrite', (store) => store.clear()),

  /** Inserts or refreshes a page, then evicts the least recently visited pages beyond the limit. */
  remember: (record) =>
    withStore('readwrite', async (store) => {
      const existing = await requestValue(store.get(record.url));
      store.put({ ...record, firstSeen: existing?.firstSeen ?? record.lastVisited });
      const excess = (await requestValue(store.count())) - PAGE_MEMORY_LIMIT;
      if (excess <= 0) return;
      let removed = 0;
      const cursor = store.index('lastVisited').openCursor();
      cursor.onsuccess = () => {
        const current = cursor.result;
        if (!current || removed >= excess) return;
        current.delete();
        removed++;
        current.continue();
      };
    }),
};
