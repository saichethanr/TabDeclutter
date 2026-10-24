// TabDeclutter service worker.
//
// MV3 service workers are terminated whenever they go idle, so every piece of durable state lives
// in chrome.storage (local for data that must survive restarts, session for per-browser-session
// bookkeeping). In-memory values here are only short-lived scheduling helpers.

import {
  STORAGE_KEYS as KEYS,
  OVERLOAD_THRESHOLD,
  STOPWORDS,
  contentStems,
  countTabsByGroup,
  getRootDomain,
  isStale,
  normalizeUrl,
  pageMemory,
  stem,
  tabUrl,
  tokenize,
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
const TITLE_STOPWORDS = new Set([
  ...STOPWORDS,
  'new', 'best', 'top', 'official', 'video', 'videos', 'full', 'part', 'two', 'way', 'home', 'page',
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
  // Single-page apps change the title after the URL, so a pending read is pushed back on title changes.
  if (navigated || (changeInfo.title && indexTimers.has(tabId))) scheduleIndex(tabId);
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
    .filter((w) => w.length >= 3 && !/^\d+$/.test(w) && !TITLE_STOPWORDS.has(w) && !noise.includes(w));
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

// ---------------------------------------------------------------------------------------------
// Topic engine: tabs on different sites about the same subject ("researching rust async" across a
// blog, the docs, and Stack Overflow) are grouped by comparing TF-IDF word profiles built locally
// from each tab's title, URL, and remembered page content.
// ---------------------------------------------------------------------------------------------

const TOPIC_PREFIX = '🔍 ';
const TOPIC_JOIN = 0.3; // similarity needed to form or join a topic
const TOPIC_STAY = 0.15; // lower bar to stay in one, so groups do not flicker
const WEB_NOISE = new Set(
  [
    'sign', 'login', 'log', 'menu', 'search', 'home', 'cookie', 'cookies', 'privacy', 'policy', 'terms',
    'subscribe', 'share', 'comment', 'comments', 'reply', 'account', 'skip', 'content', 'main',
    'navigation', 'click', 'read', 'more', 'next', 'previous', 'copyright', 'rights', 'reserved',
    'loading', 'follow', 'posted', 'updated', 'view', 'views', 'like', 'likes', 'free', 'help',
    'contact', 'official', 'site', 'website', 'page', 'learn', 'new', 'best', 'top', 'video', 'videos',
    'watch', 'question', 'questions', 'answer', 'answers', 'asked', 'modified', 'viewed', 'tagged',
    'issue', 'issues', 'pull', 'request', 'requests', 'wikipedia', 'free', 'encyclopedia', 'article',
    'blog', 'post', 'posts', 'min', 'minute', 'minutes', 'ago', 'year', 'years', 'day', 'days',
  ].map(stem),
);

/** Weighted term profile of one tab, plus the readable spelling of each stem (for labels). */
function topicProfile(tab, page) {
  const url = tabUrl(tab);
  const domain = getRootDomain(url);
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {}
  const siteWords = new Set([...tokenize(host), ...tokenize(domainLabel(domain)), ...(TITLE_NOISE[domain] ?? [])].map(stem));
  const weights = new Map();
  const surface = new Map();
  const keep = (s) => s.length >= 3 && !siteWords.has(s) && !WEB_NOISE.has(s);
  const addText = (text, weight) => {
    for (const word of tokenize(text)) {
      if (word.length < 3 || STOPWORDS.has(word) || /^\d+$/.test(word)) continue;
      const s = stem(word);
      if (!keep(s)) continue;
      weights.set(s, (weights.get(s) ?? 0) + weight);
      if (!surface.has(s)) surface.set(s, word);
    }
  };
  addText(tab.title, 3);
  addText(page?.headings, 2);
  addText(page?.description, 2);
  try {
    addText(new URL(url).pathname.replace(/[-_/.]+/g, ' '), 1);
  } catch {}
  (page?.keywords ?? []).forEach((s, rank) => {
    if (keep(s)) weights.set(s, (weights.get(s) ?? 0) + 1.5 * (1 - rank / 300));
  });
  return { weights, surface };
}

/** Turns raw profiles into unit-length TF-IDF vectors, using page memory as the document corpus. */
function vectorize(profiles, corpus) {
  const df = new Map();
  const count = (terms) => {
    for (const s of new Set(terms)) df.set(s, (df.get(s) ?? 0) + 1);
  };
  for (const page of corpus) count([...(page.keywords ?? []), ...contentStems(page.title)]);
  for (const profile of profiles) count(profile.weights.keys());
  const n = corpus.length + profiles.length;
  for (const profile of profiles) {
    const vector = new Map();
    let norm = 0;
    for (const [s, weight] of profile.weights) {
      const value = weight * (Math.log((n + 1) / ((df.get(s) ?? 0) + 1)) + 1);
      vector.set(s, value);
      norm += value * value;
    }
    norm = Math.sqrt(norm) || 1;
    for (const [s, value] of vector) vector.set(s, value / norm);
    profile.vector = vector;
  }
}

function cosine(a, b) {
  const [small, large] = a.size < b.size ? [a, b] : [b, a];
  let dot = 0;
  for (const [s, value] of small) dot += value * (large.get(s) ?? 0);
  return dot;
}

function centroid(members) {
  const sum = new Map();
  for (const { vector } of members) for (const [s, v] of vector) sum.set(s, (sum.get(s) ?? 0) + v);
  let norm = 0;
  for (const v of sum.values()) norm += v * v;
  norm = Math.sqrt(norm) || 1;
  for (const [s, v] of sum) sum.set(s, v / norm);
  return sum;
}

const distinctDomains = (members) => new Set(members.map((m) => m.domain)).size;

/** Up to two words most shared across the members, e.g. "🔍 Rust async". */
function topicLabel(members) {
  const shared = new Map();
  for (const { vector } of members) for (const [s, v] of vector) shared.set(s, (shared.get(s) ?? 0) + v);
  const inMany = [...shared]
    .filter(([s]) => members.filter((m) => m.vector.has(s)).length >= Math.max(2, Math.ceil(members.length / 2)))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([s]) => members.find((m) => m.surface.has(s))?.surface.get(s) ?? s);
  if (!inMany.length) return null;
  const label = inMany.join(' ');
  return TOPIC_PREFIX + label.charAt(0).toUpperCase() + label.slice(1);
}

/**
 * Assigns cross-site topic groups. Existing topic members stay while they still fit; other tabs
 * join the closest existing topic; the rest form new topics around the best-connected tab, which
 * must gather at least two tabs from at least two different sites.
 */
function assignTopics(candidates, registry) {
  const assignment = new Map(); // tabId -> { key, title }
  const topics = new Map(); // key -> { title, members }

  for (const c of candidates) {
    const key = registry[c.tab.groupId]?.key;
    if (!key?.startsWith('topic:')) continue;
    if (!topics.has(key)) topics.set(key, { title: registry[c.tab.groupId].title, members: [] });
    topics.get(key).members.push(c);
  }
  for (const [key, topic] of topics) {
    topic.members = topic.members.filter(
      (m) => topic.members.length > 1 && cosine(m.vector, centroid(topic.members.filter((o) => o !== m))) >= TOPIC_STAY,
    );
    if (topic.members.length < MIN_GROUP_SIZE || distinctDomains(topic.members) < 2) topics.delete(key);
  }

  for (const c of candidates) {
    if ([...topics.values()].some((t) => t.members.includes(c))) continue;
    let best = null;
    let bestScore = TOPIC_JOIN;
    for (const topic of topics.values()) {
      const score = cosine(c.vector, centroid(topic.members));
      if (score >= bestScore) [best, bestScore] = [topic, score];
    }
    best?.members.push(c);
  }

  const rest = candidates.filter((c) => ![...topics.values()].some((t) => t.members.includes(c)));
  const neighbors = rest.map((c) => rest.filter((d) => d !== c && cosine(c.vector, d.vector) >= TOPIC_JOIN));
  const used = new Set();
  const order = rest.map((_, i) => i).sort((a, b) => neighbors[b].length - neighbors[a].length);
  for (const i of order) {
    if (used.has(rest[i])) continue;
    const members = [rest[i], ...neighbors[i].filter((d) => !used.has(d))];
    if (members.length < MIN_GROUP_SIZE || distinctDomains(members) < 2) continue;
    const title = topicLabel(members);
    if (!title) continue;
    members.forEach((m) => used.add(m));
    const key = `topic:${title.slice(TOPIC_PREFIX.length).toLowerCase()}`;
    const topic = topics.get(key) ?? { title, members: [] };
    topic.members.push(...members);
    topics.set(key, topic);
  }

  for (const [key, { title, members }] of topics) for (const m of members) assignment.set(m.tab.id, { key, title });
  return assignment;
}

/**
 * Re-evaluates one window. Topic groups come first; the rest follow the site rules. Tabs already in
 * a site group stay put unless they navigated or now belong to a topic, and user-created groups
 * are never touched.
 */
async function regroupWindow(windowId, changed) {
  let win;
  try {
    win = await chrome.windows.get(windowId);
  } catch {
    return; // window closed meanwhile
  }
  if (win.type !== 'normal') return; // tab groups exist only in normal windows

  const [tabs, liveGroups, registry, detached, corpus] = await Promise.all([
    chrome.tabs.query({ windowId }),
    chrome.tabGroups.query({ windowId }),
    readKey(chrome.storage.local, KEYS.AUTO_GROUPS),
    readKey(chrome.storage.session, 'detachedTabs'),
    pageMemory.getAll().catch(() => []),
  ]);

  const groupByKey = new Map(); // key -> live auto group id in this window
  for (const group of liveGroups) {
    const entry = registry[group.id];
    if (entry && !groupByKey.has(entry.key)) groupByKey.set(entry.key, group.id);
  }
  const autoIds = new Set(groupByKey.values());
  const keyOf = (tab) => (autoIds.has(tab.groupId) ? registry[tab.groupId].key : undefined);
  // Tabs in a catch-all site's general group (e.g. "YouTube") or in a topic are re-evaluated on
  // every pass, so they can move to a better group as soon as one exists.
  const isFluid = (tab) => CATCH_ALL_DOMAINS.has(keyOf(tab)) || keyOf(tab)?.startsWith('topic:');

  const eligible = tabs.filter(
    (tab) =>
      !tab.pinned &&
      getRootDomain(tabUrl(tab)) &&
      ((tab.groupId === NO_GROUP && !detached[tab.id]) || autoIds.has(tab.groupId)),
  );

  const placement = new Map(); // key -> { title, tabs }
  const place = (key, title, tab) => {
    if (!placement.has(key)) placement.set(key, { title, tabs: [] });
    placement.get(key).tabs.push(tab);
  };

  // Step 0: cross-site topics.
  const pagesByUrl = new Map(corpus.map((page) => [page.url, page]));
  const candidates = eligible.map((tab) => ({
    tab,
    domain: getRootDomain(tabUrl(tab)),
    ...topicProfile(tab, pagesByUrl.get(normalizeUrl(tabUrl(tab)))),
  }));
  vectorize(candidates, corpus);
  const topicOf = assignTopics(candidates, registry);
  for (const tab of eligible) {
    const topic = topicOf.get(tab.id);
    if (topic) place(topic.key, topic.title, tab);
  }

  const pending = eligible.filter(
    (tab) => !topicOf.has(tab.id) && (tab.groupId === NO_GROUP || changed.has(tab.id) || isFluid(tab)),
  );

  // Step 1: join an existing site group (keeping the current one when it still fits).
  const leftovers = new Map(); // domain -> tabs
  for (const tab of pending) {
    const domain = getRootDomain(tabUrl(tab));
    const keys = candidateKeys(tab);
    const currentKey = keyOf(tab);
    const key = keys.includes(currentKey) ? currentKey : keys.find((k) => groupByKey.has(k));
    if (key) {
      place(key, key === domain ? domainLabel(domain) : subTitle(domain, key.slice(domain.length + 1)), tab);
    } else {
      if (!leftovers.has(domain)) leftovers.set(domain, []);
      leftovers.get(domain).push(tab);
    }
  }

  // Step 2: form new site groups from the rest (Rule 1: same root domain; Rule 2: shared keyword).
  for (const [domain, domainTabs] of leftovers) {
    let rest = domainTabs;
    if (CATCH_ALL_DOMAINS.has(domain)) {
      const clustered = new Set();
      for (const { keyword, tabs: members } of clusterByKeyword(domainTabs, domain)) {
        for (const tab of members) {
          place(subKey(domain, keyword), subTitle(domain, keyword), tab);
          clustered.add(tab.id);
        }
      }
      // Catch-all tabs that share no keyword still belong together under the site's name.
      rest = domainTabs.filter((tab) => !clustered.has(tab.id));
    }
    if (rest.length >= MIN_GROUP_SIZE) {
      for (const tab of rest) place(domain, domainLabel(domain), tab);
    }
  }

  // Step 3: re-evaluated tabs that fit nowhere leave their auto group.
  const placed = new Set([...placement.values()].flatMap(({ tabs: members }) => members.map((t) => t.id)));
  await release(
    pending.filter((tab) => autoIds.has(tab.groupId) && !placed.has(tab.id)).map((tab) => tab.id),
  );
  // Tabs that navigated to a page that cannot be grouped (e.g. chrome://newtab) leave too.
  await release(
    tabs.filter((tab) => autoIds.has(tab.groupId) && changed.has(tab.id) && !getRootDomain(tabUrl(tab))).map((t) => t.id),
  );

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
      autoIds.add(groupId);
      created[groupId] = { key, title, createdAt: Date.now() };
    }
  }

  // Step 5: a group left with a single tab (its siblings moved to a topic or closed) dissolves.
  let finalTabs = await chrome.tabs.query({ windowId });
  let counts = countTabsByGroup(finalTabs);
  const singles = finalTabs.filter((tab) => autoIds.has(tab.groupId) && counts.get(tab.groupId) === 1);
  if (singles.length) {
    await release(singles.map((tab) => tab.id));
    finalTabs = await chrome.tabs.query({ windowId });
    counts = countTabsByGroup(finalTabs);
  }

  // Step 6: refresh tab counts and the "overloaded" flag of every auto group in this window.
  await mutateStorage(chrome.storage.local, KEYS.AUTO_GROUPS, (reg) => {
    Object.assign(reg, created);
    for (const groupId of autoIds) {
      if (!reg[groupId]) continue;
      const tabCount = counts.get(groupId) ?? 0;
      Object.assign(reg[groupId], { windowId, tabCount, overloaded: tabCount > OVERLOAD_THRESHOLD });
    }
  });
}

