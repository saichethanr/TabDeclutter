import {
  ARCHIVE_LIMIT,
  OVERLOAD_THRESHOLD,
  STOPWORDS,
  STORAGE_KEYS as KEYS,
  contentStems,
  getLastAccessed,
  getRootDomain,
  isStale,
  normalizeUrl,
  pageMemory,
  searchQueryFromUrl,
  stem,
  tabUrl,
  tokenize,
} from './shared.js';

const MAX_OPEN_RESULTS = 6;
const MAX_CLOSED_RESULTS = 6;
const HISTORY_SHOWN = 15;

// Words that carry no search signal ("Where is my PR tab for ...", "that thing I saw yesterday").
const QUERY_STOPWORDS = new Set([
  'where', 'is', 'my', 'a', 'an', 'of', 'to', 'in', 'on', 'at', 'or', 'tab', 'tabs', 'find', 'show',
  'me', 'i', 'im', 'it', 'do', 'you', 'please', 'whats', 'wheres', 'open', 'opened', 'closed', 'page',
  'pages', 'site', 'website', 'thing', 'something', 'stuff', 'saw', 'seen', 'looking', 'reading',
  'read', 'earlier', 'yesterday', 'today', 'week', 'ago', 'remember', 'think', 'was', 'that', 'the',
]);
// Intent weighting: these signal code-hosting work, so github.com tabs rank higher.
const CODE_INTENT = /\b(prs?|pull[\s-]*requests?|code|issues?)\b/;
const INTENT_WORDS = new Set(['pr', 'prs', 'pull', 'request', 'requests', 'code', 'issue', 'issues']);
// Extra spellings matched literally against titles and URLs (GitHub PR URLs contain "/pull/").
const SYNONYMS = { pr: ['pull'], prs: ['pull', 'pulls'], issue: ['issues'], issues: ['issue'] };

