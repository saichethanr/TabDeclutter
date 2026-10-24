// TabDeclutter service worker.
//
// MV3 service workers are terminated whenever they go idle, so every piece of durable state lives
// in chrome.storage (local for data that must survive restarts, session for per-browser-session
// bookkeeping). In-memory values here are only short-lived scheduling helpers.

import {
  STORAGE_KEYS as KEYS,
  OVERLOAD_THRESHOLD,
  countTabsByGroup,
  getRootDomain,
  isStale,
  tabUrl,
} from './shared.js';

const NO_GROUP = chrome.tabGroups.TAB_GROUP_ID_NONE;
const MIN_GROUP_SIZE = 2;
const REGROUP_DEBOUNCE_MS = 750;
const HEALTH_DEBOUNCE_MS = 2000;
const NUDGE_COOLDOWN_MS = 3 * 60 * 60 * 1000;
const NUDGE_MIN_STALE = 5;
const NOTIFICATION_ID = 'tabdeclutter-nudge';
const GROUP_COLORS = ['blue', 'cyan', 'green', 'purple', 'pink', 'orange', 'yellow', 'red', 'grey'];

// Rule 2: domains that host unrelated content. They are split into keyword sub-groups instead of
// one domain-wide group.
const CATCH_ALL_DOMAINS = new Set(['google.com', 'youtube.com', 'stackoverflow.com']);
const TITLE_NOISE = {
  'google.com': ['google', 'search'],
  'youtube.com': ['youtube'],
  'stackoverflow.com': ['stack', 'overflow', 'stackoverflow'],
};
const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'your', 'you', 'are', 'was', 'not', 'but',
  'how', 'what', 'why', 'when', 'where', 'who', 'which', 'can', 'does', 'did', 'get', 'use', 'using',
  'into', 'out', 'about', 'all', 'any', 'new', 'best', 'top', 'official', 'video', 'videos', 'full',
  'part', 'vs', 'via', 'its', 'has', 'have', 'will', 'more', 'one', 'two', 'way', 'home', 'page',
]);
const DOMAIN_LABELS = {
  'github.com': 'GitHub',
  'youtube.com': 'YouTube',
  'google.com': 'Google',
  'stackoverflow.com': 'Stack Overflow',
  'linkedin.com': 'LinkedIn',
  'chatgpt.com': 'ChatGPT',
  'gitlab.com': 'GitLab',
};

// ---------------------------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------------------------

let storageChain = Promise.resolve();

/** Serialized read-modify-write of one object-valued storage key, so concurrent events never lose updates. */
function mutateStorage(area, key, mutator) {
  const run = storageChain.then(async () => {
    const value = (await area.get(key))[key] ?? {};
    const result = mutator(value);
    await area.set({ [key]: value });
    return result;
  });
  storageChain = run.catch((error) => console.warn('[TabDeclutter] storage update failed', error));
  return run;
}

async function readKey(area, key) {
  return (await area.get(key))[key] ?? {};
}

// ---------------------------------------------------------------------------------------------
// Stale tab tracking: tabAccess[tabId] = the last moment the tab was in the foreground.
// ---------------------------------------------------------------------------------------------

function stamp(tabIds, at = Date.now()) {
  const ids = tabIds.filter((id) => Number.isInteger(id) && id !== chrome.tabs.TAB_ID_NONE);
  if (!ids.length) return Promise.resolve();
  return mutateStorage(chrome.storage.local, KEYS.ACCESS, (map) => {
    for (const id of ids) map[id] = at;
  });
}

chrome.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
  // The previously active tab was in the foreground until this moment, so it is stamped too.
  const previous = await mutateStorage(chrome.storage.session, 'activeByWindow', (map) => {
    const prev = map[windowId];
    map[windowId] = tabId;
    return prev;
  });
  await stamp([tabId, previous]);
  scheduleHealthCheck();
});