/** Ungroups tabs on the extension's behalf (not recorded as a user "drag out"). */
async function release(tabIds) {
  if (!tabIds.length) return;
  tabIds.forEach((id) => selfReleased.add(id));
  try {
    await withRetry(() => chrome.tabs.ungroup(tabIds));
  } finally {
    setTimeout(() => tabIds.forEach((id) => selfReleased.delete(id)), 5000);
  }
}

/** Recognizes a group restored from a previous session that this extension originally created. */
function inferAutoKey(group, members) {
  if (group.title?.startsWith(TOPIC_PREFIX)) return `topic:${group.title.slice(TOPIC_PREFIX.length).toLowerCase()}`;
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
  tabs.forEach((tab, i) => setTimeout(() => scheduleIndex(tab.id), i * 100)); // stagger the reads
  scheduleHealthCheck();
}

// ---------------------------------------------------------------------------------------------
// Page memory: after a page settles, read what it is about (description, headings, frequent words)
// and keep it in IndexedDB on this device. Search uses it to find open and closed pages by content,
// and the topic engine uses it to relate tabs across sites. Nothing is sent anywhere.
// ---------------------------------------------------------------------------------------------

const INDEX_DELAY_MS = 1500;
const KEYWORDS_PER_PAGE = 150;
const indexTimers = new Map(); // tabId -> timer