// What people remember about a page ("that video", "the spreadsheet") mapped to the sites that
// serve it. A site pattern with a slash also matches the path (docs.google.com/spreadsheets).
const CONCEPTS = [
  [['video', 'watch', 'clip', 'stream', 'vlog', 'movie', 'film', 'trailer', 'episode', 'yt'],
    ['youtube.com', 'youtu.be', 'vimeo.com', 'twitch.tv', 'netflix.com', 'primevideo.com', 'hotstar.com']],
  [['music', 'song', 'playlist', 'album', 'podcast'],
    ['music.youtube.com', 'youtube.com', 'spotify.com', 'soundcloud.com', 'music.apple.com']],
  [['code', 'repo', 'repository', 'pr', 'pull', 'commit', 'branch', 'merge', 'issue', 'bug', 'review', 'gh'],
    ['github.com', 'gitlab.com', 'bitbucket.org']],
  [['question', 'answer', 'error', 'exception', 'stacktrace', 'howto', 'solution', 'fix'],
    ['stackoverflow.com', 'stackexchange.com', 'superuser.com', 'serverfault.com', 'askubuntu.com']],
  [['mail', 'email', 'inbox', 'gmail'],
    ['mail.google.com', 'outlook.live.com', 'outlook.office.com', 'outlook.office365.com', 'mail.yahoo.com', 'mail.proton.me']],
  [['docs', 'documentation', 'reference', 'api', 'manual', 'guide'],
    ['developer.mozilla.org', 'readthedocs.io', 'devdocs.io', 'docs.python.org', 'docs.github.com', 'learn.microsoft.com', 'developer.chrome.com']],
  [['doc', 'document', 'draft', 'notes', 'writeup'],
    ['docs.google.com/document', 'notion.so', 'notion.site', 'onedrive.live.com']],
  [['sheet', 'spreadsheet', 'excel', 'table'], ['docs.google.com/spreadsheets', 'airtable.com']],
  [['slide', 'presentation', 'deck', 'ppt'], ['docs.google.com/presentation', 'canva.com', 'pitch.com']],
  [['meeting', 'meet', 'call', 'calendar', 'schedule', 'event', 'invite'],
    ['calendar.google.com', 'meet.google.com', 'zoom.us', 'teams.microsoft.com', 'calendly.com']],
  [['chat', 'ai', 'gpt', 'chatgpt', 'llm', 'prompt', 'assistant', 'claude', 'gemini'],
    ['chatgpt.com', 'chat.openai.com', 'claude.ai', 'gemini.google.com', 'perplexity.ai', 'copilot.microsoft.com']],
  [['message', 'dm', 'slack', 'discord', 'whatsapp', 'telegram'],
    ['slack.com', 'discord.com', 'web.whatsapp.com', 'web.telegram.org']],
  [['social', 'tweet', 'twitter', 'post', 'thread', 'feed', 'fb', 'insta', 'ig'],
    ['x.com', 'twitter.com', 'linkedin.com', 'reddit.com', 'facebook.com', 'instagram.com', 'threads.net', 'bsky.app']],
  [['news', 'article', 'headline', 'blog', 'hn'],
    ['news.ycombinator.com', 'news.google.com', 'nytimes.com', 'bbc.com', 'bbc.co.uk', 'theverge.com', 'techcrunch.com',
      'medium.com', 'substack.com', 'theguardian.com', 'reuters.com', 'thehindu.com', 'ndtv.com']],
  [['buy', 'shop', 'shopping', 'order', 'cart', 'price', 'product', 'deal'],
    ['amazon.com', 'amazon.in', 'amazon.co.uk', 'flipkart.com', 'ebay.com', 'etsy.com', 'aliexpress.com', 'myntra.com']],
  [['map', 'directions', 'location', 'address', 'flight', 'hotel', 'travel', 'trip'],
    ['google.com/maps', 'maps.google.com', 'google.com/travel', 'booking.com', 'airbnb.com', 'makemytrip.com', 'skyscanner.com', 'expedia.com']],
  [['course', 'learn', 'lesson', 'lecture', 'class', 'tutorial'],
    ['coursera.org', 'udemy.com', 'khanacademy.org', 'edx.org', 'freecodecamp.org']],
  [['wiki', 'definition', 'meaning'], ['wikipedia.org']],
  [['ticket', 'task', 'jira', 'board', 'sprint', 'project', 'roadmap'],
    ['atlassian.net', 'linear.app', 'trello.com', 'asana.com', 'notion.so', 'monday.com', 'clickup.com']],
  [['design', 'figma', 'mockup', 'prototype', 'wireframe'], ['figma.com', 'canva.com', 'dribbble.com', 'behance.net']],
  [['file', 'drive', 'folder', 'upload'], ['drive.google.com', 'dropbox.com', 'onedrive.live.com', 'box.com']],
  [['search', 'googled', 'query'], ['google.com/search', 'bing.com/search', 'duckduckgo.com']],
  [['localhost', 'dev', 'server'], ['localhost', '127.0.0.1']],
];
const CONCEPT_SITES = new Map();
for (const [triggers, sites] of CONCEPTS) {
  for (const word of triggers) {
    for (const key of new Set([word, stem(word)])) CONCEPT_SITES.set(key, [...(CONCEPT_SITES.get(key) ?? []), ...sites]);
  }
}

const $ = (id) => document.getElementById(id);
const els = {
  search: $('search'),
  results: $('results'),
  resultsEmpty: $('results-empty'),
  dashboard: $('dashboard'),
  statTotal: $('stat-total'),
  statGroups: $('stat-groups'),
  statStale: $('stat-stale'),
  staleCard: $('stat-stale-card'),
  cleanups: $('cleanups'),
  cleanupsEmpty: $('cleanups-empty'),
  archiveAll: $('archive-all'),
  history: $('history'),
  historyCount: $('history-count'),
  historyList: $('history-list'),
  memoryStatus: $('memory-status'),
  memoryPause: $('memory-pause'),
  memoryClear: $('memory-clear'),
  toast: $('toast'),
};

