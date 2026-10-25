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
  searchQueryFromUrl,
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

// Rule 2: domains that host unrelated content (search, video, Q&A, AI chat). Their tabs are never
// grouped just for sharing the site: they go to topic groups by content, keyword sub-groups by
// title, and only then to a general group for the site.
const CATCH_ALL_DOMAINS = new Set([
  'google.com', 'youtube.com', 'stackoverflow.com', 'chatgpt.com', 'openai.com', 'claude.ai', 'perplexity.ai',
]);
const TITLE_NOISE = {
  'google.com': ['google', 'search'],
  'youtube.com': ['youtube'],
  'stackoverflow.com': ['stack', 'overflow', 'stackoverflow'],
  'chatgpt.com': ['chatgpt'],
  'openai.com': ['chatgpt', 'openai'],
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
  // The tab the user just left is now in its settled state (e.g. a finished chat answer): re-read it.
  if (previous !== undefined && previous !== tabId) scheduleIndex(previous);
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
  // Pages that fill in after loading (chat answers, single-page apps) usually retitle themselves,
  // so a title change triggers a fresh read.
  if (navigated || changeInfo.title) scheduleIndex(tabId, { navigated: Boolean(navigated) });
});

chrome.tabs.onRemoved.addListener((tabId, { windowId, isWindowClosing }) => {
  lastRead.delete(tabId);
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
  if (domain === 'file:') return 'Local files';
  if (domain === 'chrome:') return 'Browser pages';
  if (domain.startsWith('chrome-extension://')) return 'Extension pages';
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
// Topic engine: tabs about the same subject are grouped by what their pages say, whether they are
// on different sites ("rust async" across a blog, the docs, and Stack Overflow) or on one site (two
// ChatGPT chats about Claude Code). It compares TF-IDF word profiles built locally from each tab's
// title, URL, and remembered page content, ignoring text a site repeats on all its pages.
// ---------------------------------------------------------------------------------------------

const TOPIC_PREFIX = '🔍 ';
const TOPIC_JOIN = 0.3; // similarity needed to form or join a topic
const TOPIC_STAY = 0.15; // lower bar to stay in one, so groups do not flicker
// Pages sharing a key term must also overlap this much in their other words (raw word weights, so
// it does not swing with the size of page memory). A word with two meanings ("rust" the language
// vs. rust on cast iron) or a generic one ("recipe") is not enough on its own.
const KEY_TERM_CONTEXT = 0.09;
const KEY_TERMS_PER_PAGE = 8;
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
    // Generic words that appear on pages about anything.
    'first', 'second', 'third', 'make', 'made', 'good', 'great', 'well', 'really', 'time', 'thing',
    'things', 'want', 'need', 'try', 'keep', 'start', 'ask', 'know', 'think', 'look', 'right',
    'left', 'easy', 'hard', 'lot', 'sure', 'way', 'give', 'take', 'come', 'going', 'bit', 'even',
    'still', 'every', 'without', 'always', 'never', 'often', 'usually', 'example', 'yes', 'okay',
  ].map(stem),
);

// ---------------------------------------------------------------------------------------------
// Page memory statistics: how many remembered pages use each word, and the text each site repeats.
// Kept in the service worker and updated as pages are remembered, so a regroup pass reads only the
// open tabs' pages instead of the whole memory (up to PAGE_MEMORY_LIMIT pages).
// ---------------------------------------------------------------------------------------------

let corpusStats = null; // Promise<{ n, df, sites }>

function countPage(stats, page, sign) {
  const bump = (map, key) => {
    const value = (map.get(key) ?? 0) + sign;
    if (value > 0) map.set(key, value);
    else map.delete(key);
  };
  stats.n += sign;
  for (const s of new Set([...(page.keywords ?? []), ...contentStems(page.title)])) bump(stats.df, s);
  const domain = getRootDomain(page.url);
  if (!domain) return;
  let site = stats.sites.get(domain);
  if (!site) {
    site = { pages: 0, descriptions: new Map(), headings: new Map(), terms: new Map(), titles: new Map() };
    stats.sites.set(domain, site);
  }
  site.pages += sign;
  if (page.description) bump(site.descriptions, page.description.trim().toLowerCase());
  for (const heading of new Set((page.headings ?? '').split(' · '))) if (heading) bump(site.headings, heading.trim().toLowerCase());
  for (const s of new Set(page.keywords ?? [])) bump(site.terms, s);
  if (page.title?.trim()) bump(site.titles, page.title.trim().toLowerCase());
}

