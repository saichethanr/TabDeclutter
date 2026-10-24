import {
  ARCHIVE_LIMIT,
  OVERLOAD_THRESHOLD,
  STORAGE_KEYS as KEYS,
  getLastAccessed,
  getRootDomain,
  isStale,
  tabUrl,
} from './shared.js';

const MAX_RESULTS = 8;
const HISTORY_SHOWN = 15;

// Words that carry no search signal ("Where is my PR tab for ...").
const QUERY_STOPWORDS = new Set([
  'where', 'is', 'my', 'the', 'a', 'an', 'for', 'of', 'to', 'in', 'on', 'at', 'and', 'or', 'tab',
  'tabs', 'that', 'this', 'with', 'about', 'find', 'show', 'me', 'what', 'which', 'i', 'it', 'was',
  'open', 'page', 'did', 'do', 'can', 'you', 'please', 'whats', 'wheres',
]);
// Intent weighting: these signal code-hosting work, so github.com tabs rank higher.
const CODE_INTENT = /\b(prs?|pull[\s-]*requests?|code|issues?)\b/;
const INTENT_TERMS = new Set(['pr', 'prs', 'pull', 'request', 'requests', 'code', 'issue', 'issues']);
// Extra spellings matched against titles and URLs (GitHub PR URLs contain "/pull/").
const SYNONYMS = { pr: ['pull'], prs: ['pull', 'pulls'], issue: ['issues'], issues: ['issue'] };

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
  toast: $('toast'),
};

const state = {
  tabs: [],
  groups: new Map(),
  access: {},
  autoGroups: {},
  archive: [],
  windowNumbers: new Map(),
  stale: [],
  results: [],
  selected: 0,
};

// ---------------------------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------------------------

async function loadEcosystem() {
  const [tabs, groups, store] = await Promise.all([
    chrome.tabs.query({}),
    chrome.tabGroups.query({}),
    chrome.storage.local.get([KEYS.ACCESS, KEYS.AUTO_GROUPS, KEYS.ARCHIVE]),
  ]);
  state.tabs = tabs;
  state.groups = new Map(groups.map((group) => [group.id, group]));
  state.access = store[KEYS.ACCESS] ?? {};
  state.autoGroups = store[KEYS.AUTO_GROUPS] ?? {};
  state.archive = store[KEYS.ARCHIVE] ?? [];
  state.windowNumbers = new Map([...new Set(tabs.map((tab) => tab.windowId))].map((id, i) => [id, i + 1]));
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

  renderHistory(now);
}

function renderHistory(now) {
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
        el('span', 'history-meta', `${now - entry.closedAt < 60000 ? 'just now' : `${formatDuration(now - entry.closedAt)} ago`} · ${entry.url}`),
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

const tokenize = (text) => text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);

function parseQuery(raw) {
  const phrase = raw.trim().toLowerCase();
  const terms = [...new Set(tokenize(phrase).filter((t) => !QUERY_STOPWORDS.has(t)))];
  const codeIntent = CODE_INTENT.test(phrase);
  // Intent words boost GitHub but are not required to match, so they never shrink coverage.
  const coreTerms = codeIntent ? terms.filter((t) => !INTENT_TERMS.has(t)) : terms;
  return { phrase, terms, coreTerms, codeIntent };
}

/** Points for one term against one tab: whole-word title hits beat host hits beat URL substrings. */
function termScore(term, fields) {
  let best = 0;
  for (const variant of [term, ...(SYNONYMS[term] ?? [])]) {
    if (fields.titleTokens.has(variant)) best = Math.max(best, 10);
    else if (variant.length >= 3 && fields.title.includes(variant)) best = Math.max(best, 6);
    if (variant.length >= 3 && fields.host.includes(variant)) best = Math.max(best, 8);
    if (fields.urlTokens.has(variant)) best = Math.max(best, 5);
    else if (variant.length >= 3 && fields.url.includes(variant)) best = Math.max(best, 3);
  }
  return best;
}