const state = {
  tabs: [],
  groups: new Map(),
  access: {},
  autoGroups: {},
  archive: [],
  pages: [],
  memoryPaused: false,
  windowNumbers: new Map(),
  stale: [],
  openDocs: [],
  closedDocs: [],
  results: [],
  selected: 0,
};

// ---------------------------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------------------------

async function loadEcosystem() {
  const [tabs, groups, store, pages] = await Promise.all([
    chrome.tabs.query({}),
    chrome.tabGroups.query({}),
    chrome.storage.local.get([KEYS.ACCESS, KEYS.AUTO_GROUPS, KEYS.ARCHIVE, KEYS.MEMORY_PAUSED]),
    pageMemory.getAll().catch(() => []),
  ]);
  state.tabs = tabs;
  state.groups = new Map(groups.map((group) => [group.id, group]));
  state.access = store[KEYS.ACCESS] ?? {};
  state.autoGroups = store[KEYS.AUTO_GROUPS] ?? {};
  state.archive = store[KEYS.ARCHIVE] ?? [];
  state.memoryPaused = Boolean(store[KEYS.MEMORY_PAUSED]);
  state.pages = pages;
  state.windowNumbers = new Map([...new Set(tabs.map((tab) => tab.windowId))].map((id, i) => [id, i + 1]));
  buildSearchIndex();
}

/** Open tabs plus every remembered or archived page that is no longer open. */
function buildSearchIndex() {
  // A description a site repeats on several pages (every ChatGPT chat has the same one) describes
  // the site, not the page, so it is neither matched nor shown as a preview.
  const descriptionKey = (page) => `${page.host}\n${page.description}`;
  const descriptionCounts = new Map();
  for (const page of state.pages) {
    if (page.description) descriptionCounts.set(descriptionKey(page), (descriptionCounts.get(descriptionKey(page)) ?? 0) + 1);
  }
  const pagesByUrl = new Map(
    state.pages.map((page) => [
      page.url,
      descriptionCounts.get(descriptionKey(page)) > 1 ? { ...page, description: '' } : page,
    ]),
  );
  const openUrls = new Set();
  state.openDocs = state.tabs.map((tab) => {
    const url = tabUrl(tab);
    openUrls.add(normalizeUrl(url));
    return buildDoc({
      kind: 'open',
      tab,
      title: tab.title,
      url,
      favIconUrl: tab.favIconUrl,
      page: pagesByUrl.get(normalizeUrl(url)),
      groupTitle: state.groups.get(tab.groupId)?.title ?? '',
      when: lastSeen(tab),
    });
  });
  const archivedAt = new Map(state.archive.map((entry) => [normalizeUrl(entry.url), entry]));
  const closed = new Map();
  for (const page of pagesByUrl.values()) {
    if (openUrls.has(page.url)) continue;
    const archived = archivedAt.get(page.url);
    closed.set(page.url, { page, title: page.title, url: page.url, favIconUrl: page.favIconUrl, when: archived?.closedAt ?? page.lastVisited, archived: Boolean(archived) });
  }
  for (const [url, entry] of archivedAt) {
    if (!openUrls.has(url) && !closed.has(url)) closed.set(url, { title: entry.title, url: entry.url, when: entry.closedAt, archived: true });
  }
  state.closedDocs = [...closed.values()].map((item) => buildDoc({ kind: 'closed', ...item }));
}

async function refresh() {
  await loadEcosystem();
  renderDashboard();
  if (els.search.value.trim()) runSearch();
}

const lastSeen = (tab) => getLastAccessed(tab, state.access) ?? 0;

/** Auto-created groups above the limit, with their least-recently-used closable tabs. */
function getOverloadedGroups() {
  const members = new Map();
  for (const tab of state.tabs) {
    if (!state.autoGroups[tab.groupId]) continue;
    if (!members.has(tab.groupId)) members.set(tab.groupId, []);
    members.get(tab.groupId).push(tab);
  }
  return [...members]
    .filter(([, tabs]) => tabs.length > OVERLOAD_THRESHOLD)
    .map(([groupId, tabs]) => {
      const closable = tabs
        .filter((tab) => !tab.active && !tab.pinned && !tab.audible)
        .sort((a, b) => lastSeen(a) - lastSeen(b))
        .slice(0, tabs.length - OVERLOAD_THRESHOLD);
      return { groupId, group: state.groups.get(groupId), tabs, closable };
    });
}