function scheduleIndex(tabId) {
  clearTimeout(indexTimers.get(tabId));
  indexTimers.set(
    tabId,
    setTimeout(() => {
      indexTimers.delete(tabId);
      indexTab(tabId).catch((error) => console.warn('[TabDeclutter] page memory failed', error));
    }, INDEX_DELAY_MS),
  );
}

/** Runs inside the page. Returns null for pages that look sensitive (password fields). */
function readPage() {
  if (document.querySelector('input[type="password"]')) return null;
  const clean = (text) => (text ?? '').replace(/\s+/g, ' ').trim();
  const meta = (name) =>
    document.querySelector(`meta[name="${name}" i], meta[property="${name}" i]`)?.getAttribute('content') ?? '';
  const headings = [...document.querySelectorAll('h1, h2, h3')].map((h) => clean(h.textContent)).filter(Boolean);
  const root = document.querySelector('main, article, [role="main"]') ?? document.body;
  return {
    description: clean(meta('description') || meta('og:description')).slice(0, 400),
    headings: [...new Set(headings)].slice(0, 15).join(' · ').slice(0, 600),
    text: clean(root?.innerText).slice(0, 30000),
  };
}

async function indexTab(tabId) {
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return; // closed meanwhile
  }
  const url = tabUrl(tab);
  if (tab.incognito || tab.status !== 'complete' || !getRootDomain(url)) return;
  if ((await chrome.storage.local.get(KEYS.MEMORY_PAUSED))[KEYS.MEMORY_PAUSED]) return;

  let page = { description: '', headings: '', text: '' };
  try {
    const [injection] = await chrome.scripting.executeScript({ target: { tabId }, func: readPage });
    page = injection?.result;
  } catch {
    // Pages Chrome does not let extensions read (Web Store, error pages): keep the title and URL.
  }
  if (!page) return; // sensitive page: not remembered at all

  const counts = new Map();
  for (const s of contentStems(`${tab.title} ${page.headings} ${page.description} ${page.text}`)) {
    counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  await pageMemory.remember({
    url: normalizeUrl(url),
    title: tab.title || url,
    host: new URL(url).hostname,
    favIconUrl: /^https?:/.test(tab.favIconUrl ?? '') ? tab.favIconUrl : '',
    description: page.description,
    headings: page.headings,
    keywords: [...counts].sort((a, b) => b[1] - a[1]).slice(0, KEYWORDS_PER_PAGE).map(([s]) => s),
    lastVisited: Date.now(),
  });
  scheduleRegroup(tab.windowId, tabId); // new content may reveal a cross-site topic
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