function scoreTab(tab, query) {
  const url = tabUrl(tab).toLowerCase();
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {}
  const fields = {
    title: (tab.title ?? '').toLowerCase(),
    titleTokens: new Set(tokenize(tab.title ?? '')),
    url,
    urlTokens: new Set(tokenize(url)),
    host,
  };
  const isGitHub = getRootDomain(url) === 'github.com';

  let score = 0;
  let coreMatched = 0;
  for (const term of query.terms) {
    const points = termScore(term, fields);
    score += points;
    if (points && query.coreTerms.includes(term)) coreMatched++;
  }
  if (query.coreTerms.length && !coreMatched) return 0;
  if (!query.coreTerms.length && !score && !(query.codeIntent && isGitHub)) return 0;

  // Reward tabs that match more of the query, and the exact phrase.
  if (query.coreTerms.length) score *= 0.4 + (0.6 * coreMatched) / query.coreTerms.length;
  if (query.coreTerms.length > 1 && fields.title.includes(query.coreTerms.join(' '))) score += 8;
  if (query.codeIntent && isGitHub) score = score * 1.5 + 15;
  return score;
}

function search(raw) {
  const query = parseQuery(raw);
  if (!query.terms.length) return { query, results: [] };
  const results = state.tabs
    .map((tab) => ({ tab, score: scoreTab(tab, query) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || lastSeen(b.tab) - lastSeen(a.tab))
    .slice(0, MAX_RESULTS)
    .map((r) => r.tab);
  return { query, results };
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

function runSearch() {
  const raw = els.search.value;
  const searching = raw.trim().length > 0;
  els.dashboard.hidden = searching;
  if (!searching) {
    state.results = [];
    els.results.hidden = true;
    els.resultsEmpty.hidden = true;
    els.search.setAttribute('aria-expanded', 'false');
    return;
  }
  const { query, results } = search(raw);
  state.results = results;
  state.selected = 0;
  const multiWindow = state.windowNumbers.size > 1;
  els.results.replaceChildren(
    ...results.map((tab, index) => {
      const item = el('li', 'result');
      item.id = `result-${index}`;
      item.setAttribute('role', 'option');
      const meta = el('span', 'result-meta');
      meta.append(el('span', 'result-host', describeHost(tab)));
      const group = state.groups.get(tab.groupId);
      if (group) {
        const chip = el('span', 'chip', group.title || 'Group');
        chip.dataset.color = group.color;
        meta.append(chip);
      }
      if (multiWindow) meta.append(el('span', 'result-window', `Window ${state.windowNumbers.get(tab.windowId)}`));
      if (tab.active) meta.append(el('span', 'result-window', 'current'));
      const text = el('span', 'result-text');
      text.append(highlighted('result-title', tab.title || tabUrl(tab), query.terms), meta);
      item.append(faviconFor(tab), text);
      item.addEventListener('mousemove', () => select(index));
      item.addEventListener('click', () => focusTab(tab));
      return item;
    }),
  );
  els.results.hidden = results.length === 0;
  els.resultsEmpty.hidden = results.length > 0;
  els.search.setAttribute('aria-expanded', String(results.length > 0));
  select(0);
}

function select(index) {
  if (!state.results.length) {
    els.search.removeAttribute('aria-activedescendant');
    return;
  }
  state.selected = (index + state.results.length) % state.results.length;
  [...els.results.children].forEach((item, i) => item.setAttribute('aria-selected', String(i === state.selected)));
  const active = els.results.children[state.selected];
  els.search.setAttribute('aria-activedescendant', active.id);
  active.scrollIntoView({ block: 'nearest' });
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
    focusTab(state.results[state.selected]);
  } else if (event.key === 'Escape' && els.search.value) {
    event.preventDefault(); // clear the query instead of closing the popup
    els.search.value = '';
    runSearch();
  }
});
els.archiveAll.addEventListener('click', () => handleArchive(els.archiveAll, state.stale, 'stale'));

refresh().catch((error) => {
  console.error('[TabDeclutter] failed to load', error);
  showToast('Could not read your tabs. Try reopening the popup.');
});
