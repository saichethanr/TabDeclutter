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