// ---------------------------------------------------------------------------------------------
// Archive & Safe Close
// ---------------------------------------------------------------------------------------------

/**
 * Writes the tabs to the archive history first and closes them only after that write succeeds.
 * Tabs are re-read so anything that became active, pinned, or audible since rendering is spared.
 */
async function archiveAndClose(tabs, reason) {
  const fresh = (await Promise.all(tabs.map((tab) => chrome.tabs.get(tab.id).catch(() => null)))).filter(
    (tab) => tab && !tab.active && !tab.pinned && !tab.audible,
  );
  if (!fresh.length) return 0;
  const closedAt = Date.now();
  const entries = fresh.map((tab) => ({ title: tab.title || tabUrl(tab), url: tabUrl(tab), closedAt, reason }));
  const { [KEYS.ARCHIVE]: archive = [] } = await chrome.storage.local.get(KEYS.ARCHIVE);
  await chrome.storage.local.set({ [KEYS.ARCHIVE]: [...entries, ...archive].slice(0, ARCHIVE_LIMIT) });
  await chrome.tabs.remove(fresh.map((tab) => tab.id));
  return fresh.length;
}

async function handleArchive(button, tabs, reason) {
  const buttons = document.querySelectorAll('.cleanups button, #archive-all');
  buttons.forEach((b) => (b.disabled = true));
  button.textContent = 'Archiving…';
  try {
    const closed = await archiveAndClose(tabs, reason);
    showToast(
      closed
        ? `Archived & closed ${closed} tab${closed === 1 ? '' : 's'}. Find them under “Recently archived”.`
        : 'Nothing to close: those tabs are in use now.',
    );
  } catch (error) {
    console.error('[TabDeclutter] archive failed', error);
    showToast('Could not close those tabs. Nothing was lost.');
  }
  await refresh();
}

let toastTimer = 0;
function showToast(message) {
  els.toast.textContent = message;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (els.toast.hidden = true), 3500);
}