/** The statistics, built from page memory once per service worker run (or after a Clear). */
async function loadCorpusStats() {
  const count = await pageMemory.count().catch(() => 0);
  if (corpusStats && (await corpusStats).n === count) return corpusStats;
  corpusStats = pageMemory
    .getAll()
    .catch(() => [])
    .then((pages) => {
      const stats = { n: 0, df: new Map(), sites: new Map() };
      for (const page of pages) countPage(stats, page, 1);
      return stats;
    });
  return corpusStats;
}

/**
 * Text a site repeats across its pages says nothing about any one page: a shared meta description
 * (every ChatGPT chat has the same one), a shared title ("ChatGPT", "ShopKart: Online Shopping"),
 * navigation headings, and interface words. Learned per site from page memory and the open tabs.
 */
function siteBoilerplate(stats, tabs, pagesByUrl) {
  const repeated = (map, min) => new Set([...(map ?? [])].filter(([, n]) => n >= min).map(([text]) => text));
  // Live titles of open tabs that page memory does not have yet count as pages too.
  const liveTitles = new Map(); // domain -> Map(title -> number of URLs)
  const seen = new Set();
  for (const tab of tabs) {
    const url = normalizeUrl(tabUrl(tab));
    const domain = getRootDomain(url);
    const title = tab.title?.trim().toLowerCase();
    if (!domain || !title || seen.has(`${url} ${title}`) || pagesByUrl.get(url)?.title?.trim().toLowerCase() === title) continue;
    seen.add(`${url} ${title}`);
    if (!liveTitles.has(domain)) liveTitles.set(domain, new Map());
    liveTitles.get(domain).set(title, (liveTitles.get(domain).get(title) ?? 0) + 1);
  }
  const boilerplate = new Map();
  for (const domain of new Set(tabs.map((tab) => getRootDomain(tabUrl(tab))).filter(Boolean))) {
    const site = stats.sites.get(domain);
    const titles = new Map(site?.titles);
    for (const [title, n] of liveTitles.get(domain) ?? []) titles.set(title, (titles.get(title) ?? 0) + n);
    boilerplate.set(domain, {
      descriptions: repeated(site?.descriptions, 2),
      headings: repeated(site?.headings, 3),
      // With enough pages, words on most of a site's pages are interface text.
      terms: site?.pages >= 5 ? repeated(site.terms, Math.ceil(site.pages * 0.6)) : new Set(),
      titles: repeated(titles, 2),
    });
  }
  return boilerplate;
}

/** Numbers, hashes and IDs ("6adc5e35", "2024") say nothing about a topic. */
const isIdLike = (word) => /^\d+$/.test(word) || (/\d/.test(word) && word.length >= 6);