chrome.windows.onFocusChanged.addListener(async () => {
  // Focus moving between windows (or away from Chrome) ends or starts foreground time for the
  // active tab of each window.
  const active = await chrome.tabs.query({ active: true });
  await stamp(active.map((tab) => tab.id));
  scheduleHealthCheck();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url) {
    if (tab.active) stamp([tabId]);
    forgetDetached(tabId);
  }
  if ('groupId' in changeInfo && changeInfo.groupId === NO_GROUP && !selfReleased.has(tabId)) {
    // The user pulled this tab out of a group: leave it alone until it navigates elsewhere.
    mutateStorage(chrome.storage.session, 'detachedTabs', (map) => {
      map[tabId] = true;
    });
  }
  const navigated = changeInfo.url || changeInfo.status === 'complete';
  const retitled = changeInfo.title && CATCH_ALL_DOMAINS.has(getRootDomain(tabUrl(tab)));
  if (navigated || retitled) scheduleRegroup(tab.windowId, tabId);
});

chrome.tabs.onRemoved.addListener((tabId, { windowId, isWindowClosing }) => {
  mutateStorage(chrome.storage.local, KEYS.ACCESS, (map) => {
    delete map[tabId];
  });
  forgetDetached(tabId);
  if (isWindowClosing) {
    mutateStorage(chrome.storage.session, 'activeByWindow', (map) => {
      delete map[windowId];
    });
  } else {
    scheduleRegroup(windowId);
  }
  scheduleHealthCheck();
});

chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
  // Prerendering swaps tab ids; carry the timestamp over.
  mutateStorage(chrome.storage.local, KEYS.ACCESS, (map) => {
    map[addedTabId] = map[removedTabId] ?? Date.now();
    delete map[removedTabId];
  });
});

chrome.tabs.onAttached.addListener((tabId, { newWindowId }) => scheduleRegroup(newWindowId, tabId));
chrome.tabs.onDetached.addListener((_tabId, { oldWindowId }) => scheduleRegroup(oldWindowId));

chrome.tabGroups.onRemoved.addListener((group) => {
  mutateStorage(chrome.storage.local, KEYS.AUTO_GROUPS, (registry) => {
    delete registry[group.id];
  });
});

function forgetDetached(tabId) {
  mutateStorage(chrome.storage.session, 'detachedTabs', (map) => {
    delete map[tabId];
  });
}

// ---------------------------------------------------------------------------------------------
// Auto-grouping engine
// ---------------------------------------------------------------------------------------------

const pendingRegroups = new Map(); // windowId -> { timer, changed: Set<tabId> }
const selfReleased = new Set(); // tabs this worker is ungrouping (not a user action)
let regroupChain = Promise.resolve();

/** Debounces regrouping per window; `tabId` marks a tab whose URL or title changed. */
function scheduleRegroup(windowId, tabId) {
  if (windowId === undefined || windowId === chrome.windows.WINDOW_ID_NONE) return;
  let entry = pendingRegroups.get(windowId);
  if (!entry) {
    entry = { timer: 0, changed: new Set() };
    pendingRegroups.set(windowId, entry);
  }
  if (tabId !== undefined) entry.changed.add(tabId);
  clearTimeout(entry.timer);
  entry.timer = setTimeout(() => {
    pendingRegroups.delete(windowId);
    // Runs are serialized so two passes never create duplicate groups.
    regroupChain = regroupChain
      .then(() => regroupWindow(windowId, entry.changed))
      .catch((error) => console.warn('[TabDeclutter] regroup failed', error))
      .then(scheduleHealthCheck);
  }, REGROUP_DEBOUNCE_MS);
}

function domainLabel(domain) {
  if (DOMAIN_LABELS[domain]) return DOMAIN_LABELS[domain];
  const name = domain.split('.')[0];
  return name.charAt(0).toUpperCase() + name.slice(1);
}

const subKey = (domain, keyword) => `${domain}#${keyword}`;
const subTitle = (domain, keyword) => `${domainLabel(domain)} · ${keyword}`;

/** Stable color per group key, so a cluster keeps its color across sessions. */
function colorFor(key) {
  let hash = 2166136261;
  for (let i = 0; i < key.length; i++) hash = Math.imul(hash ^ key.charCodeAt(i), 16777619);
  return GROUP_COLORS[(hash >>> 0) % GROUP_COLORS.length];
}