// ---------------------------------------------------------------------------------------------
// Dashboard rendering
// ---------------------------------------------------------------------------------------------

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function formatDuration(ms) {
  const minutes = Math.max(1, Math.floor(ms / 60000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function faviconFor(tab) {
  const fallback = () =>
    el('span', 'favicon favicon--fallback', (getRootDomain(tabUrl(tab)) || tab.title || '?').charAt(0).toUpperCase());
  const src = tab.favIconUrl;
  if (!src || !/^(https?:|data:image\/)/.test(src)) return fallback();
  const img = el('img', 'favicon');
  img.alt = '';
  img.width = 16;
  img.height = 16;
  img.referrerPolicy = 'no-referrer';
  img.addEventListener('error', () => img.replaceWith(fallback()), { once: true });
  img.src = src;
  return img;
}

function describeHost(tab) {
  try {
    return new URL(tabUrl(tab)).hostname.replace(/^www\./, '') || tabUrl(tab);
  } catch {
    return tabUrl(tab);
  }
}

function cleanupItem({ icon, title, meta, onFocus, tabs, reason, disabled }) {
  const item = el('li', 'cleanup-item');
  const text = el('button', 'cleanup-text');
  text.type = 'button';
  text.title = `${title}\n${meta}\n(click to go there)`;
  text.append(el('span', 'cleanup-title', title), el('span', 'cleanup-meta', meta));
  text.addEventListener('click', onFocus);
  const action = el('button', 'btn btn-primary', 'Archive & Safe Close');
  action.type = 'button';
  action.disabled = disabled;
  action.addEventListener('click', () => handleArchive(action, tabs, reason));
  item.append(icon, text, action);
  return item;
}

function cleanupSection(heading, items) {
  const section = el('div', 'cleanup-section');
  const list = el('ul', 'cleanup-list');
  list.append(...items);
  section.append(el('h3', 'cleanup-heading', heading), list);
  return section;
}

function renderDashboard() {
  const now = Date.now();
  state.stale = state.tabs.filter((tab) => isStale(tab, state.access, now)).sort((a, b) => lastSeen(a) - lastSeen(b));
  const overloaded = getOverloadedGroups();

  els.statTotal.textContent = state.tabs.length;
  els.statGroups.textContent = state.groups.size;
  els.statStale.textContent = state.stale.length;
  els.staleCard.classList.toggle('stat--warn', state.stale.length > 0);

  const sections = [];
  if (overloaded.length) {
    sections.push(
      cleanupSection(
        `Overloaded groups · over ${OVERLOAD_THRESHOLD} tabs`,
        overloaded.map(({ group, tabs, closable }) => {
          const icon = el('span', 'group-dot');
          icon.dataset.color = group?.color ?? 'grey';
          return cleanupItem({
            icon,
            title: group?.title || 'Untitled group',
            meta: closable.length
              ? `${tabs.length} tabs · closes ${closable.length} oldest`
              : `${tabs.length} tabs · all in use or pinned`,
            onFocus: () => focusTab(tabs.find((t) => t.active) ?? tabs[0]),
            tabs: closable,
            reason: 'overloaded-group',
            disabled: !closable.length,
          });
        }),
      ),
    );
  }
  if (state.stale.length) {
    sections.push(
      cleanupSection(
        'Stale tabs',
        state.stale.map((tab) =>
          cleanupItem({
            icon: faviconFor(tab),
            title: tab.title || tabUrl(tab),
            meta: `idle ${formatDuration(now - lastSeen(tab))} · ${describeHost(tab)}`,
            onFocus: () => focusTab(tab),
            tabs: [tab],
            reason: 'stale',
            disabled: false,
          }),
        ),
      ),
    );
  }
  els.cleanups.replaceChildren(...sections);
  els.cleanupsEmpty.hidden = sections.length > 0;
  els.archiveAll.hidden = state.stale.length < 2;
  els.archiveAll.disabled = false;
  els.archiveAll.textContent = `Archive all ${state.stale.length} stale`;

  renderHistory();
  renderMemory();
}

function formatAgo(timestamp) {
  const ms = Date.now() - timestamp;
  return ms < 60000 ? 'just now' : `${formatDuration(ms)} ago`;
}

function renderMemory() {
  const count = state.pages.length.toLocaleString();
  els.memoryStatus.textContent = state.memoryPaused
    ? `Page memory paused · ${count} pages kept`
    : `Remembering ${count} pages on this device`;
  els.memoryPause.textContent = state.memoryPaused ? 'Resume' : 'Pause';
}

let clearArmed = 0;
async function handleMemoryClear() {
  if (!clearArmed) {
    els.memoryClear.textContent = 'Click again to clear';
    clearArmed = setTimeout(() => {
      clearArmed = 0;
      els.memoryClear.textContent = 'Clear';
    }, 4000);
    return;
  }
  clearTimeout(clearArmed);
  clearArmed = 0;
  els.memoryClear.textContent = 'Clear';
  await pageMemory.clear();
  showToast('Page memory cleared. Open tabs are still searchable by title.');
  await refresh();
}

function renderHistory() {
  els.historyCount.textContent = state.archive.length;
  els.history.hidden = state.archive.length === 0;
  els.historyList.replaceChildren(
    ...state.archive.slice(0, HISTORY_SHOWN).map((entry) => {
      const item = el('li');
      const link = el('button', 'history-item');
      link.type = 'button';
      link.title = `Reopen ${entry.url}`;
      link.append(
        el('span', 'history-title', entry.title),
        el('span', 'history-meta', `${formatAgo(entry.closedAt)} · ${entry.url}`),
      );
      link.addEventListener('click', () => chrome.tabs.create({ url: entry.url }).catch(() => showToast('That page cannot be reopened.')));
      item.append(link);
      return item;
    }),
  );
}

// ---------------------------------------------------------------------------------------------
// Command bar search engine
// ---------------------------------------------------------------------------------------------

/**
 * Splits the query into terms. Adjacent terms that appear together in a page title are a name
 * ("claude code"), so they are matched literally and do not trigger intent weighting or site
 * types ("code" would otherwise favor GitHub).
 */
function parseQuery(raw, docs) {
  const phrase = raw.trim().toLowerCase();
  const terms = [...new Set(tokenize(phrase).filter((t) => !QUERY_STOPWORDS.has(t) && !STOPWORDS.has(t)))];
  const names = new Set();
  for (let i = 0; i + 1 < terms.length; i++) {
    if (INTENT_WORDS.has(terms[i]) && INTENT_WORDS.has(terms[i + 1])) continue; // "pull request" stays an intent
    const pair = `${terms[i]} ${terms[i + 1]}`;
    if (docs.some((doc) => doc.titleLower.includes(pair))) names.add(terms[i]).add(terms[i + 1]);
  }
  const codeIntent = CODE_INTENT.test(phrase) && terms.some((t) => INTENT_WORDS.has(t) && !names.has(t));
  return { terms, names, codeIntent };
}

/** Precomputes everything search needs about one open tab or remembered page. */
function buildDoc({ kind, title, url, favIconUrl, page, tab = null, groupTitle = '', when = 0, archived = false }) {
  let host = '';
  let path = '';
  try {
    const parsed = new URL(url);
    host = parsed.hostname.toLowerCase();
    path = parsed.pathname.toLowerCase();
  } catch {}
  const shownTitle = title || url;
  const titleWords = tokenize(shownTitle);
  return {
    kind,
    tab,
    url,
    favIconUrl,
    title: shownTitle,
    when,
    archived,
    groupTitle,
    titleLower: shownTitle.toLowerCase(),
    titleWords,
    titleStems: new Set(titleWords.map(stem)),
    urlLower: url.toLowerCase(),
    urlStems: new Set(tokenize(url).map(stem)),
    host,
    hostPath: host.replace(/^www\./, '') + path,
    groupStems: new Set(contentStems(groupTitle)),
    summaryStems: new Set(
      contentStems(`${page?.description ?? ''} ${page?.headings ?? ''} ${page?.intent ?? ''} ${searchQueryFromUrl(url)}`),
    ),
    keywordStems: new Set(page?.keywords ?? []),
    snippet:
      page?.description ||
      page?.intent ||
      (page?.headings ?? '')
        .split(' · ')
        .filter((heading) => !shownTitle.toLowerCase().includes(heading.toLowerCase()))
        .join(' · '),
    isGitHub: getRootDomain(url) === 'github.com',
  };
}

function siteMatches(doc, site) {
  if (site.includes('/')) return doc.hostPath.startsWith(site) || doc.hostPath.includes(`.${site}`);
  return doc.host === site || doc.host.endsWith(`.${site}`);
}

/** Bounded Levenshtein check, for typo tolerance ("kubernets" -> "kubernetes"). */
function withinEdits(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return false;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      rowMin = Math.min(rowMin, current[j]);
    }
    if (rowMin > max) return false;
    previous = current;
  }
  return previous[b.length] <= max;
}

/**
 * Points for one query term. Title hits beat site hits beat page-content hits; a term that
 * describes the kind of site ("video", "spreadsheet") scores when the page is on such a site.
 */
function termScore(term, doc, isName) {
  const s = stem(term);
  let points = 0;
  for (const variant of [term, ...(SYNONYMS[term] ?? [])]) {
    const vs = stem(variant);
    if (doc.titleStems.has(vs)) points = Math.max(points, 10);
    else if (variant.length >= 3 && doc.titleLower.includes(variant)) points = Math.max(points, 7);
    if (variant.length >= 3 && doc.host.includes(variant)) points = Math.max(points, 8);
    if (doc.urlStems.has(vs)) points = Math.max(points, 5);
    else if (variant.length >= 3 && doc.urlLower.includes(variant)) points = Math.max(points, 3);
  }
  if (doc.groupStems.has(s)) points = Math.max(points, 6);
  if (!points && term.length >= 5) {
    const max = term.length >= 8 ? 2 : 1;
    if (doc.titleWords.some((w) => w.length >= 5 && withinEdits(term, w, max))) points = 6;
  }
  const inContent = doc.summaryStems.has(s) || doc.keywordStems.has(s);
  if (doc.summaryStems.has(s)) points = Math.max(points, 6);
  else if (doc.keywordStems.has(s)) points = Math.max(points, 4);
  const sites = isName ? null : CONCEPT_SITES.get(term) ?? CONCEPT_SITES.get(s);
  if (sites?.some((site) => siteMatches(doc, site))) points = Math.max(points, 9);
  return { points, inContent };
}

function scoreDoc(doc, query) {
  let score = 0;
  let matched = 0;
  let contentHit = false;
  for (const term of query.terms) {
    const { points, inContent } = termScore(term, doc, query.names.has(term));
    if (points) {
      score += points;
      matched++;
    }
    contentHit ||= inContent;
  }
  return { score, matched, contentHit };
}

function rank(docs, query, { limit, minCoverage }) {
  const now = Date.now();
  const hits = [];
  for (const doc of docs) {
    let { score, matched, contentHit } = scoreDoc(doc, query);
    if (!matched || matched / query.terms.length < minCoverage) continue;
    // Reward tabs that match more of the query, and the query as an exact phrase.
    score *= 0.4 + (0.6 * matched) / query.terms.length;
    if (query.terms.length > 1 && doc.titleLower.includes(query.terms.join(' '))) score += 8;
    // Intent weighting: PR / pull request / code / issue queries favor GitHub.
    if (query.codeIntent && doc.isGitHub) score = score * 1.5 + 15;
    // Among similar matches, the more recently seen page wins.
    score += 2 * Math.exp(-(now - doc.when) / (3 * 86400000));
    hits.push({ doc, score, contentHit });
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}

/** Renders text with query terms wrapped in <mark>, using text nodes only (no innerHTML). */
function highlighted(className, text, terms) {
  const node = el('span', className);
  const words = terms.filter((t) => t.length >= 3).map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (!words.length) {
    node.textContent = text;
    return node;
  }
  const pattern = new RegExp(`(${words.join('|')})`, 'giu');
  text.split(pattern).forEach((part, i) => node.append(i % 2 ? el('mark', '', part) : document.createTextNode(part)));
  return node;
}

/** The part of a page summary around the first matching word. */
function snippetAround(text, terms) {
  const lower = text.toLowerCase();
  const hit = terms.map((t) => lower.indexOf(stem(t))).filter((i) => i >= 0).sort((a, b) => a - b)[0] ?? 0;
  let start = Math.max(0, hit - 40);
  if (start) start = text.indexOf(' ', start) + 1 || start; // begin at a word boundary
  return (start ? '…' : '') + text.slice(start, start + 160);
}

function resultItem(hit, index, query) {
  const { doc } = hit;
  const item = el('li', 'result');
  item.id = `result-${index}`;
  item.setAttribute('role', 'option');
  const meta = el('span', 'result-meta');
  meta.append(el('span', 'result-host', doc.host.replace(/^www\./, '') || doc.url));
  if (doc.kind === 'open') {
    const group = state.groups.get(doc.tab.groupId);
    if (group) {
      const chip = el('span', 'chip', group.title || 'Group');
      chip.dataset.color = group.color;
      meta.append(chip);
    }
    if (state.windowNumbers.size > 1) meta.append(el('span', 'result-window', `Window ${state.windowNumbers.get(doc.tab.windowId)}`));
    if (doc.tab.active) meta.append(el('span', 'result-window', 'current'));
  } else {
    meta.append(el('span', 'result-window', `${doc.archived ? 'archived' : 'seen'} ${formatAgo(doc.when)}`));
  }
  const text = el('span', 'result-text');
  text.append(highlighted('result-title', doc.title, query.terms), meta);
  if (hit.contentHit && doc.snippet) text.append(highlighted('result-snippet', snippetAround(doc.snippet, query.terms), query.terms));
  item.append(faviconFor({ url: doc.url, title: doc.title, favIconUrl: doc.favIconUrl }), text);
  item.addEventListener('mousemove', () => select(index));
  item.addEventListener('click', () => activate(hit));
  return item;
}

function runSearch() {
  const raw = els.search.value;
  const searching = raw.trim().length > 0;
  els.dashboard.hidden = searching;
  state.results = [];
  if (!searching) {
    els.results.hidden = true;
    els.resultsEmpty.hidden = true;
    els.search.setAttribute('aria-expanded', 'false');
    return;
  }
  const query = parseQuery(raw, [...state.openDocs, ...state.closedDocs]);
  const open = query.terms.length ? rank(state.openDocs, query, { limit: MAX_OPEN_RESULTS, minCoverage: 0 }) : [];
  // The memory holds thousands of pages, so closed pages must match at least half of the query.
  const closed = query.terms.length ? rank(state.closedDocs, query, { limit: MAX_CLOSED_RESULTS, minCoverage: 0.5 }) : [];
  state.results = [...open, ...closed];

  const nodes = [];
  if (open.length) nodes.push(el('li', 'results-heading', 'Open tabs'));
  open.forEach((hit, i) => nodes.push(resultItem(hit, i, query)));
  if (closed.length) nodes.push(el('li', 'results-heading', 'Closed earlier'));
  closed.forEach((hit, i) => nodes.push(resultItem(hit, open.length + i, query)));
  nodes.filter((n) => n.classList.contains('results-heading')).forEach((n) => n.setAttribute('role', 'presentation'));
  els.results.replaceChildren(...nodes);

  const found = state.results.length > 0;
  els.results.hidden = !found;
  els.resultsEmpty.hidden = found;
  els.search.setAttribute('aria-expanded', String(found));
  select(0);
}

function select(index) {
  const options = els.results.querySelectorAll('.result');
  if (!options.length) {
    els.search.removeAttribute('aria-activedescendant');
    return;
  }
  state.selected = (index + options.length) % options.length;
  options.forEach((item, i) => item.setAttribute('aria-selected', String(i === state.selected)));
  const active = options[state.selected];
  els.search.setAttribute('aria-activedescendant', active.id);
  active.scrollIntoView({ block: 'nearest' });
}

async function activate(hit) {
  if (!hit) return;
  if (hit.doc.kind === 'open') return focusTab(hit.doc.tab);
  try {
    await chrome.tabs.create({ url: hit.doc.url });
    window.close();
  } catch {
    showToast('That page cannot be reopened.');
  }
}

async function focusTab(tab) {
  if (!tab) return;
  try {
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
    window.close();
  } catch {
    showToast('That tab was closed in the meantime.');
    await refresh();
  }
}

els.search.addEventListener('input', runSearch);
els.search.addEventListener('keydown', (event) => {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    select(state.selected + (event.key === 'ArrowDown' ? 1 : -1));
  } else if (event.key === 'Enter') {
    event.preventDefault();
    activate(state.results[state.selected]);
  } else if (event.key === 'Escape' && els.search.value) {
    event.preventDefault(); // clear the query instead of closing the popup
    els.search.value = '';
    runSearch();
  }
});
els.archiveAll.addEventListener('click', () => handleArchive(els.archiveAll, state.stale, 'stale'));
els.memoryPause.addEventListener('click', async () => {
  await chrome.storage.local.set({ [KEYS.MEMORY_PAUSED]: !state.memoryPaused });
  await refresh();
});
els.memoryClear.addEventListener('click', handleMemoryClear);

refresh().catch((error) => {
  console.error('[TabDeclutter] failed to load', error);
  showToast('Could not read your tabs. Try reopening the popup.');
});