/** Weighted term profile of one tab, plus the readable spelling of each stem (for labels). */
function topicProfile(tab, page, boilerplate) {
  const url = tabUrl(tab);
  const domain = getRootDomain(url);
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {}
  const siteText = boilerplate.get(domain);
  // Words of a title the site gives many pages ("AskBot", "ShopKart: Online Shopping") name the site.
  const siteTitleWords = [...(siteText?.titles ?? [])].flatMap((title) => tokenize(title));
  const siteWords = new Set(
    [...tokenize(host), ...tokenize(domainLabel(domain)), ...(TITLE_NOISE[domain] ?? []), ...siteTitleWords].map(stem),
  );
  const weights = new Map();
  const surface = new Map();
  const keep = (s) => s.length >= 3 && !siteWords.has(s) && !WEB_NOISE.has(s) && !siteText?.terms.has(s);
  const addText = (text, weight) => {
    for (const word of tokenize(text)) {
      if (word.length < 3 || STOPWORDS.has(word) || isIdLike(word)) continue;
      const s = stem(word);
      if (!keep(s)) continue;
      weights.set(s, (weights.get(s) ?? 0) + weight);
      if (!surface.has(s)) surface.set(s, word);
    }
  };
  // What the user searched or asked is the clearest statement of a page's theme, and the URL's
  // search query is known even before the page loads (or for tabs Chrome has not loaded yet).
  const query = searchQueryFromUrl(url);
  const title = siteText?.titles.has((tab.title ?? '').trim().toLowerCase()) ? '' : tab.title;
  addText(title, 3);
  addText(query, 3);
  addText(page?.intent, 2.5);
  const headings = (page?.headings ?? '').split(' · ').filter((h) => !siteText?.headings.has(h.trim().toLowerCase()));
  addText(headings.join(' '), 1.5);
  if (!siteText?.descriptions.has((page?.description ?? '').trim().toLowerCase())) addText(page?.description, 2);
  try {
    addText(new URL(url).pathname.replace(/[-_/.]+/g, ' '), 1);
  } catch {}
  // The words a page keeps repeating carry its topic, so page words weigh by how often they occur
  // (log-scaled). Pages remembered before counts were stored fall back to their frequency rank.
  (page?.keywords ?? []).forEach((s, rank) => {
    if (!keep(s) || isIdLike(s)) return;
    const count = page.keywordCounts?.[rank];
    const weight = count ? 1 + Math.log(count) : 2 / (1 + rank / 8);
    weights.set(s, (weights.get(s) ?? 0) + weight);
  });

  // Key terms: the few words a page repeats most, plus its title words. Two chats about guitars
  // can share little else ("F chord" vs "buying an acoustic"), but both keep saying "guitar".
  const prominence = new Map();
  (page?.keywords ?? []).forEach((s, rank) => {
    if (keep(s) && !isIdLike(s)) prominence.set(s, page.keywordCounts?.[rank] ?? Math.max(1, 6 - rank / 5));
  });
  for (const word of tokenize(`${title} ${query} ${page?.intent ?? ''}`)) {
    const s = stem(word);
    if (word.length >= 3 && !STOPWORDS.has(word) && !isIdLike(word) && keep(s)) prominence.set(s, (prominence.get(s) ?? 0) + 3);
  }
  const keyTerms = new Set(
    [...prominence]
      .filter(([, score]) => score >= 3)
      .sort((a, b) => b[1] - a[1])
      .slice(0, KEY_TERMS_PER_PAGE)
      .map(([s]) => s),
  );
  return { weights, surface, keyTerms, url: normalizeUrl(url) };
}

/** Turns raw profiles into unit-length TF-IDF vectors, using page memory as the document corpus. */
function vectorize(profiles, stats, remembered) {
  // Open tabs already in page memory are in the statistics; count only the ones that are not.
  const unseen = new Map();
  const unseenProfiles = profiles.filter((profile) => !remembered.has(profile.url));
  for (const profile of unseenProfiles) for (const s of profile.weights.keys()) unseen.set(s, (unseen.get(s) ?? 0) + 1);
  const n = stats.n + unseenProfiles.length;
  const df = (s) => (stats.df.get(s) ?? 0) + (unseen.get(s) ?? 0);
  for (const profile of profiles) {
    const vector = new Map();
    let norm = 0;
    for (const [s, weight] of profile.weights) {
      const value = weight * (Math.log((n + 1) / (df(s) + 1)) + 1);
      vector.set(s, value);
      norm += value * value;
    }
    norm = Math.sqrt(norm) || 1;
    for (const [s, value] of vector) vector.set(s, value / norm);
    profile.vector = vector;
  }
  return { df, n };
}

function cosine(a, b) {
  const [small, large] = a.size < b.size ? [a, b] : [b, a];
  let dot = 0;
  for (const [s, value] of small) dot += value * (large.get(s) ?? 0);
  return dot;
}