/** Distinctive lowercase words of a tab title, in title order, without site boilerplate. */
function titleKeywords(title, domain) {
  // While a page loads, Chrome shows its URL as the title; that carries no topic.
  if (!title || /^\S+[./]\S*$/.test(title.trim())) return [];
  const noise = TITLE_NOISE[domain] ?? [];
  const words = title
    .toLowerCase()
    .split(/[^\p{L}\p{N}#+]+/u)
    .filter((w) => w.length >= 3 && !/^\d+$/.test(w) && !STOPWORDS.has(w) && !noise.includes(w));
  return [...new Set(words)];
}

/**
 * Greedily partitions catch-all tabs into keyword clusters: repeatedly take the keyword shared by
 * the most remaining tabs (ties: longer, then alphabetical) until no keyword is shared by two tabs.
 */
function clusterByKeyword(tabs, domain) {
  let pool = tabs.map((tab) => ({ tab, words: new Set(titleKeywords(tab.title, domain)) }));
  const clusters = [];
  while (pool.length >= MIN_GROUP_SIZE) {
    const counts = new Map();
    for (const { words } of pool) for (const w of words) counts.set(w, (counts.get(w) ?? 0) + 1);
    let best = null;
    let bestCount = MIN_GROUP_SIZE - 1;
    for (const [word, count] of counts) {
      const better =
        count > bestCount ||
        (count === bestCount && best !== null &&
          (word.length > best.length || (word.length === best.length && word < best)));
      if (better) {
        best = word;
        bestCount = count;
      }
    }
    if (best === null) break;
    clusters.push({ keyword: best, tabs: pool.filter((p) => p.words.has(best)).map((p) => p.tab) });
    pool = pool.filter((p) => !p.words.has(best));
  }
  return clusters;
}

/** Group keys a tab qualifies for, most specific first. */
function candidateKeys(tab) {
  const domain = getRootDomain(tabUrl(tab));
  if (!CATCH_ALL_DOMAINS.has(domain)) return [domain];
  return titleKeywords(tab.title, domain).map((kw) => subKey(domain, kw));
}

async function withRetry(operation, attempts = 3) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      // Chrome rejects tab edits while the user is dragging a tab; wait and try again.
      const transient = /dragging|cannot be edited/i.test(String(error?.message));
      if (!transient || attempt >= attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, 400 * attempt));
    }
  }
}

/**
 * Re-evaluates one window. Only tabs that are ungrouped or that just navigated are placed; tabs
 * already sitting in an auto group stay put, and user-created groups are never touched.
 */
async function regroupWindow(windowId, changed) {
  let win;
  try {
    win = await chrome.windows.get(windowId);
  } catch {
    return; // window closed meanwhile
  }
  if (win.type !== 'normal') return; // tab groups exist only in normal windows

  const [tabs, liveGroups, registry, detached] = await Promise.all([
    chrome.tabs.query({ windowId }),
    chrome.tabGroups.query({ windowId }),
    readKey(chrome.storage.local, KEYS.AUTO_GROUPS),
    readKey(chrome.storage.session, 'detachedTabs'),
  ]);

  const groupByKey = new Map(); // key -> live auto group id in this window
  for (const group of liveGroups) {
    const entry = registry[group.id];
    if (entry && !groupByKey.has(entry.key)) groupByKey.set(entry.key, group.id);
  }
  const autoIds = new Set(groupByKey.values());

  const pending = tabs.filter(
    (tab) =>
      !tab.pinned &&
      getRootDomain(tabUrl(tab)) &&
      ((tab.groupId === NO_GROUP && !detached[tab.id]) || (autoIds.has(tab.groupId) && changed.has(tab.id))),
  );

  const placement = new Map(); // key -> { title, tabs }
  const place = (key, title, tab) => {
    if (!placement.has(key)) placement.set(key, { title, tabs: [] });
    placement.get(key).tabs.push(tab);
  };

  // Step 1: join an existing auto group (keeping the current one when it still fits).
  const leftovers = new Map(); // domain -> tabs
  for (const tab of pending) {
    const domain = getRootDomain(tabUrl(tab));
    const keys = candidateKeys(tab);
    const currentKey = registry[tab.groupId]?.key;
    const key = keys.includes(currentKey) ? currentKey : keys.find((k) => groupByKey.has(k));
    if (key) {
      place(key, key === domain ? domainLabel(domain) : subTitle(domain, key.slice(domain.length + 1)), tab);
    } else {
      if (!leftovers.has(domain)) leftovers.set(domain, []);
      leftovers.get(domain).push(tab);
    }
  }

  // Step 2: form new clusters from the rest (Rule 1: same root domain; Rule 2: shared keyword).
  for (const [domain, domainTabs] of leftovers) {
    if (CATCH_ALL_DOMAINS.has(domain)) {
      for (const { keyword, tabs: members } of clusterByKeyword(domainTabs, domain)) {
        for (const tab of members) place(subKey(domain, keyword), subTitle(domain, keyword), tab);
      }
    } else if (domainTabs.length >= MIN_GROUP_SIZE) {
      for (const tab of domainTabs) place(domain, domainLabel(domain), tab);
    }
  }

  // Step 3: tabs that navigated away from their auto group and fit nowhere else leave it.
  const placed = new Set([...placement.values()].flatMap(({ tabs: members }) => members.map((t) => t.id)));
  const released = tabs
    .filter((tab) => autoIds.has(tab.groupId) && changed.has(tab.id) && !placed.has(tab.id))
    .map((tab) => tab.id);
  if (released.length) {
    released.forEach((id) => selfReleased.add(id));
    try {
      await withRetry(() => chrome.tabs.ungroup(released));
    } finally {
      setTimeout(() => released.forEach((id) => selfReleased.delete(id)), 5000);
    }
  }

  // Step 4: apply the placement through the native tab groups API.
  const created = {};
  for (const [key, { title, tabs: members }] of placement) {
    const existingId = groupByKey.get(key);
    const tabIds = members.filter((tab) => tab.groupId !== existingId).map((tab) => tab.id);
    if (!tabIds.length) continue;
    const groupId = await withRetry(() =>
      chrome.tabs.group(
        existingId === undefined ? { tabIds, createProperties: { windowId } } : { groupId: existingId, tabIds },
      ),
    );
    if (existingId === undefined) {
      // Title and color are set only at creation, so a user's rename or recolor is kept.
      await chrome.tabGroups.update(groupId, { title, color: colorFor(key), collapsed: false });
      groupByKey.set(key, groupId);
      created[groupId] = { key, title, createdAt: Date.now() };
    }
  }

  // Step 5: refresh tab counts and the "overloaded" flag of every auto group in this window.
  const counts = countTabsByGroup(await chrome.tabs.query({ windowId }));
  await mutateStorage(chrome.storage.local, KEYS.AUTO_GROUPS, (reg) => {
    Object.assign(reg, created);
    for (const groupId of groupByKey.values()) {
      if (!reg[groupId]) continue;
      const tabCount = counts.get(groupId) ?? 0;
      Object.assign(reg[groupId], { windowId, tabCount, overloaded: tabCount > OVERLOAD_THRESHOLD });
    }
  });
}

/** Recognizes a group restored from a previous session that this extension originally created. */
function inferAutoKey(group, members) {
  const domains = new Set(members.map((tab) => getRootDomain(tabUrl(tab))));
  if (domains.size !== 1) return null;
  const [domain] = domains;
  if (!domain) return null;
  if (group.title === domainLabel(domain)) return domain;
  const prefix = `${domainLabel(domain)} · `;
  if (!CATCH_ALL_DOMAINS.has(domain) || !group.title?.startsWith(prefix)) return null;
  const key = subKey(domain, group.title.slice(prefix.length));
  return members.every((tab) => candidateKeys(tab).includes(key)) ? key : null;
}