function sharedTerms(a, b) {
  let count = 0;
  for (const s of a.keys()) if (b.has(s)) count++;
  return count;
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

/** The words most shared across the members, key terms first, e.g. "🔍 Rust async" or "🔍 Guitar". */
function topicLabel(members) {
  const need = Math.max(2, Math.ceil(members.length / 2));
  const sharedBy = (s, field) => members.filter((m) => m[field].has(s)).length;
  const weight = new Map();
  for (const { vector } of members) for (const [s, v] of vector) weight.set(s, (weight.get(s) ?? 0) + v);
  const ranked = [...weight]
    .filter(([s]) => sharedBy(s, 'vector') >= need)
    .map(([s, w]) => ({ s, w, key: sharedBy(s, 'keyTerms') >= need }))
    .sort((a, b) => b.key - a.key || b.w - a.w);
  if (!ranked.length) return null;
  const [first, second] = ranked;
  // A second word only when it is just as central to the members, so a label never reads like a
  // sub-topic of one page ("Guitar", not "Guitar chord").
  const most = Math.ceil(members.length * 0.75);
  const central = (s) => sharedBy(s, 'vector') >= most && (!first.key || sharedBy(s, 'keyTerms') >= most);
  const words = second && central(second.s) && (first.key ? second.key : second.w >= 0.6 * first.w) ? [first, second] : [first];
  const label = words.map(({ s }) => members.find((m) => m.surface.has(s))?.surface.get(s) ?? s).join(' ');
  return TOPIC_PREFIX + label.charAt(0).toUpperCase() + label.slice(1);
}

/** Cosine similarity of two vectors after removing some terms (and renormalizing). */
function cosineWithout(a, b, drop) {
  const trim = (vector) => {
    const kept = [...vector].filter(([s]) => !drop.has(s));
    const norm = Math.sqrt(kept.reduce((sum, [, v]) => sum + v * v, 0)) || 1;
    return new Map(kept.map(([s, v]) => [s, v / norm]));
  };
  return cosine(trim(a), trim(b));
}

/**
 * Assigns topic groups. Two tabs are related when their word profiles are similar overall, or when
 * they share a key term that is uncommon across the user's pages and their other words still
 * overlap (two guitar chats both mention strings, chords and capos).
 * Existing topic members stay while they still fit; other tabs join the closest fitting topic; the
 * rest form new topics around the best-connected tab.
 */
function assignTopics(candidates, registry, isRare) {
  const related = (a, b) => {
    // A single shared word is not enough on its own: before a page loads its profile can be just
    // a few title words, and "beginner" alone does not make two pages one topic.
    if (cosine(a.vector, b.vector) >= TOPIC_JOIN && sharedTerms(a.vector, b.vector) >= 2) return true;
    const shared = new Set([...a.keyTerms].filter((s) => b.keyTerms.has(s) && isRare(s)));
    return shared.size > 0 && cosineWithout(a.weights, b.weights, shared) >= KEY_TERM_CONTEXT;
  };

  const topics = new Map(); // key -> { title, members }
  for (const c of candidates) {
    const key = registry[c.tab.groupId]?.key;
    if (!key?.startsWith('topic:')) continue;
    if (!topics.has(key)) topics.set(key, { title: registry[c.tab.groupId].title, members: [] });
    topics.get(key).members.push(c);
  }
  for (const [key, topic] of topics) {
    topic.members = topic.members.filter((m) => {
      const others = topic.members.filter((o) => o !== m);
      if (!others.length) return false;
      const rest = centroid(others);
      return (cosine(m.vector, rest) >= TOPIC_STAY && sharedTerms(m.vector, rest) >= 2) || others.some((o) => related(m, o));
    });
    if (topic.members.length < MIN_GROUP_SIZE) topics.delete(key);
  }
  // Topics formed from half-loaded pages ("Strings", "Beginners") merge once the pages show they
  // are one subject: most pairs across the two are related. The larger topic keeps its group.
  const ordered = [...topics].sort((a, b) => b[1].members.length - a[1].members.length);
  for (const [i, [bigKey, big]] of ordered.entries()) {
    for (const [key, small] of ordered.slice(i + 1)) {
      if (!topics.has(bigKey) || !topics.has(key)) continue;
      const pairs = small.members.flatMap((a) => big.members.map((b) => related(a, b)));
      if (2 * pairs.filter(Boolean).length > pairs.length) {
        big.members.push(...small.members);
        small.members = [];
        topics.delete(key);
      }
    }
  }
  const inTopic = (c) => [...topics.values()].some((t) => t.members.includes(c));

  for (const c of candidates) {
    if (inTopic(c)) continue;
    let best = null;
    let bestScore = -1;
    for (const topic of topics.values()) {
      const center = centroid(topic.members);
      const similarity = cosine(c.vector, center);
      const fits = (similarity >= TOPIC_JOIN && sharedTerms(c.vector, center) >= 2) || 2 * topic.members.filter((m) => related(c, m)).length >= topic.members.length;
      if (fits && similarity > bestScore) [best, bestScore] = [topic, similarity];
    }
    best?.members.push(c);
  }

  const rest = candidates.filter((c) => !inTopic(c));
  const neighbors = rest.map((c) => rest.filter((d) => d !== c && related(c, d)));
  const used = new Set();
  const order = rest.map((_, i) => i).sort((a, b) => neighbors[b].length - neighbors[a].length);
  for (const i of order) {
    if (used.has(rest[i])) continue;
    const members = [rest[i], ...neighbors[i].filter((d) => !used.has(d))];
    if (members.length < MIN_GROUP_SIZE) continue;
    const title = topicLabel(members);
    if (!title) continue;
    members.forEach((m) => used.add(m));
    const key = `topic:${title.slice(TOPIC_PREFIX.length).toLowerCase()}`;
    const topic = topics.get(key) ?? { title, members: [] };
    topic.members.push(...members);
    topics.set(key, topic);
  }

  // Labels follow the members: a topic formed from half-loaded pages gets a better name once
  // their content is in. The key stays, so the group itself is kept.
  const assignment = new Map(); // tabId -> { key, title }
  for (const [key, topic] of topics) {
    const title = topicLabel(topic.members) ?? topic.title;
    for (const m of topic.members) assignment.set(m.tab.id, { key, title });
  }
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

  const [tabs, liveGroups, registry, detached, stats] = await Promise.all([
    chrome.tabs.query({ windowId }),
    chrome.tabGroups.query({ windowId }),
    readKey(chrome.storage.local, KEYS.AUTO_GROUPS),
    readKey(chrome.storage.session, 'detachedTabs'),
    loadCorpusStats(),
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

  // Step 0: topics, by page content. These take priority over site groups.
  const urls = [...new Set(tabs.map((tab) => normalizeUrl(tabUrl(tab))))];
  const pages = await pageMemory.getMany(urls).catch(() => []);
  const pagesByUrl = new Map(pages.filter(Boolean).map((page) => [page.url, page]));
  const boilerplate = siteBoilerplate(stats, tabs, pagesByUrl);
  const candidates = eligible.map((tab) => ({
    tab,
    ...topicProfile(tab, pagesByUrl.get(normalizeUrl(tabUrl(tab))), boilerplate),
  }));
  const { df, n } = vectorize(candidates, stats, new Set(pagesByUrl.keys()));
  // A key term only links pages if it is not on most of everything the user reads. The bar is
  // high on purpose: while researching a subject, its word is on many of the user's pages.
  const isRare = (s) => n < 20 || df(s) / n <= 0.5;
  const topicOf = assignTopics(candidates, registry, isRare);
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
  const renamed = {};
  for (const [key, { title, tabs: members }] of placement) {
    const existingId = groupByKey.get(key);
    // A topic's label is refreshed as its pages fill in, unless the user renamed the group.
    const live = liveGroups.find((group) => group.id === existingId);
    if (key.startsWith('topic:') && live && live.title !== title && live.title === registry[existingId]?.title) {
      await chrome.tabGroups.update(existingId, { title });
      renamed[existingId] = title;
    }
    const tabIds = members.filter((tab) => tab.groupId !== existingId).map((tab) => tab.id);
    if (!tabIds.length) continue;
    const groupId = await withRetry(() =>
      chrome.tabs.group(
        existingId === undefined ? { tabIds, createProperties: { windowId } } : { groupId: existingId, tabIds },
      ),
    );
    if (existingId === undefined) {
      // Color is set only at creation and titles change only while unrenamed, so a user's rename
      // or recolor is kept.
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
    for (const [groupId, title] of Object.entries(renamed)) if (reg[groupId]) reg[groupId].title = title;
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
const REREAD_GAP_MS = 10000; // a tab that did not navigate is read at most this often
const KEYWORDS_PER_PAGE = 150;
const indexTimers = new Map(); // tabId -> timer
const lastRead = new Map(); // tabId -> time of the last read

/**
 * Reads the tab soon (1.5 s). Repeated reads of a tab that did not navigate (title changes, leaving
 * the tab, the content watcher) wait until REREAD_GAP_MS after the previous one, so pages that
 * retitle themselves constantly ("(1) New message") cost one read per gap at most.
 */
function scheduleIndex(tabId, { navigated = false } = {}) {
  const wait = navigated ? INDEX_DELAY_MS : Math.max(INDEX_DELAY_MS, (lastRead.get(tabId) ?? 0) + REREAD_GAP_MS - Date.now());
  clearTimeout(indexTimers.get(tabId));
  indexTimers.set(
    tabId,
    setTimeout(() => {
      indexTimers.delete(tabId);
      // The first read after a page load (a chat retitling itself, results arriving) stays quick.
      lastRead.set(tabId, navigated ? 0 : Date.now());
      indexTab(tabId).catch((error) => console.warn('[TabDeclutter] page memory failed', error));
    }, wait),
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
  // What the user searched or asked: the site's search box, and messages they sent on AI chat sites
  // (ChatGPT, Claude, Gemini). Sent messages only; nothing is read while being typed in a chat box.
  const searchBox = document.querySelector(
    'input[type="search"], input[role="searchbox"], input[role="combobox"][name], input[name="q"], input[name="query"], input[name="search_query"], input[name="search"]',
  );
  const asked = [...document.querySelectorAll('[data-message-author-role="user"], [data-testid="user-message"], user-query')]
    .map((el) => clean(el.innerText))
    .filter(Boolean);
  return {
    description: clean(meta('description') || meta('og:description')).slice(0, 400),
    headings: [...new Set(headings)].slice(0, 15).join(' · ').slice(0, 600),
    intent: [clean(searchBox?.value), ...asked.slice(0, 10)].filter(Boolean).join(' · ').slice(0, 1000),
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
  // Web pages and local files are remembered; browser and extension pages are not readable.
  if (tab.incognito || tab.status !== 'complete' || !/^(https?|file):/.test(url) || !getRootDomain(url)) return;
  if ((await chrome.storage.local.get(KEYS.MEMORY_PAUSED))[KEYS.MEMORY_PAUSED]) return;

  let page = { description: '', headings: '', intent: '', text: '' };
  try {
    const [injection] = await chrome.scripting.executeScript({ target: { tabId }, func: readPage });
    page = injection?.result;
    // The watcher asks for a fresh read whenever the page's content changes and settles.
    if (page) await chrome.scripting.executeScript({ target: { tabId }, files: ['watch.js'] });
  } catch {
    // Pages Chrome does not let extensions read (Web Store, error pages): keep the title and URL.
  }
  if (!page) return; // sensitive page: not remembered at all

  const counts = new Map();
  for (const s of contentStems(`${tab.title} ${page.intent} ${page.headings} ${page.description} ${page.text}`)) {
    counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  const top = [...counts].sort((a, b) => b[1] - a[1]).slice(0, KEYWORDS_PER_PAGE);
  const record = {
    url: normalizeUrl(url),
    title: tab.title || url,
    host: new URL(url).hostname,
    favIconUrl: /^https?:/.test(tab.favIconUrl ?? '') ? tab.favIconUrl : '',
    description: page.description,
    headings: page.headings,
    intent: page.intent,
    keywords: top.map(([s]) => s),
    keywordCounts: top.map(([, n]) => n),
    lastVisited: Date.now(),
  };
  // Most re-reads find the same page (a flashing title, a ticking counter). Then there is nothing to
  // save or regroup; only the visit time is refreshed now and then for memory eviction.
  const previous = await pageMemory.get(record.url).catch(() => undefined);
  const same = (field) => String(previous?.[field]) === String(record[field]);
  const unchanged = previous && ['title', 'description', 'headings', 'intent', 'keywords', 'keywordCounts'].every(same);
  if (unchanged && record.lastVisited - previous.lastVisited < 10 * 60 * 1000) return;
  const { previous: replaced, saved, evicted } = await pageMemory.remember(record);
  const stats = corpusStats && (await corpusStats);
  if (stats) {
    if (replaced) countPage(stats, replaced, -1);
    countPage(stats, saved, 1);
    for (const page of evicted) countPage(stats, page, -1);
  }
  if (!unchanged) scheduleRegroup(tab.windowId, tabId); // new content may reveal a cross-site topic
}

// From watch.js: the page's content changed and has settled (results loaded, a chat answer finished).
chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type === 'page-settled' && sender.tab?.id !== undefined) scheduleIndex(sender.tab.id);
});

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