/** Brings stored state in line with the real tabs after install, update, or browser start. */
async function reconcile() {
  const [tabs, groups] = await Promise.all([chrome.tabs.query({}), chrome.tabGroups.query({})]);
  const now = Date.now();

  const liveTabIds = new Set(tabs.map((tab) => tab.id));
  await mutateStorage(chrome.storage.local, KEYS.ACCESS, (map) => {
    for (const id of Object.keys(map)) if (!liveTabIds.has(Number(id))) delete map[id];
    for (const tab of tabs) map[tab.id] ??= tab.active ? now : tab.lastAccessed ?? now;
  });

  const membersByGroup = new Map();
  for (const tab of tabs) {
    if (!membersByGroup.has(tab.groupId)) membersByGroup.set(tab.groupId, []);
    membersByGroup.get(tab.groupId).push(tab);
  }
  const liveGroupIds = new Set(groups.map((group) => group.id));
  await mutateStorage(chrome.storage.local, KEYS.AUTO_GROUPS, (registry) => {
    for (const id of Object.keys(registry)) if (!liveGroupIds.has(Number(id))) delete registry[id];
    for (const group of groups) {
      if (registry[group.id]) continue;
      const key = inferAutoKey(group, membersByGroup.get(group.id) ?? []);
      if (key) registry[group.id] = { key, title: group.title, createdAt: now };
    }
  });

  await chrome.storage.session.set({
    activeByWindow: Object.fromEntries(tabs.filter((t) => t.active).map((t) => [t.windowId, t.id])),
    detachedTabs: {},
  });

  for (const windowId of new Set(tabs.map((tab) => tab.windowId))) scheduleRegroup(windowId);
  scheduleHealthCheck();
}

chrome.runtime.onInstalled.addListener(reconcile);
chrome.runtime.onStartup.addListener(reconcile);

// ---------------------------------------------------------------------------------------------
// Health: toolbar badge with the stale count, plus a gentle, rate-limited notification.
// ---------------------------------------------------------------------------------------------

let healthTimer = 0;

function scheduleHealthCheck() {
  clearTimeout(healthTimer);
  healthTimer = setTimeout(() => {
    refreshHealth().catch((error) => console.warn('[TabDeclutter] health check failed', error));
  }, HEALTH_DEBOUNCE_MS);
}

async function refreshHealth() {
  const [tabs, store] = await Promise.all([
    chrome.tabs.query({}),
    chrome.storage.local.get([KEYS.ACCESS, KEYS.AUTO_GROUPS, KEYS.LAST_NUDGE]),
  ]);
  const now = Date.now();
  const access = store[KEYS.ACCESS] ?? {};
  const staleCount = tabs.filter((tab) => isStale(tab, access, now)).length;
  const counts = countTabsByGroup(tabs);
  const overloaded = Object.keys(store[KEYS.AUTO_GROUPS] ?? {}).filter(
    (id) => (counts.get(Number(id)) ?? 0) > OVERLOAD_THRESHOLD,
  ).length;

  await chrome.action.setBadgeBackgroundColor({ color: '#64748b' });
  await chrome.action.setBadgeText({ text: staleCount ? (staleCount > 99 ? '99+' : String(staleCount)) : '' });

  const due = now - (store[KEYS.LAST_NUDGE] ?? 0) > NUDGE_COOLDOWN_MS;
  if (!due || (staleCount < NUDGE_MIN_STALE && !overloaded)) return;

  const parts = [];
  if (staleCount) parts.push(`${staleCount} tab${staleCount === 1 ? '' : 's'} untouched for 2+ hours`);
  if (overloaded) parts.push(`${overloaded} overloaded group${overloaded === 1 ? '' : 's'}`);
  await chrome.storage.local.set({ [KEYS.LAST_NUDGE]: now });
  await chrome.notifications.create(NOTIFICATION_ID, {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: 'Time for a gentle tidy-up?',
    message: `You have ${parts.join(' and ')}. Open TabDeclutter to archive them safely.`,
    priority: 0,
    silent: true,
  });
}

chrome.notifications.onClicked.addListener((id) => {
  if (id !== NOTIFICATION_ID) return;
  chrome.notifications.clear(id);
  chrome.action.openPopup?.().catch(() => {}); // Not available on every Chrome version.
});
